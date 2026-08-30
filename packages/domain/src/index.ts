import { z } from "zod";

export const M0_FIXTURE_BRIEF =
  "Create a stylized third-person fantasy extraction arena centered on an ancient stone reliquary. The reliquary is a squat, readable hero prop made from weathered dark stone, restrained bronze bands, and a cyan crystal core. The visual language is painterly and hand-sculpted rather than photoreal. The arena should make the reliquary feel important, mysterious, and visible from across the play space.";

export const ProviderModeSchema = z.enum(["replay", "live"]);
export type ProviderMode = z.infer<typeof ProviderModeSchema>;

export const MilestoneSchema = z.enum(["m0", "m1", "m2"]);
export type Milestone = z.infer<typeof MilestoneSchema>;

export const AssetProviderSchema = z.enum(["meshy", "tripo"]);
export type AssetProvider = z.infer<typeof AssetProviderSchema>;

export const ExecutionProviderSchema = z.enum([
  "claude",
  "openai",
  "openai-api",
  "grok",
  "opencode",
]);
export type ExecutionProvider = z.infer<typeof ExecutionProviderSchema>;

export const ImageProviderSchema = z.enum([
  "openai-subscription",
  "openai-gpt-image-2",
  "custom-api",
  "none",
]);
export type ImageProvider = z.infer<typeof ImageProviderSchema>;

export const SoundProviderSchema = z.enum(["elevenlabs", "none"]);
export type SoundProvider = z.infer<typeof SoundProviderSchema>;

export type ProjectRouting = {
  mode: ProviderMode;
  orchestratorProvider: ExecutionProvider;
  implementationProvider: ExecutionProvider;
  imageProvider: ImageProvider;
  soundProvider: SoundProvider;
};

export type ProjectBudgetRouting = ProjectRouting & {
  milestone: Milestone;
};

export const isMeteredExecutionProvider = (
  provider: ExecutionProvider,
): boolean => provider === "openai-api";

/**
 * Orchestrator routes that can actually read an attached image.
 *
 * `openai-api` sends `input_image` parts on the Responses API and `openai`
 * (the signed-in Codex CLI) takes `--image` files. The other three execution
 * providers are text-only stdin pipes here, so an image handed to them would
 * be silently dropped — which is why this predicate exists rather than an
 * optimistic assumption. Replay never calls a provider at all.
 */
export const readsImageAttachments = (provider: ExecutionProvider): boolean =>
  provider === "openai" || provider === "openai-api";

/**
 * Whether an image pasted into a free-text box on this project will be seen
 * by the model that answers it. False is not a failure: the attachment is
 * still stored against the project, it just does not reach a provider, and
 * the studio says so rather than implying vision it does not have.
 */
export const attachmentsReachOrchestrator = (routing: {
  mode: ProviderMode;
  orchestratorProvider: ExecutionProvider;
}): boolean =>
  routing.mode === "live" &&
  readsImageAttachments(routing.orchestratorProvider);

export const isMeteredImageProvider = (provider: ImageProvider): boolean =>
  provider === "openai-gpt-image-2" || provider === "custom-api";

export const isMeteredSoundProvider = (provider: SoundProvider): boolean =>
  provider === "elevenlabs";

/**
 * A project budget caps provider routes billed per call. Subscription and
 * local routes never participate, even when an older snapshot carries a
 * legacy budget value.
 */
export const hasMeteredRoutes = (routing: ProjectRouting): boolean =>
  routing.mode === "live" &&
  (isMeteredExecutionProvider(routing.orchestratorProvider) ||
    isMeteredExecutionProvider(routing.implementationProvider) ||
    isMeteredImageProvider(routing.imageProvider) ||
    isMeteredSoundProvider(routing.soundProvider));

export const projectNeedsBudget = (project: ProjectBudgetRouting): boolean =>
  project.milestone === "m0" || hasMeteredRoutes(project);

export const projectNeedsMeshyCredits = (project: {
  milestone: Milestone;
  mode: ProviderMode;
  assetProvider?: AssetProvider;
}): boolean =>
  project.milestone === "m2" &&
  project.mode === "live" &&
  (project.assetProvider ?? "meshy") === "meshy";

export const SOUND_PROMPT_MAX = 450;

export const ProjectStageSchema = z.enum([
  "creative-development",
  "interrogation",
  "game-design-approval",
  "visual-direction-generation",
  "visual-direction-approval",
  "concept-planning",
  "concept-generation",
  "concept-set-approval",
  "sound-planning",
  "sound-generation",
  "sound-set-approval",
  "asset-planning",
  "asset-plan-approval",
  "asset-batch",
  "asset-production",
  "asset-quality",
  "scene-composition",
  "visual-slice-approval",
  "complete",
  "blocked",
]);
export type ProjectStage = z.infer<typeof ProjectStageSchema>;

export const ProjectStatusSchema = z.enum([
  "active",
  "awaiting-input",
  "awaiting-approval",
  "blocked",
  "complete",
]);
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

