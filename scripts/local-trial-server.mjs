import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI, Type } from "@google/genai";

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

  const client = new GoogleGenAI({ apiKey, httpOptions: { headers: { "User-Agent": "aistudio-build" } } });
  const model = mapModel(body.model, body.mode);

  if (body.mode === "generate") {
    const requested = body.settings?.perspectives?.length ? body.settings.perspectives : ["medium"];
    const results = await Promise.all(requested.map(async (perspective) => {
      const perspectiveBody = { ...body, settings: { ...body.settings, perspectives: [perspective] } };
      const image = await generateImageWithSDK(client, perspectiveBody, model, perspective);
      if (!image) throw new Error(`Gemini 未返回可用的${perspective}视角图片`);
      const title = perspective === "wide" ? "远景（房间全景）" : perspective === "medium" ? "中近景（沙发主体）" : "近景（产品细节）";
      return { perspective, title, imageUrl: `data:${image.mimeType};base64,${image.data}` };
    }));
    sendJson(res, 200, results.length ? { success: true, images: results } : createMockResponse(body));
    return;
  }

  // For analyze/quality/cutout/erase — build interleaved parts
  const parts = buildInterleavedParts(body);

  if (body.mode === "analyze") {
    const result = await callGenerateContentSDK(client, model, parts, {
      temperature: 0.2,
      responseMimeType: "application/json",
      responseSchema: ANALYZE_SCHEMA
    });
    sendJson(res, 200, { success: true, analysis: parseAnalysis(result) });
    return;
  }

  if (body.mode === "quality") {
    const result = await callGenerateContentSDK(client, model, parts, { temperature: 0.2, responseMimeType: "application/json" });
    sendJson(res, 200, { success: true, quality: parseQuality(result) });
    return;
  }

  if (body.mode === "cutout" || body.mode === "erase") {
    const image = await generateImageWithSDK(client, body, model, "wide");
    if (!image) throw new Error(body.mode === "erase" ? "Gemini 未返回可用的干净场景图" : "Gemini 未返回可用的沙发前景图");
    sendJson(res, 200, { success: true, images: [{ perspective: "wide", title: body.mode === "erase" ? "干净场景" : "沙发前景", imageUrl: `data:${image.mimeType};base64,${image.data}` }] });
    return;
  }

  sendJson(res, 200, { success: false, message: "未知操作模式" });
}

  sendJson(res, 200, parseGeneratedImages(data, body));
}

async function generateImagesWithInteractions(body, apiKey, model) {
  const requested = body.settings?.perspectives?.length ? body.settings.perspectives : ["medium"];
  const results = await Promise.all(requested.map(async (perspective) => {
    const { response, raw, model: selectedModel } = await requestImageWithFallback(body, apiKey, model, perspective);
    if (!response.ok) throw toGeminiUpstreamError(response.status, raw, "Gemini 图片生成失败");
    const data = JSON.parse(raw);
    const image = extractInteractionImage(data) || extractGeneratedContentImage(data);
    if (!image) throw new Error("Gemini 未返回可用的试摆图片");
    const title = perspective === "wide" ? "远景（房间全景）" : perspective === "medium" ? "中近景（沙发主体）" : "近景（产品细节）";
    return { perspective, title, imageUrl: `data:${image.mimeType};base64,${image.data}` };
  }));
  return results;
}

