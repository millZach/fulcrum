import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ASSET_CLASS_HANDLING_POLICIES_V1,
  ConceptViewDocumentSchema,
  MultiviewConceptSetSchema,
  type ConceptViewRole,
  type RevisionRef,
} from "@fulcrum/domain";
import type { SubscriptionImageRunner } from "@fulcrum/execution";
import { ProjectRepository } from "@fulcrum/project";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  compileConceptViewPrompt,
  conceptViewIdempotencyKey,
  MultiviewConceptProduction,
  type CompileConceptViewPromptInput,
} from "./multiview.js";

const input = (
  role: CompileConceptViewPromptInput["role"],
): CompileConceptViewPromptInput => ({
  role,
  assetName: "Ancient Reliquary",
  inheritedVisualTokens: [
    {
      tokenId: "shape-1",
      category: "shape",
      value: "squat octagonal stone vessel",
    },
    {
      tokenId: "material-1",
      category: "material",
      value: "weathered dark stone with restrained bronze bands",
    },
    {
      tokenId: "prohibited-1",
      category: "prohibited-style",
      value: "photoreal product rendering",
    },
  ],
});

describe("concept view prompt compiler", () => {
  it("view_prompt_names_image_one_as_exact_identity_anchor", () => {
    const prompt = compileConceptViewPrompt(input("front"));

    expect(prompt).toContain("Image 1 is the exact identity anchor");
    expect(prompt).toContain("unchanged proportions");
    expect(prompt).toContain("recognizable wear");
  });

  it("view_prompt_includes_approved_tokens_and_prohibited_styles", () => {
    const prompt = compileConceptViewPrompt(input("front"));

    expect(prompt).toContain("squat octagonal stone vessel");
    expect(prompt).toContain(
      "weathered dark stone with restrained bronze bands",
    );
    expect(prompt).toContain("Prohibited style: photoreal product rendering");
  });

  it.each([
    ["left", 90],
    ["back", 180],
    ["right", 270],
  ] as const)(
    "%s_prompt_uses_fixed_cardinal_guidance",
    (role, azimuthDegrees) => {
      const prompt = compileConceptViewPrompt(input(role));

      expect(prompt).toContain(
        `${role} view at ${azimuthDegrees} degrees azimuth`,
      );
      expect(prompt).toContain("orthographic");
      expect(prompt).toContain("full subject centered");
    },
  );

  it("view_prompt_preserves_guard_when_tokens_exceed_4000_chars", () => {
    const prompt = compileConceptViewPrompt({
      ...input("front"),
      inheritedVisualTokens: [
        ...input("front").inheritedVisualTokens,
        {
          tokenId: "long-token",
          category: "surface",
          value: "weathered stone ".repeat(500),
        },
      ],
    });

    expect(prompt.length).toBeLessThanOrEqual(4_000);
    expect(prompt).toMatch(
      /No text, UI, logos, extra subjects, scene dressing, or unrelated project history\.$/,
    );
  });

  it("changing_only_role_changes_prompt_hash", () => {
    const hash = (role: CompileConceptViewPromptInput["role"]) =>
      createHash("sha256")
        .update(compileConceptViewPrompt(input(role)))
        .digest("hex");

    expect(hash("front")).not.toBe(hash("left"));
  });
});

const keyInput = () => ({
  projectId: "project-1",
  assetId: "hero",
  role: "front" as const,
  attempt: 0,
  anchorConceptRevisionId: "concept-revision-1",
  anchorImage: {
    artifactId: "anchor-image",
    sha256: "a".repeat(64),
    mediaType: "image/png",
    byteLength: 64,
    uri: "/api/artifacts/anchor-image",
  },
  strategyRevisionId: "strategy-revision-1",
  promptHash: "b".repeat(64),
  mode: "replay" as const,
  imageProvider: "openai-subscription" as const,
  sourceRevisionIds: ["concept-set-revision-1", "asset-plan-revision-1"],
});