export const ArtifactRefSchema = z.object({
  artifactId: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mediaType: z.string().min(1),
  byteLength: z.number().int().nonnegative(),
  uri: z.string().min(1),
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

export const RevisionRefSchema = z.object({
  entityId: z.string().min(1),
  revisionId: z.string().min(1),
  kind: z.string().min(1),
  artifact: ArtifactRefSchema,
  createdAt: z.string().datetime(),
  createdByRunId: z.string().min(1),
});
export type RevisionRef = z.infer<typeof RevisionRefSchema>;

export const InformationOriginSchema = z.object({
  source: z.enum(["brief", "user", "research", "fulcrum"]),
  reference: z.string().min(1).optional(),
});
export type InformationOrigin = z.infer<typeof InformationOriginSchema>;

export const InterrogationQuestionSchema = z.object({
  questionId: z.string().min(1),
  branchId: z.string().min(1),
  prompt: z.string().min(1),
  recommendation: z.string().min(1),
});
export type InterrogationQuestion = z.infer<typeof InterrogationQuestionSchema>;

/** Images pasted into a free-text box. Every attachment is normalized to PNG
 *  and stored in the canonical artifact store, so the bytes — not a per-run
 *  id — are its identity and the same screenshot pasted twice is one file. */
export const MAX_IMAGE_ATTACHMENTS = 4;
export const MAX_IMAGE_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const IMAGE_ATTACHMENT_DATA_URL_PATTERN =
  /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

export const StoreImageAttachmentInputSchema = z.object({
  dataUrl: z.string().regex(IMAGE_ATTACHMENT_DATA_URL_PATTERN),
});
export type StoreImageAttachmentInput = z.infer<
  typeof StoreImageAttachmentInputSchema
>;

export const StoredImageAttachmentSchema = z.object({
  attachment: ArtifactRefSchema,
  /** Honest routing answer, decided by the project, not by the browser:
   *  false means the image is kept but no model will look at it. */
  reachesModel: z.boolean(),
});
export type StoredImageAttachment = z.infer<typeof StoredImageAttachmentSchema>;

export const ImageAttachmentListSchema = z
  .array(ArtifactRefSchema)
  .max(MAX_IMAGE_ATTACHMENTS);

export const AttachmentArtifactIdsSchema = z
  .array(z.string().min(1))
  .max(MAX_IMAGE_ATTACHMENTS);

export const InterrogationAnswerSchema = z.object({
  questionId: z.string().min(1),
  value: z.string().min(1),
  origin: InformationOriginSchema,
  /* Optional, not defaulted: an answer with no pictures keeps exactly the
     bytes it had before attachments existed, so replay revisions stay
     byte-identical to earlier runs of the same brief. */
  attachments: ImageAttachmentListSchema.optional(),
});
export type InterrogationAnswer = z.infer<typeof InterrogationAnswerSchema>;

export const InterrogationRoundSchema = z.object({
  roundId: z.string().min(1),
  questions: z.array(InterrogationQuestionSchema).min(1),
  answers: z.array(InterrogationAnswerSchema),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
});
export type InterrogationRound = z.infer<typeof InterrogationRoundSchema>;

export const SharedUnderstandingConfirmationSchema = z.object({
  confirmed: z.literal(true),
  confirmedBy: z.string().min(1),
  confirmedAt: z.string().datetime(),
});
export type SharedUnderstandingConfirmation = z.infer<
  typeof SharedUnderstandingConfirmationSchema
>;

export const InterrogationStateSchema = z.object({
  rounds: z.array(InterrogationRoundSchema),
  frontier: z.array(InterrogationQuestionSchema),
  sharedUnderstanding: SharedUnderstandingConfirmationSchema.optional(),
});
export type InterrogationState = z.infer<typeof InterrogationStateSchema>;

export const GameDesignDigestSchema = z.object({
  title: z.string().min(1),
  genre: z.string().min(1),
  camera: z.string().min(1),
  coreFantasy: z.string().min(1),
  coreLoop: z.array(z.string().min(1)).min(1),
  playerVerbs: z.array(z.string().min(1)).min(1),
  objective: z.string().min(1),
  sessionMinutes: z.number().int().positive(),
  gameplayConstraints: z.array(z.string().min(1)),
  assumptions: z.array(z.string().min(1)),
});
export type GameDesignDigest = z.infer<typeof GameDesignDigestSchema>;

export const DesignStatementSchema = z.object({
  statementId: z.string().min(1),
  text: z.string().min(1),
  kind: z.enum(["fact", "assumption"]),
  origin: InformationOriginSchema,
});
export type DesignStatement = z.infer<typeof DesignStatementSchema>;

export const GameDesignSpecSchema = GameDesignDigestSchema.omit({
  assumptions: true,
}).extend({
  facts: z.array(DesignStatementSchema.extend({ kind: z.literal("fact") })),
  assumptions: z.array(
    DesignStatementSchema.extend({ kind: z.literal("assumption") }),
  ),
});
export type GameDesignSpec = z.infer<typeof GameDesignSpecSchema>;

/* ---------- the game name decider ----------
   A game's name is part of its identity, so Fulcrum proposes and the human
   decides. Candidates are drafted from the signed-off interrogation record,
   steered by free-text feedback as many times as the human wants, and the
   committed decision is what the Game Design Spec is titled with. */

export const GAME_NAME_CANDIDATE_COUNT = 4;
export const GAME_NAME_MAX_CHARS = 60;
export const GAME_NAME_FEEDBACK_MAX_CHARS = 500;

export const GameNameCandidateSchema = z.object({
  candidateId: z.string().min(1),
  name: z.string().trim().min(2).max(GAME_NAME_MAX_CHARS),
  rationale: z.string().trim().min(1).max(240),
});
export type GameNameCandidate = z.infer<typeof GameNameCandidateSchema>;

export const GameNameCandidateSetSchema = z.object({
  candidateSetId: z.string().min(1),
  /** 1 for the first batch; each steered batch is one more round. */
  round: z.number().int().positive(),
  /** The steer that produced this batch. Absent on the first one. */
  feedback: z
    .string()
    .trim()
    .min(1)
    .max(GAME_NAME_FEEDBACK_MAX_CHARS)
    .optional(),
  candidates: z.array(GameNameCandidateSchema).min(3).max(6),
  sourceInterrogationRevisionId: z.string().min(1),
  previousCandidateSetRevisionId: z.string().min(1).optional(),
  /** "replay" or the execution provider that drafted the batch. */
  provider: z.string().min(1),
});
export type GameNameCandidateSet = z.infer<typeof GameNameCandidateSetSchema>;

export const GameNameDecisionSchema = z
  .object({
    name: z.string().trim().min(2).max(GAME_NAME_MAX_CHARS),
    origin: z.enum(["candidate", "custom"]),
    candidateId: z.string().min(1).optional(),
    sourceCandidateSetRevisionId: z.string().min(1),
    /** How many batches the conversation took before this name won. */
    rounds: z.number().int().positive(),
    decidedBy: z.string().min(1),
    decidedAt: z.string().datetime(),
  })
  .superRefine((decision, context) => {
    if (
      (decision.origin === "candidate") !==
      (decision.candidateId !== undefined)
    )
      context.addIssue({
        code: "custom",
        path: ["candidateId"],
        message:
          "A chosen candidate carries its candidate ID; a typed name carries none.",
      });
  });
export type GameNameDecision = z.infer<typeof GameNameDecisionSchema>;

export const PaletteTokenSchema = z.object({
  name: z.string().min(1),
  hex: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  role: z.string().min(1),
});

export const VisualBibleSchema = z.object({
  title: z.string().min(1),
  overallStyle: z.string().min(1),
  shapeLanguage: z.string().min(1),
  architecture: z.string().min(1),
  heroProp: z.string().min(1),
  materials: z.array(z.string().min(1)).min(1),
  palette: z.array(PaletteTokenSchema).min(3),
  lighting: z.string().min(1),
  atmosphere: z.string().min(1),
  cameraLanguage: z.string().min(1),
  textureLanguage: z.string().min(1),
  readabilityRules: z.array(z.string().min(1)).min(1),
  prohibitedStyles: z.array(z.string().min(1)),
});
export type VisualBible = z.infer<typeof VisualBibleSchema>;

export const VisualTokenSchema = z.object({
  tokenId: z.string().min(1),
  category: z.enum([
    "style",
    "project-world",
    "prohibited-style",
    "shape",
    "silhouette",
    "palette",
    "gameplay-color",
    "material",
    "surface",
    "lighting",
    "atmosphere",
    "camera",
    "scale",
    "readability",
    "vfx",
  ]),
  value: z.string().min(1),
  role: z.string().min(1).optional(),
});
export type VisualToken = z.infer<typeof VisualTokenSchema>;

export const StructuredVisualBibleSchema = VisualBibleSchema.extend({
  tokens: z.array(VisualTokenSchema).min(1),
});
export type StructuredVisualBible = z.infer<typeof StructuredVisualBibleSchema>;

export const PreviewArtifactSchema = z.object({
  artifact: ArtifactRefSchema,
  sourceGameDesignRevisionId: z.string().min(1),
  sourceVisualBibleRevisionId: z.string().min(1),
});
export type PreviewArtifact = z.infer<typeof PreviewArtifactSchema>;

export const VisualDirectionSchema = z.object({
  directionId: z.string().min(1),
  revisionId: z.string().min(1),
  name: z.string().min(1),
  rationale: z.string().min(1),
  visualBible: StructuredVisualBibleSchema,
  preview: PreviewArtifactSchema,
});
export type VisualDirection = z.infer<typeof VisualDirectionSchema>;

export const VisualDirectionSetSchema = z.object({
  directionSetId: z.string().min(1),
  directions: z.tuple([
    VisualDirectionSchema,
    VisualDirectionSchema,
    VisualDirectionSchema,
  ]),
});
export type VisualDirectionSet = z.infer<typeof VisualDirectionSetSchema>;

export const CreativeOutputSchema = z.object({
  gameDesign: GameDesignDigestSchema,
  visualBible: VisualBibleSchema,
});
export type CreativeOutput = z.infer<typeof CreativeOutputSchema>;

export const ConceptDocumentSchema = z.object({
  conceptId: z.string().min(1),
  name: z.string().min(1),
  prompt: z.string().min(1),
  negativePrompt: z.string(),
  image: ArtifactRefSchema,
  provider: z.string().min(1),
  model: z.string().min(1),
  sourceRevisionIds: z.array(z.string().min(1)).min(2),
  costUsd: z.number().nonnegative(),
});
export type ConceptDocument = z.infer<typeof ConceptDocumentSchema>;

export const RevisionAncestorSchema = z.object({
  revisionId: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  kind: z.string().min(1),
});
export type RevisionAncestor = z.infer<typeof RevisionAncestorSchema>;

/** M1 provenance contract; the M0 ConceptDocument remains unchanged. */
export const M1ConceptDocumentSchema = ConceptDocumentSchema.extend({
  ancestors: z.array(RevisionAncestorSchema).min(2),
  /** Confirmed ImageGen base prompt without a regeneration note. Optional for
   *  documents written before plan-time prompts existed. */
  basePrompt: z.string().min(1).optional(),
});
export type M1ConceptDocument = z.infer<typeof M1ConceptDocumentSchema>;

export const ConceptRevisionSchema = z.object({
  revision: RevisionRefSchema,
  inheritedVisualTokens: z.array(VisualTokenSchema).min(1),
  staleReason: z.string().min(1).optional(),
});
export type ConceptRevision = z.infer<typeof ConceptRevisionSchema>;

/** Hard cap on any ImageGen prompt, stored or overridden. Assemblers must
 *  fit within it — live specs write token values long enough to blow past
 *  it when stitched naively. */
export const CONCEPT_PROMPT_MAX_CHARS = 4000;

export const ConceptPlanSlotSchema = z.object({
  slotId: z.string().min(1),
  name: z.string().min(1),
  purpose: z.string().min(1),
  tokenCategories: z.array(VisualTokenSchema.shape.category).min(1),
  /** Exact ImageGen prompt assembled at plan time. Optional so persisted
   *  revisions from existing projects still parse. */
  prompt: z.string().min(1).max(CONCEPT_PROMPT_MAX_CHARS).optional(),
});
export type ConceptPlanSlot = z.infer<typeof ConceptPlanSlotSchema>;

export const ConceptPlanSchema = z.object({
  sourceGameDesignRevisionId: z.string().min(1),
  sourceDirectionRevisionId: z.string().min(1),
  slots: z.array(ConceptPlanSlotSchema).min(1).max(3),
});
export type ConceptPlan = z.infer<typeof ConceptPlanSchema>;

export const ConceptSlotSchema = z.object({
  slotId: z.string().min(1),
  name: z.string().min(1),
  purpose: z.string().min(1),
  revisions: z.array(ConceptRevisionSchema).min(1),
  selectedRevisionId: z.string().min(1).optional(),
});
export type ConceptSlot = z.infer<typeof ConceptSlotSchema>;

export const ConceptSetSchema = z.object({
  conceptSetId: z.string().min(1),
  sourceDirectionRevisionId: z.string().min(1),
  slots: z.array(ConceptSlotSchema).min(1).max(3),
});
export type ConceptSet = z.infer<typeof ConceptSetSchema>;

export const SoundPlanSlotSchema = z.object({
  slotId: z.string().min(1),
  title: z.string().min(1),
  purpose: z.string().min(1),
  prompt: z.string().min(1).max(SOUND_PROMPT_MAX),
  durationSeconds: z.number().gte(0.5).lte(22),
  loop: z.boolean(),
});
export type SoundPlanSlot = z.infer<typeof SoundPlanSlotSchema>;

export const SoundPlanSchema = z.object({
  sourceGameDesignRevisionId: z.string().min(1),
  sourceDirectionRevisionId: z.string().min(1),
  slots: z.array(SoundPlanSlotSchema).min(4).max(6),
});
export type SoundPlan = z.infer<typeof SoundPlanSchema>;

export const SoundDocumentSchema = z.object({
  soundId: z.string().min(1),
  slotId: z.string().min(1),
  title: z.string().min(1),
  basePrompt: z.string().min(1).max(SOUND_PROMPT_MAX),
  prompt: z.string().min(1).max(2_000),
  durationSeconds: z.number().gte(0.5).lte(22),
  loop: z.boolean(),
  audio: ArtifactRefSchema,
  provider: z.string().min(1),
  model: z.string().min(1),
  promptHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceRevisionIds: z.array(z.string().min(1)).min(1),
  costUsd: z.number().nonnegative(),
});
export type SoundDocument = z.infer<typeof SoundDocumentSchema>;

export const SoundRevisionSchema = z.object({
  revision: RevisionRefSchema,
  staleReason: z.string().min(1).optional(),
});
export type SoundRevision = z.infer<typeof SoundRevisionSchema>;

export const SoundSlotSchema = z.object({
  slotId: z.string().min(1),
  title: z.string().min(1),
  purpose: z.string().min(1),
  revisions: z.array(SoundRevisionSchema).min(1),
  selectedRevisionId: z.string().min(1).optional(),
});
export type SoundSlot = z.infer<typeof SoundSlotSchema>;

export const SoundSetSchema = z.object({
  soundSetId: z.string().min(1),
  sourceSoundPlanRevisionId: z.string().min(1),
  sourceDirectionRevisionId: z.string().min(1),
  slots: z.array(SoundSlotSchema).min(4).max(6),
});
export type SoundSet = z.infer<typeof SoundSetSchema>;

export const AssetClassificationSchema = z.enum([
  "hero",
  "kit",
  "procedural",
  "functional",
]);
export type AssetClassification = z.infer<typeof AssetClassificationSchema>;

/** The five sections the staged asset gate exposes to a human. The persisted
 * planner classification is intentionally coarser: hero assets include
 * characters, environments and props, while procedural references cover both
 * procedural and runtime-authored work. */
export const AssetPlanSectionSchema = z.enum([
  "hero",
  "environment",
  "modular-kit",
  "prop",
  "procedural-reference",
]);
export type AssetPlanSection = z.infer<typeof AssetPlanSectionSchema>;

export const ConceptViewRoleSchema = z.enum(["front", "left", "back", "right"]);
export type ConceptViewRole = z.infer<typeof ConceptViewRoleSchema>;

const ConceptViewGuidanceBaseSchema = z.object({
  elevationDegrees: z.literal(0),
  projection: z.literal("orthographic"),
  framing: z.literal("full-subject-centered"),
  background: z.literal("neutral-studio"),
});

export const ConceptViewGuidanceSchema = z.discriminatedUnion("role", [
  ConceptViewGuidanceBaseSchema.extend({
    role: z.literal("front"),
    azimuthDegrees: z.literal(0),
  }),
  ConceptViewGuidanceBaseSchema.extend({
    role: z.literal("left"),
    azimuthDegrees: z.literal(90),
  }),
  ConceptViewGuidanceBaseSchema.extend({
    role: z.literal("back"),
    azimuthDegrees: z.literal(180),
  }),
  ConceptViewGuidanceBaseSchema.extend({
    role: z.literal("right"),
    azimuthDegrees: z.literal(270),
  }),
]);
export type ConceptViewGuidance = z.infer<typeof ConceptViewGuidanceSchema>;

export const ConceptViewDocumentSchema = z.object({
  conceptViewId: z.string().min(1),
  assetId: z.string().min(1),
  guidance: ConceptViewGuidanceSchema,
  attempt: z.number().int().nonnegative(),
  prompt: z.string().min(1).max(CONCEPT_PROMPT_MAX_CHARS),
  promptHash: z.string().regex(/^[a-f0-9]{64}$/),
  image: ArtifactRefSchema,
  provider: z.string().min(1),
  model: z.string().min(1),
  providerVersion: z.string().min(1).optional(),
  seed: z.string().min(1).optional(),
  costUsd: z.number().nonnegative(),
  sourceConceptRevisionId: z.string().min(1),
  sourceRevisionIds: z.array(z.string().min(1)).min(3),
  ancestors: z.array(RevisionAncestorSchema).min(3),
  referenceArtifactHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1),
  operation: z.literal("identity-preserving-concept-view"),
});
export type ConceptViewDocument = z.infer<typeof ConceptViewDocumentSchema>;

export const MultiviewConceptSetViewSchema = z.object({
  role: ConceptViewRoleSchema,
  guidance: ConceptViewGuidanceSchema,
  revision: RevisionRefSchema,
  image: ArtifactRefSchema,
});

export const MultiviewConceptSetSchema = z
  .object({
    multiviewConceptSetId: z.string().min(1),
    assetId: z.string().min(1),
    sourceAssetPlanRevisionId: z.string().min(1),
    sourceConceptSetRevisionId: z.string().min(1),
    anchorConcept: z.object({
      revision: RevisionRefSchema,
      image: ArtifactRefSchema,
    }),
    previousMultiviewConceptSetRevisionId: z.string().min(1).optional(),
    strategyRevisionId: z.string().min(1).optional(),
    views: z.array(MultiviewConceptSetViewSchema).min(2).max(4),
    sourceRevisionIds: z.array(z.string().min(1)).min(3),
  })
  .superRefine((set, context) => {
    const roles = set.views.map(({ role }) => role);
    if (new Set(roles).size !== roles.length) {
      context.addIssue({
        code: "custom",
        path: ["views"],
        message: "A multiview set cannot repeat a view role.",
      });
    }
    if (!roles.includes("front")) {
      context.addIssue({
        code: "custom",
        path: ["views"],
        message: "A provider-ready multiview set requires a front view.",
      });
    }
    set.views.forEach((view, index) => {
      if (view.role !== view.guidance.role) {
        context.addIssue({
          code: "custom",
          path: ["views", index, "guidance", "role"],
          message: "The entry role and guidance role must match.",
        });
      }
    });
  });
export type MultiviewConceptSet = z.infer<typeof MultiviewConceptSetSchema>;

/**
 * The reference views a human approved for one planned asset in the Images
 * stage, in cardinal order.
 *
 * This is the durable answer to "what will Meshy actually see". Approving a
 * set spends nothing — the staged gate's geometry button is the first thing
 * that costs credits — but it is the only input the geometry request has, so
 * it is stored as an owned, content-addressed revision rather than left in a
 * browser tab as a blob URL.
 */
export const MAX_ASSET_REFERENCE_VIEWS = 4;
/** Total decoded bytes across one approved set. Four 8 MB views would not fit
 *  under the orchestrator's 12 MB body limit, so the set has its own ceiling
 *  and can say so instead of failing as a truncated request. */
export const MAX_ASSET_REFERENCE_SET_BYTES = 8 * 1024 * 1024;

export const AssetReferenceViewSchema = z.object({
  role: ConceptViewRoleSchema,
  source: z.enum(["generated", "uploaded"]),
  image: ArtifactRefSchema,
});
export type AssetReferenceView = z.infer<typeof AssetReferenceViewSchema>;

const assertCardinalViewRoles = (
  views: readonly { role: ConceptViewRole }[],
  context: z.RefinementCtx,
) => {
  const roles = views.map(({ role }) => role);
  if (new Set(roles).size !== roles.length)
    context.addIssue({
      code: "custom",
      path: ["views"],
      message: "An approved reference set cannot repeat a view role.",
    });
  if (!roles.includes("front"))
    context.addIssue({
      code: "custom",
      path: ["views"],
      message: "An approved reference set requires a front view.",
    });
};

export const AssetReferenceSetSchema = z
  .object({
    assetId: z.string().min(1),
    /** The plan revision the asset belonged to when the set was approved. */
    sourceAssetPlanRevisionId: z.string().min(1),
    views: z
      .array(AssetReferenceViewSchema)
      .min(1)
      .max(MAX_ASSET_REFERENCE_VIEWS),
    approvedAt: z.string().datetime(),
  })
  .superRefine((set, context) => assertCardinalViewRoles(set.views, context));
export type AssetReferenceSet = z.infer<typeof AssetReferenceSetSchema>;

export const StoreAssetReferenceSetInputSchema = z
  .object({
    assetId: z.string().min(1),
    views: z
      .array(
        z.object({
          role: ConceptViewRoleSchema,
          source: z.enum(["generated", "uploaded"]).default("generated"),
          dataUrl: z.string().regex(IMAGE_ATTACHMENT_DATA_URL_PATTERN),
        }),
      )
      .min(1)
      .max(MAX_ASSET_REFERENCE_VIEWS),
  })
  .superRefine((input, context) =>
    assertCardinalViewRoles(input.views, context),
  );
export type StoreAssetReferenceSetInput = z.infer<
  typeof StoreAssetReferenceSetInputSchema
>;

const MultiviewConceptRequestBaseSchema = z.object({
  projectId: z.string().min(1),
  assetPlan: RevisionRefSchema,
  assetId: z.string().min(1),
  previousMultiviewConceptSet: RevisionRefSchema.optional(),
  strategyRevision: RevisionRefSchema.optional(),
  requestedRoles: z.array(ConceptViewRoleSchema).min(1).max(4).optional(),
  attempt: z.number().int().nonnegative().default(0),
});

const uniqueRequestedRoles = (
  request: { requestedRoles?: ConceptViewRole[] | undefined },
  context: z.RefinementCtx,
) => {
  if (
    request.requestedRoles &&
    new Set(request.requestedRoles).size !== request.requestedRoles.length
  ) {
    context.addIssue({
      code: "custom",
      path: ["requestedRoles"],
      message: "Requested view roles must be unique.",
    });
  }
};

export const MultiviewConceptRequestSchema =
  MultiviewConceptRequestBaseSchema.superRefine(uniqueRequestedRoles);
export type MultiviewConceptRequest = z.infer<
  typeof MultiviewConceptRequestSchema
>;

export const ConceptViewGenerationRequestSchema =
  MultiviewConceptRequestBaseSchema.extend({
    runId: z.string().min(1),
    mode: ProviderModeSchema,
    imageProvider: ImageProviderSchema,
    sourceConceptSet: RevisionRefSchema,
    anchorConcept: RevisionRefSchema,
    rolesToGenerate: z.array(ConceptViewRoleSchema).min(1).max(4),
  }).superRefine(uniqueRequestedRoles);
export type ConceptViewGenerationRequest = z.infer<
  typeof ConceptViewGenerationRequestSchema
>;

export const AssetRegenerationInputSchema = z.object({
  attemptNumber: z.number().int().positive(),
  strategyRevision: RevisionRefSchema,
  parentAssetRevision: RevisionRefSchema,
  additionalConceptViews: z.array(RevisionRefSchema).optional(),
});
export type AssetRegenerationInput = z.infer<
  typeof AssetRegenerationInputSchema
>;

export const LegacyAssetProductionRequestSchema = z
  .object({
    projectId: z.string().min(1),
    runId: z.string().min(1),
    mode: ProviderModeSchema,
    assetProvider: AssetProviderSchema,
    concept: RevisionRefSchema,
    regeneration: AssetRegenerationInputSchema.optional(),
  })
  .strict();
export type LegacyAssetProductionRequest = z.infer<
  typeof LegacyAssetProductionRequestSchema
>;

export const M2AssetProductionRequestSchema = z
  .object({
    projectId: z.string().min(1),
    assetPlan: RevisionRefSchema,
    assetId: z.string().min(1),
    multiviewConceptSet: RevisionRefSchema.optional(),
    regeneration: AssetRegenerationInputSchema.optional(),
  })
  .strict();
export type M2AssetProductionRequest = z.infer<
  typeof M2AssetProductionRequestSchema
>;

export const AssetProductionRequestSchema = z.union([
  LegacyAssetProductionRequestSchema,
  M2AssetProductionRequestSchema,
]);
export type AssetProductionRequest = z.infer<
  typeof AssetProductionRequestSchema
>;

export const TextureChannelSchema = z.enum([
  "base-color",
  "metallic-roughness",
  "normal",
  "occlusion",
  "emissive",
]);
export type TextureChannel = z.infer<typeof TextureChannelSchema>;

export const AssetGenerationClaimsSchema = z.object({
  textured: z.boolean(),
  textureChannels: z.array(TextureChannelSchema),
});
export type AssetGenerationClaims = z.infer<typeof AssetGenerationClaimsSchema>;

export const AssetDocumentSchema = z.object({
  assetId: z.string().min(1),
  name: z.string().min(1),
  classification: AssetClassificationSchema,
  glb: ArtifactRefSchema,
  provider: z.string().min(1),
  model: z.string().min(1),
  sourceConceptRevisionId: z.string().min(1),
  sourceMultiviewConceptSetRevisionId: z.string().min(1).optional(),
  sourceImageArtifactHashes: z
    .array(z.string().regex(/^[a-f0-9]{64}$/))
    .min(1)
    .max(4)
    .optional(),
  sourceConceptRevisionIds: z.array(z.string().min(1)).optional(),
  parentAssetRevisionId: z.string().min(1).optional(),
  regenerationStrategyRevisionId: z.string().min(1).optional(),
  generationClaims: AssetGenerationClaimsSchema.optional(),
  providerEvidence: z
    .array(
      z.object({
        role: z.string().min(1),
        artifact: ArtifactRefSchema,
      }),
    )
    .optional(),
  externalJobId: z.string().min(1),
  costUsd: z.number().nonnegative(),
  costCredits: z.number().int().nonnegative().optional(),
});
export type AssetDocument = z.infer<typeof AssetDocumentSchema>;

export const DeterministicGateSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  passed: z.boolean(),
  detail: z.string().min(1),
});

