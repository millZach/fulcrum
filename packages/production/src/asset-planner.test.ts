import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ASSET_CLASS_HANDLING_POLICIES_V1,
  AssetPlanSchema,
  type ApprovalDecision,
  type AssetPlan,
  type AssetPlanningInput,
  type ConceptSet,
  type GameDesignSpec,
  type M1ConceptDocument,
  type RevisionRef,
} from "@fulcrum/domain";
import { assertStrictCompatibleJsonSchema } from "@fulcrum/execution";
import { ProjectRepository } from "@fulcrum/project";
import { z } from "zod";

import {
  AssetPlanDraftSchema,
  AssetPlanDraftWireSchema,
  mapAssetPlanDraftWire,
  type AssetPlanDraft,
  type AssetPlanDraftWire,
  type AssetPlanValidationInputs,
  type StructuredModelExecution,
  assetPlanIdempotencyKey,
  createAssetPlannerForTest,
  deriveReplayAssetPlanAmendmentDraft,
  deriveReplayAssetPlanDraft,
  materializeAssetPlanAmendment,
  materializeAssetPlan,
  validateAssetPlanAgainstApprovedInputs,
} from "./asset-planner.js";

describe("asset-plan live JSON Schema", () => {
  it("AssetPlanDraftWireSchema is OpenAI strict-compatible", () => {
    const jsonSchema = z.toJSONSchema(AssetPlanDraftWireSchema);
    expect(() => assertStrictCompatibleJsonSchema(jsonSchema)).not.toThrow();
    const required = [
      "assetKey",
      "name",
      "classification",
      "rationale",
      "sourceConceptSlotIds",
      "dependsOnAssetKeys",
      "poseMode",
      "procedure",
      "acceptanceCriteria",
    ];
    expect(jsonSchema).toMatchObject({
      properties: {
        assets: {
          items: {
            anyOf: [
              { additionalProperties: false, required },
              { additionalProperties: false, required },
            ],
          },
        },
      },
    });
  });

  it("rejects a procedural wire asset with a null procedure", () => {
    const wire = proceduralWireDraft();

    expect(
      AssetPlanDraftWireSchema.safeParse({
        assets: [{ ...wire.assets[0], procedure: null }],
      }).success,
    ).toBe(false);
  });
});

const timestamp = "2026-08-24T12:00:00.000Z";
const roots: string[] = [];

const proceduralWireDraft = (
  parameters: NonNullable<
    AssetPlanDraftWire["assets"][number]["procedure"]
  >["parameters"] = [
    { name: "segments", value: 12 },
    { name: "capped", value: true },
  ],
): AssetPlanDraftWire => ({
  assets: [
    {
      assetKey: "arena-columns",
      name: "Arena Columns",
      classification: "procedural",
      rationale: "Repeated columns are generated from one approved profile.",
      sourceConceptSlotIds: ["gameplay-anchor"],
      dependsOnAssetKeys: [],
      poseMode: null,
      procedure: {
        generatorId: "radial-columns-v1",
        parameters,
      },
      acceptanceCriteria: ["Columns preserve the approved profile."],
    },
  ],
});

