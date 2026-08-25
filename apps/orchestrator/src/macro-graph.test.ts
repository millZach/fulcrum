import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ASSET_CLASS_HANDLING_POLICIES_V1,
  MacroGraphInputSchema,
  M0_FIXTURE_BRIEF,
  type ApprovalDecision,
  type RevisionRef,
} from "@fulcrum/domain";
import { ProjectRepository } from "@fulcrum/project";
import {
  AssetProduction,
  AssetQuality,
  createReplayReliquary,
} from "@fulcrum/production";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  M2_GRAPH_SLOTS,
  PostConceptGraphDriver,
  createPostConceptWorkflow,
} from "./macro-graph.js";
import {
  PostConceptOperations,
  type M2MacroGraphSlots,
} from "./macro-operations.js";
import { M0Coordinator } from "./coordinator.js";

const roots: string[] = [];

const temporaryRoot = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), "fulcrum-macro-graph-"));
  roots.push(root);
  return root;
};

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MESHY_API_KEY;
  delete process.env.FULCRUM_MESHY_MODEL;
  delete process.env.FULCRUM_MESHY_RESERVE_USD;
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const flatten = (entries: unknown[]): unknown[] =>
  entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [entry];
    const item = entry as Record<string, unknown>;
    const children = [
      ...(Array.isArray(item.serializedStepFlow)
        ? item.serializedStepFlow
        : []),
      ...(Array.isArray(item.steps) ? item.steps : []),
      ...(item.step ? [item.step] : []),
    ];
    const nestedStep =
      item.step && typeof item.step === "object"
        ? (item.step as Record<string, unknown>).serializedStepFlow
        : undefined;
    if (Array.isArray(nestedStep)) children.push(...nestedStep);
    return [item, ...flatten(children)];
  });

const nodeIds = (workflow: ReturnType<typeof createPostConceptWorkflow>) =>
  flatten(workflow.serializedStepGraph).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    const step = item.step as Record<string, unknown> | undefined;
    return [item.id, item.workflowId, step?.id].filter(
      (value): value is string => typeof value === "string",
    );
  });

describe("createPostConceptWorkflow graph shape", () => {
  it("contains_one_named_node_per_m0_tail_phase", () => {
    const repository = new ProjectRepository(temporaryRoot());
    const ids = nodeIds(createPostConceptWorkflow(repository));

    expect(ids).toEqual(
      expect.arrayContaining([
        "post-concept.route",
        "m0.asset-production",
        "m0.asset-quality",
        "m0.scene-composition",
      ]),
    );
    expect(new Set(ids.filter((id) => id === "m0.asset-production")).size).toBe(
      1,
    );
    repository.close();
  });

  it("contains_the_named_m2_planning_and_per_asset_slots", () => {
    const repository = new ProjectRepository(temporaryRoot());
    const ids = nodeIds(createPostConceptWorkflow(repository));

    expect(ids).toEqual(expect.arrayContaining(Object.values(M2_GRAPH_SLOTS)));
    repository.close();
  });

  it("uses_foreach_with_project_bounded_concurrency", () => {
    const repository = new ProjectRepository(temporaryRoot());
    const workflow = createPostConceptWorkflow(repository);
    const foreach = flatten(workflow.serializedStepGraph).find(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        (entry as { type?: string }).type === "foreach",
    ) as { opts?: { fn?: string; concurrency?: number } } | undefined;

    expect(foreach?.opts?.fn).toContain("maxConcurrency");
    expect(foreach?.opts?.concurrency).toBeUndefined();
    repository.close();
  });

  it("does_not_contain_coordinate_m0_phase_or_advanceOne", () => {
    const repository = new ProjectRepository(temporaryRoot());
    const graph = JSON.stringify(
      createPostConceptWorkflow(repository).serializedStepGraph,
    );

    expect(graph).not.toContain("coordinate-m0-phase");
    expect(graph).not.toContain("advanceOne");
    repository.close();
  });

  it("workflow_snapshots_contain_refs_and_ids_but_no_artifact_bytes", () => {
    const parsed = MacroGraphInputSchema.parse({
      projectId: "project-1",
      maxConcurrency: 2,
      artifactBytes: [1, 2, 3],
      brief: "large project history",
    });

    expect(parsed).toEqual({ projectId: "project-1", maxConcurrency: 2 });
  });
});

