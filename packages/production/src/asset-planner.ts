import { createHash, randomUUID } from "node:crypto";

import {
  ASSET_CLASS_HANDLING_POLICIES_V1,
  ASSET_PLAN_MAX_ASSETS,
  AmendAssetPlanInputSchema,
  AssetClassificationSchema,
  AssetPlanSchema,
  AssetPlanFailureSchema,
  AssetPlanningInputSchema,
  ConceptSetSchema,
  CharacterPoseModeSchema,
  FinalizedAssetPlanBindingSchema,
  GameDesignSpecSchema,
  M1ConceptDocumentSchema,
  PlannedAssetProcedureSchema,
  assetPlanSectionFor,
  assetPlanGraphIssues,
  isProviderPreflightError,
  type ApprovalDecision,
  type AssetPlan,
  type AssetPlanIssue,
  type AssetPlanFailure,
  type AssetPlanSection,
  type AssetPlanningInput,
  type AssetPlanningOutcome,
  type ConceptSet,
  type GameDesignSpec,
  type M1ConceptDocument,
  type PlannedAsset,
  type RevisionAncestor,
  type RevisionRef,
} from "@fulcrum/domain";
import { ModelExecution } from "@fulcrum/execution";
import { ProjectRepository } from "@fulcrum/project";
import { z } from "zod";

type RevisionApprovalBinding = {
  revision: RevisionRef;
  approval: ApprovalDecision;
};

export type AssetPlanValidationInputs = {
  projectId: string;
  runId: string;
  gameDesignSpec: RevisionApprovalBinding;
  conceptSet: RevisionApprovalBinding;
  conceptSetDocument: ConceptSet;
  conceptDocuments: Record<string, M1ConceptDocument>;
  expectedRevisionId: string;
  expectedOperation:
    "asset-plan.initial" | "asset-plan.replan" | "asset-plan.amend";
  previousPlan?: RevisionRef;
};

export const AssetPlanDraftAssetSchema = z
  .object({
    assetKey: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
    name: z.string().trim().min(1).max(120),
    classification: AssetClassificationSchema,
    rationale: z.string().trim().min(1).max(600),
    sourceConceptSlotIds: z.array(z.string().min(1)).max(3),
    dependsOnAssetKeys: z.array(z.string().min(1)).max(11),
    poseMode: CharacterPoseModeSchema.optional(),
    procedure: PlannedAssetProcedureSchema.optional(),
    acceptanceCriteria: z
      .array(z.string().trim().min(1).max(300))
      .min(1)
      .max(8),
  })
  .superRefine((asset, context) => {
    if ((asset.classification === "procedural") !== Boolean(asset.procedure)) {
      context.addIssue({
        code: "custom",
        path: ["procedure"],
        message:
          "Procedural assets require parameters; other classes must omit them.",
      });
    }
    if (asset.poseMode && asset.classification !== "hero") {
      context.addIssue({
        code: "custom",
        path: ["poseMode"],
        message: "Only riggable hero assets may request a character pose.",
      });
    }
  });
export type AssetPlanDraftAsset = z.infer<typeof AssetPlanDraftAssetSchema>;

const draftGraphIssues = (assets: AssetPlanDraftAsset[]) => {
  const ids = new Set<string>();
  const issues: Array<{ path: Array<string | number>; message: string }> = [];
  assets.forEach((asset, index) => {
    if (ids.has(asset.assetKey)) {
      issues.push({
        path: [index, "assetKey"],
        message: `Duplicate asset key: ${asset.assetKey}.`,
      });
    }
    ids.add(asset.assetKey);
  });
  const indegree = new Map(assets.map((asset) => [asset.assetKey, 0]));
  const dependents = new Map(
    assets.map((asset) => [asset.assetKey, [] as string[]]),
  );
  assets.forEach((asset, index) => {
    for (const [
      dependencyIndex,
      dependencyKey,
    ] of asset.dependsOnAssetKeys.entries()) {
      if (dependencyKey === asset.assetKey) {
        issues.push({
          path: [index, "dependsOnAssetKeys", dependencyIndex],
          message: `Asset ${asset.assetKey} cannot depend on itself.`,
        });
      } else if (!ids.has(dependencyKey)) {
        issues.push({
          path: [index, "dependsOnAssetKeys", dependencyIndex],
          message: `Unknown dependency: ${dependencyKey}.`,
        });
      } else {
        indegree.set(asset.assetKey, (indegree.get(asset.assetKey) ?? 0) + 1);
        dependents.get(dependencyKey)?.push(asset.assetKey);
      }
    }
  });
  const queue = [...indegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([assetKey]) => assetKey)
    .sort();
  let visited = 0;
  while (queue.length > 0) {
    const assetKey = queue.shift()!;
    visited += 1;
    for (const dependent of dependents.get(assetKey) ?? []) {
      const degree = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, degree);
      if (degree === 0) queue.push(dependent);
    }
    queue.sort();
  }
  if (visited !== assets.length) {
    assets.forEach((asset, index) => {
      if ((indegree.get(asset.assetKey) ?? 0) > 0) {
        issues.push({
          path: [index, "dependsOnAssetKeys"],
          message: `Asset ${asset.assetKey} participates in a dependency cycle.`,
        });
      }
    });
  }
  return issues;
};

export const AssetPlanDraftSchema = z
  .object({
    assets: z
      .array(AssetPlanDraftAssetSchema)
      .min(1)
      .max(ASSET_PLAN_MAX_ASSETS),
  })
  .superRefine((draft, context) => {
    for (const issue of draftGraphIssues(draft.assets)) {
      context.addIssue({
        code: "custom",
        path: ["assets", ...issue.path],
        message: issue.message,
      });
    }
  });
export type AssetPlanDraft = z.infer<typeof AssetPlanDraftSchema>;

const AssetPlanDraftProcedureWireSchema = z.object({
  generatorId: PlannedAssetProcedureSchema.shape.generatorId,
  parameters: z
    .array(
      z.object({
        name: z.string().min(1),
        value: z.union([z.string(), z.number(), z.boolean()]),
      }),
    )
    .min(1),
});

export const AssetPlanDraftAssetWireSchema = z.union([
  z.object({
    ...AssetPlanDraftAssetSchema.shape,
    classification: z.enum(["hero", "kit", "functional"]),
    poseMode: CharacterPoseModeSchema.nullable(),
    procedure: z.null(),
  }),
  z.object({
    ...AssetPlanDraftAssetSchema.shape,
    classification: z.literal("procedural"),
    poseMode: CharacterPoseModeSchema.nullable(),
    procedure: AssetPlanDraftProcedureWireSchema,
  }),
]);

export const AssetPlanDraftWireSchema = z.object({
  assets: z
    .array(AssetPlanDraftAssetWireSchema)
    .min(1)
    .max(ASSET_PLAN_MAX_ASSETS),
});
export type AssetPlanDraftWire = z.infer<typeof AssetPlanDraftWireSchema>;

export const mapAssetPlanDraftWire = (
  draft: AssetPlanDraftWire,
): AssetPlanDraft => ({
  assets: draft.assets.map((asset, assetIndex) => {
    const { poseMode, procedure, ...assetFields } = asset;
    const domainFields = {
      ...assetFields,
      ...(poseMode ? { poseMode } : {}),
    };
    if (procedure === null) return domainFields;

    const names = new Set<string>();
    for (const [parameterIndex, parameter] of procedure.parameters.entries()) {
      if (names.has(parameter.name)) {
        throw new z.ZodError([
          {
            code: "custom",
            input: parameter.name,
            path: [
              "assets",
              assetIndex,
              "procedure",
              "parameters",
              parameterIndex,
              "name",
            ],
            message: `Duplicate procedure parameter name: ${parameter.name}.`,
          },
        ]);
      }
      names.add(parameter.name);
    }

    return {
      ...domainFields,
      procedure: {
        generatorId: procedure.generatorId,
        parameters: Object.fromEntries(
          procedure.parameters.map(({ name, value }) => [name, value]),
        ),
      },
    };
  }),
});

export type AssetPlanDerivationInputs = AssetPlanValidationInputs & {
  gameDesignSpecDocument: GameDesignSpec;
  previousPlanDocument?: AssetPlan;
  replanDecision?: ApprovalDecision;
};

export type AssetPlanMaterializationContext = AssetPlanDerivationInputs & {
  revisionId: string;
  createdAt: string;
  operation: "asset-plan.initial" | "asset-plan.replan" | "asset-plan.amend";
  provider?: string;
  model?: string;
};

const revisionAncestor = (revision: RevisionRef): RevisionAncestor => ({
  revisionId: revision.revisionId,
  sha256: revision.artifact.sha256,
  kind: revision.kind,
});

const sameAncestor = (
  actual: RevisionAncestor,
  expected: RevisionAncestor,
): boolean =>
  actual.revisionId === expected.revisionId &&
  actual.sha256 === expected.sha256 &&
  actual.kind === expected.kind;

