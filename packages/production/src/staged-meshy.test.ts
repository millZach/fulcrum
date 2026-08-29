import {
  DEFAULT_MESHY_CONFIG,
  MeshyConfigSchema,
  isProviderPreflightError,
  type ArtifactRef,
} from "@fulcrum/domain";
import { describe, expect, it } from "vitest";

import {
  buildMeshyStagedAnimationRequest,
  buildMeshyStagedGeometryRequest,
  buildMeshyStagedRigRequest,
  buildMeshyStagedTextureRequest,
  meshyStageEndpointUrl,
  meshyTaskStatus,
  MESHY_RIG_MAX_FACES,
} from "./meshy-adapter.js";

const artifact = (mediaType: string): ArtifactRef => ({
  artifactId: "artifact-1",
  sha256: "a".repeat(64),
  mediaType,
  byteLength: 4,
  uri: "/api/artifacts/artifact-1",
});

const image = () => ({
  artifact: artifact("image/png"),
  bytes: Uint8Array.from([1, 2, 3, 4]),
});

const model = () => ({
  artifact: artifact("model/gltf-binary"),
  bytes: Uint8Array.from([5, 6, 7, 8]),
});

describe("staged Meshy geometry request", () => {
  it("pins the model, remeshes explicitly, and asks high", () => {
    const { endpoint, body } = buildMeshyStagedGeometryRequest(
      { images: [image()] },
      DEFAULT_MESHY_CONFIG,
    );
    expect(endpoint).toBe("image-to-3d");
    expect(body).toMatchObject({
      ai_model: "meshy-6",
      model_type: "standard",
      should_texture: false,
      /* Omitting this makes Meshy silently ignore topology and polycount. */
      should_remesh: true,
      topology: "triangle",
      target_polycount: 10_000,
      auto_size: true,
      origin_at: "bottom",
      alpha_thumbnail: true,
      multi_view_thumbnails: true,
      moderation: true,
      target_formats: ["glb"],
    });
    expect(body.image_url).toMatch(/^data:image\/png;base64,/);
    expect(body.ai_model).not.toBe("latest");
    expect(body.pose_mode).toBeUndefined();
  });

  it("switches to the multi-image endpoint and keeps view order", () => {
    const { endpoint, body } = buildMeshyStagedGeometryRequest(
      {
        images: [image(), image(), image()],
        poseMode: "a-pose",
      },
      DEFAULT_MESHY_CONFIG,
    );
    expect(endpoint).toBe("multi-image-to-3d");
    expect((body.image_urls as string[]).length).toBe(3);
    expect(body.model_type).toBeUndefined();
    expect(body.pose_mode).toBe("a-pose");
  });

  it("carries a changed config into the request", () => {
    const config = MeshyConfigSchema.parse({
      targetPolycount: 30_000,
      imageEnhancement: false,
    });
    const { body } = buildMeshyStagedGeometryRequest(
      { images: [image()] },
      config,
    );
    expect(body).toMatchObject({
      target_polycount: 30_000,
      image_enhancement: false,
    });
  });

  it("refuses zero or more than four images", () => {
    expect(() =>
      buildMeshyStagedGeometryRequest({ images: [] }, DEFAULT_MESHY_CONFIG),
    ).toThrow(/one to four/);
    expect(() =>
      buildMeshyStagedGeometryRequest(
        { images: [image(), image(), image(), image(), image()] },
        DEFAULT_MESHY_CONFIG,
      ),
    ).toThrow(/one to four/);
  });
});

describe("staged Meshy texture request", () => {
  /* Retexture's `input_task_id` accepts Image-to-3D but not Multi-Image-to-3D,
     which is exactly the endpoint Fulcrum's multiview profile uses. Posting the
     GLB Fulcrum already stored works for either, and outlives Meshy's 3-day
     result deletion. */
  it("posts the stored GLB rather than a task id", () => {
    const body = buildMeshyStagedTextureRequest(
      { sourceModel: model(), styleImage: image() },
      DEFAULT_MESHY_CONFIG,
    );
    expect(body.input_task_id).toBeUndefined();
    expect(body.model_url).toMatch(/^data:application\/octet-stream;base64,/);
    expect(body).toMatchObject({
      ai_model: "meshy-6",
      enable_original_uv: true,
      enable_pbr: true,
      /* 4K costs the same 10 credits as the 2K default; 8K costs more and
         drops PBR maps, so the schema does not offer it. */
      texture_resolution: "4k",
      remove_lighting: true,
      target_formats: ["glb"],
    });
  });

  it("honours a 2K override", () => {
    const body = buildMeshyStagedTextureRequest(
      { sourceModel: model(), styleImage: image() },
      MeshyConfigSchema.parse({ textureResolution: "2k" }),
    );
    expect(body.texture_resolution).toBe("2k");
  });
});

