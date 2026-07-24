import type {
  GeminiAnalyzeResponse,
  GeminiImageResponse,
  GeminiGenerateRequest,
  GeminiQualityResponse,
  GenerationQualityCheck,
  PlacementSettings,
  SceneAnalysis,
  TrialPlacementPlan,
  UploadedImage
} from "../types";
import { perspectiveLabels } from "../constants";
import { buildAnalysisPrompt, buildGenerationPrompt, buildQualityPrompt, buildVirtualRoomPrompt } from "./prompt";
import { compressDataUrlToImage } from "./image";
import { resolvePlacementPlan } from "./placement";

export async function analyzeScene(
  roomImage: UploadedImage,
  sofaImage: UploadedImage | null,
  roomReferenceImages: UploadedImage[],
  model: string,
  extraContext: string,
  extraPrompt: string[],
  userRequirements = ""
): Promise<SceneAnalysis> {
  const response = await postGemini<GeminiAnalyzeResponse>({
    mode: "analyze",
    model,
    roomImage,
    roomReferenceImages,
    ...(sofaImage ? { sofaImage } : {}),
    systemPrompt: buildAnalysisPrompt(extraContext, extraPrompt, userRequirements)
  });

  return normalizeSceneAnalysis(response.analysis);
}

/** Frontend fallback: even a legacy/local API response must never leak objects into an editable text field. */
export function normalizeSceneAnalysis(value: unknown): SceneAnalysis {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    roomSummary: readableText(source.roomSummary, "已识别房间空间与地面关系。"),
    sofaSummary: readableText(source.sofaSummary, "已识别沙发主体、材质和外观。"),
    sofaIdentity: normalizeSofaIdentity(source.sofaIdentity, source.sofaSummary),
    lighting: readableText(source.lighting, "已判断主要光线方向。"),
    perspective: readableText(source.perspective, "已判断房间透视。"),
    placementAdvice: readableText(source.placementAdvice, "建议按空间动线自然摆放。"),
    constraints: readableList(source.constraints, ["保持房间主体结构不变"]),
    placementPlan: resolvePlacementPlan(normalizePlacementPlan(source.placementPlan, source.placementAdvice))
  };
}

function normalizeSofaIdentity(value: unknown, fallback: unknown) {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const summary = readableText(fallback, "目标沙发参考图中的产品主体");
  return {
    structure: readableText(source.structure, summary),
    seatCount: readableText(source.seatCount, "以参考图为准"),
    silhouette: readableText(source.silhouette, summary),
    armrest: readableText(source.armrest, "以参考图为准"),
    backrest: readableText(source.backrest, "以参考图为准"),
    cushions: readableText(source.cushions, "以参考图为准"),
    material: readableText(source.material, "以参考图为准"),
    color: readableText(source.color, "以参考图为准"),
    details: readableList(source.details, ["以参考图可见细节为准"])
  };
}

function normalizePlacementPlan(value: unknown, fallbackAdvice: unknown): TrialPlacementPlan {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const fallback = readableText(fallbackAdvice, "根据空间动线自然摆放目标沙发。");
  return {
    summary: readableText(source.summary, fallback),
    placement: readableText(source.placement, "由 AI 根据房间空间、动线和视觉焦点选择合适位置"),
    facing: readableText(source.facing, "根据主要视觉焦点和用户要求确定朝向"),
    scale: readableText(source.scale, "保持与房间尺度和透视关系协调"),
    preserve: readableList(source.preserve, ["保留未被用户明确要求移除的原有结构、家具与装饰"]),
    remove: readableList(source.remove, ["无明确移除对象"]),
    avoid: readableList(source.avoid, ["不要遮挡通道、门窗、主要采光和核心功能区"]),
    rationale: readableList(source.rationale, [fallback]),
    candidates: normalizeCandidates(source.candidates),
    selectedCandidateId: readableText(source.selectedCandidateId, "")
  };
}

function normalizeCandidates(value: unknown) {
  const items = Array.isArray(value) ? value : [];
  return items.map((item, index) => {
    const source = item && typeof item === "object" ? item as Record<string, unknown> : {};
    return {
      id: readableText(source.id, `candidate-${index + 1}`),
      label: readableText(source.label, `候选方案 ${index + 1}`),
      placement: readableText(source.placement, "由 AI 根据空间动线选择合适位置"),
      facing: readableText(source.facing, "面向主要视觉焦点"),
      scale: readableText(source.scale, "按房间透视协调缩放"),
      score: Number.isFinite(Number(source.score)) ? Number(source.score) : 0.5,
      reasons: readableList(source.reasons, ["符合空间视觉关系"]),
      blocksWalkway: source.blocksWalkway === true,
      conflictsWithPreservedItems: source.conflictsWithPreservedItems === true,
      violatesUserRequirements: source.violatesUserRequirements === true
    };
  });
}

function readableText(value: unknown, fallback: string): string {
  if (typeof value === "string") return value.trim() || fallback;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const text = value.map((item) => readableText(item, "")).filter(Boolean).join("；");
    return text || fallback;
  }
  if (value && typeof value === "object") {
    const text = Object.values(value as Record<string, unknown>).map((item) => readableText(item, "")).filter(Boolean).join("；");
    return text || fallback;
  }
  return fallback;
}

function readableList(value: unknown, fallback: string[]): string[] {
  const items = Array.isArray(value) ? value : value == null ? [] : [value];
  const result = items.map((item) => readableText(item, "")).filter(Boolean);
  return result.length ? result : fallback;
}