export const AssetEvaluationSchema = z.object({
  evaluationId: z.string().min(1),
  assetRevisionId: z.string().min(1),
  passed: z.boolean(),
  measurements: z.object({
    meshCount: z.number().int().nonnegative(),
    primitiveCount: z.number().int().nonnegative(),
    vertexCount: z.number().int().nonnegative(),
    triangleCount: z.number().int().nonnegative(),
    materialCount: z.number().int().nonnegative(),
    textureCount: z.number().int().nonnegative(),
    animationCount: z.number().int().nonnegative(),
    boundsMeters: z.object({
      x: z.number().nonnegative(),
      y: z.number().nonnegative(),
      z: z.number().nonnegative(),
    }),
  }),
  gates: z.array(DeterministicGateSchema),
  evaluatedAt: z.string().datetime(),
});
export type AssetEvaluation = z.infer<typeof AssetEvaluationSchema>;

export const TransformSchema = z.object({
  position: z.tuple([z.number(), z.number(), z.number()]),
  rotationEulerRadians: z.tuple([z.number(), z.number(), z.number()]),
  scale: z.tuple([z.number(), z.number(), z.number()]),
});

export const SceneEntitySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  assetRevisionId: z.string().min(1).optional(),
  transform: TransformSchema,
  tags: z.array(z.string().min(1)),
});

export const FulcrumSceneSpecV0Schema = z.object({
  schema: z.literal("fulcrum.scene"),
  version: z.literal(0),
  sceneId: z.string().min(1),
  units: z.literal("meters"),
  coordinates: z.object({
    handedness: z.literal("right"),
    up: z.literal("+Y"),
    forward: z.literal("-Z"),
  }),
  environment: z.object({
    background: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    fog: z.object({
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      near: z.number().positive(),
      far: z.number().positive(),
    }),
    ground: z.object({
      radius: z.number().positive(),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    }),
  }),
  camera: z.object({
    position: z.tuple([z.number(), z.number(), z.number()]),
    target: z.tuple([z.number(), z.number(), z.number()]),
    fieldOfViewDegrees: z.number().positive(),
  }),
  lighting: z.array(
    z.object({
      id: z.string().min(1),
      kind: z.enum(["ambient", "directional", "point"]),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      intensity: z.number().nonnegative(),
      position: z.tuple([z.number(), z.number(), z.number()]).optional(),
    }),
  ),
  entities: z.array(SceneEntitySchema),
  systems: z.array(z.string()),
  navigation: z.object({ enabled: z.boolean() }),
  spawnPoints: z.array(
    z.object({
      id: z.string(),
      position: z.tuple([z.number(), z.number(), z.number()]),
    }),
  ),
  interactionZones: z.array(
    z.object({
      id: z.string(),
      entityId: z.string(),
      radius: z.number().positive(),
    }),
  ),
});
export type FulcrumSceneSpecV0 = z.infer<typeof FulcrumSceneSpecV0Schema>;

export const ApprovalTargetTypeSchema = z.enum([
  "game-design",
  "visual-direction",
  "concept-set",
  "sound-set",
  "asset-plan",
  "visual-slice",
]);
export type ApprovalTargetType = z.infer<typeof ApprovalTargetTypeSchema>;

export const ApprovalDecisionSchema = z.object({
  approvalId: z.string().min(1),
  projectId: z.string().min(1),
  targetType: ApprovalTargetTypeSchema,
  targetRevisionId: z.string().min(1),
  targetSha256: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(["approved", "rejected", "changes-requested"]),
  notes: z.string().optional(),
  decidedBy: z.string().min(1),
  decidedAt: z.string().datetime(),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

/** The human review gates a project can be returned to after a rejection. */
export const ApprovalGateSchema = z.enum([
  "game-design",
  "visual-direction",
  "concept-set",
  "sound-set",
  "asset-plan",
]);
export type ApprovalGate = z.infer<typeof ApprovalGateSchema>;

export const APPROVAL_GATE_REVIEW_STAGES = {
  "game-design": "game-design-approval",
  "visual-direction": "visual-direction-approval",
  "concept-set": "concept-set-approval",
  "sound-set": "sound-set-approval",
  "asset-plan": "asset-plan-approval",
} as const satisfies Record<ApprovalGate, ProjectStage>;

/**
 * Blocked-reason codes that record a human rejection at a gate rather than a
 * workflow failure. Projects blocked before the rejection-reopens-the-gate fix
 * persisted these codes with `recoverable: false`; they are normalized on read.
 */
export const APPROVAL_GATE_REJECTION_CODES = {
  "game-design-not-approved": "game-design",
  "visual-direction-not-approved": "visual-direction",
  "concept-set-not-approved": "concept-set",
  "sound-set-not-approved": "sound-set",
  "asset-plan-not-approved": "asset-plan",
} as const satisfies Record<string, ApprovalGate>;

export const FailureKindSchema = z.enum([
  "retryable",
  "strategy-changing",
  "user-action-required",
  "policy-blocked",
  "terminal",
]);
export type FailureKind = z.infer<typeof FailureKindSchema>;

export const WorkflowFailureSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  kind: FailureKindSchema,
  evidenceRevisionIds: z.array(z.string().min(1)).default([]),
});
export type WorkflowFailure = z.infer<typeof WorkflowFailureSchema>;

export const BlockedReasonSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  recoverable: z.boolean(),
  failureKind: FailureKindSchema.optional(),
  resumeStage: ProjectStageSchema.optional(),
  /** Set when the block is a human rejection the studio can reopen. */
  reviewGate: ApprovalGateSchema.optional(),
});
export type BlockedReason = z.infer<typeof BlockedReasonSchema>;

export const AssetPolicySchema = z.object({
  schema: z.literal("fulcrum.asset-policy"),
  version: z.literal(1),
  classification: AssetClassificationSchema,
  mesh: z.object({
    maxMeshes: z.number().int().positive(),
    maxPrimitives: z.number().int().positive(),
    maxVertices: z.number().int().positive(),
    maxTriangles: z.number().int().positive(),
    minLargestExtentMeters: z.number().positive(),
    maxLargestExtentMeters: z.number().positive(),
    warnAspectRatioAbove: z.number().gte(1),
  }),
  material: z.object({
    requireAssignedMaterial: z.boolean(),
    requireNormals: z.boolean(),
    warnUnusedAbove: z.number().int().nonnegative(),
    warnDuplicateGroupsAbove: z.number().int().nonnegative(),
    requiredClaimedTextureChannels: z.array(TextureChannelSchema),
  }),
  texture: z.object({
    minDimensionPx: z.number().int().positive(),
    maxDimensionPx: z.number().int().positive(),
    warnUnusedAbove: z.number().int().nonnegative(),
  }),
  topology: z.object({
    maxDegenerateTriangleRatio: z.number().min(0).max(1),
    maxNonManifoldEdges: z.number().int().nonnegative(),
    maxUnreferencedVertexRatio: z.number().min(0).max(1),
    maxInconsistentWindingRatio: z.number().min(0).max(1),
    maxNormalMismatchRatio: z.number().min(0).max(1),
    warnBoundaryEdgeRatioAbove: z.number().min(0).max(1),
    weldToleranceRatio: z.number().positive().max(0.001),
  }),
  turntable: z.object({
    frameCount: z.number().int().min(4).max(12),
    width: z.number().int().min(128).max(512),
    height: z.number().int().min(128).max(512),
    elevationDegrees: z.number().min(0).max(45),
    paddingRatio: z.number().min(0.05).max(0.5),
  }),
  regeneration: z.object({
    maxAttempts: z.number().int().min(1).max(5),
    maxSameStrategyRetries: z.number().int().min(0).max(2),
    allowedStrategies: z.array(
      z.enum(["retry-same", "change-prompt", "change-views", "reclassify"]),
    ),
  }),
});
export type AssetPolicy = z.infer<typeof AssetPolicySchema>;

export const NormalizedCropSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  })
  .superRefine((crop, context) => {
    if (crop.x + crop.width > 1) {
      context.addIssue({
        code: "custom",
        path: ["width"],
        message: "Crop exceeds the right frame bound.",
      });
    }
    if (crop.y + crop.height > 1) {
      context.addIssue({
        code: "custom",
        path: ["height"],
        message: "Crop exceeds the bottom frame bound.",
      });
    }
  });
export type NormalizedCrop = z.infer<typeof NormalizedCropSchema>;

export const EvaluationEvidenceSchema = z.object({
  artifactId: z.string().min(1),
  kind: z.enum(["source-asset", "turntable-frame"]),
  frameIndex: z.number().int().nonnegative().optional(),
  crop: NormalizedCropSchema.optional(),
});
export type EvaluationEvidence = z.infer<typeof EvaluationEvidenceSchema>;

export const EvaluationFindingSchema = z
  .object({
    findingId: z.string().min(1),
    findingCode: z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/),
    rubricVersion: z.string().min(1),
    category: z.enum([
      "asset",
      "geometry",
      "materials",
      "lighting",
      "camera",
      "composition",
      "environment",
      "density",
      "vfx",
      "style",
      "gameplay",
      "technical",
    ]),
    summary: z.string().min(1).max(1_000),
    evidenceArtifactIds: z.array(z.string().min(1)).min(1),
    evidence: z.array(EvaluationEvidenceSchema).min(1),
    severity: z.enum(["info", "minor", "major", "critical"]),
    confidence: z.number().min(0).max(1),
    ownerModule: z.string().min(1),
    suggestedAction: z.string().min(1).max(1_000).optional(),
  })
  .superRefine((finding, context) => {
    const citedArtifactIds = new Set(
      finding.evidence.map((item) => item.artifactId),
    );
    const listedArtifactIds = new Set(finding.evidenceArtifactIds);
    if (
      listedArtifactIds.size !== finding.evidenceArtifactIds.length ||
      listedArtifactIds.size !== citedArtifactIds.size ||
      [...listedArtifactIds].some(
        (artifactId) => !citedArtifactIds.has(artifactId),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["evidenceArtifactIds"],
        message:
          "Evidence artifact IDs must be the unique cited evidence artifact IDs.",
      });
    }

    finding.evidence.forEach((item, index) => {
      if (
        (item.crop !== undefined || item.frameIndex !== undefined) &&
        item.kind !== "turntable-frame"
      ) {
        context.addIssue({
          code: "custom",
          path: ["evidence", index],
          message: "Only turntable evidence can carry frame coordinates.",
        });
      }
      if (item.crop !== undefined && item.frameIndex === undefined) {
        context.addIssue({
          code: "custom",
          path: ["evidence", index, "frameIndex"],
          message: "Cropped turntable evidence requires a frame index.",
        });
      }
    });
  });
export type EvaluationFinding = z.infer<typeof EvaluationFindingSchema>;

export const QualityGateSchema = z.object({
  id: z.string().min(1),
  category: z.enum(["mesh", "material", "texture", "topology"]),
  label: z.string().min(1),
  passed: z.boolean(),
  actual: z.union([z.number(), z.string(), z.boolean()]),
  threshold: z.string().min(1),
  evidenceArtifactIds: z.array(z.string().min(1)).min(1),
});
export type QualityGate = z.infer<typeof QualityGateSchema>;

export const AssetQualityMeasurementsSchema = z.object({
  mesh: z.object({
    meshCount: z.number().int().nonnegative(),
    primitiveCount: z.number().int().nonnegative(),
    vertexCount: z.number().int().nonnegative(),
    triangleCount: z.number().int().nonnegative(),
    boundsMeters: z.object({
      x: z.number().nonnegative(),
      y: z.number().nonnegative(),
      z: z.number().nonnegative(),
    }),
  }),
  material: z.object({
    materialCount: z.number().int().nonnegative(),
    unassignedPrimitiveCount: z.number().int().nonnegative(),
    unusedMaterialCount: z.number().int().nonnegative(),
    duplicateMaterialGroupCount: z.number().int().nonnegative(),
  }),
  texture: z.object({
    textureCount: z.number().int().nonnegative(),
    embeddedCount: z.number().int().nonnegative(),
    referencedCount: z.number().int().nonnegative(),
    unusedCount: z.number().int().nonnegative(),
    smallestDimensionPx: z.number().int().nonnegative(),
    largestDimensionPx: z.number().int().nonnegative(),
  }),
  topology: z.object({
    degenerateTriangles: z.number().int().nonnegative(),
    nonManifoldEdges: z.number().int().nonnegative(),
    boundaryEdges: z.number().int().nonnegative(),
    unreferencedVertices: z.number().int().nonnegative(),
    inconsistentWindingEdges: z.number().int().nonnegative(),
    normalMismatchTriangles: z.number().int().nonnegative(),
  }),
});
export type AssetQualityMeasurements = z.infer<
  typeof AssetQualityMeasurementsSchema
>;

