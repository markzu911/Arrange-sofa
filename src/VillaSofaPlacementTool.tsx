import {
  Bot,
  CheckCircle2,
  ChevronLeft,
  Download,
  ImagePlus,
  Loader2,
  Maximize2,
  PenLine,
  RefreshCcw,
  Send,
  Settings2,
  Sparkles,
  UploadCloud,
  Wand2,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { defaultSettings, perspectiveLabels, TOOL_COST, TOOL_NAME } from "./constants";
import styles from "./VillaSofaPlacementTool.module.css";
import { analyzeScene, checkGeneratedPlacement, eraseExistingSofas, extractSofaForeground, generatePlacementImages } from "./services/gemini";
import { compressDataUrlToBlob, compressImage, GEMINI_IMAGE_TARGET_BYTES, GEMINI_REFERENCE_TARGET_BYTES } from "./services/image";
import {
  consumeIntegral,
  createInitialPlatformContext,
  launchTool,
  mergeSaasInit,
  persistResultImage,
  type PlatformContext,
  verifyIntegral
} from "./services/platform";
import type {
  GeneratedImageResult,
  ImageRatio,
  PlacementSettings,
  SceneAnalysis,
  SaasInitPayload,
  ToolMode,
  TrialPlacementPlan,
  UploadedImage
} from "./types";

type GuidedStep = "room" | "sofa" | "review" | "generating" | "result";

type ChatMessage = {
  role: "assistant" | "user";
  text: string;
  image?: UploadedImage;
};

function userFacingError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : "";
  if (/not available in your current location|available-regions|当前调用地区不可用/i.test(message)) {
    return "Gemini API 当前调用地区不可用：请将后端服务部署在 Gemini API 支持的国家或地区，或改用 Google Cloud 的企业平台 Gemini API。";
  }
  if (/project has been denied access|denied access|permission denied/i.test(message)) {
    return "Gemini 项目访问被拒绝：请在 Google AI Studio 或 Google Cloud 为当前 API Key 所属项目开通模型访问权限后重试。";
  }
  return message || fallback;
}

function createManualAnalysis(): SceneAnalysis {
  return {
    roomSummary: "AI 解析暂不可用，请根据房间实际情况补充要求。",
    sofaSummary: "请确认目标沙发的款式、颜色、材质和整体轮廓。",
    sofaIdentity: { seatCount: "以参考图为准", silhouette: "以参考图为准", armrest: "以参考图为准", backrest: "以参考图为准", cushions: "以参考图为准", material: "以参考图为准", color: "以参考图为准", details: [] },
    lighting: "请保留原房间的主要光源方向，并生成自然接地阴影。",
    perspective: "请保持房间透视关系与主要通道完整。",
    placementAdvice: "请在下方填写希望保留或替换的家具、沙发朝向和通道要求。",
    constraints: ["不要遮挡主要通道", "未明确要求时保留原有家具和结构"],
    placementPlan: {
      summary: "等待您手动确认试摆方案。",
      placement: "由 AI 根据房间空间、动线和您的要求选择合适位置",
      facing: "根据主要视觉焦点和您的要求确定朝向",
      scale: "保持与房间尺度和透视关系协调",
      preserve: ["保留未明确要求移除的原有结构、家具与装饰"],
      remove: ["无明确移除对象"],
      avoid: ["不要遮挡通道、门窗、主要采光和核心功能区"],
      rationale: ["AI 解析不可用，需由用户补充确认"],
      candidates: [],
      selectedCandidateId: ""
    }
  };
}

const initialChatMessages: ChatMessage[] = [
  { role: "assistant", text: "您好，我是您的 AI 别墅沙发试摆助手。" },
  { role: "assistant", text: "我可以把您提供的沙发自然试摆到别墅房间里，保留沙发款式，并匹配空间透视、光线和阴影。要开始试摆吗？" }
];

const ratioClass: Record<ImageRatio, string> = {
  "1:1": styles.ratioSquare,
  "3:4": styles.ratioPortrait,
  "4:3": styles.ratioClassic,
  "16:9": styles.ratioWide
};

const stepMeta: Array<{ key: GuidedStep; label: string }> = [
  { key: "room", label: "上传房间" },
  { key: "sofa", label: "上传沙发" },
  { key: "review", label: "确认方案" },
  { key: "generating", label: "AI 生成" },
  { key: "result", label: "查看结果" }
];