describe("concept view idempotency", () => {
  it("view_key_is_stable_for_equivalent_source_revision_order", () => {
    const original = keyInput();
    const reordered = {
      ...original,
      sourceRevisionIds: [...original.sourceRevisionIds].reverse(),
    };

    expect(conceptViewIdempotencyKey(original)).toBe(
      conceptViewIdempotencyKey(reordered),
    );
  });

  it.each([
    { anchorImage: { ...keyInput().anchorImage, sha256: "c".repeat(64) } },
    { role: "left" as const },
    { promptHash: "d".repeat(64) },
    { attempt: 1 },
    { strategyRevisionId: "strategy-revision-2" },
  ])(
    "view_key_changes_with_anchor_hash_role_prompt_attempt_or_strategy %#",
    (change) => {
      expect(conceptViewIdempotencyKey({ ...keyInput(), ...change })).not.toBe(
        conceptViewIdempotencyKey(keyInput()),
      );
    },
  );

  it("view_key_does_not_include_artifact_uri", () => {
    const original = keyInput();

    expect(
      conceptViewIdempotencyKey({
        ...original,
        anchorImage: { ...original.anchorImage, uri: "/moved/anchor.png" },
      }),
    ).toBe(conceptViewIdempotencyKey(original));
  });
});

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

type CreativeFixture = ReturnType<typeof creativeFixture>;

const creativeFixture = () => {
  const root = mkdtempSync(path.join(tmpdir(), "fulcrum-multiview-creative-"));
  roots.push(root);
  const repository = new ProjectRepository(root);
  const projectId = "m2-creative";
  const runId = "run-1";
  const createdAt = new Date().toISOString();
  repository.reserveProject(projectId, createdAt);
  const brief = repository.writeRevision({
    projectId,
    entityId: `${projectId}:brief`,
    kind: "game-brief",
    value: { text: "Multiview creative fixture.", rightsConfirmed: true },
    runId,
  });
  const gameDesignSpec = repository.writeRevision({
    projectId,
    entityId: `${projectId}:game-design-spec`,
    kind: "game-design-spec",
    value: { title: "Fixture" },
    runId,
  });
  const anchorImage = repository.putArtifact(projectId, PNG_1x1, "image/png");
  const anchorConcept = repository.writeRevision({
    projectId,
    entityId: `${projectId}:concept:hero`,
    kind: "concept-document",
    value: {
      conceptId: "hero",
      name: "Ancient Reliquary",
      prompt: "Approved reliquary concept",
      negativePrompt: "photoreal product rendering",
      image: anchorImage,
      provider: "fulcrum-replay",
      model: "concept-fixture-v1",
      sourceRevisionIds: [brief.revisionId, gameDesignSpec.revisionId],
      ancestors: [
        {
          revisionId: brief.revisionId,
          sha256: brief.artifact.sha256,
          kind: brief.kind,
        },
        {
          revisionId: gameDesignSpec.revisionId,
          sha256: gameDesignSpec.artifact.sha256,
          kind: gameDesignSpec.kind,
        },
      ],
      costUsd: 0,
    },
    runId,
  });
  const inheritedVisualTokens = [
    {
      tokenId: "approved-shape",
      category: "shape" as const,
      value: "squat octagonal stone vessel",
    },
    {
      tokenId: "approved-material",
      category: "material" as const,
      value: "weathered dark stone and restrained bronze",
    },
    {
      tokenId: "approved-prohibited",
      category: "prohibited-style" as const,
      value: "photoreal product rendering",
    },
  ];
  const conceptSet = repository.writeRevision({
    projectId,
    entityId: `${projectId}:concept-set`,
    kind: "concept-set",
    value: {
      conceptSetId: `${projectId}:concept-set`,
      sourceDirectionRevisionId: "direction-revision-1",
      slots: [
        {
          slotId: "gameplay-anchor",
          name: "Ancient Reliquary",
          purpose: "Readable hero objective",
          revisions: [{ revision: anchorConcept, inheritedVisualTokens }],
          selectedRevisionId: anchorConcept.revisionId,
        },
      ],
    },
    runId,
  });
  const assetId = `${projectId}:planned-asset:hero`;
  const assetPlan = repository.writeRevision({
    projectId,
    entityId: `${projectId}:asset-plan`,
    kind: "asset-plan",
    value: {
      planId: `${projectId}:asset-plan`,
      assets: [
        {
          assetId,
          name: "Ancient Reliquary",
          classification: "hero",
          rationale: "The objective needs a readable hero asset.",
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
                slotId: "gameplay-anchor",
                concept: {
                  revisionId: anchorConcept.revisionId,
                  sha256: anchorConcept.artifact.sha256,
                  kind: anchorConcept.kind,
                },
              },
            ],
          },
          dependsOnAssetIds: [],
          acceptanceCriteria: ["Readable from the arena perimeter."],
        },
      ],
      handling: ASSET_CLASS_HANDLING_POLICIES_V1,
      provenance: {
        revisionId: "asset-plan-provenance-1",
        parentRevisionIds: [
          gameDesignSpec.revisionId,
          conceptSet.revisionId,
          anchorConcept.revisionId,
        ],
        sourceArtifactHashes: [
          gameDesignSpec.artifact.sha256,
          conceptSet.artifact.sha256,
          anchorConcept.artifact.sha256,
        ],
        runId,
        operation: "asset-plan.initial",
        createdAt,
      },
    },
    runId,
  });
  const conceptSetApproval = {
    approvalId: "concept-set-approval-1",
    projectId,
    targetType: "concept-set" as const,
    targetRevisionId: conceptSet.revisionId,
    targetSha256: conceptSet.artifact.sha256,
    decision: "approved" as const,
    decidedBy: "zach",
    decidedAt: createdAt,
  };
  const assetPlanApproval = {
    approvalId: "asset-plan-approval-1",
    projectId,
    targetType: "asset-plan" as const,
    targetRevisionId: assetPlan.revisionId,
    targetSha256: assetPlan.artifact.sha256,
    decision: "approved" as const,
    decidedBy: "zach",
    decidedAt: createdAt,
  };
  repository.createProject({
    schemaVersion: 1,
    milestone: "m2",
    projectId,
    name: "M2 creative fixture",
    mode: "replay",
    assetProvider: "meshy",
    orchestratorProvider: "openai",
    implementationProvider: "openai",
    imageProvider: "openai-subscription",
    soundProvider: "none",
    status: "active",
    stage: "asset-batch",
    runId,
    spentUsd: 0,
    conceptReplacementCount: 0,
    brief,
    gameDesignSpec,
    conceptSet,
    conceptSetApproval,
    assetPlan,
    assetPlanApproval,
    createdAt,
    updatedAt: createdAt,
  });
  return {
    repository,
    projectId,
    runId,
    assetId,
    assetPlan,
    conceptSet,
    anchorConcept,
    anchorImage,
    inheritedVisualTokens,
  };
};

