import { describe, expect, it } from "vitest";

import type {
  AssetBatchEntry,
  DeterministicAssetReport,
  RegenerationDecisionReport,
  SemanticAssetReport,
  TurntableManifest,
} from "@fulcrum/domain";

import { qualityView, type QualityEvent } from "./quality-view.js";

const revision = (revisionId: string) => ({
  entityId: revisionId.split(":")[0]!,
  revisionId,
  kind: "fixture",
  artifact: {
    artifactId: `artifact:${revisionId}`,
    sha256: revisionId[0]!.repeat(64),
    mediaType: "application/json",
    byteLength: 12,
    uri: `/api/artifacts/artifact:${revisionId}`,
  },
  createdAt: "2026-08-24T00:00:00.000Z",
  createdByRunId: "run-1",
});

const selection: AssetBatchEntry = {
  assetId: "hero",
  classification: "hero",
  current: revision("hero:asset:r2"),
  best: revision("hero:asset:r1"),
  attemptCount: 2,
  validated: true,
  deterministicReport: revision("hero:deterministic:r1"),
  turntable: revision("hero:turntable:r1"),
  semanticReport: revision("hero:semantic:r1"),
  decision: revision("hero:decision:r2"),
};

const gate = (
  id: string,
  category: "mesh" | "material" | "texture" | "topology",
  passed: boolean,
) => ({
  id,
  category,
  label: id.replaceAll("-", " "),
  passed,
  actual: passed ? 1 : 3,
  threshold: "at most 1",
  evidenceArtifactIds: ["hero-glb"],
});

const deterministic = {
  schema: "fulcrum.asset-deterministic-report",
  version: 1,
  reportId: "deterministic-r1",
  assetId: "hero",
  assetRevisionId: "hero:asset:r1",
  passed: false,
  gates: [
    gate("mesh-count", "mesh", true),
    gate("texture-size", "texture", false),
    gate("open-edges", "topology", true),
  ],
  findings: [
    {
      findingId: "finding-texture",
      findingCode: "texture.too-small",
      rubricVersion: "deterministic-v1",
      category: "materials",
      summary: "The base-color texture is undersized.",
      evidenceArtifactIds: ["hero-glb"],
      evidence: [{ artifactId: "hero-glb", kind: "source-asset" }],
      severity: "major",
      confidence: 1,
      ownerModule: "asset-quality.deterministic",
    },
  ],
  qualityVector: {
    hardGateFailures: 1,
    criticalFindings: 0,
    majorFindings: 1,
    minorFindings: 0,
    semanticVerdict: "not-run",
  },
} as DeterministicAssetReport;

const turntable = {
  schema: "fulcrum.turntable",
  version: 1,
  turntableId: "turntable-r1",
  assetId: "hero",
  assetRevisionId: "hero:asset:r1",
  frames: [
    {
      frameIndex: 0,
      yawDegrees: 0,
      artifact: {
        artifactId: "frame-front",
        sha256: "f".repeat(64),
        mediaType: "image/png",
        byteLength: 20,
        uri: "/api/artifacts/frame-front",
      },
    },
    {
      frameIndex: 1,
      yawDegrees: 90,
      artifact: {
        artifactId: "frame-left",
        sha256: "e".repeat(64),
        mediaType: "image/png",
        byteLength: 20,
        uri: "/api/artifacts/frame-left",
      },
    },
  ],
} as TurntableManifest;

