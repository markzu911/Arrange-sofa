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
    medium: "中近景沙发主体照：必须从远景不同的真实机位重新拍摄，相机明显靠近沙发并切换到左前方或右前方约 30 到 60 度的角度。沙发占画面约 60% 到 80%，不要求展示周边环境或完整沙发；不得把远景直接裁切、放大或沿用相同构图充当中近景。",
    close: "近景产品细节照：必须从中近景不同的真实机位重新拍摄，相机贴近沙发正前方、侧前方或略从背侧切入。画面只展示沙发的一部分真实产品细节，例如扶手、靠背、坐垫、皮纹/布纹、缝线、抱枕或转角结构；不要求展示房间环境。不得把已有视图裁切、放大或沿用相同构图充当近景。"
  };

  return [
    sofaPlacementSystemPrompt,
    "输入图片顺序：第一张是干净房间底图；第二张是已抠出的沙发前景；第三张是用户原始上传的沙发产品参考图。",
    "最高优先级：最终图里的沙发产品必须像第三张产品参考图。第三张是产品身份锚点，第二张前景只用于方便合成；如果第二张前景或生成过程与第三张产品参考图有差异，一律以第三张为准。",
    "原则排序：产品一致性第一，摆放方案第二，视角变化第三，画面美观第四。为了换视角、适配房间或增加美观，不得重新设计沙发，不得把沙发换成相似款或不同座位数/不同结构的产品。",
    "产品一致性底线：不得改变沙发的整体轮廓、贵妃位/转角方向、模块数量、扶手形状、靠背高度、坐垫分区、主色、材质和明显装饰细节。不能用相似款替代。",
    "把该沙发自然放入第一张房间底图，匹配透视、尺度、地面接触、光照、阴影、反射和环境色。不要原样返回房间底图。",
    "多视角应像同一场景内连续拍摄：产品身份必须完全不变，同时每个视角必须由不同真实相机机位重新生成。不得把远景裁切、缩放或复用相同构图伪装成中近景或近景；产品一致性和视角变化都必须满足。",
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
    medium: "中近景沙发主体照：相机必须从远景机位前移，并切换到沙发左前方或右前方约 30 到 60 度的不同角度；沙发占画面约 60% 到 80%。不要求展示周边环境或完整沙发，画面必须是重新生成的真实机位，不能直接裁切、缩放或复用远景构图。",
    close: "近景产品细节照：相机必须继续靠近沙发，并切换到与中近景不同的正前方、侧前方或略从背侧切入机位；只展示沙发的一部分真实产品细节，例如扶手、靠背、坐垫、皮纹/布纹、缝线、抱枕或转角结构，不要求展示房间环境。不能直接裁切、缩放或复用已有构图。"
  };
  const cameraDeltaInstruction: Record<string, string> = {
    medium: "中近景必须比远景更靠近沙发，并产生明显水平角度和透视差异；画面重点只需是沙发主体。不得为追求视角差异改变沙发款式、结构或比例，也不得用远景裁切或缩放代替真实换机位。",
    close: "近景必须比中近景更靠近产品细节，并切换到不同角度；画面重点只需是材质和局部结构。产品细节必须来自第一张产品参考图里的同一款沙发，且不得用已有图片裁切或缩放代替真实换机位。"
  };
  return [
    "这是同一试摆方案的换镜头任务。第一张输入图是用户原始沙发产品参考图，是产品身份唯一锚点；第二张是沙发前景；第三张是已确认的远景主图，只能参考房间、摆放位置、朝向、尺度、光影和主要家具关系。",
    "第一张产品参考图是沙发身份唯一锚点。第三张远景主图只能作为空间与摆放参考，不能作为产品款式依据；如果远景主图中的沙发已经与第一张不一致，必须按第一张产品参考图纠正。",
    "最重要原则：最终图里的沙发必须继续像第一张产品参考图。产品一致性高于视角变化；为了换镜头不得重新设计沙发，不得把它改成相似款，不得改变贵妃位/转角方向、模块数量、扶手、靠背、坐垫分区、主色和材质。",
    "中近景和近景必须是不同真实相机机位重新生成的画面，禁止把远景或中近景直接裁切、缩放或复用相同构图。禁止的是把沙发变成另一款产品，也禁止用裁切伪装换镜头。",
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

export function buildPlacementBackgroundPrompt(
  analysis: SceneAnalysis,
  settings: PlacementSettings,
  perspective: string,
  extraContext = "",
  extraPrompt: string[] = []
): string {
  const cameraInstruction: Record<string, string> = {
    wide: "远景背景板：保留完整房间和主要空间关系，镜头位于房间入口或角落。",
    medium: "中近景背景板：从远景机位前移，并向左前方或右前方小幅移动，形成真实但克制的机位差异。",
    close: "近景背景板：继续靠近未来沙发摆放区域，并从与中近景不同的轻微前侧角度拍摄，只保留少量房间上下文。"
  };
  return [
    "这是室内试摆的无沙发背景板任务。输入图是已经清场的房间；只生成同一房间、同一摆放方案下的真实不同机位背景板。",
    "画面中不得生成任何沙发、躺椅、人体模特或其他会遮挡目标沙发区域的主体家具。目标沙发将由系统以原始产品像素在后续合成，因此不得自行绘制、猜测、替代或添加沙发。",
    "必须保留房间建筑结构、门窗、地面、墙面、主要家具、光照和通道关系；中近景与近景必须是重新生成的真实机位，不能裁切、缩放或复用远景构图。",
    `目标背景镜头：${perspectiveLabels[perspective as keyof typeof perspectiveLabels] ?? perspective}。${cameraInstruction[perspective] ?? cameraInstruction.medium}`,
    `锁定试摆计划：${JSON.stringify(analysis.placementPlan)}`,
    settings.notes ? `用户要求：${settings.notes}` : "",
    extraContext ? `平台上下文：${extraContext}` : "",
    extraPrompt.length ? `平台补充关键词：${extraPrompt.join("、")}` : ""
  ].filter(Boolean).join("\n");
}

export function buildVirtualRoomBackgroundPrompt(
  analysis: SceneAnalysis,
  settings: PlacementSettings,
  perspective: string,
  extraContext = "",
  extraPrompt: string[] = []
): string {
  const styleLabel = virtualRoomStyleLabels[settings.virtualRoomStyle];
  return [
    "这是虚拟客厅的无沙发背景板任务。生成同一套完整、真实的客厅空间，但画面中不得出现沙发、躺椅或人体模特。目标沙发将由系统以原始产品像素在后续合成。",
    `装修风格：${styleLabel}。`,
    `目标镜头：${perspectiveLabels[perspective as keyof typeof perspectiveLabels] ?? perspective}。远景展示大部分空间；中近景向未来沙发区域小幅前移和侧移；近景继续靠近该区域并采用不同轻微前侧机位。所有镜头必须真实重新生成，不得裁切或缩放复用。`,
    `锁定试摆计划：${JSON.stringify(analysis.placementPlan)}`,
    extraContext ? `平台上下文：${extraContext}` : "",
    extraPrompt.length ? `平台补充关键词：${extraPrompt.join("、")}` : ""
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
    medium: "中近景沙发主体照：必须从远景不同的真实机位重新拍摄，相机明显靠近沙发并切换到左前方或右前方约 30 到 60 度的角度；沙发占画面约 60% 到 80%，不要求展示周边环境或完整沙发。不得把远景直接裁切、放大或沿用相同构图充当中近景。",
    close: "近景产品细节照：必须从中近景不同的真实机位重新拍摄，相机贴近沙发正前方、侧前方或略从背侧切入；只展示沙发的一部分真实产品细节，例如扶手、靠背、坐垫、材质纹理、缝线、抱枕或转角结构，不要求展示房间环境。不得把已有视图裁切、放大或沿用相同构图充当近景。"
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
    "多视角生成时，同一个沙发、同一个房间、同一个摆放方案必须保持一致，同时每个视角必须由不同真实相机机位重新生成。不得把远景裁切、缩放或复用相同构图伪装成中近景或近景；产品一致性和视角变化都必须满足。",
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
