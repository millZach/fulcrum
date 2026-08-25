import {
  AssetPathBaseSchema,
  AssetPlanSchema,
  AssetPlanningInputSchema,
  AssetPlanningNodeInputSchema,
  AssetPlanningNodeOutputSchema,
  AssetProductionNodeOutputSchema,
  DeterministicQaNodeOutputSchema,
  MacroGraphSuspendSchema,
  MultiviewNodeOutputSchema,
  RegenerationNodeOutputSchema,
  TurntableEvaluationNodeOutputSchema,
  type MacroGraphSuspend,
  type MacroPhase,
  type ProjectState,
  type WorkflowFailure,
} from "@fulcrum/domain";
import type { z } from "zod";
import {
  AssetPlanner,
  AssetProduction,
  AssetQuality,
  type AssetPlanning,
} from "@fulcrum/production";
import { ProjectRepository } from "@fulcrum/project";
import { SceneAuthoring } from "@fulcrum/scene";

export type PostConceptOperationOutcome =
  | { status: "ready"; state: ProjectState }
  | { status: "suspended"; suspend: MacroGraphSuspend }
  | { status: "failed"; error: WorkflowFailure };

export type PostConceptOperationPorts = {
  assetProduction?: Pick<AssetProduction, "ensure">;
  assetQuality?: Pick<AssetQuality, "evaluate">;
  sceneAuthoring?: Pick<SceneAuthoring, "compose">;
};

export interface M2MacroGraphSlots {
  assetPlanning: MacroPhase<
    z.infer<typeof AssetPlanningNodeInputSchema>,
    z.infer<typeof AssetPlanningNodeOutputSchema>
  >;
  multiviewConcepts: MacroPhase<
    z.infer<typeof AssetPathBaseSchema>,
    z.infer<typeof MultiviewNodeOutputSchema>
  >;
  assetProduction: MacroPhase<
    z.infer<typeof MultiviewNodeOutputSchema>,
    z.infer<typeof AssetProductionNodeOutputSchema>
  >;
  deterministicQa: MacroPhase<
    z.infer<typeof AssetProductionNodeOutputSchema>,
    z.infer<typeof DeterministicQaNodeOutputSchema>
  >;
  turntableEvaluation: MacroPhase<
    z.infer<typeof DeterministicQaNodeOutputSchema>,
    z.infer<typeof TurntableEvaluationNodeOutputSchema>
  >;
  regeneration: MacroPhase<
    z.infer<typeof TurntableEvaluationNodeOutputSchema>,
    z.infer<typeof RegenerationNodeOutputSchema>
  >;
}

const unavailable = <I, O>(slot: string): MacroPhase<I, O> => ({
  ensure: async () => ({
    status: "failed",
    error: {
      code: `${slot}-unavailable`,
      message:
        slot === "asset-planner"
          ? "No M2 asset planner is configured. Install the S2 planner before advancing this project."
          : `No M2 ${slot} adapter is configured.`,
      kind: "user-action-required",
      evidenceRevisionIds: [],
    },
  }),
});

export const unavailableM2MacroGraphSlots = (): M2MacroGraphSlots => ({
  assetPlanning: unavailable("asset-planner"),
  multiviewConcepts: unavailable("multiview-concepts"),
  assetProduction: unavailable("asset-production"),
  deterministicQa: unavailable("deterministic-qa"),
  turntableEvaluation: unavailable("turntable-evaluation"),
  regeneration: unavailable("regeneration"),
});

