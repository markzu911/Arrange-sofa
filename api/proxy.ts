import type { IncomingMessage, ServerResponse } from "node:http";
import { GoogleGenAI, type Part } from "@google/genai";

const SAAS_ORIGIN = process.env.SAAS_API_ORIGIN || "http://aibigtree.com";
const BODY_LIMIT = 20 * 1024 * 1024;

class ImageGenerationUnavailable extends Error {
  constructor() {
    super("图片生成服务当前繁忙，请稍后重试。已尝试高精度与备用模型，但均未在限定时间内响应。");
  }
}

class GeminiUpstreamError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

interface JsonRequest extends IncomingMessage {
  body?: unknown;
}

interface GeminiRequestBody {
  mode?: "analyze" | "cutout" | "erase" | "generate" | "quality";
  model?: string;
  roomImage?: { base64: string; mimeType: string };
  roomReferenceImages?: Array<{ base64: string; mimeType: string }>;
  sofaImage?: { base64: string; mimeType: string };
  productReferenceImage?: { base64: string; mimeType: string };
  resultImage?: { base64: string; mimeType: string };
  systemPrompt?: string;
  settings?: {
    perspectives?: string[];
    ratio?: string;
    clarity?: string;
  };
}

export default async function handler(req: JsonRequest, res: ServerResponse) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 200;
    res.end();
    return;
  }

  const path = getRequestPath(req);

  try {
    if (path === "/api/gemini" && req.method === "POST") {
      await handleGemini(req, res);
      return;
    }

    if (path.startsWith("/api/tool/") || path.startsWith("/api/upload/")) {
      await proxyToSaas(req, res, path);
      return;
    }

    sendJson(res, 404, { success: false, message: "API 路由不存在" });
  } catch (error) {
    const statusCode = error instanceof GeminiUpstreamError
      ? error.statusCode
      : error instanceof ImageGenerationUnavailable
        ? 503
        : 500;
    console.error("[api/proxy] request failed", {
      url: req.url,
      method: req.method,
      statusCode,
      ...describeError(error)
    });
    sendJson(res, statusCode, {
      success: false,
      message: error instanceof Error ? error.message : "服务端处理失败"
    });
  }
}

function describeError(error: unknown) {
  if (!(error instanceof Error)) return { message: String(error) };
  const cause = (error as Error & { cause?: Record<string, unknown> }).cause;
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

async function handleGemini(req: JsonRequest, res: ServerResponse) {
  const body = (await readJsonBody<GeminiRequestBody>(req)) || {};
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    sendJson(res, 500, {
      success: false,
      message: "未配置 GEMINI_API_KEY，当前没有调用真实 Gemini API。请在 Vercel 环境变量中配置后重新部署。"
    });
    return;
  }

  const client = new GoogleGenAI({ apiKey });
  const model = mapModel(body.model, body.mode);

  if (body.mode === "generate") {
    const images = await generateImagesWithSDK(client, body, model);
    sendJson(res, 200, images.length ? { success: true, images } : createMockGeminiResponse(body));
    return;
  }

  // For analyze/quality/cutout/erase modes — build interleaved parts and call generateContent via SDK
  const parts = buildInterleavedParts(body);

  if (body.mode === "analyze") {
    const result = await callGenerateContent(client, model, parts, { temperature: 0.2, responseMimeType: "application/json" });
    sendJson(res, 200, { success: true, analysis: parseAnalysis(result) });
    return;
  }

  if (body.mode === "quality") {
    const result = await callGenerateContent(client, model, parts, { temperature: 0.2, responseMimeType: "application/json" });
    sendJson(res, 200, { success: true, quality: parseQuality(result) });
    return;
  }

  if (body.mode === "cutout" || body.mode === "erase") {
    const result = await generateImageWithFallback(client, body, model, "wide");
    if (!result) throw new Error(body.mode === "erase" ? "Gemini 未返回可用的干净场景图" : "Gemini 未返回可用的沙发前景图");
    sendJson(res, 200, {
      success: true,
      images: [{ perspective: "wide", title: body.mode === "erase" ? "干净场景" : "沙发前景", imageUrl: `data:${result.mimeType};base64,${result.data}` }]
    });
    return;
  }

  sendJson(res, 200, { success: false, message: "未知操作模式" });
}

