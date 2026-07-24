import {
  perspectiveLabels,
  sofaPlacementSystemPrompt,
  VIRTUAL_ROOM_STYLE_SPECS,
  virtualRoomStyleLabels,
} from "../constants";
import type { PlacementSettings, SceneAnalysis, SofaIdentity } from "../types";

/** Build human model prompt section — supports adding human models directly in the generation prompt. */
function buildHumanModelPrompt(settings: PlacementSettings): string {
  if (!settings.addHumanModel) {
    return `PERSONA / HUMAN PRESENCE: DO NOT include any human figures, models, or body-shaped decorations in the scene. Provide a pure architectural and furniture visualization. 绝对不要在画面中出现任何人物模型、人体模特或人形装饰。`;
  }

  const genderLabel = {
    any: "a person (性别不限)",
    female: "a woman (女性)",
    male: "a man (男性)",
  }[settings.humanModelGender];
  const ageLabel = {
    adult: "adult (成人)",
    child: "child (儿童)",
    senior: "elderly person (老年)",
  }[settings.humanModelAge];

  return `PERSONA / HUMAN PRESENCE: You MUST include ${genderLabel}, ${ageLabel} sitting naturally on the target sofa. The human figure must seamlessly blend into the scene and interact naturally with the lighting and environment. Clothing, hairstyle, posture, temperament and colors must match the room's existing style, lighting and ambiance — no studio-shoot feel or advertising look. The model must ONLY sit on the target sofa, not on other furniture, not standing, not lying down. The model must NOT overly obscure the sofa's key product details — at least the armrest, backrest, cushion partition, main material texture, and overall silhouette must remain clearly visible. 必须包含一位${genderLabel}、${ageLabel}的人体模特自然坐在目标沙发上，服装气质与房间风格一致，不得过度遮挡沙发关键产品细节。`;
}

/** Build product identity prompt — the core product preservation section following the floor lamp project's approach.
 *  This forces Gemini to replicate the exact product by describing every dimension. */
export function buildProductIdentityPrompt(analysis: SceneAnalysis): string {
  const identity = analysis.sofaIdentity;
  const identityJson = JSON.stringify(identity, null, 2);

  return `CRITICAL DIRECT VISUAL REPLICATION OF THE SOFA PRODUCT REFERENCE IMAGE (最核心约束 - 必须和用户上传/选择的沙发产品参考图完全一致):
  - Look directly at the attached reference sofa product image.
  - The generated sofa MUST BE AN EXACT 1:1 VISUAL REPLICA of the sofa in the reference image in every single dimension:
    * EXACT Silhouette & Shape: Same overall outline, module combination, sectional direction, L-shape/straight/curved form as shown in the reference image.
    * EXACT Seat Count & Partition: Same number of seats, same cushion partition layout, same seat width proportions.
    * EXACT Armrest: Same armrest shape (rolled/flat/square/angular/curved), same armrest height relative to seat, same armrest material as in the reference image.
    * EXACT Backrest: Same backrest height, same backrest shape (high/medium/low/wingback/tufted/flat), same backrest soft-pack style as in the reference image.
    * EXACT Cushions: Same cushion count, same cushion pattern (tight/welted/box/loose), same cushion stitching details as in the reference image.
    * EXACT Color: Same primary color tone, same color depth, same color warmth/coolness, same multi-color pattern if applicable.
    * EXACT Material: Same visible material texture (leather grain/fabric weave/suede nap/velvet sheen/linen texture) as in the reference image.
    * EXACT Legs/Base: Same leg style (visible wooden legs/metal legs/concealed base/skirted base), same leg color and shape as in the reference image.
    * EXACT Decorative Details: Same visible buttons/tufting/stitching patterns/embroidery/pillow styles/trim details as in the reference image. ZERO HALLUCINATIONS — DO NOT add buttons, stitching, embroidery, or trim that is NOT visible in the reference image!
    * ZERO PRODUCT MODIFICATIONS: DO NOT change the sofa's color, material, structure, shape, or any visible detail. DO NOT substitute a similar-looking sofa. The generated sofa must be EXACTLY the same product as the reference image.
  - If there is any discrepancy between text descriptions and the reference image, THE REFERENCE IMAGE IS THE ABSOLUTE TRUTH AND MUST BE REPLICATED EXACTLY. Any visual deviation from the reference image is a critical failure!

  SOFA IDENTITY ANALYSIS (for reference — but the reference image above is the absolute truth):
${identityJson}`;
}