export const AssetQualityVectorSchema = z.object({
  hardGateFailures: z.number().int().nonnegative(),
  criticalFindings: z.number().int().nonnegative(),
  majorFindings: z.number().int().nonnegative(),
  minorFindings: z.number().int().nonnegative(),
  semanticVerdict: z.enum(["pass", "revise", "not-run"]),
});
export type AssetQualityVector = z.infer<typeof AssetQualityVectorSchema>;

const AssetPolicyRefSchema = z.object({
  revisionId: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export const DeterministicAssetReportSchema = z.object({
  schema: z.literal("fulcrum.asset-deterministic-report"),
  version: z.literal(1),
  reportId: z.string().min(1),
  assetId: z.string().min(1),
  assetRevisionId: z.string().min(1),
  assetArtifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
  policy: AssetPolicyRefSchema,
  classification: AssetClassificationSchema,
  passed: z.boolean(),
  measurements: AssetQualityMeasurementsSchema,
  gates: z.array(QualityGateSchema),
  findings: z.array(EvaluationFindingSchema),
  qualityVector: AssetQualityVectorSchema,
});
export type DeterministicAssetReport = z.infer<
  typeof DeterministicAssetReportSchema
>;

export const TurntableManifestSchema = z.object({
  schema: z.literal("fulcrum.turntable"),
  version: z.literal(1),
  turntableId: z.string().min(1),
  assetId: z.string().min(1),
  assetRevisionId: z.string().min(1),
  sourceArtifactHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1),
  rendererVersion: z.enum([
    "software-rasterizer-v1",
    "software-rasterizer-v2",
    "software-rasterizer-v3",
  ]),
  config: AssetPolicySchema.shape.turntable,
  frames: z
    .array(
      z.object({
        frameIndex: z.number().int().nonnegative(),
        yawDegrees: z.number().min(0).lt(360),
        artifact: ArtifactRefSchema,
      }),
    )
    .min(4)
    .max(12),
});
export type TurntableManifest = z.infer<typeof TurntableManifestSchema>;

export const SemanticAssetReportSchema = z.object({
  schema: z.literal("fulcrum.asset-semantic-report"),
  version: z.literal(1),
  reportId: z.string().min(1),
  assetId: z.string().min(1),
  assetRevisionId: z.string().min(1),
  turntableRevisionId: z.string().min(1),
  rubricVersion: z.string().min(1),
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  provider: z.string().min(1),
  model: z.string().min(1),
  costUsd: z.number().nonnegative(),
  verdict: z.enum(["pass", "revise"]),
  dimensionScores: z.record(z.string().min(1), z.number().min(0).max(1)),
  findings: z.array(EvaluationFindingSchema),
  qualityVector: AssetQualityVectorSchema,
});
export type SemanticAssetReport = z.infer<typeof SemanticAssetReportSchema>;

const StrategyBaseSchema = z.object({
  rationale: z.string().min(1).max(1_000),
  reasonFindingIds: z.array(z.string().min(1)),
});

export const RegenerationStrategySchema = z.discriminatedUnion("kind", [
  StrategyBaseSchema.extend({ kind: z.literal("retry-same") }),
  StrategyBaseSchema.extend({
    kind: z.literal("change-prompt"),
    changes: z
      .array(
        z.object({
          findingId: z.string().min(1),
          addToPrompt: z.string().min(1).max(500),
          avoid: z.string().min(1).max(500).optional(),
        }),
      )
      .min(1)
      .max(3),
  }),
  StrategyBaseSchema.extend({
    kind: z.literal("change-views"),
    operation: z.enum(["add", "replace"]),
    roles: z.array(ConceptViewRoleSchema).min(1).max(4),
    brief: z.string().min(1).max(1_000),
  }),
  StrategyBaseSchema.extend({
    kind: z.literal("reclassify"),
    from: AssetClassificationSchema,
    to: AssetClassificationSchema,
  }),
  StrategyBaseSchema.extend({
    kind: z.literal("accept-best"),
    assetRevisionId: z.string().min(1),
  }),
  StrategyBaseSchema.extend({
    kind: z.literal("give-up-user"),
    bestAssetRevisionId: z.string().min(1).optional(),
    message: z.string().min(1).max(1_000),
  }),
]);
export type RegenerationStrategy = z.infer<typeof RegenerationStrategySchema>;

export const RegenerationAttemptSchema = z.object({
  attemptNumber: z.number().int().nonnegative(),
  asset: RevisionRefSchema,
  deterministicReport: RevisionRefSchema,
  turntable: RevisionRefSchema.optional(),
  semanticReport: RevisionRefSchema.optional(),
  appliedStrategy: RevisionRefSchema.optional(),
  qualityVector: AssetQualityVectorSchema,
});
export type RegenerationAttempt = z.infer<typeof RegenerationAttemptSchema>;

export const RegenerationDecisionReportSchema = z.object({
  schema: z.literal("fulcrum.asset-regeneration-decision"),
  version: z.literal(1),
  decisionId: z.string().min(1),
  assetId: z.string().min(1),
  sourceReportRevisionIds: z.array(z.string().min(1)).min(1),
  bestKnownAssetRevisionId: z.string().min(1),
  strategy: RegenerationStrategySchema,
});
export type RegenerationDecisionReport = z.infer<
  typeof RegenerationDecisionReportSchema
>;

export const AssetQualitySelectionSchema = z.object({
  attemptNumber: z.number().int().nonnegative(),
  assetRevisionId: z.string().min(1),
  deterministicReport: RevisionRefSchema,
  turntable: RevisionRefSchema.optional(),
  semanticReport: RevisionRefSchema.optional(),
  decision: RevisionRefSchema.optional(),
});
export type AssetQualitySelection = z.infer<typeof AssetQualitySelectionSchema>;

export const ProvenanceSchema = z.object({
  revisionId: z.string().min(1),
  parentRevisionIds: z.array(z.string().min(1)),
  sourceArtifactHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1),
  runId: z.string().min(1),
  operation: z.string().min(1),
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  providerVersion: z.string().min(1).optional(),
  seed: z.string().min(1).optional(),
  promptArtifact: ArtifactRefSchema.optional(),
  rights: z
    .object({
      sourceOwnershipConfirmed: z.boolean().optional(),
      providerTermsUrl: z.string().url().optional(),
      notes: z.string().optional(),
    })
    .optional(),
  costUsd: z.number().nonnegative().optional(),
  createdAt: z.string().datetime(),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const AssetClassHandlingPoliciesV1Schema = z.object({
  policyVersion: z.literal(1),
  hero: z.object({
    productionRoute: z.literal("provider-3d"),
    conceptViews: z.literal("multiview-if-supported"),
    deterministicQa: z.literal("full"),
    semanticQa: z.literal("turntable"),
    regenerationStrategy: z.literal("finding-directed"),
    maxRegenerationAttempts: z.literal(2),
  }),
  kit: z.object({
    productionRoute: z.literal("provider-3d"),
    conceptViews: z.literal("single-view"),
    deterministicQa: z.literal("standard"),
    semanticQa: z.literal("none"),
    regenerationStrategy: z.literal("finding-directed"),
    maxRegenerationAttempts: z.literal(1),
  }),
  procedural: z.object({
    productionRoute: z.literal("parameterized-generation"),
    conceptViews: z.literal("none"),
    deterministicQa: z.literal("procedural-output"),
    semanticQa: z.literal("none"),
    regenerationStrategy: z.literal("parameter-adjustment"),
    maxRegenerationAttempts: z.literal(2),
  }),
  functional: z.object({
    productionRoute: z.literal("runtime-authored"),
    conceptViews: z.literal("none"),
    deterministicQa: z.literal("gameplay-function"),
    semanticQa: z.literal("none"),
    regenerationStrategy: z.literal("implementation-repair"),
    maxRegenerationAttempts: z.literal(1),
  }),
});
export type AssetClassHandlingPoliciesV1 = z.infer<
  typeof AssetClassHandlingPoliciesV1Schema
>;
export type AssetHandlingPolicy =
  AssetClassHandlingPoliciesV1[AssetClassification];

export const ASSET_CLASS_HANDLING_POLICIES_V1 =
  AssetClassHandlingPoliciesV1Schema.parse({
    policyVersion: 1,
    hero: {
      productionRoute: "provider-3d",
      conceptViews: "multiview-if-supported",
      deterministicQa: "full",
      semanticQa: "turntable",
      regenerationStrategy: "finding-directed",
      maxRegenerationAttempts: 2,
    },
    kit: {
      productionRoute: "provider-3d",
      conceptViews: "single-view",
      deterministicQa: "standard",
      semanticQa: "none",
      regenerationStrategy: "finding-directed",
      maxRegenerationAttempts: 1,
    },
    procedural: {
      productionRoute: "parameterized-generation",
      conceptViews: "none",
      deterministicQa: "procedural-output",
      semanticQa: "none",
      regenerationStrategy: "parameter-adjustment",
      maxRegenerationAttempts: 2,
    },
    functional: {
      productionRoute: "runtime-authored",
      conceptViews: "none",
      deterministicQa: "gameplay-function",
      semanticQa: "none",
      regenerationStrategy: "implementation-repair",
      maxRegenerationAttempts: 1,
    },
  });

export const AssetPlanParameterValueSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
]);

export const PlannedAssetProcedureSchema = z.object({
  generatorId: z.string().min(1).max(120),
  parameters: z
    .record(z.string().min(1), AssetPlanParameterValueSchema)
    .refine(
      (value) => Object.keys(value).length > 0,
      "Parameters are required",
    ),
});

export const CharacterPoseModeSchema = z.enum(["a-pose", "t-pose"]);
export type CharacterPoseMode = z.infer<typeof CharacterPoseModeSchema>;

export const PlannedAssetSourceSchema = z.object({
  gameDesignSpec: RevisionAncestorSchema,
  conceptSet: RevisionAncestorSchema,
  conceptSlots: z
    .array(
      z.object({
        slotId: z.string().min(1),
        concept: RevisionAncestorSchema,
      }),
    )
    .max(3),
});

export const PlannedAssetSchema = z
  .object({
    assetId: z.string().min(1),
    name: z.string().trim().min(1).max(120),
    classification: AssetClassificationSchema,
    rationale: z.string().trim().min(1).max(600),
    sourceRefs: PlannedAssetSourceSchema,
    dependsOnAssetIds: z.array(z.string().min(1)).max(11),
    poseMode: CharacterPoseModeSchema.optional(),
    procedure: PlannedAssetProcedureSchema.optional(),
    acceptanceCriteria: z
      .array(z.string().trim().min(1).max(300))
      .min(1)
      .max(8),
  })
  .superRefine((asset, context) => {
    const shouldHaveProcedure = asset.classification === "procedural";
    if (shouldHaveProcedure !== Boolean(asset.procedure)) {
      context.addIssue({
        code: "custom",
        path: ["procedure"],
        message:
          "Procedural assets require parameters; other classes must omit them.",
      });
    }
    if (asset.poseMode && asset.classification !== "hero") {
      context.addIssue({
        code: "custom",
        path: ["poseMode"],
        message: "Only riggable hero assets may request a character pose.",
      });
    }
  });
export type PlannedAsset = z.infer<typeof PlannedAssetSchema>;

const assetPlanEnvironmentTerms =
  /\b(environment|playable area|arena|level|room|world|terrain|landscape|scene)\b/;
const assetPlanPropTerms =
  /\b(prop|item|object|tool|weapon|vehicle|door|gate|switch|lever|crate|furniture|device|station|assembly)\b/;

/** Single source of truth for the section shown at the staged gate and the
 * section boundary enforced by asset-plan amendments. */
export const assetPlanSectionFor = (asset: PlannedAsset): AssetPlanSection => {
  if (asset.classification === "kit") return "modular-kit";
  if (
    asset.classification === "procedural" ||
    asset.classification === "functional"
  )
    return "procedural-reference";
  if (asset.poseMode) return "hero";
  const searchable = [
    asset.name,
    asset.rationale,
    ...asset.acceptanceCriteria,
    ...asset.sourceRefs.conceptSlots.map(({ slotId }) => slotId),
  ]
    .join(" ")
    .toLowerCase();
  if (assetPlanEnvironmentTerms.test(searchable)) return "environment";
  if (assetPlanPropTerms.test(searchable)) return "prop";
  return "hero";
};

/**
 * A human's post-plan call about whether one asset should enter the humanoid
 * rigging path. This is deliberately separate from the immutable asset plan:
 * correcting biped detection must not consume the plan's one replan window.
 */
export const AssetRigEligibilityOverrideSchema = z
  .object({
    assetId: z.string().min(1),
    sourceAssetPlanRevisionId: z.string().min(1),
    biped: z.boolean(),
    poseMode: CharacterPoseModeSchema.optional(),
    decidedBy: z.string().min(1),
    decidedAt: z.string().datetime(),
  })
  .superRefine((decision, context) => {
    if (decision.biped !== Boolean(decision.poseMode))
      context.addIssue({
        code: "custom",
        path: ["poseMode"],
        message: decision.biped
          ? "A biped override requires a pose mode."
          : "A not-biped override must clear the pose mode.",
      });
  });
export type AssetRigEligibilityOverride = z.infer<
  typeof AssetRigEligibilityOverrideSchema
>;

export const OverrideAssetRigEligibilityInputSchema = z.object({
  assetId: z.string().min(1),
  biped: z.boolean(),
  poseMode: CharacterPoseModeSchema.optional(),
});
export type OverrideAssetRigEligibilityInput = z.infer<
  typeof OverrideAssetRigEligibilityInputSchema
>;

/** The structured vision verdict recorded for one approved front reference. */
export const AssetBipedDetectionSchema = z.object({
  assetId: z.string().min(1),
  sourceAssetPlanRevisionId: z.string().min(1),
  sourceReferenceSetRevisionId: z.string().min(1),
  biped: z.boolean(),
  confidence: z.number().min(0).max(1),
  rationale: z.string().trim().min(1).max(600),
  provider: z.string().min(1),
  model: z.string().min(1),
  detectedAt: z.string().datetime(),
});
export type AssetBipedDetection = z.infer<typeof AssetBipedDetectionSchema>;

export const AssetPlanProvenanceSchema = ProvenanceSchema.extend({
  operation: z.enum([
    "asset-plan.initial",
    "asset-plan.replan",
    "asset-plan.amend",
  ]),
});

export const ASSET_PLAN_MAX_ASSETS = 12;

export const AssetPlanIssueCodeSchema = z.enum([
  "duplicate-asset-id",
  "unknown-dependency",
  "self-dependency",
  "dependency-cycle",
  "plan-size-exceeded",
  "missing-hero",
  "hero-without-kept-concept",
  "concept-source-not-kept",
  "source-approval-mismatch",
  "source-lineage-mismatch",
  "provenance-mismatch",
  "invalid-structured-output",
]);
export type AssetPlanIssueCode = z.infer<typeof AssetPlanIssueCodeSchema>;

export const AssetPlanIssueSchema = z.object({
  code: AssetPlanIssueCodeSchema,
  message: z.string().min(1),
  path: z.array(z.union([z.string(), z.number().int()])),
  assetId: z.string().min(1).optional(),
  relatedAssetId: z.string().min(1).optional(),
});
export type AssetPlanIssue = z.infer<typeof AssetPlanIssueSchema>;

