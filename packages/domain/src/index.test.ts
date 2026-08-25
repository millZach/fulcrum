import { describe, expect, it } from "vitest";

import {
  ASSET_CLASS_HANDLING_POLICIES_V1,
  AssetPlanSchema,
  AssetBatchEntrySchema,
  CreateProjectInputSchema,
  FailureKindSchema,
  MacroGraphSuspendSchema,
  PlannedAssetSchema,
  ProjectStateSchema,
  WorkflowFailureSchema,
  assetPlanGraphIssues,
  handlingForPlannedAsset,
  hasMeteredRoutes,
} from "./index.js";

const brief =
  "Create a compact lunar greenhouse stealth game with one creature and one readable escape route.";

const persistedState = (milestone: "m0" | "m1" | "m2", stage: string) => {
  const createdAt = new Date().toISOString();
  return {
    schemaVersion: 1 as const,
    milestone,
    projectId: `${milestone}-project`,
    name: `${milestone.toUpperCase()} project`,
    mode: "replay" as const,
    status: "active" as const,
    stage,
    runId: "run-1",
    spentUsd: 0,
    brief: {
      entityId: "brief-1",
      revisionId: "revision-1",
      kind: "game-brief",
      artifact: {
        artifactId: "artifact-1",
        sha256: "a".repeat(64),
        mediaType: "application/json",
        byteLength: 1,
        uri: "/api/artifacts/artifact-1",
      },
      createdAt,
      createdByRunId: "run-1",
    },
    createdAt,
    updatedAt: createdAt,
  };
};

const ancestor = (revisionId: string, sha = "a".repeat(64)) => ({
  revisionId,
  sha256: sha,
  kind: "test-revision",
});

const plannedAsset = (overrides: Record<string, unknown> = {}) => ({
  assetId: "project-1:planned-asset:hero",
  name: "Reliquary",
  classification: "hero",
  rationale: "The approved gameplay anchor needs a readable hero asset.",
  sourceRefs: {
    gameDesignSpec: ancestor("gds-1"),
    conceptSet: ancestor("concept-set-1", "b".repeat(64)),
    conceptSlots: [
      {
        slotId: "gameplay-anchor",
        concept: ancestor("concept-1", "c".repeat(64)),
      },
    ],
  },
  dependsOnAssetIds: [],
  acceptanceCriteria: ["Readable from across the play space."],
  ...overrides,
});

const assetPlan = (assets = [plannedAsset()]) => ({
  planId: "project-1:asset-plan",
  assets,
  handling: ASSET_CLASS_HANDLING_POLICIES_V1,
  provenance: {
    revisionId: "asset-plan-revision-1",
    parentRevisionIds: ["gds-1", "concept-set-1", "concept-1"],
    sourceArtifactHashes: ["a".repeat(64), "b".repeat(64), "c".repeat(64)],
    runId: "run-1",
    operation: "asset-plan.initial",
    createdAt: "2026-08-24T12:00:00.000Z",
  },
});

const parsedPlannedAsset = (overrides: Record<string, unknown> = {}) =>
  PlannedAssetSchema.parse(plannedAsset(overrides));