async function requestImageWithFallback(body, apiKey, model, perspective) {
  // Following the floor lamp project: generateContent is PRIMARY path.
  let primary;
  try {
    const response = await requestImageGenerateContent(body, apiKey, model, perspective);
    primary = { response, raw: await response.text() };
    if (primary.response.ok) {
      return { ...primary, model, api: "generateContent" };
    }
    if (shouldTryInteractions(primary.response.status, primary.raw)) {
      const fallbackResponse = await requestImageInteraction(body, apiKey, model, perspective);
      const fallbackRaw = await fallbackResponse.text();
      if (fallbackResponse.ok) return { response: fallbackResponse, raw: fallbackRaw, model, api: "interactions" };
    }
    if (!isHighDemand(primary.response.status, primary.raw) || !model.includes("pro-image")) {
      return { ...primary, model, api: "generateContent" };
    }
  } catch (error) {
    if (!model.includes("pro-image") || !isRequestTimeout(error)) throw error;
  }

  const fallbackModel = process.env.GEMINI_IMAGE_MODEL_FALLBACK || process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";
  if (fallbackModel === model) {
    if (primary) return { ...primary, model, api: "generateContent" };
    throw new ImageGenerationUnavailable();
  }

  try {
    const response = await requestImageGenerateContent(body, apiKey, fallbackModel, perspective);
    const raw = await response.text();
    if (!response.ok && shouldTryInteractions(response.status, raw)) {
      const fallbackResponse = await requestImageInteraction(body, apiKey, fallbackModel, perspective);
      const fallbackRaw = await fallbackResponse.text();
      if (fallbackResponse.ok) return { response: fallbackResponse, raw: fallbackRaw, model: fallbackModel, api: "interactions" };
    }
    if (!response.ok && isHighDemand(response.status, raw)) throw new ImageGenerationUnavailable();
    return { response, raw, model: fallbackModel, api: "generateContent" };
  } catch (error) {
    if (error instanceof ImageGenerationUnavailable) throw error;
    if (isRequestTimeout(error)) throw new ImageGenerationUnavailable();
    throw error;
  }
}

function shouldTryInteractions(status, raw) {
  return status === 400 && /not available in your current location|available-regions|not supported|unsupported|not found/i.test(raw);
}

