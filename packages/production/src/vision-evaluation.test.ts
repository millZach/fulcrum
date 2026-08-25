import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  AssetDocumentSchema,
  type ArtifactRef,
  type RevisionRef,
} from "@fulcrum/domain";
import {
  type ExecutionProviderStatus,
  type StructuredVisionExecution,
  type VisionFrameInput,
} from "@fulcrum/execution";
import { ProjectRepository } from "@fulcrum/project";
import { NodeIO } from "@gltf-transform/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { DEFAULT_ASSET_POLICIES } from "./deterministic-quality.js";
import { AssetQuality, createReplayReliquary } from "./index.js";
import { renderTurntable } from "./turntable.js";
import {
  ASSET_VISION_RUBRIC_V1,
  REPLAY_VISION_CATALOG,
  ReplayVisionEvaluationPort,
  VisionEvaluationError,
  materializeVisionReport,
  visionRequestDigest,
  type VisionFindings,
  type VisionRequestDescriptor,
} from "./vision-evaluation.js";

const roots: string[] = [];

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.FULCRUM_OPENAI_VISION_RESERVE_USD;
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const artifact = (
  artifactId: string,
  sha256 = createHash("sha256").update(artifactId).digest("hex"),
): ArtifactRef => ({
  artifactId,
  sha256,
  mediaType: "image/png",
  byteLength: 16,
  uri: `/api/artifacts/${artifactId}`,
});

const descriptor = (
  overrides: Partial<VisionRequestDescriptor> = {},
): VisionRequestDescriptor => ({
  assetRevisionId: "asset-revision-1",
  assetSha256: "a".repeat(64),
  policySha256: "b".repeat(64),
  classification: "hero",
  intendedUse: "Readable hero prop at the center of the arena.",
  requiredFeatures: ["cyan crystal core", "bronze binding rings"],
  prohibitedFeatures: ["photorealism"],
  referenceArtifacts: [],
  frames: Array.from({ length: 8 }, (_, frameIndex) => ({
    frameIndex,
    yawDegrees: frameIndex * 45,
    artifact: artifact(`frame-${frameIndex}`),
  })),
  rubric: ASSET_VISION_RUBRIC_V1,
  ...overrides,
});

const rearFinding = (): VisionFindings => ({
  verdict: "revise",
  dimensionScores: {
    "silhouette-readability": 0.42,
    "view-consistency": 0.76,
    "concept-fidelity": 0.81,
    "material-separation": 0.84,
    "classification-fit": 0.9,
  },
  findings: [
    {
      criterionId: "silhouette-readability",
      summary: "The rear silhouette loses the crystal housing and side guards.",
      severity: "major",
      confidence: 0.94,
      evidence: [
        { frameIndex: 3 },
        {
          frameIndex: 4,
          crop: { x: 0.28, y: 0.2, width: 0.44, height: 0.62 },
        },
        { frameIndex: 5 },
      ],
      suggestedAction:
        "Add rear and side references that define the crystal housing depth.",
    },
  ],
});

const passingVision = (): VisionFindings => ({
  verdict: "pass",
  dimensionScores: {
    "silhouette-readability": 0.9,
    "view-consistency": 0.92,
    "concept-fidelity": 0.91,
    "material-separation": 0.86,
    "classification-fit": 0.95,
  },
  findings: [],
});

const apiOnlyStatuses: ExecutionProviderStatus[] = [
  {
    provider: "openai",
    access: "subscription",
    ready: false,
    installed: true,
    authenticated: false,
    capabilities: { imageGeneration: false },
    detail: "not signed in",
  },
  {
    provider: "openai-api",
    access: "api",
    ready: true,
    installed: true,
    authenticated: true,
    capabilities: { imageGeneration: true },
    detail: "configured",
  },
];

type VisionExecutionInput<T> = {
  provider: "openai" | "openai-api";
  model?: string;
  cwd: string;
  systemPrompt: string;
  prompt: string;
  frames: VisionFrameInput[];
  schema: z.ZodType<T>;
  idempotencyKey: string;
};

