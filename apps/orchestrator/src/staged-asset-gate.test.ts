import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ASSET_CLASS_HANDLING_POLICIES_V1,
  type GameDesignSpec,
  type ProjectSnapshot,
} from "@fulcrum/domain";
import type { StructuredModelExecution } from "@fulcrum/creative";
import type {
  ExecutionProviderStatus,
  StructuredVisionExecution,
} from "@fulcrum/execution";
import {
  SimulatedStagedAdapter,
  type StagedAssetAdapter,
  type StagedInspectInput,
  type StagedSubmitInput,
} from "@fulcrum/production";
import { ProjectRepository } from "@fulcrum/project";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectCoordinator } from "./project-coordinator.js";
import { createFulcrumServer } from "./server.js";

const roots: string[] = [];

/** Four distinct, genuinely decodable 1x1 PNGs, one per approved view. */
const VIEW_PNGS = [
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPganD4DwADLAHKt5OFggAAAABJRU5ErkJggg==",
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOIanD4DwAEbAIaNRD1aAAAAABJRU5ErkJggg==",
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNY1eDwHwAFrAJqm3MNeQAAAABJRU5ErkJggg==",
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP41eDwHwAG7AK61tf3UgAAAABJRU5ErkJggg==",
] as const;

const viewDataUrl = (index: number) =>
  `data:image/png;base64,${VIEW_PNGS[index]}`;

const fixtureVisionExecution: StructuredVisionExecution = {
  generateStructuredVision: vi.fn(async () => ({
    value: {
      biped: true,
      confidence: 0.98,
      rationale: "The fixture has a humanoid silhouette.",
    },
    provider: "openai" as const,
    model: "fixture-vision",
  })) as unknown as StructuredVisionExecution["generateStructuredVision"],
};

const fixtureVisionProviders: ExecutionProviderStatus[] = [
  {
    provider: "openai",
    access: "subscription",
    ready: true,
    installed: true,
    authenticated: true,
    capabilities: { imageGeneration: true },
    detail: "Fixture vision is ready",
  },
];

/** The simulator, plus a record of what Meshy was actually handed. */
class RecordingAdapter implements StagedAssetAdapter {
  readonly id = "fulcrum-simulated" as const;
  readonly submissions: StagedSubmitInput[] = [];
  private readonly inner = new SimulatedStagedAdapter();

  async submit(input: StagedSubmitInput) {
    this.submissions.push(input);
    return await this.inner.submit(input);
  }