/**
 * Generate placement images — each perspective is independently generated.
 * Following the floor lamp project's approach: send room + product images directly to Gemini,
 * rely on detailed prompts for product preservation. No compositing step.
 */
export async function generatePlacementImages(
  roomImage: UploadedImage,
  sofaImage: UploadedImage,
  productReferenceImage: UploadedImage,
  roomReferenceImages: UploadedImage[],
  analysis: SceneAnalysis,
  settings: PlacementSettings,
  extraContext: string,
  extraPrompt: string[]
): Promise<GeminiImageResponse["images"]> {
  const requestedPerspectives = (["wide", "medium", "close"] as const).filter((p) => settings.perspectives.includes(p));

  // Generate each perspective independently — no master+variation dependency
  const images = await Promise.all(
    requestedPerspectives.map(async (perspective) => {
      const prompt = buildGenerationPrompt(analysis, settings, perspective, extraContext, extraPrompt);

      const response = await postGemini<GeminiImageResponse>({
        mode: "generate",
        model: settings.model,
        roomImage,
        roomReferenceImages,
        sofaImage,
        productReferenceImage,
        settings: { ...settings, perspectives: [perspective] },
        systemPrompt: prompt
      });

      // Find the image matching our requested perspective
      const image = response.images.find((img) => img.perspective === perspective)
        || response.images[0]; // fallback to first image if perspective label mismatch

      return {
        perspective,
        title: perspectiveLabels[perspective],
        imageUrl: image?.imageUrl || ""
      };
    })
  );

  // Filter out any failed perspectives
  const validImages = images.filter((img) => Boolean(img.imageUrl));
  if (validImages.length !== requestedPerspectives.length) {
    throw new Error(`视角结果不完整：已选择 ${requestedPerspectives.length} 个视角，但仅生成 ${validImages.length} 张图片。请重新生成。`);
  }

  return validImages;
}

/**
 * Generate virtual room images — each perspective independently generated.
 * Following the floor lamp project's approach with STYLE_SPECS.
 */
export async function generateVirtualRoomImages(
  sofaImage: UploadedImage,
  productReferenceImage: UploadedImage,
  analysis: SceneAnalysis,
  settings: PlacementSettings,
  extraContext: string,
  extraPrompt: string[]
): Promise<GeminiImageResponse["images"]> {
  const requestedPerspectives = (["wide", "medium", "close"] as const).filter((p) => settings.perspectives.includes(p));

  // Generate each perspective independently
  const images = await Promise.all(
    requestedPerspectives.map(async (perspective) => {
      const prompt = buildVirtualRoomPrompt(analysis, settings, perspective, extraContext, extraPrompt);

      const response = await postGemini<GeminiImageResponse>({
        mode: "generate",
        model: settings.model,
        sofaImage,
        productReferenceImage,
        settings: { ...settings, perspectives: [perspective] },
        systemPrompt: prompt
      });

      const image = response.images.find((img) => img.perspective === perspective)
        || response.images[0];

      return {
        perspective,
        title: perspectiveLabels[perspective],
        imageUrl: image?.imageUrl || ""
      };
    })
  );

  const validImages = images.filter((img) => Boolean(img.imageUrl));
  if (validImages.length !== requestedPerspectives.length) {
    throw new Error(`视角结果不完整：已选择 ${requestedPerspectives.length} 个视角，但仅生成 ${validImages.length} 张图片。请重新生成。`);
  }

  return validImages;
}

/**
 * Quality check for generated placement.
 * Checks product consistency and overall quality.
 */
export async function checkGeneratedPlacement(
  roomImage: UploadedImage,
  sofaImage: UploadedImage,
  roomReferenceImages: UploadedImage[],
  resultImageUrl: string,
  analysis: SceneAnalysis,
  settings: PlacementSettings,
  extraContext: string,
  extraPrompt: string[]
): Promise<GenerationQualityCheck> {
  const resultImage = await compressDataUrlToImage(resultImageUrl, "quality-check.jpg", 820, 0.64, 300 * 1024);
  const response = await postGemini<GeminiQualityResponse>({
    mode: "quality",
    model: settings.model,
    roomImage,
    roomReferenceImages,
    sofaImage,
    resultImage,
    analysis,
    settings,
    systemPrompt: buildQualityPrompt(analysis, settings, extraContext, extraPrompt)
  });
  return response.quality;
}

function dataUrlToImage(dataUrl: string): Pick<UploadedImage, "base64" | "mimeType"> {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(dataUrl);
  if (!match) {
    throw new Error("生成结果格式异常，暂时无法进行质量检查");
  }
  return { mimeType: match[1] as UploadedImage["mimeType"], base64: match[2] };
}

async function postGemini<T>(payload: GeminiGenerateRequest): Promise<T> {
  const body = JSON.stringify(payload);
  const bodySize = new Blob([body]).size;
  if (bodySize > 3.5 * 1024 * 1024) {
    throw new Error("请求图片体积仍然过大，可能被服务端拒绝。请减少补充角度图片，或上传分辨率更低的房间/沙发图后重试。");
  }
  const response = await fetch("/api/gemini", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body
  });

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw new Error(`Gemini 接口返回异常：${response.status}`);
  }

  const data = await response.json();
  if (!data.success) {
    throw new Error(data.message || "AI 处理失败");
  }
  return data as T;
}