const openSemanticProject = async (
  execution: StructuredVisionExecution,
): Promise<{
  repository: ProjectRepository;
  quality: AssetQuality;
  projectId: string;
  runId: string;
  asset: RevisionRef;
  policy: RevisionRef;
  deterministicReport: RevisionRef;
  turntable: RevisionRef;
}> => {
  const root = mkdtempSync(path.join(tmpdir(), "fulcrum-semantic-"));
  roots.push(root);
  const repository = new ProjectRepository(root);
  const projectId = "semantic-project";
  const runId = "semantic-run";
  const createdAt = "2026-08-24T12:00:00.000Z";
  repository.reserveProject(projectId, createdAt);
  const brief = repository.writeRevision({
    projectId,
    entityId: `${projectId}:brief`,
    kind: "game-brief",
    value: { text: "A semantic evaluation fixture.", rightsConfirmed: true },
    runId,
  });
  const glbBytes = await createReplayReliquary();
  const glb = repository.putArtifact(projectId, glbBytes, "model/gltf-binary");
  const asset = repository.writeRevision({
    projectId,
    entityId: `${projectId}:asset`,
    kind: "asset-document",
    value: AssetDocumentSchema.parse({
      assetId: `${projectId}:asset`,
      name: "Ancient Reliquary",
      classification: "hero",
      glb,
      provider: "fixture-live",
      model: "fixture-v1",
      sourceConceptRevisionId: "concept-1",
      externalJobId: "asset-job-1",
      costUsd: 0,
    }),
    runId,
  });
  const policy = repository.writeRevision({
    projectId,
    entityId: `${projectId}:policy:hero`,
    kind: "asset-policy",
    value: DEFAULT_ASSET_POLICIES.hero,
    runId,
  });
  repository.createProject({
    schemaVersion: 1,
    milestone: "m2",
    projectId,
    name: "Semantic fixture",
    mode: "live",
    status: "active",
    stage: "asset-batch",
    runId,
    budgetUsd: 1,
    spentUsd: 0,
    brief,
    createdAt,
    updatedAt: createdAt,
  });
  const quality = new AssetQuality(repository, {
    visionExecution: execution,
    visionProviderStatuses: apiOnlyStatuses,
  });
  const inspected = await quality.inspect({
    projectId,
    runId,
    asset,
    policy: { revision: policy, value: DEFAULT_ASSET_POLICIES.hero },
  });
  if (!inspected.turntable)
    throw new Error("Fixture did not render a turntable.");
  return {
    repository,
    quality,
    projectId,
    runId,
    asset,
    policy,
    deterministicReport: inspected.deterministicReport,
    turntable: inspected.turntable,
  };
};

const semanticRequest = (
  fixture: Awaited<ReturnType<typeof openSemanticProject>>,
) => ({
  projectId: fixture.projectId,
  runId: fixture.runId,
  mode: "live" as const,
  asset: fixture.asset,
  deterministicReport: fixture.deterministicReport,
  turntable: fixture.turntable,
  policy: {
    revision: fixture.policy,
    value: DEFAULT_ASSET_POLICIES.hero,
  },
  context: {
    intendedUse: "Readable hero prop at the center of the arena.",
    requiredFeatures: ["cyan crystal core", "bronze binding rings"],
    prohibitedFeatures: ["photorealism"],
    referenceArtifacts: [],
  },
});

describe("materializeVisionReport", () => {
  it("maps_frame_indices_and_crops_to_real_artifact_ids", () => {
    const report = materializeVisionReport(descriptor(), rearFinding());

    expect(report.findings[0]?.evidence).toEqual([
      {
        artifactId: "frame-3",
        kind: "turntable-frame",
        frameIndex: 3,
      },
      {
        artifactId: "frame-4",
        kind: "turntable-frame",
        frameIndex: 4,
        crop: { x: 0.28, y: 0.2, width: 0.44, height: 0.62 },
      },
      {
        artifactId: "frame-5",
        kind: "turntable-frame",
        frameIndex: 5,
      },
    ]);
    expect(report.findings[0]?.evidenceArtifactIds).toEqual([
      "frame-3",
      "frame-4",
      "frame-5",
    ]);
  });

  it("rejects_unknown_frame_index_and_pass_with_major_finding", () => {
    const unknownFrame = rearFinding();
    unknownFrame.findings[0]!.evidence = [{ frameIndex: 99 }];
    expect(() => materializeVisionReport(descriptor(), unknownFrame)).toThrow(
      /unknown frame index 99/i,
    );

    expect(() =>
      materializeVisionReport(descriptor(), {
        ...rearFinding(),
        verdict: "pass",
      }),
    ).toThrow(/pass.*major/i);
  });

  it("creates_stable_finding_ids_from_identical_evidence", () => {
    const first = materializeVisionReport(descriptor(), rearFinding());
    const second = materializeVisionReport(descriptor(), rearFinding());

    expect(second.findings[0]?.findingId).toBe(first.findings[0]?.findingId);
  });
});