const sameStrings = (actual: string[], expected: string[]): boolean => {
  const left = [...new Set(actual)].sort();
  const right = [...new Set(expected)].sort();
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
};

const selectedConceptSlots = (
  inputs: Pick<AssetPlanValidationInputs, "conceptSetDocument">,
) =>
  inputs.conceptSetDocument.slots.flatMap((slot) => {
    const kept = slot.revisions.find(
      (candidate) => candidate.revision.revisionId === slot.selectedRevisionId,
    );
    return kept && kept.staleReason === undefined ? [{ slot, kept }] : [];
  });

const slug = (value: string): string => {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return /^[a-z]/.test(normalized) ? normalized : `asset-${normalized}`;
};

const draftFromPreviousPlan = (
  projectId: string,
  plan: AssetPlan,
): AssetPlanDraft => {
  const prefix = `${projectId}:planned-asset:`;
  const assets = plan.assets.map((asset) => ({
    assetKey: asset.assetId.startsWith(prefix)
      ? asset.assetId.slice(prefix.length)
      : slug(asset.assetId),
    name: asset.name,
    classification: asset.classification,
    rationale: asset.rationale,
    sourceConceptSlotIds: asset.sourceRefs.conceptSlots
      .map((source) => source.slotId)
      .sort(),
    dependsOnAssetKeys: asset.dependsOnAssetIds
      .map((dependencyId) =>
        dependencyId.startsWith(prefix)
          ? dependencyId.slice(prefix.length)
          : slug(dependencyId),
      )
      .sort(),
    ...(asset.poseMode ? { poseMode: asset.poseMode } : {}),
    ...(asset.procedure ? { procedure: structuredClone(asset.procedure) } : {}),
    acceptanceCriteria: [...asset.acceptanceCriteria],
  }));
  return AssetPlanDraftSchema.parse({ assets });
};

const applyReplayChangeNote = (
  draft: AssetPlanDraft,
  note: string,
): AssetPlanDraft => {
  const lower = note.toLowerCase();
  const target =
    draft.assets.find((asset) => lower.includes(asset.name.toLowerCase())) ??
    draft.assets.find((asset) => lower.includes(asset.classification)) ??
    draft.assets.find((asset) => asset.classification === "hero") ??
    draft.assets[0];
  if (!target) return draft;
  const acceptanceCriteria = [...target.acceptanceCriteria];
  const criterion = note.trim().slice(0, 300);
  if (!acceptanceCriteria.includes(criterion))
    acceptanceCriteria.push(criterion);
  target.acceptanceCriteria = acceptanceCriteria.slice(-8);
  return AssetPlanDraftSchema.parse(draft);
};

export const deriveReplayAssetPlanDraft = (
  inputs: AssetPlanDerivationInputs,
): AssetPlanDraft => {
  if (
    inputs.previousPlanDocument &&
    inputs.previousPlan &&
    inputs.replanDecision?.decision === "changes-requested" &&
    inputs.replanDecision.notes?.trim()
  ) {
    return applyReplayChangeNote(
      draftFromPreviousPlan(inputs.projectId, inputs.previousPlanDocument),
      inputs.replanDecision.notes,
    );
  }

  const selected = selectedConceptSlots(inputs);
  const primary =
    selected.find(({ slot }) => slot.slotId === "gameplay-anchor") ??
    selected[0];
  if (!primary) {
    throw new Error("Asset planning requires at least one kept concept slot.");
  }
  const environment = selected.find(({ slot }) =>
    /environment|world|arena|level|room/.test(
      `${slot.slotId} ${slot.name} ${slot.purpose}`.toLowerCase(),
    ),
  );
  const actorSlots = selected.filter(
    ({ slot }) =>
      slot.slotId !== primary.slot.slotId &&
      /actor|character|hero|creature|player|enemy|threat/.test(
        `${slot.slotId} ${slot.name} ${slot.purpose}`.toLowerCase(),
      ),
  );
  const heroKey = slug(primary.slot.slotId);
  const kitKey = "environment-kit";
  const kitSource = environment ?? primary;
  const assets: AssetPlanDraftAsset[] = [
    {
      assetKey: heroKey,
      name: primary.slot.name,
      classification: "hero",
      rationale: "The approved gameplay anchor carries the core interaction.",
      sourceConceptSlotIds: [primary.slot.slotId],
      dependsOnAssetKeys: [],
      acceptanceCriteria: [
        "The primary silhouette stays readable at gameplay distance.",
      ],
    },
    ...actorSlots.map(({ slot }) => ({
      assetKey: slug(slot.slotId),
      name: slot.name,
      classification: "hero" as const,
      rationale: "This identity-defining actor needs its own hero treatment.",
      sourceConceptSlotIds: [slot.slotId],
      dependsOnAssetKeys: [],
      acceptanceCriteria: [
        "The actor preserves its approved role and silhouette.",
      ],
    })),
    {
      assetKey: kitKey,
      name: "Environment Material Kit",
      classification: "kit",
      rationale: `A reusable kit carries ${inputs.gameDesignSpecDocument.title}'s approved material language through the playable space.`,
      sourceConceptSlotIds: [kitSource.slot.slotId],
      dependsOnAssetKeys: [heroKey],
      acceptanceCriteria: [
        "Kit pieces reuse the hero material language without obscuring gameplay.",
      ],
    },
    {
      assetKey: "environment-dressing",
      name: "Environment Dressing",
      classification: "procedural",
      rationale:
        "Parameterized dressing fills the kit without hand-authoring every prop.",
      sourceConceptSlotIds: [kitSource.slot.slotId],
      dependsOnAssetKeys: [kitKey],
      procedure: {
        generatorId: "fulcrum.environment-dressing.v1",
        parameters: { density: 0.55, avoidGameplayLane: true },
      },
      acceptanceCriteria: [
        "Dressing preserves navigation and the primary gameplay sightline.",
      ],
    },
    {
      assetKey: "gameplay-volume",
      name: "Gameplay Interaction Volume",
      classification: "functional",
      rationale:
        "The core interaction needs a runtime-authored gameplay footprint.",
      sourceConceptSlotIds: [primary.slot.slotId],
      dependsOnAssetKeys: [kitKey],
      acceptanceCriteria: [
        "The interaction volume matches the approved objective footprint.",
      ],
    },
  ];
  return AssetPlanDraftSchema.parse({ assets });
};

const amendmentCount = (request: string): number => {
  const digit = /\b(\d{1,2})\b/.exec(request)?.[1];
  if (digit) return Math.max(1, Number(digit));
  const words: Readonly<Record<string, number>> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
  };
  const word = new RegExp(`\\b(${Object.keys(words).join("|")})\\b`).exec(
    request.toLowerCase(),
  )?.[1];
  return word ? words[word]! : 1;
};

const replayAmendmentAsset = (
  section: AssetPlanSection,
  assetKey: string,
  ordinal: number,
  sourceConceptSlotIds: string[],
  request: string,
  seed: string,
): AssetPlanDraftAsset => {
  const requested = request.trim().slice(0, 240);
  const shared = {
    assetKey,
    sourceConceptSlotIds,
    dependsOnAssetKeys: [] as string[],
    acceptanceCriteria: [
      `The new slot satisfies this section amendment: ${requested}`.slice(
        0,
        300,
      ),
    ],
  };
  if (section === "modular-kit")
    return {
      ...shared,
      name: `Modular Kit Slot ${ordinal}`,
      classification: "kit",
      rationale:
        "This added modular kit slot carries the approved visual language into reusable pieces.",
    };
  if (section === "procedural-reference")
    return {
      ...shared,
      name: `Procedural Reference Slot ${ordinal}`,
      classification: "procedural",
      rationale:
        "This added procedural slot gives the coding agent one auditable implementation target.",
      procedure: {
        generatorId: "fulcrum.section-amendment.v1",
        parameters: { seed, request: requested },
      },
    };
  if (section === "environment")
    return {
      ...shared,
      name: `Environment Slot ${ordinal}`,
      classification: "hero",
      rationale:
        "This added environment slot defines another playable-area visual input.",
    };
  if (section === "prop")
    return {
      ...shared,
      name: `Prop Slot ${ordinal}`,
      classification: "hero",
      rationale:
        "This added prop slot defines another distinct gameplay object.",
    };
  return {
    ...shared,
    name: `Character Slot ${ordinal}`,
    classification: "hero",
    rationale:
      "This added character slot defines another identity-readable actor.",
  };
};

