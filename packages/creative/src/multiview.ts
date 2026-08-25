import { createHash } from "node:crypto";

import {
  AssetPlanSchema,
  ConceptSetSchema,
  ConceptViewDocumentSchema,
  ConceptViewGenerationRequestSchema,
  M1ConceptDocumentSchema,
  MultiviewConceptSetSchema,
  RegenerationDecisionReportSchema,
  RegenerationStrategySchema,
  type ArtifactRef,
  type ConceptViewDocument,
  type ConceptViewGenerationRequest,
  type ConceptViewGuidance,
  type ConceptViewRole,
  type ImageProvider,
  type M1ConceptDocument,
  type MacroPhaseOutcome,
  type MultiviewConceptSet,
  type ProviderMode,
  type RevisionAncestor,
  type RevisionRef,
  type VisualToken,
} from "@fulcrum/domain";
import {
  runCodexSubscriptionImage,
  type SubscriptionImageRunner,
} from "@fulcrum/execution";
import { ProjectRepository } from "@fulcrum/project";

import { ensureDurableSubscriptionImage } from "./durable-image.js";
import { fitConceptPrompt } from "./m1.js";
import { createMultiviewReplayRunner } from "./multiview-replay.js";

const VIEW_PROMPT_GUARD =
  "No text, UI, logos, extra subjects, scene dressing, or unrelated project history.";

const GUIDANCE_BY_ROLE = {
  front: {
    role: "front",
    azimuthDegrees: 0,
    elevationDegrees: 0,
    projection: "orthographic",
    framing: "full-subject-centered",
    background: "neutral-studio",
  },
  left: {
    role: "left",
    azimuthDegrees: 90,
    elevationDegrees: 0,
    projection: "orthographic",
    framing: "full-subject-centered",
    background: "neutral-studio",
  },
  back: {
    role: "back",
    azimuthDegrees: 180,
    elevationDegrees: 0,
    projection: "orthographic",
    framing: "full-subject-centered",
    background: "neutral-studio",
  },
  right: {
    role: "right",
    azimuthDegrees: 270,
    elevationDegrees: 0,
    projection: "orthographic",
    framing: "full-subject-centered",
    background: "neutral-studio",
  },
} as const satisfies Record<ConceptViewRole, ConceptViewGuidance>;

export type CompileConceptViewPromptInput = {
  role: ConceptViewRole;
  assetName: string;
  inheritedVisualTokens: VisualToken[];
  regenerationBrief?: string;
};

export type ConceptViewIdempotencyKeyInput = {
  projectId: string;
  assetId: string;
  role: ConceptViewRole;
  attempt: number;
  anchorConceptRevisionId: string;
  anchorImage: ArtifactRef;
  strategyRevisionId?: string | undefined;
  promptHash: string;
  mode: ProviderMode;
  imageProvider: ImageProvider;
  sourceRevisionIds: string[];
};

export const conceptViewGuidanceForRole = (
  role: ConceptViewRole,
): ConceptViewGuidance => GUIDANCE_BY_ROLE[role];

export const compileConceptViewPrompt = (
  input: CompileConceptViewPromptInput,
): string => {
  const guidance = conceptViewGuidanceForRole(input.role);
  const approvedTokens = input.inheritedVisualTokens.filter(
    ({ role }) => role !== "superseded",
  );
  const positiveTokens = approvedTokens.filter(
    ({ category }) => category !== "prohibited-style",
  );
  const prohibitedTokens = approvedTokens.filter(
    ({ category }) => category === "prohibited-style",
  );

  return fitConceptPrompt(
    [
      `Create one square production concept image of ${input.assetName}.`,
      "Image 1 is the exact identity anchor. Preserve the same subject, unchanged proportions, materials, silhouette features, color placement, and recognizable wear.",
      `Render the ${guidance.role} view at ${guidance.azimuthDegrees} degrees azimuth and 0 degrees elevation. Use an orthographic camera with the full subject centered.`,
      "Use neutral studio lighting and a neutral studio background. Do not reproduce the anchor scene lighting or environment.",
      ...positiveTokens.map(
        ({ category, role, value }) =>
          `Approved ${category}${role ? ` (${role})` : ""}: ${value}.`,
      ),
      ...prohibitedTokens.map(({ value }) => `Prohibited style: ${value}.`),
      ...(input.regenerationBrief
        ? [`Requested view correction: ${input.regenerationBrief}.`]
        : []),
    ],
    VIEW_PROMPT_GUARD,
  );
};

