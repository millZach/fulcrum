import {
  AssetBatchNodeOutputSchema,
  AssetPathBaseSchema,
  AssetPlanningNodeOutputSchema,
  AssetProductionNodeOutputSchema,
  DeterministicQaNodeOutputSchema,
  MacroGraphInputSchema,
  MacroGraphOutputSchema,
  MacroGraphResumeSchema,
  MacroGraphSuspendSchema,
  MultiviewNodeOutputSchema,
  RegenerationNodeOutputSchema,
  TurntableEvaluationNodeOutputSchema,
  ProjectSnapshotSchema,
  type MacroPhase,
  type WorkflowFailure,
  type ProjectSnapshot,
} from "@fulcrum/domain";
import { randomUUID } from "node:crypto";
import { ProjectRepository } from "@fulcrum/project";
import { Mastra } from "@mastra/core";
import { InMemoryStore } from "@mastra/core/storage";
import { createStep, createWorkflow, type Step } from "@mastra/core/workflows";
import { z } from "zod";

import {
  PostConceptOperations,
  unavailableM2MacroGraphSlots,
  type M2MacroGraphSlots,
  type PostConceptOperationOutcome,
} from "./macro-operations.js";

export const M2_GRAPH_SLOTS = {
  assetPlanning: "m2.asset-planning",
  assetPlanApproval: "m2.asset-plan-approval",
  expandAssetPaths: "m2.expand-asset-paths",
  multiviewConcepts: "m2.asset.multiview-concept",
  assetProduction: "m2.asset.production",
  deterministicQa: "m2.asset.deterministic-qa",
  turntableEvaluation: "m2.asset.turntable-evaluation",
  regeneration: "m2.asset.regeneration",
  assetBatchAggregation: "m2.asset-batch-aggregation",
  complete: "m2.complete",
} as const;

const RoutedInputSchema = MacroGraphInputSchema.extend({
  milestone: z.enum(["m0", "m2"]),
});
const PlanningRuntimeSchema = RoutedInputSchema.extend({
  assetPlan: AssetPlanningNodeOutputSchema.shape.assetPlan,
  orderedAssetIds: AssetPlanningNodeOutputSchema.shape.orderedAssetIds,
});
const BatchRuntimeSchema = AssetBatchNodeOutputSchema;

export class WorkflowNodeFailure extends Error {
  constructor(readonly failure: WorkflowFailure) {
    super(`FULCRUM_WORKFLOW_FAILURE:${JSON.stringify(failure)}`);
    this.name = "WorkflowNodeFailure";
  }
}

const failed = (error: WorkflowFailure): never => {
  throw new WorkflowNodeFailure(error);
};

const m0Step = (
  id: "m0.asset-production" | "m0.asset-quality" | "m0.scene-composition",
  run: (projectId: string) => Promise<PostConceptOperationOutcome>,
) =>
  createStep({
    id,
    inputSchema: RoutedInputSchema,
    outputSchema: RoutedInputSchema,
    suspendSchema: MacroGraphSuspendSchema,
    resumeSchema: MacroGraphResumeSchema,
    execute: async ({ inputData, suspend }) => {
      const outcome = await run(inputData.projectId);
      if (outcome.status === "failed") return failed(outcome.error);
      if (outcome.status === "suspended") return suspend(outcome.suspend);
      return inputData;
    },
  });

const runM2Phase = async <I, O>(
  phase: MacroPhase<I, O>,
  input: I,
  suspend: (payload: z.infer<typeof MacroGraphSuspendSchema>) => unknown,
  nodeId: z.infer<typeof MacroGraphSuspendSchema>["nodeId"],
  projectId: string,
  assetId?: string,
): Promise<O> => {
  const outcome = await phase.ensure(input);
  if (outcome.status === "failed") return failed(outcome.error);
  if (outcome.status === "pending")
    return (await suspend({
      projectId,
      nodeId,
      reason: "provider-pending",
      requestId: outcome.requestId,
      resumeAfter: outcome.resumeAfter,
      ...(assetId ? { assetId } : {}),
    })) as never;
  return outcome.value;
};

