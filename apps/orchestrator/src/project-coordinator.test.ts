import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  AssetPlanSchema,
  type ApprovalDecision,
  type ConceptSet,
  type GameDesignSpec,
  type M1ConceptDocument,
  type RevisionRef,
} from "@fulcrum/domain";
import { ProjectRepository } from "@fulcrum/project";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createM2MacroGraphSlots,
  unavailableM2MacroGraphSlots,
  type M2MacroGraphSlots,
} from "./macro-operations.js";
import { ProjectCoordinator } from "./project-coordinator.js";

const roots: string[] = [];
const timestamp = "2026-08-24T12:00:00.000Z";

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const temporaryRoot = () => {
  const root = mkdtempSync(path.join(tmpdir(), "fulcrum-project-coordinator-"));
  roots.push(root);
  return root;
};

const approved = (
  projectId: string,
  targetType: "game-design" | "concept-set",
  target: RevisionRef,
): ApprovalDecision & { decision: "approved" } => ({
  approvalId: `${target.revisionId}:approval`,
  projectId,
  targetType,
  targetRevisionId: target.revisionId,
  targetSha256: target.artifact.sha256,
  decision: "approved",
  decidedBy: "test",
  decidedAt: timestamp,
});

const m2PlanningFixture = () => {
  const repository = new ProjectRepository(temporaryRoot());
  const projectId = "m2-planner-project";
  const runId = "m2-planner-run";
  repository.reserveProject(projectId, timestamp);
  const brief = repository.writeRevision({
    projectId,
    entityId: `${projectId}:brief`,
    kind: "game-brief",
    value: { text: "A compact extraction arena centered on one reliquary." },
    runId,
  });
  const gameDesignDocument: GameDesignSpec = {
    title: "Reliquary Run",
    genre: "third-person extraction",
    camera: "third-person",
    coreFantasy: "Recover an ancient reliquary under pressure.",
    coreLoop: ["enter", "locate", "extract"],
    playerVerbs: ["move", "inspect", "extract"],
    objective: "Extract the reliquary.",
    sessionMinutes: 8,
    gameplayConstraints: ["Keep the objective visible across the arena."],
    facts: [],
    assumptions: [],
  };
  const gameDesignSpec = repository.writeRevision({
    projectId,
    entityId: `${projectId}:gds`,
    kind: "game-design-spec",
    value: gameDesignDocument,
    runId,
  });
  const conceptDocument: M1ConceptDocument = {
    conceptId: "concept-1",
    name: "Reliquary",
    prompt: "A squat ancient reliquary hero prop.",
    negativePrompt: "photoreal",
    image: {
      artifactId: "concept-image",
      sha256: "d".repeat(64),
      mediaType: "image/png",
      byteLength: 10,
      uri: "/api/artifacts/concept-image",
    },
    provider: "replay",
    model: "fixture",
    sourceRevisionIds: [gameDesignSpec.revisionId, "direction-1"],
    costUsd: 0,
    ancestors: [
      {
        revisionId: gameDesignSpec.revisionId,
        sha256: gameDesignSpec.artifact.sha256,
        kind: gameDesignSpec.kind,
      },
      {
        revisionId: "direction-1",
        sha256: "e".repeat(64),
        kind: "visual-direction",
      },
    ],
  };
  const concept = repository.writeRevision({
    projectId,
    entityId: `${projectId}:concept:gameplay-anchor`,
    kind: "m1-concept",
    value: conceptDocument,
    runId,
  });
  const conceptSetDocument: ConceptSet = {
    conceptSetId: `${projectId}:concept-set`,
    sourceDirectionRevisionId: "direction-1",
    slots: [
      {
        slotId: "gameplay-anchor",
        name: "Reliquary",
        purpose: "gameplay anchor hero prop",
        revisions: [
          {
            revision: concept,
            inheritedVisualTokens: [
              { tokenId: "shape-1", category: "shape", value: "squat" },
            ],
          },
        ],
        selectedRevisionId: concept.revisionId,
      },
    ],
  };
  const conceptSet = repository.writeRevision({
    projectId,
    entityId: `${projectId}:concept-set`,
    kind: "concept-set",
    value: conceptSetDocument,
    runId,
  });
  const gameDesignApproval = approved(projectId, "game-design", gameDesignSpec);
  const conceptSetApproval = approved(projectId, "concept-set", conceptSet);
  repository.createProject({
    schemaVersion: 1,
    milestone: "m2",
    projectId,
    name: "M2 planner fixture",
    mode: "replay",
    status: "active",
    stage: "asset-planning",
    runId,
    maxConcurrentExternalJobs: 2,
    spentUsd: 0,
    brief,
    gameDesignSpec,
    conceptSet,
    gameDesignApproval,
    conceptSetApproval,
    assetPlanReplanCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return {
    repository,
    projectId,
    runId,
    gameDesignSpec,
    conceptSet,
    gameDesignApproval,
    conceptSetApproval,
  };
};

const coordinatorFixture = () => {
  const fixture = m2PlanningFixture();
  const planning = createM2MacroGraphSlots(fixture.repository).assetPlanning;
  const revision = (entityId: string) =>
    fixture.repository.writeRevision({
      projectId: fixture.projectId,
      entityId,
      kind: "later-slice-fixture",
      value: { entityId },
      runId: fixture.runId,
    });
  const candidateAsset = revision("candidate-asset");
  const deterministicReport = revision("deterministic-report");
  const semanticReport = revision("semantic-report");
  const generation = vi.fn(async (input) => {
    const plan = AssetPlanSchema.parse(
      fixture.repository.resolveRevision(input.assetPlan),
    );
    return {
      status: "ready" as const,
      value: {
        ...input,
        classification: plan.assets.find(
          (asset) => asset.assetId === input.assetId,
        )!.classification,
        multiviewDecision: "not-required" as const,
      },
    };
  });
  const slots: M2MacroGraphSlots = {
    ...unavailableM2MacroGraphSlots(),
    assetPlanning: planning,
    multiviewConcepts: { ensure: generation },
    assetProduction: {
      ensure: async (input) => ({
        status: "ready",
        value: { ...input, candidateAsset },
      }),
    },
    deterministicQa: {
      ensure: async (input) => ({
        status: "ready",
        value: { ...input, deterministicReport },
      }),
    },
    turntableEvaluation: {
      ensure: async (input) => ({
        status: "ready",
        value: {
          ...input,
          semanticReport,
          disposition: "accept",
        },
      }),
    },
    regeneration: {
      ensure: async () => ({
        status: "pending",
        requestId: "later-slice-generation",
        resumeAfter: "2026-08-24T12:00:05.000Z",
      }),
    },
  };
  const coordinator = new ProjectCoordinator(fixture.repository, {
    m2Slots: slots,
  });
  return { ...fixture, coordinator, slots, generation };
};

const decisionInput = (
  plan: RevisionRef,
  decision: "approved" | "rejected" | "changes-requested",
  notes?: string,
) => ({
  targetType: "asset-plan" as const,
  targetRevisionId: plan.revisionId,
  targetSha256: plan.artifact.sha256,
  decision,
  ...(notes ? { notes } : {}),
});

describe("M2 asset-plan coordinator gate", () => {
  it("asset_planning_requires_exact_approved_gds_and_concept_set", async () => {
    const fixture = m2PlanningFixture();
    const state = fixture.repository.getProject(fixture.projectId);
    fixture.repository.saveProject({
      ...state,
      gameDesignApproval: {
        ...fixture.gameDesignApproval,
        targetSha256: "f".repeat(64),
      },
    });

    const outcome = await createM2MacroGraphSlots(
      fixture.repository,
    ).assetPlanning.ensure({ projectId: fixture.projectId });

    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "asset-plan-invalid-input" },
    });
    fixture.repository.close();
  });

  it("completed_plan_suspends_at_asset_plan_approval", async () => {
    const fixture = coordinatorFixture();

    const snapshot = await fixture.coordinator.advance(fixture.projectId);

    expect(snapshot.state).toMatchObject({
      stage: "asset-plan-approval",
      status: "awaiting-approval",
      assetPlanReplanCount: 0,
    });
    expect(
      snapshot.assetPlan?.assets.map((asset) => asset.classification),
    ).toEqual(
      expect.arrayContaining(["hero", "kit", "procedural", "functional"]),
    );
    fixture.repository.close();
  });

  it("generation_cannot_start_without_an_exact_asset_plan_approval", async () => {
    const fixture = coordinatorFixture();

    await fixture.coordinator.advance(fixture.projectId);

    expect(fixture.generation).not.toHaveBeenCalled();
    expect(fixture.repository.getProject(fixture.projectId).stage).toBe(
      "asset-plan-approval",
    );
    fixture.repository.close();
  });

  it("approved_plan_resumes_the_d1_downstream_slot", async () => {
    const fixture = coordinatorFixture();
    const planned = await fixture.coordinator.advance(fixture.projectId);

    const resumed = await fixture.coordinator.decideAssetPlan(
      fixture.projectId,
      decisionInput(planned.state.assetPlan!, "approved"),
    );

    expect(resumed.state.stage).toBe("asset-batch");
    expect(fixture.generation).toHaveBeenCalled();
    fixture.repository.close();
  });

  it("changes_requested_records_the_old_hash_and_creates_one_descendant", async () => {
    const fixture = coordinatorFixture();
    const planned = await fixture.coordinator.advance(fixture.projectId);
    const oldPlan = planned.state.assetPlan!;

    const replanned = await fixture.coordinator.decideAssetPlan(
      fixture.projectId,
      decisionInput(
        oldPlan,
        "changes-requested",
        "Give the kit a stronger material tie to the hero.",
      ),
    );
    const document = AssetPlanSchema.parse(
      fixture.repository.resolveRevision(replanned.state.assetPlan!),
    );

    expect(replanned.state).toMatchObject({
      stage: "asset-plan-approval",
      assetPlanReplanCount: 1,
    });
    expect(replanned.state.assetPlan?.revisionId).not.toBe(oldPlan.revisionId);
    expect(document).toMatchObject({
      changeRequest: {
        previousPlanRevisionId: oldPlan.revisionId,
        notes: "Give the kit a stronger material tie to the hero.",
      },
      provenance: { operation: "asset-plan.replan" },
    });
    expect(document.provenance.parentRevisionIds).toContain(oldPlan.revisionId);
    fixture.repository.close();
  });

  it("old_plan_cannot_be_approved_after_replanning", async () => {
    const fixture = coordinatorFixture();
    const planned = await fixture.coordinator.advance(fixture.projectId);
    const oldPlan = planned.state.assetPlan!;
    await fixture.coordinator.decideAssetPlan(
      fixture.projectId,
      decisionInput(
        oldPlan,
        "changes-requested",
        "Strengthen the hero silhouette.",
      ),
    );

    await expect(
      fixture.coordinator.decideAssetPlan(
        fixture.projectId,
        decisionInput(oldPlan, "approved"),
      ),
    ).rejects.toThrow("current immutable revision");
    fixture.repository.close();
  });

  it("second_changes_request_is_policy_blocked_before_model_execution", async () => {
    const fixture = coordinatorFixture();
    const planned = await fixture.coordinator.advance(fixture.projectId);
    const replanned = await fixture.coordinator.decideAssetPlan(
      fixture.projectId,
      decisionInput(
        planned.state.assetPlan!,
        "changes-requested",
        "Strengthen the hero silhouette.",
      ),
    );
    const replanEventsBefore = fixture.repository
      .listEvents(fixture.projectId)
      .filter((event) => event.type === "asset-plan.replanned").length;

    const blocked = await fixture.coordinator.decideAssetPlan(
      fixture.projectId,
      decisionInput(
        replanned.state.assetPlan!,
        "changes-requested",
        "Change it again.",
      ),
    );

    expect(blocked.state).toMatchObject({
      stage: "blocked",
      blockedReason: {
        code: "asset-plan-replan-limit",
        failureKind: "policy-blocked",
      },
    });
    expect(
      fixture.repository
        .listEvents(fixture.projectId)
        .filter((event) => event.type === "asset-plan.replanned"),
    ).toHaveLength(replanEventsBefore);
    fixture.repository.close();
  });

  it("rejected_asset_plan_blocks_without_generation", async () => {
    const fixture = coordinatorFixture();
    const planned = await fixture.coordinator.advance(fixture.projectId);

    const blocked = await fixture.coordinator.decideAssetPlan(
      fixture.projectId,
      decisionInput(planned.state.assetPlan!, "rejected"),
    );

    expect(blocked.state).toMatchObject({
      stage: "blocked",
      blockedReason: { code: "asset-plan-not-approved" },
    });
    expect(fixture.generation).not.toHaveBeenCalled();
    fixture.repository.close();
  });

  it("restart_during_replan_reuses_the_submission_and_finishes_the_pointer", async () => {
    const fixture = m2PlanningFixture();
    const initialSlots = createM2MacroGraphSlots(fixture.repository);
    const firstDriver = new ProjectCoordinator(fixture.repository, {
      m2Slots: initialSlots,
    });
    const planned = await firstDriver.advance(fixture.projectId);
    const oldPlan = planned.state.assetPlan!;
    const decision: ApprovalDecision = {
      approvalId: "manual-replan-decision",
      projectId: fixture.projectId,
      targetType: "asset-plan",
      targetRevisionId: oldPlan.revisionId,
      targetSha256: oldPlan.artifact.sha256,
      decision: "changes-requested",
      notes: "Strengthen the hero silhouette.",
      decidedBy: "test",
      decidedAt: timestamp,
    };
    const state = fixture.repository.getProject(fixture.projectId);
    fixture.repository.commitApproval({
      decision,
      nextState: {
        ...state,
        status: "active",
        stage: "asset-planning",
        assetPlanApproval: decision,
      },
      event: {
        runId: fixture.runId,
        type: "approval.asset-plan-decided",
        payload: {
          approvalId: decision.approvalId,
          decision: decision.decision,
        },
      },
    });
    const readyBeforeRestart = await initialSlots.assetPlanning.ensure({
      projectId: fixture.projectId,
    });
    expect(readyBeforeRestart.status).toBe("ready");

    const restartedSlots = createM2MacroGraphSlots(fixture.repository);
    const restarted = new ProjectCoordinator(fixture.repository, {
      m2Slots: restartedSlots,
    });
    const snapshot = await restarted.advance(fixture.projectId);

    expect(snapshot.state).toMatchObject({
      stage: "asset-plan-approval",
      assetPlanReplanCount: 1,
    });
    expect(snapshot.state.assetPlan?.revisionId).toBe(
      readyBeforeRestart.status === "ready"
        ? readyBeforeRestart.value.assetPlan.revisionId
        : "unreachable",
    );
    expect(
      fixture.repository
        .listEvents(fixture.projectId)
        .filter((event) => event.type === "asset-plan.replanned"),
    ).toHaveLength(1);
    fixture.repository.close();
  });
});