const request = (fixture: CreativeFixture) => ({
  projectId: fixture.projectId,
  assetPlan: fixture.assetPlan,
  assetId: fixture.assetId,
  attempt: 0,
  runId: fixture.runId,
  mode: "replay" as const,
  imageProvider: "openai-subscription" as const,
  sourceConceptSet: fixture.conceptSet,
  anchorConcept: fixture.anchorConcept,
  rolesToGenerate: ["front", "left", "back", "right"] as ConceptViewRole[],
});

const readySet = async (
  production: MultiviewConceptProduction,
  fixture: CreativeFixture,
) => {
  const outcome = await production.ensure(request(fixture));
  expect(outcome.status).toBe("ready");
  if (outcome.status !== "ready") throw new Error("Expected ready set");
  return {
    revision: outcome.value,
    set: MultiviewConceptSetSchema.parse(
      fixture.repository.resolveRevision(outcome.value),
    ),
  };
};

describe("MultiviewConceptProduction", () => {
  it("initial_generation_writes_four_stable_view_entities_and_one_set", async () => {
    const fixture = creativeFixture();
    const { revision: setRevision, set } = await readySet(
      new MultiviewConceptProduction(fixture.repository),
      fixture,
    );

    expect(set.views.map(({ role }) => role)).toEqual([
      "front",
      "left",
      "back",
      "right",
    ]);
    expect(set.views.map(({ revision }) => revision.entityId)).toEqual(
      set.views.map(({ role }) => `${fixture.assetId}:concept-view:${role}`),
    );
    expect(setRevision.entityId).toBe(
      `${fixture.assetId}:multiview-concept-set`,
    );
    expect(
      fixture.repository
        .listEvents(fixture.projectId)
        .filter(({ type }) => type === "concept-view.completed"),
    ).toHaveLength(4);
    expect(
      fixture.repository
        .listEvents(fixture.projectId)
        .filter(({ type }) => type === "concept-view-set.completed"),
    ).toHaveLength(1);
    fixture.repository.close();
  });

  it("every_view_has_kept_concept_revision_and_hash_in_ancestors", async () => {
    const fixture = creativeFixture();
    const { set } = await readySet(
      new MultiviewConceptProduction(fixture.repository),
      fixture,
    );

    for (const view of set.views) {
      const document = ConceptViewDocumentSchema.parse(
        fixture.repository.resolveRevision(view.revision),
      );
      expect(document.ancestors).toContainEqual({
        revisionId: fixture.anchorConcept.revisionId,
        sha256: fixture.anchorConcept.artifact.sha256,
        kind: fixture.anchorConcept.kind,
      });
      expect(document.referenceArtifactHashes).toContain(
        fixture.anchorImage.sha256,
      );
    }
    fixture.repository.close();
  });

  it("approved_visual_tokens_are_resolved_from_the_selected_concept_entry", async () => {
    const fixture = creativeFixture();
    const { set } = await readySet(
      new MultiviewConceptProduction(fixture.repository),
      fixture,
    );
    const front = set.views.find(({ role }) => role === "front")!;
    const document = ConceptViewDocumentSchema.parse(
      fixture.repository.resolveRevision(front.revision),
    );

    expect(document.prompt).toContain("squat octagonal stone vessel");
    expect(document.prompt).toContain("Prohibited style");
    fixture.repository.close();
  });

  it("unselected_or_stale_anchor_is_policy_blocked", async () => {
    const fixture = creativeFixture();
    const stale = fixture.repository.writeRevision({
      projectId: fixture.projectId,
      entityId: `${fixture.projectId}:concept:stale`,
      kind: "concept-document",
      value: fixture.repository.resolveRevision(fixture.anchorConcept),
      runId: fixture.runId,
    });

    const outcome = await new MultiviewConceptProduction(
      fixture.repository,
    ).ensure({ ...request(fixture), anchorConcept: stale });

    expect(outcome).toEqual(
      expect.objectContaining({
        status: "failed",
        error: expect.objectContaining({ kind: "policy-blocked" }),
      }),
    );
    fixture.repository.close();
  });

  it("restart_after_two_ready_views_calls_only_the_two_missing_jobs", async () => {
    const fixture = creativeFixture();
    const calledRoles: ConceptViewRole[] = [];
    let failedBack = false;
    const production = new MultiviewConceptProduction(fixture.repository, {
      runnerForRole:
        (role): SubscriptionImageRunner =>
        async () => {
          calledRoles.push(role);
          if (role === "back" && !failedBack) {
            failedBack = true;
            throw new Error("fixture interruption");
          }
          return { bytes: PNG_1x1, model: "fixture-view-v1", costUsd: 0 };
        },
    });

    expect((await production.ensure(request(fixture))).status).toBe("failed");
    expect((await production.ensure(request(fixture))).status).toBe("ready");
    expect(calledRoles).toEqual(["front", "left", "back", "back", "right"]);
    fixture.repository.close();
  });

  it("exhausted_live_subscription_views_require_user_action", async () => {
    const fixture = creativeFixture();
    fixture.repository.saveProject({
      ...fixture.repository.getProject(fixture.projectId),
      mode: "live",
    });
    const runner = vi.fn(async () => {
      throw new Error("codex timed out.");
    });
    const production = new MultiviewConceptProduction(fixture.repository, {
      runnerForRole: () => runner,
    });

    const outcome = await production.ensure({
      ...request(fixture),
      mode: "live",
    });

    expect(outcome).toEqual(
      expect.objectContaining({
        status: "failed",
        error: expect.objectContaining({
          code: "concept-generation-failed",
          kind: "user-action-required",
        }),
      }),
    );
    expect(runner).toHaveBeenCalledTimes(2);
    fixture.repository.close();
  });

  it("strategy_regeneration_reuses_untouched_views", async () => {
    const fixture = creativeFixture();
    const first = await readySet(
      new MultiviewConceptProduction(fixture.repository),
      fixture,
    );
    const strategy = fixture.repository.writeRevision({
      projectId: fixture.projectId,
      entityId: `${fixture.assetId}:strategy`,
      kind: "asset-regeneration-strategy",
      value: {
        kind: "change-views",
        rationale: "The rear silhouette needs direct evidence.",
        reasonFindingIds: ["finding-1"],
        operation: "replace",
        roles: ["back", "left", "right"],
        brief: "Clarify the rear structure and side transitions.",
      },
      runId: fixture.runId,
    });
    const regeneratedRoles: ConceptViewRole[] = [];
    const production = new MultiviewConceptProduction(fixture.repository, {
      runnerForRole:
        (role): SubscriptionImageRunner =>
        async () => {
          regeneratedRoles.push(role);
          return { bytes: PNG_1x1, model: "fixture-view-v2", costUsd: 0 };
        },
    });

    const outcome = await production.ensure({
      ...request(fixture),
      previousMultiviewConceptSet: first.revision,
      strategyRevision: strategy,
      requestedRoles: ["back", "left", "right"],
      rolesToGenerate: ["back", "left", "right"],
      attempt: 1,
    });
    expect(outcome.status).toBe("ready");
    if (outcome.status !== "ready") throw new Error("Expected regeneration");
    const second = MultiviewConceptSetSchema.parse(
      fixture.repository.resolveRevision(outcome.value),
    );
    const firstByRole = new Map(
      first.set.views.map((view) => [view.role, view]),
    );
    const secondByRole = new Map(second.views.map((view) => [view.role, view]));

    expect(regeneratedRoles).toEqual(["left", "back", "right"]);
    expect(secondByRole.get("front")?.revision.revisionId).toBe(
      firstByRole.get("front")?.revision.revisionId,
    );
    for (const role of ["left", "back", "right"] as const) {
      expect(secondByRole.get(role)?.revision.revisionId).not.toBe(
        firstByRole.get(role)?.revision.revisionId,
      );
    }
    fixture.repository.close();
  });

  it("replaced_view_parents_include_anchor_prior_view_and_strategy_revision", async () => {
    const fixture = creativeFixture();
    const production = new MultiviewConceptProduction(fixture.repository);
    const first = await readySet(production, fixture);
    const strategy = fixture.repository.writeRevision({
      projectId: fixture.projectId,
      entityId: `${fixture.assetId}:strategy`,
      kind: "asset-regeneration-strategy",
      value: {
        kind: "change-views",
        rationale: "The rear silhouette needs direct evidence.",
        reasonFindingIds: ["finding-1"],
        operation: "replace",
        roles: ["back"],
        brief: "Clarify the rear structure.",
      },
      runId: fixture.runId,
    });
    const outcome = await production.ensure({
      ...request(fixture),
      previousMultiviewConceptSet: first.revision,
      strategyRevision: strategy,
      requestedRoles: ["back"],
      rolesToGenerate: ["back"],
      attempt: 1,
    });
    if (outcome.status !== "ready") throw new Error("Expected regeneration");
    const second = MultiviewConceptSetSchema.parse(
      fixture.repository.resolveRevision(outcome.value),
    );
    const previousBack = first.set.views.find(({ role }) => role === "back")!;
    const nextBack = second.views.find(({ role }) => role === "back")!;
    const document = ConceptViewDocumentSchema.parse(
      fixture.repository.resolveRevision(nextBack.revision),
    );

    expect(document.ancestors.map(({ revisionId }) => revisionId)).toEqual(
      expect.arrayContaining([
        fixture.anchorConcept.revisionId,
        previousBack.revision.revisionId,
        strategy.revisionId,
      ]),
    );
    fixture.repository.close();
  });

  it("ensureRevision_prevents_duplicate_view_and_set_revisions", async () => {
    const fixture = creativeFixture();
    const production = new MultiviewConceptProduction(fixture.repository);

    const first = await production.ensure(request(fixture));
    const second = await production.ensure(request(fixture));
    if (first.status !== "ready" || second.status !== "ready") {
      throw new Error("Expected idempotent ready outcomes");
    }

    expect(second.value.revisionId).toBe(first.value.revisionId);
    expect(
      fixture.repository
        .listEvents(fixture.projectId)
        .filter(({ type }) => type === "concept-view.completed"),
    ).toHaveLength(4);
    expect(
      fixture.repository
        .listEvents(fixture.projectId)
        .filter(({ type }) => type === "concept-view-set.completed"),
    ).toHaveLength(1);
    fixture.repository.close();
  });
});
