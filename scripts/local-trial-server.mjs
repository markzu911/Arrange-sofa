import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = normalize(join(fileURLToPath(import.meta.url), "..", ".."));
const distDir = join(root, "dist");
const preferredPort = Number(process.env.PORT || 5174);

class ImageGenerationUnavailable extends Error {
  constructor() {
    super("图片生成服务当前繁忙，请稍后重试。已尝试高精度与备用模型，但均未在限定时间内响应。");
  }
}

class GeminiUpstreamError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

loadEnv(join(root, ".env.local"));
loadEnv(join(root, ".env"));

const server = createServer(async (req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  try {
    if (url.pathname === "/api/gemini" && req.method === "POST") {
      await handleGemini(req, res);
      return;
    }

    serveStatic(url.pathname, res);
  } catch (error) {
    const statusCode = error instanceof GeminiUpstreamError
      ? error.statusCode
      : error instanceof ImageGenerationUnavailable
        ? 503
        : 500;
    console.error("[local-trial-server] request failed", {
      url: req.url,
      method: req.method,
      statusCode,
      ...describeError(error)
    });
    sendJson(res, statusCode, {
      success: false,
      message: error instanceof Error ? error.message : "本地服务处理失败"
    });
  }
});

listenWithFallback(server, preferredPort);

function listenWithFallback(targetServer, targetPort) {
  targetServer.once("error", (error) => {
    if (error?.code === "EADDRINUSE") {
      const nextPort = targetPort + 1;
      console.log(`Port ${targetPort} is in use, trying ${nextPort}...`);
      listenWithFallback(targetServer, nextPort);
      return;
    }
    throw error;
  });

  targetServer.listen(targetPort, () => {
    console.log(`Local trial server ready: http://localhost:${targetPort}`);
  });
}

function describeError(error) {
  if (!(error instanceof Error)) return { message: String(error) };
  const cause = error.cause instanceof Error || typeof error.cause === "object" && error.cause
    ? error.cause
    : undefined;
  return {
    name: error.name,
    message: error.message,
    stack: error.stack?.split("\n").slice(0, 5).join("\n"),
    cause: cause ? {
      name: cause.name,
      code: cause.code,
      errno: cause.errno,
      syscall: cause.syscall,
      address: cause.address,
      port: cause.port,
      message: cause.message
    } : undefined
  };
}

async function handleGemini(req, res) {
  const body = await readJson(req);
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    sendJson(res, 500, {
      success: false,
      message: "未配置 GEMINI_API_KEY，当前没有调用真实 Gemini API。请在 .env.local 或 Vercel 环境变量中配置后重启服务。"
    });
    return;
  }

  const model = mapModel(body.model, body.mode);
  const parts = [{ text: body.systemPrompt || "" }];

  if (body.roomImage?.base64) {
    parts.push({
      inlineData: {
        mimeType: body.roomImage.mimeType || "image/jpeg",
        data: body.roomImage.base64
      }
    });
  }

  for (const image of body.roomReferenceImages || []) {
    if (image.base64) {
      parts.push({
        inlineData: {
          mimeType: image.mimeType || "image/jpeg",
          data: image.base64
        }
      });
    }
  }

  if (body.sofaImage?.base64) {
    parts.push({
      inlineData: {
        mimeType: body.sofaImage.mimeType || "image/jpeg",
        data: body.sofaImage.base64
      }
    });
  }

  if (body.resultImage?.base64) {
    parts.push({
      inlineData: {
        mimeType: body.resultImage.mimeType || "image/jpeg",
        data: body.resultImage.base64
      }
    });
  }

  if (body.mode === "generate") {
    const images = await generateImagesWithInteractions(body, apiKey, model);
    sendJson(res, 200, images.length ? { success: true, images } : createMockResponse(body));
    return;
  }

  if (body.mode === "cutout" || body.mode === "erase") {
    const { response, raw } = await requestImageWithFallback(body, apiKey, model, "wide");
    if (!response.ok) throw toGeminiUpstreamError(response.status, raw, body.mode === "erase" ? "原场景清场失败" : "沙发前景提取失败");
    const image = extractInteractionImage(JSON.parse(raw));
    if (!image) throw new Error(body.mode === "erase" ? "Gemini 未返回可用的干净场景图" : "Gemini 未返回可用的沙发前景图");
    sendJson(res, 200, { success: true, images: [{ perspective: "wide", title: body.mode === "erase" ? "干净场景" : "沙发前景", imageUrl: `data:${image.mimeType};base64,${image.data}` }] });
    return;
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { temperature: 0.2, responseMimeType: "application/json" }
      })
    }
  );

  const raw = await response.text();
  if (!response.ok) {
    sendJson(res, response.status, {
      success: false,
      message: parseGeminiError(raw) || "Gemini 请求失败"
    });
    return;
  }

  const data = JSON.parse(raw);
  if (body.mode === "analyze") {
    sendJson(res, 200, { success: true, analysis: parseAnalysis(data) });
    return;
  }

  if (body.mode === "quality") {
    sendJson(res, 200, { success: true, quality: parseQuality(data) });
    return;
  }

  sendJson(res, 200, parseGeneratedImages(data, body));
}

