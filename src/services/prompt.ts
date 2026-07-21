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
    wide: "镜头必须为远景：相机退到房间入口或角落位置，完整呈现房间主要建筑结构、地面、天花、墙面关系和核心家具，目标沙发在画面中占比约 12% 到 25%，不能裁掉主要空间。",
    medium: "镜头必须为中近景：相机明显前移到会客区边缘，并向沙发侧前方偏移 15 到 30 度；完整呈现目标沙发和近处会客区，允许裁掉部分远端墙面、天花或外围家具，目标沙发在画面中占比约 45% 到 60%。",
    close: "镜头必须为近景：相机贴近目标沙发正前方或侧前方，以目标沙发为主要主体，清晰展示其扶手、靠背、坐垫和材质细节，目标沙发在画面中占比约 65% 到 80%，仅保留少量环境上下文。"
  };

  return [
    sofaPlacementSystemPrompt,
    "这是严格的图片编辑/合成任务，不是重新描述房间，也不是返回原图。第一张输入图是待编辑的房间主图；如有后续房间图，它们是同一空间的补充角度，只用于校验空间结构、家具关系和遮挡；最后一张输入图是必须放入房间的目标沙发。",
    "最终图必须与原房间图有清楚可见的变化：目标沙发必须出现在指定位置、尺度和朝向上。若原房间已有不符合方案的沙发，仅在用户额外要求明确允许时才移除或替换它；绝不能原样返回房间图。",
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
    "空间执行规则：准确理解用户指定的相对位置、朝向、需要保留或移除的家具、通道和遮挡关系。只移除用户在额外要求中明确允许移除或替换的物品；没有明确要求时，保留房间内其他家具与装饰。",
    "目标沙发身份锁定：最后一张输入图中的沙发是唯一允许放入的目标主体。必须保留它的款式、颜色、材质、扶手、靠背、坐垫与整体轮廓；不得仅改变场景内原沙发的颜色、材质或局部形状来冒充目标沙发。",
    `目标沙发身份卡（必须逐项执行）：${JSON.stringify(analysis.sofaIdentity)}`,
    "沙发特征必须逐项一致：整体轮廓与比例、座位数量、扶手外形、靠背分段、坐垫数量与分区、沙发脚、可见缝线/拉扣/褶皱、主色、材质纹理和可见装饰。不得用风格相似的沙发替代，不得改变结构、座位数或比例，不得新增、隐藏或并存另一张沙发。生成前逐项核验上述特征；任一特征无法保持时，视为生成失败。",
    `已确认试摆计划（必须执行，除非与用户更高优先级要求冲突）：${JSON.stringify(analysis.placementPlan)}`,
    `已确认场景分析：${JSON.stringify(analysis)}`,
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
    medium: "中近景：相机从远景位置明显前移到会客区边缘，并向沙发左前方或右前方横移 15 到 30 度，形成可见侧向视差；目标沙发占画面约 45% 到 60%。必须裁掉部分远端空间、天花或外围家具，只保留沙发周边 1 到 2 个参照物来证明仍是同一房间。",
    close: "近景：以第一张远景主图中的目标沙发为基础做局部相机靠近和细节重构，相机贴近目标沙发正前方或侧前方，目标沙发占画面约 65% 到 80%，清晰展示扶手、靠背、坐垫和材质细节；只保留局部地面、墙面或茶几作为环境上下文。"
  };
  const cameraDeltaInstruction: Record<string, string> = {
    medium: "中近景与远景的差异必须一眼可见：沙发主体面积至少达到远景的 2 倍，画面边缘必须少于远景的全房间信息；墙面、窗户、茶几、地毯或通道相对沙发的位置必须出现轻微但真实的透视位移。",
    close: "近景与远景的差异必须非常明显：沙发主体面积至少达到远景的 3 倍，画面重点从房间展示转为产品展示，远端空间大部分不可见。"
  };
  return [
    "这是锁定布局后的虚拟相机重构任务。第一张输入图是已经确认正确的远景试摆主图；它是唯一的空间与布局事实来源。第二张输入图是用户上传的目标沙发原图，是唯一的产品身份裁判。",
    "绝对禁止改变第一张图中的沙发位置、朝向、大小、款式、颜色、材质、房间结构、家具、装饰、光影、遮挡关系和人造物。不得重新规划摆位，不得添加或删除任何家具。",
    "沙发身份绝对锁定：主图中的目标沙发必须始终对应最后一张沙发参考图，而不是任何相似款或场景原有沙发的改色版本。必须保持整体轮廓与比例、座位数量、扶手外形、靠背分段、坐垫数量与分区、沙发脚、可见缝线/拉扣/褶皱、主色、材质纹理和可见装饰完全一致。任何一项变化均视为失败。",
    "生成中近景和近景时，必须同时核对第一张远景主图里的沙发和第二张用户上传沙发原图：允许因为视角变化出现合理遮挡，但不得把沙发重新设计成另一款，不得改变座位数、扶手、靠背、坐垫分区、颜色或材质。",
    `本次必须保持的沙发身份卡：${JSON.stringify(analysis.sofaIdentity)}`,
    buildHumanModelPrompt(settings),
    "只允许改变虚拟相机的位置、横向方位、朝向、拍摄距离和焦距，产生与主图属于同一时刻、同一房间、同一试摆方案的真实摄影镜头。相机机位不得与主图重合，朝向不得完全一致；必须保留目标沙发相对墙面、窗户、茶几和通道的位置关系。",
    "禁止输出仅裁切、缩放或放大主图得到的画面。近景应优先基于主图中已放置正确的沙发做相机靠近和细节重构，而不是重新生成一张新沙发。如果无法完成真实机位重构，也必须生成一个明显更近、更偏侧、更聚焦沙发的镜头，而不是返回与远景几乎相同的构图。",
    "反偷懒硬规则：最终图必须能看出真实相机位移带来的视差变化，至少两个稳定参照物（例如墙面边线、窗框、楼梯、茶几、地毯边缘、灯具）相对沙发的位置或遮挡关系必须发生合理变化。只改变画面裁切范围、只放大沙发、只模糊背景、只改变清晰度，全部判定为失败。",
    "机位差异硬约束：先从当前房间中识别稳定参照物和可行拍摄区域，再选择与主图不同的机位。新机位必须同时具备可见的横向位置变化与相机朝向变化，而不是仅前后移动、仅改变焦距、仅裁切或仅缩放。画面中墙面、窗户、茶几、地毯、通道相对沙发的透视关系必须随相机位移自然变化。",
    "场景像素事实锁定：第一张主图中已可见的建筑和家具是不可改写的事实。必须保留其数量、相对位置、结构、材质、颜色和尺度，包括但不限于楼梯、栏杆、夹层、吊灯、门窗、壁炉、墙面、地面、茶几、地毯、灯具和植物。禁止生成另一套相似但不同的别墅，禁止新增、删除、替换、移动或重新设计任何上述主体。只能在主图已有空间中改变相机位置。",
    `目标镜头：${perspectiveLabels[perspective as keyof typeof perspectiveLabels] ?? perspective}。${cameraInstruction[perspective] ?? cameraInstruction.medium}`,
    `与远景主图的差异要求：${cameraDeltaInstruction[perspective] ?? cameraDeltaInstruction.medium}`,
    "生成前自检：如果新图和远景主图在 64x64 缩略图下看起来几乎一样，说明失败；必须重新选择更近、更偏侧的相机位。最终输出只能是差异明显的新镜头。",
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
    wide: "远景：相机位于虚拟客厅入口或角落，完整呈现客厅空间、地面、墙面、天花、窗景和软装关系；目标沙发占画面约 18% 到 30%，必须能看清它在空间中的摆放。",
    medium: "中近景：相机明显靠近会客区并略微偏侧，目标沙发占画面约 45% 到 60%；只保留沙发周边的茶几、地毯、背景墙或窗景作为空间参照。",
    close: "近景：相机贴近目标沙发正前方或侧前方，目标沙发占画面约 65% 到 80%；重点展示扶手、靠背、坐垫、材质纹理和产品轮廓，仅保留少量虚拟房间上下文。"
  };

  return [
    sofaPlacementSystemPrompt,
    "这是从沙发产品图直接生成虚拟房间试摆效果的任务。没有用户房间原图，输入图片只包含一张目标沙发参考图。",
    `虚拟房间装修风格：${styleLabel}。请生成高端别墅客厅或大平层客厅，空间完整、真实、有尺度感，软装风格统一，不要生成展厅白底、棚拍、产品海报或纯背景图。`,
    "目标沙发身份锁定：输入图中的沙发是唯一允许出现的主沙发。必须保留它的款式、颜色、材质、扶手、靠背、坐垫、脚部、缝线/拉扣/褶皱、模块数量和整体轮廓；不得用相似款替代，不得重新设计，不得改变座位数、比例或主色。",
    "沙发必须自然放在虚拟客厅会客区中，与地面接触、阴影、反射、透视和环境光一致。允许根据虚拟房间风格添加茶几、地毯、灯具、窗帘、墙面、植物等配套元素，但它们不能遮挡沙发主体。",
    `生成视角：${perspectiveLabels[perspective as keyof typeof perspectiveLabels] ?? perspective}`,
    `镜头构图硬约束：${cameraInstruction[perspective] ?? cameraInstruction.medium}`,
    `图片比例：${settings.ratio}`,
    `清晰度：${settings.clarity}`,
    buildHumanModelPrompt(settings),
    settings.notes ? `用户额外要求（最高优先级，必须逐项执行）：${settings.notes}` : "用户没有额外要求时，请自行完成协调的空间搭配。",
    `已确认虚拟试摆计划：${JSON.stringify(analysis.placementPlan)}`,
    `目标沙发身份卡：${JSON.stringify(analysis.sofaIdentity)}`,
    "多视角生成时，同一个沙发、同一个房间、同一个摆放方案必须保持一致。中近景和近景不能只是远景裁切或放大，必须体现真实相机位移、距离变化和构图重点变化。",
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