describe("ReplayVisionEvaluationPort", () => {
  it("returns_fixture_only_for_exact_request_digest", async () => {
    const request = descriptor();
    const response = rearFinding();
    const port = new ReplayVisionEvaluationPort({
      schema: "fulcrum.replay-vision-catalog",
      version: 1,
      fixtures: [
        {
          requestDigest: visionRequestDigest(request),
          description: "Exact fixture",
          response,
        },
      ],
    });
    const frameBytes = request.frames.map(({ artifact: frameArtifact }) =>
      Uint8Array.from(Buffer.from(frameArtifact.artifactId)),
    );
    const withMatchingHashes = descriptor({
      frames: request.frames.map((frame, index) => ({
        ...frame,
        artifact: artifact(
          frame.artifact.artifactId,
          createHash("sha256").update(frameBytes[index]!).digest("hex"),
        ),
      })),
    });
    const matchingPort = new ReplayVisionEvaluationPort({
      schema: "fulcrum.replay-vision-catalog",
      version: 1,
      fixtures: [
        {
          requestDigest: visionRequestDigest(withMatchingHashes),
          description: "Exact fixture",
          response,
        },
      ],
    });

    await expect(
      matchingPort.evaluate(
        { ...withMatchingHashes, frameBytes },
        "vision:key",
      ),
    ).resolves.toMatchObject({
      findings: response,
      provider: "fulcrum-replay",
      model: "replay-vision-catalog-v1",
      costUsd: 0,
    });
    await expect(
      port.evaluate(
        {
          ...descriptor({ assetSha256: "c".repeat(64) }),
          frameBytes,
        },
        "vision:key",
      ),
    ).rejects.toBeInstanceOf(VisionEvaluationError);
  });

  it("fails_policy_blocked_when_fixture_is_missing", async () => {
    const request = descriptor();
    const port = new ReplayVisionEvaluationPort({
      schema: "fulcrum.replay-vision-catalog",
      version: 1,
      fixtures: [],
    });

    await expect(
      port.evaluate(
        { ...request, frameBytes: request.frames.map(() => new Uint8Array()) },
        "vision:key",
      ),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/replay|integrity/),
      failureKind: "policy-blocked",
    });
  });

  it("catalog_entries_match_current_replay_turntable_hashes", async () => {
    for (const [variant, description] of [
      ["baseline", "baseline replay reliquary"],
      ["rear-defined", "rear-defined replay reliquary"],
    ] as const) {
      const bytes = await createReplayReliquary(variant);
      const document = await new NodeIO().readBinary(bytes);
      const frames = renderTurntable(
        document,
        DEFAULT_ASSET_POLICIES.hero.turntable,
      );
      const request = descriptor({
        assetSha256: createHash("sha256").update(bytes).digest("hex"),
        policySha256: createHash("sha256")
          .update(JSON.stringify(DEFAULT_ASSET_POLICIES.hero, null, 2))
          .digest("hex"),
        frames: frames.map((frame) => ({
          frameIndex: frame.frameIndex,
          yawDegrees: frame.yawDegrees,
          artifact: artifact(
            `replay-frame-${frame.frameIndex}`,
            createHash("sha256").update(frame.bytes).digest("hex"),
          ),
        })),
      });
      const fixture = REPLAY_VISION_CATALOG.fixtures.find(
        (entry) => entry.description === description,
      );

      expect(fixture?.requestDigest).toBe(visionRequestDigest(request));
    }
  });
});

