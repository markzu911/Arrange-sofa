import { perspectiveLabels, sofaPlacementSystemPrompt, virtualRoomStyleLabels } from "../constants";
import type { PlacementSettings, SceneAnalysis } from "../types";

function buildHumanModelPrompt(settings: PlacementSettings): string {
  if (!settings.addHumanModel) {
    return "人体模特：不添加人物。最终图中不得出现人物、人体模特或人形装饰。";
  }

  const genderLabel = {
    any: "性别不限",
    female: "女性",
    male: "男性"
  }[settings.humanModelGender];
  const ageLabel = {
    adult: "成人",
    child: "儿童",
    senior: "老年"
  }[settings.humanModelAge];

  return [
    `人体模特：必须添加一位${genderLabel}、${ageLabel}的人体模特。`,
    "模特必须自然坐在目标沙发上，由 AI 自动选择舒适、真实、符合空间气质的坐姿。",
    "模特的服装、发型、姿态、气质和色彩必须与当前已有房间风格、软装调性和画面光线保持一致，不要生成棚拍感、广告大片感或与空间割裂的造型。",
    "模特只能坐在新放入的目标沙发上，不能坐在其他家具上，不能站立、躺卧或出现在沙发之外。",
    "模特要与房间透视、尺度、光照、阴影和沙发接触关系一致，腿部、手臂和衣物遮挡必须自然。",
    "不得让模特遮挡沙发的关键产品细节；至少保留扶手、靠背、坐垫分区、主材质和整体轮廓清晰可见。",
    "多视角生成时必须保持同一位模特、同一服装、同一体型、同一大致坐姿和同一相对位置。"
  ].join("\n");
}

