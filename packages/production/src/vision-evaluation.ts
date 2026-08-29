import { createHash } from "node:crypto";

import {
  ArtifactRefSchema,
  AssetClassificationSchema,
  EvaluationFindingSchema,
  NormalizedCropSchema,
  TurntableManifestSchema,
  type ArtifactRef,
  type AssetClassification,
  type EvaluationFinding,
} from "@fulcrum/domain";
import type { StructuredVisionExecution } from "@fulcrum/execution";
import { z } from "zod";

import replayCatalogJson from "./replay-vision-catalog.json" with { type: "json" };

export const VisionRubricSchema = z.object({
  rubricVersion: z.enum(["asset-turntable-v1", "asset-geometry-turntable-v1"]),
  criteria: z
    .array(
      z.object({
        criterionId: z.enum([
          "silhouette-readability",
          "view-consistency",
          "concept-fidelity",
          "material-separation",
          "classification-fit",
        ]),
        question: z.string().min(1),
        failureSeverity: z.enum(["minor", "major", "critical"]),
      }),
    )
    .min(4)
    .max(5),
});
export type VisionRubric = z.infer<typeof VisionRubricSchema>;

export const ASSET_VISION_RUBRIC_V1: VisionRubric = VisionRubricSchema.parse({
  rubricVersion: "asset-turntable-v1",
  criteria: [
    {
      criterionId: "silhouette-readability",
      question:
        "Does the silhouette remain readable and intentional across every view?",
      failureSeverity: "major",
    },
    {
      criterionId: "view-consistency",
      question:
        "Do adjacent views describe one coherent object without shape discontinuities?",
      failureSeverity: "major",
    },
    {
      criterionId: "concept-fidelity",
      question:
        "Does the asset preserve the required visual features and avoid prohibited features?",
      failureSeverity: "critical",
    },
    {
      criterionId: "material-separation",
      question:
        "Do material regions remain visually distinct at the intended use distance?",
      failureSeverity: "minor",
    },
    {
      criterionId: "classification-fit",
      question:
        "Does the asset carry the visual importance and detail expected for its class?",
      failureSeverity: "major",
    },
  ],
});

export const ASSET_GEOMETRY_VISION_RUBRIC_V1: VisionRubric =
  VisionRubricSchema.parse({
    rubricVersion: "asset-geometry-turntable-v1",
    criteria: ASSET_VISION_RUBRIC_V1.criteria.filter(
      ({ criterionId }) => criterionId !== "material-separation",
    ),
  });

export const VisionRequestDescriptorSchema = z.object({
  assetRevisionId: z.string().min(1),
  assetSha256: z.string().regex(/^[a-f0-9]{64}$/),
  policySha256: z.string().regex(/^[a-f0-9]{64}$/),
  classification: AssetClassificationSchema,
  intendedUse: z.string().min(1),
  requiredFeatures: z.array(z.string().min(1)),
  prohibitedFeatures: z.array(z.string().min(1)),
  referenceArtifacts: z.array(ArtifactRefSchema),
  frames: TurntableManifestSchema.shape.frames,
  rubric: VisionRubricSchema,
});
export type VisionRequestDescriptor = z.infer<
  typeof VisionRequestDescriptorSchema
>;

const VisionFindingDraftSchema = z.object({
  criterionId: VisionRubricSchema.shape.criteria.element.shape.criterionId,
  summary: z.string().min(1).max(1_000),
  severity: z.enum(["info", "minor", "major", "critical"]),
  confidence: z.number().min(0).max(1),
  evidence: z
    .array(
      z.object({
        frameIndex: z.number().int().nonnegative(),
        crop: NormalizedCropSchema.optional(),
      }),
    )
    .min(1),
  suggestedAction: z.string().min(1).max(1_000).optional(),
});
export type VisionFindingDraft = z.infer<typeof VisionFindingDraftSchema>;

export const VisionFindingsSchema = z.object({
  verdict: z.enum(["pass", "revise"]),
  dimensionScores: z.record(z.string().min(1), z.number().min(0).max(1)),
  findings: z.array(VisionFindingDraftSchema),
});
export type VisionFindings = z.infer<typeof VisionFindingsSchema>;

