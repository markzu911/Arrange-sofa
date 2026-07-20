import type { ImageRatio, PerspectiveOption, UploadedImage } from "../types";

const MAX_INPUT_SIZE = 20 * 1024 * 1024;
const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.85;

export async function compressImage(file: File, maxEdge = MAX_EDGE, quality = JPEG_QUALITY): Promise<UploadedImage> {
  if (!file.type.startsWith("image/")) {
    throw new Error("请上传图片文件");
  }

  if (file.size > MAX_INPUT_SIZE) {
    throw new Error("图片不能超过 20MB");
  }

  const originalDataUrl = await readFileAsDataUrl(file);
  const img = await loadImage(originalDataUrl);
  const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
  const width = Math.max(1, Math.round(img.width * scale));
  const height = Math.max(1, Math.round(img.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("浏览器不支持图片压缩");
  }

  ctx.drawImage(img, 0, 0, width, height);
  const dataUrl = canvas.toDataURL("image/jpeg", quality);
  const base64 = dataUrl.split(",")[1] ?? "";
  const size = Math.round((base64.length * 3) / 4);

  return {
    fileName: file.name.replace(/\.[^.]+$/, ".jpg"),
    mimeType: "image/jpeg",
    size,
    dataUrl,
    base64,
    width,
    height
  };
}

export async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const response = await fetch(dataUrl);
  return response.blob();
}

export async function removeGreenScreen(dataUrl: string): Promise<string> {
  const image = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("浏览器不支持沙发前景处理");
  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  for (let index = 0; index < pixels.data.length; index += 4) {
    const [red, green, blue] = [pixels.data[index], pixels.data[index + 1], pixels.data[index + 2]];
    if (green > 145 && green > red * 1.35 && green > blue * 1.35) pixels.data[index + 3] = 0;
  }
  ctx.putImageData(pixels, 0, 0);
  return canvas.toDataURL("image/png");
}

export async function createFixedCameraViews(
  masterImageUrl: string,
  perspectives: PerspectiveOption[],
  ratio: ImageRatio
): Promise<Array<{ perspective: PerspectiveOption; imageUrl: string }>> {
  const master = await loadImage(masterImageUrl);
  const targetRatio = ratioToNumber(ratio);
  const outputWidth = 1600;
  const outputHeight = Math.round(outputWidth / targetRatio);

  return perspectives.map((perspective) => {
    const scale = perspective === "wide" ? 1 : perspective === "medium" ? 0.5 : 0.32;
    const baseWidth = Math.min(master.width, master.height * targetRatio);
    const baseHeight = baseWidth / targetRatio;
    const cropWidth = baseWidth * scale;
    const cropHeight = baseHeight * scale;
    const focalX = master.width * 0.5;
    const focalY = master.height * 0.62;
    const sourceX = Math.round(clamp(focalX - cropWidth / 2, 0, master.width - cropWidth));
    const sourceY = Math.round(clamp(focalY - cropHeight / 2, 0, master.height - cropHeight));
    const canvas = document.createElement("canvas");
    canvas.width = outputWidth;
    canvas.height = outputHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("浏览器不支持镜头视角处理");
    ctx.drawImage(master, sourceX, sourceY, cropWidth, cropHeight, 0, 0, outputWidth, outputHeight);
    return { perspective, imageUrl: canvas.toDataURL("image/jpeg", 0.92) };
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export async function assertDistinctCameraViews(masterImageUrl: string, variations: string[]): Promise<void> {
  if (!variations.length) return;
  const masterImage = await loadImage(masterImageUrl);
  const master = imagePixels(masterImage);
  const cropScales = [0.72, 0.62, 0.5, 0.4, 0.32];
  for (const variationUrl of variations) {
    const variationImage = await loadImage(variationUrl);
    const variation = imagePixels(variationImage);
    const normalizedDifference = pixelDifference(master, variation);
    if (normalizedDifference < 0.025) {
      throw new Error("镜头变化不足，已拦截本次结果。请重新生成，系统不会把近乎相同的画面当作不同视角。");
    }
    for (const scale of cropScales) {
      const crop = imagePixels(masterImage, scale);
      if (pixelDifference(crop, variation) < 0.035) {
        throw new Error("镜头疑似只是远景裁切或缩放，已拦截本次结果。请重新生成真实不同机位。");
      }
    }
  }
}

function pixelDifference(left: Uint8ClampedArray, right: Uint8ClampedArray): number {
  let totalDifference = 0;
  for (let index = 0; index < left.length; index += 4) {
    totalDifference += Math.abs(left[index] - right[index]);
    totalDifference += Math.abs(left[index + 1] - right[index + 1]);
    totalDifference += Math.abs(left[index + 2] - right[index + 2]);
  }
  return totalDifference / ((left.length / 4) * 3 * 255);
}

function imagePixels(image: HTMLImageElement, cropScale = 1): Uint8ClampedArray {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("浏览器不支持镜头结果校验");
  const sourceWidth = image.width * cropScale;
  const sourceHeight = image.height * cropScale;
  const sourceX = (image.width - sourceWidth) / 2;
  const sourceY = (image.height - sourceHeight) / 2;
  ctx.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
  return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
}

function ratioToNumber(ratio: ImageRatio): number {
  const [width, height] = ratio.split(":").map(Number);
  return width / height;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片格式无法识别"));
    img.src = src;
  });
}