describe("staged Meshy rigging request", () => {
  it("prefers the textured task id and omits an unset height", () => {
    expect(
      buildMeshyStagedRigRequest(
        { inputTaskId: "task-42" },
        DEFAULT_MESHY_CONFIG,
      ),
    ).toEqual({ input_task_id: "task-42" });
  });

  it("falls back to the stored model and carries a real-world height", () => {
    const body = buildMeshyStagedRigRequest(
      { model: { bytes: model().bytes } },
      MeshyConfigSchema.parse({ realWorldHeightMeters: 1.85 }),
    );
    expect(body.input_task_id).toBeUndefined();
    expect(body.model_url).toMatch(/^data:application\/octet-stream;base64,/);
    expect(body.height_meters).toBe(1.85);
  });

  /* Meshy's human reference says 300,000 faces and its OpenAPI says 320,000.
     Refusing at the stricter number beats being rejected after paying. */
  it("refuses a mesh above the stricter face ceiling", () => {
    expect(() =>
      buildMeshyStagedRigRequest(
        { inputTaskId: "task-42", faceCount: MESHY_RIG_MAX_FACES + 1 },
        DEFAULT_MESHY_CONFIG,
      ),
    ).toThrow(/300000 faces/);
    expect(() => buildMeshyStagedRigRequest({}, DEFAULT_MESHY_CONFIG)).toThrow(
      /task id or the textured model bytes/,
    );
  });

  it("sends neither an animation type nor a name", () => {
    const body = buildMeshyStagedRigRequest(
      { inputTaskId: "task-42" },
      DEFAULT_MESHY_CONFIG,
    );
    expect(body.animation_type).toBeUndefined();
    expect(body.name).toBeUndefined();
  });
});

describe("staged Meshy animation request", () => {
  it("takes the rigging task id and one library action", () => {
    expect(buildMeshyStagedAnimationRequest({ rigTaskId: "rig-7" })).toEqual({
      rig_task_id: "rig-7",
      action_id: 0,
    });
    expect(
      buildMeshyStagedAnimationRequest({ rigTaskId: "rig-7", actionId: 92 })
        .action_id,
    ).toBe(92);
  });
});

describe("Meshy status vocabulary", () => {
  it("maps every documented status and keeps unknown ones pollable", () => {
    expect(meshyTaskStatus("PENDING")).toBe("running");
    expect(meshyTaskStatus("IN_PROGRESS")).toBe("running");
    expect(meshyTaskStatus("SUCCEEDED")).toBe("succeeded");
    expect(meshyTaskStatus("FAILED")).toBe("failed");
    expect(meshyTaskStatus("EXPIRED")).toBe("expired");
    expect(meshyTaskStatus("CANCELED")).toBe("canceled");
    expect(meshyTaskStatus("CANCELLED")).toBe("canceled");
    /* A Meshy release that adds a state must not strand a paid task. */
    expect(meshyTaskStatus("POST_PROCESSING")).toBe("unknown");
    expect(meshyTaskStatus(undefined)).toBe("unknown");
  });
});

describe("staged endpoint urls", () => {
  it("routes each family and escapes the task id", () => {
    expect(meshyStageEndpointUrl("rigging")).toBe(
      "https://api.meshy.ai/openapi/v1/rigging",
    );
    expect(meshyStageEndpointUrl("animations", "a b")).toBe(
      "https://api.meshy.ai/openapi/v1/animations/a%20b",
    );
  });
});

describe("preflight errors", () => {
  it("are provider preflight errors, so routes can report a code", () => {
    try {
      buildMeshyStagedGeometryRequest({ images: [] }, DEFAULT_MESHY_CONFIG);
      expect.unreachable();
    } catch (error) {
      expect(isProviderPreflightError(error)).toBe(true);
    }
  });
});