const createM0Tail = (operations: PostConceptOperations) => {
  const production = m0Step(
    "m0.asset-production",
    operations.assetProduction.bind(operations),
  );
  const quality = m0Step(
    "m0.asset-quality",
    operations.assetQuality.bind(operations),
  );
  const scene = m0Step(
    "m0.scene-composition",
    operations.sceneComposition.bind(operations),
  );
  const finish = createStep({
    id: "m0.tail-complete",
    inputSchema: RoutedInputSchema,
    outputSchema: MacroGraphOutputSchema,
    execute: async ({ inputData }) => ({
      projectId: inputData.projectId,
      milestone: "m0" as const,
      terminalStage: operations.repository.getProject(inputData.projectId)
        .stage,
    }),
  });
  return createWorkflow({
    id: "m0-tail",
    inputSchema: RoutedInputSchema,
    outputSchema: MacroGraphOutputSchema,
  })
    .then(production)
    .then(quality)
    .then(scene)
    .then(finish)
    .commit();
};

const createM2AssetPath = (slots: M2MacroGraphSlots) => {
  const multiview = createStep({
    id: M2_GRAPH_SLOTS.multiviewConcepts,
    inputSchema: AssetPathBaseSchema,
    outputSchema: MultiviewNodeOutputSchema,
    suspendSchema: MacroGraphSuspendSchema,
    resumeSchema: MacroGraphResumeSchema,
    execute: async ({ inputData, suspend }) =>
      await runM2Phase(
        slots.multiviewConcepts,
        inputData,
        suspend,
        M2_GRAPH_SLOTS.multiviewConcepts,
        inputData.projectId,
        inputData.assetId,
      ),
  });
  const production = createStep({
    id: M2_GRAPH_SLOTS.assetProduction,
    inputSchema: MultiviewNodeOutputSchema,
    outputSchema: AssetProductionNodeOutputSchema,
    suspendSchema: MacroGraphSuspendSchema,
    resumeSchema: MacroGraphResumeSchema,
    execute: async ({ inputData, suspend }) =>
      await runM2Phase(
        slots.assetProduction,
        inputData,
        suspend,
        M2_GRAPH_SLOTS.assetProduction,
        inputData.projectId,
        inputData.assetId,
      ),
  });
  const qa = createStep({
    id: M2_GRAPH_SLOTS.deterministicQa,
    inputSchema: AssetProductionNodeOutputSchema,
    outputSchema: DeterministicQaNodeOutputSchema,
    suspendSchema: MacroGraphSuspendSchema,
    resumeSchema: MacroGraphResumeSchema,
    execute: async ({ inputData, suspend }) =>
      await runM2Phase(
        slots.deterministicQa,
        inputData,
        suspend,
        M2_GRAPH_SLOTS.deterministicQa,
        inputData.projectId,
        inputData.assetId,
      ),
  });
  const turntable = createStep({
    id: M2_GRAPH_SLOTS.turntableEvaluation,
    inputSchema: DeterministicQaNodeOutputSchema,
    outputSchema: TurntableEvaluationNodeOutputSchema,
    suspendSchema: MacroGraphSuspendSchema,
    resumeSchema: MacroGraphResumeSchema,
    execute: async ({ inputData, suspend }) =>
      await runM2Phase(
        slots.turntableEvaluation,
        inputData,
        suspend,
        M2_GRAPH_SLOTS.turntableEvaluation,
        inputData.projectId,
        inputData.assetId,
      ),
  });
  const regeneration = createStep({
    id: M2_GRAPH_SLOTS.regeneration,
    inputSchema: TurntableEvaluationNodeOutputSchema,
    outputSchema: RegenerationNodeOutputSchema,
    suspendSchema: MacroGraphSuspendSchema,
    resumeSchema: MacroGraphResumeSchema,
    execute: async ({ inputData, suspend }) =>
      await runM2Phase(
        slots.regeneration,
        inputData,
        suspend,
        M2_GRAPH_SLOTS.regeneration,
        inputData.projectId,
        inputData.assetId,
      ),
  });
  return createWorkflow({
    id: "m2-asset-path",
    inputSchema: AssetPathBaseSchema,
    outputSchema: RegenerationNodeOutputSchema,
  })
    .then(multiview)
    .then(production)
    .then(qa)
    .then(turntable)
    .then(regeneration)
    .commit();
};