export const conceptViewIdempotencyKey = (
  input: ConceptViewIdempotencyKeyInput,
): string => {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        projectId: input.projectId,
        assetId: input.assetId,
        role: input.role,
        attempt: input.attempt,
        anchorConceptRevisionId: input.anchorConceptRevisionId,
        anchorImageHash: input.anchorImage.sha256,
        strategyRevisionId: input.strategyRevisionId ?? null,
        promptHash: input.promptHash,
        mode: input.mode,
        imageProvider: input.imageProvider,
        sourceRevisionIds: [...new Set(input.sourceRevisionIds)].sort(),
      }),
    )
    .digest("hex");
  return `m2-concept-view:${digest}`;
};

type MultiviewConceptProductionOptions = {
  runnerForRole?: (
    role: ConceptViewRole,
    mode: ProviderMode,
  ) => SubscriptionImageRunner;
};

class MultiviewProductionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly kind:
      | "retryable"
      | "strategy-changing"
      | "user-action-required"
      | "policy-blocked"
      | "terminal",
    readonly evidenceRevisionIds: string[] = [],
  ) {
    super(message);
    this.name = "MultiviewProductionError";
  }
}

const ancestorFromRevision = (revision: RevisionRef): RevisionAncestor => ({
  revisionId: revision.revisionId,
  sha256: revision.artifact.sha256,
  kind: revision.kind,
});

const uniqueAncestors = (ancestors: RevisionAncestor[]): RevisionAncestor[] => [
  ...new Map(
    ancestors.map((ancestor) => [ancestor.revisionId, ancestor]),
  ).values(),
];

const sameRevision = (left: RevisionRef, right: RevisionRef): boolean =>
  left.revisionId === right.revisionId &&
  left.artifact.sha256 === right.artifact.sha256 &&
  left.kind === right.kind;

const failure = (
  error: unknown,
  evidenceRevisionIds: string[],
): MacroPhaseOutcome<RevisionRef> => {
  if (error instanceof MultiviewProductionError) {
    return {
      status: "failed",
      error: {
        code: error.code,
        message: error.message,
        kind: error.kind,
        evidenceRevisionIds: [
          ...new Set([...evidenceRevisionIds, ...error.evidenceRevisionIds]),
        ],
      },
    };
  }
  return {
    status: "failed",
    error: {
      code: "multiview-lineage-invalid",
      message: error instanceof Error ? error.message : String(error),
      kind: "policy-blocked",
      evidenceRevisionIds,
    },
  };
};

const strategyFromRevision = (
  repository: ProjectRepository,
  revision: RevisionRef,
) => {
  const value = repository.resolveRevision<unknown>(revision);
  const decision = RegenerationDecisionReportSchema.safeParse(value);
  if (decision.success) return decision.data.strategy;
  return RegenerationStrategySchema.parse(value);
};

export class MultiviewConceptProduction {
  constructor(
    private readonly repository: ProjectRepository,
    private readonly options: MultiviewConceptProductionOptions = {},
  ) {}