export const deriveReplayAssetPlanAmendmentDraft = (input: {
  projectId: string;
  currentPlan: AssetPlan;
  section: AssetPlanSection;
  request: string;
  seed: string;
}): AssetPlanDraft => {
  const draft = draftFromPreviousPlan(input.projectId, input.currentPlan);
  const remaining = ASSET_PLAN_MAX_ASSETS - draft.assets.length;
  if (remaining <= 0)
    throw new Error(
      `The asset plan already contains the maximum of ${ASSET_PLAN_MAX_ASSETS} assets.`,
    );
  const count = Math.min(amendmentCount(input.request), remaining);
  const digest = hashText(
    JSON.stringify([
      input.seed,
      input.currentPlan.provenance.revisionId,
      input.section,
      input.request.trim(),
    ]),
  );
  const source =
    draft.assets.find((asset, index) => {
      const current = input.currentPlan.assets[index];
      return (
        current !== undefined &&
        assetPlanSectionFor(current) === input.section &&
        asset.sourceConceptSlotIds.length > 0
      );
    }) ?? draft.assets.find((asset) => asset.sourceConceptSlotIds.length > 0);
  const sourceConceptSlotIds = [...(source?.sourceConceptSlotIds ?? [])];
  const existingKeys = new Set(draft.assets.map(({ assetKey }) => assetKey));
  const sectionPrefix = input.section.replace(/[^a-z0-9]+/g, "-");
  for (let index = 0; index < count; index += 1) {
    let suffix = index;
    let assetKey = `${sectionPrefix}-amendment-${digest.slice(0, 8)}-${suffix + 1}`;
    while (existingKeys.has(assetKey)) {
      suffix += 1;
      assetKey = `${sectionPrefix}-amendment-${digest.slice(0, 8)}-${suffix + 1}`;
    }
    existingKeys.add(assetKey);
    draft.assets.push(
      replayAmendmentAsset(
        input.section,
        assetKey,
        index + 1,
        sourceConceptSlotIds,
        input.request,
        digest.slice(index * 4, index * 4 + 12),
      ),
    );
  }
  return AssetPlanDraftSchema.parse(draft);
};

const classificationOrder = {
  hero: 0,
  kit: 1,
  procedural: 2,
  functional: 3,
} as const;

const topologicalDraftOrder = (
  assets: AssetPlanDraftAsset[],
): AssetPlanDraftAsset[] => {
  const byKey = new Map(assets.map((asset) => [asset.assetKey, asset]));
  const indegree = new Map(
    assets.map((asset) => [asset.assetKey, asset.dependsOnAssetKeys.length]),
  );
  const dependents = new Map(
    assets.map((asset) => [asset.assetKey, [] as string[]]),
  );
  for (const asset of assets) {
    for (const dependency of asset.dependsOnAssetKeys) {
      dependents.get(dependency)?.push(asset.assetKey);
    }
  }
  const compare = (left: string, right: string) => {
    const leftAsset = byKey.get(left)!;
    const rightAsset = byKey.get(right)!;
    return (
      classificationOrder[leftAsset.classification] -
        classificationOrder[rightAsset.classification] ||
      left.localeCompare(right)
    );
  };
  const queue = [...indegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([assetKey]) => assetKey)
    .sort(compare);
  const ordered: AssetPlanDraftAsset[] = [];
  while (queue.length > 0) {
    const key = queue.shift()!;
    ordered.push(byKey.get(key)!);
    for (const dependent of dependents.get(key) ?? []) {
      const degree = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, degree);
      if (degree === 0) queue.push(dependent);
    }
    queue.sort(compare);
  }
  if (ordered.length !== assets.length) {
    throw new Error("Asset-plan draft contains a dependency cycle.");
  }
  return ordered;
};

export const materializeAssetPlan = (
  rawDraft: AssetPlanDraft,
  context: AssetPlanMaterializationContext,
): AssetPlan => {
  const draft = AssetPlanDraftSchema.parse(rawDraft);
  const selected = selectedConceptSlots(context);
  const selectedBySlotId = new Map(
    selected.map(({ slot, kept }) => [slot.slotId, kept.revision]),
  );
  const assetId = (assetKey: string) =>
    `${context.projectId}:planned-asset:${assetKey}`;
  const assets = topologicalDraftOrder(draft.assets).map((asset) => ({
    assetId: assetId(asset.assetKey),
    name: asset.name,
    classification: asset.classification,
    rationale: asset.rationale,
    sourceRefs: {
      gameDesignSpec: revisionAncestor(context.gameDesignSpec.revision),
      conceptSet: revisionAncestor(context.conceptSet.revision),
      conceptSlots: [...new Set(asset.sourceConceptSlotIds)]
        .sort()
        .map((slotId) => {
          const concept = selectedBySlotId.get(slotId);
          if (!concept)
            throw new Error(
              `Asset ${asset.assetKey} names unknown or stale concept slot ${slotId}.`,
            );
          return { slotId, concept: revisionAncestor(concept) };
        }),
    },
    dependsOnAssetIds: [...new Set(asset.dependsOnAssetKeys)]
      .map(assetId)
      .sort(),
    ...(asset.poseMode ? { poseMode: asset.poseMode } : {}),
    ...(asset.procedure ? { procedure: structuredClone(asset.procedure) } : {}),
    acceptanceCriteria: [...asset.acceptanceCriteria],
  }));
  const selectedRevisions = selected.map(({ kept }) => kept.revision);
  const parentRevisionIds = [
    context.gameDesignSpec.revision.revisionId,
    context.conceptSet.revision.revisionId,
    ...selectedRevisions.map((revision) => revision.revisionId),
    ...(context.previousPlan ? [context.previousPlan.revisionId] : []),
  ];
  const sourceArtifactHashes = [
    context.gameDesignSpec.revision.artifact.sha256,
    context.conceptSet.revision.artifact.sha256,
    ...selectedRevisions.map((revision) => revision.artifact.sha256),
    ...(context.previousPlan ? [context.previousPlan.artifact.sha256] : []),
  ];
  return AssetPlanSchema.parse({
    planId: `${context.projectId}:asset-plan`,
    assets,
    handling: ASSET_CLASS_HANDLING_POLICIES_V1,
    ...(context.operation === "asset-plan.replan" &&
    context.previousPlan &&
    context.replanDecision?.notes
      ? {
          changeRequest: {
            approvalId: context.replanDecision.approvalId,
            previousPlanRevisionId: context.previousPlan.revisionId,
            notes: context.replanDecision.notes,
          },
        }
      : {}),
    provenance: {
      revisionId: context.revisionId,
      parentRevisionIds: [...new Set(parentRevisionIds)],
      sourceArtifactHashes: [...new Set(sourceArtifactHashes)],
      runId: context.runId,
      operation: context.operation,
      ...(context.provider ? { provider: context.provider } : {}),
      ...(context.model ? { model: context.model } : {}),
      createdAt: context.createdAt,
    },
  });
};

export class AssetPlanAmendmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssetPlanAmendmentError";
  }
}

export type AssetPlanAmendmentDiff = {
  addedAssetIds: string[];
  changedAssetIds: string[];
  removedAssetIds: string[];
};

export type AssetPlanAmendmentMaterializationContext =
  AssetPlanMaterializationContext & {
    operation: "asset-plan.amend";
    expectedOperation: "asset-plan.amend";
    previousPlan: RevisionRef;
    previousPlanDocument: AssetPlan;
    section: AssetPlanSection;
    frozenAssetIds: ReadonlySet<string>;
  };

const samePlannedAsset = (left: PlannedAsset, right: PlannedAsset): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

export const assetPlanAmendmentDiff = (
  currentPlan: AssetPlan,
  amendedPlan: AssetPlan,
): AssetPlanAmendmentDiff => {
  const current = new Map(
    currentPlan.assets.map((asset) => [asset.assetId, asset]),
  );
  const amended = new Map(
    amendedPlan.assets.map((asset) => [asset.assetId, asset]),
  );
  return {
    addedAssetIds: amendedPlan.assets
      .filter((asset) => !current.has(asset.assetId))
      .map((asset) => asset.assetId),
    changedAssetIds: amendedPlan.assets
      .filter((asset) => {
        const previous = current.get(asset.assetId);
        return previous !== undefined && !samePlannedAsset(previous, asset);
      })
      .map((asset) => asset.assetId),
    removedAssetIds: currentPlan.assets
      .filter((asset) => !amended.has(asset.assetId))
      .map((asset) => asset.assetId),
  };
};

/** Materializes the provider's complete draft, then applies the gate section
 * boundary and frozen-asset rule to the provider result. The model never gets
 * the last word on an asset that owns spend or approved references. */