const createM2AssetIteration = (slots: M2MacroGraphSlots) =>
  createStep({
    id: M2_GRAPH_SLOTS.multiviewConcepts,
    inputSchema: AssetPathBaseSchema,
    outputSchema: RegenerationNodeOutputSchema,
    suspendSchema: MacroGraphSuspendSchema,
    resumeSchema: MacroGraphResumeSchema,
    execute: async ({ inputData, suspend }) => {
      const multiview = await runM2Phase(
        slots.multiviewConcepts,
        inputData,
        suspend,
        M2_GRAPH_SLOTS.multiviewConcepts,
        inputData.projectId,
        inputData.assetId,
      );
      const produced = await runM2Phase(
        slots.assetProduction,
        multiview,
        suspend,
        M2_GRAPH_SLOTS.assetProduction,
        inputData.projectId,
        inputData.assetId,
      );
      const deterministic = await runM2Phase(
        slots.deterministicQa,
        produced,
        suspend,
        M2_GRAPH_SLOTS.deterministicQa,
        inputData.projectId,
        inputData.assetId,
      );
      const semantic = await runM2Phase(
        slots.turntableEvaluation,
        deterministic,
        suspend,
        M2_GRAPH_SLOTS.turntableEvaluation,
        inputData.projectId,
        inputData.assetId,
      );
      return await runM2Phase(
        slots.regeneration,
        semantic,
        suspend,
        M2_GRAPH_SLOTS.regeneration,
        inputData.projectId,
        inputData.assetId,
      );
    },
  });

