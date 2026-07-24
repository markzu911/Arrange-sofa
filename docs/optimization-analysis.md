# 沙发试摆工具优化分析报告

## 一、项目现状

本地工作区（E:\develop\Saas\soft）是一个"AI 别墅沙发试摆助手"，已从 GitHub 上的落地灯试摆项目（Y_luodideng）演化为沙发产品试摆工具。

**技术栈**: React 18 + Vite 6 + TypeScript + Gemini API (Interactions + generateContent)

**核心流程**: 上传房间图+沙发图 → Gemini 分析 → 抠图 → 清场 → 生成多视角背景 → Canvas 合成 → 质检

---

## 二、问题一：产品（沙发）生成结果图与上传图不一致

### 2.1 根因分析

#### 根因 A：三个关键函数缺失，代码无法编译

以下函数被调用但从未定义：

| 缺失函数 | 调用位置 | 影响 |
|----------|---------|------|
| `generatePlacementBackgrounds` | VillaSofaPlacementTool.tsx:449 | 无法生成多视角背景 |
| `generateVirtualRoomBackgrounds` | VillaSofaPlacementTool.tsx:448 | 无法生成虚拟房间背景 |
| `buildProductIdentityPrompt` | prompt.ts:123, 162 | 产品身份约束 prompt 缺失 |

gemini.ts 中存在 `generatePlacementImages` 和 `generateVirtualRoomImages`，但 VillaSofaPlacementTool.tsx 导入的是 `generatePlacementBackgrounds` 和 `generateVirtualRoomBackgrounds`——名称不匹配。

#### 根因 B：白底抠图算法脆弱

`createWhiteBackgroundProductLayer`（image.ts:204-265）使用 flood-fill 从图像边缘检测白色背景：
- 阈值: RGB ≥ 238 且 max-min ≤ 18
- 问题: 仅适用于纯白棚拍背景；遇到灰色背景、阴影渐变、浅色沙发部件时全部失效

项目已有更可靠的绿幕抠图方案（`extractSofaForeground` + `removeGreenScreen`），但主流程未使用。

#### 根因 C：Canvas 合成缺乏真实感

`composeLockedProduct`（image.ts:267-312）的合成方式：
- 硬编码缩放比例: `wide: 0.42, medium: 0.68, close: 1.12`
- 硬编码位置: `centerX = width * 0.5/0.52/0.56`, `floorY = height * 0.82/0.86/0.9`
- 阴影: 单一模糊椭圆，不匹配房间光源方向
- 无透视变换: 同一张 2D 产品图直接缩放放置
- 无色彩匹配: 不调整产品色温/亮度以适应环境光

结果: 沙发看起来像"贴上去的"，而非自然存在于空间中。

#### 根因 D：backgroundOnly 标志从未启用

types.ts 定义了 `backgroundOnly?: boolean`，proxy.ts 中有对应逻辑（生成无沙发背景），但全代码库中从未将其设为 `true`。当前流程试图让 Gemini 同时生成房间+沙发，模型会"重新理解"沙发而非使用原始像素。

### 2.2 优化方案

#### 方案 1：修复缺失函数（必须立即执行）

```typescript
// gemini.ts 中新增 generatePlacementBackgrounds
export async function generatePlacementBackgrounds(
  clearedRoom: UploadedImage,
  analysis: SceneAnalysis,
  settings: PlacementSettings,
  extraContext: string,
  extraPrompt: string[]
): Promise<GeminiImageResponse["images"]> {
  const requestedPerspectives = (["wide", "medium", "close"] as const)
    .filter(p => settings.perspectives.includes(p));

  const perspectivePrompts = Object.fromEntries(
    requestedPerspects.map(p => [
      p,
      buildBackgroundPrompt(analysis, settings, p, extraContext, extraPrompt)
    ])
  );

  const response = await postGemini<GeminiImageResponse>({
    mode: "generate",
    model: settings.model,
    roomImage: clearedRoom,           // 使用清场后的干净房间
    roomReferenceImages: [],
    analysis,
    settings: masterSettings,
    systemPrompt: "请生成无沙发的纯背景环境图",
    perspectivePrompts,
    backgroundOnly: true              // 关键：启用背景模式
  });

  return response.images;
}
```