async function generateImagesWithInteractions(body, apiKey, model) {
  const requested = body.settings?.perspectives?.length ? body.settings.perspectives : ["medium"];
  const { response, raw, model: selectedModel, api: selectedApi } = await requestImageWithFallback(body, apiKey, model, "wide");
  if (!response.ok) throw toGeminiUpstreamError(response.status, raw, "Gemini 图片生成失败");

  const masterData = JSON.parse(raw);
  const masterImage = extractInteractionImage(masterData) || extractGeneratedContentImage(masterData);
  const interactionId = selectedApi === "interactions" && typeof masterData?.id === "string" ? masterData.id : "";
  if (!masterImage) throw new Error("Gemini 未返回可用的试摆主图");
  const results = [{ perspective: "wide", title: "远景（房间全景）", imageUrl: `data:${masterImage.mimeType};base64,${masterImage.data}` }];
  await Promise.all(requested.filter((item) => item !== "wide").map(async (perspective) => {
    const variationBody = {
      ...body,
      roomImage: { base64: masterImage.data, mimeType: masterImage.mimeType },
      roomReferenceImages: []
    };
    const variationResponse = interactionId
      ? await requestImageInteraction(variationBody, apiKey, selectedModel, perspective, interactionId)
      : await requestImageGenerateContent(variationBody, apiKey, selectedModel, perspective);
    const variationRaw = await variationResponse.text();
    if (!variationResponse.ok) throw toGeminiUpstreamError(variationResponse.status, variationRaw, "镜头生成失败，请稍后重试");
    const variationData = JSON.parse(variationRaw);
    const variationImage = extractInteractionImage(variationData) || extractGeneratedContentImage(variationData);
    if (!variationImage) throw new Error("Gemini 未返回有效镜头图片");
    results.push({ perspective, title: perspective === "medium" ? "中近景" : "近景（主要展示沙发）", imageUrl: `data:${variationImage.mimeType};base64,${variationImage.data}` });
  }));
  results.sort((left, right) => requested.indexOf(left.perspective) - requested.indexOf(right.perspective));
  return results;
}

async function requestImageWithFallback(body, apiKey, model, perspective) {
  let primary;
  try {
    const response = await requestImageInteraction(body, apiKey, model, perspective);
    primary = { response, raw: await response.text() };
    if (primary.response.ok) {
      return { ...primary, model, api: "interactions" };
    }
    if (shouldTryGenerateContent(primary.response.status, primary.raw)) {
      const fallbackResponse = await requestImageGenerateContent(body, apiKey, model, perspective);
      const fallbackRaw = await fallbackResponse.text();
      if (fallbackResponse.ok) return { response: fallbackResponse, raw: fallbackRaw, model, api: "generateContent" };
    }
    if (!isHighDemand(primary.response.status, primary.raw) || !model.includes("pro-image")) {
      return { ...primary, model, api: "interactions" };
    }
  } catch (error) {
    if (!model.includes("pro-image") || !isRequestTimeout(error)) throw error;
  }

  const fallbackModel = process.env.GEMINI_IMAGE_MODEL_FALLBACK || process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";
  if (fallbackModel === model) {
    if (primary) return { ...primary, model, api: "interactions" };
    throw new ImageGenerationUnavailable();
  }

  try {
    const response = await requestImageInteraction(body, apiKey, fallbackModel, perspective);
    const raw = await response.text();
    if (!response.ok && shouldTryGenerateContent(response.status, raw)) {
      const fallbackResponse = await requestImageGenerateContent(body, apiKey, fallbackModel, perspective);
      const fallbackRaw = await fallbackResponse.text();
      if (fallbackResponse.ok) return { response: fallbackResponse, raw: fallbackRaw, model: fallbackModel, api: "generateContent" };
    }
    if (!response.ok && isHighDemand(response.status, raw)) throw new ImageGenerationUnavailable();
    return { response, raw, model: fallbackModel, api: "interactions" };
  } catch (error) {
    if (error instanceof ImageGenerationUnavailable) throw error;
    if (isRequestTimeout(error)) throw new ImageGenerationUnavailable();
    throw error;
  }
}