const m0TailFixture = async (repository: ProjectRepository) => {
  const coordinator = new M0Coordinator(repository);
  const direction = await coordinator.create({
    brief: M0_FIXTURE_BRIEF,
    mode: "replay",
    imageProvider: "none",
    budgetUsd: 1,
    rightsConfirmed: true,
  });
  repository.saveProject({
    ...direction.state,
    status: "active",
    stage: "asset-production",
  });
  return direction.state.projectId;
};

const m2Fixture = (repository: ProjectRepository) => {
  const projectId = "m2-project";
  const runId = "m2-run";
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
  const conceptSet = revision("concept-set", "concept-set");
  const gameDesignSpec = revision("game-design", "game-design-spec");
  const visualDirectionSet = revision("directions", "visual-direction-set");
  const assetPlanRevisionId = "m2-fixture-asset-plan-revision";
  const assetPlan = repository.writeRevision({
    projectId,
    entityId: `${projectId}:asset-plan`,
    kind: "asset-plan",
    revisionId: assetPlanRevisionId,
    createdAt,
    value: {
      planId: `${projectId}:asset-plan`,
      assets: [
        {
          assetId: "hero",
          name: "Fixture hero",
          classification: "hero",
          rationale: "Exercises the S1 M2 graph contract.",
          sourceRefs: {
            gameDesignSpec: {
              revisionId: gameDesignSpec.revisionId,
              sha256: gameDesignSpec.artifact.sha256,
              kind: gameDesignSpec.kind,
            },
            conceptSet: {
              revisionId: conceptSet.revisionId,
              sha256: conceptSet.artifact.sha256,
              kind: conceptSet.kind,
            },
            conceptSlots: [],
          },
          dependsOnAssetIds: [],
          acceptanceCriteria: ["The fixture remains readable."],
        },
      ],
      handling: ASSET_CLASS_HANDLING_POLICIES_V1,
      provenance: {
        revisionId: assetPlanRevisionId,
        parentRevisionIds: [gameDesignSpec.revisionId, conceptSet.revisionId],
        sourceArtifactHashes: [
          gameDesignSpec.artifact.sha256,
          conceptSet.artifact.sha256,
        ],
        runId,
        operation: "asset-plan.initial",
        createdAt,
      },
    },
    runId,
  });
  repository.createProject({
    schemaVersion: 1,
    milestone: "m2",
    projectId,
    name: "M2 fixture",
    mode: "replay",
    status: "active",
    stage: "asset-planning",
    runId,
    maxConcurrentExternalJobs: 2,
    spentUsd: 0,
    brief,
    conceptSet,
    gameDesignSpec,
    visualDirectionSet,
    selectedVisualDirectionRevisionId: "direction-1",
    createdAt,
    updatedAt: createdAt,
  });
  return { projectId, runId, assetPlan, revision };
};

const readyM2Slots = (
  projectId: string,
  assetPlan: RevisionRef,
  revision: (entityId: string, kind?: string) => RevisionRef,
): M2MacroGraphSlots => {
  const multiview = revision("hero-multiview");
  const asset = revision("hero-asset");
  const deterministic = revision("hero-deterministic");
  const semantic = revision("hero-semantic");
  return {
    assetPlanning: {
      ensure: async () => ({
        status: "ready",
        value: { projectId, assetPlan, orderedAssetIds: ["hero"] },
      }),
    },
    multiviewConcepts: {
      ensure: async (input) => ({
        status: "ready",
        value: {
          ...input,
          classification: "hero",
          multiviewConceptSet: multiview,
          multiviewDecision: "ready",
        },
      }),
    },
    assetProduction: {
      ensure: async (input) => ({
        status: "ready",
        value: { ...input, candidateAsset: asset },
      }),
    },
    deterministicQa: {
      ensure: async (input) => ({
        status: "ready",
        value: { ...input, deterministicReport: deterministic },
      }),
    },
    turntableEvaluation: {
      ensure: async (input) => ({
        status: "ready",
        value: {
          ...input,
          semanticReport: semantic,
          disposition: "accept",
        },
      }),
    },
    regeneration: {
      ensure: async (input) => ({
        status: "ready",
        value: {
          ...input,
          bestAsset: asset,
          finalDeterministicReport: deterministic,
          finalSemanticReport: semantic,
          attemptCount: 1,
          validated: true,
        },
      }),
    },
  };
};

