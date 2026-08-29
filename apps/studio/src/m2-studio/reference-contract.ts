import {
  MESHY_STAGE_CREDITS,
  assetPlanSectionFor,
  type AssetPlanSection,
  type ConceptViewRole,
  type PlannedAsset,
  type VisualBible,
} from "@fulcrum/domain";

export type AssetClassification = AssetPlanSection;

export type GenerationPath = "image-refs" | "text-to-3d" | "procedural";

export type ReferenceViewSlot =
  | "front"
  | "back"
  | "left"
  | "right"
  | "playable-area-wide-shot"
  | "component-sheet"
  | "front-three-quarter"
  | "left-three-quarter"
  | "back-three-quarter"
  | "right-three-quarter"
  | "mood-reference";

export const VIEW_INSTRUCTIONS: Readonly<Record<ReferenceViewSlot, string>> = {
  front:
    "Render a straight-on orthographic front view with no perspective distortion and the complete silhouette visible.",
  back: "Render a straight-on orthographic back view with no perspective distortion and the complete silhouette visible.",
  left: "Render a straight-on orthographic left-side view with no perspective distortion and the complete silhouette visible.",
  right:
    "Render a straight-on orthographic right-side view with no perspective distortion and the complete silhouette visible.",
  "playable-area-wide-shot":
    "Render a wide establishing shot of the actual playable area, showing navigation space, boundaries, landmarks, gameplay scale, and clear sightlines.",
  "component-sheet":
    "Render an isolated component sheet with every reusable piece separated, evenly spaced, consistently scaled, and showing compatible connection points.",
  "front-three-quarter":
    "Render the isolated object from a front three-quarter turntable angle, with its complete form and construction clearly visible.",
  "left-three-quarter":
    "Render the isolated object from a left three-quarter turntable angle, with its complete form and construction clearly visible.",
  "back-three-quarter":
    "Render the isolated object from a back three-quarter turntable angle, with its complete form and construction clearly visible.",
  "right-three-quarter":
    "Render the isolated object from a right three-quarter turntable angle, with its complete form and construction clearly visible.",
  "mood-reference":
    "Render one clear implementation and mood reference at gameplay distance, emphasizing the intended visual result rather than a technical diagram.",
};

export const SHEET_CELL_ORDER = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
] as const;

const sheetCellLabel: Record<(typeof SHEET_CELL_ORDER)[number], string> = {
  "top-left": "Top-left",
  "top-right": "Top-right",
  "bottom-left": "Bottom-left",
  "bottom-right": "Bottom-right",
};

export const buildSheetInstruction = (
  slots: readonly ReferenceViewSlot[],
  labels: Readonly<Record<ReferenceViewSlot, string>>,
  canonicalSlot?: ReferenceViewSlot,
): string => {
  if (slots.length !== SHEET_CELL_ORDER.length)
    throw new Error("A reference sheet requires exactly four view slots.");

  const cellInstructions = SHEET_CELL_ORDER.map((cell, index) => {
    const slot = slots[index]!;
    return `${sheetCellLabel[cell]} cell: ${labels[slot]} view — ${VIEW_INSTRUCTIONS[slot]}`;
  }).join(" ");
  const canonicalCellIndex = canonicalSlot ? slots.indexOf(canonicalSlot) : -1;
  if (canonicalSlot && canonicalCellIndex < 0)
    throw new Error("The canonical slot must belong to the reference sheet.");
  const canonicalInstruction =
    canonicalCellIndex >= 0
      ? ` Image 1 is the canonical ${labels[canonicalSlot!]} view in the ${SHEET_CELL_ORDER[canonicalCellIndex]} cell; that cell must match Image 1 exactly.`
      : "";

  return `Compose ONE reference-sheet image with four views of the SAME subject in a strict 2-by-2 grid with cell boundaries at the exact horizontal and vertical midlines. ${cellInstructions} Keep the subject identical in every cell: same creature/object, same scale, same pose, same materials, same lighting. Center each view fully inside its cell with clear margin; nothing may cross a cell boundary or touch the image edge.${canonicalInstruction}`;
};

export type StyleContext = Pick<
  VisualBible,
  "palette" | "lighting" | "atmosphere" | "materials" | "shapeLanguage"
>;