/** Build interleaved parts for analyze/quality/cutout/erase — all images get explicit role labels. */
function buildInterleavedParts(body: GeminiRequestBody): Part[] {
  const parts: Part[] = [];

  if (body.roomImage?.base64) {
    parts.push({ text: "IMAGE 1 [REFERENCE ROOM ENVIRONMENT]:" });
    parts.push({ inlineData: { mimeType: body.roomImage.mimeType || "image/jpeg", data: body.roomImage.base64 } });
  }

  // P1 fix: room reference images now get explicit labels
  const refs = body.roomReferenceImages || [];
  if (refs.length > 0) {
    parts.push({ text: `IMAGE 1 SUPPLEMENTARY — ${refs.length} additional room angle(s) from the same space:` });
    for (const image of refs) {
      if (image.base64) {
        parts.push({ inlineData: { mimeType: image.mimeType || "image/jpeg", data: image.base64 } });
      }
    }
  }

  if (body.sofaImage?.base64) {
    parts.push({ text: "IMAGE 2 [EXACT REFERENCE SOFA PRODUCT — THIS IS THE PRODUCT TO IDENTIFY AND REPLICATE]:" });
    parts.push({ inlineData: { mimeType: body.sofaImage.mimeType || "image/jpeg", data: body.sofaImage.base64 } });
  }

  if (body.productReferenceImage?.base64 && body.productReferenceImage.base64 !== body.sofaImage?.base64) {
    parts.push({ text: "IMAGE 3 [PRODUCT IDENTITY REFERENCE]:" });
    parts.push({ inlineData: { mimeType: body.productReferenceImage.mimeType || "image/jpeg", data: body.productReferenceImage.base64 } });
  }

  if (body.resultImage?.base64) {
    parts.push({ text: "IMAGE 4 [GENERATED RESULT TO EVALUATE]:" });
    parts.push({ inlineData: { mimeType: body.resultImage.mimeType || "image/jpeg", data: body.resultImage.base64 } });
  }

  // Prompt at the end — following floor lamp project's approach
  parts.push({ text: body.systemPrompt || "" });

  return parts;
}

/** Build interleaved parts for image generation — images+labels first, prompt last. */
function buildGenerationParts(body: GeminiRequestBody): Part[] {
  const parts: Part[] = [];

  if (body.roomImage?.base64) {
    parts.push({ text: "IMAGE 1 [REFERENCE ROOM ENVIRONMENT]:" });
    parts.push({ inlineData: { mimeType: body.roomImage.mimeType || "image/jpeg", data: body.roomImage.base64 } });
  }

  const refs = body.roomReferenceImages || [];
  if (refs.length > 0) {
    parts.push({ text: `IMAGE 1 SUPPLEMENTARY — ${refs.length} additional room angle(s):` });
    for (const image of refs) {
      if (image.base64) {
        parts.push({ inlineData: { mimeType: image.mimeType || "image/jpeg", data: image.base64 } });
      }
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

  // Prompt LAST — critical for Gemini's sequential processing
  parts.push({ text: body.systemPrompt || "" });

  return parts;
}

/** Call generateContent via @google/genai SDK for text/JSON responses (analyze/quality). */
async function callGenerateContent(
  client: GoogleGenAI,
  model: string,
  parts: Part[],
  config: { temperature?: number; responseMimeType?: string }
): Promise<unknown> {
  const response = await client.models.generateContent({
    model,
    contents: { parts },
    config: {
      temperature: config.temperature ?? 0.2,
      responseMimeType: config.responseMimeType ?? "text/plain"
    }
  });

  if (!response.candidates?.[0]?.content?.parts) {
    throw new GeminiUpstreamError(500, "Gemini 返回了空响应");
  }

  return response;
}

/** Generate images using @google/genai SDK with generateContent as primary, Interactions as fallback. */
async function generateImagesWithSDK(client: GoogleGenAI, body: GeminiRequestBody, model: string) {
  const requested = body.settings?.perspectives?.length ? body.settings.perspectives : ["medium"];

  const results = await Promise.all(requested.map(async (perspective) => {
    const perspectiveBody: GeminiRequestBody = {
      ...body,
      settings: { ...body.settings, perspectives: [perspective] }
    };

    const image = await generateImageWithFallback(client, perspectiveBody, model, perspective);
    if (!image) throw new Error(`Gemini 未返回可用的${perspective}视角图片`);

    const title = perspective === "wide" ? "远景（房间全景）" : perspective === "medium" ? "中近景（沙发主体）" : "近景（产品细节）";
    return { perspective, title, imageUrl: `data:${image.mimeType};base64,${image.data}` };
  }));

  return results;
}

/** Try generateContent (SDK) first, then Interactions API as fallback. */
async function generateImageWithFallback(
  client: GoogleGenAI,
  body: GeminiRequestBody,
  model: string,
  perspective: string
): Promise<{ mimeType: string; data: string } | null> {
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
    console.warn("[api/proxy] generateContent SDK failed", { model, perspective, ...describeError(error) });
  }

  // FALLBACK 1: try Interactions API (raw fetch — SDK doesn't support Interactions)
  try {
    const interactionResult = await requestImageInteractionRaw(body, model, perspective);
    if (interactionResult) return interactionResult;
  } catch (error) {
    console.warn("[api/proxy] Interactions fallback failed", { model, perspective, ...describeError(error) });
  }

  // FALLBACK 2: try different model via SDK
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
      console.warn("[api/proxy] fallback model failed", { fallbackModel, perspective, ...describeError(error) });
    }
  }

  throw new ImageGenerationUnavailable();
}

