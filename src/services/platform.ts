import { TOOL_COST, TOOL_ID, TOOL_NAME } from "../constants";
import type { ApiResult, LaunchState, SaasInitPayload } from "../types";

export interface PlatformContext {
  userId: string;
  toolId: string;
  context: string;
  prompt: string[];
  launchUrl: string;
  verifyUrl: string;
  consumeUrl: string;
  uploadTokenUrl: string;
  uploadCommitUrl: string;
}

export interface UploadCommitResult {
  savedUrl?: string;
  recordId?: string;
  savedToRecords?: boolean;
}

export function createInitialPlatformContext(): PlatformContext {
  const params = new URLSearchParams(window.location.search);
  return {
    userId: cleanParam(params.get("userId")) || "demo-user",
    toolId: cleanParam(params.get("toolId")) || TOOL_ID,
    context: cleanParam(params.get("context")) || "",
    prompt: [],
    launchUrl: "/api/tool/launch",
    verifyUrl: "/api/tool/verify",
    consumeUrl: "/api/tool/consume",
    uploadTokenUrl: "/api/upload/direct-token",
    uploadCommitUrl: "/api/upload/commit"
  };
}

export function mergeSaasInit(context: PlatformContext, payload: SaasInitPayload): PlatformContext {
  return {
    ...context,
    userId: cleanParam(payload.userId) || context.userId,
    toolId: cleanParam(payload.toolId) || context.toolId,
    context: cleanParam(payload.context) || context.context,
    prompt: Array.isArray(payload.prompt) ? payload.prompt.filter(Boolean) : context.prompt,
    launchUrl: cleanParam(payload.launchUrl) || context.launchUrl,
    verifyUrl: cleanParam(payload.verifyUrl) || context.verifyUrl,
    consumeUrl: cleanParam(payload.consumeUrl) || context.consumeUrl,
    uploadTokenUrl: cleanParam(payload.uploadTokenUrl) || context.uploadTokenUrl,
    uploadCommitUrl: cleanParam(payload.uploadCommitUrl) || context.uploadCommitUrl
  };
}

export async function launchTool(context: PlatformContext): Promise<LaunchState> {
  const response = await postJson<ApiResult<LaunchState>>(context.launchUrl, {
    userId: context.userId,
    toolId: context.toolId
  });

  if (response.success && response.data) {
    return response.data;
  }

  return {
    user: { name: "演示用户", enterprise: "演示空间", integral: 90 },
    tool: { name: TOOL_NAME, integral: TOOL_COST }
  };
}

export async function verifyIntegral(context: PlatformContext): Promise<void> {
  const response = await postJson<ApiResult<{ currentIntegral: number; requiredIntegral: number }>>(
    context.verifyUrl,
    { userId: context.userId, toolId: context.toolId }
  );

  if (response.success || response.valid) {
    return;
  }

  throw new Error(response.message || "积分不足，无法继续执行");
}

export async function consumeIntegral(context: PlatformContext): Promise<number | undefined> {
  const response = await postJson<ApiResult<{ currentIntegral: number; consumedIntegral: number }>>(
    context.consumeUrl,
    { userId: context.userId, toolId: context.toolId }
  );

  if (!response.success && !response.valid) {
    throw new Error(response.message || "扣除积分失败");
  }

  return response.data?.currentIntegral;
}

export async function persistResultImage(
  context: PlatformContext,
  blob: Blob,
  fileName: string
): Promise<UploadCommitResult> {
  const token = await postJson<{
    success: boolean;
    method: string;
    objectKey: string;
    uploadUrl: string;
    proxyUploadUrl?: string;
    headers?: Record<string, string>;
    message?: string;
  }>(context.uploadTokenUrl, {
    userId: context.userId,
    toolId: context.toolId,
    source: "result",
    fileName,
    mimeType: blob.type || "image/png",
    fileSize: blob.size
  });

  if (!token.success) {
    throw new Error(token.message || "获取结果图上传地址失败");
  }

  const uploadResponse = await fetch(token.proxyUploadUrl || token.uploadUrl || "", {
    method: token.method || "PUT",
    headers: token.headers || { "Content-Type": blob.type || "image/png" },
    body: blob
  });
  if (!uploadResponse.ok) {
    throw new Error(`结果图上传失败：${uploadResponse.status}`);
  }

  const commit = await postJson<{
    success: boolean;
    savedToRecords?: boolean;
    recordId?: string;
    url?: string;
    image?: { url?: string; recordId?: string; savedToRecords?: boolean };
    message?: string;
  }>(context.uploadCommitUrl, {
    userId: context.userId,
    toolId: context.toolId,
    source: "result",
    objectKey: token.objectKey,
    fileSize: blob.size
  });

  const savedToRecords = commit.image?.savedToRecords ?? commit.savedToRecords;
  if (!commit.success || savedToRecords !== true) {
    throw new Error(commit.message || "结果图入库失败");
  }

  return {
    savedUrl: commit.image?.url || commit.url,
    recordId: commit.image?.recordId || commit.recordId,
    savedToRecords
  };
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw new Error(`接口返回异常：${response.status}`);
  }

  return response.json() as Promise<T>;
}

function cleanParam(value?: string | null): string {
  if (!value || value === "null" || value === "undefined") {
    return "";
  }
  return value;
}