describe("AssetQuality.ensureSemantic", () => {
  it("journals_intent_before_live_execution", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    let repository: ProjectRepository | undefined;
    const execution: StructuredVisionExecution = {
      async generateStructuredVision<T>(input: VisionExecutionInput<T>) {
        const submission = repository?.getSubmissionByKey(input.idempotencyKey);
        expect(submission).toMatchObject({
          status: "pending",
          provider: "openai-api",
        });
        expect(submission?.payload.providerCallStartedAt).toEqual(
          expect.any(String),
        );
        return {
          value: passingVision() as T,
          provider: input.provider,
          model: "vision-fixture-v1",
        };
      },
    };
    const fixture = await openSemanticProject(execution);
    repository = fixture.repository;

    const outcome = await fixture.quality.ensureSemantic(
      semanticRequest(fixture),
    );

    expect(outcome.status).toBe("ready");
    expect(
      fixture.repository.listEvents(fixture.projectId).map(({ type }) => type),
    ).toEqual(
      expect.arrayContaining([
        "asset.semantic-evaluation-submitted",
        "asset.semantic-evaluation-completed",
      ]),
    );
    fixture.repository.close();
  });

  it("reserves_api_budget_once_across_resume", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.FULCRUM_OPENAI_VISION_RESERVE_USD = "0.07";
    const call = vi.fn(async () => {
      throw new Error("connection reset after request body");
    });
    const execution: StructuredVisionExecution = {
      generateStructuredVision: call,
    };
    const fixture = await openSemanticProject(execution);

    const first = await fixture.quality.ensureSemantic(
      semanticRequest(fixture),
    );
    const spentAfterFirst = fixture.repository.getProject(
      fixture.projectId,
    ).spentUsd;
    const second = await fixture.quality.ensureSemantic(
      semanticRequest(fixture),
    );

    expect(first.status).toBe("failed");
    expect(second.status).toBe("failed");
    expect(spentAfterFirst).toBe(0.07);
    expect(fixture.repository.getProject(fixture.projectId).spentUsd).toBe(
      0.07,
    );
    expect(call).toHaveBeenCalledOnce();
    fixture.repository.close();
  });

  it("marks_ambiguous_api_interruption_submission_unknown", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const call = vi.fn(async () => {
      throw new Error("socket ended without a response");
    });
    const fixture = await openSemanticProject({
      generateStructuredVision: call,
    });

    const first = await fixture.quality.ensureSemantic(
      semanticRequest(fixture),
    );
    const second = await fixture.quality.ensureSemantic(
      semanticRequest(fixture),
    );

    expect(first).toMatchObject({
      status: "failed",
      error: { code: "submission-unknown" },
    });
    expect(second).toMatchObject({
      status: "failed",
      error: { code: "submission-unknown" },
    });
    expect(call).toHaveBeenCalledOnce();
    expect(
      fixture.repository
        .listEvents(fixture.projectId)
        .filter(
          ({ type }) => type === "asset.semantic-evaluation-submission-unknown",
        ),
    ).toHaveLength(1);
    fixture.repository.close();
  });

  it("returns_ready_revision_without_reinvoking_provider", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const call = vi.fn();
    const execution: StructuredVisionExecution = {
      async generateStructuredVision<T>(input: VisionExecutionInput<T>) {
        call(input);
        return {
          value: passingVision() as T,
          provider: input.provider,
          model: "vision-fixture-v1",
        };
      },
    };
    const fixture = await openSemanticProject(execution);

    const first = await fixture.quality.ensureSemantic(
      semanticRequest(fixture),
    );
    const second = await fixture.quality.ensureSemantic(
      semanticRequest(fixture),
    );

    expect(first.status).toBe("ready");
    expect(second.status).toBe("ready");
    if (first.status === "ready" && second.status === "ready")
      expect(second.value.revision).toEqual(first.value.revision);
    expect(call).toHaveBeenCalledOnce();
    fixture.repository.close();
  });

  it("persists_report_with_exact_turntable_and_model_lineage", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const fixture = await openSemanticProject({
      async generateStructuredVision<T>(input: VisionExecutionInput<T>) {
        return {
          value: passingVision() as T,
          provider: input.provider,
          model: "vision-fixture-v1",
        };
      },
    });

    const outcome = await fixture.quality.ensureSemantic(
      semanticRequest(fixture),
    );

    expect(outcome.status).toBe("ready");
    if (outcome.status === "ready") {
      expect(outcome.value.report).toMatchObject({
        assetRevisionId: fixture.asset.revisionId,
        turntableRevisionId: fixture.turntable.revisionId,
        provider: "openai-api",
        model: "vision-fixture-v1",
        verdict: "pass",
      });
      expect(
        fixture.repository.resolveRevision(outcome.value.revision),
      ).toEqual(outcome.value.report);
    }
    fixture.repository.close();
  });
});
