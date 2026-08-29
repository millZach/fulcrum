import type {
  AssetPolicy,
  AssetQualityVector,
  EvaluationFinding,
  RegenerationAttempt,
  RegenerationStrategy,
  RevisionRef,
} from "@fulcrum/domain";
import { describe, expect, it } from "vitest";

import { DEFAULT_ASSET_POLICIES } from "./deterministic-quality.js";
import { compareQualityVectors, decideRegeneration } from "./regeneration.js";

const revision = (revisionId: string): RevisionRef => ({
  entityId: revisionId.split(":")[0] ?? "entity",
  revisionId,
  kind: "fixture",
  artifact: {
    artifactId: `${revisionId}:artifact`,
    sha256: "a".repeat(64),
    mediaType: "application/json",
    byteLength: 1,
    uri: `/api/artifacts/${revisionId}:artifact`,
  },
  createdAt: "2026-08-24T12:00:00.000Z",
  createdByRunId: "run-1",
});

const vector = (
  overrides: Partial<AssetQualityVector> = {},
): AssetQualityVector => ({
  hardGateFailures: 0,
  criticalFindings: 0,
  majorFindings: 0,
  minorFindings: 0,
  semanticVerdict: "pass",
  ...overrides,
});

const attempt = (
  attemptNumber: number,
  qualityVector: AssetQualityVector,
  assetRevisionId = `asset:${attemptNumber}`,
): RegenerationAttempt => ({
  attemptNumber,
  asset: revision(assetRevisionId),
  deterministicReport: revision(`deterministic:${attemptNumber}`),
  turntable: revision(`turntable:${attemptNumber}`),
  semanticReport: revision(`semantic:${attemptNumber}`),
  qualityVector,
});

const finding = (
  criterion: string,
  overrides: Partial<EvaluationFinding> = {},
): EvaluationFinding => ({
  findingId: `finding:${criterion}`,
  findingCode: `semantic.${criterion}`,
  rubricVersion: "asset-turntable-v1",
  category: criterion === "material-separation" ? "materials" : "geometry",
  summary: `The ${criterion} criterion needs revision.`,
  evidenceArtifactIds: ["frame-4"],
  evidence: [
    {
      artifactId: "frame-4",
      kind: "turntable-frame",
      frameIndex: 4,
    },
  ],
  severity: "major",
  confidence: 0.9,
  ownerModule: "asset-quality.semantic",
  suggestedAction: `Correct ${criterion} in the next asset prompt.`,
  ...overrides,
});

const decide = (overrides: {
  currentAttempt?: RegenerationAttempt;
  attemptHistory?: RegenerationAttempt[];
  currentFindings?: EvaluationFinding[];
  failedGateIds?: string[];
  priorStrategies?: RegenerationStrategy[];
  policy?: AssetPolicy;
  providerSupportsPromptChanges?: boolean;
  permissibleClassifications?: AssetPolicy["classification"][];
}) =>
  decideRegeneration({
    assetId: "asset",
    currentAttempt:
      overrides.currentAttempt ??
      attempt(0, vector({ majorFindings: 1, semanticVerdict: "revise" })),
    attemptHistory: overrides.attemptHistory ?? [],
    currentFindings: overrides.currentFindings ?? [],
    failedGateIds: overrides.failedGateIds ?? [],
    priorStrategies: overrides.priorStrategies ?? [],
    policy: overrides.policy ?? DEFAULT_ASSET_POLICIES.hero,
    providerSupportsMultiview: true,
    providerSupportsPromptChanges:
      overrides.providerSupportsPromptChanges ?? true,
    permissibleClassifications: overrides.permissibleClassifications ?? [
      "hero",
      "kit",
    ],
  });