/** Camera instruction for each perspective type — extremely specific, like the floor lamp project. */
const CAMERA_INSTRUCTIONS: Record<string, { guidance: string; perspective: string }> = {
  wide: {
    guidance: `CENTERED SOFA IN LOCALIZED ROOM VIEW (远景视角 - 房间全景且沙发自然居中):
   - MAIN SUBJECT: The target sofa MUST be clearly visible and naturally positioned in the room. It should occupy approximately 15% to 28% of the image area, shown as part of the overall space.
   - FULL ROOM CONTEXT: The camera frames the main living room area from an entry or corner viewpoint at approximately 1.5-1.7m eye height. Show the complete room architecture: floor, ceiling, walls, windows, doors, and major furniture layout.
   - SPATIAL RELATIONSHIP: The viewer must be able to see the sofa's relationship with other furniture, the room layout, and walking paths. The sofa must NOT float or look pasted on.
   - PERSPECTIVE CONSISTENCY: All room elements must have consistent perspective lines converging naturally. The sofa must follow the same perspective grid.`,
    perspective: `VIEW AND PERSPECTIVE (FAR WIDE VIEW / 远景全景视角): The camera is positioned at the room entry or corner at normal eye height (1.5-1.7m). The entire room layout is visible — walls, floor, ceiling, windows, doors, major furniture. The target sofa is clearly visible as part of the complete spatial composition, occupying 15-28% of the image area. NEVER show just a blank wall or ceiling — this must be a complete room photograph.`
  },
  medium: {
    guidance: `SOFA-DOMINANT MID-RANGE VIEW (中近景视角 - 沙发主体居中):
   - MAIN SUBJECT: The target sofa MUST dominate the image, occupying approximately 45% to 65% of the frame. The sofa must be perfectly CENTERED as the absolute main subject.
   - LOCALIZED BACKGROUND: The background must be a tightly framed section of the room adjacent to the sofa — partial wall, side table, rug, coffee table, window fragment. DO NOT show the entire room.
   - DETAIL BALANCE: The viewer must see the sofa's complete main silhouette, armrests, backrest, and cushion layout clearly, while still having enough room context to feel the real spatial environment.
   - CAMERA POSITION: The camera moves forward from the wide-view position to approximately 2-3 meters from the sofa, at approximately 1.2-1.4m height, with a slight 15-20 degree side angle creating visible parallax difference from the wide view.`,
    perspective: `VIEW AND PERSPECTIVE (MID-RANGE VIEW / 中近景视角): The camera is positioned approximately 2-3 meters from the sofa at slightly above sofa-backrest height (1.2-1.4m), with a gentle 15-20 degree side offset. The sofa occupies 45-65% of the frame as the dominant subject. Only the sofa's immediate surroundings — partial wall, coffee table, rug, side window — are visible as localized context. MUST crop out far-end room elements, ceiling, and peripheral furniture visible in the wide view.`
  },
  close: {
    guidance: `AUTHENTIC MACRO PRODUCT CLOSE-UP (近景特写视角 - 产品细节居中):
   - MAIN SUBJECT: The target sofa MUST be perfectly CENTERED and dominate the foreground, occupying approximately 75% to 85% of the frame.
   - CROP LEVEL: Only the sofa's key product details must be visible — armrest curves, backrest shape, cushion partition lines, material texture, stitching details, sofa legs, and decorative elements (buttons, embroidery, trim). Far-end room space is mostly invisible.
   - TRUE ENVIRONMENTAL INTEGRATION: The sofa MUST NOT look like it was simply enlarged and pasted over the room. It must be deeply integrated into the environment. Only a small slice of the floor or wall is visible as environmental context.
   - TEXTURE & MATERIAL FOCUS: The viewer must be able to see and judge the material quality — leather grain, fabric weave, velvet sheen, cushion softness, stitching precision. This is a product detail shot, not just a cropped wide view.`,
    perspective: `VIEW AND PERSPECTIVE (MACRO CLOSE-UP VIEW / 真实近景特写视角): The camera is very close to the sofa, approximately 0.8-1.2 meters away, at sofa-armrest height. A highly realistic, aesthetically pleasing macro product shot. The sofa occupies 75-85% of the frame. The background showcases a small, beautifully framed real corner of the room (like a fragment of floor, a piece of rug, or a sliver of wall) rather than the full room or a blank surface. The sofa must NOT look like a cutout paste-up — it must be deeply integrated into the environment.`
  }
};