```typescript
// prompt.ts 中新增 buildProductIdentityPrompt
export function buildProductIdentityPrompt(analysis: SceneAnalysis): string {
  const id = analysis.sofaIdentity;
  return [
    "【产品身份锁定 — 不可违反】",
    `座位数量: ${id.seatCount}`,
    `整体轮廓: ${id.silhouette}`,
    `扶手: ${id.armrest}`,
    `靠背: ${id.backrest}`,
    `坐垫: ${id.cushions}`,
    `材质: ${id.material}`,
    `颜色: ${id.color}`,
    `细节: ${id.details.join("；")}`,
    "以上所有属性必须与产品参考图完全一致，禁止任何形式的修改、替换或相似款替代。"
  ].join("\n");
}
```

#### 方案 2：切换到绿幕抠图（推荐）

将主流程从 `createWhiteBackgroundProductLayer` 切换到已有的 `extractSofaForeground`：

```typescript
// VillaSofaPlacementTool.tsx 中
// 替换:
// setSofaForegroundImage(await createWhiteBackgroundProductLayer(nextSofaImage));
// 改为:
setSofaForegroundImage(await extractSofaForeground(nextSofaImage, settings));
```

优势:
- Gemini 将沙发放在纯 RGB(0,255,0) 绿幕上，`removeGreenScreen` 精确去绿
- 适配任意背景（非白底、阴影、复杂环境）
- 抠图边缘更干净

#### 方案 3：增强 Canvas 合成真实感

```typescript
// image.ts composeLockedProduct 增强版
export async function composeLockedProductEnhanced(
  backgroundUrl: string,
  productLayer: UploadedImage,
  perspective: PerspectiveOption,
  analysis: SceneAnalysis,           // 新增：用于动态参数
  lightDirection?: { x: number; y: number }  // 新增：光源方向
): Promise<string> {
  const [background, product] = await Promise.all([
    loadImage(backgroundUrl),
    loadImage(productLayer.dataUrl)
  ]);

  const canvas = document.createElement("canvas");
  canvas.width = background.width;
  canvas.height = background.height;
  const ctx = canvas.getContext("2d")!;

  // 1. 绘制背景
  ctx.drawImage(background, 0, 0);

  // 2. 计算动态缩放（基于分析结果而非硬编码）
  const bounds = alphaBounds(product);
  if (!bounds) throw new Error("未能识别沙发主体");

  // 从 analysis.placementPlan.scale 获取建议比例
  const baseScale = analysis.placementPlan.scale;
  const scaleByPerspective = {
    wide: 0.38,    // 远景占比小
    medium: 0.62,  // 中近景中等
    close: 0.95    // 近景大
  };
  const desiredWidth = canvas.width * scaleByPerspective[perspective];
  const drawScale = desiredWidth / bounds.width;

  // 3. 透视变换（远景轻微倾斜）
  if (perspective === "wide") {
    ctx.save();
    // 使用 setTransform 进行轻微透视倾斜
    const skewX = 0.03;
    ctx.transform(1, 0, skewX, 1, 0, 0);
  }

  // 4. 色彩匹配：采样背景色调，调整产品
  const bgImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const avgBrightness = calculateAverageBrightness(bgImageData);
  const avgColorTemp = calculateColorTemperature(bgImageData);

  // 5. 绘制方向性阴影（基于光源方向）
  const shadowOffsetX = (lightDirection?.x ?? 0.3) * drawWidth * 0.15;
  const shadowOffsetY = (lightDirection?.y ?? 0.5) * drawHeight * 0.08;
  ctx.save();
  ctx.filter = "blur(18px)";
  ctx.fillStyle = `rgba(15, 20, 28, ${0.3 - avgBrightness * 0.1})`;
  ctx.beginPath();
  ctx.ellipse(
    centerX + shadowOffsetX,
    floorY + shadowOffsetY,
    drawWidth * 0.45,
    Math.max(8, drawHeight * 0.05),
    0, 0, Math.PI * 2
  );
  ctx.fill();
  ctx.restore();

  // 6. 绘制产品
  ctx.drawImage(product, bounds.x, bounds.y, bounds.width, bounds.height,
    drawX, drawY, drawWidth, drawHeight);

  if (perspective === "wide") ctx.restore();

  // 7. 边缘融合：对产品边缘进行轻微模糊混合
  applyEdgeBlend(ctx, drawX, drawY, drawWidth, drawHeight);

  return canvas.toDataURL("image/png");
}
```

