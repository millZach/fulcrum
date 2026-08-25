import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectRepository } from "./index.js";
import type { ApprovalDecision, ProjectState } from "@fulcrum/domain";

const roots: string[] = [];

const temporaryRoot = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), "fulcrum-project-"));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const reserve = (repository: ProjectRepository, projectId = "project-1") => {
  repository.reserveProject(projectId, "2026-01-01T00:00:00.000Z");
  return { projectId, runId: "run-1" };
};

const openProject = (
  repository: ProjectRepository,
  projectId = "project-1",
) => {
  const { runId } = reserve(repository, projectId);
  const createdAt = "2026-01-01T00:00:00.000Z";
  const brief = repository.writeRevision({
    projectId,
    entityId: `${projectId}:brief`,
    kind: "game-brief",
    value: { text: "A project repository checkpoint fixture." },
    runId,
  });
  const state = repository.createProject({
    schemaVersion: 1,
    milestone: "m0",
    projectId,
    name: "Checkpoint fixture",
    mode: "replay",
    status: "active",
    stage: "asset-production",
    runId,
    budgetUsd: 1,
    spentUsd: 0,
    brief,
    createdAt,
    updatedAt: createdAt,
  });
  return { state, runId };
};

const openAssetPlanApprovalProject = (repository: ProjectRepository) => {
  const projectId = "asset-plan-project";
  const runId = "asset-plan-run";
  const createdAt = "2026-01-01T00:00:00.000Z";
  repository.reserveProject(projectId, createdAt);
  const brief = repository.writeRevision({
    projectId,
    entityId: `${projectId}:brief`,
    kind: "game-brief",
    value: { text: "Atomic asset-plan approval fixture." },
    runId,
  });
  const assetPlan = repository.writeRevision({
    projectId,
    entityId: `${projectId}:asset-plan`,
    kind: "asset-plan",
    value: { planId: `${projectId}:asset-plan` },
    runId,
  });
  const state = repository.createProject({
    schemaVersion: 1,
    milestone: "m2",
    projectId,
    name: "Asset-plan approval fixture",
    mode: "replay",
    status: "awaiting-approval",
    stage: "asset-plan-approval",
    runId,
    spentUsd: 0,
    brief,
    assetPlan,
    assetPlanReplanCount: 0,
    createdAt,
    updatedAt: createdAt,
  });
  const decision: ApprovalDecision = {
    approvalId: "asset-plan-approval-1",
    projectId,
    targetType: "asset-plan",
    targetRevisionId: assetPlan.revisionId,
    targetSha256: assetPlan.artifact.sha256,
    decision: "approved",
    decidedBy: "zach",
    decidedAt: createdAt,
  };
  const nextState: ProjectState = {
    ...state,
    status: "active",
    stage: "asset-batch",
    assetPlanApproval: decision,
  };
  return { projectId, runId, state, assetPlan, decision, nextState };
};

