import {
  AssetPathBaseSchema,
  AssetPlanSchema,
  AssetPolicySchema,
  AssetPlanningInputSchema,
  AssetPlanningNodeInputSchema,
  AssetPlanningNodeOutputSchema,
  AssetProductionNodeOutputSchema,
  ConceptDocumentSchema,
  DeterministicAssetReportSchema,
  DeterministicQaNodeOutputSchema,
  MacroGraphSuspendSchema,
  MultiviewNodeOutputSchema,
  RegenerationAttemptSchema,
  RegenerationNodeOutputSchema,
  SemanticAssetReportSchema,
  TurntableEvaluationNodeOutputSchema,
  handlingForPlannedAsset,
  type AssetClassification,
  type AssetPolicy,
  type MacroGraphSuspend,
  type MacroPhase,
  type ProjectState,
  type RegenerationAttempt,
  type RevisionRef,
  type WorkflowFailure,
} from "@fulcrum/domain";
import type { z } from "zod";
import {
  AssetPlanner,
  AssetProduction,
  AssetQuality,
  AssetQualityFailure,
  DEFAULT_ASSET_POLICIES,
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

export type M2MacroGraphSlotOptions = {
  assetProduction?: Pick<AssetProduction, "ensure" | "ensureMultiviewConcepts">;
  assetQuality?: Pick<
    AssetQuality,
    "inspect" | "ensureSemantic" | "selectRegeneration"
  >;
};

const slotFailure = (
  code: string,
  message: string,
  kind: WorkflowFailure["kind"],
  evidenceRevisionIds: string[],
): { status: "failed"; error: WorkflowFailure } => ({
  status: "failed",
  error: { code, message, kind, evidenceRevisionIds },
});

const qualityFailure = (
  error: unknown,
  evidenceRevisionIds: string[],
): { status: "failed"; error: WorkflowFailure } =>
  error instanceof AssetQualityFailure
    ? slotFailure(
        error.code,
        error.message,
        error.failureKind,
        evidenceRevisionIds,
      )
    : slotFailure(
        "asset-quality-failed",
        error instanceof Error ? error.message : String(error),
        "terminal",
        evidenceRevisionIds,
      );

const productionFailure = (
  error: {
    code: string;
    message: string;
    recoverable: boolean;
    failureKind?: WorkflowFailure["kind"] | undefined;
  },
  evidenceRevisionIds: string[],
): { status: "failed"; error: WorkflowFailure } =>
  slotFailure(
    error.code,
    error.message,
    error.failureKind ?? (error.recoverable ? "retryable" : "terminal"),
    evidenceRevisionIds,
  );

export const createM2MacroGraphSlots = (
  repository: ProjectRepository,
  planner: AssetPlanning = new AssetPlanner(repository),
  options: M2MacroGraphSlotOptions = {},
): M2MacroGraphSlots => {
  const assets = options.assetProduction ?? new AssetProduction(repository);
  const quality = options.assetQuality ?? new AssetQuality(repository);

  const planned = (input: { assetPlan: RevisionRef; assetId: string }) => {
    const plan = AssetPlanSchema.parse(
      repository.resolveRevision(input.assetPlan),
    );
    return { plan, ...handlingForPlannedAsset(plan, input.assetId) };
  };

  const sourceConcept = (input: {
    assetPlan: RevisionRef;
    assetId: string;
  }): RevisionRef => {
    const { asset } = planned(input);
    const source = asset.sourceRefs.conceptSlots[0]?.concept;
    if (!source)
      throw new Error(`Planned asset ${asset.assetId} has no source concept.`);
    const revision = repository.getRevision(source.revisionId);
    if (
      revision.artifact.sha256 !== source.sha256 ||
      revision.kind !== source.kind
    )
      throw new Error(
        `Planned asset ${asset.assetId} has stale concept lineage.`,
      );
    return revision;
  };

  const ensurePolicy = (
    projectId: string,
    runId: string,
    classification: AssetClassification,
  ): { revision: RevisionRef; value: AssetPolicy } => {
    const ensured = repository.ensureRevision({
      projectId,
      operationKey: `m2.asset-policy:${classification}:v1`,
      entityId: `${projectId}:asset-policy:${classification}`,
      kind: "asset-policy",
      runId,
      createValue: () => DEFAULT_ASSET_POLICIES[classification],
    });
    return {
      revision: ensured.revision,
      value: AssetPolicySchema.parse(ensured.value),
    };
  };

  const evaluationContext = (input: {
    assetPlan: RevisionRef;
    assetId: string;
  }) => {
    const { asset } = planned(input);
    const concept = ConceptDocumentSchema.parse(
      repository.resolveRevision(sourceConcept(input)),
    );
    return {
      intendedUse: asset.rationale,
      requiredFeatures: asset.acceptanceCriteria,
      prohibitedFeatures: concept.negativePrompt.trim()
        ? [concept.negativePrompt.trim()]
        : [],
      referenceArtifacts: [],
    };
  };

  const attemptFrom = (
    attemptNumber: number,
    asset: RevisionRef,
    deterministicReport: RevisionRef,
    turntable: RevisionRef | undefined,
    semanticReport: RevisionRef | undefined,
    semanticRequired: boolean,
    appliedStrategy?: RevisionRef,
  ): RegenerationAttempt => {
    const deterministic = DeterministicAssetReportSchema.parse(
      repository.resolveRevision(deterministicReport),
    );
    const semantic = semanticReport
      ? SemanticAssetReportSchema.parse(
          repository.resolveRevision(semanticReport),
        )
      : undefined;
    const qualityVector = semantic?.qualityVector ?? {
      ...deterministic.qualityVector,
      semanticVerdict:
        !semanticRequired && deterministic.qualityVector.hardGateFailures === 0
          ? ("pass" as const)
          : deterministic.qualityVector.semanticVerdict,
    };
    return RegenerationAttemptSchema.parse({
      attemptNumber,
      asset,
      deterministicReport,
      ...(turntable ? { turntable } : {}),
      ...(semanticReport ? { semanticReport } : {}),
      ...(appliedStrategy ? { appliedStrategy } : {}),
      qualityVector,
    });
  };

  return {
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
    multiviewConcepts: {
      ensure: async (input) =>
        await assets.ensureMultiviewConcepts({ ...input, attempt: 0 }),
    },
    assetProduction: {
      ensure: async (input) => {
        const outcome = await assets.ensure({
          projectId: input.projectId,
          assetPlan: input.assetPlan,
          assetId: input.assetId,
          ...(input.multiviewConceptSet
            ? { multiviewConceptSet: input.multiviewConceptSet }
            : {}),
        });
        if (outcome.status === "pending") return outcome;
        if (outcome.status === "failed")
          return productionFailure(outcome.error, [input.assetPlan.revisionId]);
        return {
          status: "ready" as const,
          value: { ...input, candidateAsset: outcome.value },
        };
      },
    },
    deterministicQa: {
      ensure: async (input) => {
        const state = repository.getProject(input.projectId);
        const classification = input.classification;
        if (!classification)
          return slotFailure(
            "asset-classification-missing",
            `Asset ${input.assetId} has no classification.`,
            "terminal",
            [input.candidateAsset.revisionId],
          );
        const policy = ensurePolicy(
          input.projectId,
          state.runId,
          classification,
        );
        try {
          const inspected = await quality.inspect({
            projectId: input.projectId,
            runId: state.runId,
            asset: input.candidateAsset,
            policy,
          });
          return {
            status: "ready" as const,
            value: {
              ...input,
              deterministicReport: inspected.deterministicReport,
              ...(inspected.turntable
                ? { turntable: inspected.turntable }
                : {}),
            },
          };
        } catch (error) {
          return qualityFailure(error, [input.candidateAsset.revisionId]);
        }
      },
    },
    turntableEvaluation: {
      ensure: async (input) => {
        const state = repository.getProject(input.projectId);
        const { policy: handling } = planned(input);
        const deterministic = DeterministicAssetReportSchema.parse(
          repository.resolveRevision(input.deterministicReport),
        );
        if (!deterministic.passed)
          return {
            status: "ready" as const,
            value: { ...input, disposition: "regenerate" as const },
          };
        if (handling.semanticQa === "none")
          return {
            status: "ready" as const,
            value: { ...input, disposition: "accept" as const },
          };
        if (!input.turntable)
          return slotFailure(
            "asset-turntable-missing",
            "Semantic QA requires the deterministic turntable revision.",
            "terminal",
            [input.deterministicReport.revisionId],
          );
        const classification = input.classification!;
        const policy = ensurePolicy(
          input.projectId,
          state.runId,
          classification,
        );
        const outcome = await quality.ensureSemantic({
          projectId: input.projectId,
          runId: state.runId,
          mode: state.mode,
          asset: input.candidateAsset,
          deterministicReport: input.deterministicReport,
          turntable: input.turntable,
          policy,
          context: evaluationContext(input),
        });
        if (outcome.status === "pending") return outcome;
        if (outcome.status === "failed")
          return productionFailure(outcome.error, [input.turntable.revisionId]);
        return {
          status: "ready" as const,
          value: {
            ...input,
            semanticReport: outcome.value.revision,
            disposition:
              outcome.value.report.verdict === "pass"
                ? ("accept" as const)
                : ("regenerate" as const),
          },
        };
      },
    },
    regeneration: {
      ensure: async (input) => {
        const state = repository.getProject(input.projectId);
        const { policy: handling } = planned(input);
        let classification = input.classification!;
        let policy = ensurePolicy(input.projectId, state.runId, classification);
        const semanticRequired = handling.semanticQa !== "none";
        const history: RegenerationAttempt[] = [];
        let current = attemptFrom(
          0,
          input.candidateAsset,
          input.deterministicReport,
          input.turntable,
          input.semanticReport,
          semanticRequired,
        );
        let multiviewConceptSet = input.multiviewConceptSet;

        for (;;) {
          const selected = await quality.selectRegeneration({
            projectId: input.projectId,
            runId: state.runId,
            assetId: input.assetId,
            currentAttempt: current,
            attemptHistory: history,
            policy: policy.value,
          });
          const strategy = selected.decision.strategy;
          if (
            strategy.kind === "accept-best" ||
            strategy.kind === "give-up-user"
          ) {
            const bestRevisionId =
              strategy.kind === "accept-best"
                ? strategy.assetRevisionId
                : (strategy.bestAssetRevisionId ??
                  selected.decision.bestKnownAssetRevisionId);
            const attempts = [...history, current];
            const best =
              attempts.find(
                (attempt) => attempt.asset.revisionId === bestRevisionId,
              ) ?? current;
            const validated =
              strategy.kind === "accept-best" &&
              best.qualityVector.hardGateFailures === 0 &&
              best.qualityVector.criticalFindings === 0;
            return {
              status: "ready" as const,
              value: {
                ...input,
                classification,
                candidateAsset: current.asset,
                deterministicReport: current.deterministicReport,
                ...(current.semanticReport
                  ? { semanticReport: current.semanticReport }
                  : { semanticReport: undefined }),
                ...(best.turntable
                  ? { turntable: best.turntable }
                  : { turntable: undefined }),
                disposition: validated
                  ? ("accept" as const)
                  : ("user-action-required" as const),
                bestAsset: best.asset,
                finalDeterministicReport: best.deterministicReport,
                ...(best.semanticReport
                  ? { finalSemanticReport: best.semanticReport }
                  : {}),
                decision: selected.revision,
                attemptCount: attempts.length,
                validated,
                ...(multiviewConceptSet ? { multiviewConceptSet } : {}),
              },
            };
          }

          if (strategy.kind === "change-views") {
            const views = await assets.ensureMultiviewConcepts({
              projectId: input.projectId,
              assetPlan: input.assetPlan,
              assetId: input.assetId,
              ...(multiviewConceptSet
                ? { previousMultiviewConceptSet: multiviewConceptSet }
                : {}),
              strategyRevision: selected.revision,
              requestedRoles: strategy.roles,
              attempt: current.attemptNumber + 1,
            });
            if (views.status !== "ready") return views;
            multiviewConceptSet = views.value.multiviewConceptSet;
          } else if (strategy.kind === "reclassify") {
            classification = strategy.to;
            policy = ensurePolicy(input.projectId, state.runId, classification);
          }

          const produced = await assets.ensure({
            projectId: input.projectId,
            assetPlan: input.assetPlan,
            assetId: input.assetId,
            ...(multiviewConceptSet ? { multiviewConceptSet } : {}),
            regeneration: {
              attemptNumber: current.attemptNumber + 1,
              strategyRevision: selected.revision,
              parentAssetRevision: current.asset,
            },
          });
          if (produced.status === "pending") return produced;
          if (produced.status === "failed")
            return productionFailure(produced.error, [
              selected.revision.revisionId,
            ]);

          let inspected;
          try {
            inspected = await quality.inspect({
              projectId: input.projectId,
              runId: state.runId,
              asset: produced.value,
              policy,
            });
          } catch (error) {
            return qualityFailure(error, [produced.value.revisionId]);
          }
          let semanticReport: RevisionRef | undefined;
          if (inspected.report.passed && semanticRequired) {
            if (!inspected.turntable)
              return slotFailure(
                "asset-turntable-missing",
                "A regenerated deterministic pass has no turntable.",
                "terminal",
                [inspected.deterministicReport.revisionId],
              );
            const semantic = await quality.ensureSemantic({
              projectId: input.projectId,
              runId: state.runId,
              mode: state.mode,
              asset: produced.value,
              deterministicReport: inspected.deterministicReport,
              turntable: inspected.turntable,
              policy,
              context: evaluationContext(input),
            });
            if (semantic.status === "pending") return semantic;
            if (semantic.status === "failed")
              return productionFailure(semantic.error, [
                inspected.turntable.revisionId,
              ]);
            semanticReport = semantic.value.revision;
          }

          history.push(current);
          current = attemptFrom(
            current.attemptNumber + 1,
            produced.value,
            inspected.deterministicReport,
            inspected.turntable,
            semanticReport,
            semanticRequired,
            selected.revision,
          );
        }
      },
    },
  };
};

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
