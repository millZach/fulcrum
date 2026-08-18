import { z } from "zod";

export const M0_FIXTURE_BRIEF =
  "Create a stylized third-person fantasy extraction arena centered on an ancient stone reliquary. The reliquary is a squat, readable hero prop made from weathered dark stone, restrained bronze bands, and a cyan crystal core. The visual language is painterly and hand-sculpted rather than photoreal. The arena should make the reliquary feel important, mysterious, and visible from across the play space.";

export const ProviderModeSchema = z.enum(["replay", "live"]);
export type ProviderMode = z.infer<typeof ProviderModeSchema>;

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

export const ProjectStageSchema = z.enum([
  "creative-development",
  "visual-direction-approval",
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

export const AssetDocumentSchema = z.object({
  assetId: z.string().min(1),
  name: z.string().min(1),
  classification: z.literal("hero"),
  glb: ArtifactRefSchema,
  provider: z.string().min(1),
  model: z.string().min(1),
  sourceConceptRevisionId: z.string().min(1),
  externalJobId: z.string().min(1),
  costUsd: z.number().nonnegative(),
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

export const ApprovalDecisionSchema = z.object({
  approvalId: z.string().min(1),
  projectId: z.string().min(1),
  targetType: z.enum(["visual-direction", "visual-slice"]),
  targetRevisionId: z.string().min(1),
  targetSha256: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(["approved", "rejected", "changes-requested"]),
  notes: z.string().optional(),
  decidedBy: z.string().min(1),
  decidedAt: z.string().datetime(),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const BlockedReasonSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  recoverable: z.boolean(),
});
export type BlockedReason = z.infer<typeof BlockedReasonSchema>;

export const ProjectStateSchema = z.object({
  schemaVersion: z.literal(1),
  projectId: z.string().min(1),
  name: z.string().min(1),
  mode: ProviderModeSchema,
  assetProvider: AssetProviderSchema.default("meshy"),
  orchestratorProvider: ExecutionProviderSchema.default("openai"),
  implementationProvider: ExecutionProviderSchema.default("openai"),
  imageProvider: ImageProviderSchema.default("openai-subscription"),
  status: ProjectStatusSchema,
  stage: ProjectStageSchema,
  runId: z.string().min(1),
  workflowRunId: z.string().optional(),
  budgetUsd: z.number().nonnegative(),
  spentUsd: z.number().nonnegative(),
  conceptReplacementCount: z.number().int().min(0).max(1).default(0),
  brief: RevisionRefSchema,
  gameDesign: RevisionRefSchema.optional(),
  visualBible: RevisionRefSchema.optional(),
  concept: RevisionRefSchema.optional(),
  directionApproval: ApprovalDecisionSchema.optional(),
  asset: RevisionRefSchema.optional(),
  assetEvaluation: RevisionRefSchema.optional(),
  scene: RevisionRefSchema.optional(),
  reviewImage: ArtifactRefSchema.optional(),
  sliceApproval: ApprovalDecisionSchema.optional(),
  blockedReason: BlockedReasonSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ProjectState = z.infer<typeof ProjectStateSchema>;

export const ProjectSnapshotSchema = z.object({
  state: ProjectStateSchema,
  briefText: z.string(),
  gameDesign: GameDesignDigestSchema.optional(),
  visualBible: VisualBibleSchema.optional(),
  concept: ConceptDocumentSchema.optional(),
  asset: AssetDocumentSchema.optional(),
  assetEvaluation: AssetEvaluationSchema.optional(),
  scene: FulcrumSceneSpecV0Schema.optional(),
});
export type ProjectSnapshot = z.infer<typeof ProjectSnapshotSchema>;

export const CreateProjectInputSchema = z.object({
  brief: z.string().min(40),
  mode: ProviderModeSchema,
  assetProvider: AssetProviderSchema.default("meshy"),
  orchestratorProvider: ExecutionProviderSchema.default("openai"),
  implementationProvider: ExecutionProviderSchema.default("openai"),
  imageProvider: ImageProviderSchema.default("openai-subscription"),
  budgetUsd: z.number().positive(),
  rightsConfirmed: z.literal(true),
});
export type CreateProjectInput = z.input<typeof CreateProjectInputSchema>;

export const ApprovalInputSchema = z.object({
  decision: z.enum(["approved", "rejected", "changes-requested"]),
  notes: z.string().max(1_000).optional(),
});
export type ApprovalInput = z.infer<typeof ApprovalInputSchema>;

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