export type ReferenceUploadRules = {
  acceptedMimeTypes: readonly ["image/png", "image/jpeg", "image/webp"];
  allowMultiple: false;
  singleUpload: {
    canonicalSlot: ReferenceViewSlot;
    deriveRemainingViews: boolean;
  };
};

export type ReferenceTemplate = {
  classification: AssetClassification;
  requiredViewSlots: readonly ReferenceViewSlot[];
  uploadRules: ReferenceUploadRules;
  allowedGenerationPaths: readonly GenerationPath[];
  /** Subject only: what the asset is, its role, and the must-hold
   *  constraints. Never carries palette, lighting, or atmosphere — the style
   *  capsule is appended once at send time by composeImagegenPrompt. */
  buildSubjectPrompt: (asset: PlannedAsset) => string;
  buildMeshyTextPrompt:
    ((asset: PlannedAsset, styleContext: StyleContext) => string) | undefined;
};

export const MESHY_MODEL = "meshy-6" as const;
/* Meshy's real rate card lives in the domain package; the gate only renames
   the two stages it talks about rather than restating their prices. Both of
   these are charged by a staged route — geometry by `stages/start`, texture by
   the `texture` decision — which is the only reason the gate may print them.
   Nothing in the Images stage itself costs anything, so it names no figure. */
export const MESHY_GEOMETRY_PREVIEW_CREDITS = MESHY_STAGE_CREDITS.geometry;
export const MESHY_4K_TEXTURE_CREDITS = MESHY_STAGE_CREDITS.texture;

/**
 * The cardinal view each UI slot becomes on the way to Meshy.
 *
 * `multi-image-to-3d` knows four orthographic directions and nothing else, so
 * a prop's three-quarter turntable and a hero's orthographic sheet both land
 * in the same front/left/back/right vocabulary, and single-view templates give
 * up their one image as the front.
 */
export const CARDINAL_ROLE_FOR_SLOT: Readonly<
  Record<ReferenceViewSlot, ConceptViewRole>
> = {
  front: "front",
  back: "back",
  left: "left",
  right: "right",
  "front-three-quarter": "front",
  "left-three-quarter": "left",
  "back-three-quarter": "back",
  "right-three-quarter": "right",
  "playable-area-wide-shot": "front",
  "component-sheet": "front",
  "mood-reference": "front",
};

/** The inverse, within one template. Every template maps its slots to
 *  distinct roles, so this is unambiguous. */
export const slotForCardinalRole = (
  template: ReferenceTemplate,
  role: ConceptViewRole,
): ReferenceViewSlot | undefined =>
  template.requiredViewSlots.find(
    (slot) => CARDINAL_ROLE_FOR_SLOT[slot] === role,
  );

const acceptedMimeTypes = ["image/png", "image/jpeg", "image/webp"] as const;

const uploadRules = (
  canonicalSlot: ReferenceViewSlot,
  deriveRemainingViews: boolean,
): ReferenceUploadRules => ({
  acceptedMimeTypes,
  allowMultiple: false,
  singleUpload: { canonicalSlot, deriveRemainingViews },
});

export const assertValidReferenceUploadSelection = (
  rules: ReferenceUploadRules,
  files: readonly { type: string }[],
): void => {
  if (files.length !== 1)
    throw new Error("Select exactly one reference image.");
  if (!rules.acceptedMimeTypes.some((type) => type === files[0]!.type))
    throw new Error("Use a PNG, JPEG, or WebP image.");
};

const clean = (value: string): string => value.trim().replace(/\s+/g, " ");

/** The first sentence, unpunctuated. Rationales and acceptance criteria are
 *  written as paragraphs; only the opening claim survives into a prompt. */
const firstSentence = (value: string): string => {
  const text = clean(value);
  const match = /^[^.!?]*[.!?]/.exec(text);
  return (match ? match[0] : text).replace(/\s*[.!?]+$/, "");
};

/** Join parts in priority order and stop at the first one that does not fit.
 *  A prompt that overruns its budget is worse than one missing its last
 *  clause: the subject is what the model must actually read. */
const fitParts = (parts: readonly string[], limit: number): string => {
  const kept: string[] = [];
  let used = 0;
  for (const part of parts) {
    if (!part) continue;
    const cost = part.length + (kept.length > 0 ? 1 : 0);
    if (used + cost > limit) break;
    kept.push(part);
    used += cost;
  }
  if (kept.length > 0) return kept.join(" ");
  const head = parts.find(Boolean) ?? "";
  return `${head.slice(0, limit - 1).replace(/\s+\S*$/, "")}…`;
};

