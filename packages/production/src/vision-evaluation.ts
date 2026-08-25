import { createHash } from "node:crypto";

import {
  ArtifactRefSchema,
  AssetClassificationSchema,
  EvaluationFindingSchema,
  NormalizedCropSchema,
  TurntableManifestSchema,
  type EvaluationFinding,
} from "@fulcrum/domain";
import type { StructuredVisionExecution } from "@fulcrum/execution";
import { z } from "zod";

import replayCatalogJson from "./replay-vision-catalog.json" with { type: "json" };

export const VisionRubricSchema = z.object({
  rubricVersion: z.literal("asset-turntable-v1"),
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
    .length(5),
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
      schema: VisionFindingsSchema,
      idempotencyKey,
    });
    return {
      findings: result.value,
      provider: result.provider,
      model: result.model,
      costUsd: 0,
    };
  }
}
