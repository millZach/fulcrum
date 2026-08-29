import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ASSET_CLASS_HANDLING_POLICIES_V1,
  ASSET_STAGE_DECISION_CREDITS,
  DEFAULT_MESHY_CONFIG,
  MESHY_STAGE_CREDITS,
  isProviderPreflightError,
  type AssetStageDecision,
  type CharacterPoseMode,
} from "@fulcrum/domain";
import { ProjectRepository } from "@fulcrum/project";
import { afterEach, describe, expect, it, vi } from "vitest";

import { encodePngRgba } from "./png.js";
import { StagedAssetLifecycle } from "./staged-asset-lifecycle.js";
import {
  SimulatedStagedAdapter,
  type SimulatedStagedOptions,
  type StagedAssetAdapter,
  type StagedInspectInput,
  type StagedSubmitInput,
} from "./staged-meshy.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const HERO_KEY = "hero";
const PROP_KEY = "prop";

/** The simulator, plus a record of exactly what Meshy was handed. */
class RecordingAdapter implements StagedAssetAdapter {
  readonly id = "fulcrum-simulated" as const;
  readonly submissions: StagedSubmitInput[] = [];
  private readonly inner: SimulatedStagedAdapter;

  constructor(options: SimulatedStagedOptions = {}) {
    this.inner = new SimulatedStagedAdapter(options);
  }

  async submit(input: StagedSubmitInput) {
    this.submissions.push(input);
    return await this.inner.submit(input);
  }

  async inspect(input: StagedInspectInput) {
    return await this.inner.inspect(input);
  }
}

/** A distinct, genuinely decodable 4x4 PNG per view. */
const pngDataUrl = (tint: number): string => {
  const rgba = new Uint8Array(4 * 4 * 4);
  for (let index = 0; index < rgba.length; index += 4) {
    rgba[index] = tint;
    rgba[index + 1] = 64;
    rgba[index + 2] = 128;
    rgba[index + 3] = 255;
  }
  return `data:image/png;base64,${Buffer.from(encodePngRgba(4, 4, rgba)).toString("base64")}`;
};

type FixtureOptions = {
  mode?: "live" | "replay";
  meshyCreditBudget?: number;
  /** "none" models a hero the planner never marked for rigging. */
  heroPose?: CharacterPoseMode | "none";
  heroName?: string;
  heroRationale?: string;
  assetPlanReplanCount?: 0 | 1;
  /** False models a plan that has not reached workflow finalization. */
  assetPlanApproved?: boolean;
  simulation?: SimulatedStagedOptions;
};