const VisionFindingDraftWireSchema = z.object({
  ...VisionFindingDraftSchema.shape,
  evidence: z
    .array(
      z.object({
        frameIndex:
          VisionFindingDraftSchema.shape.evidence.element.shape.frameIndex,
        crop: NormalizedCropSchema.nullable(),
      }),
    )
    .min(1),
  suggestedAction: VisionFindingDraftSchema.shape.suggestedAction
    .unwrap()
    .nullable(),
});

export const VisionFindingsWireSchema = z.object({
  verdict: VisionFindingsSchema.shape.verdict,
  dimensionScores: z.array(
    z.object({
      dimension: z.string().min(1),
      score: z.number().min(0).max(1),
    }),
  ),
  findings: z.array(VisionFindingDraftWireSchema),
});
export type VisionFindingsWire = z.infer<typeof VisionFindingsWireSchema>;

export const mapVisionFindingsWire = (
  findings: VisionFindingsWire,
): VisionFindings => {
  const dimensions = new Set<string>();
  for (const [scoreIndex, entry] of findings.dimensionScores.entries()) {
    if (dimensions.has(entry.dimension)) {
      throw new z.ZodError([
        {
          code: "custom",
          input: entry.dimension,
          path: ["dimensionScores", scoreIndex, "dimension"],
          message: `Duplicate vision score dimension: ${entry.dimension}.`,
        },
      ]);
    }
    dimensions.add(entry.dimension);
  }

  return {
    verdict: findings.verdict,
    dimensionScores: Object.fromEntries(
      findings.dimensionScores.map(({ dimension, score }) => [
        dimension,
        score,
      ]),
    ),
    findings: findings.findings.map((finding) => {
      const { suggestedAction, ...findingFields } = finding;
      return {
        ...findingFields,
        evidence: finding.evidence.map((item) => {
          const { crop, ...evidenceFields } = item;
          return crop === null ? evidenceFields : { ...evidenceFields, crop };
        }),
        ...(suggestedAction === null ? {} : { suggestedAction }),
      };
    }),
  };
};

export const ReplayVisionCatalogSchema = z.object({
  schema: z.literal("fulcrum.replay-vision-catalog"),
  version: z.literal(1),
  fixtures: z.array(
    z.object({
      requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
      description: z.string().min(1),
      response: VisionFindingsSchema,
    }),
  ),
});
export type ReplayVisionCatalog = z.infer<typeof ReplayVisionCatalogSchema>;

export const REPLAY_VISION_CATALOG: ReplayVisionCatalog =
  ReplayVisionCatalogSchema.parse(replayCatalogJson);

export class VisionEvaluationError extends Error {
  readonly failureKind = "policy-blocked" as const;

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "VisionEvaluationError";
  }
}

const sha256 = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex");

export const visionRequestDigest = (input: VisionRequestDescriptor): string => {
  const descriptor = VisionRequestDescriptorSchema.parse(input);
  return sha256(
    JSON.stringify({
      assetSha256: descriptor.assetSha256,
      frameHashes: descriptor.frames.map((frame) => frame.artifact.sha256),
      classification: descriptor.classification,
      policySha256: descriptor.policySha256,
      rubric: descriptor.rubric,
    }),
  );
};

export const visionRequestScopeHash = (
  input: VisionRequestDescriptor,
): string => {
  const descriptor = VisionRequestDescriptorSchema.parse(input);
  return sha256(
    JSON.stringify({
      intendedUse: descriptor.intendedUse,
      requiredFeatures: descriptor.requiredFeatures,
      prohibitedFeatures: descriptor.prohibitedFeatures,
      referenceArtifactHashes: descriptor.referenceArtifacts.map(
        (artifact) => artifact.sha256,
      ),
    }),
  );
};

