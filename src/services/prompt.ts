import {
  perspectiveLabels,
  VIRTUAL_ROOM_STYLE_SPECS,
  virtualRoomStyleLabels,
} from "../constants";
import type { PlacementSettings, SceneAnalysis, SofaIdentity } from "../types";

/** Build human model prompt section. */
function buildHumanModelPrompt(settings: PlacementSettings): string {
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

/** Build product identity prompt — following the floor lamp project's approach exactly:
 *  Use the `structure` field as the PRIMARY textual anchor, which contains both
 *  positive identification (what IS present) AND negative exclusion (what is NOT present).
 *  This is how the floor lamp project uses `lampAnalysis.structure`. */
export function buildProductIdentityPrompt(analysis: SceneAnalysis): string {
  const identity = analysis.sofaIdentity;
  const structureAnchor = identity.structure || "以参考图为准";

  return `HIGHEST PRIORITY CONSTRAINTS (MUST BE STRICTLY FOLLOWED):

1. NO UNREQUESTED OR HALLUCINATED SOFA PARTS (严禁出现沙发原本没有的任何部件 - 绝对精细100%还原):
   You MUST reproduce ONLY the exact physical parts visible in the reference sofa image (IMAGE 2) and described in the sofa analysis structure: ${structureAnchor}
   STRICTLY FORBIDDEN: Do NOT add buttons, stitching patterns, trim, extra cushions, decorative pillows, structural changes, or any detail NOT visible in IMAGE 2. Any added detail is a CRITICAL FAILURE.
   严禁增加任何参考图中不存在的设计元素！

2. ABSOLUTE SOFA FAITHFULNESS & STRUCTURAL INTEGRITY (100%还原沙发整体结构与颜色):
   You MUST completely and exactly reproduce the sofa's original appearance, colors, materials, structure, and shape from IMAGE 2. 严禁任何视觉偏差！
   REALISTIC SCALE & PROPORTION: The sofa must maintain realistic scale relative to the room. It MUST NOT be unnaturally oversized or undersized.
   PHYSICAL INTEGRITY: The sofa is ONE SINGLE connected physical object. The base MUST rest firmly on the floor.

3. REFERENCE IMAGE IS ABSOLUTE TRUTH — If text descriptions conflict with IMAGE 2, IMAGE 2 wins. The product in the result must be the SAME product, not a similar-looking substitute. 参考图是绝对真理，任何文字描述与图片冲突时以图片为准。

4. ROOM LAYOUT CONSISTENCY — Keep the exact room architecture, walls, windows, and existing furniture from IMAGE 1. Do NOT add windows, walls, or furniture that do not exist. 严禁增加原图不存在的窗户、墙面或家具。

THE SOFA TO INTEGRATE (PRODUCT ANALYSIS RESULTS — these must be EXACTLY reproduced):
${JSON.stringify(identity, null, 2)}`;
}

/** Camera instructions for each perspective — following floor lamp project's approach:
 *  - wide: LOCALIZED corner view (NOT full room), product centered
 *  - medium: product dominates frame, only immediate context visible
 *  - close: macro product detail shot, fundamentally different from spatial views */
const CAMERA_INSTRUCTIONS: Record<string, { guidance: string; perspective: string }> = {
  wide: {
    guidance: `=== CAMERA: WIDE ROOM VIEW (远景 - 完整沙发 + 大部分环境) ===
- The sofa MUST be the absolute main subject, positioned perfectly CENTERED in the frame. 沙发必须是画面绝对主体且居中。
- Show the complete sofa and a large portion of the surrounding room environment.
- The camera should be pulled back enough to reveal the sofa placement relationship with walls, windows, floor, rug, coffee table, and nearby furniture.
- The sofa remains the main subject, but the room context must be clearly visible.
- Sofa occupies about 25-40% of the frame.`,
    perspective: `VIEW: Wide interior placement photograph with sofa centered. Show the complete sofa plus clear room context, including its relationship to walls, windows, floor, rug, coffee table, and nearby furniture. This is not a close localized corner shot.`
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
    guidance: `=== CAMERA: MACRO CLOSE-UP (近景特写 — 产品材质核心) ===
- Sofa occupies 75-85% of the frame — this is a PRODUCT DETAIL photograph, NOT a spatial photograph. 这是一张产品材质特写，不是空间摄影。
- Camera at 0.8-1.2m distance, armrest height — focusing on material texture, stitching, cushion softness.
- Only a small sliver of floor/wall visible as environmental context. The sofa must NOT look like a cutout paste-up.`,
    perspective: `VIEW: Product detail macro shot showing material grain, stitching, texture quality. This is fundamentally different from the wide/medium views — it is a close-up product photography, not a cropped spatial view.`
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
      ? `6. FOCUS & DEPTH OF FIELD (对焦与视觉质感): FOR CLOSE-UP VIEW (近景特写): The sofa's texture, stitching, and material grain must be in crisp, razor-sharp focus in the foreground, with the authentic partial room background softly rendering behind it with natural close-up macro photography depth. 近景特写：沙发材质纹理必须锐利清晰，背景自然柔焦。`
      : `6. FOCUS & DEPTH OF FIELD (对焦与视觉质感): You MUST keep the ENTIRE photograph (sofa, background wall, adjacent furniture, floor) completely sharp and clear in deep focus. DO NOT apply unnatural bokeh blur. 全景深清晰对焦，不要虚化背景。`,
    buildHumanModelPrompt(settings),
    settings.notes
      ? `=== USER REQUIREMENTS (最高优先级) ===\n${settings.notes}`
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

  const roomStylePrompt = `CRITICAL ROOM STYLE MATCHING: You MUST strictly generate the room according to the textual design specifications below to perfectly capture the essence of "${styleLabel}". 必须严格按照以下【设计规范】生成极致完美的【${styleLabel}】风格样板间！

DESIGN SPECIFICATION FOR THIS STYLE:
${styleSpec}`;

  return [
    `A professional, ultra-high-resolution interior design photograph.
Your task is to generate a virtual room and place the target sofa into it.`,
    roomStylePrompt,
    buildProductIdentityPrompt(analysis),
    camera.guidance,
    camera.perspective,
    perspective === "close"
      ? `6. FOCUS: Sharp focus on sofa texture and material in foreground. 近景锐利对焦。`
      : `6. FOCUS: Entire photograph in deep focus. 全景深清晰对焦。`,
    buildHumanModelPrompt(settings),
    `=== PLACEMENT ===
${analysis.placementAdvice}`,
    settings.notes
      ? `=== USER REQUIREMENTS ===\n${settings.notes}`
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
