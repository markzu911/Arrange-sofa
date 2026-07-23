import type { IncomingMessage, ServerResponse } from "node:http";

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

interface GeminiPart {
  text?: string;
  inlineData?: {
    mimeType: string;
    data: string;
  };
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
  perspectivePrompts?: Record<string, string>;
  isCameraVariation?: boolean;
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

  const model = mapModel(body.model, body.mode);

  const parts: GeminiPart[] = [
    { text: body.systemPrompt || "" }
  ];

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

  if (body.productReferenceImage?.base64) {
    parts.push({
      inlineData: {
        mimeType: body.productReferenceImage.mimeType || "image/jpeg",
        data: body.productReferenceImage.base64
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
    sendJson(res, 200, images.length ? { success: true, images } : createMockGeminiResponse(body));
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
    sendJson(res, 200, {
      success: true,
      analysis: parseAnalysis(data)
    });
    return;
  }

  if (body.mode === "quality") {
    sendJson(res, 200, { success: true, quality: parseQuality(data) });
    return;
  }

  sendJson(res, 200, parseGeneratedImages(data, body));
}

async function generateImagesWithInteractions(body: GeminiRequestBody, apiKey: string, model: string) {
  const requested = body.settings?.perspectives?.length ? body.settings.perspectives : ["medium"];
  const { response, raw, model: selectedModel } = await requestImageWithFallback(body, apiKey, model, "wide");
  if (!response.ok) throw toGeminiUpstreamError(response.status, raw, "Gemini 图片生成失败");

  const masterData = JSON.parse(raw);
  const masterImage = extractInteractionImage(masterData) || extractGeneratedContentImage(masterData);
  if (!masterImage) throw new Error("Gemini 未返回可用的试摆主图");
  const results = [{ perspective: "wide", title: "远景（房间全景）", imageUrl: `data:${masterImage.mimeType};base64,${masterImage.data}` }];
  await Promise.all(requested.filter((item) => item !== "wide").map(async (perspective) => {
    const variationBody: GeminiRequestBody = {
      ...body,
      roomImage: { base64: masterImage.data, mimeType: masterImage.mimeType },
      roomReferenceImages: [],
      isCameraVariation: true
    };
    const { response: variationResponse, raw: variationRaw } = await requestImageWithFallback(variationBody, apiKey, selectedModel, perspective);
    if (!variationResponse.ok) throw toGeminiUpstreamError(variationResponse.status, variationRaw, "镜头生成失败，请稍后重试");
    const variationData = JSON.parse(variationRaw);
    const variationImage = extractInteractionImage(variationData) || extractGeneratedContentImage(variationData);
    if (!variationImage) throw new Error("Gemini 未返回有效镜头图片");
    results.push({ perspective, title: perspective === "medium" ? "中近景（沙发主体）" : "近景（产品细节）", imageUrl: `data:${variationImage.mimeType};base64,${variationImage.data}` });
  }));
  results.sort((left, right) => requested.indexOf(left.perspective) - requested.indexOf(right.perspective));
  return results;
}

async function requestImageWithFallback(body: GeminiRequestBody, apiKey: string, model: string, perspective: string) {
  let primary: { response: Response; raw: string } | undefined;
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

function shouldTryGenerateContent(status: number, raw: string) {
  return status === 400 && /not available in your current location|available-regions|not supported|unsupported|not found/i.test(raw);
}

function requestImageGenerateContent(body: GeminiRequestBody, apiKey: string, model: string, perspective: string) {
  const prompt = body.perspectivePrompts?.[perspective] || body.systemPrompt || "";
  const parts: GeminiPart[] = [{ text: prompt }];
  const images = body.isCameraVariation
    ? [body.productReferenceImage, body.sofaImage, body.roomImage]
    : [body.roomImage, ...(body.roomReferenceImages || []), body.sofaImage, body.productReferenceImage];
  for (const image of images) {
    if (image?.base64) parts.push({ inlineData: { mimeType: image.mimeType || "image/jpeg", data: image.base64 } });
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
            ...(model.includes("3") ? { imageSize: body.settings?.clarity || "1K" } : {})
          }
        }
      }
    })
  });
}