const findingCategory = (
  criterionId: VisionFindingDraft["criterionId"],
): EvaluationFinding["category"] => {
  switch (criterionId) {
    case "material-separation":
      return "materials";
    case "concept-fidelity":
      return "style";
    case "classification-fit":
      return "asset";
    case "silhouette-readability":
    case "view-consistency":
      return "geometry";
  }
};

export type MaterializedVisionReport = {
  verdict: VisionFindings["verdict"];
  dimensionScores: VisionFindings["dimensionScores"];
  findings: EvaluationFinding[];
};

export const materializeVisionReport = (
  descriptorInput: VisionRequestDescriptor,
  rawInput: VisionFindings,
): MaterializedVisionReport => {
  const descriptor = VisionRequestDescriptorSchema.parse(descriptorInput);
  const raw = VisionFindingsSchema.parse(rawInput);
  if (
    raw.verdict === "pass" &&
    raw.findings.some(
      (finding) =>
        finding.severity === "major" || finding.severity === "critical",
    )
  )
    throw new VisionEvaluationError(
      "vision-verdict-inconsistent",
      "A pass verdict cannot contain a major or critical finding.",
    );

  const framesByIndex = new Map(
    descriptor.frames.map((frame) => [frame.frameIndex, frame]),
  );
  const requestDigest = visionRequestDigest(descriptor);
  const findings = raw.findings.map((draft) => {
    const evidence = draft.evidence.map((item) => {
      const frame = framesByIndex.get(item.frameIndex);
      if (!frame)
        throw new VisionEvaluationError(
          "vision-evidence-frame-unknown",
          `Vision finding cites unknown frame index ${item.frameIndex}.`,
        );
      return {
        artifactId: frame.artifact.artifactId,
        kind: "turntable-frame" as const,
        frameIndex: item.frameIndex,
        ...(item.crop ? { crop: item.crop } : {}),
      };
    });
    const evidenceArtifactIds = [
      ...new Set(evidence.map((item) => item.artifactId)),
    ];
    const findingId = `finding-${sha256(
      JSON.stringify([
        requestDigest,
        draft.criterionId,
        evidence,
        draft.summary,
      ]),
    )}`;
    return EvaluationFindingSchema.parse({
      findingId,
      findingCode: `semantic.${draft.criterionId}`,
      rubricVersion: descriptor.rubric.rubricVersion,
      category: findingCategory(draft.criterionId),
      summary: draft.summary,
      evidenceArtifactIds,
      evidence,
      severity: draft.severity,
      confidence: draft.confidence,
      ownerModule: "asset-quality.semantic",
      ...(draft.suggestedAction
        ? { suggestedAction: draft.suggestedAction }
        : {}),
    });
  });
  return {
    verdict: raw.verdict,
    dimensionScores: raw.dimensionScores,
    findings,
  };
};

export type VisionEvaluationInput = VisionRequestDescriptor & {
  frameBytes: Uint8Array[];
};

export interface VisionEvaluationPort {
  evaluate(
    request: VisionEvaluationInput,
    idempotencyKey: string,
  ): Promise<{
    findings: VisionFindings;
    provider: string;
    model: string;
    costUsd: number;
  }>;
}

export class ReplayVisionEvaluationPort implements VisionEvaluationPort {
  private readonly catalog: ReplayVisionCatalog;

  constructor(catalog: ReplayVisionCatalog) {
    this.catalog = ReplayVisionCatalogSchema.parse(catalog);
  }

  async evaluate(
    request: VisionEvaluationInput,
    idempotencyKey: string,
  ): Promise<{
    findings: VisionFindings;
    provider: string;
    model: string;
    costUsd: number;
  }> {
    void idempotencyKey;
    const descriptor = VisionRequestDescriptorSchema.parse(request);
    if (request.frameBytes.length !== descriptor.frames.length)
      throw new VisionEvaluationError(
        "vision-frame-integrity",
        "Vision frame byte count does not match the descriptor.",
      );
    descriptor.frames.forEach((frame, index) => {
      if (sha256(request.frameBytes[index]!) !== frame.artifact.sha256)
        throw new VisionEvaluationError(
          "vision-frame-integrity",
          `Vision frame ${frame.frameIndex} failed content-hash verification.`,
        );
    });
    const requestDigest = visionRequestDigest(descriptor);
    const fixture = this.catalog.fixtures.find(
      (candidate) => candidate.requestDigest === requestDigest,
    );
    if (!fixture)
      throw new VisionEvaluationError(
        "replay-vision-fixture-missing",
        `Replay vision catalog has no fixture for request ${requestDigest}.`,
      );
    return {
      findings: fixture.response,
      provider: "fulcrum-replay",
      model: "replay-vision-catalog-v1",
      costUsd: 0,
    };
  }
}