export const assetPlanGraphIssues = (
  assets: readonly PlannedAsset[],
): AssetPlanIssue[] => {
  const issues: AssetPlanIssue[] = [];
  const firstIndexById = new Map<string, number>();
  const uniqueAssets: Array<{ asset: PlannedAsset; index: number }> = [];

  assets.forEach((asset, index) => {
    const firstIndex = firstIndexById.get(asset.assetId);
    if (firstIndex !== undefined) {
      issues.push({
        code: "duplicate-asset-id",
        message: `Asset ID ${asset.assetId} duplicates assets[${firstIndex}].`,
        path: [index, "assetId"],
        assetId: asset.assetId,
      });
      return;
    }
    firstIndexById.set(asset.assetId, index);
    uniqueAssets.push({ asset, index });
  });

  const ids = new Set(firstIndexById.keys());
  const indegree = new Map<string, number>(
    uniqueAssets.map(({ asset }) => [asset.assetId, 0]),
  );
  const dependents = new Map<string, string[]>(
    uniqueAssets.map(({ asset }) => [asset.assetId, []]),
  );

  for (const { asset, index } of uniqueAssets) {
    const countedDependencies = new Set<string>();
    asset.dependsOnAssetIds.forEach((dependencyId, dependencyIndex) => {
      if (dependencyId === asset.assetId) {
        issues.push({
          code: "self-dependency",
          message: `Asset ${asset.assetId} cannot depend on itself.`,
          path: [index, "dependsOnAssetIds", dependencyIndex],
          assetId: asset.assetId,
          relatedAssetId: dependencyId,
        });
        return;
      }
      if (!ids.has(dependencyId)) {
        issues.push({
          code: "unknown-dependency",
          message: `Asset ${asset.assetId} depends on unknown asset ${dependencyId}.`,
          path: [index, "dependsOnAssetIds", dependencyIndex],
          assetId: asset.assetId,
          relatedAssetId: dependencyId,
        });
        return;
      }
      if (countedDependencies.has(dependencyId)) return;
      countedDependencies.add(dependencyId);
      indegree.set(asset.assetId, (indegree.get(asset.assetId) ?? 0) + 1);
      dependents.get(dependencyId)?.push(asset.assetId);
    });
  }

  const queue = [...indegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([assetId]) => assetId)
    .sort();
  let visited = 0;
  while (queue.length > 0) {
    const assetId = queue.shift()!;
    visited += 1;
    for (const dependentId of (dependents.get(assetId) ?? []).sort()) {
      const nextDegree = (indegree.get(dependentId) ?? 0) - 1;
      indegree.set(dependentId, nextDegree);
      if (nextDegree === 0) {
        queue.push(dependentId);
        queue.sort();
      }
    }
  }

  if (visited !== uniqueAssets.length) {
    const dependencies = new Map(
      uniqueAssets.map(({ asset }) => [
        asset.assetId,
        asset.dependsOnAssetIds.filter(
          (dependencyId) =>
            dependencyId !== asset.assetId && ids.has(dependencyId),
        ),
      ]),
    );
    const participatesInCycle = (start: string): boolean => {
      const pending = [...(dependencies.get(start) ?? [])];
      const visitedDependencies = new Set<string>();
      while (pending.length > 0) {
        const dependencyId = pending.pop()!;
        if (dependencyId === start) return true;
        if (visitedDependencies.has(dependencyId)) continue;
        visitedDependencies.add(dependencyId);
        pending.push(...(dependencies.get(dependencyId) ?? []));
      }
      return false;
    };
    for (const { asset, index } of uniqueAssets) {
      if (
        (indegree.get(asset.assetId) ?? 0) > 0 &&
        participatesInCycle(asset.assetId)
      ) {
        issues.push({
          code: "dependency-cycle",
          message: `Asset ${asset.assetId} participates in a dependency cycle.`,
          path: [index, "dependsOnAssetIds"],
          assetId: asset.assetId,
        });
      }
    }
  }

  return issues;
};

export const AssetPlanSchema = z
  .object({
    planId: z.string().min(1),
    assets: z.array(PlannedAssetSchema).min(1).max(ASSET_PLAN_MAX_ASSETS),
    handling: AssetClassHandlingPoliciesV1Schema,
    changeRequest: z
      .object({
        approvalId: z.string().min(1),
        previousPlanRevisionId: z.string().min(1),
        notes: z.string().trim().min(1).max(1_000),
      })
      .optional(),
    provenance: AssetPlanProvenanceSchema,
  })
  .superRefine((plan, context) => {
    for (const issue of assetPlanGraphIssues(plan.assets)) {
      context.addIssue({
        code: "custom",
        path: ["assets", ...issue.path],
        message: issue.message,
      });
    }
  });
export type AssetPlan = z.infer<typeof AssetPlanSchema>;

export const AmendAssetPlanInputSchema = z.object({
  section: AssetPlanSectionSchema,
  request: z.string().trim().min(1).max(1_000),
});
export type AmendAssetPlanInput = z.infer<typeof AmendAssetPlanInputSchema>;

export const handlingForPlannedAsset = (plan: AssetPlan, assetId: string) => {
  const asset = plan.assets.find((candidate) => candidate.assetId === assetId);
  if (!asset) throw new Error(`Unknown planned asset: ${assetId}`);
  return { asset, policy: plan.handling[asset.classification] };
};

export const AssetPlanFailureSchema = z.object({
  kind: FailureKindSchema,
  code: z.enum([
    "asset-plan-invalid-input",
    "asset-plan-invalid-output",
    "asset-plan-provider-failed",
    "asset-plan-submission-unknown",
    "asset-plan-replan-limit",
  ]),
  message: z.string().min(1),
  issues: z.array(AssetPlanIssueSchema),
});
export type AssetPlanFailure = z.infer<typeof AssetPlanFailureSchema>;

export const ApprovedRevisionBindingSchema = z
  .object({
    revision: RevisionRefSchema,
    approval: ApprovalDecisionSchema.extend({
      decision: z.literal("approved"),
    }),
  })
  .superRefine(({ revision, approval }, context) => {
    if (
      approval.targetRevisionId !== revision.revisionId ||
      approval.targetSha256 !== revision.artifact.sha256
    ) {
      context.addIssue({
        code: "custom",
        path: ["approval"],
        message: "Approval does not bind to this immutable revision.",
      });
    }
  });
export type ApprovedRevisionBinding = z.infer<
  typeof ApprovedRevisionBindingSchema
>;

export const AssetPlanningInputSchema = z
  .object({
    projectId: z.string().min(1),
    runId: z.string().min(1),
    mode: ProviderModeSchema,
    orchestratorProvider: ExecutionProviderSchema,
    gameDesignSpec: ApprovedRevisionBindingSchema,
    conceptSet: ApprovedRevisionBindingSchema,
    replan: z
      .object({
        previousPlan: RevisionRefSchema,
        decision: ApprovalDecisionSchema,
      })
      .optional(),
  })
  .superRefine((input, context) => {
    for (const [field, binding] of [
      ["gameDesignSpec", input.gameDesignSpec],
      ["conceptSet", input.conceptSet],
    ] as const) {
      if (binding.approval.projectId !== input.projectId) {
        context.addIssue({
          code: "custom",
          path: [field, "approval", "projectId"],
          message: "Approval belongs to a different project.",
        });
      }
    }
    if (input.gameDesignSpec.approval.targetType !== "game-design") {
      context.addIssue({
        code: "custom",
        path: ["gameDesignSpec", "approval", "targetType"],
        message: "Expected an approved Game Design Spec.",
      });
    }
    if (input.conceptSet.approval.targetType !== "concept-set") {
      context.addIssue({
        code: "custom",
        path: ["conceptSet", "approval", "targetType"],
        message: "Expected an approved concept set.",
      });
    }
    if (input.replan) {
      const { previousPlan, decision } = input.replan;
      if (decision.projectId !== input.projectId) {
        context.addIssue({
          code: "custom",
          path: ["replan", "decision", "projectId"],
          message: "Replan decision belongs to a different project.",
        });
      }
      if (
        decision.targetType !== "asset-plan" ||
        decision.decision !== "changes-requested" ||
        !decision.notes?.trim() ||
        decision.targetRevisionId !== previousPlan.revisionId ||
        decision.targetSha256 !== previousPlan.artifact.sha256
      ) {
        context.addIssue({
          code: "custom",
          path: ["replan"],
          message: "Replanning requires an exact changes-requested decision.",
        });
      }
    }
  });
export type AssetPlanningInput = z.infer<typeof AssetPlanningInputSchema>;

export const AssetPlanningOutcomeSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    requestId: z.string().min(1),
    value: RevisionRefSchema,
  }),
  z.object({
    status: z.literal("failed"),
    requestId: z.string().min(1),
    error: AssetPlanFailureSchema,
  }),
]);
export type AssetPlanningOutcome = z.infer<typeof AssetPlanningOutcomeSchema>;

/**
 * The immutable asset-plan revision the workflow finalized for production.
 *
 * `assetPlanApproval` remains an ApprovalDecision in persisted project state so
 * projects written before automatic finalization keep loading. New decisions
 * are written by the workflow rather than a human review screen.
 */
export const AssetPlanFinalizationSchema = ApprovalDecisionSchema.extend({
  targetType: z.literal("asset-plan"),
  decision: z.literal("approved"),
});
export type AssetPlanFinalization = z.infer<typeof AssetPlanFinalizationSchema>;

export const FinalizedAssetPlanBindingSchema = z
  .object({
    projectId: z.string().min(1),
    plan: RevisionRefSchema,
    finalization: AssetPlanFinalizationSchema,
  })
  .superRefine(({ projectId, plan, finalization }, context) => {
    if (finalization.projectId !== projectId) {
      context.addIssue({
        code: "custom",
        path: ["finalization", "projectId"],
        message: "The asset-plan finalization belongs to another project.",
      });
    }
    if (
      finalization.targetRevisionId !== plan.revisionId ||
      finalization.targetSha256 !== plan.artifact.sha256
    ) {
      context.addIssue({
        code: "custom",
        path: ["finalization"],
        message: "The asset-plan finalization is stale.",
      });
    }
  });
export type FinalizedAssetPlanBinding = z.infer<
  typeof FinalizedAssetPlanBindingSchema
>;

export const AssetBatchEntrySchema = z.object({
  assetId: z.string().min(1),
  classification: AssetClassificationSchema,
  current: RevisionRefSchema,
  best: RevisionRefSchema,
  attemptCount: z.number().int().nonnegative(),
  validated: z.boolean(),
  deterministicReport: RevisionRefSchema.optional(),
  turntable: RevisionRefSchema.optional(),
  semanticReport: RevisionRefSchema.optional(),
  decision: RevisionRefSchema.optional(),
  multiviewConceptSet: RevisionRefSchema.optional(),
  staleReason: z.string().optional(),
});
export type AssetBatchEntry = z.infer<typeof AssetBatchEntrySchema>;

/* ------------------------------------------------------------------------- *
 * Staged Meshy asset lifecycle
 *
 * Meshy bills a finished asset in four separately-priced tasks, and each one
 * is a decision a human should make with the previous one on screen. Modelling
 * them as one 30-credit "resolve" hid two thirds of the spend behind a single
 * click and gave nobody a chance to scrap a bad silhouette before paying to
 * texture it. These schemas are that lifecycle: one record per asset, one run
 * per paid task, one decision per human choice.
 * ------------------------------------------------------------------------- */

export const MeshyStageSchema = z.enum([
  "geometry",
  "texture",
  "rig",
  "animation",
]);
export type MeshyStage = z.infer<typeof MeshyStageSchema>;

/**
 * Meshy's per-task price list, in credits. Every one of these is real money:
 * Meshy publishes no free-retry path on the public API, so a retry is a new
 * `geometry` task at full price. The web app's 12 free retries per asset are
 * not exposed to `POST /openapi/v1/*` and are deliberately not modelled here.
 */
export const MESHY_STAGE_CREDITS = {
  geometry: 20,
  texture: 10,
  rig: 5,
  animation: 3,
} as const satisfies Record<MeshyStage, number>;

export const MeshyTaskStatusSchema = z.enum([
  "running",
  "succeeded",
  "failed",
  "expired",
  "canceled",
]);
export type MeshyTaskStatus = z.infer<typeof MeshyTaskStatusSchema>;

/**
 * `expired` is not a flavour of `failed`. A failed task is refunded and can be
 * re-run against the same inputs; an expired one *succeeded*, was billed, and
 * then Meshy deleted the result before Fulcrum persisted it. The only recovery
 * is a visible new spend, so the two must never collapse into one status.
 */
export const AssetStageStatusSchema = z.enum([
  "not-started",
  "running",
  "review",
  "accepted",
  "scrapped",
  "failed",
  "expired",
]);
export type AssetStageStatus = z.infer<typeof AssetStageStatusSchema>;

export const AssetStageDecisionSchema = z.enum([
  "scrap",
  "retry",
  "rebuild-geometry",
  "texture",
  "accept",
  "retexture",
  "rig",
  "animate",
]);
export type AssetStageDecision = z.infer<typeof AssetStageDecisionSchema>;

/** What each decision costs the moment it is taken. Zero means it is free. */
export const ASSET_STAGE_DECISION_CREDITS = {
  scrap: 0,
  accept: 0,
  retry: MESHY_STAGE_CREDITS.geometry,
  "rebuild-geometry": MESHY_STAGE_CREDITS.geometry,
  texture: MESHY_STAGE_CREDITS.texture,
  retexture: MESHY_STAGE_CREDITS.texture,
  rig: MESHY_STAGE_CREDITS.rig,
  animate: MESHY_STAGE_CREDITS.animation,
} as const satisfies Record<AssetStageDecision, number>;

/** The stage a decision submits. Absent for the two free decisions. */
export const ASSET_STAGE_DECISION_STAGES = {
  retry: "geometry",
  "rebuild-geometry": "geometry",
  texture: "texture",
  retexture: "texture",
  rig: "rig",
  animate: "animation",
} as const satisfies Record<
  Exclude<AssetStageDecision, "scrap" | "accept">,
  MeshyStage
>;

export const AssetStageProviderSchema = z.enum(["meshy", "blender-local"]);
export type AssetStageProvider = z.infer<typeof AssetStageProviderSchema>;

export const AssetStageRunSchema = z.object({
  stage: MeshyStageSchema,
  /** 1-based attempt counter within this stage. A retry increments it. */
  round: z.number().int().min(1),
  status: MeshyTaskStatusSchema,
  progress: z.number().int().min(0).max(100),
  /** The durable submission record that owns this task's credit reservation. */
  requestId: z.string().min(1),
  externalJobId: z.string().min(1).optional(),
  /** Optional for records written before provider provenance was introduced. */
  provider: AssetStageProviderSchema.optional(),
  /** Meshy's synchronous model refusal that caused a local rig run. */
  providerRefusalReason: z.string().min(1).optional(),
  /** Manifest key from tools/rigging/ used by a local rig run. */
  rigArchetype: z.string().min(1).optional(),
  reservedCredits: z.number().int().nonnegative(),
  consumedCredits: z.number().int().nonnegative().optional(),
  /** The persisted GLB. Present once the run succeeds and bytes are stored. */
  model: ArtifactRefSchema.optional(),
  supporting: z
    .array(
      z.object({
        role: z.string().min(1),
        artifact: ArtifactRefSchema,
      }),
    )
    .optional(),
  error: z.string().min(1).optional(),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
});
export type AssetStageRun = z.infer<typeof AssetStageRunSchema>;