function requestImageInteraction(body: GeminiRequestBody, apiKey: string, model: string, perspective: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 75_000);
  const isAssetEdit = body.mode === "cutout" || body.mode === "erase";
  const prompt = body.perspectivePrompts?.[perspective] || body.systemPrompt || "";
  const cameraVariationInstruction = body.productReferenceImage?.base64
    ? "这是同一试摆方案的换镜头任务，不继承前一张生成图的产品样式。第一张是原始沙发产品参考图，是产品身份唯一依据；第二张是沙发前景；第三张远景图只用于参考房间、摆放、尺度、光影和家具关系。如果远景图中的沙发与第一张产品参考图不一致，必须按第一张产品参考图纠正。"
    : "这是同一虚拟试摆方案的换镜头任务，不继承前一张生成图的产品样式。第一张是原始沙发产品参考图，是产品身份唯一依据；第二张远景图只用于参考房间、摆放、尺度、光影和家具关系。如果远景图中的沙发与第一张产品参考图不一致，必须按第一张产品参考图纠正。";
  const input = isAssetEdit
    ? [
        { type: "text", text: prompt },
          ...(body.mode === "erase" && body.roomImage?.base64
            ? [{ type: "image", mime_type: body.roomImage.mimeType || "image/jpeg", data: body.roomImage.base64 }]
            : body.sofaImage?.base64
              ? [{ type: "image", mime_type: body.sofaImage.mimeType || "image/jpeg", data: body.sofaImage.base64 }]
              : [])
      ]
    : body.isCameraVariation
      ? [
          { type: "text", text: `${prompt}\n\n${cameraVariationInstruction}只生成指定镜头：${perspective}。请直接输出最终效果图。` },
          ...(body.productReferenceImage?.base64 ? [{ type: "image", mime_type: body.productReferenceImage.mimeType || "image/jpeg", data: body.productReferenceImage.base64 }] : []),
          ...(body.sofaImage?.base64 ? [{ type: "image", mime_type: body.sofaImage.mimeType || "image/jpeg", data: body.sofaImage.base64 }] : []),
          ...(body.roomImage?.base64 ? [{ type: "image", mime_type: body.roomImage.mimeType || "image/jpeg", data: body.roomImage.base64 }] : [])
        ]
      : [
          { type: "text", text: `${prompt}\n\n请先生成锁定布局的远景主图。远景必须展示完整目标沙发和大部分环境；沙发产品身份必须以原始产品参考图为准。` },
          ...(body.roomImage?.base64 ? [{ type: "image", mime_type: body.roomImage.mimeType || "image/jpeg", data: body.roomImage.base64 }] : []),
          ...((body.roomReferenceImages || []).filter((image) => image.base64).map((image) => ({ type: "image", mime_type: image.mimeType || "image/jpeg", data: image.base64 }))),
          ...(body.sofaImage?.base64 ? [{ type: "image", mime_type: body.sofaImage.mimeType || "image/jpeg", data: body.sofaImage.base64 }] : []),
          ...(body.productReferenceImage?.base64 ? [{ type: "image", mime_type: body.productReferenceImage.mimeType || "image/jpeg", data: body.productReferenceImage.base64 }] : [])
        ];
  return fetchWithDiagnostics(`interactions:${model}:${perspective}:${body.isCameraVariation ? "variation" : "master"}`, "https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    signal: controller.signal,
    body: JSON.stringify({
      model,
      input,
      response_format: {
        type: "image",
        mime_type: "image/jpeg",
        aspect_ratio: body.settings?.ratio || "16:9",
        image_size: body.settings?.clarity || "1K"
      }
    })
  }).finally(() => clearTimeout(timeout));
}