export class LiveVisionEvaluationPort implements VisionEvaluationPort {
  constructor(
    private readonly execution: StructuredVisionExecution,
    private readonly provider: "openai" | "openai-api",
    private readonly cwd: string,
    private readonly model?: string,
  ) {}

  async evaluate(
    request: VisionEvaluationInput,
    idempotencyKey: string,
  ): Promise<{
    findings: VisionFindings;
    provider: string;
    model: string;
    costUsd: number;
  }> {
    const descriptor = VisionRequestDescriptorSchema.parse(request);
    const result = await this.execution.generateStructuredVision({
      provider: this.provider,
      ...(this.model ? { model: this.model } : {}),
      cwd: this.cwd,
      systemPrompt: [
        "You are Fulcrum's asset turntable evaluator.",
        "Use only visible evidence in the supplied frames.",
        "Cite the exact frame indices for every finding.",
        "A pass verdict cannot contain a major or critical finding.",
      ].join(" "),
      prompt: JSON.stringify({
        assetRevisionId: descriptor.assetRevisionId,
        classification: descriptor.classification,
        intendedUse: descriptor.intendedUse,
        requiredFeatures: descriptor.requiredFeatures,
        prohibitedFeatures: descriptor.prohibitedFeatures,
        rubric: descriptor.rubric,
      }),
      frames: descriptor.frames.map((frame, index) => ({
        label: `frame ${frame.frameIndex}, yaw ${frame.yawDegrees} degrees`,
        mediaType: "image/png" as const,
        bytes: request.frameBytes[index]!,
      })),
      schema: VisionFindingsWireSchema,
      idempotencyKey,
    });
    const findings = VisionFindingsSchema.parse(
      mapVisionFindingsWire(result.value),
    );
    return {
      findings,
      provider: result.provider,
      model: result.model,
      costUsd: 0,
    };
  }
}

/* --------------------------- biped classification -------------------------- */

export const BipedDetectionVerdictSchema = z.object({
  biped: z.boolean(),
  confidence: z.number().min(0).max(1),
  rationale: z.string().trim().min(1).max(600),
});
export type BipedDetectionVerdict = z.infer<typeof BipedDetectionVerdictSchema>;

export type BipedDetectionInput = {
  assetId: string;
  name: string;
  description: string;
  classification: AssetClassification;
  frontImage: ArtifactRef;
  frontImageBytes: Uint8Array;
};

export interface BipedDetectionPort {
  detect(
    input: BipedDetectionInput,
    idempotencyKey: string,
  ): Promise<{
    verdict: BipedDetectionVerdict;
    provider: string;
    model: string;
    costUsd: number;
  }>;
}

const assertBipedImageIntegrity = (input: BipedDetectionInput): void => {
  const image = ArtifactRefSchema.parse(input.frontImage);
  if (image.mediaType !== "image/png")
    throw new VisionEvaluationError(
      "biped-front-image-format",
      "Biped detection requires the approved front view as a PNG.",
    );
  if (sha256(input.frontImageBytes) !== image.sha256)
    throw new VisionEvaluationError(
      "biped-front-image-integrity",
      "The approved front view failed content-hash verification.",
    );
};

const BIPED_TERMS = [
  "biped",
  "bipedal",
  "boss",
  "character",
  "guard",
  "guardian",
  "humanoid",
  "hunter",
  "knight",
  "person",
  "smith",
  "soldier",
  "warrior",
  "warden",
] as const;