describe("PostConceptGraphDriver", () => {
  it("fresh_m0_approval_runs_all_ready_tail_nodes_to_visual_review", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const projectId = await m0TailFixture(repository);

    const snapshot = await new PostConceptGraphDriver(repository).advance(
      projectId,
    );

    expect(snapshot.state.stage).toBe("visual-slice-approval");
    expect(snapshot.state.asset).toBeDefined();
    expect(snapshot.state.assetEvaluation).toBeDefined();
    expect(snapshot.state.scene).toBeDefined();
    repository.close();
  });

  it("pending_asset_suspends_and_http_poll_resumes_the_same_run", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const projectId = await m0TailFixture(repository);
    const ensure = vi.fn(async () => ({
      status: "pending" as const,
      requestId: "request-1",
      resumeAfter: "2026-01-01T00:00:05.000Z",
    }));
    const operations = new PostConceptOperations(repository, {
      assetProduction: { ensure },
    });
    const driver = new PostConceptGraphDriver(repository, { operations });

    await driver.advance(projectId);
    const firstRunId = repository.getProject(projectId).workflowRunId;
    await driver.advance(projectId);

    expect(repository.getProject(projectId).workflowRunId).toBe(firstRunId);
    expect(repository.getProject(projectId).stage).toBe("asset-production");
    expect(ensure).toHaveBeenCalledTimes(2);
    repository.close();
  });

  it("second_pending_poll_does_not_create_another_paid_submission", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const projectId = await m0TailFixture(repository);
    const state = repository.getProject(projectId);
    const intent = repository.recordSubmissionIntent({
      projectId,
      operation: "image-to-model",
      provider: "fixture",
      idempotencyKey: "one-paid-intent",
      payload: {},
    });
    const operations = new PostConceptOperations(repository, {
      assetProduction: {
        ensure: async () => ({
          status: "pending",
          requestId: "request-1",
          resumeAfter: "2026-01-01T00:00:05.000Z",
        }),
      },
    });
    const driver = new PostConceptGraphDriver(repository, { operations });

    await driver.advance(projectId);
    await driver.advance(projectId);

    expect(repository.getSubmissionByKey("one-paid-intent")?.requestId).toBe(
      intent.requestId,
    );
    expect(repository.getProject(projectId).spentUsd).toBe(state.spentUsd);
    repository.close();
  });

  it("approval_resume_continues_from_asset_plan_gate", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const fixture = m2Fixture(repository);
    const driver = new PostConceptGraphDriver(repository, {
      slots: readyM2Slots(
        fixture.projectId,
        fixture.assetPlan,
        fixture.revision,
      ),
    });
    await driver.advance(fixture.projectId);
    const suspendedRunId = repository.getProject(
      fixture.projectId,
    ).workflowRunId;
    const state = repository.getProject(fixture.projectId);
    const decision: ApprovalDecision = repository.recordApproval({
      approvalId: "approval-1",
      projectId: fixture.projectId,
      targetType: "asset-plan",
      targetRevisionId: fixture.assetPlan.revisionId,
      targetSha256: fixture.assetPlan.artifact.sha256,
      decision: "approved",
      decidedBy: "test",
      decidedAt: "2026-01-01T00:00:01.000Z",
    });
    repository.saveProject({
      ...state,
      assetPlanApproval: decision,
      status: "active",
    });

    const completed = await driver.advance(
      fixture.projectId,
      "approval-recorded",
    );

    expect(completed.state.workflowRunId).toBe(suspendedRunId);
    expect(completed.state.stage).toBe("complete");
    repository.close();
  });

  it("workflow_failure_maps_to_typed_blocked_reason_and_failed_event", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const { projectId } = m2Fixture(repository);

    const snapshot = await new PostConceptGraphDriver(repository).advance(
      projectId,
    );

    expect(snapshot.state).toMatchObject({
      stage: "blocked",
      blockedReason: {
        code: "asset-plan-invalid-input",
        failureKind: "user-action-required",
      },
    });
    expect(
      repository
        .listEvents(projectId)
        .some(({ type }) => type === "workflow.node.failed"),
    ).toBe(true);
    repository.close();
  });

  it("simultaneous_advance_calls_share_one_in_process_project_promise", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const projectId = await m0TailFixture(repository);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operations = new PostConceptOperations(repository, {
      assetProduction: {
        ensure: async () => {
          await gate;
          return {
            status: "pending",
            requestId: "request-1",
            resumeAfter: "2026-01-01T00:00:05.000Z",
          };
        },
      },
    });
    const driver = new PostConceptGraphDriver(repository, { operations });

    const first = driver.advance(projectId);
    const second = driver.advance(projectId);
    expect(second).toBe(first);
    release();
    await first;
    repository.close();
  });
});