describe("asset plan schema", () => {
  it("asset_plan_schema_accepts_the_four_class_contract", () => {
    const policy = ASSET_CLASS_HANDLING_POLICIES_V1;

    expect(policy).toEqual({
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
    expect(AssetPlanSchema.parse(assetPlan()).handling).toEqual(policy);
  });

  it("asset_plan_schema_requires_parameters_only_for_procedural_assets", () => {
    expect(
      PlannedAssetSchema.safeParse(
        plannedAsset({ classification: "procedural" }),
      ).success,
    ).toBe(false);
    expect(
      PlannedAssetSchema.safeParse(
        plannedAsset({
          classification: "procedural",
          procedure: {
            generatorId: "scatter-dressing-v1",
            parameters: { density: 0.65, avoidGameplayLane: true },
          },
        }),
      ).success,
    ).toBe(true);
    expect(
      PlannedAssetSchema.safeParse(
        plannedAsset({
          procedure: {
            generatorId: "not-for-heroes",
            parameters: { enabled: true },
          },
        }),
      ).success,
    ).toBe(false);
  });

  it("asset_plan_schema_rejects_more_than_twelve_assets", () => {
    const assets = Array.from({ length: 13 }, (_, index) =>
      plannedAsset({
        assetId: `project-1:planned-asset:hero-${index}`,
        name: `Hero ${index}`,
      }),
    );

    expect(AssetPlanSchema.safeParse(assetPlan(assets)).success).toBe(false);
  });

  it("handling_for_planned_asset_returns_the_approved_policy", () => {
    const plan = AssetPlanSchema.parse(assetPlan());

    expect(
      handlingForPlannedAsset(plan, "project-1:planned-asset:hero"),
    ).toEqual({ asset: plan.assets[0], policy: plan.handling.hero });
  });

  it("project_state_schema_still_parses_existing_m0_and_m1_rows", () => {
    expect(
      ProjectStateSchema.safeParse(persistedState("m0", "asset-production"))
        .success,
    ).toBe(true);
    expect(
      ProjectStateSchema.safeParse(persistedState("m1", "interrogation"))
        .success,
    ).toBe(true);
  });
});

describe("asset plan graph", () => {
  it("asset_plan_graph_rejects_duplicate_logical_ids", () => {
    const issues = assetPlanGraphIssues([
      parsedPlannedAsset(),
      parsedPlannedAsset({ name: "Duplicate reliquary" }),
    ]);

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "duplicate-asset-id",
          assetId: "project-1:planned-asset:hero",
        }),
      ]),
    );
  });

  it("asset_plan_graph_rejects_an_unknown_dependency", () => {
    const issues = assetPlanGraphIssues([
      parsedPlannedAsset({ dependsOnAssetIds: ["missing-asset"] }),
    ]);

    expect(issues).toEqual([
      expect.objectContaining({
        code: "unknown-dependency",
        relatedAssetId: "missing-asset",
      }),
    ]);
  });

  it("asset_plan_graph_rejects_a_self_dependency", () => {
    const asset = parsedPlannedAsset({
      dependsOnAssetIds: ["project-1:planned-asset:hero"],
    });

    expect(assetPlanGraphIssues([asset])).toEqual([
      expect.objectContaining({
        code: "self-dependency",
        assetId: asset.assetId,
      }),
    ]);
  });

  it("asset_plan_graph_reports_the_members_of_a_cycle", () => {
    const heroId = "project-1:planned-asset:hero";
    const kitId = "project-1:planned-asset:kit";
    const issues = assetPlanGraphIssues([
      parsedPlannedAsset({ dependsOnAssetIds: [kitId] }),
      parsedPlannedAsset({
        assetId: kitId,
        name: "Arena kit",
        classification: "kit",
        dependsOnAssetIds: [heroId],
      }),
    ]);

    expect(
      issues
        .filter((issue) => issue.code === "dependency-cycle")
        .map((issue) => issue.assetId)
        .sort(),
    ).toEqual([heroId, kitId]);
  });

  it("asset_plan_graph_accepts_a_disconnected_acyclic_graph", () => {
    const heroId = "project-1:planned-asset:hero";
    const kitId = "project-1:planned-asset:kit";
    const assets = [
      parsedPlannedAsset(),
      parsedPlannedAsset({
        assetId: kitId,
        name: "Arena kit",
        classification: "kit",
        dependsOnAssetIds: [heroId],
      }),
      parsedPlannedAsset({
        assetId: "project-1:planned-asset:portal",
        name: "Exit portal",
        classification: "functional",
      }),
    ];

    expect(assetPlanGraphIssues(assets)).toEqual([]);
  });
});

describe("M2 domain boundaries", () => {
  it("accepts_m2_replay_without_budget_and_defaults_concurrency", () => {
    const parsed = CreateProjectInputSchema.parse({
      milestone: "m2",
      brief,
      mode: "replay",
      imageProvider: "none",
      rightsConfirmed: true,
    });

    expect(parsed.budgetUsd).toBeUndefined();
    expect(parsed.maxConcurrentExternalJobs).toBe(2);
  });

  it("requires_positive_budget_for_live_m2", () => {
    const input = {
      milestone: "m2" as const,
      brief,
      mode: "live" as const,
      imageProvider: "openai-subscription" as const,
      soundProvider: "none" as const,
      rightsConfirmed: true as const,
    };

    expect(CreateProjectInputSchema.safeParse(input).success).toBe(false);
    expect(
      CreateProjectInputSchema.safeParse({ ...input, budgetUsd: 1 }).success,
    ).toBe(true);
  });

  it("rejects_non_none_sound_provider_for_m2", () => {
    expect(
      CreateProjectInputSchema.safeParse({
        milestone: "m2",
        brief,
        mode: "replay",
        imageProvider: "none",
        soundProvider: "elevenlabs",
        rightsConfirmed: true,
      }).success,
    ).toBe(false);
  });

  it("rejects_m2_sound_stage_and_m1_asset_batch_stage", () => {
    expect(
      ProjectStateSchema.safeParse(persistedState("m2", "sound-generation"))
        .success,
    ).toBe(false);
    expect(
      ProjectStateSchema.safeParse(persistedState("m1", "asset-batch")).success,
    ).toBe(false);
  });

  it("parses_existing_schema_v1_m0_and_m1_rows_without_migration", () => {
    expect(
      ProjectStateSchema.parse(persistedState("m0", "asset-production"))
        .maxConcurrentExternalJobs,
    ).toBeUndefined();
    expect(
      ProjectStateSchema.parse(persistedState("m1", "interrogation"))
        .maxConcurrentExternalJobs,
    ).toBeUndefined();
  });

  it("uses_failure_kind_at_workflow_boundaries", () => {
    expect(FailureKindSchema.parse("user-action-required")).toBe(
      "user-action-required",
    );
    expect(
      WorkflowFailureSchema.parse({
        code: "planner-missing",
        message: "No planner is configured.",
        kind: "user-action-required",
      }),
    ).toMatchObject({ kind: "user-action-required", evidenceRevisionIds: [] });
    expect(
      MacroGraphSuspendSchema.parse({
        projectId: "project-1",
        nodeId: "m2.asset-plan-approval",
        reason: "approval-required",
      }).nodeId,
    ).toBe("m2.asset-plan-approval");
  });

  it("accepts_the_authoritative_asset_batch_entry_shape", () => {
    const current = ProjectStateSchema.parse(
      persistedState("m2", "asset-batch"),
    ).brief;
    const entry = AssetBatchEntrySchema.parse({
      assetId: "hero",
      classification: "hero",
      current,
      best: current,
      attemptCount: 1,
      validated: true,
      deterministicReport: current,
    });

    const state = ProjectStateSchema.parse({
      ...persistedState("m2", "asset-batch"),
      assetBatch: { hero: entry },
    });
    expect(state.assetBatch?.hero?.classification).toBe("hero");
  });
});