/** Build the main generation prompt for real-room placement mode.
 *  Following the floor lamp project's approach: extremely detailed product preservation + perspective control. */
export function buildGenerationPrompt(
  analysis: SceneAnalysis,
  settings: PlacementSettings,
  perspective: string,
  extraContext = "",
  extraPrompt: string[] = [],
): string {
  const camera = CAMERA_INSTRUCTIONS[perspective] || CAMERA_INSTRUCTIONS.medium;
  const positionLabel = "未指定位置：请根据房间尺度、通行动线、主要视觉焦点、采光和透视关系，自动选择最自然、最合理且不遮挡通道的位置与朝向。";

  const qualityPrompt = settings.clarity === "4K"
    ? "IMAGE QUALITY & RESOLUTION: Render at ultra-high 4K resolution with hyper-fine textures, extreme edge sharpness, and studio master photographic clarity."
    : settings.clarity === "2K"
    ? "IMAGE QUALITY & RESOLUTION: Render at high-definition 2K resolution with crisp details and clean clarity."
    : "IMAGE QUALITY & RESOLUTION: Render at standard clean 1K resolution.";

  return [
    `A professional, ultra-high-resolution interior design photograph.`,
    `Your task is to generate a new room scene by placing the provided target sofa into the uploaded room environment.`,
    sofaPlacementSystemPrompt,
    `IMAGE INPUT ORDER: IMAGE 1 is the reference room environment. IMAGE 2 is the EXACT reference sofa product image that MUST be replicated 100%.`,
    buildProductIdentityPrompt(analysis),

    `CRITICAL ROOM ARCHITECTURE, WALLS, WINDOWS & FURNITURE FAITHFULNESS (房间墙面、窗户与家具严禁随意篡改与幻觉):`,
    `- ABSOLUTE ROOM FIDELITY: You MUST PRESERVE the exact architectural structure, wall finishes (wallpapers, wood paneling, stone, paint color, plaster textures), window locations, and existing furniture from the room image.`,
    `- NO HALLUCINATED WINDOWS OR WALLS: If the room image does NOT have a window on a wall, DO NOT add a window! If the room has dark wood wall panels, KEEP the exact same dark wood panels! DO NOT change the wall material or color!`,
    `- NO UNREQUESTED FURNITURE: DO NOT introduce random new cabinets, tables, chairs, or shelves that do not exist in the room image. The furniture present in the generated image MUST strictly match the room image.`,
    `- PERSPECTIVE CONSISTENCY: The underlying room elements (background wall, curtains, floor, furniture) MUST remain faithful to the room image without arbitrary changes.`,

    `PLACEMENT POSITION: ${positionLabel}`,
    `PLACEMENT PLAN (confirmed, must execute unless conflicting with higher-priority user requirements): ${JSON.stringify(analysis.placementPlan)}`,

    camera.guidance,
    camera.perspective,

    `FOCUS & DEPTH OF FIELD: ${perspective === "close"
      ? "The sofa's armrest, cushion texture, stitching, and material grain must be in crisp, razor-sharp focus in the foreground, with the authentic partial room background softly rendering behind it with natural macro photography depth of field."
      : "You MUST keep the ENTIRE photograph (sofa, background wall, adjacent furniture, floor, curtains) completely sharp and clear in deep focus. DO NOT apply unnatural bokeh blur or heavy portrait-style background blur."}`,

    qualityPrompt,

    buildHumanModelPrompt(settings),

    settings.notes
      ? `USER EXPLICIT REQUIREMENTS (最高优先级，必须逐项执行): ${settings.notes}`
      : "User has no additional requirements. Choose the most natural placement yourself.",
    extraContext ? `平台传入上下文: ${extraContext}` : "",
    extraPrompt.length ? `平台补充关键词: ${extraPrompt.join("、")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Build camera variation prompt for generating mid/close perspectives as independent scenes.
 *  Following the floor lamp project's approach — each perspective is independent, not derived from a master. */
export function buildCameraVariationPrompt(
  analysis: SceneAnalysis,
  settings: PlacementSettings,
  perspective: string,
  extraContext = "",
  extraPrompt: string[] = [],
): string {
  // Same as buildGenerationPrompt — each perspective is independently generated
  // The "variation" naming is kept for API compatibility but the logic is the same
  return buildGenerationPrompt(analysis, settings, perspective, extraContext, extraPrompt);
}

/** Build virtual room generation prompt.
 *  Following the floor lamp project's approach with detailed STYLE_SPECS. */
export function buildVirtualRoomPrompt(
  analysis: SceneAnalysis,
  settings: PlacementSettings,
  perspective: string,
  extraContext = "",
  extraPrompt: string[] = [],
): string {
  const styleLabel = virtualRoomStyleLabels[settings.virtualRoomStyle];
  const styleSpec = VIRTUAL_ROOM_STYLE_SPECS[settings.virtualRoomStyle];
  const camera = CAMERA_INSTRUCTIONS[perspective] || CAMERA_INSTRUCTIONS.medium;

  const qualityPrompt = settings.clarity === "4K"
    ? "IMAGE QUALITY & RESOLUTION: Render at ultra-high 4K resolution with hyper-fine textures, extreme edge sharpness, and studio master photographic clarity."
    : settings.clarity === "2K"
    ? "IMAGE QUALITY & RESOLUTION: Render at high-definition 2K resolution with crisp details and clean clarity."
    : "IMAGE QUALITY & RESOLUTION: Render at standard clean 1K resolution.";

  return [
    `A professional, ultra-high-resolution interior design photograph.`,
    `Your task is to generate a virtual room and naturally place the provided target sofa into it.`,
    sofaPlacementSystemPrompt,

    `IMAGE INPUT: The attached image is the EXACT reference sofa product image that MUST be replicated 100%. There is NO uploaded room image — you must generate the virtual room yourself.`,
    buildProductIdentityPrompt(analysis),

    `CRITICAL VIRTUAL ROOM STYLE MATCHING (虚拟房间风格必须严格匹配):`,
    `You MUST strictly generate the room according to the textual design specifications below to perfectly capture the essence of "${styleLabel}". 必须严格按照以下设计规范和文字描述生成极致完美的【${styleLabel}】风格样板间，完全符合对应的颜色、家具和布局设定，切记不要偏离指定的风格！`,
    `DESIGN SPECIFICATION FOR THIS STYLE:`,
    styleSpec,

    `VIRTUAL ROOM REQUIREMENTS:`,
    `- Generate a high-end villa living room or large flat living room with complete space, real scale, and unified soft-furnish style.`,
    `- DO NOT generate showroom white backgrounds, studio shots, product posters, or pure background images.`,
    `- The sofa must naturally sit in the living room conversation area with correct ground contact, shadows, reflections, perspective, and ambient lighting.`,
    `- You may add coffee table, rug, lamps, curtains, wall art, plants and other matching elements according to the style, but they must NOT obscure the sofa's main body.`,

    camera.guidance,
    camera.perspective,

    `FOCUS & DEPTH OF FIELD: ${perspective === "close"
      ? "The sofa's armrest, cushion texture, stitching, and material grain must be in crisp, razor-sharp focus in the foreground, with the authentic partial room background softly rendering behind it with natural macro photography depth of field."
      : "You MUST keep the ENTIRE photograph completely sharp and clear in deep focus. DO NOT apply unnatural bokeh blur."}`,

    qualityPrompt,

    buildHumanModelPrompt(settings),

    `PLACEMENT PLAN (confirmed): ${JSON.stringify(analysis.placementPlan)}`,

    `MULTI-VIEW CONSISTENCY RULES:`,
    `1. The same sofa must appear with EXACTLY identical style, color, material, and details in all perspectives.`,
    `2. The sofa's placement position and orientation must be consistent across perspectives, following real camera movement rules.`,
    `3. Lighting direction and intensity must remain consistent; shadow shapes and positions must reflect the new perspective's spatial changes.`,
    `4. Mid-range and close-up views MUST NOT be just cropped or scaled versions of the wide view. They must represent genuine camera displacement, distance change, and compositional focus shift.`,

    settings.notes
      ? `USER EXPLICIT REQUIREMENTS (最高优先级): ${settings.notes}`
      : "User has no additional requirements. Complete a harmonious space arrangement yourself.",
    extraContext ? `平台传入上下文: ${extraContext}` : "",
    extraPrompt.length ? `平台补充关键词: ${extraPrompt.join("、")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Build analysis prompt — keeps the existing JSON structure analysis approach. */
export function buildAnalysisPrompt(
  extraContext = "",
  extraPrompt: string[] = [],
  userRequirements = "",
): string {
  return [
    sofaPlacementSystemPrompt,
    "输入图片顺序为：第一张是房间主图；如有后续房间图，它们是同一空间的补充角度；最后一张是沙发参考图。请综合所有房间角度分析空间，再识别沙发，返回严格 JSON，不要输出 Markdown。",
    "JSON 字段必须严格为：roomSummary, sofaSummary, sofaIdentity, lighting, perspective, placementAdvice, constraints, placementPlan。sofaIdentity 必须是对象，字段严格为 seatCount, silhouette, armrest, backrest, cushions, material, color, details；前七项为中文字符串，details 为中文字符串数组。",
    "placementPlan 必须是对象，字段严格为：summary, placement, facing, scale, preserve, remove, avoid, rationale, candidates, selectedCandidateId。其中 summary、placement、facing、scale 为中文字符串；preserve、remove、avoid、rationale 为中文字符串数组。",
    "candidates 必须包含 2 到 3 个候选摆位对象。每个对象字段严格为：id, label, placement, facing, scale, score, reasons, blocksWalkway, conflictsWithPreservedItems, violatesUserRequirements。score 为 0 到 1 的数字；reasons 为字符串数组；后三项为布尔值。明确标记会阻塞通道、碰撞需保留家具或违背用户要求的候选方案。selectedCandidateId 填写最推荐且不违反硬约束的候选 id。",
    "用户要求优先级最高。请把用户明确提出的摆放、朝向、保留、覆盖、移除、通道、视角等要求写入 placementPlan；未明确时才根据空间自行判断。",
    userRequirements
      ? `用户当前要求（最高优先级）：${userRequirements}`
      : "用户尚未给出额外要求，请依据空间自然规划。",
    extraContext ? `平台传入上下文：${extraContext}` : "",
    extraPrompt.length ? `平台补充关键词：${extraPrompt.join("、")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Build quality check prompt — checks product consistency and overall quality. */
export function buildQualityPrompt(
  analysis: SceneAnalysis,
  settings: PlacementSettings,
  extraContext = "",
  extraPrompt: string[] = [],
): string {
  return [
    "你是室内软装试摆结果质检员。输入依次为房间原图、目标沙发图、生成结果图。",
    "【产品一致性专项检查】",
    "请逐项对比生成结果中的沙发与目标沙发参考图：",
    "1. 整体轮廓检查：沙发的整体形状、模块组合方式、贵妃位方向是否一致？",
    "2. 座位数量检查：座位数量是否与参考图一致？",
    "3. 扶手检查：扶手的形状、高度、材质是否一致？",
    "4. 靠背检查：靠背的高度、形状、软包方式是否一致？",
    "5. 坐垫检查：坐垫的数量、分区方式、缝线图案是否一致？",
    "6. 颜色检查：沙发的主色调、颜色层次是否一致？",
    "7. 材质检查：沙发的材质纹理（真皮/布艺/实木等）是否一致？",
    "8. 细节检查：沙发脚、拉扣、刺绣、抱枕等装饰元素是否一致？",
    "9. 尺寸比例检查：沙发的各部分比例是否与参考图一致？",
    "【整体质量检查】",
    "请核对生成结果是否真正放入了目标沙发，并且符合已确认的试摆计划与用户最高优先级要求。检查：是否仍是原图、沙发是否为相似款或原沙发改色冒充、位置/朝向是否违背计划、是否错误移除了需保留物、是否遮挡通道或关键结构、透视尺度光影是否明显失真。",
    settings.addHumanModel
      ? "用户已要求添加人体模特：请检查结果中是否有一位符合选项的人体模特自然坐在目标沙发上，人物是否与空间光影尺度一致，是否过度遮挡沙发关键细节。"
      : "用户未要求添加人体模特：结果中不得出现人物或人体模特。",
    `目标沙发识别信息：${JSON.stringify(analysis.sofaIdentity)}`,
    "只返回严格 JSON：passed（布尔值）, issues（中文字符串数组）, correctionPrompt（中文字符串）。若通过，issues 返回空数组，correctionPrompt 为空字符串；若不通过，correctionPrompt 要给出可直接用于下一次图像编辑的具体纠正要求，必须明确指出需要修正的具体方面。",
    `已确认试摆计划：${JSON.stringify(analysis.placementPlan)}`,
    settings.notes
      ? `用户当前要求（最高优先级）：${settings.notes}`
      : "用户没有额外要求。",
    extraContext ? `平台传入上下文：${extraContext}` : "",
    extraPrompt.length ? `平台补充关键词：${extraPrompt.join("；")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