export function VillaSofaPlacementTool() {
  const [platform, setPlatform] = useState<PlatformContext>(() => createInitialPlatformContext());
  const [mode, setMode] = useState<ToolMode>("agent");
  const [guidedStep, setGuidedStep] = useState<GuidedStep>("room");
  const [roomImage, setRoomImage] = useState<UploadedImage | null>(null);
  const [roomReferenceImages, setRoomReferenceImages] = useState<UploadedImage[]>([]);
  const [sofaImage, setSofaImage] = useState<UploadedImage | null>(null);
  const [sofaForegroundImage, setSofaForegroundImage] = useState<UploadedImage | null>(null);
  const [clearedRoomImage, setClearedRoomImage] = useState<UploadedImage | null>(null);
  const [settings, setSettings] = useState<PlacementSettings>(defaultSettings);
  const [analysis, setAnalysis] = useState<SceneAnalysis | null>(null);
  const [results, setResults] = useState<GeneratedImageResult[]>([]);
  const [selectedResult, setSelectedResult] = useState(0);
  const [compareValue, setCompareValue] = useState(50);
  const [integral, setIntegral] = useState(TOOL_COST * 9);
  const [toolCost, setToolCost] = useState(TOOL_COST);
  const [status, setStatus] = useState("准备就绪，请上传房间照片开始试摆");
  const [error, setError] = useState("");
  const [isLaunching, setIsLaunching] = useState(false);
  const [isAnalyzingRoom, setIsAnalyzingRoom] = useState(false);
  const [isAnalyzingSofa, setIsAnalyzingSofa] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [showAnalysisEditor, setShowAnalysisEditor] = useState(false);
  const [reviewSubstep, setReviewSubstep] = useState<"plan" | "settings">("plan");
  const [chatDraft, setChatDraft] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(initialChatMessages);
  const [agentFlowStarted, setAgentFlowStarted] = useState(false);

  const isStandaloneTrial = platform.userId === "demo-user" && platform.toolId === "villa-sofa-placement";
  const currentResult = results[selectedResult];

  useEffect(() => {
    const handleMessage = (event: MessageEvent<SaasInitPayload>) => {
      if (event.data?.type === "SAAS_INIT") {
        setPlatform((current) => mergeSaasInit(current, event.data));
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  useEffect(() => {
    let active = true;
    if (isStandaloneTrial) {
      setIsLaunching(false);
      return () => {
        active = false;
      };
    }

    setIsLaunching(true);
    launchTool(platform)
      .then((state) => {
        if (!active) return;
        setIntegral(state.user.integral);
        setToolCost(state.tool.integral);
      })
      .catch(() => active && setStatus("暂时无法读取积分信息，请刷新后重试"))
      .finally(() => active && setIsLaunching(false));

    return () => {
      active = false;
    };
  }, [platform.userId, platform.toolId, platform.launchUrl, isStandaloneTrial]);

  const guideCopy = useMemo(() => {
    if (guidedStep === "room") {
      return {
        eyebrow: "第 1 步",
        title: "先上传客户房间照片",
        desc: "上传后我会自动解析空间、光线和透视，不需要您再找按钮。",
        hint: "建议照片能看到地面、墙面、窗户或主光源。"
      };
    }
    if (guidedStep === "sofa") {
      return {
        eyebrow: "第 2 步",
        title: "现在上传沙发照片",
        desc: "沙发上传后会自动分析款式、材质和适合的摆放方式。",
        hint: "建议沙发主体完整，正面或 45 度角，背景尽量简单。"
      };
    }
    if (guidedStep === "review") {
      return {
        eyebrow: "第 3 步",
        title: "确认试摆方案",
        desc: "我已经整理好空间和沙发分析。您只需要确认位置、视角和比例即可生成。",
        hint: "高级设置已折叠，默认参数适合先快速看效果。"
      };
    }
    if (guidedStep === "generating") {
      return {
        eyebrow: "第 4 步",
        title: "正在生成试摆效果",
        desc: "我会按已确认的方案生成图片，完成后自动进入结果页。",
        hint: "多视角会一次完成，请保持页面打开直到生成结束。"
      };
    }
    return {
      eyebrow: "完成",
      title: "查看试摆效果",
      desc: "拖动滑块对比原图和效果图，也可以下载结果或重新生成。",
      hint: "如需换角度，返回方案设置后重新选择视角。"
    };
  }, [guidedStep]);

  function addChatMessage(message: ChatMessage) {
    setChatMessages((current) => [...current, message]);
  }

  function submitChatNote() {
    const note = chatDraft.trim();
    if (!note) return;
    setChatDraft("");
    addChatMessage({ role: "user", text: note });

    if (/^(你好|嗨|hi|hello)/i.test(note)) {
      addChatMessage({ role: "assistant", text: "你好，很高兴帮您做别墅沙发试摆。您可以问我能做什么，或直接说“开始试摆”。" });
      return;
    }

    if (/(能做什么|可以干嘛|做什么|功能|怎么用)/.test(note)) {
      addChatMessage({ role: "assistant", text: "我能根据一张房间照片和一张沙发照片，生成沙发在房间里的真实试摆效果。流程是：上传房间，自动分析；上传沙发，自动匹配；确认方案后生成效果图。准备好后对我说“开始试摆”。" });
      return;
    }

    if (/(开始|试摆|上传.*房间|房间.*照片)/.test(note) && !roomImage) {
      setAgentFlowStarted(true);
      addChatMessage({ role: "assistant", text: "好的，我们开始。请先上传别墅房间照片，我会自动分析空间、光线和透视关系。" });
      return;
    }

    if (!agentFlowStarted) {
      addChatMessage({ role: "assistant", text: "我可以先回答您的问题。准备生成试摆效果时，直接对我说“开始试摆”即可。" });
      return;
    }

    if (agentFlowStarted) {
      setSettings((current) => ({ ...current, notes: current.notes ? `${current.notes}\n${note}` : note }));
      addChatMessage({
        role: "assistant",
        text: guidedStep === "review"
          ? "收到，这条要求已加入试摆方案。您可以继续补充，或点击下方按钮生成效果图。"
          : "收到，我已记下这条试摆要求，后续会与房间和沙发照片一起用于合成。"
      });
      return;
    }
  }

  async function handleUpload(kind: "room" | "sofa" | "room-reference", file?: File) {
    if (!file) return;
    setError("");
    setStatus("正在压缩图片...");
    try {
      const image = await compressImage(
        file,
        kind === "room-reference" ? 900 : undefined,
        kind === "room-reference" ? 0.68 : undefined,
        kind === "room-reference" ? GEMINI_REFERENCE_TARGET_BYTES : GEMINI_IMAGE_TARGET_BYTES
      );
      setResults([]);
      if (kind === "room") {
        setAgentFlowStarted(true);
        setRoomImage(image);
        setRoomReferenceImages([]);
        setSofaImage(null);
        setSofaForegroundImage(null);
      setClearedRoomImage(null);
      setAnalysis(null);
      setReviewSubstep("plan");
      setGuidedStep("room");
        addChatMessage({ role: "user", text: "已上传房间照片", image });
        addChatMessage({ role: "assistant", text: "房间照片已收到，我正在分析空间尺度、光线和透视关系。" });
        await autoAnalyzeRoom(image);
      } else if (kind === "room-reference") {
        setRoomReferenceImages((current) => current.length >= 5 ? current : [...current, image]);
        setStatus("已加入空间补充角度，后续分析和生成会一并参考");
        addChatMessage({ role: "user", text: "已补充一张房间不同角度照片", image });
      } else {
        setSofaImage(image);
        setSofaForegroundImage(null);
        setClearedRoomImage(null);
        addChatMessage({ role: "user", text: "已上传沙发照片", image });
        addChatMessage({ role: "assistant", text: "沙发照片已收到，我正在识别款式、材质、颜色和比例。" });
        await autoAnalyzeSofa(image);
      }
    } catch (err) {
      setError(userFacingError(err, "上传失败"));
      setStatus("");
    }
  }

  async function autoAnalyzeRoom(nextRoomImage: UploadedImage) {
    setIsAnalyzingRoom(true);
    setStatus("正在自动解析房间...");
    try {
      if (!isStandaloneTrial) {
        await verifyIntegral(platform);
      }
      const nextAnalysis = await analyzeScene(nextRoomImage, null, roomReferenceImages, settings.model, platform.context, platform.prompt, settings.notes);
      setAnalysis({
        ...nextAnalysis,
        sofaSummary: "等待上传沙发照片后补充沙发分析。"
      });
      setGuidedStep("sofa");
      setStatus("房间解析完成，请上传沙发照片");
      addChatMessage({ role: "assistant", text: "房间解析完成。现在请上传要试摆的沙发照片，建议选择正面或 45 度角、主体完整的图片。" });
    } catch (err) {
      setError(userFacingError(err, "房间解析失败"));
      setStatus("房间解析失败，您仍可继续上传沙发后重试");
      setGuidedStep("sofa");
      addChatMessage({ role: "assistant", text: "房间分析暂时没有完成，但我们仍可继续。请上传沙发照片，我会在生成时重新匹配。" });
    } finally {
      setIsAnalyzingRoom(false);
    }
  }

  async function autoAnalyzeSofa(nextSofaImage: UploadedImage) {
    if (!roomImage) {
      setError("请先上传房间照片");
      return;
    }

    setIsAnalyzingSofa(true);
    setStatus("正在自动解析沙发并合并试摆建议...");
    try {
      if (!isStandaloneTrial) {
        await verifyIntegral(platform);
      }
      const nextAnalysis = await analyzeScene(roomImage, nextSofaImage, roomReferenceImages, settings.model, platform.context, platform.prompt, settings.notes);
      setAnalysis(nextAnalysis);
      setStatus("正在提取并核验沙发前景...");
      const foreground = await extractSofaForeground(nextSofaImage, settings);
      setSofaForegroundImage(foreground);
      setStatus("正在移除原场景中的沙发，生成干净试摆底图...");
      const clearedRoom = await eraseExistingSofas(roomImage, settings);
      setClearedRoomImage(clearedRoom);
      setReviewSubstep("plan");
      setGuidedStep("review");
      setStatus("沙发前景和干净场景已锁定，请确认试摆方案");
      addChatMessage({ role: "assistant", text: `已完成沙发前景提取和原场景清场，后续试摆将只在这张干净底图上合成。我的建议是：${nextAnalysis.placementAdvice}。请在下方确认方案，或直接告诉我您想调整的位置和视角。` });
    } catch (err) {
      setError(userFacingError(err, "沙发解析失败"));
      setSofaForegroundImage(null);
      setClearedRoomImage(null);
      setStatus("沙发前景或场景清场失败，请重新上传或重试；系统不会使用原图继续试摆");
      addChatMessage({ role: "assistant", text: "沙发前景提取或原场景清场没有完成。为避免生成出错误沙发或不同房间，系统已停止后续试摆，请重新上传清晰图片后重试。" });
    } finally {
      setIsAnalyzingSofa(false);
    }
  }

  async function handleGenerate(correctionPrompt = "") {
    if (!roomImage || !sofaImage || !sofaForegroundImage || !clearedRoomImage || !analysis) {
      setError("请先完成房间和沙发上传");
      return;
    }

    setError("");
    setIsGenerating(true);
    setGuidedStep("generating");
    setStatus("正在生成试摆效果图...");
    addChatMessage({ role: "assistant", text: "方案已确认，正在生成试摆效果图。我会匹配沙发尺度、房间透视、光照和地面阴影。" });
    try {
      if (!isStandaloneTrial) {
        await verifyIntegral(platform);
      }
      const generationSettings = correctionPrompt
        ? { ...settings, notes: `${settings.notes}\n质检纠正要求：${correctionPrompt}`.trim() }
        : settings;
      const images = await generatePlacementImages(clearedRoomImage, sofaForegroundImage, roomReferenceImages, analysis, generationSettings, platform.context, platform.prompt);
      if (images.length !== generationSettings.perspectives.length) {
        throw new Error(`视角结果不完整：已选择 ${generationSettings.perspectives.length} 个视角，但仅生成 ${images.length} 张图片。请重新生成。`);
      }
      const generated: GeneratedImageResult[] = images.map((item, index) => ({
        id: `${Date.now()}-${index}`,
        perspective: item.perspective,
        title: item.title,
        imageUrl: item.imageUrl,
        uploadStatus: isStandaloneTrial ? "skipped" : "pending"
      }));

      if (!isStandaloneTrial) {
        const currentIntegral = await consumeIntegral(platform);
        if (typeof currentIntegral === "number") setIntegral(currentIntegral);
      } else {
        setIntegral((value) => Math.max(0, value - toolCost));
      }

      setResults(generated);
      setSelectedResult(0);
      setGuidedStep("result");
      setStatus(`已生成 ${generated.length} 个视角结果`);
      addChatMessage({ role: "assistant", text: `试摆效果已经生成，共 ${generated.length} 个视角。您可以在下方切换视角、拖动对比滑块或下载图片。` });

      if (!isStandaloneTrial) {
        await uploadGeneratedResults(generated);
      }

      if (generated.length) {
        setStatus("试摆效果已生成，正在自动检查是否符合确认方案...");
        try {
          const qualities = await Promise.all(generated.map((item) => checkGeneratedPlacement(
            roomImage,
            sofaImage,
            roomReferenceImages,
            item.imageUrl,
            analysis,
            generationSettings,
            platform.context,
            platform.prompt
          )));
          setResults((current) => current.map((item, index) => ({ ...item, quality: qualities[index] })));
          const issues = qualities.flatMap((quality, index) => quality.passed ? [] : [`${generated[index].title}：${quality.issues.join("；")}`]);
          setStatus(issues.length ? "试摆效果已生成，请查看自动检查建议" : "试摆效果已生成并通过自动检查");
          if (issues.length) {
            addChatMessage({ role: "assistant", text: `自动检查发现：${issues.join("；")}。您可以返回调整方案后重新生成。` });
          }
        } catch {
          setStatus("试摆效果已生成，自动检查暂不可用，请人工确认效果");
        }
      }
    } catch (err) {
      setError(userFacingError(err, "生成失败"));
      setGuidedStep("review");
      setReviewSubstep("settings");
      setStatus("生成失败，请调整方案后重试");
    } finally {
      setIsGenerating(false);
    }
  }

  async function uploadGeneratedResults(generated: GeneratedImageResult[]) {
    setStatus("生成完成，正在保存结果图...");
    const settled = await Promise.all(generated.map(async (item, index) => {
      try {
        const blob = await compressDataUrlToBlob(item.imageUrl);
        const saved = await persistResultImage(platform, blob, `${item.perspective}-${Date.now()}-${index + 1}.jpg`);
        setResults((current) => current.map((result) => result.id === item.id ? {
          ...result,
          savedUrl: saved.savedUrl,
          recordId: saved.recordId,
          uploadStatus: "saved"
        } : result));
        return { ok: true };
      } catch (err) {
        setResults((current) => current.map((result) => result.id === item.id ? {
          ...result,
          uploadStatus: "failed"
        } : result));
        return { ok: false, message: userFacingError(err, "结果图保存失败") };
      }
    }));

    const failed = settled.filter((item) => !item.ok);
    setStatus(failed.length
      ? `生成已完成，但有 ${failed.length} 张结果图保存失败，请稍后重试或下载保存`
      : "生成已完成，结果图已保存到我的图片");
  }

  function updateAnalysisField<K extends keyof SceneAnalysis>(field: K, value: SceneAnalysis[K]) {
    if (!analysis) return;
    setAnalysis({ ...analysis, [field]: value });
  }

  function updatePlacementPlanField<K extends keyof TrialPlacementPlan>(field: K, value: TrialPlacementPlan[K]) {
    if (!analysis) return;
    setAnalysis({ ...analysis, placementPlan: { ...analysis.placementPlan, [field]: value } });
  }

  async function refreshPlacementPlan() {
    if (!sofaImage) return;
    await autoAnalyzeSofa(sofaImage);
  }

  function togglePerspective(value: PlacementSettings["perspectives"][number]) {
    setSettings((current) => {
      const exists = current.perspectives.includes(value);
      const next = exists ? current.perspectives.filter((item) => item !== value) : [...current.perspectives, value];
      return { ...current, perspectives: next.length ? next : ["medium"] };
    });
  }

  function resetFlow() {
    setGuidedStep("room");
    setReviewSubstep("plan");
    setRoomImage(null);
    setRoomReferenceImages([]);
    setSofaImage(null);
    setSofaForegroundImage(null);
    setClearedRoomImage(null);
    setAnalysis(null);
    setResults([]);
    setAgentFlowStarted(false);
    setChatMessages(initialChatMessages);
    setError("");
    setStatus("准备就绪，请上传房间照片开始试摆");
  }

  const currentStepContent = (
    <>
      {guidedStep === "room" && (
        <UploadStep
          kind="room"
          image={roomImage}
          busy={isAnalyzingRoom}
          title="上传房间照片"
          description="上传后自动解析空间，不需要手动点击下一步。"
          onFile={(file) => handleUpload("room", file)}
        />
      )}

      {guidedStep === "sofa" && (
        <div className={styles.focusLayout}>
          <PreviewCard title="房间已解析" image={roomImage} loading={isAnalyzingRoom} />
          <RoomReferenceUploader
            images={roomReferenceImages}
            onFiles={(files) => files.forEach((file) => handleUpload("room-reference", file))}
          />
          <UploadStep
            kind="sofa"
            image={sofaImage}
            busy={isAnalyzingSofa}
            title="上传沙发照片"
            description="上传后自动合并房间和沙发分析，生成试摆建议。"
            onFile={(file) => handleUpload("sofa", file)}
          />
        </div>
      )}

      {guidedStep === "review" && analysis && (
        <ReviewStep
          analysis={analysis}
          sofaForegroundImage={sofaForegroundImage}
          settings={settings}
          substep={reviewSubstep}
          showAnalysisEditor={showAnalysisEditor}
          onToggleAnalysis={() => setShowAnalysisEditor((value) => !value)}
          onAnalysisChange={updateAnalysisField}
          onPlanChange={updatePlacementPlanField}
          onRefreshPlan={refreshPlacementPlan}
          onSettingsChange={setSettings}
          onPerspectiveToggle={togglePerspective}
          onConfirmPlan={() => setReviewSubstep("settings")}
          onBackToPlan={() => setReviewSubstep("plan")}
          onGenerate={handleGenerate}
          isGenerating={isGenerating}
          isRefreshingPlan={isAnalyzingSofa}
        />
      )}

      {guidedStep === "generating" && (
        <section className={styles.generatingCard}>
          <Loader2 className={styles.spin} size={42} />
          <h3>正在生成别墅沙发试摆效果</h3>
          <p>我正在匹配房间透视、沙发尺度、光照和地面阴影。完成后会自动进入结果页。</p>
        </section>
      )}

      {guidedStep === "result" && roomImage && currentResult && (
        <ResultStep
          roomImage={roomImage}
          result={currentResult}
          results={results}
          selectedResult={selectedResult}
          compareValue={compareValue}
          ratio={settings.ratio}
          onSelectResult={setSelectedResult}
          onCompareChange={setCompareValue}
          onBack={() => { setReviewSubstep("settings"); setGuidedStep("review"); }}
          onRegenerate={handleGenerate}
          onCorrect={() => handleGenerate(currentResult.quality?.correctionPrompt || "")}
          isGenerating={isGenerating}
        />
      )}
    </>
  );

  return (
    <main className={styles.toolShell}>
      <header className={styles.toolHeader}>
        <div className={styles.brandBlock}>
          <div className={styles.logoMark}>
            <Sparkles size={22} />
          </div>
          <div>
            <h1>{TOOL_NAME}</h1>
            <p>智能引导式试摆 · 当前只展示下一步</p>
          </div>
        </div>

        <div className={styles.headerActions}>
          <div className={styles.modeSwitch}>
            <button className={mode === "agent" ? styles.activeMode : ""} onClick={() => setMode("agent")}>
              <Bot size={16} />
              智能体聊天
            </button>
            <button className={mode === "expert" ? styles.activeMode : ""} onClick={() => setMode("expert")}>
              <Settings2 size={16} />
              工作台模式
            </button>
          </div>
          <div className={styles.integralPill}>
            <Sparkles size={16} />
            {isLaunching ? "积分读取中" : `积分: ${integral}`}
          </div>
        </div>
      </header>

      {mode === "agent" ? (
        <ChatWorkspace
          messages={chatMessages}
          stepContent={agentFlowStarted ? currentStepContent : null}
          draft={chatDraft}
          status={isAnalyzingRoom || isAnalyzingSofa || isGenerating ? status : ""}
          error={error}
          onDraftChange={setChatDraft}
          onSend={submitChatNote}
          onReset={resetFlow}
        />
      ) : (
        <>
          <section className={styles.flowHeader}>
            <div>
              <span>{guideCopy.eyebrow}</span>
              <h2>{guideCopy.title}</h2>
              <p>{guideCopy.desc}</p>
            </div>
            <button className={styles.secondaryButton} onClick={resetFlow}>
              <RefreshCcw size={16} />
              重新开始
            </button>
          </section>

          <section className={styles.progressRail}>
            {stepMeta.map((item, index) => {
              const activeIndex = stepMeta.findIndex((step) => step.key === guidedStep);
              const isDone = index < activeIndex;
              const isActive = item.key === guidedStep;
              return (
                <div className={`${styles.progressItem} ${isActive ? styles.currentProgress : ""} ${isDone ? styles.doneProgress : ""}`} key={item.key}>
                  <span>{isDone ? <CheckCircle2 size={16} /> : index + 1}</span>
                  {item.label}
                </div>
              );
            })}
          </section>

          <section className={styles.statusBar}>
            <span>{guideCopy.hint}</span>
            {status && <strong>{status}</strong>}
            {error && <strong className={styles.errorText}>{error}</strong>}
          </section>

          <section className={styles.workbenchStage}>{currentStepContent}</section>
        </>
      )}
    </main>
  );
}

function ChatWorkspace({
  messages,
  stepContent,
  draft,
  status,
  error,
  onDraftChange,
  onSend,
  onReset
}: {
  messages: ChatMessage[];
  stepContent: ReactNode;
  draft: string;
  status: string;
  error: string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  onReset: () => void;
}) {
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, stepContent]);

  return (
    <section className={styles.chatWorkspace}>
      <header className={styles.chatWorkspaceHeader}>
        <div className={styles.chatAgentIdentity}>
          <span className={styles.chatAvatar}><Bot size={19} /></span>
          <div>
            <strong>AI 别墅沙发试摆助手</strong>
            <small>正在为您提供一对一试摆服务</small>
          </div>
        </div>
        <button className={styles.secondaryButton} onClick={onReset}>
          <RefreshCcw size={16} />
          重置对话
        </button>
      </header>

      <div className={styles.chatConversation}>
        {messages.map((message, index) => (
          message.role === "assistant" ? (
            <div className={styles.assistantMessage} key={`${message.text}-${index}`}>
              <span className={styles.messageAvatar}><Bot size={16} /></span>
              <p>{message.text}</p>
            </div>
          ) : (
            <div className={styles.userMessage} key={`${message.text}-${index}`}>
              <div className={styles.userBubble}>
                {message.image && <img src={message.image.dataUrl} alt={message.text} />}
                <p>{message.text}</p>
              </div>
            </div>
          )
        ))}
        {stepContent && <div className={styles.chatTask}>{stepContent}</div>}
        {(status || error) && (
          <div className={`${styles.chatStatus} ${error ? styles.errorText : ""}`}>
            {error || status}
          </div>
        )}
        <div ref={chatEndRef} />
      </div>

      <footer className={styles.chatComposer}>
        <input
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSend();
            }
          }}
          placeholder="补充任何要求，例如：朝向壁炉、替换旧沙发、保留地毯、留出通道…"
        />
        <button className={styles.sendButton} onClick={onSend} aria-label="发送试摆要求" disabled={!draft.trim()}>
          <Send size={19} />
        </button>
      </footer>
    </section>
  );
}