describe("metered project routing", () => {
  it("allows M1 subscription and replay projects to omit budgetUsd", () => {
    const subscription = CreateProjectInputSchema.parse({
      milestone: "m1",
      brief,
      mode: "live",
      orchestratorProvider: "openai",
      implementationProvider: "openai",
      imageProvider: "openai-subscription",
      soundProvider: "none",
      rightsConfirmed: true,
    });
    const replay = CreateProjectInputSchema.parse({
      milestone: "m1",
      brief,
      mode: "replay",
      imageProvider: "none",
      rightsConfirmed: true,
    });

    expect(subscription.budgetUsd).toBeUndefined();
    expect(replay.budgetUsd).toBeUndefined();
    expect(hasMeteredRoutes(subscription)).toBe(false);
    expect(hasMeteredRoutes(replay)).toBe(false);
  });

  it.each([
    { orchestratorProvider: "openai-api" as const },
    { implementationProvider: "openai-api" as const },
    { imageProvider: "openai-gpt-image-2" as const },
    { soundProvider: "elevenlabs" as const },
  ])("requires budgetUsd for live metered selection %#", (route) => {
    const input = {
      milestone: "m1" as const,
      brief,
      mode: "live" as const,
      orchestratorProvider: "openai" as const,
      implementationProvider: "openai" as const,
      imageProvider: "openai-subscription" as const,
      soundProvider: "none" as const,
      rightsConfirmed: true as const,
      ...route,
    };

    expect(CreateProjectInputSchema.safeParse(input).success).toBe(false);
    expect(
      CreateProjectInputSchema.safeParse({ ...input, budgetUsd: 1 }).success,
    ).toBe(true);
  });

  it("keeps an old snapshot containing budgetUsd readable", () => {
    const createdAt = new Date().toISOString();
    const artifact = {
      artifactId: "artifact-1",
      sha256: "a".repeat(64),
      mediaType: "application/json",
      byteLength: 1,
      uri: "/api/artifacts/artifact-1",
    };
    const parsed = ProjectStateSchema.parse({
      schemaVersion: 1,
      milestone: "m1",
      projectId: "old-subscription-project",
      name: "Old subscription project",
      mode: "live",
      assetProvider: "meshy",
      orchestratorProvider: "openai",
      implementationProvider: "openai",
      imageProvider: "openai-subscription",
      soundProvider: "none",
      status: "awaiting-input",
      stage: "interrogation",
      runId: "run-1",
      budgetUsd: 1,
      spentUsd: 0,
      conceptReplacementCount: 0,
      brief: {
        entityId: "brief-1",
        revisionId: "revision-1",
        kind: "game-brief",
        artifact,
        createdAt,
        createdByRunId: "run-1",
      },
      createdAt,
      updatedAt: createdAt,
    });

    expect(parsed.budgetUsd).toBe(1);
    expect(hasMeteredRoutes(parsed)).toBe(false);
  });

  it("normalizes a new no-metered state without budgetUsd to zero", () => {
    const createdAt = new Date().toISOString();
    const parsed = ProjectStateSchema.parse({
      schemaVersion: 1,
      milestone: "m1",
      projectId: "new-replay-project",
      name: "New replay project",
      mode: "replay",
      status: "awaiting-input",
      stage: "interrogation",
      runId: "run-1",
      spentUsd: 0,
      brief: {
        entityId: "brief-1",
        revisionId: "revision-1",
        kind: "game-brief",
        artifact: {
          artifactId: "artifact-1",
          sha256: "a".repeat(64),
          mediaType: "application/json",
          byteLength: 1,
          uri: "/api/artifacts/artifact-1",
        },
        createdAt,
        createdByRunId: "run-1",
      },
      createdAt,
      updatedAt: createdAt,
    });

    expect(parsed.budgetUsd).toBe(0);
  });
});
