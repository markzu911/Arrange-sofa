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
  medium: "中近景（沙发主体）",
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

export const sofaPlacementSystemPrompt = `You are a professional high-end villa interior soft-furnishing visual design assistant. Your task is to naturally place the user's target sofa into the living room space and generate a professional interior design photograph.

CORE REQUIREMENTS:
1. The target sofa MUST be an EXACT 1:1 visual replica of the uploaded product reference image in every dimension: silhouette, seat count, armrest shape, backrest height, cushion partition, main color, material texture, and visible decorative details.
2. The sofa must be naturally integrated into the room with correct perspective, scale, ground contact, lighting, shadows, reflections, and ambient color.
3. Preserve the room's main structure and key furniture relationships. Do not add irrelevant text, watermarks, or exaggerated decoration.
4. Prioritize user notes and confirmed placement plans. When no explicit position is given, choose the most natural and reasonable location yourself.

HIGHEST PRIORITY CONSTRAINT:
- CRITICAL DIRECT VISUAL REPLICATION (最核心约束 - 必须和用户上传的沙发产品参考图完全一致):
  The generated sofa MUST BE AN EXACT visual replica of the reference product image. Any visual deviation from the reference image is a critical failure!
  If there is any discrepancy between text descriptions and the reference image, THE REFERENCE IMAGE IS THE ABSOLUTE TRUTH AND MUST BE REPLICATED EXACTLY.`;