#### 方案 4：启用 backgroundOnly 背景生成模式

在 `requestImageInteraction` 中，当 `backgroundOnly=true` 时，prompt 指示 Gemini 仅生成无沙发环境：

```
请生成锁定布局的远景无沙发背景板。
必须保留房间主体结构和大部分环境，画面中不得出现沙发、躺椅或人体模特。
```

这样 Gemini 只负责生成房间环境，沙发像素完全由 Canvas 合成保留——从根本上解决产品不一致问题。

---

## 三、问题二：三视角（远景/中近景/近景）达不到标准

### 3.1 根因分析

#### 根因 A：背景生成函数缺失，三视角无法独立生成

`generatePlacementBackgrounds` 未定义，当前代码无法为三个视角分别生成背景。

#### 根因 B：视角差异校验过于宽松

`assertDistinctCameraViews`（image.ts:183-202）：
- 将图像降采样到 64×64 像素
- 像素差异阈值仅 2.5%（普通裁切 3.5%）
- 64×64 几乎丢失所有空间信息，任何两张不同图片都容易通过

#### 根因 C：产品缩放和位置硬编码

`composeLockedProduct` 中 `scaleByPerspective` 硬编码为 `{ wide: 0.42, medium: 0.68, close: 1.12 }`，不随房间/沙发实际比例变化。远景中沙发可能过大，近景中可能过小。

#### 根因 D：无透视变换

三视角使用同一张 2D 产品图直接缩放，没有模拟真实相机移动产生的透视变化。远景应该看到沙发侧面/斜面，近景应该看到更多正面细节。

#### 根因 E：camera variation 依赖模型重新生成

proxy.ts 中的 `isCameraVariation` 模式让 Gemini 基于远景主图重新生成中近景/近景，但 Gemini 可能：
- 直接裁切远景图（偷懒）
- 重新生成不一致的房间
- 改变沙发外观

### 3.2 优化方案

#### 方案 1：三视角独立背景生成

每个视角使用独立的 prompt 生成无沙发背景，明确指定相机参数：

```typescript
function buildBackgroundPrompt(
  analysis: SceneAnalysis,
  settings: PlacementSettings,
  perspective: string
): string {
  const cameraSpecs = {
    wide: {
      distance: "相机位于房间入口或对角角落",
      height: "1.5-1.7米正常人眼高度",
      sofaRatio: "沙发区域预留画面 15%-25% 的空间",
      framing: "完整呈现房间结构、地面、墙面、门窗和核心家具布局"
    },
    medium: {
      distance: "相机前移至沙发区域前方2-3米",
      height: "1.2-1.4米略高于沙发靠背",
      angle: "可偏向沙发左侧或右侧约15-20度",
      sofaRatio: "沙发区域预留画面 45%-60% 的空间",
      framing: "完整展示沙发位置的周边环境"
    },
    close: {
      distance: "相机贴近沙发正前方0.8-1.2米",
      height: "与沙发扶手齐平或略高",
      sofaRatio: "沙发区域预留画面 75%-85% 的空间",
      framing: "仅保留少量局部地面或墙面作为环境上下文"
    }
  };

  const spec = cameraSpecs[perspective] || cameraSpecs.medium;
  return [
    `这是一个无沙发背景生成任务。房间已经清场，不存在任何沙发。`,
    `镜头参数: ${spec.distance}，高度${spec.height}，${spec.framing}。`,
    spec.angle ? `相机角度: ${spec.angle}。` : "",
    `画面中沙发所在区域应预留约 ${spec.sofaRatio} 的空白空间，不要放置任何家具。`,
    `保持房间的墙面材质、窗户位置、地面材质、光影方向与清场前完全一致。`,
    `严禁在画面中出现沙发、躺椅或任何座具。`,
  ].filter(Boolean).join("\n");
}
```