export const materializeAssetPlanAmendment = (
  rawDraft: AssetPlanDraft,
  context: AssetPlanAmendmentMaterializationContext,
): { plan: AssetPlan; diff: AssetPlanAmendmentDiff } => {
  const candidate = materializeAssetPlan(rawDraft, context);
  const currentById = new Map(
    context.previousPlanDocument.assets.map((asset) => [asset.assetId, asset]),
  );
  const protectedIds = new Set(
    context.previousPlanDocument.assets.flatMap((asset) =>
      context.frozenAssetIds.has(asset.assetId) ||
      assetPlanSectionFor(asset) !== context.section
        ? [asset.assetId]
        : [],
    ),
  );
  const keptIds = new Set<string>();
  const safeAssets: PlannedAsset[] = [];

  for (const proposed of candidate.assets) {
    const current = currentById.get(proposed.assetId);
    if (!current) {
      if (assetPlanSectionFor(proposed) !== context.section) continue;
      safeAssets.push(proposed);
      keptIds.add(proposed.assetId);
      continue;
    }
    if (
      protectedIds.has(proposed.assetId) ||
      assetPlanSectionFor(proposed) !== context.section
    ) {
      safeAssets.push(current);
    } else {
      safeAssets.push(proposed);
    }
    keptIds.add(proposed.assetId);
  }

  for (const current of context.previousPlanDocument.assets) {
    if (!protectedIds.has(current.assetId) || keptIds.has(current.assetId))
      continue;
    safeAssets.push(current);
    keptIds.add(current.assetId);
  }

  let plan: AssetPlan;
  try {
    plan = AssetPlanSchema.parse({ ...candidate, assets: safeAssets });
  } catch (caught) {
    throw new AssetPlanAmendmentError(
      `The amendment could not preserve the current asset dependencies: ${caught instanceof Error ? caught.message : String(caught)}`,
    );
  }

  for (const assetId of context.frozenAssetIds) {
    const before = currentById.get(assetId);
    const after = plan.assets.find((asset) => asset.assetId === assetId);
    if (before && (!after || !samePlannedAsset(before, after)))
      throw new AssetPlanAmendmentError(
        `The amendment tried to change frozen asset ${assetId}.`,
      );
  }

  const diff = assetPlanAmendmentDiff(context.previousPlanDocument, plan);
  if (
    diff.addedAssetIds.length === 0 &&
    diff.changedAssetIds.length === 0 &&
    diff.removedAssetIds.length === 0
  )
    throw new AssetPlanAmendmentError(
      "The planner did not return a safe change for this section. The current plan was left untouched.",
    );
  return { plan, diff };
};

const approvalIssue = (
  binding: RevisionApprovalBinding,
  targetType: "game-design" | "concept-set",
  path: Array<string | number>,
): AssetPlanIssue | undefined => {
  const { approval, revision } = binding;
  if (
    approval.decision === "approved" &&
    approval.targetType === targetType &&
    approval.targetRevisionId === revision.revisionId &&
    approval.targetSha256 === revision.artifact.sha256
  ) {
    return undefined;
  }
  return {
    code: "source-approval-mismatch",
    message: `${targetType} approval does not bind to the supplied immutable revision.`,
    path,
  };
};

export const validateAssetPlanAgainstApprovedInputs = (
  plan: AssetPlan,
  inputs: AssetPlanValidationInputs,
): AssetPlanIssue[] => {
  const issues: AssetPlanIssue[] = [];
  const gdsAncestor = revisionAncestor(inputs.gameDesignSpec.revision);
  const conceptSetAncestor = revisionAncestor(inputs.conceptSet.revision);
  const gdsApprovalIssue = approvalIssue(inputs.gameDesignSpec, "game-design", [
    "gameDesignSpec",
    "approval",
  ]);
  const conceptSetApprovalIssue = approvalIssue(
    inputs.conceptSet,
    "concept-set",
    ["conceptSet", "approval"],
  );
  if (gdsApprovalIssue) issues.push(gdsApprovalIssue);
  if (conceptSetApprovalIssue) issues.push(conceptSetApprovalIssue);

  if (plan.assets.length > ASSET_PLAN_MAX_ASSETS) {
    issues.push({
      code: "plan-size-exceeded",
      message: `Asset plans may contain at most ${ASSET_PLAN_MAX_ASSETS} assets.`,
      path: ["assets"],
    });
  }
  if (!plan.assets.some((asset) => asset.classification === "hero")) {
    issues.push({
      code: "missing-hero",
      message: "The asset plan must contain at least one hero asset.",
      path: ["assets"],
    });
  }
  issues.push(
    ...assetPlanGraphIssues(plan.assets).map((issue) => ({
      ...issue,
      path: ["assets", ...issue.path],
    })),
  );

  const sourceHashes = new Set<string>([
    inputs.gameDesignSpec.revision.artifact.sha256,
    inputs.conceptSet.revision.artifact.sha256,
  ]);
  const sourceRevisionIds = new Set<string>([
    inputs.gameDesignSpec.revision.revisionId,
    inputs.conceptSet.revision.revisionId,
  ]);
  for (const { kept } of selectedConceptSlots(inputs)) {
    sourceHashes.add(kept.revision.artifact.sha256);
    sourceRevisionIds.add(kept.revision.revisionId);
    const concept = inputs.conceptDocuments[kept.revision.revisionId];
    if (
      !concept?.ancestors.some((ancestor) =>
        sameAncestor(ancestor, gdsAncestor),
      )
    ) {
      issues.push({
        code: "source-lineage-mismatch",
        message: `Selected concept ${kept.revision.revisionId} does not descend from the approved Game Design Spec.`,
        path: ["conceptDocuments", kept.revision.revisionId, "ancestors"],
      });
    }
  }

  plan.assets.forEach((asset, assetIndex) => {
    if (!sameAncestor(asset.sourceRefs.gameDesignSpec, gdsAncestor)) {
      issues.push({
        code: "source-approval-mismatch",
        message: `Asset ${asset.assetId} does not name the approved Game Design Spec.`,
        path: ["assets", assetIndex, "sourceRefs", "gameDesignSpec"],
        assetId: asset.assetId,
      });
    }
    if (!sameAncestor(asset.sourceRefs.conceptSet, conceptSetAncestor)) {
      issues.push({
        code: "source-approval-mismatch",
        message: `Asset ${asset.assetId} does not name the approved concept set.`,
        path: ["assets", assetIndex, "sourceRefs", "conceptSet"],
        assetId: asset.assetId,
      });
    }
    if (
      asset.classification === "hero" &&
      asset.sourceRefs.conceptSlots.length === 0
    ) {
      issues.push({
        code: "hero-without-kept-concept",
        message: `Hero asset ${asset.assetId} requires a kept concept revision.`,
        path: ["assets", assetIndex, "sourceRefs", "conceptSlots"],
        assetId: asset.assetId,
      });
    }

    asset.sourceRefs.conceptSlots.forEach((source, sourceIndex) => {
      const slot = inputs.conceptSetDocument.slots.find(
        (candidate) => candidate.slotId === source.slotId,
      );
      const kept = slot?.revisions.find(
        (candidate) =>
          candidate.revision.revisionId === slot.selectedRevisionId,
      );
      const expected = kept ? revisionAncestor(kept.revision) : undefined;
      if (
        !slot ||
        !kept ||
        kept.staleReason !== undefined ||
        !expected ||
        !sameAncestor(source.concept, expected)
      ) {
        issues.push({
          code: "concept-source-not-kept",
          message: `Concept source ${source.slotId} is not the exact selected, non-stale revision.`,
          path: [
            "assets",
            assetIndex,
            "sourceRefs",
            "conceptSlots",
            sourceIndex,
          ],
          assetId: asset.assetId,
          relatedAssetId: source.concept.revisionId,
        });
        return;
      }

      sourceHashes.add(kept.revision.artifact.sha256);
      sourceRevisionIds.add(kept.revision.revisionId);
    });
  });

  if (inputs.previousPlan) {
    sourceRevisionIds.add(inputs.previousPlan.revisionId);
    sourceHashes.add(inputs.previousPlan.artifact.sha256);
  }
  const provenanceMatches =
    plan.provenance.revisionId === inputs.expectedRevisionId &&
    plan.provenance.runId === inputs.runId &&
    plan.provenance.operation === inputs.expectedOperation &&
    sameStrings(plan.provenance.sourceArtifactHashes, [...sourceHashes]) &&
    sameStrings(plan.provenance.parentRevisionIds, [...sourceRevisionIds]) &&
    JSON.stringify(plan.handling) ===
      JSON.stringify(ASSET_CLASS_HANDLING_POLICIES_V1);
  if (!provenanceMatches) {
    issues.push({
      code: "provenance-mismatch",
      message:
        "Asset-plan provenance does not match the exact approved sources.",
      path: ["provenance"],
    });
  }

  return issues;
};

export type StructuredModelExecution = Pick<
  ModelExecution,
  "generateStructured"
>;

type AssetPlannerDependencies = {
  execution: StructuredModelExecution;
  now: () => string;
  revisionId: () => string;
};

type ResolvedPlanningDocuments = {
  gameDesignSpecDocument: GameDesignSpec;
  conceptSetDocument: ConceptSet;
  conceptDocuments: Record<string, M1ConceptDocument>;
  previousPlanDocument?: AssetPlan;
};

export interface AssetPlanning {
  plan(input: AssetPlanningInput): Promise<AssetPlanningOutcome>;
}