const preparedM0Asset = async (repository: ProjectRepository) => {
  const projectId = await m0TailFixture(repository);
  const state = repository.getProject(projectId);
  const outcome = await new AssetProduction(repository).ensure({
    projectId,
    runId: state.runId,
    mode: "replay",
    assetProvider: state.assetProvider,
    concept: state.concept!,
  });
  if (outcome.status !== "ready")
    throw new Error("Replay asset fixture did not become ready.");
  repository.saveProject({
    ...repository.getProject(projectId),
    asset: outcome.value,
    stage: "asset-quality",
  });
  return { projectId, asset: outcome.value };
};

describe("PostConceptGraphDriver reconstruction", () => {
  it("new_coordinator_reconstructs_pending_asset_from_submission_journal", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const projectId = await m0TailFixture(repository);
    const state = repository.getProject(projectId);
    repository.saveProject({
      ...state,
      mode: "live",
      workflowRunId: "lost-workflow-run",
    });
    const key = `asset:${projectId}:${state.concept!.artifact.sha256}:live:meshy`;
    const intent = repository.recordSubmissionIntent({
      projectId,
      operation: "image-to-model",
      provider: "meshy",
      idempotencyKey: key,
      payload: { conceptRevisionId: state.concept!.revisionId },
    });
    repository.updateSubmission(intent.requestId, {
      status: "pending",
      externalJobId: "meshy-job-reconstructed",
    });
    const glb = await createReplayReliquary();
    const glbBuffer = new ArrayBuffer(glb.byteLength);
    new Uint8Array(glbBuffer).set(glb);
    const fetchMock = vi.fn(async (request: string | URL | Request) => {
      const url = String(request);
      if (url.endsWith("/image-to-3d/meshy-job-reconstructed"))
        return Response.json({
          status: "SUCCEEDED",
          model_urls: { glb: "https://assets.test/reconstructed.glb" },
        });
      if (url === "https://assets.test/reconstructed.glb")
        return new Response(glbBuffer, { status: 200 });
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    process.env.MESHY_API_KEY = "test-key";
    process.env.FULCRUM_MESHY_MODEL = "meshy-6";

    await new PostConceptGraphDriver(repository).advance(projectId);

    expect(repository.getProject(projectId).asset).toBeDefined();
    expect(
      fetchMock.mock.calls.some(([request]) =>
        String(request).endsWith("/image-to-3d"),
      ),
    ).toBe(false);
    repository.close();
  });

  it("stale_workflow_run_id_emits_reconstructed_and_is_replaced", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const { projectId } = await preparedM0Asset(repository);
    const state = repository.getProject(projectId);
    repository.saveProject({ ...state, workflowRunId: "stale-run" });

    await new PostConceptGraphDriver(repository).advance(projectId);

    expect(repository.getProject(projectId).workflowRunId).not.toBe(
      "stale-run",
    );
    expect(
      repository
        .listEvents(projectId)
        .some(({ type }) => type === "workflow.run.reconstructed"),
    ).toBe(true);
    repository.close();
  });

  it("restart_at_asset_quality_skips_asset_production", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const { projectId } = await preparedM0Asset(repository);
    const ensure = vi.fn(async () => {
      throw new Error("asset production should be skipped");
    });
    const operations = new PostConceptOperations(repository, {
      assetProduction: { ensure },
    });

    const snapshot = await new PostConceptGraphDriver(repository, {
      operations,
    }).advance(projectId);

    expect(snapshot.state.stage).toBe("visual-slice-approval");
    expect(ensure).not.toHaveBeenCalled();
    repository.close();
  });

  it("restart_at_scene_composition_reuses_quality_revision", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const { projectId, asset } = await preparedM0Asset(repository);
    const state = repository.getProject(projectId);
    const report = await new AssetQuality(repository).evaluate({
      projectId,
      runId: state.runId,
      asset,
    });
    repository.saveProject({
      ...repository.getProject(projectId),
      assetEvaluation: report.revision,
      stage: "scene-composition",
    });
    const evaluate = vi.fn(async () => {
      throw new Error("quality should be skipped");
    });
    const operations = new PostConceptOperations(repository, {
      assetQuality: { evaluate },
    });

    await new PostConceptGraphDriver(repository, { operations }).advance(
      projectId,
    );

    expect(repository.getProject(projectId).assetEvaluation?.revisionId).toBe(
      report.revision.revisionId,
    );
    expect(evaluate).not.toHaveBeenCalled();
    repository.close();
  });

  it("restart_after_completed_checkpoint_does_not_duplicate_revision", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const projectId = await m0TailFixture(repository);
    const first = await new PostConceptGraphDriver(repository).advance(
      projectId,
    );
    const revisionIds = {
      asset: first.state.asset?.revisionId,
      quality: first.state.assetEvaluation?.revisionId,
      scene: first.state.scene?.revisionId,
    };
    const eventCount = repository.listEvents(projectId).length;

    const second = await new PostConceptGraphDriver(repository).advance(
      projectId,
    );

    expect({
      asset: second.state.asset?.revisionId,
      quality: second.state.assetEvaluation?.revisionId,
      scene: second.state.scene?.revisionId,
    }).toEqual(revisionIds);
    expect(repository.listEvents(projectId)).toHaveLength(eventCount);
    repository.close();
  });

  it("reconstruction_never_reads_a_mastra_snapshot", async () => {
    const root = temporaryRoot();
    const firstRepository = new ProjectRepository(root);
    const { projectId } = await preparedM0Asset(firstRepository);
    firstRepository.close();

    const reconstructed = new ProjectRepository(root);
    const snapshot = await new PostConceptGraphDriver(reconstructed).advance(
      projectId,
    );

    expect(snapshot.state.stage).toBe("visual-slice-approval");
    reconstructed.close();
  });
});