  async ensure(
    input: ConceptViewGenerationRequest,
  ): Promise<MacroPhaseOutcome<RevisionRef>> {
    const evidenceRevisionIds = [
      input.assetPlan.revisionId,
      input.sourceConceptSet.revisionId,
      input.anchorConcept.revisionId,
      input.previousMultiviewConceptSet?.revisionId,
      input.strategyRevision?.revisionId,
    ].filter((value): value is string => Boolean(value));
    try {
      const request = ConceptViewGenerationRequestSchema.parse(input);
      const state = this.repository.getProject(request.projectId);
      if (
        !state.assetPlan ||
        !sameRevision(state.assetPlan, request.assetPlan) ||
        state.assetPlanApproval?.decision !== "approved" ||
        state.assetPlanApproval.targetRevisionId !==
          request.assetPlan.revisionId ||
        state.assetPlanApproval.targetSha256 !==
          request.assetPlan.artifact.sha256
      ) {
        throw new MultiviewProductionError(
          "asset-plan-approval-invalid",
          "Multiview generation requires the current hash-approved asset plan.",
          "policy-blocked",
        );
      }
      if (
        !state.conceptSet ||
        !sameRevision(state.conceptSet, request.sourceConceptSet) ||
        state.conceptSetApproval?.decision !== "approved" ||
        state.conceptSetApproval.targetRevisionId !==
          request.sourceConceptSet.revisionId ||
        state.conceptSetApproval.targetSha256 !==
          request.sourceConceptSet.artifact.sha256
      ) {
        throw new MultiviewProductionError(
          "concept-set-approval-invalid",
          "Multiview generation requires the current hash-approved concept set.",
          "policy-blocked",
        );
      }

      const plan = AssetPlanSchema.parse(
        this.repository.resolveRevision(request.assetPlan),
      );
      const plannedAsset = plan.assets.find(
        ({ assetId }) => assetId === request.assetId,
      );
      if (!plannedAsset) {
        throw new MultiviewProductionError(
          "asset-plan-route-invalid",
          `Asset ${request.assetId} is not present in the approved plan.`,
          "policy-blocked",
        );
      }
      const plannedConceptSet = plannedAsset.sourceRefs.conceptSet;
      if (
        plannedConceptSet.revisionId !== request.sourceConceptSet.revisionId ||
        plannedConceptSet.sha256 !== request.sourceConceptSet.artifact.sha256 ||
        plannedConceptSet.kind !== request.sourceConceptSet.kind
      ) {
        throw new MultiviewProductionError(
          "multiview-concept-set-lineage-invalid",
          "The planned asset does not name the approved source concept set.",
          "policy-blocked",
        );
      }

      const conceptSet = ConceptSetSchema.parse(
        this.repository.resolveRevision(request.sourceConceptSet),
      );
      const selected = conceptSet.slots
        .flatMap((slot) =>
          slot.revisions
            .filter(
              ({ revision }) => revision.revisionId === slot.selectedRevisionId,
            )
            .map((conceptRevision) => ({ slot, conceptRevision })),
        )
        .find(({ conceptRevision }) =>
          sameRevision(conceptRevision.revision, request.anchorConcept),
        );
      const plannedAnchor = plannedAsset.sourceRefs.conceptSlots.find(
        ({ concept }) =>
          concept.revisionId === request.anchorConcept.revisionId &&
          concept.sha256 === request.anchorConcept.artifact.sha256 &&
          concept.kind === request.anchorConcept.kind,
      );
      if (!selected || !plannedAnchor) {
        throw new MultiviewProductionError(
          "multiview-anchor-not-selected",
          "The requested anchor is not a kept concept named by the approved asset plan.",
          "policy-blocked",
        );
      }
      const anchorDocument = M1ConceptDocumentSchema.parse(
        this.repository.resolveRevision<M1ConceptDocument>(
          request.anchorConcept,
        ),
      );

      let previous:
        { revision: RevisionRef; value: MultiviewConceptSet } | undefined;
      if (request.previousMultiviewConceptSet) {
        const value = MultiviewConceptSetSchema.parse(
          this.repository.resolveRevision(request.previousMultiviewConceptSet),
        );
        if (
          value.assetId !== request.assetId ||
          !sameRevision(value.anchorConcept.revision, request.anchorConcept) ||
          value.anchorConcept.image.sha256 !== anchorDocument.image.sha256
        ) {
          throw new MultiviewProductionError(
            "previous-multiview-lineage-invalid",
            "The previous multiview set belongs to different approved lineage.",
            "policy-blocked",
          );
        }
        previous = {
          revision: request.previousMultiviewConceptSet,
          value,
        };
      }

      let regenerationBrief: string | undefined;
      if (request.strategyRevision) {
        const strategy = strategyFromRevision(
          this.repository,
          request.strategyRevision,
        );
        if (strategy.kind !== "change-views") {
          throw new MultiviewProductionError(
            "multiview-strategy-invalid",
            "Only a change-views strategy can replace concept views.",
            "policy-blocked",
          );
        }
        regenerationBrief = strategy.brief;
      }
      if (
        (request.previousMultiviewConceptSet || request.requestedRoles) &&
        (!request.previousMultiviewConceptSet || !request.strategyRevision)
      ) {
        throw new MultiviewProductionError(
          "multiview-regeneration-lineage-incomplete",
          "View regeneration requires both the prior set and strategy revision.",
          "policy-blocked",
        );
      }
      if (
        request.requestedRoles &&
        request.rolesToGenerate.some(
          (role) => !request.requestedRoles?.includes(role),
        )
      ) {
        throw new MultiviewProductionError(
          "multiview-regeneration-role-mismatch",
          "Generated roles must be a subset of the requested regeneration roles.",
          "policy-blocked",
        );
      }

      const viewByRole = new Map(
        previous?.value.views.map((view) => [view.role, view]) ?? [],
      );
      const rolesToGenerate = new Set(request.rolesToGenerate);
      for (const role of Object.keys(GUIDANCE_BY_ROLE) as ConceptViewRole[]) {
        if (!rolesToGenerate.has(role)) continue;
        const prompt = compileConceptViewPrompt({
          role,
          assetName: plannedAsset.name,
          inheritedVisualTokens: selected.conceptRevision.inheritedVisualTokens,
          ...(regenerationBrief ? { regenerationBrief } : {}),
        });
        const promptHash = createHash("sha256").update(prompt).digest("hex");
        const sourceRevisionIds = [
          request.assetPlan.revisionId,
          request.sourceConceptSet.revisionId,
          request.anchorConcept.revisionId,
          ...(request.previousMultiviewConceptSet
            ? [request.previousMultiviewConceptSet.revisionId]
            : []),
          ...(request.strategyRevision
            ? [request.strategyRevision.revisionId]
            : []),
        ];
        const idempotencyKey = conceptViewIdempotencyKey({
          projectId: request.projectId,
          assetId: request.assetId,
          role,
          attempt: request.attempt,
          anchorConceptRevisionId: request.anchorConcept.revisionId,
          anchorImage: anchorDocument.image,
          ...(request.strategyRevision
            ? { strategyRevisionId: request.strategyRevision.revisionId }
            : {}),
          promptHash,
          mode: request.mode,
          imageProvider: request.imageProvider,
          sourceRevisionIds,
        });
        const runner =
          this.options.runnerForRole?.(role, request.mode) ??
          (request.mode === "replay"
            ? createMultiviewReplayRunner(role)
            : runCodexSubscriptionImage);
        const image = await ensureDurableSubscriptionImage({
          repository: this.repository,
          runner,
          projectId: request.projectId,
          runId: request.runId,
          idempotencyKey,
          prompt,
          mode: request.mode,
          provider:
            request.mode === "replay"
              ? "fulcrum-replay"
              : request.imageProvider,
          operation: "m2-concept-view",
          referenceImages: [anchorDocument.image],
        });
        if (image.status === "pending") return image;
        if (image.status === "failed") {
          const retryLimitReached = /retry limit/i.test(image.error.message);
          return {
            status: "failed",
            error: {
              code: image.error.code,
              message: image.error.message,
              kind:
                image.error.code === "submission-unknown"
                  ? "user-action-required"
                  : retryLimitReached
                    ? "strategy-changing"
                    : (image.error.failureKind ?? "retryable"),
              evidenceRevisionIds,
            },
          };
        }

        const priorView = viewByRole.get(role);
        const ancestors = uniqueAncestors([
          ancestorFromRevision(request.assetPlan),
          ancestorFromRevision(request.sourceConceptSet),
          ancestorFromRevision(request.anchorConcept),
          ...(priorView ? [ancestorFromRevision(priorView.revision)] : []),
          ...(request.strategyRevision
            ? [ancestorFromRevision(request.strategyRevision)]
            : []),
        ]);
        const ensured = this.repository.ensureRevision({
          projectId: request.projectId,
          operationKey: `${idempotencyKey}:${image.value.artifact.sha256}`,
          entityId: `${request.assetId}:concept-view:${role}`,
          kind: "concept-view-document",
          runId: request.runId,
          createValue: (): ConceptViewDocument =>
            ConceptViewDocumentSchema.parse({
              conceptViewId: `${request.assetId}:concept-view:${role}`,
              assetId: request.assetId,
              guidance: conceptViewGuidanceForRole(role),
              attempt: request.attempt,
              prompt,
              promptHash,
              image: image.value.artifact,
              provider:
                request.mode === "replay"
                  ? "fulcrum-replay"
                  : request.imageProvider,
              model: image.value.model,
              ...(request.mode === "replay"
                ? {
                    seed: createHash("sha256")
                      .update(`${anchorDocument.image.sha256}:${role}`)
                      .digest("hex"),
                  }
                : {}),
              costUsd: image.value.costUsd,
              sourceConceptRevisionId: request.anchorConcept.revisionId,
              sourceRevisionIds: ancestors.map(({ revisionId }) => revisionId),
              ancestors,
              referenceArtifactHashes: [anchorDocument.image.sha256],
              operation: "identity-preserving-concept-view",
            }),
        });
        const document = ConceptViewDocumentSchema.parse(ensured.value);
        if (ensured.created) {
          this.repository.appendEvent({
            projectId: request.projectId,
            runId: request.runId,
            type: "concept-view.completed",
            payload: {
              assetId: request.assetId,
              role,
              revisionId: ensured.revision.revisionId,
              imageArtifactId: document.image.artifactId,
            },
          });
        }
        viewByRole.set(role, {
          role,
          guidance: document.guidance,
          revision: ensured.revision,
          image: document.image,
        });
      }

      const views = (Object.keys(GUIDANCE_BY_ROLE) as ConceptViewRole[])
        .map((role) => viewByRole.get(role))
        .filter((view): view is NonNullable<typeof view> => view !== undefined);
      const setSourceRevisionIds = [
        request.assetPlan.revisionId,
        request.sourceConceptSet.revisionId,
        request.anchorConcept.revisionId,
        ...(request.previousMultiviewConceptSet
          ? [request.previousMultiviewConceptSet.revisionId]
          : []),
        ...(request.strategyRevision
          ? [request.strategyRevision.revisionId]
          : []),
      ];
      const setValue = MultiviewConceptSetSchema.parse({
        multiviewConceptSetId: `${request.assetId}:multiview-concept-set`,
        assetId: request.assetId,
        sourceAssetPlanRevisionId: request.assetPlan.revisionId,
        sourceConceptSetRevisionId: request.sourceConceptSet.revisionId,
        anchorConcept: {
          revision: request.anchorConcept,
          image: anchorDocument.image,
        },
        ...(request.previousMultiviewConceptSet
          ? {
              previousMultiviewConceptSetRevisionId:
                request.previousMultiviewConceptSet.revisionId,
            }
          : {}),
        ...(request.strategyRevision
          ? { strategyRevisionId: request.strategyRevision.revisionId }
          : {}),
        views,
        sourceRevisionIds: setSourceRevisionIds,
      });
      const ensuredSet = this.repository.ensureRevision({
        projectId: request.projectId,
        operationKey: `multiview-set:${createHash("sha256")
          .update(
            JSON.stringify({
              sourceRevisionIds: setSourceRevisionIds,
              views: views.map(({ role, revision, image }) => ({
                role,
                revisionId: revision.revisionId,
                imageHash: image.sha256,
              })),
            }),
          )
          .digest("hex")}`,
        entityId: `${request.assetId}:multiview-concept-set`,
        kind: "multiview-concept-set",
        runId: request.runId,
        createValue: () => setValue,
      });
      if (ensuredSet.created) {
        this.repository.appendEvent({
          projectId: request.projectId,
          runId: request.runId,
          type: "concept-view-set.completed",
          payload: {
            assetId: request.assetId,
            revisionId: ensuredSet.revision.revisionId,
            viewRevisionIds: views.map(({ revision }) => revision.revisionId),
          },
        });
      }
      return { status: "ready", value: ensuredSet.revision };
    } catch (error) {
      return failure(error, evidenceRevisionIds);
    }
  }
}
