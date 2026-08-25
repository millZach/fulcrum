import { ProjectRepository } from "@fulcrum/project";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  adapterJobRefFromSubmissionPayload,
  assetRequestFingerprint,
  decideMultiviewStrategy,
  type AssetGenerationJob,
  type MultiviewImageInputCapability,
} from "./asset-generation.js";
import {
  buildMeshyRequest,
  MeshyAssetAdapter,
  meshyMultiviewCapability,
} from "./meshy-adapter.js";
import { createReplayAssetAdapter } from "./replay-asset-adapter.js";
import {
  buildTripoTaskPayload,
  tripoMultiviewCapability,
} from "./tripo-adapter.js";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MESHY_API_KEY;
  delete process.env.FULCRUM_MESHY_MODEL;
  delete process.env.FULCRUM_MESHY_RESERVE_USD;
});

const capable: MultiviewImageInputCapability = {
  supported: true,
  minViews: 2,
  maxViews: 4,
  primaryRole: "front",
  roles: ["front", "left", "back", "right"],
  payloadShape: "ordered-images",
  profileVersion: "test-v1",
};

describe("multiview strategy", () => {
  it("eligible_hero_and_capable_adapter_selects_four_cardinal_views", () => {
    expect(
      decideMultiviewStrategy(
        { conceptViews: "multiview-if-supported" },
        capable,
      ),
    ).toEqual({
      kind: "generate",
      roles: ["front", "left", "back", "right"],
    });
  });

  it("policy_disabled_returns_not_required_even_when_adapter_supports_views", () => {
    expect(
      decideMultiviewStrategy({ conceptViews: "single-view" }, capable),
    ).toEqual({
      kind: "not-required",
      reason: "Asset handling policy requires single-view input.",
    });
    expect(decideMultiviewStrategy({ conceptViews: "none" }, capable)).toEqual({
      kind: "not-required",
      reason: "Asset handling policy disables concept views.",
    });
  });

  it("unsupported_or_unknown_model_returns_not_required", () => {
    expect(
      decideMultiviewStrategy(
        { conceptViews: "multiview-if-supported" },
        { supported: false, reason: "Unknown model version." },
      ),
    ).toEqual({ kind: "not-required", reason: "Unknown model version." });
  });

  it("requested_regeneration_roles_are_capped_and_canonicalized", () => {
    expect(
      decideMultiviewStrategy(
        { conceptViews: "multiview-if-supported" },
        capable,
        ["right", "back", "left", "front", "right"],
      ),
    ).toEqual({
      kind: "generate",
      roles: ["front", "left", "back", "right"],
    });
  });

  it("workflow_decision_never_branches_on_provider_name", () => {
    const meshyLabel = { ...capable, provider: "meshy" };
    const tripoLabel = { ...capable, provider: "tripo" };

    expect(
      decideMultiviewStrategy(
        { conceptViews: "multiview-if-supported" },
        meshyLabel,
      ),
    ).toEqual(
      decideMultiviewStrategy(
        { conceptViews: "multiview-if-supported" },
        tripoLabel,
      ),
    );
  });
});

const artifact = (artifactId: string, sha256: string) => ({
  artifactId,
  sha256,
  mediaType: "image/png",
  byteLength: 64,
  uri: `/api/artifacts/${artifactId}`,
});

const revision = (role: string, sha256: string) => ({
  entityId: `hero:concept-view:${role}`,
  revisionId: `hero-${role}-revision-1`,
  kind: "concept-view-document",
  artifact: artifact(`hero-${role}-document`, sha256),
  createdAt: "2026-08-24T12:00:00.000Z",
  createdByRunId: "run-1",
});

const multiviewJob = (): AssetGenerationJob => ({
  projectId: "project-1",
  assetId: "hero",
  imageInput: {
    kind: "multiview",
    conceptSet: revision("set", "1".repeat(64)),
    anchorConcept: revision("anchor", "2".repeat(64)),
    views: [
      {
        role: "right",
        revision: revision("right", "3".repeat(64)),
        image: artifact("right", "4".repeat(64)),
      },
      {
        role: "front",
        revision: revision("front", "5".repeat(64)),
        image: artifact("front", "6".repeat(64)),
      },
      {
        role: "back",
        revision: revision("back", "7".repeat(64)),
        image: artifact("back", "8".repeat(64)),
      },
      {
        role: "left",
        revision: revision("left", "9".repeat(64)),
        image: artifact("left", "a".repeat(64)),
      },
    ],
  },
});

const fingerprint = (job: AssetGenerationJob) =>
  assetRequestFingerprint(job, {
    modelVersion: "meshy-7",
    endpointKind: "multi-image-to-3d",
    generationOptions: { shouldTexture: true, textureResolution: "2k" },
  });