const batchSlots = (
  fixture: ReturnType<typeof m2Fixture>,
  orderedAssetIds: string[],
  hooks: {
    multiview?: M2MacroGraphSlots["multiviewConcepts"]["ensure"];
    regeneration?: M2MacroGraphSlots["regeneration"]["ensure"];
    classification?: (assetId: string) => "hero" | "kit";
  } = {},
): M2MacroGraphSlots => {
  const candidate = fixture.revision(`candidate-${orderedAssetIds.join("-")}`);
  const deterministic = fixture.revision(
    `deterministic-${orderedAssetIds.join("-")}`,
  );
  const semantic = fixture.revision(`semantic-${orderedAssetIds.join("-")}`);
  const classify =
    hooks.classification ??
    ((assetId: string): "hero" | "kit" =>
      assetId === "hero" ? "hero" : "kit");
  return {
    assetPlanning: {
      ensure: async () => ({
        status: "ready",
        value: {
          projectId: fixture.projectId,
          assetPlan: fixture.assetPlan,
          orderedAssetIds,
        },
      }),
    },
    multiviewConcepts: {
      ensure:
        hooks.multiview ??
        (async (input) => ({
          status: "ready",
          value: {
            ...input,
            classification: classify(input.assetId),
            multiviewDecision: "not-required",
          },
        })),
    },
    assetProduction: {
      ensure: async (input) => ({
        status: "ready",
        value: { ...input, candidateAsset: candidate },
      }),
    },
    deterministicQa: {
      ensure: async (input) => ({
        status: "ready",
        value: { ...input, deterministicReport: deterministic },
      }),
    },
    turntableEvaluation: {
      ensure: async (input) => ({
        status: "ready",
        value: {
          ...input,
          semanticReport: semantic,
          disposition: "accept",
        },
      }),
    },
    regeneration: {
      ensure:
        hooks.regeneration ??
        (async (input) => ({
          status: "ready",
          value: {
            ...input,
            bestAsset: candidate,
            finalDeterministicReport: deterministic,
            finalSemanticReport: semantic,
            attemptCount: 1,
            validated: true,
          },
        })),
    },
  };
};

