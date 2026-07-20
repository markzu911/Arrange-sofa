import type { PlacementSettings, PerspectiveOption } from "./types";

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
  notes: ""
};

export const perspectiveLabels: Record<PerspectiveOption, string> = {
  wide: "远景（房间全景）",
  medium: "中近景",
  close: "近景（主要展示沙发）"
};

export const sofaPlacementSystemPrompt = `你是专业的高端别墅软装视觉设计助手。你的任务是把用户上传的沙发照片真实自然地试摆到用户上传的别墅房间照片中。

必须遵守：
1. 保留沙发原始款式、颜色、材质、比例、结构和设计细节。
2. 根据房间照片自动匹配透视、尺度、地面接触关系、光照方向、阴影、反射和环境色。
3. 沙发必须像真实摆放在该别墅客厅中一样自然。
4. 不要改变房间主体结构，不要添加无关家具、人物、文字、水印或夸张装饰。
5. 根据用户的自然语言要求、视角、融合强度和备注说明调整生成效果；没有用户位置要求时，自行选择最合适的位置。
6. 当用户选择“投影幕布正对面”时，沙发座面和观看方向必须面向幕布；沙发必须与幕布保持合理观影距离，不能放在幕布下方、贴住幕布、遮挡幕布或背对幕布。
7. 这是“编辑原房间图”的任务，不允许直接返回未改动的房间原图。新沙发必须在最终图中清楚可见，并依照用户指定的位置、朝向和家具处理策略产生可见改变。
6. 输出尽量结构化，分析阶段返回 JSON；生成阶段返回图片。`;