describe("asset request fingerprint", () => {
  it("asset_fingerprint_changes_when_any_input_image_hash_changes", () => {
    const changed = structuredClone(multiviewJob());
    if (changed.imageInput.kind !== "multiview") throw new Error("bad fixture");
    changed.imageInput.views[2]!.image.sha256 = "f".repeat(64);

    expect(fingerprint(changed)).not.toBe(fingerprint(multiviewJob()));
  });

  it("asset_fingerprint_canonicalizes_cardinal_order", () => {
    const reordered = structuredClone(multiviewJob());
    if (reordered.imageInput.kind !== "multiview")
      throw new Error("bad fixture");
    reordered.imageInput.views.reverse();

    expect(fingerprint(reordered)).toBe(fingerprint(multiviewJob()));
  });
});

describe("Meshy adapter contract", () => {
  it("meshy_capability_supports_known_multiview_models_with_max_four", () => {
    expect(meshyMultiviewCapability("meshy-7")).toEqual(
      expect.objectContaining({
        supported: true,
        maxViews: 4,
        primaryRole: "front",
        payloadShape: "ordered-images",
      }),
    );
    expect(meshyMultiviewCapability("future-unknown")).toEqual({
      supported: false,
      reason: "Meshy model future-unknown has no declared multiview profile.",
    });
  });

  it("meshy_multi_payload_uses_front_first_image_urls", () => {
    const request = buildMeshyRequest(multiviewJob(), "meshy-7", (image) =>
      new TextEncoder().encode(image.artifactId),
    );

    expect(request.endpointKind).toBe("multi-image-to-3d");
    expect(request.body.image_urls).toHaveLength(4);
    const imageUrls = request.body.image_urls as string[];
    expect(
      Buffer.from(String(imageUrls[0]).split(",")[1]!, "base64").toString(),
    ).toBe("front");
  });

  it("meshy_single_payload_retains_current_m0_body", () => {
    const image = artifact("anchor", "b".repeat(64));
    const request = buildMeshyRequest(
      {
        projectId: "project-1",
        assetId: "hero",
        imageInput: {
          kind: "single",
          concept: revision("anchor", "c".repeat(64)),
          image,
        },
      },
      "meshy-6",
      () => PNG_BYTES,
    );

    expect(request).toEqual({
      endpointKind: "image-to-3d",
      jobKind: "single-image",
      body: {
        image_url: `data:image/png;base64,${Buffer.from(PNG_BYTES).toString("base64")}`,
        model_type: "standard",
        ai_model: "meshy-6",
        should_texture: true,
        enable_pbr: true,
        texture_resolution: "2k",
        should_remesh: false,
        image_enhancement: false,
        remove_lighting: true,
        moderation: true,
        target_formats: ["glb"],
      },
    });
  });

  it("inspect_uses_stored_meshy_multi_endpoint", async () => {
    process.env.MESHY_API_KEY = "test-key";
    process.env.FULCRUM_MESHY_MODEL = "meshy-7";
    const fetchMock = vi.fn(async (_request: string | URL | Request) =>
      Response.json({ status: "IN_PROGRESS", progress: 50 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new MeshyAssetAdapter({} as ProjectRepository);

    const outcome = await adapter.inspect(
      adapterJobRefFromSubmissionPayload("task-1", {
        jobKind: "multi-image",
      }),
    );

    expect(outcome.status).toBe("pending");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/multi-image-to-3d/task-1",
    );
  });
});

const PNG_BYTES = new Uint8Array([137, 80, 78, 71]);

describe("Tripo and replay adapter contracts", () => {
  it("tripo_capability_rejects_unsupported_model_versions", () => {
    expect(tripoMultiviewCapability("v2.5-20250123")).toEqual(
      expect.objectContaining({
        supported: true,
        minViews: 4,
        payloadShape: "cardinal-slots",
      }),
    );
    expect(tripoMultiviewCapability("unknown-version")).toEqual({
      supported: false,
      reason: "Tripo model unknown-version has no declared multiview profile.",
    });
  });

  it("tripo_multi_payload_uses_exact_front_left_back_right_slots", () => {
    const job = multiviewJob();
    if (job.imageInput.kind !== "multiview") throw new Error("bad fixture");
    const tokens = Object.fromEntries(
      job.imageInput.views.map(({ image, role }) => [
        image.sha256,
        `${role}-token`,
      ]),
    );

    expect(buildTripoTaskPayload(job, "v2.5-20250123", tokens)).toEqual({
      type: "multiview_to_model",
      model_version: "v2.5-20250123",
      files: [
        { type: "png", file_token: "front-token" },
        { type: "png", file_token: "left-token" },
        { type: "png", file_token: "back-token" },
        { type: "png", file_token: "right-token" },
      ],
    });
  });

  it("replay_adapter_copies_selected_live_capability_profile", () => {
    const live = {
      id: "meshy" as const,
      multiviewImageInput: capable,
      requestFingerprint: vi.fn(() => "fingerprint"),
      submit: vi.fn(),
      inspect: vi.fn(),
    };

    expect(createReplayAssetAdapter(live).multiviewImageInput).toEqual(capable);
  });

  it("missing_job_kind_reconciles_as_legacy_single_image", () => {
    expect(adapterJobRefFromSubmissionPayload("legacy-task", {})).toEqual({
      taskId: "legacy-task",
      jobKind: "single-image",
    });
  });
});