/** Detailed style specifications for virtual rooms, following the floor lamp project's STYLE_SPECS approach. */
export const VIRTUAL_ROOM_STYLE_SPECS: Record<VirtualRoomStyle, string> = {
  modern: `MASTERPIECE ARCHITECTURE: Contemporary luxury modern living room (现代简约风格客厅). Open floor plan with clean straight lines.
MATERIALS: Large-format polished marble or sintered stone floor slabs, tinted glass partitions, brushed metal accents, premium Italian leather furniture.
COLORS: Monochromatic scale of charcoal, slate gray, pure white, and subtle metallic accents. Clean neutral palette.
LIGHTING: Cinematic recessed spotlights, warm ambient cove ceiling lighting casting a soft golden wash. Large floor-to-ceiling windows with sheer white curtains letting in abundant diffused natural daylight.
FURNITURE: A spacious comfortable sectional sofa in premium charcoal-gray or off-white Italian leather, a minimalist long marble coffee table, sleek metal-legged console table, modern geometric pendant light. Large glass windows with light frames showing a peaceful outdoor view.
VIBE: Sophisticated, expensive, understated luxury, hyper-detailed, photorealistic.`,

  italian: `MASTERPIECE ARCHITECTURE: Italian luxury modern living room (意式轻奢风格客厅). Elegant, refined, warm luxury.
MATERIALS: Rich walnut or dark oak wood floor, premium Italian marble accent wall, brass/gold metal details, velvet and leather upholstery.
COLORS: Deep espresso brown, warm gold, cream white, sage green accents. Warm rich color temperature.
LIGHTING: Dramatic warm golden ambient lighting from recessed ceiling spots and a stunning modern brass pendant chandelier. Warm cove lighting behind feature wall panels. Large windows with heavy linen curtains.
FURNITURE: A luxurious deep velvet or premium leather sofa in warm beige or deep emerald, brass-framed glass coffee table, marble side tables, large abstract art on wall, sculptural brass floor lamp. Tall indoor plant in brass pot.
VIBE: Warm, rich, luxurious, sophisticated, artistic, photorealistic.`,

  cream: `MASTERPIECE ARCHITECTURE: Elegant French warm creamy-style living room (温柔奶油风客厅) featuring authentic and realistic high-end furniture.
MATERIALS: Immaculate warm-white or ivory plaster wall panels with delicate classic mouldings, premium high-gloss pristine beige ceramic floor tiles reflecting soft light, fluffy cream-white plush area rug.
LIGHTING: Gentle, dreamy warm light glowing from wall-mounted brass glass sconces, a delicate brass glass pendant lamp, and ceiling spotlights casting soft focus. Sheer translucent white linen window curtains.
FURNITURE: A luxurious low-profile sofa with soft cream/beige leather headboard featuring vertical channel tufting (竖向拉扣), layered with fluffy white pillows, warm milk-tea colored cushions, and a soft cream wool knit throw blanket. Minimalist matte cream side tables with slender gold brass legs. Large glass windows with cream curtains.
VIBE: Extremely gentle, warm, quiet, romantic, luxurious, and cozy, marshmallow-like, photorealistic.`,

  "new-chinese": `MASTERPIECE ARCHITECTURE: High-End warm and elegant New Chinese Style Living Room (新中式风格客厅). Symmetrical, spacious layout.
MATERIALS: Light natural wood floors, premium warm oak and walnut wall paneling, elegant hollow wood grid screens (木格栅), warm plaster walls, sheer translucent linen curtains.
FURNITURE: A traditional-style solid wood sofa frame with plush cream-colored cushions and clean bolster cushions, a minimalist solid-wood coffee table, and classical rattan woven accent chairs. Traditional scroll ink painting on wall, warm rustic ceramic vase with plum blossoms, large lush potted indoor plant.
LIGHTING: Built-in ambient ceiling cove lighting casting a rich soft warm yellow glow, and a beautiful central bronze lantern/chandelier.
VIBE: Warm, serene, sophisticated, Zen, culturally rich, high-end residential, photorealistic.`,

  "wabi-sabi": `MASTERPIECE ARCHITECTURE: Elegant, quiet Wabi-Sabi style living room (侘寂风客厅) featuring authentic and realistic high-end residential furniture.
MATERIALS: Soft warm sand-beige textured clay plaster walls, warm natural wood floors, sheer translucent white linen window curtains, thick woven sand-beige wool blend area rug.
LIGHTING: Built-in soft warm glow from a modern minimalist rectangular hollow box fireplace with realistic yellow dancing flame, combined with gentle daylight filtering through large floor-to-ceiling glass sliding patio door.
FURNITURE: A highly comfortable, luxurious low-profile deep charcoal-gray/black textured fabric sofa, and a low chunky rectangular solid dark-wood coffee table. Side furniture includes a tall open dark-wood bookshelf filled with books and organic-shaped ceramic vessels, and a cozy single lounge armchair in light beige cotton linen. Large frameless abstract textured canvas painting in deep dark brown tones on wall.
VIBE: Extremely quiet, serene, peaceful, natural, and warm, photorealistic.`,

  american: `MASTERPIECE ARCHITECTURE: Warm classic American-style living room (经典美式客厅). Spacious, comfortable, traditional elegance.
MATERIALS: Warm honey-oak hardwood floors, soft cream-white or pale beige plaster walls, classic crown moulding and baseboard details, rich damask or floral patterned accent wallpaper on feature wall.
LIGHTING: Warm ambient lighting from classic brass chandelier with white fabric shades, wall-mounted brass sconces with warm golden glow, and generous natural daylight from large double-hung windows with layered curtains (sheer + heavy).
FURNITURE: A generously sized deep-seated traditional sofa in warm beige or muted floral patterned fabric with rolled arms and skirted base, classic mahogany coffee table with turned legs, traditional bookcase, vintage brass table lamp, rich oriental-style area rug in warm tones. Fresh flowers in ceramic vase.
VIBE: Warm, comfortable, classic, family-oriented, gracious, photorealistic.`,

  nordic: `MASTERPIECE ARCHITECTURE: Sun-drenched warm cozy Scandinavian living room (北欧风温润客厅) featuring authentic and realistic high-end residential furniture.
MATERIALS: Light natural white oak solid wood floors, flawless warm soft-white plastered walls, sheer translucent flowing white curtains, thick high-density off-white or oat-beige textured wool area rug.
LIGHTING: Abundant bright diffused natural daylight streaming from large glass sliding patio doors, combined with soft warm glow (2700K-3000K) from a classic floor lamp with a pleated cream lampshade. Minimal modern pendant light.
FURNITURE: A spacious comfortable L-shaped cream-colored or off-white fabric sofa, styled with sage-green, light gray and warm beige throw pillows and a textured white knit throw blanket. A minimalist long white-oak coffee table and a matching low wood TV media console on the side. Lush green houseplants including a tall potted indoor tree and small trailing plants.
VIBE: Extremely cozy, bright, serene, natural, healing, peaceful, and warm, photorealistic.`,

  minimal: `MASTERPIECE ARCHITECTURE: Ultra-minimalist monochrome black and white living room (极简黑白风格客厅). Stark, dramatic, gallery-like.
MATERIALS: Polished pure white marble floor slabs, stark white seamless plaster walls, black steel frame accents, matte black metal details.
LIGHTING: Precise, dramatic architectural lighting — clean recessed LED strip lighting casting sharp geometric shadows, single dramatic black pendant light, large floor-to-ceiling windows with no curtains showing urban skyline.
FURNITURE: A single pure-white or pure-black low-profile minimalist sofa with clean geometric lines and no visible cushion segmentation, a stark black steel-framed glass coffee table, a single large monochrome abstract art piece on wall, minimal black sculptural vase with single white branch.
VIBE: Dramatic, stark, pure, gallery-like, uncompromising, photorealistic.`
};