#### 方案 2：增强视角差异校验

```typescript
// 使用 SSIM (结构相似性指数) 替代简单像素差异
export async function assertDistinctCameraViewsEnhanced(
  masterImageUrl: string,
  variations: string[],
  perspectives: string[]
): Promise<void> {
  if (!variations.length) return;

  const masterImage = await loadImage(masterImageUrl);

  for (let i = 0; i < variations.length; i++) {
    const variationUrl = variations[i];
    const perspective = perspectives[i + 1]; // 跳过 wide
    const variationImage = await loadImage(variationUrl);

    // 1. SSIM 结构相似度检查（阈值 < 0.85 才算不同视角）
    const ssim = calculateSSIM(masterImage, variationImage);
    if (ssim > 0.85) {
      throw new Error(`${perspective}与远景过于相似(SSIM=${ssim.toFixed(2)})，请重新生成真实不同机位。`);
    }

    // 2. 裁切检测：检查是否只是远景的局部裁切
    const cropScales = [0.8, 0.7, 0.6, 0.5, 0.4, 0.35, 0.3];
    for (const scale of cropScales) {
      const cropSSIM = calculateSSIM(masterImage, variationImage, scale);
      if (cropSSIM > 0.90) {
        throw new Error(`${perspective}疑似远景裁切(SSIM=${cropSSIM.toFixed(2)})，请重新生成。`);
      }
    }

    // 3. 沙发面积比检查（如果可用）
    // 中近景沙发面积应 ≥ 远景的 2x，近景应 ≥ 3x
    const expectedMinRatio = perspective === "medium" ? 2.0 : 3.0;
    // 此检查需要产品合成后进行
  }
}

function calculateSSIM(
  img1: HTMLImageElement,
  img2: HTMLImageElement,
  cropScale = 1
): number {
  const size = 128;  // 提高到 128x128 获取更多结构信息
  const data1 = downsample(img1, size, cropScale);
  const data2 = downsample(img2, size);

  // SSIM 计算
  let mu1 = 0, mu2 = 0;
  const n = size * size;
  for (let i = 0; i < data1.length; i += 4) {
    mu1 += (data1[i] + data1[i+1] + data1[i+2]) / 3;
    mu2 += (data2[i] + data2[i+1] + data2[i+2]) / 3;
  }
  mu1 /= n; mu2 /= n;

  let sigma1Sq = 0, sigma2Sq = 0, sigma12 = 0;
  for (let i = 0; i < data1.length; i += 4) {
    const v1 = (data1[i] + data1[i+1] + data1[i+2]) / 3 - mu1;
    const v2 = (data2[i] + data2[i+1] + data2[i+2]) / 3 - mu2;
    sigma1Sq += v1 * v1;
    sigma2Sq += v2 * v2;
    sigma12 += v1 * v2;
  }
  sigma1Sq /= n; sigma2Sq /= n; sigma12 /= n;

  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  return ((2 * mu1 * mu2 + c1) * (2 * sigma12 + c2)) /
         ((mu1*mu1 + mu2*mu2 + c1) * (sigma1Sq + sigma2Sq + c2));
}
```

#### 方案 3：动态产品缩放与透视变换

```typescript
// 基于分析结果动态计算缩放，而非硬编码
function calculateDynamicScale(
  perspective: PerspectiveOption,
  analysis: SceneAnalysis,
  canvasWidth: number,
  productBounds: { width: number; height: number }
): number {
  // 从分析结果中获取沙发在房间中的建议占比
  const planScale = analysis.placementPlan.scale;

  // 基础占比（视角决定）
  const baseRatio = {
    wide: 0.20,    // 远景占画面 20%
    medium: 0.55,  // 中近景占 55%
    close: 0.80    // 近景占 80%
  };

  const targetWidth = canvasWidth * baseRatio[perspective];
  return targetWidth / productBounds.width;
}

// 透视变换：远景添加轻微透视倾斜
function applyPerspectiveTransform(
  ctx: CanvasRenderingContext2D,
  perspective: PerspectiveOption,
  canvasWidth: number,
  canvasHeight: number
): void {
  if (perspective === "wide") {
    // 远景: 轻微俯视效果
    ctx.transform(1, 0.02, -0.01, 0.98, canvasWidth * 0.01, 0);
  } else if (perspective === "medium") {
    // 中近景: 轻微侧角
    ctx.transform(0.98, 0, 0.03, 1, 0, 0);
  }
  // 近景: 无变换，正面展示
}
```

