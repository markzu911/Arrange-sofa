import {
  perspectiveLabels,
  VIRTUAL_ROOM_STYLE_SPECS,
  virtualRoomStyleLabels,
} from "../constants";
import type { PlacementSettings, SceneAnalysis } from "../types";

/** Build human model prompt section. */
function buildHumanModelPrompt(settings: PlacementSettings, perspective: string): string {
  if (perspective === "close") {
    return `5. PERSONA / HUMAN PRESENCE: DO NOT include any person or human body part in this close-up product view. 近景产品特写禁止出现人物或人体局部。`;
  }

  if (!settings.addHumanModel) {
    return `5. PERSONA / HUMAN PRESENCE: DO NOT include any human figures, models, or body-shaped decorations. 绝对不要出现人物。`;
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

  return `5. PERSONA / HUMAN PRESENCE: Include ${genderLabel}, ${ageLabel} sitting naturally on the target sofa. Clothing and posture must match the room's style. The model must NOT obscure the sofa's key details — armrest, backrest, cushion, material, and silhouette must remain clearly visible. 必须包含一个自然坐在沙发上的${ageLabel}${genderLabel}，但不遮挡沙发主体特征。`;
}

/** Build product identity prompt with the uploaded product image as the only source of truth. */
export function buildProductIdentityPrompt(analysis: SceneAnalysis): string {
  const identity = analysis.sofaIdentity;
  const structureAnchor = identity.structure || "以参考图为准";

  return `HIGHEST PRIORITY CONSTRAINTS (MUST BE STRICTLY FOLLOWED):

ABSOLUTE PRIORITY ORDER: PRODUCT FIDELITY > PHYSICAL PLACEMENT > CAMERA COMPOSITION > ROOM / STYLE / DECORATION.
If any lower-priority instruction would change the sofa, relax that lower-priority instruction instead. 产品一致性高于构图、环境、风格和其他全部要求。

1. IMAGE 2 IS THE SOLE PRODUCT TRUTH (产品图是唯一事实来源):
   Reproduce the exact same sofa shown in IMAGE 2, not a similar sofa and not a style-matched substitute.
   Preserve every clearly visible component exactly as shown, including overall silhouette, module and seat count, proportions, armrests, backrests, cushion segmentation, visible seams and surface details, material, color, legs, accessories, and asymmetry.
   Never add, remove, merge, split, redesign, restyle, or reinterpret any sofa component. 不能因为房间、风格或构图改变产品。

2. TEXT IS SECONDARY (文字分析只作辅助):
   The analysis below may be used only when it agrees with details clearly visible in IMAGE 2. Ignore any uncertain, missing, or conflicting textual detail. Never invent a product feature from text alone.
   Secondary structure hint: ${structureAnchor}

3. PHYSICAL INTEGRITY:
   REALISTIC SCALE & PROPORTION: The sofa must maintain realistic scale relative to the room. It MUST NOT be unnaturally oversized or undersized.
   Keep the exact connected or modular relationships visible in IMAGE 2. The base must rest naturally on the floor.

4. ROOM IS SECONDARY:
   If IMAGE 1 is provided, preserve its overall room identity, major architecture, perspective, and lighting approximately. Minor differences in decoration or background furniture are acceptable. Never alter the sofa to make the room easier to reproduce.`;
}

/** Camera instructions for each perspective:
 *  - wide: complete sofa with substantial room context
 *  - medium: product dominates frame, only immediate context visible
 *  - close: macro product detail shot, fundamentally different from spatial views */
const CAMERA_INSTRUCTIONS: Record<string, { guidance: string; perspective: string }> = {
  wide: {
    guidance: `=== CAMERA: WIDE ROOM VIEW (远景 - 完整沙发 + 大部分环境) ===
- The sofa MUST be the absolute main subject, positioned perfectly CENTERED in the frame. 沙发必须是画面绝对主体且居中。
- Show the complete exact sofa plus a substantial portion of the room environment.
- Sofa occupies about 40-55% of the frame. Preserve the product unchanged even if framing or room details need adjustment.
- Keep the room broadly consistent with IMAGE 1; exact reproduction of minor furniture and decoration is not required.`,
    perspective: `VIEW: Wide interior placement photograph with the complete sofa centered and clearly readable as the main subject. Show enough surrounding room to understand placement, while allocating visual attention and detail to the exact product.`
  },
  medium: {
    guidance: `=== CAMERA: PRODUCT-DOMINANT MID-VIEW (中近景 — 沙发主体特写) ===
- Sofa occupies 60-75% of the frame, perfectly CENTERED as the dominant subject. 沙发占据画面60-75%，必须是主导主体。
- Camera at 2m distance, 1.2m height, slight 15° side offset for visible parallax.
- Background: tightly cropped — only the sofa's immediate surface context (edge of coffee table, sliver of rug). Far-end room elements MUST be cropped out.
- This MUST look fundamentally different from the wide view — closer camera, tighter framing, sofa visibly larger.`,
    perspective: `VIEW: Product-dominant shot. Sofa fills most of the frame. Only immediate surface-level room context visible. MUST NOT look like a zoomed-in version of the wide view — it must represent genuine camera displacement with tighter framing.`
  },
  close: {
    guidance: `=== CAMERA: EXTREME LOCAL PRODUCT CLOSE-UP (近景 — 沙发局部特写) ===
- Move the camera physically close to the sofa at 0.6-1.0m distance. This must be a newly generated close camera position, not a crop or digital zoom of another view.
- Show ONLY one representative local area automatically selected from IMAGE 2, such as an armrest, fabric surface, cushion edge, backrest detail, or module connection.
- Do NOT show the complete sofa. Most of the sofa must extend naturally beyond the frame. 只展示沙发局部，完整沙发不需要入镜。
- The visible sofa detail occupies 75-90% of the frame. Keep only minimal room context in the background.`,
    perspective: `VIEW: Genuine close-range product detail photograph of one selected sofa area. Preserve the visible local shape, material, color, and construction exactly as shown in IMAGE 2; do not reconstruct or summarize the complete sofa.`
  }
};

/** Build the main generation prompt for real-room placement mode.
 *  Following the floor lamp project's structure: bilingual constraints, `structure` textual anchor,
 *  NO room analysis JSON block (Gemini can see the room image), NO placement JSON block. */
export function buildGenerationPrompt(
  analysis: SceneAnalysis,
  settings: PlacementSettings,
  perspective: string,
  extraContext = "",
  extraPrompt: string[] = [],
): string {
  const camera = CAMERA_INSTRUCTIONS[perspective] || CAMERA_INSTRUCTIONS.medium;
  const positionLabel = "未指定位置：请根据房间尺度和动线自动选择最自然的位置与朝向。";

  return [
    `A professional, ultra-high-resolution interior design photograph.
Your task is to naturally place the target sofa into the room and generate a photorealistic interior photograph.`,
    buildProductIdentityPrompt(analysis),
    `=== PLACEMENT ===
Position: ${positionLabel}
Advice: ${analysis.placementAdvice}`,
    camera.guidance,
    camera.perspective,
    perspective === "close"
      ? `6. FOCUS & DEPTH OF FIELD (对焦与视觉质感): Use natural shallow depth of field. Keep the selected local product detail crisp and sharp while the remaining sofa and minimal room background fall naturally out of focus. Do not invent stitching, trim, texture, or construction details. 近景焦点局部锐利，其余自然虚化，严禁补造细节。`
      : `6. FOCUS & DEPTH OF FIELD (对焦与视觉质感): You MUST keep the ENTIRE photograph (sofa, background wall, adjacent furniture, floor) completely sharp and clear in deep focus. DO NOT apply unnatural bokeh blur. 全景深清晰对焦，不要虚化背景。`,
    buildHumanModelPrompt(settings, perspective),
    settings.notes
      ? `=== USER REQUIREMENTS (仅在不影响产品一致性时执行) ===\n${settings.notes}`
      : "",
    extraContext ? `平台上下文: ${extraContext}` : "",
    extraPrompt.length ? `平台关键词: ${extraPrompt.join("、")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Build virtual room generation prompt — following the floor lamp project's STYLE_SPECS approach. */
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

  const roomStylePrompt = `SECONDARY ROOM STYLE GUIDANCE: Apply the following "${styleLabel}" specification only to the room architecture, lighting, palette, and non-sofa decoration.
IGNORE every sofa, seating, upholstery, cushion, throw, product material, product color, or product shape example contained in the style specification. IMAGE 2 replaces all sofa examples and must remain completely unchanged. 风格只作用于环境，所有涉及沙发的风格描述一律忽略。

DESIGN SPECIFICATION FOR THIS STYLE:
${styleSpec}`;

  return [
    `A professional, ultra-high-resolution interior design photograph.
Your task is to generate a virtual room and place the target sofa into it.`,
    buildProductIdentityPrompt(analysis),
    roomStylePrompt,
    camera.guidance,
    camera.perspective,
    perspective === "close"
      ? `6. FOCUS: Natural shallow depth of field with the selected local sofa detail sharp and the remaining sofa and room softly out of focus. 近景局部锐利，其余自然虚化。`
      : `6. FOCUS: Entire photograph in deep focus. 全景深清晰对焦。`,
    buildHumanModelPrompt(settings, perspective),
    `=== PLACEMENT ===
${analysis.placementAdvice}`,
    settings.notes
      ? `=== USER REQUIREMENTS (apply only when consistent with product fidelity) ===\n${settings.notes}`
      : "",
    extraContext ? `平台上下文: ${extraContext}` : "",
    extraPrompt.length ? `平台关键词: ${extraPrompt.join("、")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Build analysis prompt — following the floor lamp project's approach:
 *  Demand exhaustive component analysis with Chinese descriptions.
 *  CRITICAL: The `structure` field is the PRIMARY textual anchor for product fidelity.
 *  It must contain BOTH positive identification AND negative exclusion. */
export function buildAnalysisPrompt(
  extraContext = "",
  extraPrompt: string[] = [],
  userRequirements = "",
): string {
  return [
    "You are an expert interior design and product analysis assistant. VERY IMPORTANT: You MUST reply in Chinese (简体中文) for all string values.",
    "CRITICAL INSTRUCTIONS FOR FULL SOFA COMPONENT ANALYSIS (全部件无遗漏全面细节深度解析):",
    "You MUST inspect and describe EVERY SINGLE visible physical component of the sofa in IMAGE 2 with maximum detail and precision. Do NOT omit anything:",
    "0. 整体结构描述 (structure) — MOST IMPORTANT: A comprehensive Chinese sentence describing ALL physical components from top to bottom, AND explicitly stating what is NOT present. Format: '包含：[all visible parts described in order]. 严禁增加：[elements NOT in the reference, e.g. 拉扣/铆钉、金属腿、额外抱枕、L型转角、任何参考图中不存在的设计元素].'",
    "1. 座位数量 (seatCount): Exact number of seat positions. Must be a specific number, e.g. '三人位' or '两人位'.",
    "2. 整体轮廓 (silhouette): Detailed description of overall shape — is it L-shaped, straight, curved? Low-profile or high-back? Compact or generous?",
    "3. 扶手 (armrest): Shape (rounded, square, tapered, roll-arm), height relative to seat, material visible on armrest. IF no visible armrest, state '无明显扶手'.",
    "4. 靠背 (backrest): Height (low/medium/high), shape (straight, curved, wingback), material and texture visible.",
    "5. 坐垫 (cushions): Number of individual cushions, partition pattern (visible seams between cushions), firmness impression.",
    "6. 主材质 (material): Exact material name — e.g. 棉麻混纺, 纳帕牛皮, 科技布, 绒布. NOT generic terms like '布艺'.",
    "7. 主色调 (color): Precise color description — e.g. 深灰色, 米白色, 暖棕色, 墨绿色. NOT generic terms like '灰色'.",
    "8. 全部可见细节 (details): Exhaustive list of ALL visible details — stitching patterns, tufting/buckle (IF present; state '无拉扣设计' if NOT), sofa legs (material & shape; state '无可见沙发脚' if hidden), decorative piping, visible zippers, buttons, embroidery, metal accents, etc. EXPLICITLY state what is NOT present!",
    "",
    "Your PRIMARY task is to accurately identify and describe the sofa in IMAGE 2. Room analysis is secondary context.",
    "Return strict JSON matching this schema (no Markdown code blocks):",
    "roomSummary: brief room description in Chinese",
    "sofaSummary: detailed sofa appearance description in Chinese",
    "sofaIdentity: { structure, seatCount, silhouette, armrest, backrest, cushions, material, color, details[] } — ALL fields must be PRECISE, SPECIFIC, and in Chinese. The `structure` field is the MOST IMPORTANT and must contain BOTH positive description AND negative exclusion. NO generic defaults like '以参考图为准'.",
    "lighting: main light direction in Chinese",
    "perspective: room depth description in Chinese",
    "placementAdvice: best placement suggestion in Chinese",
    "constraints: Chinese string array of constraints",
    "placementPlan: { summary, placement, facing, scale, preserve[], remove[], avoid[], rationale[], candidates[{id, label, placement, facing, scale, score, reasons[], blocksWalkway, conflictsWithPreservedItems, violatesUserRequirements}], selectedCandidateId }",
    userRequirements
      ? `USER REQUIREMENTS (highest priority): ${userRequirements}`
      : "",
    extraContext ? `平台上下文: ${extraContext}` : "",
    extraPrompt.length ? `平台关键词: ${extraPrompt.join("、")}` : "",
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
    "1. 整体轮廓：沙发的整体形状、模块组合方式是否一致？",
    "2. 座位数量：座位数量是否一致？",
    "3. 扶手/靠背：形状、高度、材质是否一致？",
    "4. 坐垫：数量、分区方式、缝线图案是否一致？",
    "5. 颜色/材质：主色调、材质纹理是否一致？",
    "6. 细节：沙发脚、拉扣、刺绣等是否一致？",
    "【整体质量检查】",
    "核对生成结果是否真正放入了目标沙发，位置/朝向是否违背计划，透视尺度光影是否失真。",
    settings.addHumanModel
      ? "用户要求添加人体模特：检查是否符合选项且不过度遮挡沙发。"
      : "未要求人体模特：结果中不得出现人物。",
    `目标沙发识别：${JSON.stringify(analysis.sofaIdentity)}`,
    `已确认试摆计划：${JSON.stringify(analysis.placementPlan)}`,
    "返回严格 JSON：passed (布尔值), issues (中文字符串数组), correctionPrompt (中文字符串)。通过时 issues 为空数组、correctionPrompt 为空字符串。",
    settings.notes ? `用户要求：${settings.notes}` : "",
    extraContext ? `平台上下文: ${extraContext}` : "",
    extraPrompt.length ? `平台关键词: ${extraPrompt.join("；")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
