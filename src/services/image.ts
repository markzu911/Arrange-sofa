import type { ImageRatio, PerspectiveOption, UploadedImage } from "../types";

const MAX_INPUT_SIZE = 20 * 1024 * 1024;
const MAX_EDGE = 1200;
const JPEG_QUALITY = 0.72;

export const GEMINI_IMAGE_TARGET_BYTES = 420 * 1024;
export const GEMINI_REFERENCE_TARGET_BYTES = 160 * 1024;

export async function compressImage(
  file: File,
  maxEdge = MAX_EDGE,
  quality = JPEG_QUALITY,
  targetBytes = GEMINI_IMAGE_TARGET_BYTES
): Promise<UploadedImage> {
  if (!file.type.startsWith("image/")) {
    throw new Error("请上传图片文件");
  }

  if (file.size > MAX_INPUT_SIZE) {
    throw new Error("图片不能超过 20MB");
  }

  const originalDataUrl = await readFileAsDataUrl(file);
  const img = await loadImage(originalDataUrl);
  return renderCompressedImage(img, file.name.replace(/\.[^.]+$/, ".jpg"), maxEdge, quality, targetBytes);
}

function renderCompressedImage(
  img: HTMLImageElement,
  fileName: string,
  maxEdge: number,
  quality: number,
  targetBytes: number
): UploadedImage {
  let edge = maxEdge;
  let currentQuality = quality;
  let compressed = drawJpeg(img, fileName, edge, currentQuality);
  while (compressed.size > targetBytes && (edge > 640 || currentQuality > 0.5)) {
    if (currentQuality > 0.5) {
      currentQuality = Math.max(0.5, currentQuality - 0.08);
    } else {
      edge = Math.max(640, Math.round(edge * 0.82));
      currentQuality = quality;
    }
    compressed = drawJpeg(img, fileName, edge, currentQuality);
  }
  return compressed;
}

function drawJpeg(img: HTMLImageElement, fileName: string, maxEdge: number, quality: number): UploadedImage {
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
    fileName,
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

export async function compressDataUrlToImage(
  dataUrl: string,
  fileName: string,
  maxEdge = MAX_EDGE,
  quality = JPEG_QUALITY,
  targetBytes = GEMINI_IMAGE_TARGET_BYTES
): Promise<UploadedImage> {
  const image = await loadImage(dataUrl);
  return renderCompressedImage(image, fileName.replace(/\.[^.]+$/, ".jpg"), maxEdge, quality, targetBytes);
}

export async function compressDataUrlToBlob(
  dataUrl: string,
  maxEdge = 1600,
  quality = 0.86,
  targetBytes = 1200 * 1024
): Promise<Blob> {
  const image = await loadImage(dataUrl);
  let edge = maxEdge;
  let currentQuality = quality;
  let blob = await drawJpegBlob(image, edge, currentQuality);
  while (blob.size > targetBytes && (edge > 960 || currentQuality > 0.68)) {
    if (currentQuality > 0.68) {
      currentQuality = Math.max(0.68, currentQuality - 0.08);
    } else {
      edge = Math.max(960, Math.round(edge * 0.85));
      currentQuality = quality;
    }
    blob = await drawJpegBlob(image, edge, currentQuality);
  }
  return blob;
}

function drawJpegBlob(image: HTMLImageElement, maxEdge: number, quality: number): Promise<Blob> {
  const scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("浏览器不支持结果图压缩");
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("结果图压缩失败")), "image/jpeg", quality);
  });
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