const approveFixturePlan = (
  repository: ProjectRepository,
  fixture: ReturnType<typeof m2Fixture>,
) => {
  const state = repository.getProject(fixture.projectId);
  const decision = repository.recordApproval({
    approvalId: `approval-${fixture.projectId}`,
    projectId: fixture.projectId,
    targetType: "asset-plan",
    targetRevisionId: fixture.assetPlan.revisionId,
    targetSha256: fixture.assetPlan.artifact.sha256,
    decision: "approved",
    decidedBy: "test",
    decidedAt: "2026-01-01T00:00:01.000Z",
  });
  repository.saveProject({
    ...state,
    assetPlanApproval: decision,
    status: "active",
  });
};

describe("M2 macro slot contracts", () => {
  it("planner_output_suspends_for_exact_asset_plan_approval", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const fixture = m2Fixture(repository);
    const driver = new PostConceptGraphDriver(repository, {
      slots: batchSlots(fixture, ["hero"]),
    });

    const snapshot = await driver.advance(fixture.projectId);

    expect(snapshot.state).toMatchObject({
      stage: "asset-plan-approval",
      status: "awaiting-approval",
      assetPlan: { revisionId: fixture.assetPlan.revisionId },
    });
    expect(repository.listEvents(fixture.projectId).at(-1)).toMatchObject({
      type: "workflow.node.suspended",
      payload: {
        nodeId: "m2.asset-plan-approval",
        checkpointKey: `m2.asset-plan-approval:${fixture.assetPlan.revisionId}`,
      },
    });
    repository.close();
  });

  it("foreach_receives_dependency_ordered_asset_ids", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const fixture = m2Fixture(repository);
    const received: string[] = [];
    const base = batchSlots(fixture, ["hero", "door", "wall"]);
    const slots: M2MacroGraphSlots = {
      ...base,
      multiviewConcepts: {
        ensure: async (input) => {
          received.push(input.assetId);
          return await base.multiviewConcepts.ensure(input);
        },
      },
    };
    const driver = new PostConceptGraphDriver(repository, { slots });
    await driver.advance(fixture.projectId);
    approveFixturePlan(repository, fixture);

    await driver.advance(fixture.projectId, "approval-recorded");

    expect(received).toEqual(["hero", "door", "wall"]);
    repository.close();
  });

  it("foreach_never_exceeds_max_concurrent_external_jobs", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const fixture = m2Fixture(repository);
    let active = 0;
    let maximum = 0;
    const base = batchSlots(fixture, ["hero", "a", "b", "c"], {
      multiview: async (input) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return {
          status: "ready",
          value: {
            ...input,
            classification: input.assetId === "hero" ? "hero" : "kit",
            multiviewDecision: "not-required",
          },
        };
      },
    });
    const driver = new PostConceptGraphDriver(repository, { slots: base });
    await driver.advance(fixture.projectId);
    approveFixturePlan(repository, fixture);

    await driver.advance(fixture.projectId, "approval-recorded");

    expect(maximum).toBe(2);
    repository.close();
  });

  it("one_suspended_iteration_resumes_by_foreach_index", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const fixture = m2Fixture(repository);
    const calls = new Map<string, number>();
    const slots = batchSlots(fixture, ["hero", "door"], {
      multiview: async (input) => {
        const count = (calls.get(input.assetId) ?? 0) + 1;
        calls.set(input.assetId, count);
        if (input.assetId === "door" && count === 1)
          return {
            status: "pending",
            requestId: "door-request",
            resumeAfter: "2026-01-01T00:00:05.000Z",
          };
        return {
          status: "ready",
          value: {
            ...input,
            classification: input.assetId === "hero" ? "hero" : "kit",
            multiviewDecision: "not-required",
          },
        };
      },
    });
    const driver = new PostConceptGraphDriver(repository, { slots });
    await driver.advance(fixture.projectId);
    approveFixturePlan(repository, fixture);
    const suspended = await driver.advance(
      fixture.projectId,
      "approval-recorded",
    );
    expect(suspended.state.stage).toBe("asset-batch");

    const completed = await driver.advance(fixture.projectId);

    expect(completed.state.stage).toBe("complete");
    expect(calls.get("door")).toBe(2);
    repository.close();
  });

  it("ready_sibling_iterations_are_not_reexecuted", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const fixture = m2Fixture(repository);
    const calls = new Map<string, number>();
    const slots = batchSlots(fixture, ["hero", "door"], {
      multiview: async (input) => {
        const count = (calls.get(input.assetId) ?? 0) + 1;
        calls.set(input.assetId, count);
        if (input.assetId === "door" && count === 1)
          return {
            status: "pending",
            requestId: "door-request",
            resumeAfter: "2026-01-01T00:00:05.000Z",
          };
        return {
          status: "ready",
          value: {
            ...input,
            classification: input.assetId === "hero" ? "hero" : "kit",
            multiviewDecision: "not-required",
          },
        };
      },
    });
    const driver = new PostConceptGraphDriver(repository, { slots });
    await driver.advance(fixture.projectId);
    approveFixturePlan(repository, fixture);
    await driver.advance(fixture.projectId, "approval-recorded");
    await driver.advance(fixture.projectId);

    expect(calls.get("hero")).toBe(1);
    expect(calls.get("door")).toBe(2);
    repository.close();
  });

  it("regeneration_receives_the_exact_qa_and_semantic_report_refs", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const fixture = m2Fixture(repository);
    const deterministic = fixture.revision("exact-deterministic");
    const semantic = fixture.revision("exact-semantic");
    let received:
      | {
          deterministicReport: RevisionRef;
          semanticReport: RevisionRef;
        }
      | undefined;
    const base = batchSlots(fixture, ["hero"]);
    const slots: M2MacroGraphSlots = {
      ...base,
      deterministicQa: {
        ensure: async (input) => ({
          status: "ready",
          value: { ...input, deterministicReport: deterministic },
        }),
      },
      turntableEvaluation: {
        ensure: async (input) => ({
          status: "ready",
          value: {
            ...input,
            semanticReport: semantic,
            disposition: "accept",
          },
        }),
      },
      regeneration: {
        ensure: async (input) => {
          received = {
            deterministicReport: input.deterministicReport,
            semanticReport: input.semanticReport,
          };
          return {
            status: "ready",
            value: {
              ...input,
              bestAsset: input.candidateAsset,
              finalDeterministicReport: input.deterministicReport,
              finalSemanticReport: input.semanticReport,
              attemptCount: 1,
              validated: true,
            },
          };
        },
      },
    };
    const driver = new PostConceptGraphDriver(repository, { slots });
    await driver.advance(fixture.projectId);
    approveFixturePlan(repository, fixture);
    await driver.advance(fixture.projectId, "approval-recorded");

    expect(received?.deterministicReport).toEqual(deterministic);
    expect(received?.semanticReport).toEqual(semantic);
    repository.close();
  });

  it("batch_cannot_complete_without_a_validated_hero_result", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const fixture = m2Fixture(repository);
    const slots = batchSlots(fixture, ["hero"], {
      classification: () => "kit",
    });
    const driver = new PostConceptGraphDriver(repository, { slots });
    await driver.advance(fixture.projectId);
    approveFixturePlan(repository, fixture);

    const blocked = await driver.advance(
      fixture.projectId,
      "approval-recorded",
    );

    expect(blocked.state).toMatchObject({
      stage: "blocked",
      blockedReason: {
        code: "validated-hero-required",
        failureKind: "policy-blocked",
      },
    });
    repository.close();
  });
});