/** Extract image from SDK generateContent response. */
function extractSDKImage(response: unknown): { mimeType: string; data: string } | null {
  const resp = response as { candidates?: Array<{ content?: { parts?: Array<Part> } }> };
  const parts = resp.candidates?.[0]?.content?.parts;
  if (!parts) return null;

  for (const part of parts) {
    if (part.inlineData?.data) {
      return {
        mimeType: part.inlineData.mimeType || "image/png",
        data: part.inlineData.data
      };
    }
  }
  return null;
}

/** Interactions API fallback — raw fetch since @google/genai SDK doesn't support it. */
async function requestImageInteractionRaw(
  body: GeminiRequestBody,
  model: string,
  perspective: string
): Promise<{ mimeType: string; data: string } | null> {
  const apiKey = process.env.GEMINI_API_KEY!;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 75_000);

  const input = buildInterleavedInteractionInput(body);

  try {
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
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
    });

    const raw = await response.text();
    if (!response.ok) return null;

    const data = JSON.parse(raw);
    return extractInteractionImage(data);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function buildInterleavedInteractionInput(body: GeminiRequestBody) {
  const parts: Array<{ type: string; text?: string; mime_type?: string; data?: string }> = [];

  if (body.roomImage?.base64) {
    parts.push({ type: "text", text: "IMAGE 1 [REFERENCE ROOM ENVIRONMENT]:" });
    parts.push({ type: "image", mime_type: body.roomImage.mimeType || "image/jpeg", data: body.roomImage.base64 });
  }

  const refs = body.roomReferenceImages || [];
  if (refs.length > 0) {
    parts.push({ type: "text", text: `IMAGE 1 SUPPLEMENTARY — ${refs.length} additional room angle(s):` });
    for (const image of refs) {
      if (image.base64) parts.push({ type: "image", mime_type: image.mimeType || "image/jpeg", data: image.base64 });
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

  parts.push({ type: "text", text: body.systemPrompt || "" });
  return parts;
}

function extractInteractionImage(data: unknown): { mimeType: string; data: string } | null {
  const record = asRecord(data);
  const outputImage = asRecord(record.output_image);
  if (typeof outputImage.data === "string") {
    return {
      mimeType: typeof outputImage.mime_type === "string" ? outputImage.mime_type : "image/png",
      data: outputImage.data
    };
  }

  const steps = Array.isArray(record.steps) ? record.steps : [];
  for (const step of steps) {
    const image = asRecord(asRecord(step).output_image);
    if (typeof image.data === "string") {
      return {
        mimeType: typeof image.mime_type === "string" ? image.mime_type : "image/png",
        data: image.data
      };
    }

    const content = asRecord(step).content;
    if (Array.isArray(content)) {
      for (const item of content) {
        const contentItem = asRecord(item);
        if (typeof contentItem.data === "string" && String(contentItem.mime_type || "").startsWith("image/")) {
          return {
            mimeType: typeof contentItem.mime_type === "string" ? contentItem.mime_type : "image/png",
            data: contentItem.data
          };
        }
      }
    }
  }

  return null;
}

async function proxyToSaas(req: JsonRequest, res: ServerResponse, path: string) {
  const target = `${SAAS_ORIGIN}${path}${getQuery(req)}`;
  const headers: Record<string, string> = {};
  const contentType = req.headers["content-type"];

  if (typeof contentType === "string") {
    headers["Content-Type"] = contentType;
  }

  const init: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers
  };

  if (req.method !== "GET" && req.method !== "HEAD") {
    if (contentType?.includes("application/json")) {
      init.body = JSON.stringify(await readJsonBody(req));
    } else {
      init.body = req as never;
      init.duplex = "half";
    }
  }

  const response = await fetch(target, init);
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    if (!["content-encoding", "content-length", "transfer-encoding"].includes(key.toLowerCase())) {
      res.setHeader(key, value);
    }
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  res.end(buffer);
}

function createMockGeminiResponse(body: GeminiRequestBody) {
  if (body.mode === "analyze") {
    return {
      success: true,
      analysis: {
        roomSummary: "别墅客厅空间开阔，地面与墙面关系清晰，适合进行大尺寸沙发试摆。",
        sofaSummary: "沙发主体清晰，应保留原有颜色、面料质感、扶手和坐垫结构。",
        lighting: "自然光从侧向进入，生成时需要补充地面接触阴影和环境反射。",
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

function parseAnalysis(data: unknown) {
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

function normalizeSofaIdentity(value: unknown, fallback: unknown) {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const summary = toReadableText(fallback, "目标沙发参考图中的产品主体");
  return {
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

function parsePlacementPlan(value: unknown, fallbackAdvice: unknown) {
  const plan = asRecord(value);
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

function parseCandidates(value: unknown) {
  const candidates = Array.isArray(value) ? value : [];
  return candidates.map((candidate, index) => {
    const item = asRecord(candidate);
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

function parseQuality(data: unknown) {
  const text = extractText(data);
  try {
    const parsed = JSON.parse(stripCodeFence(text));
    return {
      passed: parsed.passed === true,
      issues: toReadableList(parsed.issues, []),
      correctionPrompt: toReadableText(parsed.correctionPrompt, "")
    };
  } catch {
    return {
      passed: false,
      issues: ["无法完成自动质检，请人工确认试摆效果。"],
      correctionPrompt: ""
    };
  }
}

function extractText(data: unknown): string {
  const resp = data as { candidates?: Array<{ content?: { parts?: Array<Part> } }> };
  const parts = resp.candidates?.[0]?.content?.parts;
  if (!parts) return "";
  return parts
    .map((part) => (part as { text?: string }).text || "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function mapModel(model?: string, mode?: string): string {
  if (mode === "analyze" || mode === "quality") {
    return process.env.GEMINI_ANALYZE_MODEL || "gemini-2.5-flash";
  }

  // P2 fix: default to lite model matching the floor lamp project
  if (model === "gemini-3") {
    return process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-lite-image";
  }

  return process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";
}

async function readJsonBody<T = unknown>(req: JsonRequest): Promise<T> {
  if (req.body) {
    return req.body as T;
  }

  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > BODY_LIMIT) {
      throw new Error("请求体超过 20MB，请压缩图片后重试");
    }
    chunks.push(buffer);
  }

  if (!chunks.length) {
    return {} as T;
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

function setCors(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Content-Security-Policy", "frame-ancestors *");
}

function getRequestPath(req: IncomingMessage): string {
  const host = req.headers.host || "localhost";
  const url = new URL(req.url || "/", `http://${host}`);
  if (url.pathname === "/api/proxy") {
    const rewrittenPath = url.searchParams.get("path");
    if (rewrittenPath) {
      return `/api/${rewrittenPath.replace(/^\/+/, "")}`;
    }
  }
  return url.pathname;
}

function getQuery(req: IncomingMessage): string {
  const host = req.headers.host || "localhost";
  const url = new URL(req.url || "/", `http://${host}`);
  if (url.pathname === "/api/proxy") {
    url.searchParams.delete("path");
  }
  return url.search;
}

function stripCodeFence(text: string): string {
  return text.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
}

function parseGeminiError(raw: string): string {
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

function toReadableText(value: unknown, fallback: string): string {
  if (typeof value === "string") return value.trim() || fallback;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const text = value.map((item) => toReadableText(item, "")).filter(Boolean).join("；");
    return text || fallback;
  }
  if (value && typeof value === "object") {
    const text = Object.values(value as Record<string, unknown>)
      .map((item) => toReadableText(item, ""))
      .filter(Boolean)
      .join("；");
    return text || fallback;
  }
  return fallback;
}

function toReadableList(value: unknown, fallback: string[]): string[] {
  const items = Array.isArray(value) ? value : value == null ? [] : [value];
  const normalized = items.map((item) => toReadableText(item, "")).filter(Boolean);
  return normalized.length ? normalized : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function createMockSvgDataUrl(perspective: string, ratio: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="900" viewBox="0 0 1400 900">
  <rect width="1400" height="900" fill="#edf2f7"/>
  <path d="M0 610 L1400 470 L1400 900 L0 900 Z" fill="#d6c6ad"/>
  <path d="M0 0 H1400 V470 L0 610 Z" fill="#f8fafc"/>
  <rect x="170" y="190" width="390" height="250" rx="8" fill="#dbeafe"/>
  <rect x="775" y="190" width="430" height="250" rx="8" fill="#e2e8f0"/>
  <ellipse cx="700" cy="690" rx="390" ry="70" fill="#b8a58d" opacity=".36"/>
  <rect x="405" y="520" width="590" height="155" rx="30" fill="#52616f"/>
  <rect x="450" y="465" width="500" height="130" rx="28" fill="#64748b"/>
  <rect x="450" y="640" width="52" height="88" rx="12" fill="#334155"/>
  <rect x="898" y="640" width="52" height="88" rx="12" fill="#334155"/>
  <text x="700" y="805" text-anchor="middle" font-family="Arial, sans-serif" font-size="34" fill="#334155">AI 别墅沙发试摆 · ${escapeXml(perspective)} · ${escapeXml(ratio)}</text>
</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (char) => {
    const map: Record<string, string> = { "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" };
    return map[char] || char;
  });
}