const hashText = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export const assetPlanIdempotencyKey = (input: AssetPlanningInput): string => {
  const previousPlan = input.replan?.previousPlan.artifact.sha256 ?? "initial";
  const changeNoteHash = hashText(input.replan?.decision.notes?.trim() ?? "");
  return [
    "asset-plan",
    input.projectId,
    input.gameDesignSpec.revision.artifact.sha256,
    input.conceptSet.revision.artifact.sha256,
    previousPlan,
    changeNoteHash,
    input.mode,
    input.orchestratorProvider,
  ].join(":");
};

const textReserveUsd = (): number => {
  const value = Number(process.env.FULCRUM_OPENAI_TEXT_RESERVE_USD ?? "0.25");
  return Number.isFinite(value) && value >= 0 ? value : 0.25;
};

const zodIssues = (error: z.ZodError): AssetPlanIssue[] =>
  error.issues.map((issue) => ({
    code: "invalid-structured-output",
    message: issue.message,
    path: issue.path.flatMap((segment) =>
      typeof segment === "string" || typeof segment === "number"
        ? [segment]
        : [],
    ),
  }));

const validateAssetPlanDraftWire = (
  draft: AssetPlanDraftWire,
):
  | { success: true; draft: AssetPlanDraft }
  | { success: false; issues: AssetPlanIssue[] } => {
  let mapped: AssetPlanDraft;
  try {
    mapped = mapAssetPlanDraftWire(draft);
  } catch (caught) {
    if (caught instanceof z.ZodError) {
      return { success: false, issues: zodIssues(caught) };
    }
    throw caught;
  }
  const parsed = AssetPlanDraftSchema.safeParse(mapped);
  return parsed.success
    ? { success: true, draft: parsed.data }
    : { success: false, issues: zodIssues(parsed.error) };
};

const failure = (
  code: AssetPlanFailure["code"],
  kind: AssetPlanFailure["kind"],
  message: string,
  issues: AssetPlanIssue[] = [],
): AssetPlanFailure =>
  AssetPlanFailureSchema.parse({ code, kind, message, issues });

const priorFailure = (payload: Record<string, unknown>): AssetPlanFailure => {
  const parsed = AssetPlanFailureSchema.safeParse(payload.failure);
  return parsed.success
    ? parsed.data
    : failure(
        "asset-plan-provider-failed",
        "user-action-required",
        "The prior asset-planning request failed and requires an explicit retry.",
      );
};

const eventMetrics = (plan: AssetPlan) => ({
  revisionId: plan.provenance.revisionId,
  sourceRevisionIds: plan.provenance.parentRevisionIds.filter(
    (revisionId) => revisionId !== plan.changeRequest?.previousPlanRevisionId,
  ),
  assetCount: plan.assets.length,
  edgeCount: plan.assets.reduce(
    (count, asset) => count + asset.dependsOnAssetIds.length,
    0,
  ),
  classCounts: {
    hero: plan.assets.filter((asset) => asset.classification === "hero").length,
    kit: plan.assets.filter((asset) => asset.classification === "kit").length,
    procedural: plan.assets.filter(
      (asset) => asset.classification === "procedural",
    ).length,
    functional: plan.assets.filter(
      (asset) => asset.classification === "functional",
    ).length,
  },
});

class AssetPlannerImplementation implements AssetPlanning {
  constructor(
    private readonly repository: ProjectRepository,
    private readonly dependencies: AssetPlannerDependencies,
  ) {}

  async plan(rawInput: AssetPlanningInput): Promise<AssetPlanningOutcome> {
    const parsed = AssetPlanningInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      const requestId = `invalid-${hashText(JSON.stringify(rawInput))}`;
      return {
        status: "failed",
        requestId,
        error: failure(
          "asset-plan-invalid-input",
          "user-action-required",
          "Asset planning requires exact approved Game Design Spec and concept-set revisions.",
          zodIssues(parsed.error),
        ),
      };
    }
    const input = parsed.data;
    const idempotencyKey = assetPlanIdempotencyKey(input);
    const existing = this.repository.getSubmissionByKey(idempotencyKey);
    if (existing?.status === "ready" && existing.resultRevisionId) {
      return {
        status: "ready",
        requestId: existing.requestId,
        value: this.repository.getRevision(existing.resultRevisionId),
      };
    }
    if (existing?.status === "failed") {
      return {
        status: "failed",
        requestId: existing.requestId,
        error: priorFailure(existing.payload),
      };
    }
    if (existing?.status === "submission-unknown") {
      return {
        status: "failed",
        requestId: existing.requestId,
        error: failure(
          "asset-plan-submission-unknown",
          "user-action-required",
          "The live planning submission may have completed; Fulcrum will not spend again automatically.",
        ),
      };
    }
    if (
      existing &&
      input.mode === "live" &&
      typeof existing.payload.providerCallStartedAt === "string"
    ) {
      const error = failure(
        "asset-plan-submission-unknown",
        "user-action-required",
        "The live planning submission was interrupted after the provider call started.",
      );
      this.repository.updateSubmission(existing.requestId, {
        status: "submission-unknown",
        payload: { ...existing.payload, failure: error },
      });
      this.appendFailure(input, existing.requestId, error);
      return { status: "failed", requestId: existing.requestId, error };
    }

    const submission =
      existing ??
      this.repository.recordSubmissionIntent({
        projectId: input.projectId,
        operation: input.replan ? "asset-plan.replan" : "asset-plan.initial",
        provider:
          input.mode === "replay"
            ? "fulcrum-replay"
            : input.orchestratorProvider,
        idempotencyKey,
        payload: {
          revisionId: this.dependencies.revisionId(),
          createdAt: this.dependencies.now(),
          mode: input.mode,
        },
      });
    const revisionId =
      typeof submission.payload.revisionId === "string"
        ? submission.payload.revisionId
        : this.dependencies.revisionId();
    const createdAt =
      typeof submission.payload.createdAt === "string"
        ? submission.payload.createdAt
        : this.dependencies.now();

    const resolved = this.resolveDocuments(input);
    if (resolved.issues.length > 0 || !resolved.documents) {
      const error = failure(
        "asset-plan-invalid-input",
        "user-action-required",
        "The approved planning inputs or selected concept lineage are invalid.",
        resolved.issues,
      );
      this.repository.updateSubmission(submission.requestId, {
        status: "failed",
        payload: { ...submission.payload, failure: error },
      });
      this.appendFailure(input, submission.requestId, error);
      return { status: "failed", requestId: submission.requestId, error };
    }

    const operation = input.replan
      ? ("asset-plan.replan" as const)
      : ("asset-plan.initial" as const);
    let draft: AssetPlanDraft;
    let model: string | undefined;
    if (input.mode === "replay") {
      try {
        draft = deriveReplayAssetPlanDraft({
          ...input,
          ...resolved.documents,
          expectedRevisionId: revisionId,
          expectedOperation: operation,
          ...(input.replan
            ? {
                previousPlan: input.replan.previousPlan,
                replanDecision: input.replan.decision,
              }
            : {}),
        });
      } catch (caught) {
        const error = failure(
          "asset-plan-invalid-input",
          "user-action-required",
          caught instanceof Error ? caught.message : String(caught),
        );
        this.repository.updateSubmission(submission.requestId, {
          status: "failed",
          payload: { ...submission.payload, failure: error },
        });
        this.appendFailure(input, submission.requestId, error);
        return { status: "failed", requestId: submission.requestId, error };
      }
    } else {
      const live = await this.generateLiveDraft(
        input,
        submission,
        resolved.documents,
      );
      if (live.status === "failed") return live.outcome;
      draft = live.draft;
      model = live.model;
    }

    let plan: AssetPlan;
    try {
      plan = materializeAssetPlan(draft, {
        ...input,
        ...resolved.documents,
        expectedRevisionId: revisionId,
        expectedOperation: operation,
        revisionId,
        createdAt,
        operation,
        ...(input.replan
          ? {
              previousPlan: input.replan.previousPlan,
              replanDecision: input.replan.decision,
            }
          : {}),
        ...(input.mode === "live"
          ? {
              provider: input.orchestratorProvider,
              ...(model ? { model } : {}),
            }
          : {}),
      });
    } catch (caught) {
      const issues = caught instanceof z.ZodError ? zodIssues(caught) : [];
      return this.failOutput(
        input,
        submission.requestId,
        submission.payload,
        caught instanceof Error ? caught.message : String(caught),
        issues,
      );
    }

    const validationIssues = validateAssetPlanAgainstApprovedInputs(plan, {
      ...input,
      ...resolved.documents,
      expectedRevisionId: revisionId,
      expectedOperation: operation,
      ...(input.replan ? { previousPlan: input.replan.previousPlan } : {}),
    });
    if (validationIssues.length > 0) {
      return this.failOutput(
        input,
        submission.requestId,
        submission.payload,
        "The materialized asset plan failed approved-input validation.",
        validationIssues,
      );
    }