export function buildAnalysisPrompt(extraContext = "", extraPrompt: string[] = [], userRequirements = ""): string {
  return [
    sofaPlacementSystemPrompt,
    "输入图片顺序为：第一张是房间主图；如有后续房间图，它们是同一空间的补充角度；最后一张是沙发参考图。请综合所有房间角度分析空间，再识别沙发，返回严格 JSON，不要输出 Markdown。",
    "JSON 字段必须严格为：roomSummary, sofaSummary, sofaIdentity, lighting, perspective, placementAdvice, constraints, placementPlan。sofaIdentity 必须是对象，字段严格为 seatCount, silhouette, armrest, backrest, cushions, material, color, details；前七项为中文字符串，details 为中文字符串数组。",
    "placementPlan 必须是对象，字段严格为：summary, placement, facing, scale, preserve, remove, avoid, rationale, candidates, selectedCandidateId。其中 summary、placement、facing、scale 为中文字符串；preserve、remove、avoid、rationale 为中文字符串数组。",
    "candidates 必须包含 2 到 3 个候选摆位对象。每个对象字段严格为：id, label, placement, facing, scale, score, reasons, blocksWalkway, conflictsWithPreservedItems, violatesUserRequirements。score 为 0 到 1 的数字；reasons 为字符串数组；后三项为布尔值。明确标记会阻塞通道、碰撞需保留家具或违背用户要求的候选方案。selectedCandidateId 填写最推荐且不违反硬约束的候选 id。",
    "用户要求优先级最高。请把用户明确提出的摆放、朝向、保留、覆盖、移除、通道、视角等要求写入 placementPlan；未明确时才根据空间自行判断。",
    userRequirements ? `用户当前要求（最高优先级）：${userRequirements}` : "用户尚未给出额外要求，请依据空间自然规划。",
    extraContext ? `平台传入上下文：${extraContext}` : "",
    extraPrompt.length ? `平台补充关键词：${extraPrompt.join("、")}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildGenerationPrompt(
  analysis: SceneAnalysis,
  settings: PlacementSettings,
  perspective: string,
  extraContext = "",
  extraPrompt: string[] = []
): string {
  const positionLabel = {
    auto: "未指定位置：请根据房间尺度、通行动线、主要视觉焦点、采光和透视关系，自动选择最自然、最合理且不遮挡通道的位置与朝向。"
  }[settings.position];
  const cameraInstruction: Record<string, string> = {
    wide: "远景布局照：相机退到房间入口、角落或二层俯视边缘，展示完整目标沙发和大部分房间环境。目标沙发占画面约 20% 到 35%，重点看摆放位置、空间尺度和动线，但必须仍能判断沙发整体结构与输入产品一致。",
    medium: "中近景环境照：相机靠近会客区，距离比近景远一点点，使用平视或轻微侧前方机位。目标沙发占画面约 40% 到 60%，不强制完整展示沙发，允许裁掉少量边缘；同时看得到茶几、地毯、窗帘、灯具或墙面等周边环境。",
    close: "近景产品细节照：参考真实家居产品实拍的局部细节视角，相机贴近沙发正前方、侧前方或略从背侧切入。画面只需要展示沙发的一部分产品细节，例如扶手、靠背、坐垫、皮纹/布纹、缝线、抱枕或转角结构。允许明显局部裁切沙发，只保留少量窗景、茶几、地面或灯具作为氛围背景。"
  };

  return [
    sofaPlacementSystemPrompt,
    "输入图片顺序：第一张是干净房间底图；第二张是已抠出的沙发前景；第三张是用户原始上传的沙发产品参考图。",
    "最高优先级：最终图里的沙发产品必须像第三张产品参考图。第三张是产品身份锚点，第二张前景只用于方便合成；如果第二张前景或生成过程与第三张产品参考图有差异，一律以第三张为准。",
    "原则排序：产品一致性第一，摆放方案第二，视角变化第三，画面美观第四。为了换视角、适配房间或增加美观，不得重新设计沙发，不得把沙发换成相似款或不同座位数/不同结构的产品。",
    "产品一致性底线：不得改变沙发的整体轮廓、贵妃位/转角方向、模块数量、扶手形状、靠背高度、坐垫分区、主色、材质和明显装饰细节。不能用相似款替代。",
    "把该沙发自然放入第一张房间底图，匹配透视、尺度、地面接触、光照、阴影、反射和环境色。不要原样返回房间底图。",
    "多视角应像同一场景内连续拍摄：可以改变相机距离、高度、水平角度和前景/背景关系，但前提是目标沙发产品身份完全不变；如果产品一致性和视角变化冲突，必须优先保持产品一致，宁可让视角变化保守一点。",
    `摆放位置：${positionLabel}`,
    `生成视角：${perspectiveLabels[perspective as keyof typeof perspectiveLabels] ?? perspective}`,
    `镜头构图硬约束：${cameraInstruction[perspective] ?? cameraInstruction.medium}`,
    `融合强度：${settings.blendStrength}`,
    `图片比例：${settings.ratio}`,
    `清晰度：${settings.clarity}`,
    buildHumanModelPrompt(settings),
    settings.notes
      ? `用户额外要求（最高优先级，必须以用户想法为准并逐项执行）：${settings.notes}`
      : "用户没有额外要求时，请自行选择最适合该房间的摆放位置、朝向与尺度。",
    `目标沙发识别信息：${JSON.stringify(analysis.sofaIdentity)}`,
    `已确认试摆计划（必须执行，除非与用户更高优先级要求冲突）：${JSON.stringify(analysis.placementPlan)}`,
    extraContext ? `平台传入上下文：${extraContext}` : "",
    extraPrompt.length ? `平台补充关键词：${extraPrompt.join("、")}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildCameraVariationPrompt(
  analysis: SceneAnalysis,
  settings: PlacementSettings,
  perspective: string,
  extraContext = "",
  extraPrompt: string[] = []
): string {
  const cameraInstruction: Record<string, string> = {
    medium: "中近景环境照：相机从远景机位前移到会客区外缘，并可向沙发左前方或右前方轻微横移；目标沙发占画面约 40% 到 60%。不要求完整展示沙发，允许裁掉少量边缘；保留茶几、地毯、窗帘、灯具或墙面中的 2 到 3 个环境参照物。",
    close: "近景产品细节照：参考真实家居产品实拍的局部细节视角，相机继续靠近沙发，使用正前方、侧前方或略从背侧切入的低到中等高度机位；画面只需要展示沙发的一部分产品细节，例如扶手、靠背、坐垫、皮纹/布纹、缝线、抱枕或转角结构。允许明显局部裁切沙发，只保留少量窗景、茶几、地面或灯具作为氛围背景。"
  };
  const cameraDeltaInstruction: Record<string, string> = {
    medium: "中近景应比远景更靠近沙发，画面重点从全房间转为沙发与周边环境。可以有轻微视差和构图变化，但不得为追求视角差异改变沙发款式、结构或比例。",
    close: "近景应比中近景更靠近产品细节，画面重点从沙发与环境转为材质和局部结构。可以局部裁切沙发；裁切是允许的，但产品细节必须仍来自第三张产品参考图里的同一款沙发。"
  };
  return [
    "这是同一试摆方案的换镜头任务。第一张输入图是已确认的远景主图，用来参考房间、摆放位置、朝向、尺度、光影和主要家具关系；第二张是沙发前景；第三张是用户原始沙发产品参考图。",
    "第三张产品参考图是沙发身份唯一锚点。第一张远景主图只能作为空间与摆放参考，不能作为产品款式依据；如果远景主图中的沙发已经与第三张不一致，必须按第三张产品参考图纠正。",
    "最重要原则：最终图里的沙发必须继续像第三张产品参考图。产品一致性高于视角变化；为了换镜头不得重新设计沙发，不得把它改成相似款，不得改变贵妃位/转角方向、模块数量、扶手、靠背、坐垫分区、主色和材质。",
    "视角变化可以保守；允许中近景或近景包含局部裁切。禁止的是把沙发变成另一款产品，而不是禁止合理裁切。产品一致性和镜头变化冲突时，优先保持产品一致。",
    buildHumanModelPrompt(settings),
    `目标镜头：${perspectiveLabels[perspective as keyof typeof perspectiveLabels] ?? perspective}。${cameraInstruction[perspective] ?? cameraInstruction.medium}`,
    `与远景主图的差异要求：${cameraDeltaInstruction[perspective] ?? cameraDeltaInstruction.medium}`,
    `目标沙发识别信息：${JSON.stringify(analysis.sofaIdentity)}`,
    `锁定试摆计划：${JSON.stringify(analysis.placementPlan)}`,
    settings.notes ? `用户要求（最高优先级）：${settings.notes}` : "",
    extraContext ? `平台上下文：${extraContext}` : "",
    extraPrompt.length ? `平台补充关键词：${extraPrompt.join("；")}` : ""
  ].filter(Boolean).join("\n");
}

export function buildVirtualRoomPrompt(
  analysis: SceneAnalysis,
  settings: PlacementSettings,
  perspective: string,
  extraContext = "",
  extraPrompt: string[] = []
): string {
  const styleLabel = virtualRoomStyleLabels[settings.virtualRoomStyle];
  const cameraInstruction: Record<string, string> = {
    wide: "远景布局照：相机位于虚拟客厅入口、角落或二层俯视边缘，展示完整目标沙发和大部分客厅空间、地面、墙面、天花、窗景和软装关系；目标沙发占画面约 20% 到 35%，重点看空间尺度和摆放位置。",
    medium: "中近景环境照：相机明显靠近会客区并略微偏侧，比近景远一点点；目标沙发占画面约 40% 到 60%，不要求完整展示沙发，允许裁掉少量边缘，同时保留茶几、地毯、背景墙、窗景或灯具作为空间参照。",
    close: "近景产品细节照：参考真实家居产品实拍的局部细节视角，相机贴近沙发正前方、侧前方或略从背侧切入；画面只需要展示沙发的一部分产品细节，例如扶手、靠背、坐垫、材质纹理、缝线、抱枕或转角结构。允许明显局部裁切沙发，仅保留少量虚拟房间上下文。"
  };

  return [
    sofaPlacementSystemPrompt,
    "这是从沙发产品图直接生成虚拟房间试摆效果的任务。没有用户房间原图，输入图片只包含一张目标沙发参考图。",
    `虚拟房间装修风格：${styleLabel}。请生成高端别墅客厅或大平层客厅，空间完整、真实、有尺度感，软装风格统一，不要生成展厅白底、棚拍、产品海报或纯背景图。`,
    "原则排序：产品一致性第一，虚拟房间合理性第二，视角变化第三，画面美观第四。为了换视角、适配房间或增加美观，不得重新设计沙发，不得把沙发换成相似款或不同座位数/不同结构的产品。",
    "产品一致性底线：最终图里的沙发必须像输入产品图。不得改变整体轮廓、贵妃位/转角方向、模块数量、扶手形状、靠背高度、坐垫分区、主色、材质和明显装饰细节。不能用相似款替代。",
    "沙发必须自然放在虚拟客厅会客区中，与地面接触、阴影、反射、透视和环境光一致。允许根据虚拟房间风格添加茶几、地毯、灯具、窗帘、墙面、植物等配套元素，但它们不能遮挡沙发主体。",
    `生成视角：${perspectiveLabels[perspective as keyof typeof perspectiveLabels] ?? perspective}`,
    `镜头构图硬约束：${cameraInstruction[perspective] ?? cameraInstruction.medium}`,
    `图片比例：${settings.ratio}`,
    `清晰度：${settings.clarity}`,
    buildHumanModelPrompt(settings),
    settings.notes ? `用户额外要求（最高优先级，必须逐项执行）：${settings.notes}` : "用户没有额外要求时，请自行完成协调的空间搭配。",
    `已确认虚拟试摆计划：${JSON.stringify(analysis.placementPlan)}`,
    `目标沙发身份卡：${JSON.stringify(analysis.sofaIdentity)}`,
    "多视角生成时，同一个沙发、同一个房间、同一个摆放方案必须保持一致。可以改变相机距离、构图和局部裁切，但前提是目标沙发产品身份完全不变；如果产品一致性和视角变化冲突，必须优先保持产品一致，宁可让视角变化保守一点。",
    extraContext ? `平台传入上下文：${extraContext}` : "",
    extraPrompt.length ? `平台补充关键词：${extraPrompt.join("、")}` : ""
  ].filter(Boolean).join("\n");
}

export function buildQualityPrompt(
  analysis: SceneAnalysis,
  settings: PlacementSettings,
  extraContext = "",
  extraPrompt: string[] = []
): string {
  return [
    "你是室内软装试摆结果质检员。输入依次为房间原图、目标沙发图、生成结果图。",
    "请核对生成结果是否真正放入了目标沙发，并且符合已确认的试摆计划与用户最高优先级要求。重点检查：是否仍是原图、沙发是否为相似款或原沙发改色冒充、整体轮廓/座位数/扶手/靠背/坐垫/沙发脚/缝线或拉扣/主色/材质纹理是否与最后一张沙发参考图一致、位置/朝向是否违背计划、是否错误移除了需保留物、是否遮挡通道或关键结构、透视尺度光影是否明显失真。",
    settings.addHumanModel
      ? "用户已要求添加人体模特：请检查结果中是否有一位符合选项的人体模特自然坐在目标沙发上，人物是否与空间光影尺度一致，是否过度遮挡沙发关键细节。"
      : "用户未要求添加人体模特：结果中不得出现人物或人体模特。",
    "只返回严格 JSON：passed（布尔值）, issues（中文字符串数组）, correctionPrompt（中文字符串）。若通过，issues 返回空数组，correctionPrompt 为空字符串；若不通过，correctionPrompt 要给出可直接用于下一次图像编辑的具体纠正要求。",
    `已确认试摆计划：${JSON.stringify(analysis.placementPlan)}`,
    settings.notes ? `用户当前要求（最高优先级）：${settings.notes}` : "用户没有额外要求。",
    extraContext ? `平台传入上下文：${extraContext}` : "",
    extraPrompt.length ? `平台补充关键词：${extraPrompt.join("；")}` : ""
  ].filter(Boolean).join("\n");
}