const createM2Batch = (
  repository: ProjectRepository,
  slots: M2MacroGraphSlots,
  iterationMode: "named-workflow" | "single-step" = "named-workflow",
) => {
  const planning = createStep({
    id: M2_GRAPH_SLOTS.assetPlanning,
    inputSchema: RoutedInputSchema,
    outputSchema: PlanningRuntimeSchema,
    suspendSchema: MacroGraphSuspendSchema,
    resumeSchema: MacroGraphResumeSchema,
    execute: async ({ inputData, suspend }) => {
      const result = await runM2Phase(
        slots.assetPlanning,
        { projectId: inputData.projectId },
        suspend,
        M2_GRAPH_SLOTS.assetPlanning,
        inputData.projectId,
      );
      const state = repository.getProject(inputData.projectId);
      if (state.stage === "asset-planning")
        repository.commitWorkflowCheckpoint({
          projectId: state.projectId,
          runId: state.runId,
          checkpointKey: `${M2_GRAPH_SLOTS.assetPlanning}:${state.conceptSet?.revisionId ?? "missing"}`,
          expectedStage: "asset-planning",
          nextState: {
            ...state,
            assetPlan: result.assetPlan,
            status: "awaiting-approval",
            stage: "asset-plan-approval",
          },
          event: {
            type: "workflow.node.completed",
            payload: {
              nodeId: M2_GRAPH_SLOTS.assetPlanning,
              stage: "asset-plan-approval",
              inputRevisionIds: [
                state.conceptSet?.revisionId,
                state.gameDesignSpec?.revisionId,
                state.visualDirectionSet?.revisionId,
              ].filter((value): value is string => Boolean(value)),
              outputRevisionIds: [result.assetPlan.revisionId],
            },
          },
        });
      return { ...inputData, ...result };
    },
  });
  const approval = createStep({
    id: M2_GRAPH_SLOTS.assetPlanApproval,
    inputSchema: PlanningRuntimeSchema,
    outputSchema: PlanningRuntimeSchema,
    suspendSchema: MacroGraphSuspendSchema,
    resumeSchema: MacroGraphResumeSchema,
    execute: async ({ inputData, suspend }) => {
      const state = repository.getProject(inputData.projectId);
      const decision = state.assetPlanApproval;
      if (
        decision?.decision === "approved" &&
        decision.targetRevisionId === inputData.assetPlan.revisionId &&
        decision.targetSha256 === inputData.assetPlan.artifact.sha256
      ) {
        if (state.stage === "asset-plan-approval")
          repository.commitWorkflowCheckpoint({
            projectId: state.projectId,
            runId: state.runId,
            checkpointKey: `${M2_GRAPH_SLOTS.assetPlanApproval}:${decision.approvalId}`,
            expectedStage: "asset-plan-approval",
            nextState: { ...state, status: "active", stage: "asset-batch" },
            event: {
              type: "workflow.node.completed",
              payload: {
                nodeId: M2_GRAPH_SLOTS.assetPlanApproval,
                stage: "asset-batch",
                inputRevisionIds: [inputData.assetPlan.revisionId],
                outputRevisionIds: [],
              },
            },
          });
        return inputData;
      }
      if (decision)
        return failed({
          code: "asset-plan-not-approved",
          message:
            "The current asset plan does not have an exact approved decision.",
          kind: "user-action-required",
          evidenceRevisionIds: [inputData.assetPlan.revisionId],
        });
      const checkpointKey = `${M2_GRAPH_SLOTS.assetPlanApproval}:${inputData.assetPlan.revisionId}`;
      repository.appendWorkflowEvent({
        projectId: state.projectId,
        runId: state.runId,
        type: "workflow.node.suspended",
        payload: {
          checkpointKey,
          nodeId: M2_GRAPH_SLOTS.assetPlanApproval,
          stage: state.stage,
        },
      });
      return suspend({
        projectId: state.projectId,
        nodeId: M2_GRAPH_SLOTS.assetPlanApproval,
        reason: "approval-required",
      });
    },
  });
  const expand = createStep({
    id: M2_GRAPH_SLOTS.expandAssetPaths,
    inputSchema: PlanningRuntimeSchema,
    outputSchema: z.array(AssetPathBaseSchema).min(1),
    execute: async ({ inputData }) =>
      inputData.orderedAssetIds.map((assetId) => ({
        projectId: inputData.projectId,
        assetPlan: inputData.assetPlan,
        assetId,
      })),
  });
  const assetPath =
    iterationMode === "single-step"
      ? createM2AssetIteration(slots)
      : (createM2AssetPath(slots) as unknown as Step<
          "m2-asset-path",
          unknown,
          z.infer<typeof AssetPathBaseSchema>,
          z.infer<typeof RegenerationNodeOutputSchema>,
          unknown,
          unknown
        >);
  const aggregate = createStep({
    id: M2_GRAPH_SLOTS.assetBatchAggregation,
    inputSchema: z.array(RegenerationNodeOutputSchema).min(1),
    outputSchema: BatchRuntimeSchema,
    execute: async ({ inputData }) => {
      const first = inputData[0]!;
      const validHero = inputData.some(
        ({ classification, validated }) =>
          classification === "hero" && validated,
      );
      if (!validHero)
        return failed({
          code: "validated-hero-required",
          message:
            "The asset batch cannot complete without a validated hero asset.",
          kind: "policy-blocked",
          evidenceRevisionIds: inputData.map(
            ({ bestAsset }) => bestAsset.revisionId,
          ),
        });
      const state = repository.getProject(first.projectId);
      const assetBatch = Object.fromEntries(
        inputData.map((asset) => {
          if (!asset.classification)
            return failed({
              code: "asset-classification-missing",
              message: `Asset ${asset.assetId} has no classification.`,
              kind: "terminal",
              evidenceRevisionIds: [asset.bestAsset.revisionId],
            });
          return [
            asset.assetId,
            {
              assetId: asset.assetId,
              classification: asset.classification,
              current: asset.candidateAsset,
              best: asset.bestAsset,
              attemptCount: asset.attemptCount,
              validated: asset.validated,
              deterministicReport: asset.finalDeterministicReport,
              ...(asset.turntable ? { turntable: asset.turntable } : {}),
              semanticReport: asset.finalSemanticReport,
              ...(asset.decision ? { decision: asset.decision } : {}),
              ...(asset.multiviewConceptSet
                ? { multiviewConceptSet: asset.multiviewConceptSet }
                : {}),
            },
          ];
        }),
      );
      if (state.stage === "asset-batch")
        repository.commitWorkflowCheckpoint({
          projectId: state.projectId,
          runId: state.runId,
          checkpointKey: `${M2_GRAPH_SLOTS.assetBatchAggregation}:${first.assetPlan.revisionId}`,
          expectedStage: "asset-batch",
          nextState: { ...state, assetBatch },
          event: {
            type: "workflow.node.completed",
            payload: {
              nodeId: M2_GRAPH_SLOTS.assetBatchAggregation,
              stage: "asset-batch",
              inputRevisionIds: inputData.map(
                ({ bestAsset }) => bestAsset.revisionId,
              ),
              outputRevisionIds: [],
            },
          },
        });
      return {
        projectId: first.projectId,
        assetPlan: first.assetPlan,
        assets: inputData,
      };
    },
  });
  const complete = createStep({
    id: M2_GRAPH_SLOTS.complete,
    inputSchema: BatchRuntimeSchema,
    outputSchema: MacroGraphOutputSchema,
    execute: async ({ inputData }) => {
      const state = repository.getProject(inputData.projectId);
      const committed = repository.commitWorkflowCheckpoint({
        projectId: state.projectId,
        runId: state.runId,
        checkpointKey: `${M2_GRAPH_SLOTS.complete}:${inputData.assetPlan.revisionId}`,
        expectedStage: "asset-batch",
        nextState: { ...state, status: "complete", stage: "complete" },
        event: {
          type: "workflow.node.completed",
          payload: {
            nodeId: M2_GRAPH_SLOTS.complete,
            stage: "complete",
            inputRevisionIds: [inputData.assetPlan.revisionId],
            outputRevisionIds: [],
          },
        },
      });
      return {
        projectId: inputData.projectId,
        milestone: "m2" as const,
        terminalStage: committed.state.stage,
      };
    },
  });
  return createWorkflow({
    id: "m2-batch",
    inputSchema: RoutedInputSchema,
    outputSchema: MacroGraphOutputSchema,
  })
    .then(planning)
    .then(approval)
    .then(expand)
    .foreach(assetPath, {
      concurrency: ({ getInitData }) =>
        MacroGraphInputSchema.parse(getInitData()).maxConcurrency,
    })
    .then(aggregate)
    .then(complete)
    .commit();
};