    const writeRevision = this.repository.writeRevision.bind(
      this.repository,
    ) as <T>(input: {
      projectId: string;
      entityId: string;
      kind: string;
      value: T;
      runId: string;
      revisionId?: string;
      createdAt?: string;
    }) => RevisionRef;
    const revision = writeRevision({
      projectId: input.projectId,
      entityId: `${input.projectId}:asset-plan`,
      kind: "asset-plan",
      value: plan,
      runId: input.runId,
      revisionId,
      createdAt,
    });
    const current =
      this.repository.getSubmissionByKey(idempotencyKey) ?? submission;
    this.repository.updateSubmission(submission.requestId, {
      status: "ready",
      resultRevisionId: revision.revisionId,
      payload: {
        ...current.payload,
        revisionId,
        createdAt,
        ...(model ? { model } : {}),
      },
    });
    this.repository.appendEvent({
      projectId: input.projectId,
      runId: input.runId,
      type: input.replan ? "asset-plan.replanned" : "asset-plan.created",
      payload: {
        ...eventMetrics(plan),
        revisionId: revision.revisionId,
        hash: revision.artifact.sha256,
        mode: input.mode,
      },
    });
    return {
      status: "ready",
      requestId: submission.requestId,
      value: revision,
    };
  }

  private resolveDocuments(input: AssetPlanningInput): {
    documents?: ResolvedPlanningDocuments;
    issues: AssetPlanIssue[];
  } {
    try {
      const gameDesignSpecDocument = GameDesignSpecSchema.parse(
        this.repository.resolveRevision(input.gameDesignSpec.revision),
      );
      const conceptSetDocument = ConceptSetSchema.parse(
        this.repository.resolveRevision(input.conceptSet.revision),
      );
      const conceptDocuments: Record<string, M1ConceptDocument> = {};
      const issues: AssetPlanIssue[] = [];
      for (const [slotIndex, slot] of conceptSetDocument.slots.entries()) {
        const kept = slot.revisions.find(
          (candidate) =>
            candidate.revision.revisionId === slot.selectedRevisionId,
        );
        if (!kept || kept.staleReason !== undefined) {
          issues.push({
            code: "concept-source-not-kept",
            message: `Concept slot ${slot.slotId} has no selected, non-stale revision.`,
            path: ["conceptSet", "slots", slotIndex],
          });
          continue;
        }
        const stored = this.repository.getRevision(kept.revision.revisionId);
        if (stored.artifact.sha256 !== kept.revision.artifact.sha256) {
          issues.push({
            code: "concept-source-not-kept",
            message: `Concept slot ${slot.slotId} does not bind to its stored revision hash.`,
            path: ["conceptSet", "slots", slotIndex, "revisions"],
          });
          continue;
        }
        const document = M1ConceptDocumentSchema.parse(
          this.repository.resolveRevision(stored),
        );
        conceptDocuments[stored.revisionId] = document;
        if (
          !document.ancestors.some(
            (ancestor) =>
              ancestor.revisionId ===
                input.gameDesignSpec.revision.revisionId &&
              ancestor.sha256 ===
                input.gameDesignSpec.revision.artifact.sha256 &&
              ancestor.kind === input.gameDesignSpec.revision.kind,
          )
        ) {
          issues.push({
            code: "source-lineage-mismatch",
            message: `Selected concept ${stored.revisionId} does not descend from the approved Game Design Spec.`,
            path: ["conceptDocuments", stored.revisionId, "ancestors"],
          });
        }
      }
      const previousPlanDocument = input.replan
        ? AssetPlanSchema.parse(
            this.repository.resolveRevision(input.replan.previousPlan),
          )
        : undefined;
      return {
        documents: {
          gameDesignSpecDocument,
          conceptSetDocument,
          conceptDocuments,
          ...(previousPlanDocument ? { previousPlanDocument } : {}),
        },
        issues,
      };
    } catch (caught) {
      return {
        issues: [
          {
            code: "invalid-structured-output",
            message: caught instanceof Error ? caught.message : String(caught),
            path: ["inputs"],
          },
        ],
      };
    }
  }

  private async generateLiveDraft(
    input: AssetPlanningInput,
    submission: ReturnType<ProjectRepository["recordSubmissionIntent"]>,
    documents: ResolvedPlanningDocuments,
  ): Promise<
    | { status: "ready"; draft: AssetPlanDraft; model: string }
    | { status: "failed"; outcome: AssetPlanningOutcome }
  > {
    const {
      failure: _failure,
      preflightCode: _preflightCode,
      error: _priorError,
      ...cleanPayload
    } = submission.payload;
    this.repository.updateSubmission(submission.requestId, {
      status: "pending",
      payload: cleanPayload,
    });
    if (
      input.orchestratorProvider === "openai-api" &&
      submission.payload.budgetReserved !== true
    ) {
      try {
        this.repository.reserveBudget(
          input.projectId,
          textReserveUsd(),
          "Asset-plan structured generation",
        );
      } catch (caught) {
        if (!isProviderPreflightError(caught)) throw caught;
        const error = failure(
          "asset-plan-provider-failed",
          "user-action-required",
          caught.message,
        );
        this.repository.updateSubmission(submission.requestId, {
          status: "intent-recorded",
          payload: {
            ...cleanPayload,
            preflightCode: caught.code,
            error: caught.message,
            failure: error,
          },
        });
        this.appendFailure(input, submission.requestId, error);
        return {
          status: "failed",
          outcome: { status: "failed", requestId: submission.requestId, error },
        };
      }
    }
    const pending = this.repository.updateSubmission(submission.requestId, {
      status: "pending",
      payload: {
        ...cleanPayload,
        ...(input.orchestratorProvider === "openai-api"
          ? { budgetReserved: true }
          : {}),
        providerCallStartedAt: this.dependencies.now(),
      },
    });
    try {
      const selectedSummaries = documents.conceptSetDocument.slots.flatMap(
        (slot) => {
          const kept = slot.revisions.find(
            (candidate) =>
              candidate.revision.revisionId === slot.selectedRevisionId,
          );
          const document = kept
            ? documents.conceptDocuments[kept.revision.revisionId]
            : undefined;
          return kept && document
            ? [
                {
                  slotId: slot.slotId,
                  name: slot.name,
                  purpose: slot.purpose,
                  conceptName: document.name,
                  promptSummary: document.prompt.slice(0, 500),
                },
              ]
            : [];
        },
      );
      const systemPrompt =
        "Create a compact asset-plan draft. Return no lineage, policy, provenance, or final IDs. Asset keys must be unique; dependsOnAssetKeys may only reference assetKeys present in this draft and must stay acyclic; sourceConceptSlotIds may only use the supplied slot IDs. Set poseMode on every clearly humanoid character the game animates — playable characters, humanoid NPCs, and humanoid enemies — preferring a-pose, because that is what a rigger expects. Omit poseMode for props, kits, vehicles, creatures that are not bipedal, and anything that never moves.";
      const prompt = JSON.stringify({
        gameDesignSpec: documents.gameDesignSpecDocument,
        selectedConcepts: selectedSummaries,
        ...(input.replan
          ? {
              previousPlan: documents.previousPlanDocument,
              changeRequest: input.replan.decision.notes,
            }
          : {}),
      });
      let validationIssues: AssetPlanIssue[] = [];
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const generated = await this.dependencies.execution.generateStructured({
          provider: input.orchestratorProvider,
          cwd: process.env.FULCRUM_REPOSITORY_ROOT ?? process.cwd(),
          systemPrompt:
            attempt === 1
              ? systemPrompt
              : `${systemPrompt}\n\nCorrection required. The previous draft failed validation with these issues: ${JSON.stringify(validationIssues)}. Correct every issue and return a corrected complete draft.`,
          prompt,
          schema: AssetPlanDraftWireSchema,
        });
        const validated = validateAssetPlanDraftWire(generated.value);
        if (validated.success) {
          return {
            status: "ready",
            draft: validated.draft,
            model: generated.model,
          };
        }
        validationIssues = validated.issues;
      }
      return {
        status: "failed",
        outcome: this.failOutput(
          input,
          submission.requestId,
          pending.payload,
          "The orchestrator returned an invalid asset-plan draft.",
          validationIssues,
        ),
      };
    } catch (caught) {
      const error = failure(
        "asset-plan-submission-unknown",
        "user-action-required",
        caught instanceof Error ? caught.message : String(caught),
      );
      this.repository.updateSubmission(submission.requestId, {
        status: "submission-unknown",
        payload: { ...pending.payload, failure: error },
      });
      this.appendFailure(input, submission.requestId, error);
      return {
        status: "failed",
        outcome: { status: "failed", requestId: submission.requestId, error },
      };
    }
  }

  private failOutput(
    input: AssetPlanningInput,
    requestId: string,
    payload: Record<string, unknown>,
    message: string,
    issues: AssetPlanIssue[],
  ): AssetPlanningOutcome {
    const error = failure(
      "asset-plan-invalid-output",
      "strategy-changing",
      message,
      issues,
    );
    this.repository.updateSubmission(requestId, {
      status: "failed",
      payload: { ...payload, failure: error },
    });
    this.appendFailure(input, requestId, error);
    return { status: "failed", requestId, error };
  }

  private appendFailure(
    input: AssetPlanningInput,
    requestId: string,
    error: AssetPlanFailure,
  ): void {
    this.repository.appendEvent({
      projectId: input.projectId,
      runId: input.runId,
      type: "asset-plan.failed",
      payload: {
        requestId,
        failureCode: error.code,
        kind: error.kind,
        issueCodes: error.issues.map((issue) => issue.code),
      },
    });
  }
}

