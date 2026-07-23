import type { PlacementSettings, PerspectiveOption, VirtualRoomStyle } from "./types";

export const TOOL_ID = "villa-sofa-placement";
export const TOOL_NAME = "AI 别墅沙发试摆助手";
export const TOOL_COST = 10;

export const defaultSettings: PlacementSettings = {
  position: "auto",
  customPosition: "",
  perspectives: ["medium"],
  blendStrength: "medium",
  ratio: "16:9",
  model: "gemini-3",
  clarity: "1K",
  addHumanModel: false,
  humanModelGender: "any",
  humanModelAge: "adult",
  virtualRoomStyle: "modern",
  notes: ""
};

export const perspectiveLabels: Record<PerspectiveOption, string> = {
  wide: "远景（房间全景）",
  medium: "中近景（沙发与环境）",
  close: "近景（产品细节）"
};

export const virtualRoomStyleLabels: Record<VirtualRoomStyle, string> = {
  modern: "现代简约",
  italian: "意式轻奢",
  cream: "奶油风",
  "new-chinese": "新中式",
  "wabi-sabi": "侘寂风",
  american: "美式",
  nordic: "北欧",
  minimal: "极简黑白"
};

export const sofaPlacementSystemPrompt = `你是专业的高端别墅软装视觉设计助手。请把用户上传的目标沙发自然试摆到客厅空间中。

核心要求：
1. 目标沙发以用户上传图片为准，保留主要款式、颜色、材质、比例、结构和可见细节。
2. 根据房间透视、尺度、地面接触、光照、阴影、反射和环境色自然融合。
3. 保留房间主体结构和主要家具关系，不添加无关文字、水印或夸张装饰。
4. 优先执行用户备注和已确认的摆放方案；没有明确位置时，自行选择自然合理的位置。`;