describe("ProjectRepository asset-plan revisions and approvals", () => {
  it("preallocated_revision_id_matches_the_provenance_manifest", () => {
    const repository = new ProjectRepository(temporaryRoot());
    const { projectId, runId } = reserve(repository);
    const revisionId = "asset-plan-revision-1";
    const createdAt = "2026-01-01T01:00:00.000Z";
    const value = {
      provenance: {
        revisionId,
        parentRevisionIds: ["gds-1"],
        sourceArtifactHashes: ["a".repeat(64)],
        runId,
        operation: "asset-plan.initial",
        createdAt,
      },
    };

    const written = repository.writeRevision({
      projectId,
      entityId: `${projectId}:asset-plan`,
      kind: "asset-plan",
      value,
      runId,
      revisionId,
      createdAt,
    });

    expect(written).toMatchObject({ revisionId, createdAt });
    expect(
      repository.resolveRevision<typeof value>(written).provenance.revisionId,
    ).toBe(written.revisionId);
    repository.close();
  });

  it("write_revision_without_preallocation_preserves_existing_behavior", () => {
    const repository = new ProjectRepository(temporaryRoot());
    const { projectId, runId } = reserve(repository);
    const write = () =>
      repository.writeRevision({
        projectId,
        entityId: `${projectId}:fixture`,
        kind: "fixture",
        value: { stable: true },
        runId,
      });

    const first = write();
    const second = write();

    expect(first.revisionId).not.toBe(second.revisionId);
    expect(Date.parse(first.createdAt)).not.toBeNaN();
    expect(first.artifact.sha256).toBe(second.artifact.sha256);
    repository.close();
  });

  it("commit_approval_rejects_a_wrong_hash_without_state_or_event_changes", () => {
    const repository = new ProjectRepository(temporaryRoot());
    const fixture = openAssetPlanApprovalProject(repository);

    expect(() =>
      repository.commitApproval({
        decision: { ...fixture.decision, targetSha256: "f".repeat(64) },
        nextState: fixture.nextState,
        event: {
          runId: fixture.runId,
          type: "approval.asset-plan-decided",
          payload: { decision: "approved" },
        },
      }),
    ).toThrow("hash");
    expect(repository.getProject(fixture.projectId)).toEqual(fixture.state);
    expect(repository.listEvents(fixture.projectId)).toEqual([]);
    repository.close();
  });

  it("commit_approval_rolls_back_all_three_writes_on_failure", () => {
    const repository = new ProjectRepository(temporaryRoot());
    const fixture = openAssetPlanApprovalProject(repository);

    expect(() =>
      repository.commitApproval({
        decision: fixture.decision,
        nextState: fixture.nextState,
        event: {
          runId: fixture.runId,
          type: "approval.asset-plan-decided",
          payload: { cannotSerialize: 1n },
        },
      }),
    ).toThrow();
    expect(repository.getProject(fixture.projectId)).toEqual(fixture.state);
    expect(repository.listEvents(fixture.projectId)).toEqual([]);

    expect(() =>
      repository.commitApproval({
        decision: fixture.decision,
        nextState: fixture.nextState,
        event: {
          runId: fixture.runId,
          type: "approval.asset-plan-decided",
          payload: { decision: "approved" },
        },
      }),
    ).not.toThrow();
    repository.close();
  });

  it("commit_approval_persists_decision_state_and_event_atomically", () => {
    const repository = new ProjectRepository(temporaryRoot());
    const fixture = openAssetPlanApprovalProject(repository);

    const committed = repository.commitApproval({
      decision: fixture.decision,
      nextState: fixture.nextState,
      event: {
        runId: fixture.runId,
        type: "approval.asset-plan-decided",
        payload: {
          approvalId: fixture.decision.approvalId,
          decision: fixture.decision.decision,
        },
      },
    });

    expect(committed.decision).toEqual(fixture.decision);
    expect(committed.state.assetPlanApproval).toEqual(fixture.decision);
    expect(repository.getProject(fixture.projectId)).toEqual(committed.state);
    expect(repository.listEvents(fixture.projectId)).toEqual([
      expect.objectContaining({
        type: "approval.asset-plan-decided",
        payload: {
          approvalId: fixture.decision.approvalId,
          decision: "approved",
        },
      }),
    ]);
    repository.close();
  });
});