/** A subject brief states the asset, not the art direction. */
export const SUBJECT_PROMPT_MAX_CHARACTERS = 500;

/** The style capsule is the only place approved Color & Mood enters an
 *  ImageGen prompt. Long style paragraphs drown the subject, so the capsule
 *  stays at a few short sentences. */
export const STYLE_CAPSULE_MAX_CHARACTERS = 400;

/** More than three named colors reads as a spec sheet, not a direction. */
const CAPSULE_PALETTE_LIMIT = 3;

/** The must-hold constraints a subject brief carries. The full acceptance
 *  criteria stay in the asset brief above the composer, where they are read
 *  by a human rather than spent on the model's attention. */
const SUBJECT_CONSTRAINT_LIMIT = 2;

/**
 * The single Color & Mood formatter. Every ImageGen request in the Images
 * stage appends exactly this string, so a human-typed subject carries the
 * approved art direction as faithfully as a suggested one.
 */
export const buildStyleCapsule = (styleContext: StyleContext): string => {
  const palette = styleContext.palette
    .slice(0, CAPSULE_PALETTE_LIMIT)
    .map(({ name, hex, role }) => `${clean(name)} ${hex} (${clean(role)})`)
    .join(", ");
  return fitParts(
    [
      `Palette: ${palette}.`,
      `Lighting: ${firstSentence(styleContext.lighting)}.`,
      `Atmosphere: ${firstSentence(styleContext.atmosphere)}.`,
      `Shape language: ${firstSentence(styleContext.shapeLanguage)}.`,
    ],
    STYLE_CAPSULE_MAX_CHARACTERS,
  );
};

/**
 * The one place a subject and the approved style capsule become a request
 * prompt. Subject prompts never contain mood content, so this cannot
 * double-inject.
 */
export const composeImagegenPrompt = (
  subjectPrompt: string,
  styleCapsule: string,
): string => {
  const subject = clean(subjectPrompt);
  const capsule = clean(styleCapsule);
  if (!capsule) return subject;
  return `${subject}\n\n${capsule}`;
};

const assetRequirements = (asset: PlannedAsset): string => {
  const criteria = asset.acceptanceCriteria.map(clean).join("; ");
  return `Asset purpose: ${clean(asset.rationale)} Acceptance criteria: ${criteria}.`;
};

/** Kept for the Meshy text-to-3D path only, which is out of scope for the
 *  subject/capsule split. Follow-up: give the 3D prompt the same shape. */
const styleRules = (styleContext: StyleContext): string => {
  const palette = styleContext.palette
    .map(({ name, hex, role }) => `${name} ${hex} for ${role}`)
    .join(", ");
  return `Color and mood rules: palette ${palette}; lighting ${clean(styleContext.lighting)}; atmosphere ${clean(styleContext.atmosphere)}; materials ${styleContext.materials.map(clean).join(", ")}.`;
};

const subjectPrompt =
  (
    lead: (asset: PlannedAsset) => string,
  ): ReferenceTemplate["buildSubjectPrompt"] =>
  (asset) => {
    const constraints = asset.acceptanceCriteria
      .slice(0, SUBJECT_CONSTRAINT_LIMIT)
      .map(firstSentence)
      .filter(Boolean)
      .join("; ");
    return fitParts(
      [
        clean(lead(asset)),
        `Role: ${firstSentence(asset.rationale)}.`,
        constraints ? `Must hold: ${constraints}.` : "",
      ],
      SUBJECT_PROMPT_MAX_CHARACTERS,
    );
  };

const meshyPrompt =
  (
    lead: (asset: PlannedAsset) => string,
  ): NonNullable<ReferenceTemplate["buildMeshyTextPrompt"]> =>
  (asset, styleContext) =>
    `${lead(asset)} ${assetRequirements(asset)} ${styleRules(styleContext)}`;

export const REFERENCE_TEMPLATES: Readonly<
  Record<AssetClassification, ReferenceTemplate>