const defaultDependencies = (): AssetPlannerDependencies => ({
  execution: new ModelExecution(),
  now: () => new Date().toISOString(),
  revisionId: randomUUID,
});

export class AssetPlanner extends AssetPlannerImplementation {
  constructor(repository: ProjectRepository) {
    super(repository, defaultDependencies());
  }
}

export const createAssetPlannerForTest = (
  repository: ProjectRepository,
  dependencies: AssetPlannerDependencies,
): AssetPlanning => new AssetPlannerImplementation(repository, dependencies);

const AssetPlanAmendmentRequestSchema = AmendAssetPlanInputSchema.extend({
  projectId: z.string().min(1),
});

export type AssetPlanAmendmentRequest = z.infer<
  typeof AssetPlanAmendmentRequestSchema
>;

export type AssetPlanAmendmentResult = AssetPlanAmendmentDiff & {
  fromRevision: RevisionRef;
  toRevision: RevisionRef;
  plan: AssetPlan;
};

export interface AssetPlanAmending {
  amend(input: AssetPlanAmendmentRequest): Promise<AssetPlanAmendmentResult>;
}

type ResolvedAssetPlanAmendment = {
  input: AssetPlanAmendmentRequest;
  planningInput: AssetPlanningInput;
  currentPlanRevision: RevisionRef;
  currentPlan: AssetPlan;
  gameDesignSpecDocument: GameDesignSpec;
  conceptSetDocument: ConceptSet;
  conceptDocuments: Record<string, M1ConceptDocument>;
  frozenAssetIds: Set<string>;
};

export const assetPlanAmendmentIdempotencyKey = (input: {
  projectId: string;
  currentPlan: RevisionRef;
  section: AssetPlanSection;
  request: string;
  mode: AssetPlanningInput["mode"];
  orchestratorProvider: AssetPlanningInput["orchestratorProvider"];
}): string =>
  [
    "asset-plan-amend",
    input.projectId,
    input.currentPlan.artifact.sha256,
    input.section,
    hashText(input.request.trim()),
    input.mode,
    input.orchestratorProvider,
  ].join(":");

const amendmentFailureMessage = (payload: Record<string, unknown>): string =>
  typeof payload.error === "string"
    ? payload.error
    : "The prior asset-plan amendment failed. The current plan was left untouched.";

class AssetPlanAmenderImplementation implements AssetPlanAmending {
  constructor(
    private readonly repository: ProjectRepository,
    private readonly dependencies: AssetPlannerDependencies,
  ) {}

  async amend(
    rawInput: AssetPlanAmendmentRequest,
  ): Promise<AssetPlanAmendmentResult> {
    const input = AssetPlanAmendmentRequestSchema.parse(rawInput);
    const resolved = this.resolve(input);
    const idempotencyKey = assetPlanAmendmentIdempotencyKey({
      projectId: input.projectId,
      currentPlan: resolved.currentPlanRevision,
      section: input.section,
      request: input.request,
      mode: resolved.planningInput.mode,
      orchestratorProvider: resolved.planningInput.orchestratorProvider,
    });
    const existing = this.repository.getSubmissionByKey(idempotencyKey);
    if (existing?.status === "ready" && existing.resultRevisionId) {
      const toRevision = this.repository.getRevision(existing.resultRevisionId);
      const plan = AssetPlanSchema.parse(
        this.repository.resolveRevision(toRevision),
      );
      return {
        fromRevision: resolved.currentPlanRevision,
        toRevision,
        plan,
        ...assetPlanAmendmentDiff(resolved.currentPlan, plan),
      };
    }
    if (existing?.status === "failed")
      throw new AssetPlanAmendmentError(
        amendmentFailureMessage(existing.payload),
      );
    if (
      existing?.status === "submission-unknown" ||
      (existing &&
        resolved.planningInput.mode === "live" &&
        typeof existing.payload.providerCallStartedAt === "string")
    )
      throw new AssetPlanAmendmentError(
        "The live amendment may have reached the planner provider. Fulcrum left the asset plan unchanged and will not submit it again automatically.",
      );

    const submission =
      existing ??
      this.repository.recordSubmissionIntent({
        projectId: input.projectId,
        operation: "asset-plan.amend",
        provider:
          resolved.planningInput.mode === "replay"
            ? "fulcrum-replay"
            : resolved.planningInput.orchestratorProvider,
        idempotencyKey,
        payload: {
          revisionId: this.dependencies.revisionId(),
          createdAt: this.dependencies.now(),
          section: input.section,
          request: input.request,
          fromRevisionId: resolved.currentPlanRevision.revisionId,
          mode: resolved.planningInput.mode,
        },
      });
    const revisionId =
      typeof submission.payload.revisionId === "string"
        ? submission.payload.revisionId
        : this.dependencies.revisionId();
    const createdAt =
      typeof submission.payload.createdAt === "string"
        ? submission.payload.createdAt
        : this.dependencies.now();

    let draft: AssetPlanDraft;
    let model: string | undefined;
    if (resolved.planningInput.mode === "replay") {
      try {
        draft = deriveReplayAssetPlanAmendmentDraft({
          projectId: input.projectId,
          currentPlan: resolved.currentPlan,
          section: input.section,
          request: input.request,
          seed: resolved.currentPlanRevision.artifact.sha256,
        });
      } catch (caught) {
        return this.fail(
          submission.requestId,
          submission.payload,
          caught instanceof Error ? caught.message : String(caught),
        );
      }
    } else {
      const generated = await this.generateLiveDraft(resolved, submission);
      draft = generated.draft;
      model = generated.model;
    }

    let materialized: { plan: AssetPlan; diff: AssetPlanAmendmentDiff };
    try {
      materialized = materializeAssetPlanAmendment(draft, {
        ...resolved.planningInput,
        gameDesignSpecDocument: resolved.gameDesignSpecDocument,
        conceptSetDocument: resolved.conceptSetDocument,
        conceptDocuments: resolved.conceptDocuments,
        expectedRevisionId: revisionId,
        expectedOperation: "asset-plan.amend",
        previousPlan: resolved.currentPlanRevision,
        previousPlanDocument: resolved.currentPlan,
        revisionId,
        createdAt,
        operation: "asset-plan.amend",
        section: input.section,
        frozenAssetIds: resolved.frozenAssetIds,
        ...(resolved.planningInput.mode === "live"
          ? {
              provider: resolved.planningInput.orchestratorProvider,
              ...(model ? { model } : {}),
            }
          : {}),
      });
    } catch (caught) {
      return this.fail(
        submission.requestId,
        submission.payload,
        caught instanceof Error ? caught.message : String(caught),
      );
    }

    const validationIssues = validateAssetPlanAgainstApprovedInputs(
      materialized.plan,
      {
        ...resolved.planningInput,
        conceptSetDocument: resolved.conceptSetDocument,
        conceptDocuments: resolved.conceptDocuments,
        expectedRevisionId: revisionId,
        expectedOperation: "asset-plan.amend",
        previousPlan: resolved.currentPlanRevision,
      },
    );
    if (validationIssues.length > 0)
      return this.fail(
        submission.requestId,
        submission.payload,
        `The amended plan failed approved-input validation: ${validationIssues
          .map(({ message }) => message)
          .join(" ")}`,
      );

    const latest = this.repository.getProject(input.projectId);
    if (
      latest.assetPlan?.revisionId !==
        resolved.currentPlanRevision.revisionId ||
      latest.assetPlan?.artifact.sha256 !==
        resolved.currentPlanRevision.artifact.sha256
    )
      return this.fail(
        submission.requestId,
        submission.payload,
        "The asset plan changed while this amendment was running. No amendment was applied.",
      );

    const toRevision = this.repository.writeRevision({
      projectId: input.projectId,
      entityId: `${input.projectId}:asset-plan`,
      kind: "asset-plan",
      value: materialized.plan,
      runId: resolved.planningInput.runId,
      revisionId,
      createdAt,
    });
    this.repository.updateSubmission(submission.requestId, {
      status: "ready",
      resultRevisionId: toRevision.revisionId,
      payload: {
        ...submission.payload,
        revisionId,
        createdAt,
        ...(model ? { model } : {}),
      },
    });
    return {
      fromRevision: resolved.currentPlanRevision,
      toRevision,
      plan: materialized.plan,
      ...materialized.diff,
    };
  }