const NON_BIPED_TERMS = [
  "building",
  "chest",
  "dragon",
  "lantern",
  "quadruped",
  "reliquary",
  "serpent",
  "ship",
  "spider",
  "terrain",
  "vehicle",
  "weapon",
] as const;

const matchingTerms = (text: string, terms: readonly string[]): string[] =>
  terms.filter((term) => new RegExp(`\\b${term}\\b`, "i").test(text));

/**
 * Replay uses the same metadata and front-image integrity checks as live, but
 * makes the verdict locally. The digest only supplies a stable confidence
 * nudge, so repeated runs cannot drift while fixture wording stays unchanged.
 */
export const detectBipedDeterministically = (
  input: BipedDetectionInput,
): BipedDetectionVerdict => {
  assertBipedImageIntegrity(input);
  const text = `${input.name} ${input.description}`.toLowerCase();
  const positive = matchingTerms(text, BIPED_TERMS);
  const negative = matchingTerms(text, NON_BIPED_TERMS);
  const biped =
    input.classification === "hero" &&
    positive.length > 0 &&
    positive.length >= negative.length;
  const seededNudge =
    Number.parseInt(
      sha256(
        JSON.stringify([
          input.assetId,
          input.name,
          input.description,
          input.classification,
          input.frontImage.sha256,
        ]),
      ).slice(0, 4),
      16,
    ) /
    0xffff /
    20;
  const confidence = Math.min(
    0.98,
    (biped ? 0.82 : positive.length === 0 ? 0.74 : 0.68) + seededNudge,
  );
  return BipedDetectionVerdictSchema.parse({
    biped,
    confidence,
    rationale: biped
      ? `Replay metadata identifies a humanoid character (${positive.join(", ")}).`
      : negative.length > 0
        ? `Replay metadata points to a non-biped asset (${negative.join(", ")}).`
        : "Replay metadata contains no biped or humanoid character terms.",
  });
};

export class ReplayBipedDetectionPort implements BipedDetectionPort {
  async detect(
    input: BipedDetectionInput,
    idempotencyKey: string,
  ): Promise<{
    verdict: BipedDetectionVerdict;
    provider: string;
    model: string;
    costUsd: number;
  }> {
    void idempotencyKey;
    return {
      verdict: detectBipedDeterministically(input),
      provider: "fulcrum-replay",
      model: "replay-biped-heuristic-v1",
      costUsd: 0,
    };
  }
}

export class LiveBipedDetectionPort implements BipedDetectionPort {
  constructor(
    private readonly execution: StructuredVisionExecution,
    private readonly provider: "openai" | "openai-api",
    private readonly cwd: string,
    private readonly model?: string,
  ) {}

  async detect(
    input: BipedDetectionInput,
    idempotencyKey: string,
  ): Promise<{
    verdict: BipedDetectionVerdict;
    provider: string;
    model: string;
    costUsd: number;
  }> {
    assertBipedImageIntegrity(input);
    const result = await this.execution.generateStructuredVision({
      provider: this.provider,
      ...(this.model ? { model: this.model } : {}),
      cwd: this.cwd,
      systemPrompt: [
        "You classify whether a game asset can use a humanoid biped auto-rigger.",
        "A biped has one torso, one head, two primary legs and a humanoid limb layout; armor, robots and stylized proportions still count.",
        "Quadrupeds, serpents, spiders, props and ambiguous silhouettes do not count.",
        "Use the front image as primary evidence and the asset metadata only as supporting context.",
        "Return a concise rationale grounded in visible anatomy.",
      ].join(" "),
      prompt: JSON.stringify({
        assetId: input.assetId,
        name: input.name,
        description: input.description,
        classification: input.classification,
      }),
      frames: [
        {
          label: "approved front reference",
          mediaType: "image/png",
          bytes: input.frontImageBytes,
        },
      ],
      schema: BipedDetectionVerdictSchema,
      idempotencyKey,
    });
    return {
      verdict: BipedDetectionVerdictSchema.parse(result.value),
      provider: result.provider,
      model: result.model,
      costUsd: 0,
    };
  }
}