> = {
  hero: {
    classification: "hero",
    requiredViewSlots: ["front", "back", "left", "right"],
    uploadRules: uploadRules("front", true),
    allowedGenerationPaths: ["image-refs", "text-to-3d"],
    buildSubjectPrompt: subjectPrompt(
      (asset) =>
        `Four orthographic references of ${clean(asset.name)} — front, back, left, right — identical silhouette, proportions, and${asset.poseMode ? ` ${asset.poseMode}` : " neutral"} pose in every view, on a clean neutral background.`,
    ),
    buildMeshyTextPrompt: meshyPrompt(
      (asset) =>
        `Create a production-ready, fully modeled 3D hero asset for ${clean(asset.name)}${asset.poseMode ? ` in a ${asset.poseMode}` : " in a neutral pose"}. Preserve a readable silhouette and consistent proportions on every side.`,
    ),
  },
  environment: {
    classification: "environment",
    requiredViewSlots: ["playable-area-wide-shot"],
    uploadRules: uploadRules("playable-area-wide-shot", false),
    allowedGenerationPaths: ["image-refs", "text-to-3d"],
    buildSubjectPrompt: subjectPrompt(
      (asset) =>
        `One wide establishing view of the playable area of ${clean(asset.name)}, showing navigation space, boundaries, landmarks, and player sightlines at true gameplay scale. Not a distant beauty shot.`,
    ),
    buildMeshyTextPrompt: meshyPrompt(
      (asset) =>
        `Create a production-ready 3D playable environment for ${clean(asset.name)}. Model the navigable area, boundaries, landmarks, and gameplay-readable sightlines at a coherent player scale.`,
    ),
  },
  "modular-kit": {
    classification: "modular-kit",
    requiredViewSlots: ["component-sheet"],
    uploadRules: uploadRules("component-sheet", false),
    allowedGenerationPaths: ["image-refs", "text-to-3d"],
    buildSubjectPrompt: subjectPrompt(
      (asset) =>
        `An isolated component sheet for ${clean(asset.name)}: every reusable piece laid out separately at consistent scale with visible connection points. No assembled scene, people, or labels.`,
    ),
    buildMeshyTextPrompt: meshyPrompt(
      (asset) =>
        `Create a production-ready 3D modular kit for ${clean(asset.name)}. Keep pieces separate, consistently scaled, reusable, and aligned to compatible connection points.`,
    ),
  },
  prop: {
    classification: "prop",
    requiredViewSlots: [
      "front-three-quarter",
      "left-three-quarter",
      "back-three-quarter",
      "right-three-quarter",
    ],
    uploadRules: uploadRules("front-three-quarter", true),
    allowedGenerationPaths: ["image-refs", "text-to-3d"],
    buildSubjectPrompt: subjectPrompt(
      (asset) =>
        `Four three-quarter turntable references of ${clean(asset.name)} — front, left, back, right — identical geometry, scale, and orientation in every view, on a clean neutral background.`,
    ),
    buildMeshyTextPrompt: meshyPrompt(
      (asset) =>
        `Create a production-ready 3D prop for ${clean(asset.name)}. Model the complete object with coherent scale, readable construction, and consistent detail on every side.`,
    ),
  },
  "procedural-reference": {
    classification: "procedural-reference",
    requiredViewSlots: ["mood-reference"],
    uploadRules: uploadRules("mood-reference", false),
    allowedGenerationPaths: ["procedural"],
    buildSubjectPrompt: subjectPrompt((asset) => {
      const procedure = asset.procedure
        ? `, generated by ${clean(asset.procedure.generatorId)}`
        : "";
      return `One implementation reference for ${clean(asset.name)}${procedure}, at gameplay distance. Show the intended result, not a technical diagram or a labeled sheet.`;
    }),
    buildMeshyTextPrompt: undefined,
  },
};

export const classifyAsset = (asset: PlannedAsset): AssetClassification =>
  assetPlanSectionFor(asset);

export const referenceTemplateFor = (asset: PlannedAsset): ReferenceTemplate =>
  REFERENCE_TEMPLATES[classifyAsset(asset)];

/** Whether this asset ever reaches Meshy at all. Procedural and functional
 *  work is built by the coding agent from one reference and never spends. */
export const isMeshyRouted = (asset: PlannedAsset): boolean =>
  asset.classification === "hero" || asset.classification === "kit";