describe("mapAssetPlanDraftWire", () => {
  it("folds wire parameter entries into the domain record", () => {
    const mapped = mapAssetPlanDraftWire(
      AssetPlanDraftWireSchema.parse(proceduralWireDraft()),
    );

    expect(mapped.assets[0]?.procedure).toEqual({
      generatorId: "radial-columns-v1",
      parameters: { segments: 12, capped: true },
    });
    expect(AssetPlanDraftSchema.parse(mapped)).toEqual(mapped);
  });

  it("maps a non-procedural wire variant without a domain procedure", () => {
    const wire = proceduralWireDraft();
    const parsed = AssetPlanDraftWireSchema.parse({
      assets: [
        {
          ...wire.assets[0]!,
          classification: "hero",
          procedure: null,
        },
      ],
    });

    expect(mapAssetPlanDraftWire(parsed).assets[0]).not.toHaveProperty(
      "procedure",
    );
  });

  it("rejects duplicate parameter names with their wire issue path", () => {
    const wire = proceduralWireDraft([
      { name: "segments", value: 12 },
      { name: "segments", value: 16 },
    ]);

    try {
      mapAssetPlanDraftWire(wire);
      throw new Error("Expected duplicate parameters to be rejected.");
    } catch (error) {
      expect(error).toBeInstanceOf(z.ZodError);
      expect((error as z.ZodError).issues).toEqual([
        expect.objectContaining({
          path: ["assets", 0, "procedure", "parameters", 1, "name"],
          message: "Duplicate procedure parameter name: segments.",
        }),
      ]);
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const temporaryRoot = () => {
  const root = mkdtempSync(path.join(tmpdir(), "fulcrum-asset-planner-"));
  roots.push(root);
  return root;
};

const revision = (
  revisionId: string,
  sha256: string,
  kind: string,
): RevisionRef => ({
  entityId: `${revisionId}:entity`,
  revisionId,
  kind,
  artifact: {
    artifactId: `${revisionId}:artifact`,
    sha256,
    mediaType: "application/json",
    byteLength: 100,
    uri: `/api/artifacts/${revisionId}:artifact`,
  },
  createdAt: timestamp,
  createdByRunId: "run-1",
});

const approval = (
  targetType: ApprovalDecision["targetType"],
  target: RevisionRef,
): ApprovalDecision & { decision: "approved" } => ({
  approvalId: `${target.revisionId}:approval`,
  projectId: "project-1",
  targetType,
  targetRevisionId: target.revisionId,
  targetSha256: target.artifact.sha256,
  decision: "approved",
  decidedBy: "zach",
  decidedAt: timestamp,
});

const validationFixture = (): {
  plan: AssetPlan;
  inputs: AssetPlanValidationInputs;
} => {
  const gds = revision("gds-1", "a".repeat(64), "game-design-spec");
  const set = revision("concept-set-1", "b".repeat(64), "concept-set");
  const concept = revision("concept-1", "c".repeat(64), "m1-concept");
  const conceptSet: ConceptSet = {
    conceptSetId: "concept-set-1",
    sourceDirectionRevisionId: "direction-1",
    slots: [
      {
        slotId: "gameplay-anchor",
        name: "Reliquary",
        purpose: "gameplay anchor hero prop",
        revisions: [
          {
            revision: concept,
            inheritedVisualTokens: [
              { tokenId: "shape-1", category: "shape", value: "squat" },
            ],
          },
        ],
        selectedRevisionId: concept.revisionId,
      },
    ],
  };
  const conceptDocument: M1ConceptDocument = {
    conceptId: "concept-1",
    name: "Reliquary",
    prompt: "A squat ancient reliquary hero prop.",
    negativePrompt: "photoreal",
    image: {
      artifactId: "concept-image",
      sha256: "d".repeat(64),
      mediaType: "image/png",
      byteLength: 10,
      uri: "/api/artifacts/concept-image",
    },
    provider: "replay",
    model: "fixture",
    sourceRevisionIds: [gds.revisionId, "direction-1"],
    costUsd: 0,
    ancestors: [
      {
        revisionId: gds.revisionId,
        sha256: gds.artifact.sha256,
        kind: gds.kind,
      },
      {
        revisionId: "direction-1",
        sha256: "e".repeat(64),
        kind: "visual-direction",
      },
    ],
  };
  const plan = AssetPlanSchema.parse({
    planId: "project-1:asset-plan",
    assets: [
      {
        assetId: "project-1:planned-asset:reliquary",
        name: "Reliquary",
        classification: "hero",
        rationale: "The gameplay anchor needs a readable hero prop.",
        sourceRefs: {
          gameDesignSpec: {
            revisionId: gds.revisionId,
            sha256: gds.artifact.sha256,
            kind: gds.kind,
          },
          conceptSet: {
            revisionId: set.revisionId,
            sha256: set.artifact.sha256,
            kind: set.kind,
          },
          conceptSlots: [
            {
              slotId: "gameplay-anchor",
              concept: {
                revisionId: concept.revisionId,
                sha256: concept.artifact.sha256,
                kind: concept.kind,
              },
            },
          ],
        },
        dependsOnAssetIds: [],
        acceptanceCriteria: ["Readable from across the arena."],
      },
    ],
    handling: ASSET_CLASS_HANDLING_POLICIES_V1,
    provenance: {
      revisionId: "plan-revision-1",
      parentRevisionIds: [gds.revisionId, set.revisionId, concept.revisionId],
      sourceArtifactHashes: [
        gds.artifact.sha256,
        set.artifact.sha256,
        concept.artifact.sha256,
      ],
      runId: "run-1",
      operation: "asset-plan.initial",
      createdAt: timestamp,
    },
  });
  return {
    plan,
    inputs: {
      projectId: "project-1",
      runId: "run-1",
      gameDesignSpec: { revision: gds, approval: approval("game-design", gds) },
      conceptSet: { revision: set, approval: approval("concept-set", set) },
      conceptSetDocument: conceptSet,
      conceptDocuments: { [concept.revisionId]: conceptDocument },
      expectedRevisionId: "plan-revision-1",
      expectedOperation: "asset-plan.initial",
    },
  };
};

describe("validateAssetPlanAgainstApprovedInputs", () => {
  it("asset_plan_rejects_an_unapproved_game_design_spec", () => {
    const fixture = validationFixture();
    fixture.inputs.gameDesignSpec.approval = {
      ...fixture.inputs.gameDesignSpec.approval,
      decision: "rejected",
    };

    expect(
      validateAssetPlanAgainstApprovedInputs(fixture.plan, fixture.inputs),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "source-approval-mismatch" }),
      ]),
    );
  });

  it("asset_plan_rejects_an_unapproved_concept_set", () => {
    const fixture = validationFixture();
    fixture.inputs.conceptSet.approval = {
      ...fixture.inputs.conceptSet.approval,
      decision: "changes-requested",
    };

    expect(
      validateAssetPlanAgainstApprovedInputs(fixture.plan, fixture.inputs),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "source-approval-mismatch" }),
      ]),
    );
  });

  it("hero_asset_requires_a_kept_concept_revision", () => {
    const fixture = validationFixture();
    const plan = AssetPlanSchema.parse({
      ...fixture.plan,
      assets: [
        {
          ...fixture.plan.assets[0],
          sourceRefs: {
            ...fixture.plan.assets[0]!.sourceRefs,
            conceptSlots: [],
          },
        },
      ],
    });

    expect(
      validateAssetPlanAgainstApprovedInputs(plan, fixture.inputs),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "hero-without-kept-concept" }),
      ]),
    );
  });

  it("concept_source_must_match_the_slots_selected_revision_and_hash", () => {
    const fixture = validationFixture();
    const plan = structuredClone(fixture.plan);
    plan.assets[0]!.sourceRefs.conceptSlots[0]!.concept.sha256 = "f".repeat(64);

    expect(
      validateAssetPlanAgainstApprovedInputs(plan, fixture.inputs),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "concept-source-not-kept" }),
      ]),
    );
  });

  it("selected_concept_must_descend_from_the_approved_game_design_spec", () => {
    const fixture = validationFixture();
    fixture.inputs.conceptDocuments["concept-1"] = {
      ...fixture.inputs.conceptDocuments["concept-1"]!,
      ancestors: [
        {
          revisionId: "other-gds",
          sha256: "9".repeat(64),
          kind: "game-design-spec",
        },
        {
          revisionId: "direction-1",
          sha256: "e".repeat(64),
          kind: "visual-direction",
        },
      ],
    };

    expect(
      validateAssetPlanAgainstApprovedInputs(fixture.plan, fixture.inputs),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "source-lineage-mismatch" }),
      ]),
    );
  });

  it("plan_provenance_must_name_every_exact_source_hash", () => {
    const fixture = validationFixture();
    const plan = structuredClone(fixture.plan);
    plan.provenance.sourceArtifactHashes = [
      fixture.inputs.gameDesignSpec.revision.artifact.sha256,
      fixture.inputs.conceptSet.revision.artifact.sha256,
    ];

    expect(
      validateAssetPlanAgainstApprovedInputs(plan, fixture.inputs),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "provenance-mismatch" }),
      ]),
    );
  });
});