export const AssetStageDecisionRecordSchema = z.object({
  decision: AssetStageDecisionSchema,
  /** The stage and round the human was looking at when they decided. */
  reviewedStage: MeshyStageSchema,
  reviewedRound: z.number().int().min(1),
  credits: z.number().int().nonnegative(),
  note: z.string().trim().max(600).optional(),
  decidedAt: z.string().datetime(),
});
export type AssetStageDecisionRecord = z.infer<
  typeof AssetStageDecisionRecordSchema
>;

/** A provider rejected a new task before Fulcrum could create a stage run. */
export const AssetStageSubmitFailureSchema = z.object({
  stage: MeshyStageSchema,
  round: z.number().int().min(1),
  reason: z.string().min(1),
  failedAt: z.string().datetime(),
  recovered: z.boolean().optional(),
});
export type AssetStageSubmitFailure = z.infer<
  typeof AssetStageSubmitFailureSchema
>;

/** The durable half of an asset's lifecycle. Everything else is derived. */
export const AssetStageRecordSchema = z.object({
  assetId: z.string().min(1),
  status: AssetStageStatusSchema,
  stage: MeshyStageSchema,
  runs: z.array(AssetStageRunSchema),
  decisions: z.array(AssetStageDecisionRecordSchema),
  /** Does not replace the last reviewable stage; a retry clears it. */
  submitFailure: AssetStageSubmitFailureSchema.optional(),
  terminalReason: z.string().min(1).optional(),
  updatedAt: z.string().datetime(),
});
export type AssetStageRecord = z.infer<typeof AssetStageRecordSchema>;

/**
 * One CTA the studio may render. A rig or animation offer is absent until the
 * eligibility decision allows it; the character card carries the explanation
 * and override instead of presenting a spend button that cannot run.
 */
export const AssetStageOfferSchema = z.object({
  decision: AssetStageDecisionSchema,
  credits: z.number().int().nonnegative(),
  label: z.string().min(1),
  available: z.boolean(),
  unavailableReason: z.string().min(1).optional(),
});
export type AssetStageOffer = z.infer<typeof AssetStageOfferSchema>;

export const AssetStagePreviewSchema = z.object({
  glb: ArtifactRefSchema,
  stage: MeshyStageSchema,
  round: z.number().int().min(1),
  provider: AssetStageProviderSchema.optional(),
  textured: z.boolean(),
  rigged: z.boolean(),
  animated: z.boolean(),
});
export type AssetStagePreview = z.infer<typeof AssetStagePreviewSchema>;

/** The projection the studio renders: durable record plus everything derived. */
export const AssetStageViewSchema = AssetStageRecordSchema.extend({
  name: z.string().min(1),
  classification: AssetClassificationSchema,
  /** The effective pose after manual, automatic and plan evidence is merged. */
  poseMode: CharacterPoseModeSchema.optional(),
  rigEligible: z.boolean(),
  rigEligibilityReason: z.string().min(1),
  rigEligibilitySource: z
    .enum([
      "classification",
      "manual-biped",
      "manual-not-biped",
      "auto-biped",
      "auto-not-biped",
      "plan",
      "none",
    ])
    .optional(),
  rigEligibilityOverride: AssetRigEligibilityOverrideSchema.optional(),
  bipedDetection: AssetBipedDetectionSchema.optional(),
  /** 0-100. Mirrors the active run, or the last completed run when idle. */
  progress: z.number().int().min(0).max(100),
  activeRun: AssetStageRunSchema.optional(),
  preview: AssetStagePreviewSchema.optional(),
  offers: z.array(AssetStageOfferSchema),
  creditsReserved: z.number().int().nonnegative(),
  creditsConsumed: z.number().int().nonnegative(),
});
export type AssetStageView = z.infer<typeof AssetStageViewSchema>;

/**
 * Whether Meshy's rigger will accept this asset. A human override is the
 * authority for every classification. Without one, only heroes can inherit
 * eligibility from automatic biped detection or the plan's `poseMode`.
 */
export type AssetRigEligibilityEvidence = {
  override?: AssetRigEligibilityOverride | undefined;
  detection?: AssetBipedDetection | undefined;
};

export type AssetRigEligibility = {
  eligible: boolean;
  reason: string;
  poseMode?: CharacterPoseMode | undefined;
  source:
    | "classification"
    | "manual-biped"
    | "manual-not-biped"
    | "auto-biped"
    | "auto-not-biped"
    | "plan"
    | "none";
};

export const assetRigEligibility = (
  asset: {
    classification: AssetClassification;
    poseMode?: CharacterPoseMode | undefined;
  },
  evidence: AssetRigEligibilityEvidence = {},
): AssetRigEligibility => {
  if (evidence.override)
    return evidence.override.biped
      ? {
          eligible: true,
          poseMode: evidence.override.poseMode ?? "a-pose",
          reason:
            asset.classification === "hero"
              ? `You marked this hero as a biped in ${evidence.override.poseMode === "t-pose" ? "T-pose" : "A-pose"}.`
              : `You marked this ${asset.classification} as a rigged biped, overriding its planned classification.`,
          source: "manual-biped",
        }
      : {
          eligible: false,
          reason: `You marked this ${asset.classification} as not bipedal, so rigging is off.`,
          source: "manual-not-biped",
        };
  if (asset.classification !== "hero")
    return {
      eligible: false,
      reason: `Meshy rigs humanoid heroes only; this asset is planned as ${asset.classification}.`,
      source: "classification",
    };
  if (evidence.detection)
    return evidence.detection.biped
      ? {
          eligible: true,
          poseMode: "a-pose",
          reason: `Vision detected a biped (${Math.round(evidence.detection.confidence * 100)}% confidence): ${evidence.detection.rationale}`,
          source: "auto-biped",
        }
      : {
          eligible: false,
          reason: `Vision did not detect a biped (${Math.round(evidence.detection.confidence * 100)}% confidence): ${evidence.detection.rationale}`,
          source: "auto-not-biped",
        };
  if (!asset.poseMode)
    return {
      eligible: false,
      reason:
        "The asset plan did not mark this hero as a rigging-bound humanoid, so no pose was requested.",
      source: "none",
    };
  return {
    eligible: true,
    poseMode: asset.poseMode,
    reason: `The plan marks this hero as a humanoid in ${asset.poseMode === "a-pose" ? "A-pose" : "T-pose"}, intended for rigging.`,
    source: "plan",
  };
};

const OFFER_LABELS = {
  scrap: "Scrap this asset",
  retry: "Generate new geometry",
  "rebuild-geometry": "Rebuild geometry",
  texture: "Texture this geometry",
  accept: "Accept this asset",
  retexture: "Texture again",
  rig: "Rig this character",
  animate: "Add a walk and run clip",
} as const satisfies Record<AssetStageDecision, string>;

const offer = (
  decision: AssetStageDecision,
  unavailableReason?: string,
): AssetStageOffer => ({
  decision,
  credits: ASSET_STAGE_DECISION_CREDITS[decision],
  label: OFFER_LABELS[decision],
  available: unavailableReason === undefined,
  ...(unavailableReason ? { unavailableReason } : {}),
});

/**
 * The decisions a human may take right now. Pure, so the studio, the routes
 * and the tests all agree on what is legal without re-deriving the rules.
 */
export const assetStageOffers = (
  record: Pick<AssetStageRecord, "status" | "stage"> & {
    runs?: Pick<AssetStageRun, "stage" | "status" | "provider">[];
  },
  eligibility: { eligible: boolean; reason: string },
): AssetStageOffer[] => {
  switch (record.status) {
    case "not-started":
    case "running":
      return [];
    case "failed":
    case "expired":
      return [offer("retry"), offer("scrap")];
    case "accepted":
    case "scrapped":
      return [];
    case "review":
      break;
  }
  switch (record.stage) {
    case "geometry":
      return [offer("texture"), offer("retry"), offer("scrap")];
    case "texture":
      return [
        offer("accept"),
        offer("retexture"),
        ...(eligibility.eligible ? [offer("rig")] : []),
        offer("rebuild-geometry"),
        offer("scrap"),
      ];
    case "rig":
      /* Meshy animation requires a Meshy rig task id. Blender's local rig has
         no such id and already carries its baked walk, so offering animation
         here would authorize a task the provider cannot accept. */
      const latestRig = [...(record.runs ?? [])]
        .reverse()
        .find((run) => run.stage === "rig" && run.status === "succeeded");
      return [
        offer("accept"),
        ...(eligibility.eligible && latestRig?.provider !== "blender-local"
          ? [offer("animate")]
          : []),
        offer("rebuild-geometry"),
        offer("scrap"),
      ];
    case "animation":
      return [offer("accept"), offer("scrap")];
  }
};

/* ------------------------------------------------------------------------- *
 * Meshy request configuration
 *
 * Every default below is a rule paid for in credits, not a preference:
 * `modelVersion` is pinned because "latest" silently repointed and quadrupled
 * a bill; `targetPolycount` has a *floor* because Meshy's remesher destroys
 * form at low targets, and low-poly delivery is a local decimation concern;
 * `textureResolution` tops out at 4k because 8k costs more and drops PBR maps.
 * ------------------------------------------------------------------------- */

export const MESHY_PINNED_MODEL_VERSION = "meshy-6" as const;

/**
 * How many triangles the *delivered* asset should end up at. Fulcrum never
 * decimates — Meshy is always asked for the high target. This is plan intent
 * carried to whatever tool does the reduction downstream.
 */
export const DELIVERED_POLYCOUNT_TARGETS = {
  background: 2_000,
  standard: 6_000,
  hero: 10_000,
} as const;

export const DeliveredPolycountPresetSchema = z.enum([
  "background",
  "standard",
  "hero",
]);
export type DeliveredPolycountPreset = z.infer<
  typeof DeliveredPolycountPresetSchema
>;

export const MESHY_MIN_TARGET_POLYCOUNT = 10_000;

export const MeshyConfigSchema = z.object({
  /** Never "latest". A repoint is a silent price change. */
  modelVersion: z.literal(MESHY_PINNED_MODEL_VERSION).default("meshy-6"),
  topology: z.enum(["triangle"]).default("triangle"),
  /** Requested from Meshy. Floored, because a low remesh target ruins form. */
  targetPolycount: z
    .number()
    .int()
    .min(MESHY_MIN_TARGET_POLYCOUNT)
    .max(300_000)
    .default(MESHY_MIN_TARGET_POLYCOUNT),
  textureResolution: z.enum(["2k", "4k"]).default("4k"),
  poseMode: CharacterPoseModeSchema.default("a-pose"),
  /** Drives Meshy's rig resize. Meshy's own default is 1.7 m. */
  realWorldHeightMeters: z.number().positive().max(100).optional(),
  /** Metadata only. Fulcrum does not decimate. */
  deliveredPolycountPreset: DeliveredPolycountPresetSchema.default("standard"),
  removeLighting: z.boolean().default(true),
  imageEnhancement: z.boolean().default(true),
});
export type MeshyConfig = z.infer<typeof MeshyConfigSchema>;
export type MeshyConfigInput = z.input<typeof MeshyConfigSchema>;

export const DEFAULT_MESHY_CONFIG: MeshyConfig = MeshyConfigSchema.parse({});

/** Where a continued project came from. The source world is never written to,
 *  so this pointer in the descendant is the whole record of the lineage. */
export const ContinuationProvenanceSchema = z.object({
  projectId: z.string().min(1),
  milestone: MilestoneSchema,
  runId: z.string().min(1),
  name: z.string().min(1),
  gameDesignSpecRevisionId: z.string().min(1),
  visualDirectionRevisionId: z.string().min(1),
  conceptSetRevisionId: z.string().min(1),
  continuedAt: z.string().datetime(),
});
export type ContinuationProvenance = z.infer<
  typeof ContinuationProvenanceSchema
>;

const stagesByMilestone: Record<Milestone, ReadonlySet<ProjectStage>> = {
  m0: new Set([
    "creative-development",
    "visual-direction-approval",
    "asset-production",
    "asset-quality",
    "scene-composition",
    "visual-slice-approval",
    "complete",
    "blocked",
  ]),
  m1: new Set([
    "interrogation",
    "game-design-approval",
    "visual-direction-generation",
    "visual-direction-approval",
    "concept-planning",
    "concept-generation",
    "concept-set-approval",
    "sound-planning",
    "sound-generation",
    "sound-set-approval",
    "complete",
    "blocked",
  ]),
  m2: new Set([
    "interrogation",
    "game-design-approval",
    "visual-direction-generation",
    "visual-direction-approval",
    "concept-planning",
    "concept-generation",
    "concept-set-approval",
    "asset-planning",
    "asset-plan-approval",
    "asset-batch",
    "complete",
    "blocked",
  ]),
};