describe("ProjectRepository.ensureRevision", () => {
  it("returns_the_same_revision_for_the_same_operation_key", () => {
    const repository = new ProjectRepository(temporaryRoot());
    const { projectId, runId } = reserve(repository);

    const first = repository.ensureRevision({
      projectId,
      operationKey: "quality:asset-1",
      entityId: "asset-1:quality",
      kind: "asset-evaluation",
      runId,
      createValue: () => ({ passed: true }),
    });
    const second = repository.ensureRevision({
      projectId,
      operationKey: "quality:asset-1",
      entityId: "asset-1:quality",
      kind: "asset-evaluation",
      runId: "run-2",
      createValue: () => ({ passed: false }),
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.revision).toEqual(first.revision);
    expect(second.value).toEqual({ passed: true });
    repository.close();
  });

  it("calls_create_value_once_after_a_reconstruction", () => {
    const root = temporaryRoot();
    const first = new ProjectRepository(root);
    const { projectId, runId } = reserve(first);
    const createValue = vi.fn(() => ({ value: 1 }));
    first.ensureRevision({
      projectId,
      operationKey: "scene:asset-1:bible-1",
      entityId: "scene-1",
      kind: "scene",
      runId,
      createValue,
    });
    first.close();

    const reconstructed = new ProjectRepository(root);
    reconstructed.ensureRevision({
      projectId,
      operationKey: "scene:asset-1:bible-1",
      entityId: "scene-1",
      kind: "scene",
      runId: "run-2",
      createValue,
    });

    expect(createValue).toHaveBeenCalledTimes(1);
    reconstructed.close();
  });

  it("does_not_alias_different_operation_keys_with_equal_bytes", () => {
    const repository = new ProjectRepository(temporaryRoot());
    const { projectId, runId } = reserve(repository);
    const ensure = (operationKey: string) =>
      repository.ensureRevision({
        projectId,
        operationKey,
        entityId: "shared-entity",
        kind: "fixture",
        runId,
        createValue: () => ({ equal: true }),
      });

    const first = ensure("operation-a");
    const second = ensure("operation-b");

    expect(second.revision.revisionId).not.toBe(first.revision.revisionId);
    expect(second.revision.artifact.sha256).toBe(
      first.revision.artifact.sha256,
    );
    repository.close();
  });
});

describe("ProjectRepository workflow checkpoints", () => {
  it("atomically_updates_project_and_appends_completed_checkpoint", () => {
    const repository = new ProjectRepository(temporaryRoot());
    const { state, runId } = openProject(repository);

    const result = repository.commitWorkflowCheckpoint({
      projectId: state.projectId,
      runId,
      checkpointKey: "m0.asset-production:asset-1",
      expectedStage: "asset-production",
      nextState: { ...state, stage: "asset-quality" },
      event: {
        type: "workflow.node.completed",
        payload: {
          nodeId: "m0.asset-production",
          stage: "asset-quality",
          outputRevisionIds: ["asset-1"],
        },
      },
    });

    expect(result.status).toBe("committed");
    expect(repository.getProject(state.projectId).stage).toBe("asset-quality");
    expect(repository.listEvents(state.projectId)).toEqual([
      expect.objectContaining({
        type: "workflow.node.completed",
        payload: expect.objectContaining({
          checkpointKey: "m0.asset-production:asset-1",
          nodeId: "m0.asset-production",
        }),
      }),
    ]);
    repository.close();
  });

  it("repeating_checkpoint_returns_already_committed_without_an_event", () => {
    const repository = new ProjectRepository(temporaryRoot());
    const { state, runId } = openProject(repository);
    const input = {
      projectId: state.projectId,
      runId,
      checkpointKey: "m0.asset-production:asset-1",
      expectedStage: "asset-production" as const,
      nextState: { ...state, stage: "asset-quality" as const },
      event: {
        type: "workflow.node.completed" as const,
        payload: { nodeId: "m0.asset-production", stage: "asset-quality" },
      },
    };

    expect(repository.commitWorkflowCheckpoint(input).status).toBe("committed");
    expect(repository.commitWorkflowCheckpoint(input).status).toBe(
      "already-committed",
    );
    expect(repository.listEvents(state.projectId)).toHaveLength(1);
    repository.close();
  });

  it("stale_expected_stage_does_not_modify_project_or_event_log", () => {
    const repository = new ProjectRepository(temporaryRoot());
    const { state, runId } = openProject(repository);

    const result = repository.commitWorkflowCheckpoint({
      projectId: state.projectId,
      runId,
      checkpointKey: "m0.asset-quality:evaluation-1",
      expectedStage: "asset-quality",
      nextState: { ...state, stage: "scene-composition" },
      event: {
        type: "workflow.node.completed",
        payload: { nodeId: "m0.asset-quality", stage: "scene-composition" },
      },
    });

    expect(result.status).toBe("stale");
    expect(repository.getProject(state.projectId).stage).toBe(
      "asset-production",
    );
    expect(repository.listEvents(state.projectId)).toEqual([]);
    repository.close();
  });

  it("list_events_breaks_equal_timestamp_ties_by_sqlite_rowid", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const repository = new ProjectRepository(temporaryRoot());
    const { state, runId } = openProject(repository);
    for (const sequence of [1, 2, 3])
      repository.appendEvent({
        projectId: state.projectId,
        runId,
        type: "fixture",
        payload: { sequence },
      });

    expect(
      repository
        .listEvents(state.projectId)
        .map(({ payload }) => payload.sequence),
    ).toEqual([1, 2, 3]);
    repository.close();
    vi.useRealTimers();
  });
});