function requestImageGenerateContent(body, apiKey, model, perspective) {
  const prompt = body.systemPrompt || "";
  const parts = [];
  let refLabelAdded = false;

  // Following the floor lamp project: images + labels FIRST, prompt LAST.
  if (body.roomImage?.base64) {
    parts.push({ text: "IMAGE 1 [REFERENCE ROOM ENVIRONMENT]:" });
    parts.push({ inlineData: { mimeType: body.roomImage.mimeType || "image/jpeg", data: body.roomImage.base64 } });
  }
  for (const image of body.roomReferenceImages || []) {
    if (image.base64) {
      if (!refLabelAdded) {
        parts.push({ text: `IMAGE 1 SUPPLEMENTARY — ${body.roomReferenceImages.length} additional room angle(s):` });
        refLabelAdded = true;
      }
      parts.push({ inlineData: { mimeType: image.mimeType || "image/jpeg", data: image.base64 } });
    }
  }
  if (body.sofaImage?.base64) {
    parts.push({ text: "IMAGE 2 [EXACT REFERENCE SOFA PRODUCT — 必须100%按此图还原沙发]:" });
    parts.push({ inlineData: { mimeType: body.sofaImage.mimeType || "image/jpeg", data: body.sofaImage.base64 } });
  }
  if (body.productReferenceImage?.base64 && body.productReferenceImage.base64 !== body.sofaImage?.base64) {
    parts.push({ text: "IMAGE 3 [PRODUCT IDENTITY REFERENCE]:" });
    parts.push({ inlineData: { mimeType: body.productReferenceImage.mimeType || "image/jpeg", data: body.productReferenceImage.base64 } });
  }

  // Prompt comes at the END
  parts.push({ text: prompt });
  return fetchWithDiagnostics(`generateContent:${model}:${perspective}`, `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: {
        responseModalities: ["Image"],
        imageConfig: {
          aspectRatio: body.settings?.ratio || "16:9"
        }
      }
    })
  });
}

function requestImageInteraction(body, apiKey, model, perspective) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 75_000);
  const isAssetEdit = body.mode === "cutout" || body.mode === "erase";
  const prompt = body.systemPrompt || "";
  const input = isAssetEdit
    ? [
        { type: "text", text: prompt },
          ...(body.mode === "erase" && body.roomImage?.base64
            ? [{ type: "image", mime_type: body.roomImage.mimeType || "image/jpeg", data: body.roomImage.base64 }]
            : body.sofaImage?.base64
              ? [{ type: "image", mime_type: body.sofaImage.mimeType || "image/jpeg", data: body.sofaImage.base64 }]
              : [])
      ]
    : buildInterleavedInput(prompt, body);
  return fetchWithDiagnostics(`interactions:${model}:${perspective}:independent`, "https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    signal: controller.signal,
    body: JSON.stringify({
      model,
      input,
      response_format: {
        type: "image",
        mime_type: "image/jpeg",
        aspect_ratio: body.settings?.ratio || "16:9"
      }
    })
  }).finally(() => clearTimeout(timeout));
}

function buildInterleavedInput(prompt, body) {
  const parts = [];
  let refLabelAdded = false;

  if (body.roomImage?.base64) {
    parts.push({ type: "text", text: "IMAGE 1 [REFERENCE ROOM ENVIRONMENT]:" });
    parts.push({ type: "image", mime_type: body.roomImage.mimeType || "image/jpeg", data: body.roomImage.base64 });
  }
  for (const image of body.roomReferenceImages || []) {
    if (image.base64) {
      if (!refLabelAdded) {
        parts.push({ type: "text", text: `IMAGE 1 SUPPLEMENTARY — ${body.roomReferenceImages.length} additional room angle(s):` });
        refLabelAdded = true;
      }
      parts.push({ type: "image", mime_type: image.mimeType || "image/jpeg", data: image.base64 });
    }
  }
  if (body.sofaImage?.base64) {
    parts.push({ type: "text", text: "IMAGE 2 [EXACT REFERENCE SOFA PRODUCT — 必须100%按此图还原沙发]:" });
    parts.push({ type: "image", mime_type: body.sofaImage.mimeType || "image/jpeg", data: body.sofaImage.base64 });
  }
  if (body.productReferenceImage?.base64 && body.productReferenceImage.base64 !== body.sofaImage?.base64) {
    parts.push({ type: "text", text: "IMAGE 3 [PRODUCT IDENTITY REFERENCE]:" });
    parts.push({ type: "image", mime_type: body.productReferenceImage.mimeType || "image/jpeg", data: body.productReferenceImage.base64 });
  }

  parts.push({ type: "text", text: prompt });

  return parts;
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

function normalizeSofaIdentity(value, fallback) {
  const source = value && typeof value === "object" ? value : {};
  const summary = toReadableText(fallback, "目标沙发参考图中的产品主体");
  return {
    structure: toReadableText(source.structure, summary),
    seatCount: toReadableText(source.seatCount, "以参考图为准"),
    silhouette: toReadableText(source.silhouette, summary),
    armrest: toReadableText(source.armrest, "以参考图为准"),
    backrest: toReadableText(source.backrest, "以参考图为准"),
    cushions: toReadableText(source.cushions, "以参考图为准"),
    material: toReadableText(source.material, "以参考图为准"),
    color: toReadableText(source.color, "以参考图为准"),
    details: toReadableList(source.details, ["以参考图可见细节为准"])
  };
}

function parseAnalysis(data) {
  const text = extractText(data);
  try {
    const parsed = JSON.parse(stripCodeFence(text));
    return {
      roomSummary: toReadableText(parsed.roomSummary, "已识别房间空间与地面关系。"),
      sofaSummary: toReadableText(parsed.sofaSummary, "已识别沙发主体、材质和外观。"),
      sofaIdentity: normalizeSofaIdentity(parsed.sofaIdentity, parsed.sofaSummary),
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
      sofaIdentity: normalizeSofaIdentity(null, null),
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

/** Response schema for analyze mode — forces Gemini to return detailed, structured output. */
const ANALYZE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    roomSummary: { type: Type.STRING, description: "房间空间与地面关系的详细中文描述" },
    sofaSummary: { type: Type.STRING, description: "沙发外观的详细中文描述" },
    sofaIdentity: {
      type: Type.OBJECT,
      properties: {
        structure: { type: Type.STRING, description: "整体结构完整描述（正面+负面排除）：从上到下、从外到内逐一描述所有可见物理部件，并明确声明参考图中不存在的设计元素。格式如：'包含：低矮紧凑型直排轮廓、方形低矮扶手、中等高度平直靠背、三坐垫分区缝线、深灰色纳帕牛皮面、黑色圆柱形沙发脚。严禁增加：拉扣/铆钉、金属腿、额外抱枕、L型转角、任何参考图中不存在的设计元素。'" },
        seatCount: { type: Type.STRING, description: "座位数量，如'三人位'、'两人位'，必须是具体数字" },
        silhouette: { type: Type.STRING, description: "沙发整体轮廓的详细中文描述，包括线条、体量、高低形态" },
        armrest: { type: Type.STRING, description: "扶手形状、高度、材质的详细中文描述" },
        backrest: { type: Type.STRING, description: "靠背高度、形态、材质的详细中文描述" },
        cushions: { type: Type.STRING, description: "坐垫数量、分区方式、缝线图案的详细中文描述" },
        material: { type: Type.STRING, description: "主材质的中文名称，如'棉麻混纺'、'纳帕牛皮'、'科技布'" },
        color: { type: Type.STRING, description: "主色调的中文精确描述，如'深灰色'、'米白色'、'暖棕色'" },
        details: { type: Type.ARRAY, items: { type: Type.STRING }, description: "所有可见细节的中文列表，如拉扣、刺绣、沙发脚、缝线、抱枕等" }
      },
      required: ["seatCount", "silhouette", "armrest", "backrest", "cushions", "material", "color", "details"]
    },
    lighting: { type: Type.STRING },
    perspective: { type: Type.STRING },
    placementAdvice: { type: Type.STRING },
    constraints: { type: Type.ARRAY, items: { type: Type.STRING } },
    placementPlan: {
      type: Type.OBJECT,
      properties: {
        summary: { type: Type.STRING }, placement: { type: Type.STRING }, facing: { type: Type.STRING },
        scale: { type: Type.STRING }, preserve: { type: Type.ARRAY, items: { type: Type.STRING } },
        remove: { type: Type.ARRAY, items: { type: Type.STRING } }, avoid: { type: Type.ARRAY, items: { type: Type.STRING } },
        rationale: { type: Type.ARRAY, items: { type: Type.STRING } },
        candidates: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: {
          id: { type: Type.STRING }, label: { type: Type.STRING }, placement: { type: Type.STRING },
          facing: { type: Type.STRING }, scale: { type: Type.STRING }, score: { type: Type.NUMBER },
          reasons: { type: Type.ARRAY, items: { type: Type.STRING } },
          blocksWalkway: { type: Type.BOOLEAN }, conflictsWithPreservedItems: { type: Type.BOOLEAN },
          violatesUserRequirements: { type: Type.BOOLEAN }
        } } },
        selectedCandidateId: { type: Type.STRING }
      },
      required: ["summary", "placement", "facing", "scale", "preserve", "remove", "avoid", "rationale", "candidates", "selectedCandidateId"]
    }
  },
  required: ["roomSummary", "sofaSummary", "sofaIdentity", "lighting", "perspective", "placementAdvice", "constraints", "placementPlan"]
};

/** Build interleaved parts — images+labels first, prompt last. */
function buildInterleavedParts(body) {
  const parts = [];

  if (body.roomImage?.base64) {
    parts.push({ text: "IMAGE 1 [REFERENCE ROOM ENVIRONMENT]:" });
    parts.push({ inlineData: { mimeType: body.roomImage.mimeType || "image/jpeg", data: body.roomImage.base64 } });
  }

  const refs = body.roomReferenceImages || [];
  if (refs.length > 0) {
    parts.push({ text: `IMAGE 1 SUPPLEMENTARY — ${refs.length} additional room angle(s) from the same space:` });
    for (const image of refs) {
      if (image.base64) parts.push({ inlineData: { mimeType: image.mimeType || "image/jpeg", data: image.base64 } });
    }
  }

  if (body.sofaImage?.base64) {
    parts.push({ text: "IMAGE 2 [EXACT REFERENCE SOFA PRODUCT — THIS IS THE PRODUCT TO IDENTIFY AND REPLICATE]:" });
    parts.push({ inlineData: { mimeType: body.sofaImage.mimeType || "image/jpeg", data: body.sofaImage.base64 } });
  }

  if (body.productReferenceImage?.base64) {
    parts.push({ text: "IMAGE 3 [PRODUCT IDENTITY REFERENCE]:" });
    parts.push({ inlineData: { mimeType: body.productReferenceImage.mimeType || "image/jpeg", data: body.productReferenceImage.base64 } });
  }

  if (body.resultImage?.base64) {
    parts.push({ text: "IMAGE 4 [GENERATED RESULT TO EVALUATE]:" });
    parts.push({ inlineData: { mimeType: body.resultImage.mimeType || "image/jpeg", data: body.resultImage.base64 } });
  }

  parts.push({ text: body.systemPrompt || "" });
  return parts;
}

/** Build interleaved parts for image generation — images+labels first, prompt last. */
function buildGenerationParts(body) {
  const parts = [];

  if (body.roomImage?.base64) {
    parts.push({ text: "IMAGE 1 [REFERENCE ROOM ENVIRONMENT]:" });
    parts.push({ inlineData: { mimeType: body.roomImage.mimeType || "image/jpeg", data: body.roomImage.base64 } });
  }

  const refs = body.roomReferenceImages || [];
  if (refs.length > 0) {
    parts.push({ text: `IMAGE 1 SUPPLEMENTARY — ${refs.length} additional room angle(s):` });
    for (const image of refs) {
      if (image.base64) parts.push({ inlineData: { mimeType: image.mimeType || "image/jpeg", data: image.base64 } });
    }
  }

  if (body.sofaImage?.base64) {
    parts.push({ text: "IMAGE 2 [EXACT REFERENCE SOFA PRODUCT — 必须100%按此图还原沙发]:" });
    parts.push({ inlineData: { mimeType: body.sofaImage.mimeType || "image/jpeg", data: body.sofaImage.base64 } });
  }

  // Log the full prompt for debugging
  if (body.systemPrompt) {
    console.log("[local-trial] GENERATION PROMPT (model=" + model + "):");
    console.log(body.systemPrompt);
    console.log("[local-trial] END PROMPT");
  }

  parts.push({ text: body.systemPrompt || "" });
  return parts;
}

/** Call generateContent via @google/genai SDK for text/JSON responses. */
async function callGenerateContentSDK(client, model, parts, config) {
  const sdkConfig = {
    temperature: config.temperature ?? 0.2,
    responseMimeType: config.responseMimeType ?? "text/plain"
  };
  if (config.responseSchema) sdkConfig.responseSchema = config.responseSchema;

  const response = await client.models.generateContent({
    model,
    contents: { parts },
    config: sdkConfig
  });

  if (!response.candidates?.[0]?.content?.parts) {
    throw new Error("Gemini 返回了空响应");
  }
  return response;
}

/** Generate images using @google/genai SDK. */
async function generateImageWithSDK(client, body, model, perspective) {
  // PRIMARY: generateContent via SDK
  try {
    const parts = buildGenerationParts(body);
    const response = await client.models.generateContent({
      model,
      contents: { parts },
      config: {
        imageConfig: {
          aspectRatio: body.settings?.ratio || "16:9"
        }
      }
    });
    const image = extractSDKImage(response);
    if (image) return image;
  } catch (error) {
    console.warn("[local-trial] generateContent SDK failed", { model, perspective, error: error.message });
  }

  // FALLBACK: try different model via SDK
  const fallbackModel = process.env.GEMINI_IMAGE_MODEL_FALLBACK || "gemini-2.5-flash-image";
  if (fallbackModel !== model) {
    try {
      const parts = buildGenerationParts(body);
      const response = await client.models.generateContent({
        model: fallbackModel,
        contents: { parts },
        config: {
          imageConfig: {
            aspectRatio: body.settings?.ratio || "16:9"
          }
        }
      });
      const image = extractSDKImage(response);
      if (image) return image;
    } catch (error) {
      console.warn("[local-trial] fallback model failed", { fallbackModel, perspective, error: error.message });
    }
  }

  throw new ImageGenerationUnavailable();
}

/** Extract image from SDK generateContent response. */
function extractSDKImage(response) {
  const parts = response.candidates?.[0]?.content?.parts;
  if (!parts) return null;
  for (const part of parts) {
    if (part.inlineData?.data) {
      return { mimeType: part.inlineData.mimeType || "image/png", data: part.inlineData.data };
    }
  }
  return null;
}

function mapModel(model, mode) {
  if (mode === "analyze" || mode === "quality") {
    return process.env.GEMINI_ANALYZE_MODEL || "gemini-2.5-flash";
  }

  // Use the full model (not lite) for complex product fidelity — sofa is harder than a lamp
  if (model === "gemini-3") {
    return process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image";
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
