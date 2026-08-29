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
  DEFAULT_ASSET_POLICIES,
  createReplayReliquary,
} from "@fulcrum/production";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  M2_GRAPH_SLOTS,
  PostConceptGraphDriver,
  createPostConceptWorkflow,
} from "./macro-graph.js";
import {
  createM2MacroGraphSlots,
  PostConceptOperations,
  type M2MacroGraphSlots,
} from "./macro-operations.js";
import { M0Coordinator } from "./coordinator.js";
import { qualityEvidenceFor } from "./m1-coordinator.js";

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
  vi.unstubAllEnvs();
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
  const gameDesignSpec = revision("game-design", "game-design-spec");
  const visualDirectionSet = revision("directions", "visual-direction-set");
  const conceptImage = repository.putArtifact(
    projectId,
    Uint8Array.from([137, 80, 78, 71]),
    "image/png",
  );
  const concept = repository.writeRevision({
    projectId,
    entityId: `${projectId}:concept:hero`,
    kind: "concept-document",
    value: {
      conceptId: `${projectId}:concept:hero`,
      name: "Reliquary hero",
      prompt: "An ancient reliquary with a cyan crystal core and bronze rings.",
      negativePrompt: "photorealism",
      image: conceptImage,
      provider: "fulcrum-replay",
      model: "fixture-concept-v1",
      sourceRevisionIds: [
        gameDesignSpec.revisionId,
        visualDirectionSet.revisionId,
      ],
      ancestors: [gameDesignSpec, visualDirectionSet].map((source) => ({
        revisionId: source.revisionId,
        sha256: source.artifact.sha256,
        kind: source.kind,
      })),
      costUsd: 0,
    },
    runId,
  });
  const conceptSet = repository.writeRevision({
    projectId,
    entityId: `${projectId}:concept-set`,
    kind: "concept-set",
    value: {
      conceptSetId: `${projectId}:concept-set`,
      sourceDirectionRevisionId: visualDirectionSet.revisionId,
      slots: [
        {
          slotId: "hero",
          name: "Reliquary hero",
          purpose: "Readable hero objective",
          revisions: [
            {
              revision: concept,
              inheritedVisualTokens: [
                {
                  tokenId: "hero-shape",
                  category: "shape",
                  value: "squat octagonal stone reliquary",
                },
                {
                  tokenId: "hero-material",
                  category: "material",
                  value: "weathered dark stone and restrained bronze rings",
                },
                {
                  tokenId: "hero-prohibited",
                  category: "prohibited-style",
                  value: "photoreal product rendering",
                },
              ],
            },
          ],
          selectedRevisionId: concept.revisionId,
        },
      ],
    },
    runId,
  });
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
          rationale: "Readable hero prop at the center of the arena.",
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
            conceptSlots: [
              {
                slotId: "hero",
                concept: {
                  revisionId: concept.revisionId,
                  sha256: concept.artifact.sha256,
                  kind: concept.kind,
                },
              },
            ],
          },
          dependsOnAssetIds: [],
          acceptanceCriteria: ["cyan crystal core", "bronze binding rings"],
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
    conceptSetApproval: {
      approvalId: "concept-set-approval",
      projectId,
      targetType: "concept-set",
      targetRevisionId: conceptSet.revisionId,
      targetSha256: conceptSet.artifact.sha256,
      decision: "approved",
      decidedBy: "test",
      decidedAt: createdAt,
    },
    gameDesignSpec,
    gameDesignApproval: {
      approvalId: "game-design-approval",
      projectId,
      targetType: "game-design",
      targetRevisionId: gameDesignSpec.revisionId,
      targetSha256: gameDesignSpec.artifact.sha256,
      decision: "approved",
      decidedBy: "test",
      decidedAt: createdAt,
    },
    visualDirectionSet,
    selectedVisualDirectionRevisionId: "direction-1",
    createdAt,
    updatedAt: createdAt,
  });
  return { repository, projectId, runId, assetPlan, concept, revision };
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

  it("reconstructs an old awaiting asset-plan gate and auto-finalizes it", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const fixture = m2Fixture(repository);
    repository.saveProject({
      ...repository.getProject(fixture.projectId),
      status: "awaiting-approval",
      stage: "asset-plan-approval",
      assetPlan: fixture.assetPlan,
      workflowRunId: "old-approval-workflow-run",
    });
    const driver = new PostConceptGraphDriver(repository, {
      slots: readyM2Slots(
        fixture.projectId,
        fixture.assetPlan,
        fixture.revision,
      ),
    });
    const completed = await driver.advance(fixture.projectId);

    expect(completed.state.stage).toBe("complete");
    expect(completed.state.assetPlanApproval).toMatchObject({
      decision: "approved",
      decidedBy: "fulcrum:auto-finalizer",
      targetRevisionId: fixture.assetPlan.revisionId,
      targetSha256: fixture.assetPlan.artifact.sha256,
    });
    expect(
      repository
        .listEvents(fixture.projectId)
        .find(
          ({ type, payload }) =>
            type === "workflow.node.completed" &&
            payload.nodeId === "m2.asset-plan-approval",
        ),
    ).toMatchObject({
      payload: {
        stage: "asset-batch",
        decision: "approved",
        decidedBy: "fulcrum:auto-finalizer",
        automatic: true,
        targetRevisionId: fixture.assetPlan.revisionId,
        targetSha256: fixture.assetPlan.artifact.sha256,
      },
    });
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
    assetProduction?: M2MacroGraphSlots["assetProduction"]["ensure"];
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
      ensure:
        hooks.assetProduction ??
        (async (input) => ({
          status: "ready",
          value: { ...input, candidateAsset: candidate },
        })),
    },
    deterministicQa: {
      ensure: async (input) => {
        fixture.repository.getProject(input.projectId);
        return {
          status: "ready",
          value: { ...input, deterministicReport: deterministic },
        };
      },
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

const recoverablyBlockedM2Fixture = async () => {
  const repository = new ProjectRepository(temporaryRoot());
  const fixture = m2Fixture(repository);
  let attempts = 0;
  const multiview = vi.fn(async (input) => {
    attempts += 1;
    if (attempts === 1)
      return {
        status: "failed" as const,
        error: {
          code: "concept-generation-failed",
          message: "Subscription ImageGen needs a user-directed retry.",
          kind: "user-action-required" as const,
          evidenceRevisionIds: [],
        },
      };
    return {
      status: "ready" as const,
      value: {
        ...input,
        classification: "hero" as const,
        multiviewDecision: "not-required" as const,
      },
    };
  });
  const driver = new PostConceptGraphDriver(repository, {
    slots: batchSlots(fixture, ["hero"], { multiview }),
  });
  const blocked = await driver.advance(fixture.projectId);
  return { repository, fixture, driver, blocked, multiview };
};

describe("M2 macro slot contracts", () => {
  it("live_meshy_old_approval_state_auto_finalizes_and_parks_before_legacy_production", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const fixture = m2Fixture(repository);
    repository.saveProject({
      ...repository.getProject(fixture.projectId),
      mode: "live",
      assetProvider: "meshy",
      status: "awaiting-approval",
      stage: "asset-plan-approval",
      assetPlan: fixture.assetPlan,
      workflowRunId: "old-live-approval-workflow-run",
    });
    const assetProduction: Pick<
      AssetProduction,
      "ensure" | "ensureMultiviewConcepts" | "finish"
    > = {
      ensureMultiviewConcepts: vi.fn(async () => {
        throw new Error("legacy multiview must stay parked");
      }),
      ensure: vi.fn(async () => {
        throw new Error("legacy production must stay parked");
      }),
      finish: vi.fn(async () => {
        throw new Error("legacy finishing must stay parked");
      }),
    };
    const slots = createM2MacroGraphSlots(
      repository,
      {
        plan: async () => ({
          status: "ready",
          requestId: "live-fixture-plan",
          value: fixture.assetPlan,
        }),
      },
      { assetProduction },
    );
    const driver = new PostConceptGraphDriver(repository, { slots });
    const parked = await driver.advance(fixture.projectId);

    expect(parked.state).toMatchObject({
      mode: "live",
      assetProvider: "meshy",
      status: "active",
      stage: "asset-batch",
      assetPlanApproval: {
        decision: "approved",
        decidedBy: "fulcrum:auto-finalizer",
        targetRevisionId: fixture.assetPlan.revisionId,
      },
    });
    expect(assetProduction.ensureMultiviewConcepts).not.toHaveBeenCalled();
    expect(assetProduction.ensure).not.toHaveBeenCalled();
    expect(assetProduction.finish).not.toHaveBeenCalled();
    expect(repository.listEvents(fixture.projectId).at(-1)).toMatchObject({
      type: "workflow.node.suspended",
      payload: {
        nodeId: "m2.staged-asset-gate",
        stage: "asset-batch",
      },
    });
    repository.close();
  });

  it("replay_plan_finalization_keeps_the_legacy_asset_path_to_completion", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const fixture = m2Fixture(repository);
    const base = batchSlots(fixture, ["hero"]);
    const multiview = vi.fn(base.multiviewConcepts.ensure);
    const production = vi.fn(base.assetProduction.ensure);
    const finishing = vi.fn(async (input) => ({
      status: "ready" as const,
      value: input,
    }));
    const driver = new PostConceptGraphDriver(repository, {
      slots: {
        ...base,
        multiviewConcepts: { ensure: multiview },
        assetProduction: { ensure: production },
        assetFinishing: { ensure: finishing },
      },
    });
    const completed = await driver.advance(fixture.projectId);

    expect(completed.state).toMatchObject({
      mode: "replay",
      status: "complete",
      stage: "complete",
    });
    expect(multiview).toHaveBeenCalledOnce();
    expect(production).toHaveBeenCalledOnce();
    expect(finishing).toHaveBeenCalledOnce();
    repository.close();
  });

  it("live_meshy_reconstruction_mid_batch_stays_parked_with_pending_legacy_submissions", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const fixture = m2Fixture(repository);
    approveFixturePlan(repository, fixture);
    repository.saveProject({
      ...repository.getProject(fixture.projectId),
      mode: "live",
      assetProvider: "meshy",
      stage: "asset-batch",
      assetPlan: fixture.assetPlan,
      workflowRunId: "interrupted-legacy-run",
    });
    const pendingKeys = ["stuck-concept-view-left", "stuck-concept-view-right"];
    for (const idempotencyKey of pendingKeys) {
      const intent = repository.recordSubmissionIntent({
        projectId: fixture.projectId,
        operation: "m2-concept-view",
        provider: "openai-subscription",
        idempotencyKey,
        payload: { assetId: "hero" },
      });
      repository.updateSubmission(intent.requestId, { status: "pending" });
    }
    const base = batchSlots(fixture, ["hero"]);
    const phases = {
      planning: vi.fn(base.assetPlanning.ensure),
      multiview: vi.fn(base.multiviewConcepts.ensure),
      production: vi.fn(base.assetProduction.ensure),
      qa: vi.fn(base.deterministicQa.ensure),
      turntable: vi.fn(base.turntableEvaluation.ensure),
      regeneration: vi.fn(base.regeneration.ensure),
      finishing: vi.fn(async (input) => ({
        status: "ready" as const,
        value: input,
      })),
    };
    const driver = new PostConceptGraphDriver(repository, {
      slots: {
        assetPlanning: { ensure: phases.planning },
        multiviewConcepts: { ensure: phases.multiview },
        assetProduction: { ensure: phases.production },
        deterministicQa: { ensure: phases.qa },
        turntableEvaluation: { ensure: phases.turntable },
        regeneration: { ensure: phases.regeneration },
        assetFinishing: { ensure: phases.finishing },
      },
    });

    const parked = await driver.advance(fixture.projectId, "reconstructed");

    expect(parked.state).toMatchObject({
      status: "active",
      stage: "asset-batch",
      workflowRunId: "interrupted-legacy-run",
    });
    for (const phase of Object.values(phases))
      expect(phase).not.toHaveBeenCalled();
    for (const idempotencyKey of pendingKeys)
      expect(repository.getSubmissionByKey(idempotencyKey)?.status).toBe(
        "pending",
      );
    repository.close();
  });

  it("planner_output_records_exact_automatic_finalization", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const fixture = m2Fixture(repository);
    const driver = new PostConceptGraphDriver(repository, {
      slots: batchSlots(fixture, ["hero"]),
    });

    const snapshot = await driver.advance(fixture.projectId);

    expect(snapshot.state).toMatchObject({
      stage: "complete",
      status: "complete",
      assetPlan: { revisionId: fixture.assetPlan.revisionId },
      assetPlanApproval: {
        decision: "approved",
        decidedBy: "fulcrum:auto-finalizer",
        targetRevisionId: fixture.assetPlan.revisionId,
      },
    });
    expect(
      repository
        .listEvents(fixture.projectId)
        .find(
          ({ type, payload }) =>
            type === "workflow.node.completed" &&
            payload.nodeId === "m2.asset-plan-approval",
        ),
    ).toMatchObject({
      payload: {
        decision: "approved",
        automatic: true,
        inputRevisionIds: [fixture.assetPlan.revisionId],
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

    expect(maximum).toBe(2);
    repository.close();
  });

  it("one_suspended_iteration_resumes", async () => {
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
    const suspended = await driver.advance(fixture.projectId);
    expect(suspended.state.stage).toBe("asset-batch");

    const completed = await driver.advance(fixture.projectId);

    expect(completed.state.stage).toBe("complete");
    expect(calls.get("door")).toBe(2);
    repository.close();
  });

  it("explicit_advance_reenters_a_recoverable_block_and_completes_the_batch", async () => {
    const { repository, fixture, driver, blocked, multiview } =
      await recoverablyBlockedM2Fixture();

    expect(blocked.state).toMatchObject({
      status: "blocked",
      stage: "blocked",
      blockedReason: {
        recoverable: true,
        resumeStage: "asset-batch",
      },
    });
    repository.saveProject({
      ...blocked.state,
      blockedReason: {
        code: blocked.state.blockedReason!.code,
        message: blocked.state.blockedReason!.message,
        recoverable: true,
        failureKind: blocked.state.blockedReason!.failureKind,
      },
    });

    const completed = await driver.advance(
      fixture.projectId,
      "explicit-advance",
    );

    expect(completed.state).toMatchObject({
      status: "complete",
      stage: "complete",
    });
    expect(multiview).toHaveBeenCalledTimes(2);
    repository.close();
  });

  it("http_poll_does_not_reenter_a_recoverable_block", async () => {
    const { repository, fixture, driver, multiview } =
      await recoverablyBlockedM2Fixture();

    const polled = await driver.advance(fixture.projectId, "http-poll");

    expect(polled.state).toMatchObject({
      status: "blocked",
      stage: "blocked",
      blockedReason: { recoverable: true },
    });
    expect(multiview).toHaveBeenCalledTimes(1);
    repository.close();
  });

  it("explicit_advance_does_not_reenter_a_nonrecoverable_block", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const fixture = m2Fixture(repository);
    const base = batchSlots(fixture, ["hero"], {
      classification: () => "kit",
    });
    const multiview = vi.fn(base.multiviewConcepts.ensure);
    const driver = new PostConceptGraphDriver(repository, {
      slots: {
        ...base,
        multiviewConcepts: { ensure: multiview },
      },
    });
    await driver.advance(fixture.projectId);

    const blocked = await driver.advance(fixture.projectId, "explicit-advance");

    expect(blocked.state).toMatchObject({
      status: "blocked",
      stage: "blocked",
      blockedReason: { recoverable: false },
    });
    expect(multiview).toHaveBeenCalledTimes(1);
    repository.close();
  });

  it("two_concurrent_replay_asset_production_suspends_do_not_block_the_batch", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const fixture = m2Fixture(repository);
    const calls = new Map<string, number>();
    const submissionRequestIds = new Map<string, Set<string>>();
    const completedAssetIds = new Set<string>();
    const candidate = fixture.revision("concurrent-candidate");
    const deterministic = fixture.revision("concurrent-deterministic");
    const semantic = fixture.revision("concurrent-semantic");
    const slots = batchSlots(fixture, ["hero", "door"], {
      multiview: async (input) => {
        if (input.assetId === "door")
          await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          status: "ready",
          value: {
            ...input,
            classification: input.assetId === "hero" ? "hero" : "kit",
            multiviewDecision: "not-required",
          },
        };
      },
      assetProduction: async (input) => {
        const count = (calls.get(input.assetId) ?? 0) + 1;
        calls.set(input.assetId, count);
        const intent = repository.recordSubmissionIntent({
          projectId: input.projectId,
          operation: "image-to-model",
          provider: "fixture",
          idempotencyKey: `m2-production:${input.assetId}`,
          payload: { assetId: input.assetId },
        });
        const requestIds = submissionRequestIds.get(input.assetId) ?? new Set();
        requestIds.add(intent.requestId);
        submissionRequestIds.set(input.assetId, requestIds);
        if (count > 1)
          return {
            status: "ready",
            value: { ...input, candidateAsset: candidate },
          };
        return {
          status: "pending",
          requestId: intent.requestId,
          resumeAfter: "2026-01-01T00:00:05.000Z",
        };
      },
      regeneration: async (input) => {
        completedAssetIds.add(input.assetId);
        return {
          status: "ready",
          value: {
            ...input,
            bestAsset: candidate,
            finalDeterministicReport: deterministic,
            finalSemanticReport: semantic,
            attemptCount: 1,
            validated: true,
          },
        };
      },
    });
    const driver = new PostConceptGraphDriver(repository, { slots });
    const suspended = await driver.advance(fixture.projectId);
    expect(suspended.state).toMatchObject({
      status: "active",
      stage: "asset-batch",
    });
    expect(completedAssetIds.size).toBe(0);

    const completed = await driver.advance(fixture.projectId);

    expect(completed.state).toMatchObject({
      status: "complete",
      stage: "complete",
    });
    expect(calls).toEqual(
      new Map([
        ["hero", 2],
        ["door", 2],
      ]),
    );
    expect(completedAssetIds).toEqual(new Set(["hero", "door"]));
    expect(submissionRequestIds.get("hero")?.size).toBe(1);
    expect(submissionRequestIds.get("door")?.size).toBe(1);
    expect(repository.getSubmissionByKey("m2-production:hero")?.requestId).toBe(
      [...submissionRequestIds.get("hero")!][0],
    );
    expect(repository.getSubmissionByKey("m2-production:door")?.requestId).toBe(
      [...submissionRequestIds.get("door")!][0],
    );
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
            semanticReport: input.semanticReport!,
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
    const blocked = await driver.advance(fixture.projectId);

    expect(blocked.state).toMatchObject({
      stage: "blocked",
      blockedReason: {
        code: "validated-hero-required",
        failureKind: "policy-blocked",
      },
    });
    repository.close();
  });

  it("unsupported_provider_capability_does_not_start_null_multiview_regeneration", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const fixture = m2Fixture(repository);
    repository.saveProject({
      ...repository.getProject(fixture.projectId),
      assetPlan: fixture.assetPlan,
    });
    approveFixturePlan(repository, fixture);
    const slots = createM2MacroGraphSlots(repository, {
      plan: vi.fn(),
    } as never);
    const multiview = {
      projectId: fixture.projectId,
      assetPlan: fixture.assetPlan,
      assetId: "hero",
      classification: "hero" as const,
      multiviewDecision: "not-required" as const,
    };
    const produced = await slots.assetProduction.ensure(multiview);
    if (produced.status !== "ready")
      throw new Error("Replay fixture asset was not ready.");
    const inspected = await slots.deterministicQa.ensure(produced.value);
    if (inspected.status !== "ready")
      throw new Error("Replay fixture inspection was not ready.");
    const evaluated = await slots.turntableEvaluation.ensure(inspected.value);
    if (evaluated.status !== "ready")
      throw new Error("Replay fixture semantic QA was not ready.");
    repository.saveProject({
      ...repository.getProject(fixture.projectId),
      mode: "live",
      assetProvider: "meshy",
    });
    vi.stubEnv("FULCRUM_MESHY_MODEL", "meshy-5");

    const outcome = await slots.regeneration.ensure(evaluated.value);

    expect(outcome).toMatchObject({
      status: "ready",
      value: {
        attemptCount: 1,
        disposition: "user-action-required",
        validated: false,
      },
    });
    expect(
      repository
        .listEvents(fixture.projectId)
        .filter(({ type }) => type === "asset.regeneration-attempt-started"),
    ).toHaveLength(0);
    expect(
      repository
        .listEvents(fixture.projectId)
        .filter(({ type }) => type === "asset.regeneration-strategy-selected")
        .map(({ payload }) => payload.strategyKind),
    ).toEqual(["give-up-user"]);
    repository.close();
  });

  it("revises_persisted_asset_policies_when_quality_thresholds_change", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const fixture = m2Fixture(repository);
    repository.saveProject({
      ...repository.getProject(fixture.projectId),
      assetPlan: fixture.assetPlan,
    });
    approveFixturePlan(repository, fixture);
    const prior = repository.ensureRevision({
      projectId: fixture.projectId,
      operationKey: "m2.asset-policy:hero:v1",
      entityId: `${fixture.projectId}:asset-policy:hero`,
      kind: "asset-policy",
      runId: fixture.runId,
      createValue: () => ({
        ...DEFAULT_ASSET_POLICIES.hero,
        topology: {
          ...DEFAULT_ASSET_POLICIES.hero.topology,
          maxNonManifoldEdges: 0,
        },
      }),
    });
    const slots = createM2MacroGraphSlots(repository, {
      plan: vi.fn(),
    } as never);
    const multiview = await slots.multiviewConcepts.ensure({
      projectId: fixture.projectId,
      assetPlan: fixture.assetPlan,
      assetId: "hero",
    });
    if (multiview.status !== "ready")
      throw new Error("Replay fixture multiview set was not ready.");
    const produced = await slots.assetProduction.ensure(multiview.value);
    if (produced.status !== "ready")
      throw new Error("Replay fixture asset was not ready.");
    const inspected = await slots.deterministicQa.ensure(produced.value);
    if (inspected.status !== "ready")
      throw new Error("Replay fixture inspection was not ready.");

    const report = repository.resolveRevision<{
      policy: { revisionId: string };
    }>(inspected.value.deterministicReport);
    const currentPolicy = repository.resolveRevision<{
      topology: { maxNonManifoldEdges: number };
    }>(repository.getRevision(report.policy.revisionId));

    expect(report.policy.revisionId).not.toBe(prior.revision.revisionId);
    expect(currentPolicy.topology.maxNonManifoldEdges).toBe(250);
    expect(inspected.value.turntable).toBeDefined();
    expect(
      repository.resolveRevision<{ rendererVersion: string }>(
        inspected.value.turntable!,
      ).rendererVersion,
    ).toBe("software-rasterizer-v3");
    repository.close();
  });

  it("replay_hero_runs_change_views_then_validates_attempt_two", async () => {
    vi.stubEnv("FULCRUM_MESHY_MODEL", "meshy-6");
    const repository = new ProjectRepository(temporaryRoot());
    const fixture = m2Fixture(repository);
    const slots = createM2MacroGraphSlots(repository, {
      plan: async () => ({
        status: "ready",
        requestId: "fixture-plan",
        value: fixture.assetPlan,
      }),
    });
    const driver = new PostConceptGraphDriver(repository, { slots });

    const completed = await driver.advance(fixture.projectId);

    const selection = completed.state.assetBatch?.hero;
    expect(completed.state.stage).toBe("complete");
    expect(selection).toMatchObject({
      classification: "hero",
      attemptCount: 2,
      validated: true,
    });
    expect(selection?.current.revisionId).toBe(selection?.best.revisionId);
    expect(
      repository.resolveRevision<{ model: string }>(selection!.best).model,
    ).toBe("parametric-reliquary-rear-defined-v2");

    const events = repository.listEvents(fixture.projectId);
    expect(
      events
        .filter(({ type }) => type === "asset.regeneration-strategy-selected")
        .map(({ payload }) => payload.strategyKind),
    ).toEqual(["change-views", "accept-best"]);
    const regenerationAttempts = events.filter(
      ({ type }) => type === "asset.regeneration-attempt-started",
    );
    expect(regenerationAttempts).toHaveLength(1);
    expect(regenerationAttempts[0]?.payload).toMatchObject({
      multiviewConceptSetRevisionId: expect.any(String),
    });
    expect(
      regenerationAttempts.some(
        ({ payload }) => payload.multiviewConceptSetRevisionId === null,
      ),
    ).toBe(false);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "asset.best-revision-considered",
          payload: expect.objectContaining({ result: "updated" }),
        }),
      ]),
    );

    const changeViewsEvent = events.find(
      ({ type, payload }) =>
        type === "asset.regeneration-strategy-selected" &&
        payload.strategyKind === "change-views",
    );
    const decision = repository.resolveRevision<{
      strategy: { kind: string; roles: string[]; operation: string };
    }>(
      repository.getRevision(
        changeViewsEvent!.payload.decisionRevisionId as string,
      ),
    );
    expect(decision.strategy).toMatchObject({
      kind: "change-views",
      roles: ["back", "left", "right"],
      operation: "add",
    });

    const semanticReports = events.filter(
      ({ type }) => type === "asset.semantic-evaluation-completed",
    );
    expect(semanticReports).toHaveLength(2);
    expect(qualityEvidenceFor(repository, completed.state)?.hero).toMatchObject(
      {
        deterministicReports: [expect.anything(), expect.anything()],
        turntables: [expect.anything(), expect.anything()],
        semanticReports: [expect.anything(), expect.anything()],
        decisions: [
          { report: { strategy: { kind: "change-views" } } },
          { report: { strategy: { kind: "accept-best" } } },
        ],
        events: expect.arrayContaining([
          expect.objectContaining({
            type: "asset.regeneration-strategy-selected",
          }),
        ]),
      },
    );
    const firstReport = repository.resolveRevision<{
      findings: Array<{
        evidence: Array<{ frameIndex?: number; crop?: unknown }>;
      }>;
    }>(
      repository.getRevision(
        semanticReports[0]!.payload.semanticReportRevisionId as string,
      ),
    );
    expect(firstReport.findings[0]?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ frameIndex: 3 }),
        expect.objectContaining({ frameIndex: 4, crop: expect.any(Object) }),
        expect.objectContaining({ frameIndex: 5 }),
      ]),
    );
    repository.close();
  });

  it("restart_between_submission_and_semantic_resume_spends_once", async () => {
    const root = temporaryRoot();
    const repository = new ProjectRepository(root);
    const fixture = m2Fixture(repository);
    const planner = {
      plan: async () => ({
        status: "ready" as const,
        requestId: "fixture-plan",
        value: fixture.assetPlan,
      }),
    };
    const base = createM2MacroGraphSlots(repository, planner);
    let interrupted = false;
    const slots: M2MacroGraphSlots = {
      ...base,
      regeneration: {
        ensure: async (input) => {
          const outcome = await base.regeneration.ensure(input);
          if (!interrupted && outcome.status === "ready") {
            interrupted = true;
            return {
              status: "pending",
              requestId: "semantic-resume-checkpoint-interruption",
              resumeAfter: "2026-01-01T00:00:05.000Z",
            };
          }
          return outcome;
        },
      },
    };
    const driver = new PostConceptGraphDriver(repository, { slots });
    const suspended = await driver.advance(fixture.projectId);
    expect(suspended.state.stage).toBe("asset-batch");
    const baselineSubmission = repository
      .listEvents(fixture.projectId)
      .find(({ type }) => type === "asset.semantic-evaluation-submitted");
    expect(baselineSubmission).toBeDefined();
    const completedViewImages = repository
      .listEvents(fixture.projectId)
      .filter(({ type }) => type === "concept-view.image-completed").length;
    expect(completedViewImages).toBe(7);
    repository.close();

    const reconstructed = new ProjectRepository(root);
    const restarted = new PostConceptGraphDriver(reconstructed, {
      slots: createM2MacroGraphSlots(reconstructed, planner),
    });
    const completed = await restarted.advance(
      fixture.projectId,
      "reconstructed",
    );
    const semanticSubmissions = reconstructed
      .listEvents(fixture.projectId)
      .filter(({ type }) => type === "asset.semantic-evaluation-submitted");

    expect(completed.state.stage).toBe("complete");
    expect(
      semanticSubmissions.filter(
        ({ payload }) =>
          payload.requestDigest === baselineSubmission!.payload.requestDigest,
      ),
    ).toHaveLength(1);
    expect(
      new Set(semanticSubmissions.map(({ payload }) => payload.requestDigest))
        .size,
    ).toBe(2);
    expect(
      reconstructed
        .listEvents(fixture.projectId)
        .filter(({ type }) => type === "concept-view.image-completed"),
    ).toHaveLength(completedViewImages);
    reconstructed.close();
  });

  it("accept_best_strategy_does_not_validate_a_revise_verdict", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const fixture = m2Fixture(repository);
    const quality = new AssetQuality(repository);
    const slots = createM2MacroGraphSlots(
      repository,
      {
        plan: async () => ({
          status: "ready",
          requestId: "fixture-plan",
          value: fixture.assetPlan,
        }),
      },
      {
        assetQuality: {
          inspect: quality.inspect.bind(quality),
          ensureSemantic: quality.ensureSemantic.bind(quality),
          selectRegeneration: async (input) => {
            const selected = await quality.selectRegeneration(input);
            return {
              ...selected,
              decision: {
                ...selected.decision,
                strategy: {
                  kind: "accept-best" as const,
                  rationale: "Forced accept-best fixture.",
                  reasonFindingIds: [],
                  assetRevisionId: input.currentAttempt.asset.revisionId,
                },
              },
            };
          },
        },
      },
    );
    repository.saveProject({
      ...repository.getProject(fixture.projectId),
      assetPlan: fixture.assetPlan,
    });
    approveFixturePlan(repository, fixture);
    const multiview = await slots.multiviewConcepts.ensure({
      projectId: fixture.projectId,
      assetPlan: fixture.assetPlan,
      assetId: "hero",
    });
    if (multiview.status !== "ready")
      throw new Error("Replay fixture multiview set was not ready.");
    const produced = await slots.assetProduction.ensure(multiview.value);
    if (produced.status !== "ready")
      throw new Error("Replay fixture asset was not ready.");
    const inspected = await slots.deterministicQa.ensure(produced.value);
    if (inspected.status !== "ready")
      throw new Error("Replay fixture inspection was not ready.");
    const evaluated = await slots.turntableEvaluation.ensure(inspected.value);
    if (evaluated.status !== "ready")
      throw new Error("Replay fixture semantic QA was not ready.");

    const outcome = await slots.regeneration.ensure(evaluated.value);

    expect(outcome).toMatchObject({
      status: "ready",
      value: {
        attemptCount: 1,
        disposition: "user-action-required",
        validated: false,
      },
    });
    repository.close();
  });

  it("semantically_rejected_best_attempt_is_not_validated", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const fixture = m2Fixture(repository);
    const replayVisionCatalog = {
      schema: "fulcrum.replay-vision-catalog" as const,
      version: 1 as const,
      fixtures: [
        {
          requestDigest:
            "ce80f5382b896fbba01f160876f5bfaee69e34ec6b1689e43b0ea06df82c4075",
          description: "baseline remains the Pareto incumbent",
          response: {
            verdict: "revise" as const,
            dimensionScores: { "silhouette-readability": 0.42 },
            findings: [
              {
                criterionId: "silhouette-readability" as const,
                summary: "The rear silhouette needs direct concept evidence.",
                severity: "major" as const,
                confidence: 0.94,
                evidence: [{ frameIndex: 4 }],
                suggestedAction: "Add rear and side concept views.",
              },
            ],
          },
        },
        {
          requestDigest:
            "bfc34ee8c986f061c306d7b4cfe7b25d702239321953ab5d37a0ef3e0fb87ae1",
          description: "rear-defined attempt regresses concept fidelity",
          response: {
            verdict: "revise" as const,
            dimensionScores: { "concept-fidelity": 0.18 },
            findings: [
              {
                criterionId: "concept-fidelity" as const,
                summary: "The correction changes the approved identity.",
                severity: "critical" as const,
                confidence: 0.96,
                evidence: [{ frameIndex: 0 }],
                suggestedAction: "Restore the approved front identity.",
              },
            ],
          },
        },
      ],
    };
    const quality = new AssetQuality(repository, { replayVisionCatalog });
    const slots = createM2MacroGraphSlots(
      repository,
      {
        plan: async () => ({
          status: "ready",
          requestId: "fixture-plan",
          value: fixture.assetPlan,
        }),
      },
      { assetQuality: quality },
    );
    repository.saveProject({
      ...repository.getProject(fixture.projectId),
      assetPlan: fixture.assetPlan,
    });
    approveFixturePlan(repository, fixture);
    const multiview = await slots.multiviewConcepts.ensure({
      projectId: fixture.projectId,
      assetPlan: fixture.assetPlan,
      assetId: "hero",
    });
    if (multiview.status !== "ready")
      throw new Error("Replay fixture multiview set was not ready.");
    const produced = await slots.assetProduction.ensure(multiview.value);
    if (produced.status !== "ready")
      throw new Error("Replay fixture asset was not ready.");
    const inspected = await slots.deterministicQa.ensure(produced.value);
    if (inspected.status !== "ready")
      throw new Error("Replay fixture inspection was not ready.");
    const evaluated = await slots.turntableEvaluation.ensure(inspected.value);
    if (evaluated.status !== "ready")
      throw new Error("Replay fixture semantic QA was not ready.");

    const outcome = await slots.regeneration.ensure(evaluated.value);
    if (outcome.status !== "ready")
      throw new Error(
        `Replay fixture regeneration was not ready: ${JSON.stringify(outcome)}`,
      );
    const selection = outcome.value;

    expect(selection).toMatchObject({ attemptCount: 2, validated: false });
    expect(selection.candidateAsset.revisionId).not.toBe(
      selection.bestAsset.revisionId,
    );
    expect(
      repository
        .listEvents(fixture.projectId)
        .filter(({ type }) => type === "asset.best-revision-considered")
        .at(-1),
    ).toMatchObject({ payload: { result: "retained" } });
    expect(
      repository
        .listEvents(fixture.projectId)
        .filter(({ type }) => type === "asset.regeneration-strategy-selected")
        .map(({ payload }) => payload.strategyKind),
    ).toEqual(["change-views", "give-up-user"]);
    repository.close();
  });
});