export const createM2MacroGraphSlots = (
  repository: ProjectRepository,
  planner: AssetPlanning = new AssetPlanner(repository),
): M2MacroGraphSlots => ({
  ...unavailableM2MacroGraphSlots(),
  assetPlanning: {
    ensure: async ({ projectId }) => {
      const state = repository.getProject(projectId);
      const parsed = AssetPlanningInputSchema.safeParse({
        projectId,
        runId: state.runId,
        mode: state.mode,
        orchestratorProvider: state.orchestratorProvider,
        gameDesignSpec:
          state.gameDesignSpec && state.gameDesignApproval
            ? {
                revision: state.gameDesignSpec,
                approval: state.gameDesignApproval,
              }
            : undefined,
        conceptSet:
          state.conceptSet && state.conceptSetApproval
            ? {
                revision: state.conceptSet,
                approval: state.conceptSetApproval,
              }
            : undefined,
        ...(state.assetPlan &&
        state.assetPlanApproval?.decision === "changes-requested"
          ? {
              replan: {
                previousPlan: state.assetPlan,
                decision: state.assetPlanApproval,
              },
            }
          : {}),
      });
      if (!parsed.success)
        return {
          status: "failed" as const,
          error: {
            code: "asset-plan-invalid-input",
            message:
              "Asset planning requires exact approved Game Design Spec and concept-set revisions.",
            kind: "user-action-required" as const,
            evidenceRevisionIds: [
              state.gameDesignSpec?.revisionId,
              state.conceptSet?.revisionId,
            ].filter((value): value is string => Boolean(value)),
          },
        };
      const outcome = await planner.plan(parsed.data);
      if (outcome.status === "failed")
        return {
          status: "failed" as const,
          error: {
            code: outcome.error.code,
            message: outcome.error.message,
            kind: outcome.error.kind,
            evidenceRevisionIds: [
              state.gameDesignSpec?.revisionId,
              state.conceptSet?.revisionId,
              state.assetPlan?.revisionId,
            ].filter((value): value is string => Boolean(value)),
          },
        };
      const plan = AssetPlanSchema.parse(
        repository.resolveRevision(outcome.value),
      );
      return {
        status: "ready" as const,
        value: {
          projectId,
          assetPlan: outcome.value,
          orderedAssetIds: plan.assets.map((asset) => asset.assetId),
        },
      };
    },
  },
});

const laterThanProduction = new Set<ProjectState["stage"]>([
  "asset-quality",
  "scene-composition",
  "visual-slice-approval",
  "complete",
  "blocked",
]);
const laterThanQuality = new Set<ProjectState["stage"]>([
  "scene-composition",
  "visual-slice-approval",
  "complete",
  "blocked",
]);
const laterThanScene = new Set<ProjectState["stage"]>([
  "visual-slice-approval",
  "complete",
  "blocked",
]);

export class PostConceptOperations {
  private readonly assets: Pick<AssetProduction, "ensure">;
  private readonly quality: Pick<AssetQuality, "evaluate">;
  private readonly scenes: Pick<SceneAuthoring, "compose">;

  constructor(
    readonly repository: ProjectRepository,
    ports: PostConceptOperationPorts = {},
  ) {
    this.assets = ports.assetProduction ?? new AssetProduction(repository);
    this.quality = ports.assetQuality ?? new AssetQuality(repository);
    this.scenes = ports.sceneAuthoring ?? new SceneAuthoring(repository);
  }

  async assetProduction(
    projectId: string,
  ): Promise<PostConceptOperationOutcome> {
    const state = this.requireM0(projectId);
    if (laterThanProduction.has(state.stage)) return { status: "ready", state };
    const nodeId = "m0.asset-production" as const;
    const checkpointKey = `${nodeId}:${state.concept?.revisionId ?? "missing"}`;
    if (state.stage !== "asset-production" || !state.concept)
      return this.fail(state, checkpointKey, nodeId, {
        code: "missing-concept",
        message: "Asset production has no approved concept.",
        kind: "terminal",
        evidenceRevisionIds: [],
      });
    this.enter(state, checkpointKey, nodeId);
    const outcome = await this.assets.ensure({
      projectId,
      runId: state.runId,
      mode: state.mode,
      assetProvider: state.assetProvider,
      concept: state.concept,
    });
    if (outcome.status === "failed")
      return this.fail(state, checkpointKey, nodeId, {
        code: outcome.error.code,
        message: outcome.error.message,
        kind: outcome.error.recoverable ? "retryable" : "terminal",
        evidenceRevisionIds: [state.concept.revisionId],
      });
    if (outcome.status === "pending") {
      const suspend = MacroGraphSuspendSchema.parse({
        projectId,
        nodeId,
        reason: "provider-pending",
        requestId: outcome.requestId,
        resumeAfter: outcome.resumeAfter,
      });
      this.repository.appendWorkflowEvent({
        projectId,
        runId: state.runId,
        type: "workflow.node.suspended",
        payload: {
          checkpointKey,
          nodeId,
          stage: state.stage,
          requestId: outcome.requestId,
          resumeAfter: outcome.resumeAfter,
        },
      });
      return { status: "suspended", suspend };
    }
    const latest = this.repository.getProject(projectId);
    const committed = this.repository.commitWorkflowCheckpoint({
      projectId,
      runId: state.runId,
      checkpointKey,
      expectedStage: "asset-production",
      nextState: {
        ...latest,
        asset: outcome.value,
        stage: "asset-quality",
      },
      event: {
        type: "workflow.node.completed",
        payload: {
          nodeId,
          stage: "asset-quality",
          inputRevisionIds: [state.concept.revisionId],
          outputRevisionIds: [outcome.value.revisionId],
        },
      },
    });
    return { status: "ready", state: committed.state };
  }