export type ReferenceImage = {
  slot: ReferenceViewSlot;
  uri: string;
  source: "generated" | "uploaded";
};

export type UnresolvedAssetResolution = {
  status: "unresolved";
};

export type InProgressAssetResolution = {
  status: "in-progress";
  path: GenerationPath;
};

/**
 * Resolution is free.
 *
 * Approving a reference set persists what Meshy will be shown; approving a
 * text prompt records what a human wrote. Neither one submits anything or
 * moves a credit — the staged card's geometry button is the first spend — so
 * there is no acknowledgment step here to invent a price for.
 */
export type ApprovedReferencesResolution = {
  status: "resolved";
  kind: "approved-references";
  path: "image-refs";
  references: readonly ReferenceImage[];
  meshyModel: typeof MESHY_MODEL;
};

export type ApprovedTextPromptResolution = {
  status: "resolved";
  kind: "approved-text-prompt";
  path: "text-to-3d";
  prompt: string;
  meshyModel: typeof MESHY_MODEL;
};

export type ApprovedProceduralReferenceResolution = {
  status: "resolved";
  kind: "approved-procedural-reference";
  path: "procedural";
  reference: ReferenceImage;
};

export type ResolvedAssetResolution =
  | ApprovedReferencesResolution
  | ApprovedTextPromptResolution
  | ApprovedProceduralReferenceResolution;

export type AssetResolution =
  | UnresolvedAssetResolution
  | InProgressAssetResolution
  | ResolvedAssetResolution;

export type AssetResolutionEvent =
  | { type: "start"; path: GenerationPath }
  | { type: "approve-references"; references: readonly ReferenceImage[] }
  | { type: "approve-text-prompt"; prompt: string }
  | { type: "approve-procedural-reference"; reference: ReferenceImage };

const assertCompleteReferenceSet = (
  template: ReferenceTemplate,
  references: readonly ReferenceImage[],
): void => {
  const actualSlots = new Set(references.map(({ slot }) => slot));
  const expectedSlots = new Set(template.requiredViewSlots);
  if (
    actualSlots.size !== references.length ||
    actualSlots.size !== expectedSlots.size ||
    [...expectedSlots].some((slot) => !actualSlots.has(slot))
  )
    throw new Error(
      "Approved references must fill every required view exactly once.",
    );

  const uniqueUris = new Set(references.map(({ uri }) => uri));
  if (uniqueUris.size !== references.length)
    throw new Error("Every required view must use a unique image URI.");
};

export const transitionAssetResolution = (
  asset: PlannedAsset,
  resolution: AssetResolution,
  event: AssetResolutionEvent,
): AssetResolution => {
  const template = referenceTemplateFor(asset);

  if (resolution.status === "resolved")
    throw new Error("A resolved asset cannot transition again.");

  if (resolution.status === "unresolved") {
    if (event.type !== "start")
      throw new Error(
        "An unresolved asset must start a generation path first.",
      );
    if (!template.allowedGenerationPaths.includes(event.path))
      throw new Error(
        `${template.classification} assets do not allow the ${event.path} path.`,
      );
    return { status: "in-progress", path: event.path };
  }

  if (event.type === "start")
    throw new Error("An in-progress asset already has a generation path.");

  if (resolution.path === "image-refs" && event.type === "approve-references") {
    assertCompleteReferenceSet(template, event.references);
    return {
      status: "resolved",
      kind: "approved-references",
      path: "image-refs",
      references: [...event.references],
      meshyModel: MESHY_MODEL,
    };
  }

  if (
    resolution.path === "text-to-3d" &&
    event.type === "approve-text-prompt"
  ) {
    const prompt = clean(event.prompt);
    if (!prompt) throw new Error("The approved Meshy prompt cannot be empty.");
    return {
      status: "resolved",
      kind: "approved-text-prompt",
      path: "text-to-3d",
      prompt,
      meshyModel: MESHY_MODEL,
    };
  }

  if (
    resolution.path === "procedural" &&
    event.type === "approve-procedural-reference"
  ) {
    assertCompleteReferenceSet(template, [event.reference]);
    return {
      status: "resolved",
      kind: "approved-procedural-reference",
      path: "procedural",
      reference: event.reference,
    };
  }

  throw new Error(
    `The ${event.type} event does not match the ${resolution.path} path.`,
  );
};
