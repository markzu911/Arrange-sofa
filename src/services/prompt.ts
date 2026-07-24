import {
  perspectiveLabels,
  sofaPlacementSystemPrompt,
  VIRTUAL_ROOM_STYLE_SPECS,
  virtualRoomStyleLabels,
} from "../constants";
import type { PlacementSettings, SceneAnalysis, SofaIdentity } from "../types";

/** Build human model prompt section. */
function buildHumanModelPrompt(settings: PlacementSettings): string {
  if (!settings.addHumanModel) {
    return `=== HUMAN PRESENCE ===\nNO human figures, models, or body-shaped decorations. 绝对不要出现人物。`;
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

  return `=== HUMAN PRESENCE ===\nInclude ${genderLabel}, ${ageLabel} sitting naturally on the target sofa. Clothing and posture must match the room's style. The model must NOT obscure the sofa's key details — armrest, backrest, cushion, material, and silhouette must remain clearly visible.`;
}

/** Build product identity prompt — 4 hard constraints following the floor lamp project's approach.
 *  NO redundant repetition of IMAGE INPUT ORDER (already declared in interleaved labels).
 *  NO dimension-by-dimension listing (dilutes attention). */
export function buildProductIdentityPrompt(analysis: SceneAnalysis): string {
  const identity = analysis.sofaIdentity;

  return `=== PRODUCT FIDELITY (SINGLE MOST IMPORTANT CONSTRAINT) ===
1. EXACT VISUAL REPLICA — The generated sofa MUST look identical to IMAGE 2 in every visible aspect: shape, color, material, armrest, backrest, cushions, legs, and decorative details.
2. ZERO HALLUCINATIONS — Do NOT add buttons, stitching, trim, or structural changes that are NOT visible in IMAGE 2. Any added detail is a critical failure.
3. REFERENCE IMAGE IS ABSOLUTE TRUTH — If text descriptions conflict with IMAGE 2, IMAGE 2 wins. The product in the result must be the SAME product, not a similar-looking substitute.
4. REALISTIC SCALE — The sofa must have correct proportions relative to the room, with natural ground contact, shadows, and ambient lighting.

SOFA IDENTITY (reference only — IMAGE 2 is the absolute truth):
- Seats: ${identity.seatCount}
- Silhouette: ${identity.silhouette}
- Armrest: ${identity.armrest}
- Backrest: ${identity.backrest}
- Cushions: ${identity.cushions}
- Material: ${identity.material}
- Color: ${identity.color}
- Details: ${identity.details.join("、")}`;
}

/** Camera instructions for each perspective — specific and differentiated. */
const CAMERA_INSTRUCTIONS: Record<string, { guidance: string; perspective: string }> = {
  wide: {
    guidance: `=== CAMERA: FAR WIDE VIEW (远景全景) ===
- Sofa occupies 15-28% of the frame, naturally positioned in the room.
- Camera at room entry/corner, eye height 1.5-1.7m, showing full room layout: walls, floor, ceiling, windows, doors, furniture.
- Sofa must follow the same perspective grid as all room elements.`,
    perspective: `VIEW: Complete room photograph from entry viewpoint. Sofa is clearly visible as part of the spatial composition. NEVER show just a blank wall or ceiling.`
  },
  medium: {
    guidance: `=== CAMERA: MID-RANGE VIEW (中近景 — 空间关系核心) ===
- Sofa occupies 45-65% of the frame, centered as dominant subject.
- Camera at 2-3m distance, 1.2-1.4m height, 15-20° side offset — creating visible parallax difference from wide view.
- Background: tightly framed room section — partial wall, coffee table, rug. NOT the entire room.`,
    perspective: `VIEW: Spatial relationship shot. Sofa dominates while showing its immediate room context. MUST crop far-end room elements visible in the wide view — this is NOT a cropped wide view, it is a genuine camera displacement.`
  },
  close: {
    guidance: `=== CAMERA: MACRO CLOSE-UP (近景特写 — 产品材质核心) ===
- Sofa occupies 75-85% of the frame — this is a PRODUCT DETAIL photograph, NOT a spatial photograph.
- Camera at 0.8-1.2m distance, armrest height — focusing on material texture, stitching, cushion softness.
- Only a small sliver of floor/wall visible as environmental context. The sofa must NOT look like a cutout paste-up.`,
    perspective: `VIEW: Product detail macro shot showing material grain, stitching, texture quality. This is fundamentally different from the wide/medium views — it is a close-up product photography, not a cropped spatial view.`
  }
};

/** Build the main generation prompt for real-room placement mode.
 *  Simplified structure: clear section headers, total length < 1500 chars. */
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
    sofaPlacementSystemPrompt,

    buildProductIdentityPrompt(analysis),

    `=== ROOM PRESERVATION ===
- Keep the exact room architecture, walls, windows, and existing furniture from IMAGE 1.
- Do NOT add windows, walls, or furniture that do not exist in IMAGE 1. If the room has dark wood panels, keep dark wood panels.`,

    `=== PLACEMENT ===
Position: ${positionLabel}
Plan: ${JSON.stringify(analysis.placementPlan)}`,

    camera.guidance,
    camera.perspective,

    perspective === "close"
      ? "=== FOCUS === Sharp focus on sofa texture, stitching, material grain in foreground. Natural depth of field for room context behind."
      : "=== FOCUS === Entire photograph in deep focus — sofa, walls, furniture, floor all sharp. No artificial bokeh.",

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

/** Build virtual room generation prompt — simplified with STYLE_SPECS. */
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

  return [
    sofaPlacementSystemPrompt,

    `=== VIRTUAL ROOM ===
Generate a virtual room and place the target sofa into it. IMAGE 2 is the exact product reference — NO uploaded room image.`,

    buildProductIdentityPrompt(analysis),

    `=== STYLE: ${styleLabel} ===
${styleSpec}`,

    camera.guidance,
    camera.perspective,

    perspective === "close"
      ? "=== FOCUS === Sharp focus on sofa texture and material in foreground."
      : "=== FOCUS === Entire photograph in deep focus.",

    buildHumanModelPrompt(settings),

    `=== PLACEMENT ===\n${JSON.stringify(analysis.placementPlan)}`,

    settings.notes
      ? `=== USER REQUIREMENTS ===\n${settings.notes}`
      : "",
    extraContext ? `平台上下文: ${extraContext}` : "",
    extraPrompt.length ? `平台关键词: ${extraPrompt.join("、")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Build analysis prompt — focused on SOFA IDENTIFICATION (P1 fix).
 *  No text-based image order declaration (interleaved labels handle this).
 *  Sofa recognition is the core priority, JSON format is minimized. */
export function buildAnalysisPrompt(
  extraContext = "",
  extraPrompt: string[] = [],
  userRequirements = "",
): string {
  return [
    "You are an interior design analysis assistant. Examine the attached images carefully.",
    "CRITICAL: IMAGE 2 is the EXACT SOFA PRODUCT to identify. Study it thoroughly — every visible detail matters.",
    "Your PRIMARY task is to accurately identify and describe the sofa in IMAGE 2. Room analysis is secondary context.",
    "Return strict JSON (no Markdown) with these fields:",
    "roomSummary: brief room description",
    "sofaSummary: what the sofa looks like",
    "sofaIdentity: { seatCount, silhouette, armrest, backrest, cushions, material, color, details } — all Chinese strings except details (Chinese string array). Be PRECISE and SPECIFIC — not generic defaults.",
    "lighting: main light direction",
    "perspective: room depth description",
    "placementAdvice: best placement suggestion",
    "constraints: string array of constraints",
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