export const createPostConceptWorkflow = (
  repository: ProjectRepository,
  options: {
    operations?: PostConceptOperations;
    slots?: M2MacroGraphSlots;
  } = {},
) => {
  const operations =
    options.operations ?? new PostConceptOperations(repository);
  const slots = options.slots ?? unavailableM2MacroGraphSlots();
  const route = createStep({
    id: "post-concept.route",
    inputSchema: MacroGraphInputSchema,
    outputSchema: RoutedInputSchema,
    execute: async ({ inputData }) => {
      const state = repository.getProject(inputData.projectId);
      if (state.milestone !== "m0" && state.milestone !== "m2")
        throw new Error(
          `Project ${state.projectId} has no post-concept graph.`,
        );
      return { ...inputData, milestone: state.milestone };
    },
  });
  const m0 = createM0Tail(operations);
  const m2 = createM2Batch(repository, slots);
  const m0Branch = m0 as unknown as Step<
    "m0-tail",
    unknown,
    z.infer<typeof RoutedInputSchema>,
    z.infer<typeof MacroGraphOutputSchema>,
    unknown,
    unknown
  >;
  const m2Branch = m2 as unknown as Step<
    "m2-batch",
    unknown,
    z.infer<typeof RoutedInputSchema>,
    z.infer<typeof MacroGraphOutputSchema>,
    unknown,
    unknown
  >;
  const finish = createStep({
    id: "post-concept.finish",
    inputSchema: z.unknown(),
    outputSchema: MacroGraphOutputSchema,
    execute: async ({ getInitData }) => {
      const input = MacroGraphInputSchema.parse(getInitData());
      const state = repository.getProject(input.projectId);
      if (state.milestone !== "m0" && state.milestone !== "m2")
        throw new Error(
          `Project ${state.projectId} has no post-concept graph.`,
        );
      return {
        projectId: state.projectId,
        milestone: state.milestone,
        terminalStage: state.stage,
      };
    },
  });
  return createWorkflow({
    id: "post-concept",
    inputSchema: MacroGraphInputSchema,
    outputSchema: MacroGraphOutputSchema,
  })
    .then(route)
    .branch([
      [async ({ inputData }) => inputData.milestone === "m0", m0Branch],
      [async ({ inputData }) => inputData.milestone === "m2", m2Branch],
    ])
    .then(finish)
    .commit();
};

type PostConceptRun = Awaited<
  ReturnType<ReturnType<typeof createPostConceptWorkflow>["createRun"]>
>;