const replayInputs = () => {
  const fixture = validationFixture();
  const gameDesignSpecDocument: GameDesignSpec = {
    title: "Reliquary Run",
    genre: "third-person extraction",
    camera: "third-person",
    coreFantasy: "Recover an ancient reliquary under pressure.",
    coreLoop: ["enter", "locate", "extract"],
    playerVerbs: ["move", "inspect", "extract"],
    objective: "Extract the reliquary.",
    sessionMinutes: 8,
    gameplayConstraints: ["The objective must read from across the arena."],
    facts: [],
    assumptions: [],
  };
  return { ...fixture.inputs, gameDesignSpecDocument };
};

const initialReplayPlan = () => {
  const inputs = replayInputs();
  const draft = deriveReplayAssetPlanDraft(inputs);
  const plan = materializeAssetPlan(draft, {
    ...inputs,
    revisionId: "replay-plan-1",
    createdAt: timestamp,
    operation: "asset-plan.initial",
  });
  return { inputs, draft, plan };
};

describe("replay asset-plan derivation and materialization", () => {
  it("keeps parent lineage in semantic input order instead of UUID order", () => {
    const { inputs, plan } = initialReplayPlan();

    expect(plan.provenance.parentRevisionIds).toEqual([
      inputs.gameDesignSpec.revision.revisionId,
      inputs.conceptSet.revision.revisionId,
      inputs.conceptSetDocument.slots[0]!.selectedRevisionId,
    ]);
    expect(plan.provenance.sourceArtifactHashes).toEqual([
      inputs.gameDesignSpec.revision.artifact.sha256,
      inputs.conceptSet.revision.artifact.sha256,
      inputs.conceptSetDocument.slots[0]!.revisions[0]!.revision.artifact
        .sha256,
    ]);
  });

  it("replay_planner_is_deterministic_for_identical_approved_inputs", () => {
    const first = initialReplayPlan().plan;
    const second = initialReplayPlan().plan;

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("replay_fixture_contains_hero_kit_procedural_and_functional_assets", () => {
    const classes = initialReplayPlan().plan.assets.map(
      (asset) => asset.classification,
    );

    expect(new Set(classes)).toEqual(
      new Set(["hero", "kit", "procedural", "functional"]),
    );
  });

  it("replay_kit_depends_on_the_hero_material_language", () => {
    const plan = initialReplayPlan().plan;
    const hero = plan.assets.find((asset) => asset.classification === "hero")!;
    const kit = plan.assets.find((asset) => asset.classification === "kit")!;

    expect(kit.dependsOnAssetIds).toContain(hero.assetId);
  });

  it("materialization_assigns_stable_project_scoped_asset_ids", () => {
    const { plan } = initialReplayPlan();

    expect(
      plan.assets.every((asset) =>
        asset.assetId.startsWith("project-1:planned-asset:"),
      ),
    ).toBe(true);
    expect(new Set(plan.assets.map((asset) => asset.assetId)).size).toBe(
      plan.assets.length,
    );
  });

  it("replan_preserves_ids_for_unchanged_asset_keys", () => {
    const initial = initialReplayPlan();
    const previousPlan = revision(
      initial.plan.provenance.revisionId,
      "7".repeat(64),
      "asset-plan",
    );
    const decision: ApprovalDecision = {
      approvalId: "plan-change-1",
      projectId: "project-1",
      targetType: "asset-plan",
      targetRevisionId: previousPlan.revisionId,
      targetSha256: previousPlan.artifact.sha256,
      decision: "changes-requested",
      notes: "Give the arena kit a stronger material tie to the hero.",
      decidedBy: "zach",
      decidedAt: timestamp,
    };
    const inputs = {
      ...initial.inputs,
      previousPlan,
      previousPlanDocument: initial.plan,
      replanDecision: decision,
    };
    const replanned = materializeAssetPlan(deriveReplayAssetPlanDraft(inputs), {
      ...inputs,
      revisionId: "replay-plan-2",
      createdAt: timestamp,
      operation: "asset-plan.replan",
    });

    expect(replanned.assets.map((asset) => asset.assetId).sort()).toEqual(
      initial.plan.assets.map((asset) => asset.assetId).sort(),
    );
  });

  it("replan_records_parent_revision_approval_and_change_note", () => {
    const initial = initialReplayPlan();
    const previousPlan = revision(
      initial.plan.provenance.revisionId,
      "7".repeat(64),
      "asset-plan",
    );
    const decision: ApprovalDecision = {
      approvalId: "plan-change-1",
      projectId: "project-1",
      targetType: "asset-plan",
      targetRevisionId: previousPlan.revisionId,
      targetSha256: previousPlan.artifact.sha256,
      decision: "changes-requested",
      notes: "Give the arena kit a stronger material tie to the hero.",
      decidedBy: "zach",
      decidedAt: timestamp,
    };
    const inputs = {
      ...initial.inputs,
      previousPlan,
      previousPlanDocument: initial.plan,
      replanDecision: decision,
    };
    const replanned = materializeAssetPlan(deriveReplayAssetPlanDraft(inputs), {
      ...inputs,
      revisionId: "replay-plan-2",
      createdAt: timestamp,
      operation: "asset-plan.replan",
    });

    expect(replanned.changeRequest).toEqual({
      approvalId: decision.approvalId,
      previousPlanRevisionId: previousPlan.revisionId,
      notes: decision.notes,
    });
    expect(replanned.provenance.parentRevisionIds).toContain(
      previousPlan.revisionId,
    );
  });

  it("replay_section_amendment_is_deterministic_for_the_same_seed_and_request", () => {
    const { plan } = initialReplayPlan();
    const input = {
      projectId: "project-1",
      currentPlan: plan,
      section: "hero" as const,
      request: "I'd like two more character slots",
      seed: "parked-world-seed",
    };

    const first = deriveReplayAssetPlanAmendmentDraft(input);
    const second = deriveReplayAssetPlanAmendmentDraft(input);

    expect(second).toEqual(first);
    expect(first.assets).toHaveLength(plan.assets.length + 2);
  });

  it("section_amendment_adds_assets_and_keeps_every_existing_asset_id", () => {
    const initial = initialReplayPlan();
    const previousPlan = revision(
      initial.plan.provenance.revisionId,
      "7".repeat(64),
      "asset-plan",
    );
    const draft = deriveReplayAssetPlanAmendmentDraft({
      projectId: "project-1",
      currentPlan: initial.plan,
      section: "hero",
      request: "two more character slots",
      seed: "stable-amendment",
    });
    const amended = materializeAssetPlanAmendment(draft, {
      ...initial.inputs,
      previousPlan,
      previousPlanDocument: initial.plan,
      expectedRevisionId: "amended-plan-2",
      expectedOperation: "asset-plan.amend",
      revisionId: "amended-plan-2",
      createdAt: timestamp,
      operation: "asset-plan.amend",
      section: "hero",
      frozenAssetIds: new Set(),
    });

    expect(amended.diff.addedAssetIds).toHaveLength(2);
    expect(amended.diff.changedAssetIds).toEqual([]);
    expect(amended.diff.removedAssetIds).toEqual([]);
    expect(
      amended.plan.assets
        .filter(({ assetId }) =>
          initial.plan.assets.some((asset) => asset.assetId === assetId),
        )
        .map(({ assetId }) => assetId)
        .sort(),
    ).toEqual(initial.plan.assets.map(({ assetId }) => assetId).sort());
    expect(amended.plan.provenance).toMatchObject({
      operation: "asset-plan.amend",
      parentRevisionIds: expect.arrayContaining([previousPlan.revisionId]),
    });
  });

  it("restores_a_provider_rename_of_a_frozen_asset_but_keeps_safe_additions", () => {
    const initial = initialReplayPlan();
    const previousPlan = revision(
      initial.plan.provenance.revisionId,
      "7".repeat(64),
      "asset-plan",
    );
    const draft = deriveReplayAssetPlanAmendmentDraft({
      projectId: "project-1",
      currentPlan: initial.plan,
      section: "hero",
      request: "two more character slots",
      seed: "frozen-amendment",
    });
    const frozen = initial.plan.assets.find(
      ({ classification }) => classification === "hero",
    )!;
    const frozenKey = frozen.assetId.split(":").at(-1)!;
    draft.assets.find(({ assetKey }) => assetKey === frozenKey)!.name =
      "Renamed spent boss";

    const amended = materializeAssetPlanAmendment(draft, {
      ...initial.inputs,
      previousPlan,
      previousPlanDocument: initial.plan,
      expectedRevisionId: "amended-plan-2",
      expectedOperation: "asset-plan.amend",
      revisionId: "amended-plan-2",
      createdAt: timestamp,
      operation: "asset-plan.amend",
      section: "hero",
      frozenAssetIds: new Set([frozen.assetId]),
    });

    expect(
      amended.plan.assets.find(({ assetId }) => assetId === frozen.assetId),
    ).toEqual(frozen);
    expect(amended.diff.addedAssetIds).toHaveLength(2);
    expect(amended.diff.changedAssetIds).not.toContain(frozen.assetId);
  });

  it("rejects_an_amendment_when_the_frozen_guard_removes_every_change", () => {
    const initial = initialReplayPlan();
    const previousPlan = revision(
      initial.plan.provenance.revisionId,
      "7".repeat(64),
      "asset-plan",
    );
    const draft = deriveReplayAssetPlanAmendmentDraft({
      projectId: "project-1",
      currentPlan: initial.plan,
      section: "hero",
      request: "two more character slots",
      seed: "unsafe-only",
    });
    const frozen = initial.plan.assets.find(
      ({ classification }) => classification === "hero",
    )!;
    const frozenKey = frozen.assetId.split(":").at(-1)!;
    draft.assets = draft.assets.filter(
      ({ assetKey }) => !assetKey.includes("-amendment-"),
    );
    draft.assets.find(({ assetKey }) => assetKey === frozenKey)!.name =
      "Unsafe rename";

    expect(() =>
      materializeAssetPlanAmendment(draft, {
        ...initial.inputs,
        previousPlan,
        previousPlanDocument: initial.plan,
        expectedRevisionId: "amended-plan-2",
        expectedOperation: "asset-plan.amend",
        revisionId: "amended-plan-2",
        createdAt: timestamp,
        operation: "asset-plan.amend",
        section: "hero",
        frozenAssetIds: new Set([frozen.assetId]),
      }),
    ).toThrow("did not return a safe change");
  });
});

const plannerFixture = (
  mode: "replay" | "live" = "replay",
  orchestratorProvider: AssetPlanningInput["orchestratorProvider"] = "openai",
  budgetUsd = 1,
) => {
  const repository = new ProjectRepository(temporaryRoot());
  const projectId = "planner-project";
  const runId = "planner-run";
  repository.reserveProject(projectId, timestamp);
  const brief = repository.writeRevision({
    projectId,
    entityId: `${projectId}:brief`,
    kind: "game-brief",
    value: { text: "A compact extraction arena centered on one reliquary." },
    runId,
  });
  const gameDesignSpecDocument: GameDesignSpec = {
    title: "Reliquary Run",
    genre: "third-person extraction",
    camera: "third-person",
    coreFantasy: "Recover an ancient reliquary under pressure.",
    coreLoop: ["enter", "locate", "extract"],
    playerVerbs: ["move", "inspect", "extract"],
    objective: "Extract the reliquary.",
    sessionMinutes: 8,
    gameplayConstraints: ["Keep the objective visible across the arena."],
    facts: [],
    assumptions: [],
  };
  const gds = repository.writeRevision({
    projectId,
    entityId: `${projectId}:gds`,
    kind: "game-design-spec",
    value: gameDesignSpecDocument,
    runId,
  });
  const conceptDocument: M1ConceptDocument = {
    conceptId: "concept-1",
    name: "Reliquary",
    prompt: "A squat ancient reliquary hero prop.",
    negativePrompt: "photoreal",
    image: {
      artifactId: "concept-image",
      sha256: "d".repeat(64),
      mediaType: "image/png",
      byteLength: 10,
      uri: "/api/artifacts/concept-image",
    },
    provider: "replay",
    model: "fixture",
    sourceRevisionIds: [gds.revisionId, "direction-1"],
    costUsd: 0,
    ancestors: [
      {
        revisionId: gds.revisionId,
        sha256: gds.artifact.sha256,
        kind: gds.kind,
      },
      {
        revisionId: "direction-1",
        sha256: "e".repeat(64),
        kind: "visual-direction",
      },
    ],
  };
  const concept = repository.writeRevision({
    projectId,
    entityId: `${projectId}:concept:gameplay-anchor`,
    kind: "m1-concept",
    value: conceptDocument,
    runId,
  });
  const conceptSetDocument: ConceptSet = {
    conceptSetId: `${projectId}:concept-set`,
    sourceDirectionRevisionId: "direction-1",
    slots: [
      {
        slotId: "gameplay-anchor",
        name: "Reliquary",
        purpose: "gameplay anchor hero prop",
        revisions: [
          {
            revision: concept,
            inheritedVisualTokens: [
              { tokenId: "shape-1", category: "shape", value: "squat" },
            ],
          },
        ],
        selectedRevisionId: concept.revisionId,
      },
    ],
  };
  const conceptSet = repository.writeRevision({
    projectId,
    entityId: `${projectId}:concept-set`,
    kind: "concept-set",
    value: conceptSetDocument,
    runId,
  });
  const gameDesignApproval = {
    ...approval("game-design", gds),
    projectId,
  };
  const conceptSetApproval = {
    ...approval("concept-set", conceptSet),
    projectId,
  };
  repository.createProject({
    schemaVersion: 1,
    milestone: "m2",
    projectId,
    name: "Planner fixture",
    mode,
    orchestratorProvider,
    status: "active",
    stage: "asset-planning",
    runId,
    budgetUsd,
    spentUsd: 0,
    brief,
    gameDesignSpec: gds,
    conceptSet,
    gameDesignApproval,
    conceptSetApproval,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const input: AssetPlanningInput = {
    projectId,
    runId,
    mode,
    orchestratorProvider,
    gameDesignSpec: { revision: gds, approval: gameDesignApproval },
    conceptSet: { revision: conceptSet, approval: conceptSetApproval },
  };
  const resolved = {
    projectId,
    runId,
    gameDesignSpec: input.gameDesignSpec,
    conceptSet: input.conceptSet,
    conceptSetDocument,
    conceptDocuments: { [concept.revisionId]: conceptDocument },
    expectedRevisionId: "unused",
    expectedOperation: "asset-plan.initial" as const,
    gameDesignSpecDocument,
  };
  return { repository, input, resolved };
};

const executionReturning = (value: unknown): StructuredModelExecution => ({
  generateStructured: vi.fn(async () => ({
    value,
    provider: "openai",
    model: "planner-model",
  })) as StructuredModelExecution["generateStructured"],
});

const wireDraftFromDomain = (draft: AssetPlanDraft): AssetPlanDraftWire => ({
  assets: draft.assets.map((asset) => {
    if (asset.classification !== "procedural") {
      return {
        ...asset,
        classification: asset.classification,
        poseMode: asset.poseMode ?? null,
        procedure: null,
      };
    }
    if (!asset.procedure) {
      throw new Error("Procedural domain fixture requires a procedure.");
    }
    return {
      ...asset,
      classification: asset.classification,
      poseMode: null,
      procedure: {
        generatorId: asset.procedure.generatorId,
        parameters: Object.entries(asset.procedure.parameters).map(
          ([name, value]) => ({ name, value }),
        ),
      },
    };
  }),
});

describe("AssetPlanner.plan", () => {
  it("replay_planning_never_calls_structured_execution", async () => {
    const fixture = plannerFixture();
    const execution = executionReturning({});
    const planner = createAssetPlannerForTest(fixture.repository, {
      execution,
      now: () => timestamp,
      revisionId: () => "plan-revision-1",
    });

    const outcome = await planner.plan(fixture.input);

    expect(outcome.status).toBe("ready");
    expect(execution.generateStructured).not.toHaveBeenCalled();
    fixture.repository.close();
  });

  it("repeat_planning_returns_the_ready_revision_without_writing_another", async () => {
    const fixture = plannerFixture();
    const planner = createAssetPlannerForTest(fixture.repository, {
      execution: executionReturning({}),
      now: () => timestamp,
      revisionId: vi.fn(() => "plan-revision-1"),
    });

    const first = await planner.plan(fixture.input);
    const second = await planner.plan(fixture.input);

    expect(second).toEqual(first);
    expect(
      fixture.repository
        .listEvents(fixture.input.projectId)
        .filter((event) => event.type === "asset-plan.created"),
    ).toHaveLength(1);
    fixture.repository.close();
  });

  it("live_planning_journals_intent_before_model_execution", async () => {
    const fixture = plannerFixture("live");
    const key = assetPlanIdempotencyKey(fixture.input);
    const execution = executionReturning(
      wireDraftFromDomain(deriveReplayAssetPlanDraft(fixture.resolved)),
    );
    vi.mocked(execution.generateStructured).mockImplementationOnce(
      async (input) => {
        expect(fixture.repository.getSubmissionByKey(key)?.status).toBe(
          "pending",
        );
        expect(input.schema).toBe(AssetPlanDraftWireSchema);
        return {
          value: wireDraftFromDomain(
            deriveReplayAssetPlanDraft(fixture.resolved),
          ),
          provider: "openai",
          model: "planner-model",
        };
      },
    );
    const planner = createAssetPlannerForTest(fixture.repository, {
      execution,
      now: () => timestamp,
      revisionId: () => "plan-revision-1",
    });

    expect((await planner.plan(fixture.input)).status).toBe("ready");
    fixture.repository.close();
  });

  it("openai_api_planning_reserves_budget_before_the_call", async () => {
    const fixture = plannerFixture("live", "openai-api");
    const execution = executionReturning(
      wireDraftFromDomain(deriveReplayAssetPlanDraft(fixture.resolved)),
    );
    vi.mocked(execution.generateStructured).mockImplementationOnce(async () => {
      expect(
        fixture.repository.getProject(fixture.input.projectId).spentUsd,
      ).toBe(0.25);
      return {
        value: wireDraftFromDomain(
          deriveReplayAssetPlanDraft(fixture.resolved),
        ),
        provider: "openai-api",
        model: "planner-model",
      };
    });
    const planner = createAssetPlannerForTest(fixture.repository, {
      execution,
      now: () => timestamp,
      revisionId: () => "plan-revision-1",
    });

    expect((await planner.plan(fixture.input)).status).toBe("ready");
    fixture.repository.close();
  });

  it("budget_refusal_does_not_call_the_model_or_poison_the_key", async () => {
    const fixture = plannerFixture("live", "openai-api", 0);
    const execution = executionReturning(
      wireDraftFromDomain(deriveReplayAssetPlanDraft(fixture.resolved)),
    );
    const planner = createAssetPlannerForTest(fixture.repository, {
      execution,
      now: () => timestamp,
      revisionId: () => "plan-revision-1",
    });

    const refused = await planner.plan(fixture.input);
    expect(refused.status).toBe("failed");
    expect(execution.generateStructured).not.toHaveBeenCalled();
    const key = assetPlanIdempotencyKey(fixture.input);
    expect(fixture.repository.getSubmissionByKey(key)?.status).toBe(
      "intent-recorded",
    );

    fixture.repository.saveProject({
      ...fixture.repository.getProject(fixture.input.projectId),
      budgetUsd: 1,
    });
    expect((await planner.plan(fixture.input)).status).toBe("ready");
    expect(execution.generateStructured).toHaveBeenCalledTimes(1);
    fixture.repository.close();
  });

  it("invalid_live_output_returns_strategy_changing_and_persists_no_plan", async () => {
    const fixture = plannerFixture("live");
    const planner = createAssetPlannerForTest(fixture.repository, {
      execution: executionReturning({ assets: [] }),
      now: () => timestamp,
      revisionId: () => "plan-revision-1",
    });

    const outcome = await planner.plan(fixture.input);

    expect(outcome).toMatchObject({
      status: "failed",
      error: {
        code: "asset-plan-invalid-output",
        kind: "strategy-changing",
      },
    });
    expect(
      fixture.repository
        .listEvents(fixture.input.projectId)
        .some((event) => event.type === "asset-plan.created"),
    ).toBe(false);
    fixture.repository.close();
  });

  it("invalid_live_draft_is_corrected_once_within_the_same_submission", async () => {
    const fixture = plannerFixture("live");
    const validDraft = wireDraftFromDomain(
      deriveReplayAssetPlanDraft(fixture.resolved),
    );
    const cyclicDraft = structuredClone(validDraft);
    cyclicDraft.assets[0]!.dependsOnAssetKeys = [
      cyclicDraft.assets[1]!.assetKey,
    ];
    cyclicDraft.assets[1]!.dependsOnAssetKeys = [
      cyclicDraft.assets[0]!.assetKey,
    ];
    const execution = executionReturning(validDraft);
    vi.mocked(execution.generateStructured)
      .mockResolvedValueOnce({
        value: cyclicDraft,
        provider: "openai",
        model: "planner-model",
      })
      .mockResolvedValueOnce({
        value: validDraft,
        provider: "openai",
        model: "planner-model",
      });
    const recordSubmissionIntent = vi.spyOn(
      fixture.repository,
      "recordSubmissionIntent",
    );
    const planner = createAssetPlannerForTest(fixture.repository, {
      execution,
      now: () => timestamp,
      revisionId: () => "plan-revision-1",
    });

    expect((await planner.plan(fixture.input)).status).toBe("ready");
    expect(recordSubmissionIntent).toHaveBeenCalledTimes(1);
    expect(execution.generateStructured).toHaveBeenCalledTimes(2);
    const firstPrompt = vi.mocked(execution.generateStructured).mock
      .calls[0]?.[0].systemPrompt;
    const correctionPrompt = vi.mocked(execution.generateStructured).mock
      .calls[1]?.[0].systemPrompt;
    expect(firstPrompt).toContain(
      "Asset keys must be unique; dependsOnAssetKeys may only reference assetKeys present in this draft and must stay acyclic; sourceConceptSlotIds may only use the supplied slot IDs.",
    );
    /* A live run left every hero — including "Scavenger Player Character" —
       without a poseMode, which makes `assetRigEligibility` refuse to rig
       anything. The instruction now asks for a pose by default. */
    expect(firstPrompt).toContain(
      "Set poseMode on every clearly humanoid character the game animates",
    );
    expect(firstPrompt).toContain("preferring a-pose");
    expect(firstPrompt).toContain("Omit poseMode for props, kits, vehicles");
    expect(correctionPrompt).toContain(firstPrompt);
    for (const asset of cyclicDraft.assets.slice(0, 2)) {
      expect(correctionPrompt).toContain(
        `Asset ${asset.assetKey} participates in a dependency cycle.`,
      );
    }
    expect(correctionPrompt).toContain("return a corrected complete draft");
    fixture.repository.close();
  });

  it("second_invalid_live_draft_reports_only_the_second_attempt_issues", async () => {
    const fixture = plannerFixture("live");
    const cyclicDraft = wireDraftFromDomain(
      deriveReplayAssetPlanDraft(fixture.resolved),
    );
    cyclicDraft.assets[0]!.dependsOnAssetKeys = [
      cyclicDraft.assets[0]!.assetKey,
    ];
    const execution = executionReturning({});
    vi.mocked(execution.generateStructured)
      .mockResolvedValueOnce({
        value: cyclicDraft,
        provider: "openai",
        model: "planner-model",
      })
      .mockResolvedValueOnce({
        value: proceduralWireDraft([
          { name: "segments", value: 12 },
          { name: "segments", value: 16 },
        ]),
        provider: "openai",
        model: "planner-model",
      });
    const planner = createAssetPlannerForTest(fixture.repository, {
      execution,
      now: () => timestamp,
      revisionId: () => "plan-revision-1",
    });

    const outcome = await planner.plan(fixture.input);

    expect(outcome).toMatchObject({
      status: "failed",
      error: {
        code: "asset-plan-invalid-output",
        issues: [
          {
            path: ["assets", 0, "procedure", "parameters", 1, "name"],
            message: "Duplicate procedure parameter name: segments.",
          },
        ],
      },
    });
    expect(execution.generateStructured).toHaveBeenCalledTimes(2);
    fixture.repository.close();
  });

  it("duplicate_wire_parameter_returns_the_invalid_draft_failure", async () => {
    const fixture = plannerFixture("live");
    const planner = createAssetPlannerForTest(fixture.repository, {
      execution: executionReturning(
        proceduralWireDraft([
          { name: "segments", value: 12 },
          { name: "segments", value: 16 },
        ]),
      ),
      now: () => timestamp,
      revisionId: () => "plan-revision-1",
    });

    const outcome = await planner.plan(fixture.input);

    expect(outcome).toMatchObject({
      status: "failed",
      error: {
        code: "asset-plan-invalid-output",
        kind: "strategy-changing",
        message: "The orchestrator returned an invalid asset-plan draft.",
        issues: [
          {
            code: "invalid-structured-output",
            path: ["assets", 0, "procedure", "parameters", 1, "name"],
            message: "Duplicate procedure parameter name: segments.",
          },
        ],
      },
    });
    fixture.repository.close();
  });

  it("interrupted_live_planning_becomes_submission_unknown_without_respend", async () => {
    const fixture = plannerFixture("live", "openai-api");
    const execution = executionReturning({});
    vi.mocked(execution.generateStructured).mockRejectedValueOnce(
      new Error("connection interrupted"),
    );
    const planner = createAssetPlannerForTest(fixture.repository, {
      execution,
      now: () => timestamp,
      revisionId: () => "plan-revision-1",
    });

    const first = await planner.plan(fixture.input);
    const second = await planner.plan(fixture.input);

    expect(first).toMatchObject({
      status: "failed",
      error: { code: "asset-plan-submission-unknown" },
    });
    expect(second).toMatchObject({
      status: "failed",
      error: { code: "asset-plan-submission-unknown" },
    });
    expect(execution.generateStructured).toHaveBeenCalledTimes(1);
    expect(
      fixture.repository.getProject(fixture.input.projectId).spentUsd,
    ).toBe(0.25);
    fixture.repository.close();
  });

  it("ready_live_submission_replays_without_a_second_model_call", async () => {
    const fixture = plannerFixture("live");
    const execution = executionReturning(
      wireDraftFromDomain(deriveReplayAssetPlanDraft(fixture.resolved)),
    );
    const planner = createAssetPlannerForTest(fixture.repository, {
      execution,
      now: () => timestamp,
      revisionId: () => "plan-revision-1",
    });

    const first = await planner.plan(fixture.input);
    const second = await planner.plan(fixture.input);

    expect(second).toEqual(first);
    expect(execution.generateStructured).toHaveBeenCalledTimes(1);
    fixture.repository.close();
  });
});