const semantic = {
  schema: "fulcrum.asset-semantic-report",
  version: 1,
  reportId: "semantic-r1",
  assetId: "hero",
  assetRevisionId: "hero:asset:r1",
  verdict: "revise",
  findings: [
    {
      findingId: "finding-silhouette",
      findingCode: "semantic.rear-silhouette",
      rubricVersion: "asset-turntable-v1",
      category: "style",
      summary: "The rear silhouette loses the approved shoulder shape.",
      evidenceArtifactIds: ["frame-left"],
      evidence: [
        {
          artifactId: "frame-left",
          kind: "turntable-frame",
          frameIndex: 1,
          crop: { x: 0.22, y: 0.12, width: 0.4, height: 0.6 },
        },
      ],
      severity: "major",
      confidence: 0.92,
      ownerModule: "asset-quality.semantic",
      suggestedAction: "Add rear identity views.",
    },
  ],
  qualityVector: {
    hardGateFailures: 0,
    criticalFindings: 0,
    majorFindings: 1,
    minorFindings: 0,
    semanticVerdict: "revise",
  },
} as SemanticAssetReport;

const changeViews = {
  schema: "fulcrum.asset-regeneration-decision",
  version: 1,
  decisionId: "decision-1",
  assetId: "hero",
  sourceReportRevisionIds: ["hero:semantic:r1"],
  bestKnownAssetRevisionId: "hero:asset:r1",
  strategy: {
    kind: "change-views",
    rationale: "The rear silhouette needs stronger identity evidence.",
    reasonFindingIds: ["finding-silhouette"],
    operation: "add",
    roles: ["back", "left", "right"],
    brief: "Preserve the front identity while defining the rear silhouette.",
  },
} as RegenerationDecisionReport;

const events: QualityEvent[] = [
  {
    eventId: "event-1",
    runId: "run-1",
    type: "asset.regeneration-strategy-selected",
    payload: {
      assetId: "hero",
      attemptNumber: 0,
      decisionRevisionId: "hero:decision:r1",
      strategyKind: "change-views",
    },
    createdAt: "2026-08-24T00:01:00.000Z",
  },
  {
    eventId: "event-2",
    runId: "run-1",
    type: "asset.regeneration-attempt-started",
    payload: { attemptNumber: 1, strategyRevisionId: "hero:decision:r1" },
    createdAt: "2026-08-24T00:02:00.000Z",
  },
];

const reports = {
  deterministicReports: [deterministic],
  turntables: [turntable],
  semanticReports: [semantic],
  decisions: [{ revisionId: "hero:decision:r1", report: changeViews }],
};

describe("quality evidence view", () => {
  it("groups gates and findings without collapsing them to one score", () => {
    const view = qualityView(selection, reports, events);

    expect(view.gateGroups.map(({ category }) => category)).toEqual([
      "mesh",
      "texture",
      "topology",
    ]);
    expect(
      view.gateGroups.find(({ category }) => category === "texture"),
    ).toMatchObject({ failedCount: 1, gates: [{ id: "texture-size" }] });
    expect(view.findingGroups).toEqual([
      expect.objectContaining({
        source: "deterministic",
        findings: [expect.anything()],
      }),
      expect.objectContaining({
        source: "semantic",
        findings: [expect.anything()],
      }),
    ]);
    expect(view).not.toHaveProperty("score");
  });

  it("links a semantic crop to its cited turntable frame", () => {
    const view = qualityView(selection, reports, events);
    const cited = view.frames.find(
      ({ artifactId }) => artifactId === "frame-left",
    );

    expect(cited?.overlays).toEqual([
      {
        findingId: "finding-silhouette",
        summary: "The rear silhouette loses the approved shoulder shape.",
        severity: "major",
        crop: { x: 0.22, y: 0.12, width: 0.4, height: 0.6 },
      },
    ]);
  });

  it("marks best separately from latest and shows the strategy timeline", () => {
    const view = qualityView(selection, reports, events);

    expect(view.revisions).toEqual([
      { revisionId: "hero:asset:r1", best: true, latest: false },
      { revisionId: "hero:asset:r2", best: false, latest: true },
    ]);
    expect(view.timeline).toEqual([
      expect.objectContaining({
        attemptNumber: 0,
        strategyKind: "change-views",
        roles: ["back", "left", "right"],
        rationale: "The rear silhouette needs stronger identity evidence.",
      }),
    ]);
  });
});