async function fetchWithDiagnostics(label: string, url: string, init: RequestInit) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await fetch(url, init);
    } catch (error) {
      lastError = error;
      console.error("[api/proxy] upstream fetch failed", {
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

function isRetryableFetchError(error: unknown) {
  if (!(error instanceof Error)) return false;
  const cause = (error as Error & { cause?: Record<string, unknown> }).cause;
  const causeText = String(cause?.code || cause?.name || cause?.message || "");
  return /fetch failed|network|socket|terminated|timeout|aborted/i.test(error.message)
    || /ECONNRESET|ETIMEDOUT|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|EAI_AGAIN|ENETUNREACH|ECONNREFUSED/i.test(causeText);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isHighDemand(status: number, raw: string): boolean {
  return status === 429 || status === 503 || /high demand|try again later|resource exhausted/i.test(raw);
}

function isRequestTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /aborted|timeout/i.test(error.message));
}

function toGeminiUpstreamError(statusCode: number, raw: string, fallbackMessage: string): GeminiUpstreamError {
  const upstreamMessage = parseGeminiError(raw) || fallbackMessage;
  if (/denied access|permission|api key|unauthenticated|forbidden/i.test(upstreamMessage) || statusCode === 401 || statusCode === 403) {
    return new GeminiUpstreamError(statusCode, "Gemini API Key 或当前项目权限不可用，请检查 API Key 所属项目及 Gemini API 访问权限。");
  }
  if (statusCode === 404 || /not found|not supported|model.*not/i.test(upstreamMessage)) {
    return new GeminiUpstreamError(statusCode, "当前 Gemini 图片模型不可用或不支持此接口，请检查模型配置。");
  }
  return new GeminiUpstreamError(statusCode, upstreamMessage);
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

/** Gemini 偶尔会把文本字段包装成数组或对象，统一转换为可展示的中文文本。 */
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

function parseGeneratedImages(data: unknown, body: GeminiRequestBody) {
  const candidates = asRecord(data).candidates as unknown[];
  const parts = asRecord(asRecord(candidates?.[0]).content).parts as unknown[];
  const images = (parts || [])
    .map((part) => asRecord(part).inlineData as { mimeType?: string; data?: string } | undefined)
    .filter((part): part is { mimeType?: string; data: string } => Boolean(part?.data))
    .map((part, index) => ({
      perspective: body.settings?.perspectives?.[index] || "medium",
      title: `试摆效果 ${index + 1}`,
      imageUrl: `data:${part.mimeType || "image/png"};base64,${part.data}`
    }));

  if (images.length) {
    return { success: true, images };
  }

  return createMockGeminiResponse(body);
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

function extractGeneratedContentImage(data: unknown): { mimeType: string; data: string } | null {
  const candidates = asRecord(data).candidates;
  const firstCandidate = Array.isArray(candidates) ? asRecord(candidates[0]) : {};
  const content = asRecord(firstCandidate.content);
  const parts = Array.isArray(content.parts) ? content.parts : [];
  for (const part of parts) {
    const source = asRecord(part);
    const image = asRecord(source.inlineData || source.inline_data);
    if (typeof image.data === "string") {
      return {
        mimeType: typeof image.mimeType === "string" ? image.mimeType : typeof image.mime_type === "string" ? image.mime_type : "image/png",
        data: image.data
      };
    }
  }
  return null;
}

function extractText(data: unknown): string {
  const candidates = asRecord(data).candidates as unknown[];
  const parts = asRecord(asRecord(candidates?.[0]).content).parts as unknown[];
  return (parts || [])
    .map((part) => asRecord(part).text)
    .filter((text): text is string => typeof text === "string")
    .join("\n")
    .trim();
}

function mapModel(model?: string, mode?: string): string {
  if (mode === "analyze" || mode === "quality") {
    return process.env.GEMINI_ANALYZE_MODEL || "gemini-2.5-flash";
  }

  if (model === "gemini-3") {
    return process.env.GEMINI_IMAGE_MODEL_3 || process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image";
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