export const ProjectStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    milestone: MilestoneSchema.default("m0"),
    projectId: z.string().min(1),
    name: z.string().min(1),
    mode: ProviderModeSchema,
    assetProvider: AssetProviderSchema.default("meshy"),
    orchestratorProvider: ExecutionProviderSchema.default("openai"),
    implementationProvider: ExecutionProviderSchema.default("openai"),
    imageProvider: ImageProviderSchema.default("openai-subscription"),
    soundProvider: SoundProviderSchema.default("none"),
    status: ProjectStatusSchema,
    stage: ProjectStageSchema,
    runId: z.string().min(1),
    workflowRunId: z.string().optional(),
    maxConcurrentExternalJobs: z.number().int().min(1).max(8).optional(),
    budgetUsd: z.number().nonnegative().default(0),
    spentUsd: z.number().nonnegative(),
    meshyCreditBudget: z.number().int().nonnegative().optional(),
    meshyCreditsReserved: z.number().int().nonnegative().optional(),
    meshyCreditsConsumed: z.number().int().nonnegative().optional(),
    conceptReplacementCount: z.number().int().min(0).max(1).default(0),
    directionReplacementCount: z.number().int().min(0).max(1).optional(),
    focusedDirectionChangeCount: z.number().int().min(0).max(1).optional(),
    conceptRegenerationCounts: z
      .record(z.string().min(1), z.number().int().min(0))
      .optional(),
    soundRegenerationCounts: z
      .record(z.string().min(1), z.number().int().min(0))
      .optional(),
    brief: RevisionRefSchema,
    creativeCapabilities: RevisionRefSchema.optional(),
    interrogation: RevisionRefSchema.optional(),
    /** The latest batch of proposed names. Present from signoff onward. */
    gameNameCandidates: RevisionRefSchema.optional(),
    /** The committed name decision. Its name is the project's display name. */
    gameName: RevisionRefSchema.optional(),
    /** Set on an M2 project seeded from a finished M1 world. */
    continuedFrom: ContinuationProvenanceSchema.optional(),
    gameDesign: RevisionRefSchema.optional(),
    gameDesignSpec: RevisionRefSchema.optional(),
    projectGlossary: RevisionRefSchema.optional(),
    decisionRecords: z.array(RevisionRefSchema).optional(),
    visualDirectionSet: RevisionRefSchema.optional(),
    selectedVisualDirectionRevisionId: z.string().min(1).optional(),
    focusedDirectionChange: RevisionRefSchema.optional(),
    visualBible: RevisionRefSchema.optional(),
    concept: RevisionRefSchema.optional(),
    conceptPlan: RevisionRefSchema.optional(),
    conceptSet: RevisionRefSchema.optional(),
    soundPlan: RevisionRefSchema.optional(),
    soundSet: RevisionRefSchema.optional(),
    gameDesignApproval: ApprovalDecisionSchema.optional(),
    directionApproval: ApprovalDecisionSchema.optional(),
    conceptSetApproval: ApprovalDecisionSchema.optional(),
    soundSetApproval: ApprovalDecisionSchema.optional(),
    assetPlan: RevisionRefSchema.optional(),
    /** The exact plan finalization. The field name is retained for old worlds. */
    assetPlanApproval: ApprovalDecisionSchema.optional(),
    assetPlanReplanCount: z.number().int().min(0).max(1).optional(),
    assetBatch: z.record(z.string().min(1), AssetBatchEntrySchema).optional(),
    /** Approved Images-stage reference views, keyed by planned asset id. The
     *  staged geometry request reads these first. */
    assetReferenceSets: z
      .record(z.string().min(1), RevisionRefSchema)
      .optional(),
    /** Latest automatic biped verdict per asset. Values are owned revisions. */
    assetBipedDetections: z
      .record(z.string().min(1), RevisionRefSchema)
      .optional(),
    /** Latest post-plan human biped decision per asset. */
    assetRigEligibilityOverrides: z
      .record(z.string().min(1), RevisionRefSchema)
      .optional(),
    /** Per-project Meshy request settings. Absent means the pinned defaults. */
    meshyConfig: RevisionRefSchema.optional(),
    /** The staged geometry/texture/rig lifecycle, keyed by planned asset id. */
    assetStages: z.record(z.string().min(1), AssetStageRecordSchema).optional(),
    asset: RevisionRefSchema.optional(),
    assetEvaluation: RevisionRefSchema.optional(),
    scene: RevisionRefSchema.optional(),
    reviewImage: ArtifactRefSchema.optional(),
    sliceApproval: ApprovalDecisionSchema.optional(),
    blockedReason: BlockedReasonSchema.optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .superRefine((state, context) => {
    if (!stagesByMilestone[state.milestone].has(state.stage)) {
      context.addIssue({
        code: "custom",
        path: ["stage"],
        message: `${state.stage} is not valid for ${state.milestone}.`,
      });
    }
  });
export type ProjectState = z.infer<typeof ProjectStateSchema>;
export type ProjectStateInput = z.input<typeof ProjectStateSchema>;

export const isStageForMilestone = (
  milestone: Milestone,
  stage: ProjectStage,
): boolean => stagesByMilestone[milestone].has(stage);

/**
 * The gate a blocked project can be returned to, when the block records a
 * human rejection. Undefined for genuine failures, which stay unrecoverable
 * or recover through the workflow graph instead.
 */
export const approvalGateBlock = (state: {
  milestone: Milestone;
  status?: ProjectStatus;
  blockedReason?: BlockedReason | undefined;
}): { gate: ApprovalGate; reviewStage: ProjectStage } | undefined => {
  const reason = state.blockedReason;
  if (!reason) return undefined;
  const gate: ApprovalGate | undefined =
    reason.reviewGate ??
    APPROVAL_GATE_REJECTION_CODES[
      reason.code as keyof typeof APPROVAL_GATE_REJECTION_CODES
    ];
  if (!gate) return undefined;
  const reviewStage = APPROVAL_GATE_REVIEW_STAGES[gate];
  return isStageForMilestone(state.milestone, reviewStage)
    ? { gate, reviewStage }
    : undefined;
};

/**
 * Rejection blocks persisted before rejection reopened its gate carry
 * `recoverable: false` and no gate. Normalizing on read makes those projects
 * rescuable without rewriting history.
 */
export const normalizeBlockedReason = <T extends ProjectState>(state: T): T => {
  const block = approvalGateBlock(state);
  if (!block || !state.blockedReason) return state;
  const reason = state.blockedReason;
  if (
    reason.recoverable &&
    reason.reviewGate === block.gate &&
    reason.resumeStage === block.reviewStage
  )
    return state;
  return {
    ...state,
    blockedReason: {
      ...reason,
      recoverable: true,
      failureKind: reason.failureKind ?? "user-action-required",
      resumeStage: block.reviewStage,
      reviewGate: block.gate,
    },
  };
};

export const M1InFlightActionSchema = z.enum([
  "answers",
  "confirm",
  "suggest-names",
  "name-game",
  "revise",
  "approve-gds",
  "replace",
  "change",
  "generate",
  "regenerate",
  "generate-sounds",
  "regenerate-sound",
  "plan-assets",
  "replan-assets",
]);
export type M1InFlightAction = z.infer<typeof M1InFlightActionSchema>;

export const M1InFlightSchema = z.object({
  action: M1InFlightActionSchema,
  startedAt: z.string().datetime(),
});
export type M1InFlight = z.infer<typeof M1InFlightSchema>;

export const ProjectEventSchema = z.object({
  eventId: z.string().min(1),
  runId: z.string().min(1),
  type: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
});
export type ProjectEvent = z.infer<typeof ProjectEventSchema>;

export const AssetQualityEvidenceSchema = z.object({
  deterministicReports: z.array(DeterministicAssetReportSchema),
  turntables: z.array(TurntableManifestSchema),
  semanticReports: z.array(SemanticAssetReportSchema),
  decisions: z.array(
    z.object({
      revisionId: z.string().min(1),
      report: RegenerationDecisionReportSchema,
    }),
  ),
  events: z.array(ProjectEventSchema),
});
export type AssetQualityEvidence = z.infer<typeof AssetQualityEvidenceSchema>;

export const ProjectSnapshotSchema = z.object({
  state: ProjectStateSchema,
  briefText: z.string(),
  inFlight: M1InFlightSchema.optional(),
  interrogation: InterrogationStateSchema.optional(),
  gameNameCandidates: GameNameCandidateSetSchema.optional(),
  gameName: GameNameDecisionSchema.optional(),
  gameDesign: GameDesignDigestSchema.optional(),
  gameDesignSpec: GameDesignSpecSchema.optional(),
  visualDirections: VisualDirectionSetSchema.optional(),
  visualDirectionRevisions: z
    .record(z.string().min(1), RevisionRefSchema)
    .optional(),
  conceptPlan: ConceptPlanSchema.optional(),
  visualBible: VisualBibleSchema.optional(),
  concept: ConceptDocumentSchema.optional(),
  conceptSet: ConceptSetSchema.optional(),
  conceptDocuments: z
    .record(z.string().min(1), z.array(M1ConceptDocumentSchema).min(1))
    .optional(),
  soundPlan: SoundPlanSchema.optional(),
  soundSet: SoundSetSchema.optional(),
  soundDocuments: z
    .record(z.string().min(1), z.array(SoundDocumentSchema).min(1))
    .optional(),
  assetPlan: AssetPlanSchema.optional(),
  assetQualityEvidence: z
    .record(z.string().min(1), AssetQualityEvidenceSchema)
    .optional(),
  /** Resolved settings, defaults included, so the studio never guesses. */
  meshyConfig: MeshyConfigSchema.optional(),
  /** Everything the staged asset gate renders: progress, previews, CTAs. */
  assetStages: z.record(z.string().min(1), AssetStageViewSchema).optional(),
  /** Resolved approved reference sets, so a reloaded gate shows the views a
   *  human already approved instead of empty slots. */
  assetReferenceSets: z
    .record(z.string().min(1), AssetReferenceSetSchema)
    .optional(),
  asset: AssetDocumentSchema.optional(),
  assetEvaluation: AssetEvaluationSchema.optional(),
  scene: FulcrumSceneSpecV0Schema.optional(),
});
export type ProjectSnapshot = z.infer<typeof ProjectSnapshotSchema>;

export const CreateProjectInputSchema = z
  .object({
    milestone: MilestoneSchema.default("m0"),
    brief: z.string().min(40),
    mode: ProviderModeSchema,
    assetProvider: AssetProviderSchema.default("meshy"),
    orchestratorProvider: ExecutionProviderSchema.default("openai"),
    implementationProvider: ExecutionProviderSchema.default("openai"),
    imageProvider: ImageProviderSchema.default("openai-subscription"),
    soundProvider: SoundProviderSchema.default("none"),
    maxConcurrentExternalJobs: z.number().int().min(1).max(8).default(2),
    budgetUsd: z.number().positive().optional(),
    meshyCreditBudget: z.number().int().positive().optional(),
    rightsConfirmed: z.literal(true),
  })
  .superRefine((value, context) => {
    if (value.milestone === "m2" && value.soundProvider !== "none") {
      context.addIssue({
        code: "custom",
        path: ["soundProvider"],
        message: "M2 skips sound production; soundProvider must be none.",
      });
    }
    if (projectNeedsBudget(value) && value.budgetUsd === undefined) {
      context.addIssue({
        code: "custom",
        path: ["budgetUsd"],
        message: "A positive USD budget is required for metered routes.",
      });
    }
    if (
      projectNeedsMeshyCredits(value) &&
      value.meshyCreditBudget === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["meshyCreditBudget"],
        message: "A positive Meshy credit budget is required for live M2.",
      });
    }
  });
export type CreateProjectInput = z.input<typeof CreateProjectInputSchema>;

export const MacroGraphNodeIdSchema = z.enum([
  "post-concept.route",
  "m0.asset-production",
  "m0.asset-quality",
  "m0.scene-composition",
  "m2.asset-planning",
  "m2.asset-plan-approval",
  "m2.staged-asset-gate",
  "m2.expand-asset-paths",
  "m2.asset.multiview-concept",
  "m2.asset.production",
  "m2.asset.deterministic-qa",
  "m2.asset.turntable-evaluation",
  "m2.asset.regeneration",
  "m2.asset.finishing",
  "m2.asset-batch-aggregation",
  "m2.complete",
]);
export type MacroGraphNodeId = z.infer<typeof MacroGraphNodeIdSchema>;

export const MacroGraphInputSchema = z.object({
  projectId: z.string().min(1),
  maxConcurrency: z.number().int().min(1).max(8),
});
export type MacroGraphInput = z.infer<typeof MacroGraphInputSchema>;

export const MacroGraphOutputSchema = z.object({
  projectId: z.string().min(1),
  milestone: z.enum(["m0", "m2"]),
  terminalStage: ProjectStageSchema,
});
export type MacroGraphOutput = z.infer<typeof MacroGraphOutputSchema>;

export const MacroGraphResumeSchema = z.object({
  trigger: z.enum([
    "http-poll",
    "explicit-advance",
    "approval-recorded",
    "reconstructed",
  ]),
});
export type MacroGraphResume = z.infer<typeof MacroGraphResumeSchema>;

export const MacroGraphSuspendSchema = z.object({
  projectId: z.string().min(1),
  nodeId: MacroGraphNodeIdSchema,
  reason: z.enum(["provider-pending", "approval-required"]),
  requestId: z.string().min(1).optional(),
  resumeAfter: z.string().datetime().optional(),
  assetId: z.string().min(1).optional(),
});
export type MacroGraphSuspend = z.infer<typeof MacroGraphSuspendSchema>;

export const AssetPlanningNodeInputSchema = z.object({
  projectId: z.string().min(1),
});
export const AssetPlanningNodeOutputSchema = z.object({
  projectId: z.string().min(1),
  assetPlan: RevisionRefSchema,
  orderedAssetIds: z.array(z.string().min(1)).min(1),
});

export const AssetPathBaseSchema = z.object({
  projectId: z.string().min(1),
  assetPlan: RevisionRefSchema,
  assetId: z.string().min(1),
  classification: AssetClassificationSchema.optional(),
});
export const MultiviewNodeOutputSchema = AssetPathBaseSchema.extend({
  multiviewConceptSet: RevisionRefSchema.optional(),
  multiviewDecision: z.enum(["ready", "not-required"]),
});
export type MultiviewNodeOutput = z.infer<typeof MultiviewNodeOutputSchema>;
export const AssetProductionNodeOutputSchema = MultiviewNodeOutputSchema.extend(
  {
    candidateAsset: RevisionRefSchema,
  },
);
export const DeterministicQaNodeOutputSchema =
  AssetProductionNodeOutputSchema.extend({
    deterministicReport: RevisionRefSchema,
    turntable: RevisionRefSchema.optional(),
  });
export const TurntableEvaluationNodeOutputSchema =
  DeterministicQaNodeOutputSchema.extend({
    semanticReport: RevisionRefSchema.optional(),
    disposition: z.enum(["accept", "regenerate", "user-action-required"]),
  });
export const RegenerationNodeOutputSchema =
  TurntableEvaluationNodeOutputSchema.extend({
    bestAsset: RevisionRefSchema,
    finalDeterministicReport: RevisionRefSchema,
    finalSemanticReport: RevisionRefSchema.optional(),
    decision: RevisionRefSchema.optional(),
    attemptCount: z.number().int().nonnegative(),
    validated: z.boolean(),
  });
export const AssetBatchNodeOutputSchema = z.object({
  projectId: z.string().min(1),
  assetPlan: RevisionRefSchema,
  assets: z.array(RegenerationNodeOutputSchema).min(1),
});

export type MacroPhaseOutcome<T> =
  | { status: "ready"; value: T }
  | { status: "pending"; requestId: string; resumeAfter: string }
  | { status: "failed"; error: WorkflowFailure };

export interface MacroPhase<I, O> {
  ensure(input: I): Promise<MacroPhaseOutcome<O>>;
}

export const ApprovalInputSchema = z.object({
  decision: z.enum(["approved", "rejected", "changes-requested"]),
  notes: z.string().max(1_000).optional(),
});
export type ApprovalInput = z.infer<typeof ApprovalInputSchema>;

/** Returns a project blocked by a rejection to that gate's review. */
export const ReopenApprovalReviewInputSchema = z.object({
  gate: ApprovalGateSchema,
});
export type ReopenApprovalReviewInput = z.infer<
  typeof ReopenApprovalReviewInputSchema
>;

/** Kicks off the first paid task — 20 credits of geometry — for one asset. */
export const StartAssetStageInputSchema = z.object({
  assetId: z.string().min(1),
});
export type StartAssetStageInput = z.infer<typeof StartAssetStageInputSchema>;