export async function createWhiteBackgroundProductLayer(source: UploadedImage): Promise<UploadedImage> {
  const image = await loadImage(source.dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("浏览器不支持产品前景处理");

  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const width = canvas.width;
  const height = canvas.height;
  const visited = new Uint8Array(width * height);
  const queue: number[] = [];

  const isWhiteBackgroundPixel = (index: number) => {
    const red = pixels.data[index * 4];
    const green = pixels.data[index * 4 + 1];
    const blue = pixels.data[index * 4 + 2];
    return red >= 238 && green >= 238 && blue >= 238 && Math.max(red, green, blue) - Math.min(red, green, blue) <= 18;
  };
  const enqueue = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const position = y * width + x;
    if (visited[position] || !isWhiteBackgroundPixel(position)) return;
    visited[position] = 1;
    queue.push(position);
  };

  for (let x = 0; x < width; x += 1) {
    enqueue(x, 0);
    enqueue(x, height - 1);
  }
  for (let y = 1; y < height - 1; y += 1) {
    enqueue(0, y);
    enqueue(width - 1, y);
  }

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const position = queue[cursor];
    const x = position % width;
    const y = Math.floor(position / width);
    enqueue(x - 1, y);
    enqueue(x + 1, y);
    enqueue(x, y - 1);
    enqueue(x, y + 1);
  }

  for (const position of queue) pixels.data[position * 4 + 3] = 0;
  ctx.putImageData(pixels, 0, 0);
  const dataUrl = canvas.toDataURL("image/png");
  const base64 = dataUrl.split(",")[1] ?? "";
  return {
    fileName: source.fileName.replace(/\.[^.]+$/, "-product.png"),
    mimeType: "image/png",
    size: Math.round((base64.length * 3) / 4),
    dataUrl,
    base64,
    width,
    height
  };
}

export async function composeLockedProduct(
  backgroundUrl: string,
  productLayer: UploadedImage,
  perspective: PerspectiveOption
): Promise<string> {
  const [background, product] = await Promise.all([loadImage(backgroundUrl), loadImage(productLayer.dataUrl)]);
  const canvas = document.createElement("canvas");
  canvas.width = background.width;
  canvas.height = background.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("浏览器不支持产品合成");
  ctx.drawImage(background, 0, 0);

  const bounds = alphaBounds(product);
  if (!bounds) throw new Error("未能从白底产品图识别出沙发主体，请上传背景更干净、主体更完整的产品图");
  const scaleByPerspective: Record<PerspectiveOption, number> = { wide: 0.42, medium: 0.68, close: 1.12 };
  const desiredWidth = canvas.width * scaleByPerspective[perspective];
  const drawScale = desiredWidth / bounds.width;
  const drawWidth = bounds.width * drawScale;
  const drawHeight = bounds.height * drawScale;
  const centerX = canvas.width * (perspective === "wide" ? 0.5 : perspective === "medium" ? 0.52 : 0.56);
  const floorY = canvas.height * (perspective === "wide" ? 0.82 : perspective === "medium" ? 0.86 : 0.9);
  const drawX = centerX - drawWidth / 2;
  const drawY = floorY - drawHeight;

  ctx.save();
  ctx.filter = "blur(14px)";
  ctx.fillStyle = "rgba(20, 24, 30, 0.24)";
  ctx.beginPath();
  ctx.ellipse(centerX, floorY + 5, drawWidth * 0.42, Math.max(8, drawHeight * 0.045), 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.drawImage(
    product,
    bounds.x,
    bounds.y,
    bounds.width,
    bounds.height,
    drawX,
    drawY,
    drawWidth,
    drawHeight
  );
  return canvas.toDataURL("image/png");
}

function alphaBounds(image: HTMLImageElement) {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let minX = canvas.width;
  let minY = canvas.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      if (data[(y * canvas.width + x) * 4 + 3] < 24) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return maxX >= minX && maxY >= minY
    ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
    : null;
}

export async function assertNoDuplicateCameraViews(masterImageUrl: string, variations: string[]): Promise<void> {
  if (!variations.length) return;
  const master = imagePixels(await loadImage(masterImageUrl));
  for (const variationUrl of variations) {
    const variation = imagePixels(await loadImage(variationUrl));
    if (pixelDifference(master, variation) < 0.025) {
      throw new Error("镜头结果与远景几乎完全相同，请重新生成真实不同机位的画面。");
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
