import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  AssetEvaluation,
  ProjectState,
  RevisionRef,
} from "@fulcrum/domain";
import { ProjectRepository } from "@fulcrum/project";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PostConceptOperations } from "./macro-operations.js";

const roots: string[] = [];

const temporaryRoot = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), "fulcrum-macro-operations-"));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const evaluation = (
  passed: boolean,
  assetRevisionId: string,
): AssetEvaluation => ({
  evaluationId: "evaluation-1",
  assetRevisionId,
  passed,
  measurements: {
    meshCount: 1,
    primitiveCount: 1,
    vertexCount: 3,
    triangleCount: 1,
    materialCount: 1,
    textureCount: 0,
    animationCount: 0,
    boundsMeters: { x: 1, y: 1, z: 1 },
  },
  gates: [
    { id: "mesh", label: "Mesh", passed, detail: passed ? "pass" : "fail" },
  ],
  evaluatedAt: "2026-01-01T00:00:00.000Z",
});

const fixture = (stage: ProjectState["stage"] = "asset-production") => {
  const repository = new ProjectRepository(temporaryRoot());
  const projectId = "project-1";
  const runId = "run-1";
  const createdAt = "2026-01-01T00:00:00.000Z";
  repository.reserveProject(projectId, createdAt);
  const revision = (entityId: string, kind = "fixture"): RevisionRef =>
    repository.writeRevision({
      projectId,
      entityId,
      kind,
      value: { entityId },
      runId,
    });
  const brief = revision("brief", "game-brief");
  const concept = revision("concept", "concept-document");
  const visualBible = revision("visual-bible", "visual-bible");
  const asset = revision("asset", "asset-document");
  repository.createProject({
    schemaVersion: 1,
    milestone: "m0",
    projectId,
    name: "Macro operations fixture",
    mode: "replay",
    status: "active",
    stage,
    runId,
    budgetUsd: 1,
    spentUsd: 0,
    brief,
    concept,
    visualBible,
    ...(stage === "asset-production" ? {} : { asset }),
    createdAt,
    updatedAt: createdAt,
  });
  return { repository, projectId, runId, asset, revision };
};

describe("PostConceptOperations", () => {
  it("asset_production_pending_returns_suspend_without_advancing_stage", async () => {
    const { repository, projectId } = fixture();
    const operations = new PostConceptOperations(repository, {
      assetProduction: {
        ensure: vi.fn(async () => ({
          status: "pending" as const,
          requestId: "request-1",
          resumeAfter: "2026-01-01T00:00:05.000Z",
        })),
      },
    });

    const outcome = await operations.assetProduction(projectId);

    expect(outcome).toMatchObject({
      status: "suspended",
      suspend: {
        nodeId: "m0.asset-production",
        reason: "provider-pending",
        requestId: "request-1",
      },
    });
    expect(repository.getProject(projectId).stage).toBe("asset-production");
    repository.close();
  });

  it("asset_production_ready_persists_asset_and_advances_to_quality", async () => {
    const { repository, projectId, asset } = fixture();
    const operations = new PostConceptOperations(repository, {
      assetProduction: {
        ensure: vi.fn(async () => ({
          status: "ready" as const,
          requestId: "request-1",
          value: asset,
        })),
      },
    });

    const outcome = await operations.assetProduction(projectId);

    expect(outcome.status).toBe("ready");
    expect(repository.getProject(projectId)).toMatchObject({
      stage: "asset-quality",
      asset: { revisionId: asset.revisionId },
    });
    repository.close();
  });

  it("quality_failure_preserves_existing_m0_blocked_behavior", async () => {
    const { repository, projectId, asset, revision } = fixture("asset-quality");
    const report = revision("evaluation", "asset-evaluation");
    const operations = new PostConceptOperations(repository, {
      assetQuality: {
        evaluate: vi.fn(async () => ({
          revision: report,
          evaluation: evaluation(false, asset.revisionId),
        })),
      },
    });

    await operations.assetQuality(projectId);

    expect(repository.getProject(projectId)).toMatchObject({
      stage: "blocked",
      status: "blocked",
      assetEvaluation: { revisionId: report.revisionId },
      blockedReason: { code: "asset-quality-failed", recoverable: true },
    });
    repository.close();
  });

  it("quality_success_advances_to_scene_once", async () => {
    const { repository, projectId, asset, revision } = fixture("asset-quality");
    const report = revision("evaluation", "asset-evaluation");
    const evaluate = vi.fn(async () => ({
      revision: report,
      evaluation: evaluation(true, asset.revisionId),
    }));
    const operations = new PostConceptOperations(repository, {
      assetQuality: { evaluate },
    });

    await operations.assetQuality(projectId);
    await operations.assetQuality(projectId);

    expect(repository.getProject(projectId).stage).toBe("scene-composition");
    expect(evaluate).toHaveBeenCalledTimes(1);
    repository.close();
  });

  it("scene_composition_sets_visual_slice_approval_once", async () => {
    const { repository, projectId, revision } = fixture("scene-composition");
    const scene = revision("scene", "fulcrum-scene-v0");
    const compose = vi.fn(() => ({ revision: scene, scene: {} as never }));
    const operations = new PostConceptOperations(repository, {
      sceneAuthoring: { compose },
    });

    await operations.sceneComposition(projectId);
    await operations.sceneComposition(projectId);

    expect(repository.getProject(projectId)).toMatchObject({
      stage: "visual-slice-approval",
      status: "awaiting-approval",
      scene: { revisionId: scene.revisionId },
    });
    expect(compose).toHaveBeenCalledTimes(1);
    repository.close();
  });

  it("completed_phase_is_a_noop_when_replayed_from_later_state", async () => {
    const { repository, projectId } = fixture("scene-composition");
    const production = vi.fn();
    const quality = vi.fn();
    const operations = new PostConceptOperations(repository, {
      assetProduction: { ensure: production },
      assetQuality: { evaluate: quality },
    });

    expect((await operations.assetProduction(projectId)).status).toBe("ready");
    expect((await operations.assetQuality(projectId)).status).toBe("ready");
    expect(production).not.toHaveBeenCalled();
    expect(quality).not.toHaveBeenCalled();
    repository.close();
  });
});