function UploadStep({
  title,
  description,
  image,
  busy,
  onFile
}: {
  kind: "room" | "sofa";
  title: string;
  description: string;
  image: UploadedImage | null;
  busy: boolean;
  onFile: (file?: File) => void;
}) {
  return (
    <section className={styles.uploadHero}>
      <label className={styles.bigUploader}>
        <input type="file" accept="image/*" onChange={(event) => onFile(event.target.files?.[0])} />
        {image ? (
          <img src={image.dataUrl} alt={title} />
        ) : (
          <span>
            <UploadCloud size={44} />
            <strong>{title}</strong>
            <small>{description}</small>
            <em>支持 JPG、PNG、WebP，最大 20MB，上传后自动压缩</em>
          </span>
        )}
        {busy && (
          <div className={styles.busyOverlay}>
            <Loader2 className={styles.spin} size={30} />
            正在自动解析...
          </div>
        )}
      </label>
    </section>
  );
}

function PreviewCard({ title, image, loading }: { title: string; image: UploadedImage | null; loading?: boolean }) {
  return (
    <section className={styles.previewCard}>
      <h3>{title}</h3>
      {image ? <img src={image.dataUrl} alt={title} /> : <div className={styles.previewEmpty}>等待上传</div>}
      {loading && <p>解析中...</p>}
    </section>
  );
}