  private resolve(
    input: AssetPlanAmendmentRequest,
  ): ResolvedAssetPlanAmendment {
    const state = this.repository.getProject(input.projectId);
    if (state.milestone !== "m2" || state.stage !== "asset-batch")
      throw new AssetPlanAmendmentError(
        "Asset-plan sections can only be amended from the staged asset gate.",
      );
    if (!state.assetPlan)
      throw new AssetPlanAmendmentError(
        "This project has no asset plan to amend.",
      );
    const finalized = FinalizedAssetPlanBindingSchema.safeParse({
      projectId: input.projectId,
      plan: state.assetPlan,
      finalization: state.assetPlanApproval,
    });
    if (!finalized.success)
      throw new AssetPlanAmendmentError(
        "The current asset plan is not hash-bound to an approved finalization.",
      );
    const planningInput = AssetPlanningInputSchema.parse({
      projectId: input.projectId,
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
          ? { revision: state.conceptSet, approval: state.conceptSetApproval }
          : undefined,
    });
    const gameDesignSpecDocument = GameDesignSpecSchema.parse(
      this.repository.resolveRevision(planningInput.gameDesignSpec.revision),
    );
    const conceptSetDocument = ConceptSetSchema.parse(
      this.repository.resolveRevision(planningInput.conceptSet.revision),
    );
    const conceptDocuments: Record<string, M1ConceptDocument> = {};
    for (const slot of conceptSetDocument.slots) {
      const kept = slot.revisions.find(
        ({ revision }) => revision.revisionId === slot.selectedRevisionId,
      );
      if (!kept || kept.staleReason)
        throw new AssetPlanAmendmentError(
          `Concept slot ${slot.slotId} has no selected, non-stale revision.`,
        );
      const stored = this.repository.getRevision(kept.revision.revisionId);
      if (stored.artifact.sha256 !== kept.revision.artifact.sha256)
        throw new AssetPlanAmendmentError(
          `Concept slot ${slot.slotId} does not bind to its stored revision hash.`,
        );
      conceptDocuments[stored.revisionId] = M1ConceptDocumentSchema.parse(
        this.repository.resolveRevision(stored),
      );
    }
    const currentPlan = AssetPlanSchema.parse(
      this.repository.resolveRevision(state.assetPlan),
    );
    const currentAssetIds = new Set(
      currentPlan.assets.map(({ assetId }) => assetId),
    );
    const frozenAssetIds = new Set([
      ...Object.entries(state.assetStages ?? {}).flatMap(([assetId, stage]) =>
        stage.runs.length > 0 && currentAssetIds.has(assetId) ? [assetId] : [],
      ),
      ...Object.keys(state.assetReferenceSets ?? {}).filter((assetId) =>
        currentAssetIds.has(assetId),
      ),
    ]);
    return {
      input,
      planningInput,
      currentPlanRevision: state.assetPlan,
      currentPlan,
      gameDesignSpecDocument,
      conceptSetDocument,
      conceptDocuments,
      frozenAssetIds,
    };
  }

  private async generateLiveDraft(
    resolved: ResolvedAssetPlanAmendment,
    submission: ReturnType<ProjectRepository["recordSubmissionIntent"]>,
  ): Promise<{ draft: AssetPlanDraft; model: string }> {
    const { input, planningInput, currentPlan, frozenAssetIds } = resolved;
    const {
      error: _priorError,
      providerCallStartedAt: _priorProviderCallStartedAt,
      ...cleanPayload
    } = submission.payload;
    this.repository.updateSubmission(submission.requestId, {
      status: "pending",
      payload: cleanPayload,
    });
    if (
      planningInput.orchestratorProvider === "openai-api" &&
      submission.payload.budgetReserved !== true
    ) {
      try {
        this.repository.reserveBudget(
          input.projectId,
          textReserveUsd(),
          "Asset-plan section amendment",
        );
      } catch (caught) {
        if (!isProviderPreflightError(caught)) throw caught;
        this.repository.updateSubmission(submission.requestId, {
          status: "intent-recorded",
          payload: { ...cleanPayload, error: caught.message },
        });
        throw caught;
      }
    }
    const pending = this.repository.updateSubmission(submission.requestId, {
      status: "pending",
      payload: {
        ...cleanPayload,
        ...(planningInput.orchestratorProvider === "openai-api"
          ? { budgetReserved: true }
          : {}),
        providerCallStartedAt: this.dependencies.now(),
      },
    });
    const selectedConcepts = resolved.conceptSetDocument.slots.flatMap(
      (slot) => {
        const kept = slot.revisions.find(
          ({ revision }) => revision.revisionId === slot.selectedRevisionId,
        );
        const document = kept
          ? resolved.conceptDocuments[kept.revision.revisionId]
          : undefined;
        return document
          ? [
              {
                slotId: slot.slotId,
                name: slot.name,
                purpose: slot.purpose,
                conceptName: document.name,
                promptSummary: document.prompt.slice(0, 500),
              },
            ]
          : [];
      },
    );
    const systemPrompt = [
      "Return one complete amended asset-plan draft using the same wire schema as initial planning.",
      `The request is scoped only to the ${input.section} gate section. Preserve every asset outside that section exactly and do not add assets to another section.`,
      "Reuse every existing assetKey for an existing asset. An unchanged asset must keep the same assetKey so its final asset ID stays stable.",
      "Frozen assets have a recorded staged run or an approved reference set. Keep every frozen asset present and byte-for-byte unchanged: do not rename, remove, reclassify, alter its rationale, sources, dependencies, pose, procedure, or acceptance criteria.",
      "New assets are unresolved plan slots only. Do not request, schedule or claim any Meshy task, image generation, reference approval or other spend.",
      "Asset keys must be unique; dependsOnAssetKeys may only reference assetKeys present in this draft and must stay acyclic; sourceConceptSlotIds may only use the supplied slot IDs.",
      "Set poseMode on every clearly humanoid character the game animates, preferring a-pose. Omit poseMode for props, kits, environments, vehicles, non-biped creatures and anything that never moves.",
    ].join(" ");
    const prompt = JSON.stringify({
      section: input.section,
      request: input.request,
      currentPlan,
      currentDraft: draftFromPreviousPlan(input.projectId, currentPlan),
      frozenAssetIds: [...frozenAssetIds],
      frozenAssets: currentPlan.assets.filter(({ assetId }) =>
        frozenAssetIds.has(assetId),
      ),
      selectedConcepts,
    });
    let validationIssues: AssetPlanIssue[] = [];
    try {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const generated = await this.dependencies.execution.generateStructured({
          provider: planningInput.orchestratorProvider,
          cwd: process.env.FULCRUM_REPOSITORY_ROOT ?? process.cwd(),
          systemPrompt:
            attempt === 1
              ? systemPrompt
              : `${systemPrompt}\n\nCorrection required. The prior draft failed schema validation with these issues: ${JSON.stringify(validationIssues)}. Return a corrected complete draft.`,
          prompt,
          schema: AssetPlanDraftWireSchema,
        });
        const validated = validateAssetPlanDraftWire(generated.value);
        if (validated.success)
          return {
            draft: validated.draft,
            model: generated.model,
          };
        validationIssues = validated.issues;
      }
      return this.fail(
        submission.requestId,
        pending.payload,
        `The planner returned an invalid amendment: ${validationIssues
          .map(({ message }) => message)
          .join(" ")}`,
      );
    } catch (caught) {
      if (caught instanceof AssetPlanAmendmentError) throw caught;
      const message = caught instanceof Error ? caught.message : String(caught);
      this.repository.updateSubmission(submission.requestId, {
        status: "submission-unknown",
        payload: { ...pending.payload, error: message },
      });
      throw new AssetPlanAmendmentError(
        `The live planner request was interrupted. Fulcrum left the asset plan unchanged. ${message}`,
      );
    }
  }

  private fail(
    requestId: string,
    payload: Record<string, unknown>,
    message: string,
  ): never {
    this.repository.updateSubmission(requestId, {
      status: "failed",
      payload: { ...payload, error: message },
    });
    throw new AssetPlanAmendmentError(message);
  }
}

export class AssetPlanAmender extends AssetPlanAmenderImplementation {
  constructor(
    repository: ProjectRepository,
    execution: StructuredModelExecution = new ModelExecution(),
  ) {
    super(repository, {
      ...defaultDependencies(),
      execution,
    });
  }
}

export const createAssetPlanAmenderForTest = (
  repository: ProjectRepository,
  dependencies: AssetPlannerDependencies,
): AssetPlanAmending =>
  new AssetPlanAmenderImplementation(repository, dependencies);
