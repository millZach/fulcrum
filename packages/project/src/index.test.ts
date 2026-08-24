import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectRepository } from "./index.js";

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