function RoomReferenceUploader({
  images,
  onFiles
}: {
  images: UploadedImage[];
  onFiles: (files: File[]) => void;
}) {
  const remaining = 5 - images.length;
  return (
    <section className={styles.referenceUploader}>
      <div>
        <strong>补充房间角度</strong>
        <span>可选，最多 5 张。建议上传左右侧、斜角或窗边视角。</span>
      </div>
      {images.length > 0 && (
        <div className={styles.referenceThumbs}>
          {images.map((image) => <img key={`${image.fileName}-${image.size}`} src={image.dataUrl} alt="房间补充角度" />)}
        </div>
      )}
      {remaining > 0 && (
        <label className={styles.referenceUploadButton}>
          <ImagePlus size={17} />
          添加补充照片（还可添加 {remaining} 张）
          <input
            type="file"
            accept="image/*"
            multiple
            onChange={(event) => onFiles(Array.from(event.target.files ?? []).slice(0, remaining))}
          />
        </label>
      )}
    </section>
  );
}

function ReviewStep({
  analysis,
  sofaForegroundImage,
  settings,
  substep,
  showAnalysisEditor,
  onToggleAnalysis,
  onAnalysisChange,
  onPlanChange,
  onRefreshPlan,
  onSettingsChange,
  onPerspectiveToggle,
  onConfirmPlan,
  onBackToPlan,
  onGenerate,
  isGenerating,
  isRefreshingPlan
}: {
  analysis: SceneAnalysis;
  sofaForegroundImage: UploadedImage | null;
  settings: PlacementSettings;
  substep: "plan" | "settings";
  showAnalysisEditor: boolean;
  onToggleAnalysis: () => void;
  onAnalysisChange: <K extends keyof SceneAnalysis>(field: K, value: SceneAnalysis[K]) => void;
  onPlanChange: <K extends keyof TrialPlacementPlan>(field: K, value: TrialPlacementPlan[K]) => void;
  onRefreshPlan: () => void;
  onSettingsChange: (settings: PlacementSettings) => void;
  onPerspectiveToggle: (value: PlacementSettings["perspectives"][number]) => void;
  onConfirmPlan: () => void;
  onBackToPlan: () => void;
  onGenerate: () => void;
  isGenerating: boolean;
  isRefreshingPlan: boolean;
}) {
  const chosenCandidate = analysis.placementPlan.candidates.find(
    (candidate) => candidate.id === analysis.placementPlan.selectedCandidateId
  );

  return (
    <section className={styles.reviewLayout}>
      <div className={styles.reviewPanel}>
        {substep === "plan" ? (
          <>
            <div className={styles.planOverview}>
              <div className={styles.aiSummary}>
                <div>
                  <Bot size={20} />
                  <strong>AI 已整理试摆建议</strong>
                </div>
                <p>{analysis.placementAdvice}</p>
                <ul>
                  <li>{analysis.lighting}</li>
                  <li>{analysis.perspective}</li>
                </ul>
              </div>

              <section className={styles.planCard}>
                <div className={styles.planHeader}>
                  <div>
                    <Bot size={18} />
                    <strong>AI 已理解的试摆方案</strong>
                  </div>
                  <span>确认后进入生成设置</span>
                </div>
                <p>{analysis.placementPlan.summary}</p>
                {chosenCandidate && (
                  <div className={styles.planDecision}>
                    <strong>已采用：{chosenCandidate.label}</strong>
                    <span>{chosenCandidate.reasons.join("；")}</span>
                  </div>
                )}
                <div className={styles.planActions}>
                  <button className={styles.secondaryButton} onClick={onRefreshPlan} disabled={isRefreshingPlan}>
                    {isRefreshingPlan ? <Loader2 className={styles.spin} size={16} /> : <RefreshCcw size={16} />}
                    按当前要求重新规划
                  </button>
                  {sofaForegroundImage && <span>沙发前景已锁定</span>}
                </div>
                <div className={styles.planGrid}>
                  <PlanField label="摆放位置" value={analysis.placementPlan.placement} onChange={(value) => onPlanChange("placement", value)} />
                  <PlanField label="沙发朝向" value={analysis.placementPlan.facing} onChange={(value) => onPlanChange("facing", value)} />
                  <PlanField label="尺寸与比例" value={analysis.placementPlan.scale} onChange={(value) => onPlanChange("scale", value)} />
                  <PlanListField label="保留内容" value={analysis.placementPlan.preserve} onChange={(value) => onPlanChange("preserve", value)} />
                  <PlanListField label="移除或替换" value={analysis.placementPlan.remove} onChange={(value) => onPlanChange("remove", value)} />
                  <PlanListField label="需要避免" value={analysis.placementPlan.avoid} onChange={(value) => onPlanChange("avoid", value)} />
                </div>
              </section>
            </div>
            <button className={styles.primaryButton} onClick={onConfirmPlan}>
              <CheckCircle2 size={18} />
              确认方案，进入生成设置
            </button>
          </>
        ) : (
          <>
            <div className={styles.settingsHeader}>
              <div>
                <strong>生成设置</strong>
                <span>比例、视角、清晰度和人体模特会共同影响最终画面</span>
              </div>
              <button className={styles.secondaryButton} onClick={onBackToPlan}>
                <ChevronLeft size={16} />
                返回方案
              </button>
            </div>

            <div className={styles.settingsGrid}>
              <div className={styles.optionBlock}>
                <div className={styles.optionHeading}>
                  <strong>图片比例</strong>
                  <span>同步影响画幅</span>
                </div>
                <div className={styles.choiceGrid}>
                  {(["1:1", "3:4", "4:3", "16:9"] as const).map((ratio) => (
                    <button key={ratio} className={settings.ratio === ratio ? styles.selectedChoice : ""} onClick={() => onSettingsChange({ ...settings, ratio })} aria-pressed={settings.ratio === ratio}>
                      {ratio}
                    </button>
                  ))}
                </div>
              </div>

              <div className={styles.optionBlock}>
                <div className={styles.optionHeading}>
                  <strong>选择视角</strong>
                  <span>可多选</span>
                </div>
                <div className={styles.choiceGrid}>
                  {Object.entries(perspectiveLabels).map(([key, label]) => (
                    <button key={key} className={settings.perspectives.includes(key as never) ? styles.selectedChoice : ""} onClick={() => onPerspectiveToggle(key as never)} aria-pressed={settings.perspectives.includes(key as never)}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className={styles.optionBlock}>
                <div className={styles.optionHeading}>
                  <strong>图片清晰度</strong>
                  <span>越高耗时越长</span>
                </div>
                <div className={styles.choiceGrid}>
                  {(["1K", "2K", "4K"] as const).map((clarity) => (
                    <button key={clarity} className={settings.clarity === clarity ? styles.selectedChoice : ""} onClick={() => onSettingsChange({ ...settings, clarity })} aria-pressed={settings.clarity === clarity}>
                      {clarity}
                    </button>
                  ))}
                </div>
              </div>

              <div className={styles.optionBlock}>
                <div className={styles.optionHeading}>
                  <strong>人体模特</strong>
                  <span>自然坐在目标沙发上</span>
                </div>
                <label className={styles.toggleControl}>
                  <input type="checkbox" checked={settings.addHumanModel} onChange={(event) => onSettingsChange({ ...settings, addHumanModel: event.target.checked })} />
                  <span>添加人体模特</span>
                </label>
                {settings.addHumanModel && (
                  <div className={styles.modelOptions}>
                    <div>
                      <span>性别</span>
                      <div className={styles.choiceGrid}>
                        {([["any", "不限"], ["female", "女"], ["male", "男"]] as const).map(([value, label]) => (
                          <button key={value} className={settings.humanModelGender === value ? styles.selectedChoice : ""} onClick={() => onSettingsChange({ ...settings, humanModelGender: value })} aria-pressed={settings.humanModelGender === value}>
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <span>年龄段</span>
                      <div className={styles.choiceGrid}>
                        {([["adult", "成人"], ["child", "儿童"], ["senior", "老年"]] as const).map(([value, label]) => (
                          <button key={value} className={settings.humanModelAge === value ? styles.selectedChoice : ""} onClick={() => onSettingsChange({ ...settings, humanModelAge: value })} aria-pressed={settings.humanModelAge === value}>
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <label className={styles.freeformField}>
                补充合成要求
                <textarea value={settings.notes} onChange={(event) => onSettingsChange({ ...settings, notes: event.target.value })} placeholder="例如：移除原有黑色沙发；保留茶几和地毯；新沙发朝向幕布；右侧留出通道" />
              </label>
            </div>

            <div className={styles.foldActions}>
              <button className={styles.secondaryButton} onClick={onToggleAnalysis}>
                <PenLine size={16} />
                {showAnalysisEditor ? "收起分析内容" : "编辑分析内容"}
              </button>
            </div>

            {showAnalysisEditor && (
              <div className={styles.analysisEditor}>
                <AnalysisField label="房间分析" value={analysis.roomSummary} onChange={(value) => onAnalysisChange("roomSummary", value)} />
                <AnalysisField label="沙发分析" value={analysis.sofaSummary} onChange={(value) => onAnalysisChange("sofaSummary", value)} />
                <AnalysisField label="光线判断" value={analysis.lighting} onChange={(value) => onAnalysisChange("lighting", value)} />
                <AnalysisField label="透视判断" value={analysis.perspective} onChange={(value) => onAnalysisChange("perspective", value)} />
                <AnalysisField label="摆放建议" value={analysis.placementAdvice} onChange={(value) => onAnalysisChange("placementAdvice", value)} />
              </div>
            )}

            <button className={styles.primaryButton} onClick={onGenerate} disabled={isGenerating}>
              {isGenerating ? <Loader2 className={styles.spin} size={18} /> : <Wand2 size={18} />}
              一键生成试摆效果
            </button>
          </>
        )}
      </div>
    </section>
  );
}

function ResultStep({
  roomImage,
  result,
  results,
  selectedResult,
  compareValue,
  ratio,
  onSelectResult,
  onCompareChange,
  onBack,
  onRegenerate,
  onCorrect,
  isGenerating
}: {
  roomImage: UploadedImage;
  result: GeneratedImageResult;
  results: GeneratedImageResult[];
  selectedResult: number;
  compareValue: number;
  ratio: ImageRatio;
  onSelectResult: (index: number) => void;
  onCompareChange: (value: number) => void;
  onBack: () => void;
  onRegenerate: () => void;
  onCorrect: () => void;
  isGenerating: boolean;
}) {
  const [isViewerOpen, setIsViewerOpen] = useState(false);
  const [viewerImage, setViewerImage] = useState<"result" | "original">("result");

  return (
    <section className={styles.resultPage}>
      <p className={styles.resultSummary}>本次已生成 {results.length} 个视角结果</p>
      <div className={styles.resultTabs}>
        {results.map((item, index) => (
          <button key={item.id} className={selectedResult === index ? styles.selectedChoice : ""} onClick={() => onSelectResult(index)}>
            {item.title}
          </button>
        ))}
      </div>
      <button className={`${styles.resultImageButton} ${ratioClass[ratio]}`} onClick={() => { setViewerImage("result"); setIsViewerOpen(true); }}>
        <img src={result.imageUrl} alt="生成效果图，点击查看大图" />
        <span><Maximize2 size={18} /> 点击查看大图</span>
      </button>
      <div className={styles.resultActions}>
        <button className={styles.secondaryButton} onClick={onBack}>
          <ChevronLeft size={16} />
          返回调整
        </button>
        <a className={styles.secondaryButton} href={result.imageUrl} download={`${result.title}.jpg`}>
          <Download size={16} />
          下载图片
        </a>
        <button className={styles.primaryInlineButton} onClick={onRegenerate} disabled={isGenerating}>
          <RefreshCcw size={16} />
          重新生成
        </button>
      </div>
      {result.quality && (
        <section className={result.quality.passed ? styles.qualityPassed : styles.qualityWarning}>
          <strong>{result.quality.passed ? "自动检查已通过" : "自动检查建议调整"}</strong>
          {!result.quality.passed && <p>{result.quality.issues.join("；")}</p>}
          {!result.quality.passed && result.quality.correctionPrompt && (
            <button className={styles.secondaryButton} onClick={onCorrect} disabled={isGenerating}>
              <RefreshCcw size={16} />
              按建议重新生成
            </button>
          )}
        </section>
      )}
      {isViewerOpen && (
        <div className={styles.imageViewer} role="dialog" aria-modal="true" aria-label="图片查看">
          <div className={styles.viewerToolbar}>
            <div>
              <button className={viewerImage === "result" ? styles.selectedChoice : ""} onClick={() => setViewerImage("result")}>效果图</button>
              <button className={viewerImage === "original" ? styles.selectedChoice : ""} onClick={() => setViewerImage("original")}>原图</button>
            </div>
            <button className={styles.viewerClose} onClick={() => setIsViewerOpen(false)} aria-label="关闭查看"><X size={22} /></button>
          </div>
          <img src={viewerImage === "result" ? result.imageUrl : roomImage.dataUrl} alt={viewerImage === "result" ? "生成效果图" : "原始房间图"} />
        </div>
      )}
    </section>
  );
}

function AnalysisField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className={styles.analysisField}>
      {label}
      <textarea value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function PlanField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className={styles.planField}>
      {label}
      <input value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function PlanListField({ label, value, onChange }: { label: string; value: string[]; onChange: (value: string[]) => void }) {
  return (
    <label className={styles.planField}>
      {label}
      <textarea value={value.join("；")} onChange={(event) => onChange(event.target.value.split(/[；;\n]/).map((item) => item.trim()).filter(Boolean))} />
    </label>
  );
}