const failureFromUnknown = (error: unknown): WorkflowFailure => {
  const candidates: unknown[] = [error];
  const seen = new Set<unknown>();
  while (candidates.length > 0) {
    const candidate = candidates.shift();
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (candidate instanceof WorkflowNodeFailure) return candidate.failure;
    if (typeof candidate === "string") {
      const marker = "FULCRUM_WORKFLOW_FAILURE:";
      const index = candidate.indexOf(marker);
      if (index >= 0) {
        try {
          return JSON.parse(
            candidate.slice(index + marker.length),
          ) as WorkflowFailure;
        } catch {}
      }
      continue;
    }
    if (candidate && typeof candidate === "object") {
      const record = candidate as Record<string, unknown>;
      if (
        typeof record.code === "string" &&
        typeof record.message === "string" &&
        typeof record.kind === "string"
      )
        return record as WorkflowFailure;
      candidates.push(
        record.failure,
        record.error,
        record.cause,
        record.message,
        record.stack,
      );
    }
  }
  return {
    code: "workflow-run-failed",
    message: error instanceof Error ? error.message : String(error),
    kind: "terminal",
    evidenceRevisionIds: [],
  };
};

const nodeForStage = (
  stage: z.infer<typeof MacroGraphOutputSchema>["terminalStage"],
): z.infer<typeof MacroGraphSuspendSchema>["nodeId"] => {
  const nodes: Partial<
    Record<
      z.infer<typeof MacroGraphOutputSchema>["terminalStage"],
      z.infer<typeof MacroGraphSuspendSchema>["nodeId"]
    >
  > = {
    "asset-production": "m0.asset-production",
    "asset-quality": "m0.asset-quality",
    "scene-composition": "m0.scene-composition",
    "asset-planning": "m2.asset-planning",
    "asset-plan-approval": "m2.asset-plan-approval",
    "asset-batch": "m2.asset-batch-aggregation",
  };
  return nodes[stage] ?? "post-concept.route";
};

export class PostConceptGraphDriver {
  private readonly workflow;
  private readonly m2Workflow;
  private readonly assetOrder = new Map<string, string[]>();
  private readonly activeRuns = new Map<
    string,
    { workflowRunId: string; run: PostConceptRun; forEachIndex?: number }
  >();
  private readonly inFlight = new Map<string, Promise<ProjectSnapshot>>();

  constructor(
    readonly repository: ProjectRepository,
    options: {
      operations?: PostConceptOperations;
      slots?: M2MacroGraphSlots;
    } = {},
  ) {
    const sourceSlots = options.slots ?? unavailableM2MacroGraphSlots();
    const slots: M2MacroGraphSlots = {
      ...sourceSlots,
      assetPlanning: {
        ensure: async (input) => {
          const outcome = await sourceSlots.assetPlanning.ensure(input);
          if (outcome.status === "ready")
            this.assetOrder.set(input.projectId, outcome.value.orderedAssetIds);
          return outcome;
        },
      },
    };
    this.workflow = createPostConceptWorkflow(repository, {
      ...options,
      slots,
    });
    this.m2Workflow = createM2Batch(repository, slots, "single-step");
    new Mastra({
      storage: new InMemoryStore({ id: `post-concept-${randomUUID()}` }),
      workflows: { postConcept: this.workflow, m2Batch: this.m2Workflow },
    });
  }

  advance(
    projectId: string,
    trigger: z.infer<typeof MacroGraphResumeSchema>["trigger"] = "http-poll",
  ): Promise<ProjectSnapshot> {
    const current = this.inFlight.get(projectId);
    if (current) return current;
    let promise!: Promise<ProjectSnapshot>;
    promise = this.run(projectId, trigger).finally(() => {
      if (this.inFlight.get(projectId) === promise)
        this.inFlight.delete(projectId);
    });
    this.inFlight.set(projectId, promise);
    return promise;
  }