function shouldTryGenerateContent(status, raw) {
  return status === 400 && /not available in your current location|available-regions|not supported|unsupported|not found/i.test(raw);
}

function requestImageGenerateContent(body, apiKey, model, perspective) {
  const prompt = body.perspectivePrompts?.[perspective] || body.systemPrompt || "";
  const parts = [{ text: prompt }];
  if (body.roomImage?.base64) {
    parts.push({ inlineData: { mimeType: body.roomImage.mimeType || "image/jpeg", data: body.roomImage.base64 } });
  }
  for (const image of body.roomReferenceImages || []) {
    if (image.base64) parts.push({ inlineData: { mimeType: image.mimeType || "image/jpeg", data: image.base64 } });
  }
  if (body.sofaImage?.base64) {
    parts.push({ inlineData: { mimeType: body.sofaImage.mimeType || "image/jpeg", data: body.sofaImage.base64 } });
  }
  return fetchWithDiagnostics(`generateContent:${model}:${perspective}`, `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: {
        responseModalities: ["Image"],
        responseFormat: {
          image: {
            aspectRatio: body.settings?.ratio || "16:9",
            ...(String(model).includes("3") ? { imageSize: body.settings?.clarity || "1K" } : {})
          }
        }
      }
    })
  });
}

function requestImageInteraction(body, apiKey, model, perspective, previousInteractionId) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 75_000);
  const isAssetEdit = body.mode === "cutout" || body.mode === "erase";
  const prompt = body.perspectivePrompts?.[perspective] || body.systemPrompt || "";
  const input = isAssetEdit
    ? [
        { type: "text", text: prompt },
        ...(body.mode === "erase" && body.roomImage?.base64
          ? [{ type: "image", mime_type: body.roomImage.mimeType || "image/jpeg", data: body.roomImage.base64 }]
          : body.sofaImage?.base64
            ? [{ type: "image", mime_type: body.sofaImage.mimeType || "image/jpeg", data: body.sofaImage.base64 }]
            : [])
      ]
    : previousInteractionId
      ? [
          { type: "text", text: `${prompt}\n\n这是主图受限相机变换，不是新场景生成。只生成指定镜头：${perspective}。请直接输出最终效果图。` },
          ...(body.roomImage?.base64 ? [{ type: "image", mime_type: body.roomImage.mimeType || "image/jpeg", data: body.roomImage.base64 }] : []),
          ...(body.sofaImage?.base64 ? [{ type: "image", mime_type: body.sofaImage.mimeType || "image/jpeg", data: body.sofaImage.base64 }] : [])
        ]
      : [
          { type: "text", text: `${prompt}\n\n请先生成锁定布局的远景主图。` },
          ...(body.roomImage?.base64 ? [{ type: "image", mime_type: body.roomImage.mimeType || "image/jpeg", data: body.roomImage.base64 }] : []),
          ...((body.roomReferenceImages || []).filter((image) => image.base64).map((image) => ({ type: "image", mime_type: image.mimeType || "image/jpeg", data: image.base64 }))),
          ...(body.sofaImage?.base64 ? [{ type: "image", mime_type: body.sofaImage.mimeType || "image/jpeg", data: body.sofaImage.base64 }] : [])
        ];
  return fetchWithDiagnostics(`interactions:${model}:${perspective}:${previousInteractionId ? "variation" : "master"}`, "https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    signal: controller.signal,
    body: JSON.stringify({
      model,
      input,
      ...(previousInteractionId ? { previous_interaction_id: previousInteractionId } : {}),
      response_format: {
        type: "image",
        mime_type: "image/jpeg",
        aspect_ratio: body.settings?.ratio || "16:9",
        image_size: body.settings?.clarity || "1K"
      }
    })
  }).finally(() => clearTimeout(timeout));
}

async function fetchWithDiagnostics(label, url, init) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await fetch(url, init);
    } catch (error) {
      lastError = error;
      console.error("[local-trial-server] upstream fetch failed", {
        label,
        attempt,
        willRetry: attempt < 3 && isRetryableFetchError(error),
        ...describeError(error)
      });
      if (attempt >= 3 || !isRetryableFetchError(error)) throw error;
      await sleep(700 * attempt);
    }
  }
  throw lastError;
}

function isRetryableFetchError(error) {
  if (!(error instanceof Error)) return false;
  const cause = error.cause || {};
  return /fetch failed|network|socket|terminated|timeout|aborted/i.test(error.message)
    || /ECONNRESET|ETIMEDOUT|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|EAI_AGAIN|ENETUNREACH|ECONNREFUSED/i.test(String(cause.code || cause.name || cause.message || ""));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isHighDemand(status, raw) {
  return status === 429 || status === 503 || /high demand|try again later|resource exhausted/i.test(raw);
}

function isRequestTimeout(error) {
  return error instanceof Error && (error.name === "AbortError" || /aborted|timeout/i.test(error.message));
}

function toGeminiUpstreamError(statusCode, raw, fallbackMessage) {
  const upstreamMessage = parseGeminiError(raw) || fallbackMessage;
  if (/denied access|permission|api key|unauthenticated|forbidden/i.test(upstreamMessage) || statusCode === 401 || statusCode === 403) {
    return new GeminiUpstreamError(statusCode, "Gemini API Key 或当前项目权限不可用，请检查 API Key 所属项目及 Gemini API 访问权限。");
  }
  if (statusCode === 404 || /not found|not supported|model.*not/i.test(upstreamMessage)) {
    return new GeminiUpstreamError(statusCode, "当前 Gemini 图片模型不可用或不支持此接口，请检查模型配置。");
  }
  return new GeminiUpstreamError(statusCode, upstreamMessage);
}


function serveStatic(pathname, res) {
  const cleanPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = normalize(join(distDir, cleanPath));
  const safeDist = normalize(distDir);
  const target = filePath.startsWith(safeDist) && existsSync(filePath) ? filePath : join(distDir, "index.html");

  const content = readFileSync(target);
  res.writeHead(200, { "Content-Type": mimeType(target) });
  res.end(content);
}

function createMockResponse(body) {
  if (body.mode === "analyze") {
    return {
      success: true,
      analysis: {
        roomSummary: "别墅客厅空间开阔，地面与墙面关系清晰，适合进行沙发试摆。",
        sofaSummary: "沙发主体清晰，应保留颜色、面料质感、扶手和坐垫结构。",
        lighting: "自然光从侧向进入，需要补充地面接触阴影和环境反射。",
        perspective: "房间具备明显纵深，沙发应随地面透视线调整尺度和角度。",
        placementAdvice: "建议优先靠墙或靠窗一侧试摆，避免遮挡主要通行动线。",
        constraints: ["不要改变房间主体结构", "不要添加人物和文字", "保持原沙发材质与比例"],
        placementPlan: {
          summary: "将目标沙发自然试摆到客厅核心会客区，优先保证通行与视觉平衡。",
          placement: "由 AI 结合空间焦点和动线选择最合适的位置。",
          facing: "朝向房间的主要视觉焦点。",
          scale: "按地面透视和周边家具尺度匹配。",
          preserve: ["保留未被明确要求移除的结构、家具和装饰"],
          remove: ["无明确移除对象"],
          avoid: ["不要遮挡通道、门窗和主要采光"],
          rationale: ["优先保证会客区使用舒适与空间动线完整"],
          candidates: [
            { id: "candidate-main", label: "主会客区方案", placement: "放在主会客区，避开进出通道", facing: "面向主要视觉焦点", scale: "与地面透视协调", score: 0.9, reasons: ["通道完整", "视觉平衡"], blocksWalkway: false, conflictsWithPreservedItems: false, violatesUserRequirements: false },
            { id: "candidate-side", label: "侧墙方案", placement: "靠近侧墙摆放", facing: "朝向空间中心", scale: "略小于主会客区方案", score: 0.65, reasons: ["可保留中央活动区"], blocksWalkway: false, conflictsWithPreservedItems: false, violatesUserRequirements: false },
            { id: "candidate-blocked", label: "通道阻塞方案", placement: "靠近出入口摆放", facing: "朝向电视墙", scale: "偏大", score: 0.8, reasons: ["会影响通行"], blocksWalkway: true, conflictsWithPreservedItems: false, violatesUserRequirements: false }
          ],
          selectedCandidateId: "candidate-main"
        }
      }
    };
  }

  if (body.mode === "quality") {
    return { success: true, quality: { passed: true, issues: [], correctionPrompt: "" } };
  }

  const perspectives = body.settings?.perspectives?.length ? body.settings.perspectives : ["medium"];
  return {
    success: true,
    images: perspectives.map((perspective, index) => ({
      perspective,
      title: `试摆效果 ${index + 1}`,
      imageUrl: createMockSvgDataUrl(perspective, body.settings?.ratio || "16:9")
    }))
  };
}

function parseAnalysis(data) {
  const text = extractText(data);
  try {
    const parsed = JSON.parse(stripCodeFence(text));
    return {
      roomSummary: toReadableText(parsed.roomSummary, "已识别房间空间与地面关系。"),
      sofaSummary: toReadableText(parsed.sofaSummary, "已识别沙发主体、材质和外观。"),
      lighting: toReadableText(parsed.lighting, "已判断主要光线方向。"),
      perspective: toReadableText(parsed.perspective, "已判断房间透视。"),
      placementAdvice: toReadableText(parsed.placementAdvice, "建议按空间动线自然摆放。"),
      constraints: toReadableList(parsed.constraints, ["保持房间主体结构不变"]),
      placementPlan: parsePlacementPlan(parsed.placementPlan, parsed.placementAdvice)
    };
  } catch {
    return {
      roomSummary: text || "已识别房间空间与地面关系。",
      sofaSummary: "已识别沙发主体、材质和外观。",
      lighting: "已判断主要光线方向。",
      perspective: "已判断房间透视。",
      placementAdvice: "建议按空间动线自然摆放。",
      constraints: ["保持房间主体结构不变"],
      placementPlan: parsePlacementPlan(null, "根据空间动线自然摆放目标沙发。")
    };
  }
}

function parsePlacementPlan(value, fallbackAdvice) {
  const plan = value && typeof value === "object" ? value : {};
  const fallback = toReadableText(fallbackAdvice, "根据空间动线自然摆放目标沙发。");
  return {
    summary: toReadableText(plan.summary, fallback),
    placement: toReadableText(plan.placement, "由 AI 根据房间空间、动线和视觉焦点选择合适位置"),
    facing: toReadableText(plan.facing, "根据主要视觉焦点和用户要求确定朝向"),
    scale: toReadableText(plan.scale, "保持与房间尺度和透视关系协调"),
    preserve: toReadableList(plan.preserve, ["保留未被用户明确要求移除的原有结构、家具与装饰"]),
    remove: toReadableList(plan.remove, ["无明确移除对象"]),
    avoid: toReadableList(plan.avoid, ["不要遮挡通道、门窗、主要采光和核心功能区"]),
    rationale: toReadableList(plan.rationale, [fallback]),
    candidates: parseCandidates(plan.candidates),
    selectedCandidateId: toReadableText(plan.selectedCandidateId, "")
  };
}

function parseCandidates(value) {
  const candidates = Array.isArray(value) ? value : [];
  return candidates.map((candidate, index) => {
    const item = candidate && typeof candidate === "object" ? candidate : {};
    const score = Number(item.score);
    return {
      id: toReadableText(item.id, `candidate-${index + 1}`),
      label: toReadableText(item.label, `候选方案 ${index + 1}`),
      placement: toReadableText(item.placement, "由 AI 根据空间动线选择合适位置"),
      facing: toReadableText(item.facing, "面向主要视觉焦点"),
      scale: toReadableText(item.scale, "按房间透视协调缩放"),
      score: Number.isFinite(score) ? score : 0.5,
      reasons: toReadableList(item.reasons, ["符合空间视觉关系"]),
      blocksWalkway: item.blocksWalkway === true,
      conflictsWithPreservedItems: item.conflictsWithPreservedItems === true,
      violatesUserRequirements: item.violatesUserRequirements === true
    };
  });
}

function parseQuality(data) {
  const text = extractText(data);
  try {
    const parsed = JSON.parse(stripCodeFence(text));
    return {
      passed: parsed.passed === true,
      issues: toReadableList(parsed.issues, []),
      correctionPrompt: toReadableText(parsed.correctionPrompt, "")
    };
  } catch {
    return { passed: false, issues: ["无法完成自动质检，请人工确认试摆效果。"], correctionPrompt: "" };
  }
}

function toReadableText(value, fallback) {
  if (typeof value === "string") return value.trim() || fallback;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const text = value.map((item) => toReadableText(item, "")).filter(Boolean).join("；");
    return text || fallback;
  }
  if (value && typeof value === "object") {
    const text = Object.values(value).map((item) => toReadableText(item, "")).filter(Boolean).join("；");
    return text || fallback;
  }
  return fallback;
}

function toReadableList(value, fallback) {
  const items = Array.isArray(value) ? value : value == null ? [] : [value];
  const normalized = items.map((item) => toReadableText(item, "")).filter(Boolean);
  return normalized.length ? normalized : fallback;
}

function parseGeneratedImages(data, body) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const images = parts
    .map((part) => part.inlineData)
    .filter((part) => part?.data)
    .map((part, index) => ({
      perspective: body.settings?.perspectives?.[index] || "medium",
      title: `试摆效果 ${index + 1}`,
      imageUrl: `data:${part.mimeType || "image/png"};base64,${part.data}`
    }));

  return images.length ? { success: true, images } : createMockResponse(body);
}

function extractInteractionImage(data) {
  if (data?.output_image?.data) {
    return {
      mimeType: data.output_image.mime_type || "image/png",
      data: data.output_image.data
    };
  }

  for (const step of data?.steps || []) {
    if (step?.output_image?.data) {
      return {
        mimeType: step.output_image.mime_type || "image/png",
        data: step.output_image.data
      };
    }

    for (const item of step?.content || []) {
      if (item?.data && String(item?.mime_type || "").startsWith("image/")) {
        return {
          mimeType: item.mime_type || "image/png",
          data: item.data
        };
      }
    }
  }

  return null;
}

function extractGeneratedContentImage(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    const image = part?.inlineData || part?.inline_data;
    if (image?.data) {
      return {
        mimeType: image.mimeType || image.mime_type || "image/png",
        data: image.data
      };
    }
  }
  return null;
}

function extractText(data) {
  return (data?.candidates?.[0]?.content?.parts || [])
    .map((part) => part.text)
    .filter(Boolean)
    .join("\n")
    .trim();
}

function mapModel(model, mode) {
  if (mode === "analyze" || mode === "quality") {
    return process.env.GEMINI_ANALYZE_MODEL || "gemini-2.5-flash";
  }

  if (model === "gemini-3") {
    return process.env.GEMINI_IMAGE_MODEL_3 || process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image";
  }

  return process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function loadEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

function parseGeminiError(raw) {
  try {
    const message = JSON.parse(raw).error?.message || "";
    if (/not available in your current location|available-regions/i.test(message)) {
      return "Gemini API 当前调用地区不可用。请将后端服务部署在 Gemini API 支持的国家或地区，或改用 Google Cloud 的企业平台 Gemini API。";
    }
    return message;
  } catch {
    if (/not available in your current location|available-regions/i.test(raw)) {
      return "Gemini API 当前调用地区不可用。请将后端服务部署在 Gemini API 支持的国家或地区，或改用 Google Cloud 的企业平台 Gemini API。";
    }
    return raw.slice(0, 200);
  }
}

function stripCodeFence(text) {
  return text.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
}

function mimeType(path) {
  const ext = extname(path);
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg"
  }[ext] || "application/octet-stream";
}

function createMockSvgDataUrl(perspective, ratio) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="900" viewBox="0 0 1400 900">
  <rect width="1400" height="900" fill="#edf2f7"/>
  <path d="M0 610 L1400 470 L1400 900 L0 900 Z" fill="#d6c6ad"/>
  <path d="M0 0 H1400 V470 L0 610 Z" fill="#f8fafc"/>
  <rect x="170" y="190" width="390" height="250" rx="8" fill="#dbeafe"/>
  <rect x="775" y="190" width="430" height="250" rx="8" fill="#e2e8f0"/>
  <ellipse cx="700" cy="690" rx="390" ry="70" fill="#b8a58d" opacity=".36"/>
  <rect x="405" y="520" width="590" height="155" rx="30" fill="#52616f"/>
  <rect x="450" y="465" width="500" height="130" rx="28" fill="#64748b"/>
  <text x="700" y="805" text-anchor="middle" font-family="Arial, sans-serif" font-size="34" fill="#334155">AI 别墅沙发试摆 · ${escapeXml(perspective)} · ${escapeXml(ratio)}</text>
</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function escapeXml(value) {
  return String(value).replace(/[<>&'"]/g, (char) => {
    const map = { "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" };
    return map[char] || char;
  });
}