/**
 * A human's call at a review gate. `acknowledgedCredits` is not decoration:
 * the studio must echo back the price it showed, so a stale CTA rendered
 * against an older price list cannot silently authorize a different spend.
 */
export const DecideAssetStageInputSchema = z.object({
  assetId: z.string().min(1),
  decision: AssetStageDecisionSchema,
  acknowledgedCredits: z.number().int().nonnegative(),
  note: z.string().trim().max(600).optional(),
});
export type DecideAssetStageInput = z.infer<typeof DecideAssetStageInputSchema>;

export const UpdateMeshyConfigInputSchema = MeshyConfigSchema.partial();
export type UpdateMeshyConfigInput = z.input<
  typeof UpdateMeshyConfigInputSchema
>;

export const AnswerFrontierRoundInputSchema = z.object({
  interrogationRevisionId: z.string().min(1),
  roundId: z.string().min(1),
  answers: z
    .array(
      z.object({
        questionId: z.string().min(1),
        value: z.string().min(1),
        /** Ids returned by the attachment upload route. The refs themselves
         *  are re-read from the store server-side so a browser cannot claim
         *  bytes, a hash, or another project's artifact. */
        attachmentArtifactIds: AttachmentArtifactIdsSchema.optional(),
      }),
    )
    .min(1),
});
export type AnswerFrontierRoundInput = z.infer<
  typeof AnswerFrontierRoundInputSchema
>;

export const ConfirmSharedUnderstandingInputSchema = z.object({
  interrogationRevisionId: z.string().min(1),
  confirmed: z.literal(true),
});
export type ConfirmSharedUnderstandingInput = z.infer<
  typeof ConfirmSharedUnderstandingInputSchema
>;

export const SuggestGameNamesInputSchema = z.object({
  gameNameCandidatesRevisionId: z.string().min(1),
  feedback: z.string().trim().min(1).max(GAME_NAME_FEEDBACK_MAX_CHARS),
  attachmentArtifactIds: AttachmentArtifactIdsSchema.optional(),
});
export type SuggestGameNamesInput = z.infer<typeof SuggestGameNamesInputSchema>;

export const CommitGameNameInputSchema = z
  .object({
    gameNameCandidatesRevisionId: z.string().min(1),
    candidateId: z.string().min(1).optional(),
    name: z.string().trim().min(2).max(GAME_NAME_MAX_CHARS).optional(),
  })
  .superRefine((input, context) => {
    if ((input.candidateId === undefined) === (input.name === undefined))
      context.addIssue({
        code: "custom",
        path: [],
        message: "Choose one proposed name or type one of your own.",
      });
  });
export type CommitGameNameInput = z.infer<typeof CommitGameNameInputSchema>;

/**
 * What a continuation genuinely has to collect. Everything else — routing,
 * concurrency, the approved package — is carried over from the source world.
 * A live Meshy continuation needs its own credit cap because the source M1
 * world never had one; replay needs nothing at all.
 */
export const ContinueIntoM2InputSchema = z.object({
  meshyCreditBudget: z.number().int().positive().optional(),
  budgetUsd: z.number().positive().optional(),
  maxConcurrentExternalJobs: z.number().int().min(1).max(8).optional(),
});
export type ContinueIntoM2Input = z.infer<typeof ContinueIntoM2InputSchema>;

/** Why a world cannot be continued into M2, or undefined when it can. */
export const M1_CONTINUATION_ISSUES = {
  "not-m1": "Only an M1 world can be continued into M2.",
  "concept-set-not-approved":
    "M2 starts from an approved concept set. Approve the concept package first.",
  "game-design-not-approved":
    "The Game Design Spec approval no longer binds this world's current spec.",
  "visual-direction-not-approved":
    "The visual direction approval no longer binds this world's Visual Bible.",
} as const;
export type M1ContinuationIssue = keyof typeof M1_CONTINUATION_ISSUES;

const bindsRevision = (
  approval: ApprovalDecision | undefined,
  revision: RevisionRef | undefined,
): boolean =>
  approval?.decision === "approved" &&
  revision !== undefined &&
  approval.targetRevisionId === revision.revisionId &&
  approval.targetSha256 === revision.artifact.sha256;

/**
 * M2 reuses M1's interrogation, Game Design Spec, visual direction, concept
 * plan, concept generation, and concept-set approval, and skips M1 sound work.
 * So the seam is exactly the concept-set approval: any M1 world whose three
 * creative approvals still bind its current revisions holds everything an M2
 * project needs at asset planning. A finished M1 world always qualifies.
 */
export const m1ContinuationIssue = (state: {
  milestone: Milestone;
  gameDesignSpec?: RevisionRef | undefined;
  gameDesignApproval?: ApprovalDecision | undefined;
  visualBible?: RevisionRef | undefined;
  directionApproval?: ApprovalDecision | undefined;
  conceptSet?: RevisionRef | undefined;
  conceptSetApproval?: ApprovalDecision | undefined;
}): M1ContinuationIssue | undefined => {
  if (state.milestone !== "m1") return "not-m1";
  if (!bindsRevision(state.conceptSetApproval, state.conceptSet))
    return "concept-set-not-approved";
  if (!bindsRevision(state.gameDesignApproval, state.gameDesignSpec))
    return "game-design-not-approved";
  if (!bindsRevision(state.directionApproval, state.visualBible))
    return "visual-direction-not-approved";
  return undefined;
};

export const canContinueIntoM2 = (
  state: Parameters<typeof m1ContinuationIssue>[0],
): boolean => m1ContinuationIssue(state) === undefined;

export const ConceptPlanPromptOverrideSchema = z.object({
  slotId: z.string().min(1),
  prompt: z.string().min(1).max(CONCEPT_PROMPT_MAX_CHARS),
});
export type ConceptPlanPromptOverride = z.infer<
  typeof ConceptPlanPromptOverrideSchema
>;

export const ConfirmConceptPlanInputSchema = z.object({
  conceptPlanRevisionId: z.string().min(1),
  confirmed: z.literal(true),
  promptOverrides: z.array(ConceptPlanPromptOverrideSchema).optional(),
});
export type ConfirmConceptPlanInput = z.infer<
  typeof ConfirmConceptPlanInputSchema
>;

export const SoundPlanPromptOverrideSchema = z.object({
  slotId: z.string().min(1),
  prompt: z.string().min(1).max(SOUND_PROMPT_MAX),
});
export type SoundPlanPromptOverride = z.infer<
  typeof SoundPlanPromptOverrideSchema
>;

export const ConfirmSoundPlanInputSchema = z.object({
  soundPlanRevisionId: z.string().min(1),
  confirmed: z.literal(true),
  promptOverrides: z.array(SoundPlanPromptOverrideSchema).optional(),
});
export type ConfirmSoundPlanInput = z.infer<typeof ConfirmSoundPlanInputSchema>;

export const RegenerateSoundInputSchema = z.object({
  soundSetRevisionId: z.string().min(1),
  slotId: z.string().min(1),
  notes: z.string().max(1_000).optional(),
});
export type RegenerateSoundInput = z.infer<typeof RegenerateSoundInputSchema>;

export const M1ApprovalInputSchema = ApprovalInputSchema.extend({
  targetType: z.enum([
    "game-design",
    "visual-direction",
    "concept-set",
    "sound-set",
  ]),
  targetRevisionId: z.string().min(1),
  targetSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type M1ApprovalInput = z.infer<typeof M1ApprovalInputSchema>;

export const ReplaceVisualDirectionInputSchema = z.object({
  directionSetRevisionId: z.string().min(1),
  directionRevisionId: z.string().min(1),
  notes: z.string().min(1).max(1_000),
});
export type ReplaceVisualDirectionInput = z.infer<
  typeof ReplaceVisualDirectionInputSchema
>;

export const ChangeVisualDirectionInputSchema = z.object({
  directionSetRevisionId: z.string().min(1),
  directionRevisionId: z.string().min(1),
  change: z.string().min(1).max(1_000),
  pinnedAspects: z.array(z.string().min(1)).min(1),
});
export type ChangeVisualDirectionInput = z.infer<
  typeof ChangeVisualDirectionInputSchema
>;

export const RegenerateConceptInputSchema = z.object({
  conceptSetRevisionId: z.string().min(1),
  slotId: z.string().min(1),
  notes: z.string().max(1_000).optional(),
});
export type RegenerateConceptInput = z.infer<
  typeof RegenerateConceptInputSchema
>;

export const RebaseConceptSetInputSchema = z.object({
  conceptSetRevisionId: z.string().min(1),
  directionSetRevisionId: z.string().min(1),
  previousDirectionRevisionId: z.string().min(1),
  newDirectionRevisionId: z.string().min(1),
});
export type RebaseConceptSetInput = z.infer<typeof RebaseConceptSetInputSchema>;

export const SelectConceptRevisionInputSchema = z.object({
  conceptSetRevisionId: z.string().min(1),
  slotId: z.string().min(1),
  conceptRevisionId: z.string().min(1),
});
export type SelectConceptRevisionInput = z.infer<
  typeof SelectConceptRevisionInputSchema
>;

export const ReviseGameDesignSpecInputSchema = z.object({
  gameDesignSpecRevisionId: z.string().min(1),
  change: z.string().min(1).max(1_000),
});
export type ReviseGameDesignSpecInput = z.infer<
  typeof ReviseGameDesignSpecInputSchema
>;

export const IncreaseBudgetInputSchema = z
  .object({
    budgetUsd: z.number().positive().optional(),
    meshyCreditBudget: z.number().int().positive().optional(),
  })
  .superRefine((value, context) => {
    if (
      (value.budgetUsd === undefined) ===
      (value.meshyCreditBudget === undefined)
    )
      context.addIssue({
        code: "custom",
        path: [],
        message: "Raise either the USD budget or the Meshy credit budget.",
      });
  });
export type IncreaseBudgetInput = z.infer<typeof IncreaseBudgetInputSchema>;

export const ConfigurationStatusSchema = z.object({
  defaultMode: ProviderModeSchema,
  defaultAssetProvider: AssetProviderSchema,
  defaultOrchestratorProvider: ExecutionProviderSchema,
  defaultImplementationProvider: ExecutionProviderSchema,
  defaultImageProvider: ImageProviderSchema,
  liveReady: z.boolean(),
  missingLiveConfiguration: z.array(z.string()),
  executionProviders: z.array(
    z.object({
      provider: ExecutionProviderSchema,
      access: z.enum(["subscription", "api"]),
      ready: z.boolean(),
      installed: z.boolean(),
      authenticated: z.boolean(),
      capabilities: z.object({
        imageGeneration: z.boolean(),
      }),
      detail: z.string(),
    }),
  ),
  imageProviders: z.array(
    z.object({
      provider: ImageProviderSchema,
      ready: z.boolean(),
      missingConfiguration: z.array(z.string()),
      detail: z.string(),
    }),
  ),
  soundProviders: z.array(
    z.object({
      provider: SoundProviderSchema,
      ready: z.boolean(),
      missingConfiguration: z.array(z.string()),
      detail: z.string(),
    }),
  ),
  assetProviders: z.array(
    z.object({
      provider: AssetProviderSchema,
      ready: z.boolean(),
      missingConfiguration: z.array(z.string()),
    }),
  ),
  fixtureBrief: z.string(),
  m0BudgetUsd: z.number().positive().optional(),
});
export type ConfigurationStatus = z.infer<typeof ConfigurationStatusSchema>;

export const SubmissionStatusSchema = z.enum([
  "intent-recorded",
  "pending",
  "ready",
  "failed",
  "submission-unknown",
]);
export type SubmissionStatus = z.infer<typeof SubmissionStatusSchema>;

export type SubmissionRecord = {
  requestId: string;
  projectId: string;
  operation: string;
  provider: string;
  idempotencyKey: string;
  status: SubmissionStatus;
  externalJobId?: string;
  resultRevisionId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type ProductionOutcome<T> =
  | { status: "pending"; requestId: string; resumeAfter: string }
  | { status: "ready"; requestId: string; value: T }
  | { status: "failed"; requestId: string; error: BlockedReason };

export const ProviderPreflightCodeSchema = z.enum([
  "budget-refused",
  "provider-unconfigured",
  "payload-invalid",
]);
export type ProviderPreflightCode = z.infer<typeof ProviderPreflightCodeSchema>;

export class ProviderPreflightError extends Error {
  readonly code: ProviderPreflightCode;

  constructor(code: ProviderPreflightCode, message: string) {
    super(message);
    this.name = "ProviderPreflightError";
    this.code = code;
  }
}

export const isProviderPreflightError = (
  error: unknown,
): error is ProviderPreflightError => error instanceof ProviderPreflightError;

export const ProviderUsageCodeSchema = z.enum(["subscription-quota"]);
export type ProviderUsageCode = z.infer<typeof ProviderUsageCodeSchema>;

export class ProviderUsageError extends Error {
  readonly code: ProviderUsageCode;

  constructor(code: ProviderUsageCode, message: string) {
    super(message);
    this.name = "ProviderUsageError";
    this.code = code;
  }
}

export const isProviderUsageError = (
  error: unknown,
): error is ProviderUsageError => error instanceof ProviderUsageError;

export const preflightCodeFromPayload = (
  payload: Record<string, unknown>,
): ProviderPreflightCode | undefined => {
  const parsed = ProviderPreflightCodeSchema.safeParse(payload.preflightCode);
  return parsed.success ? parsed.data : undefined;
};

export const providerCallStartedAtFromPayload = (
  payload: Record<string, unknown>,
): string | undefined =>
  typeof payload.providerCallStartedAt === "string"
    ? payload.providerCallStartedAt
    : undefined;

export type DurableSubmissionDecision =
  | { kind: "ready"; submission: SubmissionRecord }
  | { kind: "terminal-failed"; submission: SubmissionRecord }
  | { kind: "inspect"; submission: SubmissionRecord }
  | { kind: "unknown-interruption"; submission: SubmissionRecord }
  | { kind: "proceed"; submission?: SubmissionRecord };

/**
 * Shared start-of-ensure decision for M0 asset jobs and M1 concept ImageGen.
 * Live restart after a provider call has started stays submission-unknown.
 * A typed preflight refusal leaves the intent retryable.
 */
export const decideDurableSubmission = (
  prior: SubmissionRecord | undefined,
  mode: ProviderMode,
): DurableSubmissionDecision => {
  if (!prior) return { kind: "proceed" };
  if (prior.status === "ready") return { kind: "ready", submission: prior };
  if (prior.status === "failed" || prior.status === "submission-unknown")
    return { kind: "terminal-failed", submission: prior };
  if (prior.status === "pending" && prior.externalJobId)
    return { kind: "inspect", submission: prior };
  if (
    mode === "live" &&
    prior.status === "intent-recorded" &&
    preflightCodeFromPayload(prior.payload) &&
    !providerCallStartedAtFromPayload(prior.payload)
  )
    return { kind: "proceed", submission: prior };
  if (
    mode === "live" &&
    (prior.status === "intent-recorded" ||
      (prior.status === "pending" && !prior.externalJobId))
  )
    return { kind: "unknown-interruption", submission: prior };
  return { kind: "proceed", submission: prior };
};