describe("decideRegeneration", () => {
  it("hero_rear_silhouette_finding_requests_three_rear_views", () => {
    const strategy = decide({
      currentFindings: [
        finding("silhouette-readability", {
          summary: "The rear silhouette collapses behind the crystal housing.",
        }),
      ],
    });

    expect(strategy).toMatchObject({
      kind: "change-views",
      operation: "add",
      roles: ["back", "left", "right"],
      reasonFindingIds: ["finding:silhouette-readability"],
    });
  });

  it("concept_fidelity_finding_builds_cited_prompt_changes", () => {
    const conceptFinding = finding("concept-fidelity", {
      category: "style",
      suggestedAction: "Restore the cyan crystal and remove gold filigree.",
    });

    const strategy = decide({
      currentFindings: [conceptFinding],
      providerSupportsPromptChanges: true,
    });

    expect(strategy).toMatchObject({
      kind: "change-prompt",
      reasonFindingIds: [conceptFinding.findingId],
      changes: [
        {
          findingId: conceptFinding.findingId,
          addToPrompt: conceptFinding.suggestedAction,
        },
      ],
    });
  });

  it("unsupported_prompt_changes_fall_through_to_kit_reclassification", () => {
    const strategy = decide({
      currentFindings: [
        finding("concept-fidelity"),
        finding("classification-fit", {
          summary: "This repeated piece should use kit handling.",
        }),
      ],
      policy: DEFAULT_ASSET_POLICIES.kit,
      providerSupportsPromptChanges: false,
      permissibleClassifications: ["hero", "kit"],
    });

    expect(strategy).toMatchObject({
      kind: "reclassify",
      from: "kit",
      to: "hero",
    });
  });

  it("unsupported_prompt_changes_give_up_for_procedural_assets", () => {
    const strategy = decide({
      currentFindings: [finding("concept-fidelity")],
      policy: DEFAULT_ASSET_POLICIES.procedural,
      providerSupportsPromptChanges: false,
      permissibleClassifications: ["procedural"],
    });

    expect(strategy.kind).toBe("give-up-user");
  });

  it("claimed_texture_failure_retries_same_only_once", () => {
    const first = decide({ failedGateIds: ["texture-claims"] });
    const second = decide({
      failedGateIds: ["texture-claims"],
      priorStrategies: [first],
    });

    expect(first.kind).toBe("retry-same");
    expect(second.kind).not.toBe("retry-same");
  });

  it("attempt_cap_accepts_viable_best_instead_of_latest", () => {
    const incumbent = attempt(
      0,
      vector({ minorFindings: 1, semanticVerdict: "pass" }),
      "asset:best",
    );
    const latest = attempt(
      2,
      vector({ majorFindings: 1, semanticVerdict: "revise" }),
      "asset:latest",
    );

    const strategy = decide({
      currentAttempt: latest,
      attemptHistory: [incumbent],
    });

    expect(strategy).toMatchObject({
      kind: "accept-best",
      assetRevisionId: "asset:best",
    });
  });

  it("attempt_cap_gives_up_when_best_candidate_has_revise_verdict", () => {
    const strategy = decide({
      currentAttempt: attempt(
        2,
        vector({ majorFindings: 1, semanticVerdict: "revise" }),
        "asset:latest",
      ),
      attemptHistory: [
        attempt(
          0,
          vector({ minorFindings: 1, semanticVerdict: "revise" }),
          "asset:best",
        ),
      ],
    });

    expect(strategy.kind).toBe("give-up-user");
  });

  it("attempt_cap_gives_up_when_every_candidate_has_hard_failures", () => {
    const strategy = decide({
      currentAttempt: attempt(2, vector({ hardGateFailures: 1 })),
      attemptHistory: [attempt(0, vector({ hardGateFailures: 2 }))],
    });

    expect(strategy.kind).toBe("give-up-user");
  });

  it("incomparable_candidate_retains_incumbent", () => {
    const incumbent = vector({ majorFindings: 1, minorFindings: 0 });
    const candidate = vector({ majorFindings: 0, minorFindings: 2 });

    expect(compareQualityVectors(incumbent, candidate)).toBe("incomparable");
  });
});
