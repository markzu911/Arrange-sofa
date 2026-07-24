export type ToolMode = "agent" | "expert";
export type WorkflowStep = "upload" | "analysis" | "confirm" | "settings" | "result";
export type ImageRatio = "1:1" | "3:4" | "4:3" | "16:9";
export type ClarityLevel = "1K" | "2K" | "4K";
export type GeminiModelChoice = "gemini-2.5" | "gemini-3";
export type PlacementPosition = "auto";
export type PerspectiveOption = "wide" | "medium" | "close";
export type BlendStrength = "low" | "medium" | "high";
export type HumanModelGender = "any" | "female" | "male";
export type HumanModelAge = "adult" | "child" | "senior";
export type VirtualRoomStyle = "modern" | "italian" | "cream" | "new-chinese" | "wabi-sabi" | "american" | "nordic" | "minimal";

export interface SaasInitPayload {
  type: "SAAS_INIT";
  userId?: string;
  toolId?: string;
  context?: string;
  prompt?: string[];
  launchUrl?: string;
  verifyUrl?: string;
  consumeUrl?: string;
  uploadTokenUrl?: string;
  uploadCommitUrl?: string;
}

export interface ToolUser {
  name: string;
  enterprise?: string;
  integral: number;
}

export interface ToolInfo {
  name: string;
  integral: number;
}

export interface LaunchState {
  user: ToolUser;
  tool: ToolInfo;
}

export interface UploadedImage {
  fileName: string;
  mimeType: "image/jpeg" | "image/png";
  size: number;
  dataUrl: string;
  base64: string;
  width: number;
  height: number;
}

export interface SceneAnalysis {
  roomSummary: string;
  sofaSummary: string;
  sofaIdentity: SofaIdentity;
  lighting: string;
  perspective: string;
  placementAdvice: string;
  constraints: string[];
  placementPlan: TrialPlacementPlan;
}

export interface SofaIdentity {
  seatCount: string;
  silhouette: string;
  armrest: string;
  backrest: string;
  cushions: string;
  material: string;
  color: string;
  details: string[];
}

export interface TrialPlacementPlan {
  summary: string;
  placement: string;
  facing: string;
  scale: string;
  preserve: string[];
  remove: string[];
  avoid: string[];
  rationale: string[];
  candidates: PlacementCandidate[];
  selectedCandidateId: string;
}

export interface PlacementCandidate {
  id: string;
  label: string;
  placement: string;
  facing: string;
  scale: string;
  score: number;
  reasons: string[];
  blocksWalkway: boolean;
  conflictsWithPreservedItems: boolean;
  violatesUserRequirements: boolean;
}

export interface GenerationQualityCheck {
  passed: boolean;
  issues: string[];
  correctionPrompt: string;
}

export interface PlacementSettings {
  position: PlacementPosition;
  customPosition: string;
  perspectives: PerspectiveOption[];
  blendStrength: BlendStrength;
  ratio: ImageRatio;
  model: GeminiModelChoice;
  clarity: ClarityLevel;
  addHumanModel: boolean;
  humanModelGender: HumanModelGender;
  humanModelAge: HumanModelAge;
  virtualRoomStyle: VirtualRoomStyle;
  notes: string;
}

export interface GeneratedImageResult {
  id: string;
  perspective: PerspectiveOption;
  title: string;
  imageUrl: string;
  savedUrl?: string;
  recordId?: string;
  uploadStatus: "pending" | "saved" | "failed" | "skipped";
  quality?: GenerationQualityCheck;
}

export interface GeminiGenerateRequest {
  mode: "analyze" | "cutout" | "erase" | "generate" | "quality";
  model: string;
  roomImage?: Pick<UploadedImage, "base64" | "mimeType">;
  roomReferenceImages?: Array<Pick<UploadedImage, "base64" | "mimeType">>;
  sofaImage?: Pick<UploadedImage, "base64" | "mimeType">;
  productReferenceImage?: Pick<UploadedImage, "base64" | "mimeType">;
  analysis?: SceneAnalysis;
  settings?: PlacementSettings;
  systemPrompt: string;
  perspectivePrompts?: Record<string, string>;
  resultImage?: Pick<UploadedImage, "base64" | "mimeType">;
  backgroundOnly?: boolean;
}

export interface GeminiAnalyzeResponse {
  success: true;
  analysis: SceneAnalysis;
}

export interface GeminiImageResponse {
  success: true;
  images: Array<{
    perspective: PerspectiveOption;
    title: string;
    imageUrl: string;
  }>;
}

export interface GeminiQualityResponse {
  success: true;
  quality: GenerationQualityCheck;
}

export type GeminiResponse = GeminiAnalyzeResponse | GeminiImageResponse;

export interface ApiResult<T> {
  success: boolean;
  valid?: boolean;
  message?: string;
  data?: T;
}