const fixture = (options: FixtureOptions = {}) => {
  const root = mkdtempSync(path.join(tmpdir(), "fulcrum-staged-"));
  roots.push(root);
  const repository = new ProjectRepository(root);
  const projectId = `staged-${roots.length}`;
  const runId = "run-1";
  const heroName = options.heroName ?? "Warden";
  const createdAt = new Date("2026-08-28T12:00:00.000Z").toISOString();
  repository.reserveProject(projectId, createdAt);

  const brief = repository.writeRevision({
    projectId,
    entityId: `${projectId}:brief`,
    kind: "game-brief",
    value: { text: "Staged asset gate fixture.", rightsConfirmed: true },
    runId,
  });
  const gameDesignSpec = repository.writeRevision({
    projectId,
    entityId: `${projectId}:game-design-spec`,
    kind: "game-design-spec",
    value: { title: "Fixture" },
    runId,
  });
  const anchorImage = repository.putArtifact(
    projectId,
    Buffer.from("anchor-image"),
    "image/png",
  );
  const anchorConcept = repository.writeRevision({
    projectId,
    entityId: `${projectId}:concept:hero`,
    kind: "concept-document",
    value: {
      conceptId: "hero",
      name: heroName,
      prompt: "Approved concept",
      negativePrompt: "photorealism",
      image: anchorImage,
      provider: "fulcrum-replay",
      model: "fixture",
      sourceRevisionIds: [brief.revisionId, gameDesignSpec.revisionId],
      ancestors: [brief, gameDesignSpec].map((revision) => ({
        revisionId: revision.revisionId,
        sha256: revision.artifact.sha256,
        kind: revision.kind,
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
      sourceDirectionRevisionId: "direction-1",
      slots: [
        {
          slotId: "gameplay-anchor",
          name: heroName,
          purpose: "Readable objective",
          revisions: [
            {
              revision: anchorConcept,
              inheritedVisualTokens: [
                { tokenId: "shape-1", category: "shape", value: "tall biped" },
              ],
            },
          ],
          selectedRevisionId: anchorConcept.revisionId,
        },
      ],
    },
    runId,
  });

  const sourceRefs = {
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
  };
  const heroId = `${projectId}:planned-asset:${HERO_KEY}`;
  const propId = `${projectId}:planned-asset:${PROP_KEY}`;
  const assetPlan = repository.writeRevision({
    projectId,
    entityId: `${projectId}:asset-plan`,
    kind: "asset-plan",
    value: {
      planId: `${projectId}:asset-plan`,
      assets: [
        {
          assetId: heroId,
          name: heroName,
          classification: "hero",
          rationale:
            options.heroRationale ?? "The objective needs a hero asset.",
          sourceRefs,
          dependsOnAssetIds: [],
          ...((options.heroPose ?? "a-pose") === "none"
            ? {}
            : { poseMode: options.heroPose ?? "a-pose" }),
          acceptanceCriteria: ["Readable from the arena perimeter."],
        },
        {
          assetId: propId,
          name: "Signal Lantern",
          classification: "kit",
          rationale: "Set dressing for the arena rim.",
          sourceRefs,
          dependsOnAssetIds: [],
          acceptanceCriteria: ["Tiles without a visible seam."],
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

  const meshyCreditBudget = options.meshyCreditBudget ?? 200;
  repository.createProject({
    schemaVersion: 1,
    milestone: "m2",
    projectId,
    name: "Staged gate fixture",
    mode: options.mode ?? "replay",
    assetProvider: "meshy",
    orchestratorProvider: "openai",
    implementationProvider: "openai",
    imageProvider: "openai-subscription",
    soundProvider: "none",
    status: "active",
    stage: "asset-batch",
    runId,
    budgetUsd: 5,
    spentUsd: 0,
    meshyCreditBudget,
    meshyCreditsReserved: 0,
    meshyCreditsConsumed: 0,
    conceptReplacementCount: 0,
    brief,
    gameDesignSpec,
    conceptSet,
    conceptSetApproval: {
      approvalId: "concept-set-approval-1",
      projectId,
      targetType: "concept-set",
      targetRevisionId: conceptSet.revisionId,
      targetSha256: conceptSet.artifact.sha256,
      decision: "approved",
      decidedBy: "zach",
      decidedAt: createdAt,
    },
    assetPlan,
    ...(options.assetPlanReplanCount === undefined
      ? {}
      : { assetPlanReplanCount: options.assetPlanReplanCount }),
    ...((options.assetPlanApproved ?? true)
      ? {
          assetPlanApproval: {
            approvalId: "asset-plan-approval-1",
            projectId,
            targetType: "asset-plan" as const,
            targetRevisionId: assetPlan.revisionId,
            targetSha256: assetPlan.artifact.sha256,
            decision: "approved" as const,
            decidedBy: "fulcrum:auto-finalizer",
            decidedAt: createdAt,
          },
        }
      : {}),
    createdAt,
    updatedAt: createdAt,
  });

  const adapter = new RecordingAdapter(options.simulation ?? {});
  const lifecycle = new StagedAssetLifecycle(repository, { adapter });
  return {
    repository,
    projectId,
    heroId,
    propId,
    lifecycle,
    adapter,
    anchorSha256: anchorImage.sha256,
  };
};

type Fixture = ReturnType<typeof fixture>;

/** Polls until the task in flight settles. The simulator finishes in three. */
const settle = async (context: Fixture, assetId: string, polls = 6) => {
  for (let index = 0; index < polls; index += 1) {
    const { record } = await context.lifecycle.poll(context.projectId, assetId);
    if (record.status !== "running") return record;
  }
  throw new Error("The simulated task never settled.");
};

const decide = async (
  context: Fixture,
  assetId: string,
  decision: AssetStageDecision,
) =>
  await context.lifecycle.decide(context.projectId, {
    assetId,
    decision,
    acknowledgedCredits: ASSET_STAGE_DECISION_CREDITS[decision],
  });

const project = (context: Fixture) =>
  context.repository.getProject(context.projectId);

const eventTypes = (context: Fixture) =>
  context.repository.listEvents(context.projectId).map((event) => event.type);

describe("staged asset lifecycle", () => {
  it("reports rising progress across polls before it hands back a mesh", async () => {
    const context = fixture();
    const started = await context.lifecycle.start(context.projectId, {
      assetId: context.heroId,
    });
    expect(started.record.status).toBe("running");
    expect(started.record.runs[0]).toMatchObject({
      stage: "geometry",
      round: 1,
      progress: 0,
      reservedCredits: MESHY_STAGE_CREDITS.geometry,
    });
    expect(started.resumeAfter).toBeTruthy();

    const first = await context.lifecycle.poll(
      context.projectId,
      context.heroId,
    );
    expect(first.record.status).toBe("running");
    expect(first.record.runs[0]!.progress).toBe(33);
    const second = await context.lifecycle.poll(
      context.projectId,
      context.heroId,
    );
    expect(second.record.runs[0]!.progress).toBe(67);
    const third = await context.lifecycle.poll(
      context.projectId,
      context.heroId,
    );
    expect(third.record.status).toBe("review");
    expect(third.record.runs[0]!.progress).toBe(100);
    expect(third.record.runs[0]!.model?.mediaType).toBe("model/gltf-binary");
  });

  it("reserves before submitting and reconciles on completion, per stage", async () => {
    const context = fixture();
    await context.lifecycle.start(context.projectId, {
      assetId: context.heroId,
    });
    expect(project(context).meshyCreditsReserved).toBe(
      MESHY_STAGE_CREDITS.geometry,
    );
    expect(project(context).meshyCreditsConsumed).toBe(0);

    await settle(context, context.heroId);
    expect(project(context).meshyCreditsReserved).toBe(0);
    expect(project(context).meshyCreditsConsumed).toBe(
      MESHY_STAGE_CREDITS.geometry,
    );

    await decide(context, context.heroId, "texture");
    expect(project(context).meshyCreditsReserved).toBe(
      MESHY_STAGE_CREDITS.texture,
    );
    await settle(context, context.heroId);
    expect(project(context).meshyCreditsConsumed).toBe(
      MESHY_STAGE_CREDITS.geometry + MESHY_STAGE_CREDITS.texture,
    );

    await decide(context, context.heroId, "rig");
    await settle(context, context.heroId);
    expect(project(context).meshyCreditsConsumed).toBe(
      MESHY_STAGE_CREDITS.geometry +
        MESHY_STAGE_CREDITS.texture +
        MESHY_STAGE_CREDITS.rig,
    );

    await decide(context, context.heroId, "animate");
    const animated = await settle(context, context.heroId);
    expect(animated.stage).toBe("animation");
    expect(project(context).meshyCreditsConsumed).toBe(
      MESHY_STAGE_CREDITS.geometry +
        MESHY_STAGE_CREDITS.texture +
        MESHY_STAGE_CREDITS.rig +
        MESHY_STAGE_CREDITS.animation,
    );
  });

  /* Meshy publishes no free-retry path on its public API. The web app's 12
     retries per asset are not reachable from POST /openapi/v1/*, so a retry
     here is a brand-new 20-credit geometry task and must be priced as one. */
  it("charges a retry as a new geometry task, not a free re-roll", async () => {
    const context = fixture();
    await context.lifecycle.start(context.projectId, {
      assetId: context.heroId,
    });
    const first = await settle(context, context.heroId);
    const firstGlb = first.runs[0]!.model!.sha256;

    const retried = await decide(context, context.heroId, "retry");
    expect(retried.record.runs).toHaveLength(2);
    expect(retried.record.runs[1]).toMatchObject({
      stage: "geometry",
      round: 2,
      reservedCredits: MESHY_STAGE_CREDITS.geometry,
    });
    expect(retried.record.decisions.at(-1)).toMatchObject({
      decision: "retry",
      credits: 20,
    });

    const second = await settle(context, context.heroId);
    expect(project(context).meshyCreditsConsumed).toBe(
      MESHY_STAGE_CREDITS.geometry * 2,
    );
    expect(second.runs[1]!.model!.sha256).not.toBe(firstGlb);
  });

  it("keeps a scrapped asset terminal and says what it cost", async () => {
    const context = fixture();
    await context.lifecycle.start(context.projectId, {
      assetId: context.heroId,
    });
    await settle(context, context.heroId);
    const { record } = await decide(context, context.heroId, "scrap");
    expect(record.status).toBe("scrapped");
    expect(record.terminalReason).toBe("Scrapped after 20 credits.");

    const view = context.lifecycle.views(context.projectId)[context.heroId]!;
    expect(view.offers).toEqual([]);
    await expect(decide(context, context.heroId, "retry")).rejects.toThrow(
      /not offered/,
    );
  });

  /* Meshy refunds a FAILED task and reports zero consumed credits. An EXPIRED
     one succeeded, was billed, and then had its result deleted. Collapsing the
     two would make an already-paid-for result look like a free retry. */
  it("separates a refunded failure from a billed expiry", async () => {
    const failing = fixture({ simulation: { outcomeFor: () => "failed" } });
    await failing.lifecycle.start(failing.projectId, {
      assetId: failing.heroId,
    });
    const failed = await settle(failing, failing.heroId);
    expect(failed.status).toBe("failed");
    expect(failed.runs[0]!.consumedCredits).toBe(0);
    expect(project(failing).meshyCreditsConsumed).toBe(0);
    expect(project(failing).meshyCreditsReserved).toBe(0);
    expect(eventTypes(failing)).toContain("asset.stage-failed");

    const expiring = fixture({ simulation: { outcomeFor: () => "expired" } });
    await expiring.lifecycle.start(expiring.projectId, {
      assetId: expiring.heroId,
    });
    const expired = await settle(expiring, expiring.heroId);
    expect(expired.status).toBe("expired");
    expect(expired.runs[0]!.consumedCredits).toBe(MESHY_STAGE_CREDITS.geometry);
    expect(project(expiring).meshyCreditsConsumed).toBe(
      MESHY_STAGE_CREDITS.geometry,
    );
    expect(eventTypes(expiring)).toContain("asset.stage-expired");

    /* Recovery from either is the same visible new spend. */
    for (const context of [failing, expiring]) {
      const offers = context.lifecycle.views(context.projectId)[context.heroId]!
        .offers;
      expect(offers.map(({ decision }) => decision)).toEqual([
        "retry",
        "scrap",
      ]);
      expect(offers[0]!.credits).toBe(MESHY_STAGE_CREDITS.geometry);
    }
  });

  it("refuses to rig anything the plan did not mark as a humanoid", async () => {
    const context = fixture();
    await context.lifecycle.start(context.projectId, {
      assetId: context.propId,
    });
    await settle(context, context.propId);
    await decide(context, context.propId, "texture");
    await settle(context, context.propId);

    const view = context.lifecycle.views(context.projectId)[context.propId]!;
    expect(view.rigEligible).toBe(false);
    expect(view.rigEligibilityReason).toMatch(/humanoid heroes only/);
    expect(
      view.offers.find(({ decision }) => decision === "rig"),
    ).toBeUndefined();
    await expect(decide(context, context.propId, "rig")).rejects.toThrow(
      /humanoid heroes only/,
    );
    expect(project(context).meshyCreditsConsumed).toBe(
      MESHY_STAGE_CREDITS.geometry + MESHY_STAGE_CREDITS.texture,
    );
  });

  /* The planner only sets poseMode on a hero it means to rig later. A hero
     without one is a hero Meshy's rigger would reject after taking 5 credits. */
  it("refuses to rig a hero the plan never gave a pose", () => {
    const context = fixture({ heroPose: "none" });
    const view = context.lifecycle.views(context.projectId)[context.heroId]!;
    expect(view.rigEligible).toBe(false);
    expect(view.rigEligibilityReason).toMatch(/did not mark this hero/);
    expect(
      view.offers.find(({ decision }) => decision === "rig"),
    ).toBeUndefined();
  });

  it("lets an approved pose-less hero be marked biped after geometry and texture", async () => {
    const context = fixture({
      mode: "live",
      heroPose: "none",
      assetPlanReplanCount: 1,
    });
    const before = project(context);
    const approvedPlanRevisionId = before.assetPlan!.revisionId;
    const approval = before.assetPlanApproval;
    await context.lifecycle.start(context.projectId, {
      assetId: context.heroId,
    });
    await settle(context, context.heroId);
    await decide(context, context.heroId, "texture");
    await settle(context, context.heroId);
    const submissionsBeforeOverride = context.adapter.submissions.length;

    await context.lifecycle.overrideRigEligibility(context.projectId, {
      assetId: context.heroId,
      biped: true,
    });

    const view = context.lifecycle.views(context.projectId)[context.heroId]!;
    expect(view.rigEligible).toBe(true);
    expect(
      view.offers.find(({ decision }) => decision === "rig"),
    ).toMatchObject({ available: true, credits: MESHY_STAGE_CREDITS.rig });
    expect(context.adapter.submissions).toHaveLength(submissionsBeforeOverride);
    expect(project(context)).toMatchObject({
      assetPlan: { revisionId: approvedPlanRevisionId },
      assetPlanApproval: approval,
      assetPlanReplanCount: 1,
    });
    expect(eventTypes(context)).toContain("asset.rig-eligibility-overridden");
    await expect(decide(context, context.heroId, "rig")).resolves.toBeDefined();
    await settle(context, context.heroId);
    expect(
      context.lifecycle
        .views(context.projectId)
        [context.heroId]!.offers.find(({ decision }) => decision === "animate"),
    ).toMatchObject({
      available: true,
      credits: MESHY_STAGE_CREDITS.animation,
    });
    await expect(
      decide(context, context.heroId, "animate"),
    ).resolves.toBeDefined();
  });

  it("applies a biped override before geometry and sends its effective A-pose", async () => {
    const context = fixture({ heroPose: "none" });
    context.lifecycle.overrideRigEligibility(context.projectId, {
      assetId: context.heroId,
      biped: true,
    });

    const view = context.lifecycle.views(context.projectId)[context.heroId]!;
    expect(view).toMatchObject({
      rigEligible: true,
      poseMode: "a-pose",
      rigEligibilitySource: "manual-biped",
    });
    expect(context.adapter.submissions).toEqual([]);
    await context.lifecycle.start(context.projectId, {
      assetId: context.heroId,
    });
    expect(context.adapter.submissions[0]).toMatchObject({
      stage: "geometry",
      poseMode: "a-pose",
    });
  });

  it("lets a user-marked kit reach rig submission despite its planned classification", async () => {
    const context = fixture();
    await context.lifecycle.start(context.projectId, {
      assetId: context.propId,
    });
    await settle(context, context.propId);
    await decide(context, context.propId, "texture");
    await settle(context, context.propId);

    context.lifecycle.overrideRigEligibility(context.projectId, {
      assetId: context.propId,
      biped: true,
    });

    expect(
      context.lifecycle.views(context.projectId)[context.propId],
    ).toMatchObject({
      rigEligible: true,
      poseMode: "a-pose",
      rigEligibilitySource: "manual-biped",
      rigEligibilityReason: expect.stringMatching(
        /overriding its planned classification/,
      ),
    });
    context.lifecycle.overrideRigEligibility(context.projectId, {
      assetId: context.propId,
      biped: false,
    });
    expect(
      context.lifecycle.views(context.projectId)[context.propId],
    ).toMatchObject({
      rigEligible: false,
      rigEligibilitySource: "manual-not-biped",
    });
    context.lifecycle.overrideRigEligibility(context.projectId, {
      assetId: context.propId,
      biped: true,
    });
    await expect(decide(context, context.propId, "rig")).resolves.toBeDefined();
    expect(context.adapter.submissions.at(-1)).toMatchObject({ stage: "rig" });
  });

  it("keeps rig authorization closed when no plan, detection or override supplies a pose", async () => {
    const context = fixture({ heroPose: "none" });
    await context.lifecycle.start(context.projectId, {
      assetId: context.heroId,
    });
    await settle(context, context.heroId);
    await decide(context, context.heroId, "texture");
    await settle(context, context.heroId);
    const submissionsBeforeRig = context.adapter.submissions.length;

    await expect(decide(context, context.heroId, "rig")).rejects.toThrow(
      /did not mark this hero/,
    );
    expect(context.adapter.submissions).toHaveLength(submissionsBeforeRig);
  });

  it("refuses a decision priced differently from the one the studio showed", async () => {
    const context = fixture();
    await context.lifecycle.start(context.projectId, {
      assetId: context.heroId,
    });
    await settle(context, context.heroId);
    await expect(
      context.lifecycle.decide(context.projectId, {
        assetId: context.heroId,
        decision: "texture",
        acknowledgedCredits: 0,
      }),
    ).rejects.toThrow(/costs 10 credits, but 0 were acknowledged/);
    expect(project(context).meshyCreditsReserved).toBe(0);
  });

  it("refuses a stage that would exceed the credit cap, before submitting", async () => {
    const context = fixture({ meshyCreditBudget: 15 });
    await expect(
      context.lifecycle.start(context.projectId, { assetId: context.heroId }),
    ).rejects.toSatisfy(
      (error) =>
        isProviderPreflightError(error) && error.code === "budget-refused",
    );
    expect(project(context).meshyCreditsReserved).toBe(0);
    expect(project(context).assetStages?.[context.heroId]).toBeUndefined();
  });

  it("records every transition and decision as an event", async () => {
    const context = fixture();
    await context.lifecycle.start(context.projectId, {
      assetId: context.heroId,
    });
    await settle(context, context.heroId);
    await decide(context, context.heroId, "texture");
    await settle(context, context.heroId);
    await decide(context, context.heroId, "accept");
    expect(
      eventTypes(context).filter((type) => type.startsWith("asset.")),
    ).toEqual([
      "asset.stage-started",
      "asset.stage-succeeded",
      "asset.stage-decided",
      "asset.stage-started",
      "asset.stage-succeeded",
      "asset.stage-decided",
    ]);
  });

  it("only starts an asset once", async () => {
    const context = fixture();
    await context.lifecycle.start(context.projectId, {
      assetId: context.heroId,
    });
    await expect(
      context.lifecycle.start(context.projectId, { assetId: context.heroId }),
    ).rejects.toThrow(/already started/);
  });
});

describe("staged snapshot surface", () => {
  it("describes every planned asset, started or not", () => {
    const context = fixture();
    const views = context.lifecycle.views(context.projectId);
    expect(Object.keys(views).sort()).toEqual(
      [context.heroId, context.propId].sort(),
    );
    const hero = views[context.heroId]!;
    expect(hero).toMatchObject({
      name: "Warden",
      classification: "hero",
      poseMode: "a-pose",
      status: "not-started",
      stage: "geometry",
      progress: 0,
      rigEligible: true,
      creditsReserved: 0,
      creditsConsumed: 0,
      offers: [],
    });
    expect(hero.preview).toBeUndefined();
    expect(hero.activeRun).toBeUndefined();
  });

  it("carries the preview, the live run and the priced CTAs", async () => {
    const context = fixture();
    await context.lifecycle.start(context.projectId, {
      assetId: context.heroId,
    });
    const running = context.lifecycle.views(context.projectId)[context.heroId]!;
    expect(running.status).toBe("running");
    expect(running.activeRun).toMatchObject({ stage: "geometry", progress: 0 });
    expect(running.creditsReserved).toBe(MESHY_STAGE_CREDITS.geometry);
    expect(running.offers).toEqual([]);

    await settle(context, context.heroId);
    const reviewing = context.lifecycle.views(context.projectId)[
      context.heroId
    ]!;
    expect(reviewing.status).toBe("review");
    expect(reviewing.progress).toBe(100);
    expect(reviewing.preview).toMatchObject({
      stage: "geometry",
      round: 1,
      textured: false,
      rigged: false,
      animated: false,
    });
    expect(reviewing.preview!.glb.uri).toMatch(/^\/api\/artifacts\//);
    expect(
      reviewing.offers.map(({ decision, credits }) => [decision, credits]),
    ).toEqual([
      ["texture", 10],
      ["retry", 20],
      ["scrap", 0],
    ]);

    await decide(context, context.heroId, "texture");
    await settle(context, context.heroId);
    const textured = context.lifecycle.views(context.projectId)[
      context.heroId
    ]!;
    expect(textured.preview).toMatchObject({
      stage: "texture",
      textured: true,
      rigged: false,
    });
    expect(
      textured.offers.map(({ decision, credits }) => [decision, credits]),
    ).toEqual([
      ["accept", 0],
      ["retexture", 10],
      ["rig", 5],
      ["scrap", 0],
    ]);
  });
});

describe("Meshy configuration", () => {
  it("defaults to the pinned, high-polycount, 4K profile", () => {
    const context = fixture();
    expect(context.lifecycle.config(context.projectId)).toEqual(
      DEFAULT_MESHY_CONFIG,
    );
    expect(DEFAULT_MESHY_CONFIG).toMatchObject({
      modelVersion: "meshy-6",
      topology: "triangle",
      targetPolycount: 10_000,
      textureResolution: "4k",
      deliveredPolycountPreset: "standard",
      removeLighting: true,
      imageEnhancement: true,
    });
  });

  it("persists a patch and leaves the rest of the profile alone", () => {
    const context = fixture();
    const updated = context.lifecycle.updateConfig(context.projectId, {
      deliveredPolycountPreset: "background",
      realWorldHeightMeters: 1.85,
    });
    expect(updated).toMatchObject({
      deliveredPolycountPreset: "background",
      realWorldHeightMeters: 1.85,
      targetPolycount: 10_000,
      modelVersion: "meshy-6",
    });
    expect(context.lifecycle.config(context.projectId)).toEqual(updated);
    expect(eventTypes(context)).toContain("asset.meshy-config-updated");
  });

  /* The remesher destroys form below this target and polycount does not change
     the price, so a low request is pure loss. Delivered low-poly is metadata. */
  it("refuses a target polycount below the floor and a model repoint", () => {
    const context = fixture();
    expect(() =>
      context.lifecycle.updateConfig(context.projectId, {
        targetPolycount: 2_000,
      }),
    ).toThrow();
    expect(() =>
      context.lifecycle.updateConfig(context.projectId, {
        modelVersion: "latest",
      }),
    ).toThrow();
    expect(() =>
      context.lifecycle.updateConfig(context.projectId, {
        textureResolution: "8k",
      }),
    ).toThrow();
    expect(context.lifecycle.config(context.projectId)).toEqual(
      DEFAULT_MESHY_CONFIG,
    );
  });

  it("locks the settings while a paid task is in flight", async () => {
    const context = fixture();
    await context.lifecycle.start(context.projectId, {
      assetId: context.heroId,
    });
    expect(() =>
      context.lifecycle.updateConfig(context.projectId, {
        textureResolution: "2k",
      }),
    ).toThrow(/locked while .* has a geometry task in flight/);

    await settle(context, context.heroId);
    expect(
      context.lifecycle.updateConfig(context.projectId, {
        textureResolution: "2k",
      }).textureResolution,
    ).toBe("2k");
  });
});

/* The Images stage is where a human looks at four views and says "build this".
   Before this existed the approved set stayed in the browser and Meshy was
   handed a single unrelated concept image instead. */
describe("approved reference sets", () => {
  const geometryImages = (context: Fixture) => {
    const submitted = context.adapter.submissions[0];
    if (submitted?.stage !== "geometry")
      throw new Error("The first submission was not a geometry task.");
    return submitted.images;
  };

  const approveFourViews = async (context: Fixture) =>
    await context.lifecycle.recordReferences(context.projectId, {
      assetId: context.heroId,
      /* Deliberately not cardinal order: the browser sends whatever the
         template happened to iterate. */
      views: [
        { role: "right", source: "generated", dataUrl: pngDataUrl(10) },
        { role: "front", source: "uploaded", dataUrl: pngDataUrl(20) },
        { role: "back", source: "generated", dataUrl: pngDataUrl(30) },
        { role: "left", source: "generated", dataUrl: pngDataUrl(40) },
      ],
    });

  it("hands Meshy the approved views, in cardinal order, not the anchor", async () => {
    const context = fixture();
    const set = await approveFourViews(context);
    expect(set.views.map(({ role }) => role)).toEqual([
      "front",
      "left",
      "back",
      "right",
    ]);
    expect(set.views.map(({ source }) => source)).toEqual([
      "uploaded",
      "generated",
      "generated",
      "generated",
    ]);

    await context.lifecycle.start(context.projectId, {
      assetId: context.heroId,
    });
    const images = geometryImages(context);
    expect(images.map(({ artifact }) => artifact.sha256)).toEqual(
      set.views.map(({ image }) => image.sha256),
    );
    expect(images.map(({ artifact }) => artifact.sha256)).not.toContain(
      context.anchorSha256,
    );
    /* Four images is what makes this a multi-image request downstream. */
    expect(images).toHaveLength(4);
  });

  it("auto-detects a replay biped when references are approved without submitting to Meshy", async () => {
    const context = fixture({ heroPose: "none" });
    const recordSubmission = vi.spyOn(
      context.repository,
      "recordSubmissionIntent",
    );
    await approveFourViews(context);

    expect(
      context.lifecycle.views(context.projectId)[context.heroId],
    ).toMatchObject({
      rigEligible: true,
      poseMode: "a-pose",
      rigEligibilitySource: "auto-biped",
      bipedDetection: {
        biped: true,
        provider: "fulcrum-replay",
        model: "replay-biped-heuristic-v1",
      },
    });
    expect(eventTypes(context)).toContain("asset.biped-detected");
    expect(context.adapter.submissions).toEqual([]);
    expect(recordSubmission).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "asset-biped-detection",
        provider: "fulcrum-replay",
      }),
    );
    expect(recordSubmission).not.toHaveBeenCalledWith(
      expect.objectContaining({ provider: "meshy" }),
    );
  });

  it("does not run or grant automatic biped detection for a non-hero", async () => {
    const context = fixture();
    const recordSubmission = vi.spyOn(
      context.repository,
      "recordSubmissionIntent",
    );
    await context.lifecycle.recordReferences(context.projectId, {
      assetId: context.propId,
      views: [{ role: "front", source: "uploaded", dataUrl: pngDataUrl(55) }],
    });

    expect(
      project(context).assetBipedDetections?.[context.propId],
    ).toBeUndefined();
    const view = context.lifecycle.views(context.projectId)[context.propId]!;
    expect(view).toMatchObject({
      rigEligible: false,
      rigEligibilitySource: "classification",
    });
    expect(view.bipedDetection).toBeUndefined();
    expect(recordSubmission).not.toHaveBeenCalledWith(
      expect.objectContaining({ operation: "asset-biped-detection" }),
    );
    await expect(
      context.lifecycle.detectBiped(context.projectId, context.propId),
    ).rejects.toThrow(/only runs for hero assets/);
    expect(recordSubmission).not.toHaveBeenCalledWith(
      expect.objectContaining({ operation: "asset-biped-detection" }),
    );
    expect(context.adapter.submissions).toEqual([]);
  });

  it("uses the approved front reference as texture style input for every texture round", async () => {
    const context = fixture();
    const set = await approveFourViews(context);
    const front = set.views.find(({ role }) => role === "front")!;
    await context.lifecycle.start(context.projectId, {
      assetId: context.heroId,
    });
    await settle(context, context.heroId);
    await decide(context, context.heroId, "texture");
    await settle(context, context.heroId);
    await decide(context, context.heroId, "retexture");

    const textures = context.adapter.submissions.filter(
      (submission) => submission.stage === "texture",
    );
    expect(textures).toHaveLength(2);
    for (const submission of textures) {
      if (submission.stage !== "texture") throw new Error("Expected texture.");
      expect(submission.styleImage.artifact.sha256).toBe(front.image.sha256);
      expect(submission.styleImage.bytes).toEqual(
        context.repository.readArtifact(front.image),
      );
    }
    expect(textures.map(({ round }) => round)).toEqual([1, 2]);
    const first = context.repository.getSubmissionByKey(
      `asset-stage:v1:${context.projectId}:${context.heroId}:texture:1`,
    );
    const second = context.repository.getSubmissionByKey(
      `asset-stage:v1:${context.projectId}:${context.heroId}:texture:2`,
    );
    expect(first?.requestId).toBeTruthy();
    expect(second?.requestId).toBeTruthy();
    expect(second?.requestId).not.toBe(first?.requestId);
  });

  it("falls back to the anchor as texture style input when no references exist", async () => {
    const context = fixture();
    await context.lifecycle.start(context.projectId, {
      assetId: context.heroId,
    });
    await settle(context, context.heroId);
    await decide(context, context.heroId, "texture");

    const texture = context.adapter.submissions.at(-1);
    if (texture?.stage !== "texture") throw new Error("Expected texture.");
    expect(texture.styleImage.artifact.sha256).toBe(context.anchorSha256);
  });

  it("gives retexture a distinct round when its style image changes to an approved front", async () => {
    const context = fixture();
    await context.lifecycle.start(context.projectId, {
      assetId: context.heroId,
    });
    await settle(context, context.heroId);
    await decide(context, context.heroId, "texture");
    await settle(context, context.heroId);
    const firstTexture = context.adapter.submissions.at(-1);
    if (firstTexture?.stage !== "texture")
      throw new Error("Expected first texture.");
    expect(firstTexture.styleImage.artifact.sha256).toBe(context.anchorSha256);

    const set = await approveFourViews(context);
    const front = set.views.find(({ role }) => role === "front")!;
    await decide(context, context.heroId, "retexture");
    const secondTexture = context.adapter.submissions.at(-1);
    if (secondTexture?.stage !== "texture")
      throw new Error("Expected second texture.");
    expect(secondTexture).toMatchObject({
      round: 2,
      styleImage: { artifact: { sha256: front.image.sha256 } },
    });
    expect(secondTexture.styleImage.artifact.sha256).not.toBe(
      firstTexture.styleImage.artifact.sha256,
    );
    const firstSubmission = context.repository.getSubmissionByKey(
      `asset-stage:v1:${context.projectId}:${context.heroId}:texture:1`,
    );
    const secondSubmission = context.repository.getSubmissionByKey(
      `asset-stage:v1:${context.projectId}:${context.heroId}:texture:2`,
    );
    expect(secondSubmission?.requestId).not.toBe(firstSubmission?.requestId);
  });

  it("lets manual decisions beat automatic detection in both directions", async () => {
    const positive = fixture({ heroPose: "none" });
    await approveFourViews(positive);
    expect(
      positive.lifecycle.views(positive.projectId)[positive.heroId]!
        .rigEligible,
    ).toBe(true);
    positive.lifecycle.overrideRigEligibility(positive.projectId, {
      assetId: positive.heroId,
      biped: false,
    });
    expect(
      positive.lifecycle.views(positive.projectId)[positive.heroId],
    ).toMatchObject({
      rigEligible: false,
      rigEligibilitySource: "manual-not-biped",
    });

    const negative = fixture({
      heroPose: "none",
      heroName: "Ancient Reliquary",
      heroRationale: "A stone objective chest bound with bronze rings.",
    });
    await approveFourViews(negative);
    expect(
      negative.lifecycle.views(negative.projectId)[negative.heroId],
    ).toMatchObject({
      rigEligible: false,
      rigEligibilitySource: "auto-not-biped",
    });
    negative.lifecycle.overrideRigEligibility(negative.projectId, {
      assetId: negative.heroId,
      biped: true,
    });
    expect(
      negative.lifecycle.views(negative.projectId)[negative.heroId],
    ).toMatchObject({
      rigEligible: true,
      poseMode: "a-pose",
      rigEligibilitySource: "manual-biped",
    });
    expect(positive.adapter.submissions).toEqual([]);
    expect(negative.adapter.submissions).toEqual([]);
  });

  it("lazily detects an already-approved reference set without re-uploading", async () => {
    const context = fixture({ heroPose: "none" });
    await approveFourViews(context);
    const state = project(context);
    context.repository.saveProject({
      ...state,
      assetBipedDetections: undefined,
    });
    expect(
      context.lifecycle.views(context.projectId)[context.heroId]!
        .bipedDetection,
    ).toBeUndefined();

    const verdict = await context.lifecycle.detectBiped(
      context.projectId,
      context.heroId,
    );
    expect(verdict.biped).toBe(true);
    expect(
      context.lifecycle.views(context.projectId)[context.heroId],
    ).toMatchObject({
      rigEligible: true,
      rigEligibilitySource: "auto-biped",
    });
    expect(context.adapter.submissions).toEqual([]);
  });

  it("re-encodes every view to PNG in the project's own artifact store", async () => {
    const context = fixture();
    const set = await approveFourViews(context);
    for (const view of set.views) {
      expect(view.image.mediaType).toBe("image/png");
      expect(
        context.repository.getProjectArtifact(
          context.projectId,
          view.image.artifactId,
        ).sha256,
      ).toBe(view.image.sha256);
    }
    expect(
      context.repository
        .listEvents(context.projectId)
        .map((event) => event.type),
    ).toContain("asset.references-approved");
  });

  it("still falls back to the anchor concept when nothing was approved", async () => {
    const context = fixture();
    await context.lifecycle.start(context.projectId, {
      assetId: context.propId,
    });
    const images = geometryImages(context);
    expect(images).toHaveLength(1);
    expect(images[0]!.artifact.sha256).toBe(context.anchorSha256);
  });

  it("exposes the approved set for the studio to hydrate from", async () => {
    const context = fixture();
    const set = await approveFourViews(context);
    expect(context.lifecycle.referenceSets(context.projectId)).toEqual({
      [context.heroId]: set,
    });
  });

  it("replaces the previous set rather than accumulating stale views", async () => {
    const context = fixture();
    await approveFourViews(context);
    const second = await context.lifecycle.recordReferences(context.projectId, {
      assetId: context.heroId,
      views: [{ role: "front", source: "uploaded", dataUrl: pngDataUrl(99) }],
    });
    expect(second.views).toHaveLength(1);
    expect(context.lifecycle.referenceSets(context.projectId)).toEqual({
      [context.heroId]: second,
    });

    await context.lifecycle.start(context.projectId, {
      assetId: context.heroId,
    });
    /* One image is a valid geometry request; it just takes the single-image
       endpoint instead of the multi-image one. */
    expect(geometryImages(context)).toHaveLength(1);
  });

  it("refuses an asset id the current plan does not contain", async () => {
    const context = fixture();
    await expect(
      context.lifecycle.recordReferences(context.projectId, {
        assetId: `${context.projectId}:planned-asset:invented`,
        views: [{ role: "front", source: "generated", dataUrl: pngDataUrl(1) }],
      }),
    ).rejects.toThrow(/not in this project's current asset plan/);
  });

  it("refuses a set without a front view or with a repeated role", async () => {
    const context = fixture();
    await expect(
      context.lifecycle.recordReferences(context.projectId, {
        assetId: context.heroId,
        views: [{ role: "left", source: "generated", dataUrl: pngDataUrl(1) }],
      }),
    ).rejects.toThrow(/requires a front view/);
    await expect(
      context.lifecycle.recordReferences(context.projectId, {
        assetId: context.heroId,
        views: [
          { role: "front", source: "generated", dataUrl: pngDataUrl(1) },
          { role: "front", source: "generated", dataUrl: pngDataUrl(2) },
        ],
      }),
    ).rejects.toThrow(/cannot repeat a view role/);
  });

  it("refuses a set that would overrun the request ceiling", async () => {
    const context = fixture();
    const huge = `data:image/png;base64,${"A".repeat(12 * 1024 * 1024)}`;
    await expect(
      context.lifecycle.recordReferences(context.projectId, {
        assetId: context.heroId,
        views: [{ role: "front", source: "uploaded", dataUrl: huge }],
      }),
    ).rejects.toThrow(/8 MB or less across every view/);
    expect(context.lifecycle.referenceSets(context.projectId)).toEqual({});
  });

  /* Reference persistence is free, but paid stages still require the workflow's
     exact finalization binding. */
  it("accepts references before plan finalization and still refuses to spend", async () => {
    const context = fixture({ assetPlanApproved: false });
    const set = await approveFourViews(context);
    expect(set.views).toHaveLength(4);
    await expect(
      context.lifecycle.start(context.projectId, { assetId: context.heroId }),
    ).rejects.toThrow(/needs the current finalized asset plan/);
    expect(context.adapter.submissions).toEqual([]);
  });

  it("refuses a stale finalization hash before submitting geometry", async () => {
    const context = fixture();
    const state = project(context);
    context.repository.saveProject({
      ...state,
      assetPlanApproval: {
        ...state.assetPlanApproval!,
        targetSha256: "0".repeat(64),
      },
    });

    await expect(
      context.lifecycle.start(context.projectId, { assetId: context.heroId }),
    ).rejects.toThrow(/needs the current finalized asset plan/);
    expect(context.adapter.submissions).toEqual([]);
  });
});