#### 方案 4：可选的 Gemini 二次光影融合

在 Canvas 合成后，可选地使用 Gemini 进行"仅边缘融合"的 inpainting：

```typescript
export async function refineLightingIntegration(
  composedImageUrl: string,
  productReferenceImage: UploadedImage,
  settings: PlacementSettings
): Promise<string> {
  const response = await postGemini<GeminiImageResponse>({
    mode: "generate",
    model: settings.model,
    roomImage: { base64: extractBase64(composedImageUrl), mimeType: "image/png" },
    productReferenceImage,
    settings: { ...settings, perspectives: ["wide"] },
    systemPrompt: [
      "这是一个光影融合微调任务，不是重新生成任务。",
      "第一张图是已合成好的试摆效果图，第二张是原始产品参考图。",
      "请仅微调第一张图中沙发与环境的接触阴影、边缘反光、环境色反射，",
      "使沙发看起来更自然地融入空间。",
      "严禁改变沙发的款式、颜色、材质、轮廓、座位数、扶手、靠背和任何细节。",
      "严禁改变房间的墙面、窗户、家具和布局。",
      "沙发像素必须保持与第二张产品参考图完全一致。"
    ].join("\n"),
    perspectivePrompts: { wide: "输出微调后的融合效果图。" }
  });

  return response.images[0]?.imageUrl || composedImageUrl;
}
```

---

## 四、优先级排序

| 优先级 | 优化项 | 影响范围 | 预计工作量 |
|--------|--------|---------|-----------|
| P0-必须 | 补全3个缺失函数 | 代码无法编译 | 小 |
| P0-必须 | 切换绿幕抠图 | 产品一致性 | 小 |
| P0-必须 | 启用 backgroundOnly 模式 | 产品一致性 | 中 |
| P1-重要 | 增强 composeLockedProduct | 产品真实感 | 中 |
| P1-重要 | 三视角独立背景生成 | 视角质量 | 中 |
| P1-重要 | 增强 SSIM 视角校验 | 视角质量 | 中 |
| P2-优化 | 动态缩放与透视变换 | 视角质量 | 大 |
| P2-优化 | 色彩匹配与光照融合 | 产品真实感 | 大 |
| P3-可选 | Gemini 二次光影融合 | 最终效果 | 中 |

---

## 五、其他发现的问题

### 5.1 图片压缩过度

`compressImage` 默认参数: maxEdge=1200, quality=0.72, targetBytes=420KB。对于产品参考图，420KB 压缩可能导致细节丢失，影响 Gemini 识别产品特征。建议产品参考图使用更高质量（maxEdge=1600, quality=0.85）。

### 5.2 请求体大小限制

`postGemini` 限制请求体 ≤ 3.5MB。当同时发送房间图+沙发图+产品参考图+前景图时容易超限。建议优化图片压缩策略或分步发送。

### 5.3 超时设置

`requestImageInteraction` 设置 75 秒超时。三视角串行生成时，总耗时可能超过 Vercel 的 120 秒函数限制。建议改为并行生成或使用流式响应。

### 5.4 模型选择

当前默认使用 `gemini-3`（映射到 gemini-3.1-flash-image）。建议产品抠图和背景生成使用不同的模型——抠图需要精确分割能力，背景生成需要创意能力。

### 5.5 无重试机制的清场步骤

`eraseExistingSofas` 如果失败会直接中断整个流程。建议增加重试或降级策略（如清场失败时回退到让 Gemini 直接生成完整场景）。