  async assetQuality(projectId: string): Promise<PostConceptOperationOutcome> {
    const state = this.requireM0(projectId);
    if (laterThanQuality.has(state.stage)) return { status: "ready", state };
    const nodeId = "m0.asset-quality" as const;
    const checkpointKey = `${nodeId}:${state.asset?.revisionId ?? "missing"}`;
    if (state.stage !== "asset-quality" || !state.asset)
      return this.fail(state, checkpointKey, nodeId, {
        code: "missing-asset",
        message: "Asset quality has no GLB revision.",
        kind: "terminal",
        evidenceRevisionIds: [],
      });
    this.enter(state, checkpointKey, nodeId);
    const result = await this.quality.evaluate({
      projectId,
      runId: state.runId,
      asset: state.asset,
    });
    const nextState = result.evaluation.passed
      ? {
          ...state,
          assetEvaluation: result.revision,
          stage: "scene-composition" as const,
        }
      : {
          ...state,
          assetEvaluation: result.revision,
          status: "blocked" as const,
          stage: "blocked" as const,
          blockedReason: {
            code: "asset-quality-failed",
            message: "The generated GLB failed deterministic M0 gates.",
            recoverable: true,
            failureKind: "policy-blocked" as const,
          },
        };
    const committed = this.repository.commitWorkflowCheckpoint({
      projectId,
      runId: state.runId,
      checkpointKey,
      expectedStage: "asset-quality",
      nextState,
      event: {
        type: "workflow.node.completed",
        payload: {
          nodeId,
          stage: nextState.stage,
          inputRevisionIds: [state.asset.revisionId],
          outputRevisionIds: [result.revision.revisionId],
        },
      },
    });
    return { status: "ready", state: committed.state };
  }

  async sceneComposition(
    projectId: string,
  ): Promise<PostConceptOperationOutcome> {
    const state = this.requireM0(projectId);
    if (laterThanScene.has(state.stage)) return { status: "ready", state };
    const nodeId = "m0.scene-composition" as const;
    const checkpointKey = `${nodeId}:${state.asset?.revisionId ?? "missing"}:${state.visualBible?.revisionId ?? "missing"}`;
    if (
      state.stage !== "scene-composition" ||
      !state.asset ||
      !state.visualBible
    )
      return this.fail(state, checkpointKey, nodeId, {
        code: "missing-scene-input",
        message: "Scene composition is missing its asset or visual bible.",
        kind: "terminal",
        evidenceRevisionIds: [],
      });
    this.enter(state, checkpointKey, nodeId);
    const result = this.scenes.compose({
      projectId,
      runId: state.runId,
      asset: state.asset,
      visualBible: state.visualBible,
    });
    const committed = this.repository.commitWorkflowCheckpoint({
      projectId,
      runId: state.runId,
      checkpointKey,
      expectedStage: "scene-composition",
      nextState: {
        ...state,
        scene: result.revision,
        status: "awaiting-approval",
        stage: "visual-slice-approval",
      },
      event: {
        type: "workflow.node.completed",
        payload: {
          nodeId,
          stage: "visual-slice-approval",
          inputRevisionIds: [
            state.asset.revisionId,
            state.visualBible.revisionId,
          ],
          outputRevisionIds: [result.revision.revisionId],
        },
      },
    });
    return { status: "ready", state: committed.state };
  }

  private requireM0(projectId: string): ProjectState {
    const state = this.repository.getProject(projectId);
    if (state.milestone !== "m0")
      throw new Error(`Project ${projectId} is not an M0 project.`);
    return state;
  }

  private enter(
    state: ProjectState,
    checkpointKey: string,
    nodeId: "m0.asset-production" | "m0.asset-quality" | "m0.scene-composition",
  ): void {
    this.repository.appendWorkflowEvent({
      projectId: state.projectId,
      runId: state.runId,
      type: "workflow.node.entered",
      payload: { checkpointKey, nodeId, stage: state.stage },
    });
  }

  private fail(
    state: ProjectState,
    checkpointKey: string,
    nodeId: "m0.asset-production" | "m0.asset-quality" | "m0.scene-composition",
    error: WorkflowFailure,
  ): PostConceptOperationOutcome {
    this.repository.appendWorkflowEvent({
      projectId: state.projectId,
      runId: state.runId,
      type: "workflow.node.failed",
      payload: {
        checkpointKey,
        nodeId,
        stage: state.stage,
        code: error.code,
        kind: error.kind,
        evidenceRevisionIds: error.evidenceRevisionIds,
      },
    });
    return { status: "failed", error };
  }
}