  async inspect(input: StagedInspectInput) {
    return await this.inner.inspect(input);
  }
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

/**
 * A minimal approved-plan M2 world. The staged gate is the only thing under
 * test, so everything upstream of the asset plan is a hand-written revision
 * rather than a replayed creative front.
 */
const fixture = async (
  options: {
    execution?: StructuredModelExecution;
    heroPose?: "a-pose" | "t-pose" | "none";
    mode?: "live" | "replay";
  } = {},
) => {
  const root = mkdtempSync(path.join(tmpdir(), "fulcrum-staged-gate-"));
  roots.push(root);
  const repository = new ProjectRepository(root);
  const projectId = `staged-gate-${roots.length}`;
  const runId = "run-1";
  const createdAt = new Date("2026-08-28T12:00:00.000Z").toISOString();
  repository.reserveProject(projectId, createdAt);

  const revision = (entityId: string, kind: string, value: unknown) =>
    repository.writeRevision({ projectId, entityId, kind, value, runId });

  const brief = revision(`${projectId}:brief`, "game-brief", {
    text: "Staged gate fixture.",
    rightsConfirmed: true,
  });
  const gameDesignSpec = revision(
    `${projectId}:game-design-spec`,
    "game-design-spec",
    {
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
    } satisfies GameDesignSpec,
  );
  const image = repository.putArtifact(
    projectId,
    Buffer.from("anchor"),
    "image/png",
  );
  const anchorConcept = revision(
    `${projectId}:concept:hero`,
    "concept-document",
    {
      conceptId: "hero",
      name: "Warden",
      prompt: "Approved concept",
      negativePrompt: "photorealism",
      image,
      provider: "fulcrum-replay",
      model: "fixture",
      sourceRevisionIds: [brief.revisionId, gameDesignSpec.revisionId],
      ancestors: [brief, gameDesignSpec].map((entry) => ({
        revisionId: entry.revisionId,
        sha256: entry.artifact.sha256,
        kind: entry.kind,
      })),
      costUsd: 0,
    },
  );
  const conceptSet = revision(`${projectId}:concept-set`, "concept-set", {
    conceptSetId: `${projectId}:concept-set`,
    sourceDirectionRevisionId: "direction-1",
    slots: [
      {
        slotId: "gameplay-anchor",
        name: "Warden",
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
  });
  const assetId = `${projectId}:planned-asset:warden`;
  const assetPlan = revision(`${projectId}:asset-plan`, "asset-plan", {
    planId: `${projectId}:asset-plan`,
    assets: [
      {
        assetId,
        name: "Warden",
        classification: "hero",
        rationale: "The objective needs a hero asset.",
        ...((options.heroPose ?? "a-pose") === "none"
          ? {}
          : { poseMode: options.heroPose ?? "a-pose" }),
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
  });

  repository.createProject({
    schemaVersion: 1,
    milestone: "m2",
    projectId,
    name: "Staged gate",
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
    meshyCreditBudget: 200,
    meshyCreditsReserved: 0,
    meshyCreditsConsumed: 0,
    conceptReplacementCount: 0,
    brief,
    gameDesignSpec,
    gameDesignApproval: {
      approvalId: "game-design-approval-1",
      projectId,
      targetType: "game-design",
      targetRevisionId: gameDesignSpec.revisionId,
      targetSha256: gameDesignSpec.artifact.sha256,
      decision: "approved",
      decidedBy: "zach",
      decidedAt: createdAt,
    },
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
    assetPlanApproval: {
      approvalId: "asset-plan-approval-1",
      projectId,
      targetType: "asset-plan",
      targetRevisionId: assetPlan.revisionId,
      targetSha256: assetPlan.artifact.sha256,
      decision: "approved",
      decidedBy: "zach",
      decidedAt: createdAt,
    },
    createdAt,
    updatedAt: createdAt,
  });

  const adapter = new RecordingAdapter();
  const coordinator = new ProjectCoordinator(repository, {
    ...(options.execution ? { execution: options.execution } : {}),
    stagedAssetAdapter: adapter,
    stagedVisionExecution: fixtureVisionExecution,
    stagedVisionProviderStatuses: fixtureVisionProviders,
  });
  const { server } = await createFulcrumServer({
    repository,
    coordinator,
    logger: false,
    prototypeImagegen: { imageRoot: path.join(root, "images") },
  });
  const base = `/api/projects/${projectId}/assets/${encodeURIComponent(assetId)}/stages`;

  const post = async (url: string, payload: Record<string, unknown> = {}) =>
    await server.inject({ method: "POST", url, payload });
  const settle = async (): Promise<ProjectSnapshot> => {
    for (let index = 0; index < 6; index += 1) {
      const response = await post(`${base}/poll`);
      const snapshot = response.json() as ProjectSnapshot;
      if (snapshot.assetStages?.[assetId]?.status !== "running")
        return snapshot;
    }
    throw new Error("The staged task never settled.");
  };

  const references = `/api/projects/${projectId}/assets/${encodeURIComponent(assetId)}/references`;
  const approveViews = async (
    roles: readonly ("front" | "left" | "back" | "right")[],
    headers: Record<string, string> = {},
  ) =>
    await server.inject({
      method: "POST",
      url: references,
      headers,
      payload: {
        views: roles.map((role, index) => ({
          role,
          source: "generated",
          dataUrl: viewDataUrl(index),
        })),
      },
    });

  return {
    repository,
    server,
    projectId,
    assetId,
    base,
    references,
    post,
    settle,
    adapter,
    approveViews,
  };
};

describe("staged asset gate routes", () => {
  it("walks geometry to texture to rig over HTTP", async () => {
    const context = await fixture();
    const started = await context.post(`${context.base}/start`);
    expect(started.statusCode).toBe(200);
    expect(
      (started.json() as ProjectSnapshot).assetStages?.[context.assetId],
    ).toMatchObject({ status: "running", stage: "geometry", progress: 0 });

    const reviewing = await context.settle();
    const geometry = reviewing.assetStages![context.assetId]!;
    expect(geometry.status).toBe("review");
    expect(geometry.preview?.glb.uri).toMatch(/^\/api\/artifacts\//);
    expect(geometry.offers.map(({ decision }) => decision)).toEqual([
      "texture",
      "retry",
      "scrap",
    ]);

    /* The GLB the studio's viewer will fetch has to actually be servable. */
    const glb = await context.server.inject({
      method: "GET",
      url: geometry.preview!.glb.uri,
    });
    expect(glb.statusCode).toBe(200);
    expect(glb.headers["content-type"]).toBe("model/gltf-binary");
    expect(glb.rawPayload.subarray(0, 4).toString("latin1")).toBe("glTF");

    const textured = await context.post(`${context.base}/decide`, {
      decision: "texture",
      acknowledgedCredits: 10,
    });
    expect(textured.statusCode).toBe(200);
    await context.settle();
    const rigged = await context.post(`${context.base}/decide`, {
      decision: "rig",
      acknowledgedCredits: 5,
    });
    expect(rigged.statusCode).toBe(200);
    const final = await context.settle();
    expect(final.assetStages![context.assetId]).toMatchObject({
      stage: "rig",
      status: "review",
      creditsConsumed: 35,
      preview: { rigged: true, textured: true },
    });
  });

  it("returns a synchronous Meshy refusal while keeping texture review retryable", async () => {
    const context = await fixture({ mode: "live" });
    await context.post(`${context.base}/start`);
    await context.settle();
    await context.post(`${context.base}/decide`, {
      decision: "texture",
      acknowledgedCredits: 10,
    });
    await context.settle();
    const providerMessage =
      "Pose estimation failed, please provide a valid model";
    vi.spyOn(context.adapter, "submit").mockRejectedValueOnce(
      new Error(providerMessage),
    );

    const refused = await context.post(`${context.base}/decide`, {
      decision: "rig",
      acknowledgedCredits: 5,
    });

    expect(refused.statusCode).toBe(500);
    expect(refused.json()).toMatchObject({ detail: providerMessage });
    expect(
      context.repository.getProject(context.projectId).meshyCreditsReserved,
    ).toBe(0);
    expect(
      context.repository.getProject(context.projectId).assetStages?.[
        context.assetId
      ],
    ).toMatchObject({
      status: "review",
      stage: "texture",
      submitFailure: { stage: "rig", reason: providerMessage },
    });

    const retried = await context.post(`${context.base}/decide`, {
      decision: "rig",
      acknowledgedCredits: 5,
    });
    expect(retried.statusCode).toBe(200);
    expect(
      (retried.json() as ProjectSnapshot).assetStages?.[context.assetId],
    ).toMatchObject({ status: "running", stage: "rig" });
  });

  it("returns a reconciled ledger on the first snapshot that finds an orphaned rig intent", async () => {
    const context = await fixture({ mode: "live" });
    await context.post(`${context.base}/start`);
    await context.settle();
    await context.post(`${context.base}/decide`, {
      decision: "texture",
      acknowledgedCredits: 10,
    });
    await context.settle();
    const submission = context.repository.recordSubmissionIntent({
      projectId: context.projectId,
      operation: "m2-staged-rig",
      provider: "meshy",
      idempotencyKey: `asset-stage:v1:${context.projectId}:${context.assetId}:rig:1`,
      payload: {
        assetId: context.assetId,
        stage: "rig",
        round: 1,
        pollCount: 0,
      },
    });
    context.repository.reserveMeshySubmissionCredits(
      submission.requestId,
      5,
      "Meshy rigging",
    );
    const providerCallsBeforeTouch = context.adapter.submissions.length;

    const response = await context.server.inject({
      method: "GET",
      url: `/api/projects/${context.projectId}`,
    });
    const snapshot = response.json() as ProjectSnapshot;

    expect(response.statusCode).toBe(200);
    expect(snapshot.state.meshyCreditsReserved).toBe(0);
    expect(snapshot.assetStages?.[context.assetId]).toMatchObject({
      status: "review",
      stage: "texture",
      submitFailure: { stage: "rig", recovered: true },
    });
    expect(context.adapter.submissions).toHaveLength(providerCallsBeforeTouch);
  });

  it("exposes the Meshy profile and refuses an unpinned model", async () => {
    const context = await fixture();
    const snapshot = (
      await context.server.inject({
        method: "GET",
        url: `/api/projects/${context.projectId}`,
      })
    ).json() as ProjectSnapshot;
    expect(snapshot.meshyConfig).toMatchObject({
      modelVersion: "meshy-6",
      targetPolycount: 10_000,
      textureResolution: "4k",
    });

    const updated = await context.post(
      `/api/projects/${context.projectId}/settings/meshy`,
      { deliveredPolycountPreset: "hero" },
    );
    expect(updated.statusCode).toBe(200);
    expect(
      (updated.json() as ProjectSnapshot).meshyConfig?.deliveredPolycountPreset,
    ).toBe("hero");

    const refused = await context.post(
      `/api/projects/${context.projectId}/settings/meshy`,
      { modelVersion: "latest" },
    );
    expect(refused.statusCode).toBe(400);
  });

  it("refuses a settings change while a paid task is in flight", async () => {
    const context = await fixture();
    await context.post(`${context.base}/start`);
    const refused = await context.post(
      `/api/projects/${context.projectId}/settings/meshy`,
      { textureResolution: "2k" },
    );
    expect(refused.statusCode).toBe(500);
    expect(refused.json()).toMatchObject({
      code: "payload-invalid",
      detail: expect.stringContaining("locked while"),
    });
  });

  it("refuses a decision the gate is not offering", async () => {
    const context = await fixture();
    await context.post(`${context.base}/start`);
    await context.settle();
    const refused = await context.post(`${context.base}/decide`, {
      decision: "rig",
      acknowledgedCredits: 5,
    });
    expect(refused.statusCode).toBe(500);
    expect(refused.json()).toMatchObject({
      detail: expect.stringContaining("not offered"),
    });
  });

  it("records a trusted post-approval rig override and unlocks the 5 CR decision", async () => {
    const context = await fixture({ mode: "live", heroPose: "none" });
    const stateBefore = context.repository.getProject(context.projectId);
    await context.post(`${context.base}/start`);
    await context.settle();
    await context.post(`${context.base}/decide`, {
      decision: "texture",
      acknowledgedCredits: 10,
    });
    await context.settle();
    const submissionsBeforeOverride = context.adapter.submissions.length;

    const overridden = await context.server.inject({
      method: "POST",
      url: `/api/projects/${context.projectId}/assets/${encodeURIComponent(context.assetId)}/rig-eligibility`,
      headers: { origin: "http://localhost:4311" },
      payload: { biped: true },
    });
    expect(overridden.statusCode).toBe(200);
    expect(
      (overridden.json() as ProjectSnapshot).assetStages?.[context.assetId],
    ).toMatchObject({
      rigEligible: true,
      poseMode: "a-pose",
      rigEligibilitySource: "manual-biped",
      offers: expect.arrayContaining([
        expect.objectContaining({
          decision: "rig",
          credits: 5,
          available: true,
        }),
      ]),
    });
    expect(context.adapter.submissions).toHaveLength(submissionsBeforeOverride);
    const stateAfter = context.repository.getProject(context.projectId);
    expect(stateAfter).toMatchObject({
      assetPlan: { revisionId: stateBefore.assetPlan!.revisionId },
      assetPlanApproval: stateBefore.assetPlanApproval,
    });
    expect(stateAfter.assetPlanReplanCount).toBe(
      stateBefore.assetPlanReplanCount,
    );

    const rigged = await context.post(`${context.base}/decide`, {
      decision: "rig",
      acknowledgedCredits: 5,
    });
    expect(rigged.statusCode).toBe(200);
  });

  it("origin-guards the manual rig override", async () => {
    const context = await fixture({ heroPose: "none" });
    const refused = await context.server.inject({
      method: "POST",
      url: `/api/projects/${context.projectId}/assets/${encodeURIComponent(context.assetId)}/rig-eligibility`,
      headers: { origin: "http://evil.example" },
      payload: { biped: true },
    });
    expect(refused.statusCode).toBe(403);
    expect(
      context.repository.getProject(context.projectId)
        .assetRigEligibilityOverrides,
    ).toBeUndefined();
  });
});

/* The approved reference set is the whole point of the Images stage: it is
   what Meshy will be shown. Before this route existed it never left the
   browser, and geometry silently fell back to one unrelated concept image. */
describe("approved reference set route", () => {
  it("persists the approved views and feeds them to geometry", async () => {
    const context = await fixture();
    /* Sent in the order the studio's template iterates, not cardinal order. */
    const stored = await context.approveViews([
      "right",
      "front",
      "back",
      "left",
    ]);
    expect(stored.statusCode).toBe(200);
    const snapshot = stored.json() as ProjectSnapshot;
    const set = snapshot.assetReferenceSets?.[context.assetId];
    expect(set?.views.map(({ role }) => role)).toEqual([
      "front",
      "left",
      "back",
      "right",
    ]);
    for (const view of set!.views)
      expect(view.image.uri).toMatch(/^\/api\/artifacts\//);
    expect(snapshot.assetStages?.[context.assetId]).toMatchObject({
      rigEligibilitySource: "auto-biped",
      rigEligible: true,
    });
    expect(context.adapter.submissions).toEqual([]);

    /* A reload sees the same set, which is what the gate hydrates from. */
    const reloaded = (
      await context.server.inject({
        method: "GET",
        url: `/api/projects/${context.projectId}`,
      })
    ).json() as ProjectSnapshot;
    expect(reloaded.assetReferenceSets?.[context.assetId]).toEqual(set);

    /* Each stored view must be servable: the gate renders these URIs. */
    const front = await context.server.inject({
      method: "GET",
      url: set!.views[0]!.image.uri,
    });
    expect(front.statusCode).toBe(200);
    expect(front.headers["content-type"]).toBe("image/png");

    expect((await context.post(`${context.base}/start`)).statusCode).toBe(200);
    const submitted = context.adapter.submissions[0];
    if (submitted?.stage !== "geometry")
      throw new Error("The first submission was not a geometry task.");
    expect(submitted.images.map(({ artifact }) => artifact.sha256)).toEqual(
      set!.views.map(({ image }) => image.sha256),
    );
  });

  it("refuses a request that is not from a trusted studio origin", async () => {
    const context = await fixture();
    const refused = await context.approveViews(["front"], {
      origin: "http://evil.example",
    });
    expect(refused.statusCode).toBe(403);
    expect(
      (
        (
          await context.server.inject({
            method: "GET",
            url: `/api/projects/${context.projectId}`,
          })
        ).json() as ProjectSnapshot
      ).assetReferenceSets,
    ).toBeUndefined();

    const allowed = await context.approveViews(["front"], {
      origin: "http://localhost:4311",
    });
    expect(allowed.statusCode).toBe(200);
  });

  it("refuses an asset id this project's plan does not contain", async () => {
    const context = await fixture();
    const refused = await context.server.inject({
      method: "POST",
      url: `/api/projects/${context.projectId}/assets/borrowed-asset/references`,
      payload: {
        views: [
          { role: "front", source: "generated", dataUrl: viewDataUrl(0) },
        ],
      },
    });
    expect(refused.statusCode).toBe(500);
    expect(refused.json()).toMatchObject({
      detail: expect.stringContaining(
        "not in this project's current asset plan",
      ),
    });
  });

  it("refuses a set that would overrun the request ceiling", async () => {
    const context = await fixture();
    const refused = await context.server.inject({
      method: "POST",
      url: context.references,
      payload: {
        views: [
          {
            role: "front",
            source: "uploaded",
            dataUrl: `data:image/png;base64,${"A".repeat(11 * 1024 * 1024)}`,
          },
        ],
      },
    });
    expect(refused.statusCode).toBe(500);
    expect(refused.json()).toMatchObject({
      detail: expect.stringContaining("8 MB or less across every view"),
    });
  });

  it("refuses a set with no front view", async () => {
    const context = await fixture();
    const refused = await context.approveViews(["left", "back"]);
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({
      detail: expect.stringContaining("requires a front view"),
    });
  });

  it("lazily backfills a verdict through the trusted detection route", async () => {
    const context = await fixture({ heroPose: "none" });
    expect((await context.approveViews(["front"])).statusCode).toBe(200);
    const state = context.repository.getProject(context.projectId);
    context.repository.saveProject({
      ...state,
      assetBipedDetections: undefined,
    });

    const detected = await context.server.inject({
      method: "POST",
      url: `/api/projects/${context.projectId}/assets/${encodeURIComponent(context.assetId)}/biped-detection`,
      headers: { origin: "http://localhost:4311" },
    });
    expect(detected.statusCode).toBe(200);
    expect(
      (detected.json() as ProjectSnapshot).assetStages?.[context.assetId],
    ).toMatchObject({
      rigEligible: true,
      rigEligibilitySource: "auto-biped",
    });
    expect(context.adapter.submissions).toEqual([]);
  });
});

describe("asset-plan section amendment route", () => {
  it("amends_a_live_shaped_gate_without_touching_the_spent_referenced_boss", async () => {
    const generateStructured = vi.fn(
      async (input: { systemPrompt: string; prompt: string }) => {
        expect(input.systemPrompt).toContain(
          "Keep every frozen asset present and byte-for-byte unchanged",
        );
        expect(input.systemPrompt).toContain(
          "New assets are unresolved plan slots only",
        );
        expect(input.prompt).toContain("two more character slots");
        return {
          provider: "openai" as const,
          model: "amendment-fixture",
          value: {
            assets: [
              {
                assetKey: "warden",
                name: "Renamed spent boss",
                classification: "hero",
                rationale: "The objective needs a hero asset.",
                sourceConceptSlotIds: ["gameplay-anchor"],
                dependsOnAssetKeys: [],
                poseMode: "a-pose",
                procedure: null,
                acceptanceCriteria: ["Readable from the arena perimeter."],
              },
              {
                assetKey: "character-amendment-scout",
                name: "Character Scout Slot",
                classification: "hero",
                rationale: "A second readable actor slot.",
                sourceConceptSlotIds: ["gameplay-anchor"],
                dependsOnAssetKeys: [],
                poseMode: null,
                procedure: null,
                acceptanceCriteria: ["Readable at gameplay distance."],
              },
              {
                assetKey: "character-amendment-rival",
                name: "Character Rival Slot",
                classification: "hero",
                rationale: "A third readable actor slot.",
                sourceConceptSlotIds: ["gameplay-anchor"],
                dependsOnAssetKeys: [],
                poseMode: null,
                procedure: null,
                acceptanceCriteria: ["Distinct from the other actors."],
              },
            ],
          },
        };
      },
    ) as unknown as StructuredModelExecution["generateStructured"];
    const context = await fixture({
      mode: "live",
      execution: { generateStructured },
    });
    const approved = await context.approveViews(
      ["front", "left", "back", "right"],
      { origin: "http://localhost:4311" },
    );
    expect(approved.statusCode, approved.body).toBe(200);
    expect((await context.post(`${context.base}/start`)).statusCode).toBe(200);

    const beforeState = context.repository.getProject(context.projectId);
    const beforePlan = context.repository.resolveRevision<
      NonNullable<ProjectSnapshot["assetPlan"]>
    >(beforeState.assetPlan!);
    const frozenBoss = beforePlan.assets.find(
      ({ assetId }) => assetId === context.assetId,
    )!;
    const adapterSubmissionCount = context.adapter.submissions.length;
    const amended = await context.server.inject({
      method: "POST",
      url: `/api/projects/${context.projectId}/asset-plan/amend`,
      headers: { origin: "http://localhost:4311" },
      payload: {
        section: "hero",
        request: "I'd like two more character slots",
      },
    });

    expect(amended.statusCode).toBe(200);
    const snapshot = amended.json() as ProjectSnapshot;
    const afterState = context.repository.getProject(context.projectId);
    expect(snapshot.assetPlan?.assets).toHaveLength(3);
    expect(
      snapshot.assetPlan?.assets.find(
        ({ assetId }) => assetId === context.assetId,
      ),
    ).toEqual(frozenBoss);
    expect(
      snapshot.assetPlan?.assets
        .filter(({ assetId }) => assetId !== context.assetId)
        .map(({ name }) => name),
    ).toEqual(["Character Rival Slot", "Character Scout Slot"]);
    expect(snapshot.assetPlan?.provenance).toMatchObject({
      operation: "asset-plan.amend",
      parentRevisionIds: expect.arrayContaining([
        beforeState.assetPlan!.revisionId,
      ]),
    });
    expect(afterState.assetPlanApproval).toMatchObject({
      decision: "approved",
      decidedBy: "fulcrum:auto-finalizer",
      targetRevisionId: afterState.assetPlan?.revisionId,
      targetSha256: afterState.assetPlan?.artifact.sha256,
    });
    expect(afterState.assetStages).toEqual(beforeState.assetStages);
    expect(afterState.assetReferenceSets).toEqual(
      beforeState.assetReferenceSets,
    );
    expect(afterState.meshyCreditsReserved).toBe(
      beforeState.meshyCreditsReserved,
    );
    expect(afterState.meshyCreditsConsumed).toBe(
      beforeState.meshyCreditsConsumed,
    );
    expect(afterState.spentUsd).toBe(beforeState.spentUsd);
    expect(context.adapter.submissions).toHaveLength(adapterSubmissionCount);
    for (const asset of snapshot.assetPlan!.assets.filter(
      ({ assetId }) => assetId !== context.assetId,
    )) {
      expect(snapshot.assetStages?.[asset.assetId]).toMatchObject({
        status: "not-started",
        runs: [],
        creditsReserved: 0,
        creditsConsumed: 0,
      });
      expect(snapshot.assetReferenceSets?.[asset.assetId]).toBeUndefined();
    }
    expect(
      context.repository
        .listEvents(context.projectId)
        .findLast(({ type }) => type === "asset-plan.amended"),
    ).toMatchObject({
      payload: {
        section: "hero",
        request: "I'd like two more character slots",
        fromRevisionId: beforeState.assetPlan?.revisionId,
        toRevisionId: afterState.assetPlan?.revisionId,
        addedAssetIds: expect.arrayContaining([
          `${context.projectId}:planned-asset:character-amendment-scout`,
          `${context.projectId}:planned-asset:character-amendment-rival`,
        ]),
        changedAssetIds: [],
        removedAssetIds: [],
      },
    });
    expect(generateStructured).toHaveBeenCalledTimes(1);
  });

  it("origin_guards_asset_plan_amendments", async () => {
    const context = await fixture();
    const refused = await context.server.inject({
      method: "POST",
      url: `/api/projects/${context.projectId}/asset-plan/amend`,
      headers: { origin: "https://evil.example" },
      payload: { section: "hero", request: "Add one character" },
    });

    expect(refused.statusCode).toBe(403);
    expect(
      context.repository
        .listEvents(context.projectId)
        .some(({ type }) => type === "asset-plan.amended"),
    ).toBe(false);
  });
});