  private async run(
    projectId: string,
    trigger: z.infer<typeof MacroGraphResumeSchema>["trigger"],
  ): Promise<ProjectSnapshot> {
    let state = this.repository.getProject(projectId);
    if (state.milestone !== "m0" && state.milestone !== "m2")
      throw new Error(`Project ${projectId} has no post-concept graph.`);
    if (state.status === "blocked" || state.status === "complete")
      return this.snapshot(projectId);
    if (state.status === "awaiting-approval" && trigger === "http-poll")
      return this.snapshot(projectId);

    let active = this.activeRuns.get(projectId);
    let result;
    if (active && active.workflowRunId === state.workflowRunId) {
      result = await active.run.resume({
        resumeData: { trigger },
        ...(active.forEachIndex !== undefined
          ? { forEachIndex: active.forEachIndex }
          : {}),
      });
    } else {
      const previousWorkflowRunId = state.workflowRunId;
      const workflowRunId = randomUUID();
      if (previousWorkflowRunId)
        this.repository.appendWorkflowEvent({
          projectId,
          runId: state.runId,
          type: "workflow.run.reconstructed",
          payload: {
            checkpointKey: `post-concept.reconstructed:${previousWorkflowRunId}`,
            nodeId: "post-concept.route",
            stage: state.stage,
            previousWorkflowRunId,
            workflowRunId,
          },
        });
      state = this.repository.saveProject({ ...state, workflowRunId });
      const workflow =
        state.milestone === "m2" ? this.m2Workflow : this.workflow;
      const run = (await workflow.createRun({
        runId: workflowRunId,
        resourceId: projectId,
      })) as unknown as PostConceptRun;
      active = { workflowRunId, run };
      this.activeRuns.set(projectId, active);
      result = await run.start({
        inputData: {
          projectId,
          maxConcurrency:
            state.maxConcurrentExternalJobs ??
            (state.milestone === "m2" ? 2 : 1),
          ...(state.milestone === "m2" ? { milestone: "m2" as const } : {}),
        },
      });
    }

    if (result.status === "failed") {
      const failure = failureFromUnknown(result.error);
      const currentState = this.repository.getProject(projectId);
      const nodeId = nodeForStage(currentState.stage);
      const prior = this.repository.listEvents(projectId).at(-1);
      if (
        prior?.type !== "workflow.node.failed" ||
        prior.payload.code !== failure.code
      )
        this.repository.appendWorkflowEvent({
          projectId,
          runId: currentState.runId,
          type: "workflow.node.failed",
          payload: {
            checkpointKey: `${nodeId}:failed:${failure.code}`,
            nodeId,
            stage: currentState.stage,
            code: failure.code,
            kind: failure.kind,
            evidenceRevisionIds: failure.evidenceRevisionIds,
          },
        });
      this.repository.saveProject({
        ...currentState,
        status: "blocked",
        stage: "blocked",
        blockedReason: {
          code: failure.code,
          message: failure.message,
          recoverable:
            failure.kind === "retryable" ||
            failure.kind === "user-action-required",
          failureKind: failure.kind,
        },
      });
      this.activeRuns.delete(projectId);
    } else if (result.status === "suspended") {
      const assetId =
        result.suspendPayload &&
        typeof result.suspendPayload === "object" &&
        "assetId" in result.suspendPayload &&
        typeof result.suspendPayload.assetId === "string"
          ? result.suspendPayload.assetId
          : undefined;
      if (assetId && active) {
        const index = this.assetOrder.get(projectId)?.indexOf(assetId) ?? -1;
        if (index >= 0) active.forEachIndex = index;
      }
    } else {
      this.activeRuns.delete(projectId);
    }
    return this.snapshot(projectId);
  }

  private snapshot(projectId: string): ProjectSnapshot {
    const state = this.repository.getProject(projectId);
    const brief = this.repository.resolveRevision<{ text?: string }>(
      state.brief,
    );
    return ProjectSnapshotSchema.parse({
      state,
      briefText: brief.text ?? "",
      ...(state.milestone === "m0" && state.visualBible
        ? { visualBible: this.repository.resolveRevision(state.visualBible) }
        : {}),
      ...(state.milestone === "m0" && state.concept
        ? { concept: this.repository.resolveRevision(state.concept) }
        : {}),
      ...(state.asset
        ? { asset: this.repository.resolveRevision(state.asset) }
        : {}),
      ...(state.assetEvaluation
        ? {
            assetEvaluation: this.repository.resolveRevision(
              state.assetEvaluation,
            ),
          }
        : {}),
      ...(state.scene
        ? { scene: this.repository.resolveRevision(state.scene) }
        : {}),
    });
  }
}
