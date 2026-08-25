import { createHash } from "node:crypto";

import { Document, NodeIO } from "@gltf-transform/core";
import { describe, expect, it } from "vitest";

import { DEFAULT_ASSET_POLICIES } from "./deterministic-quality.js";
import { createReplayReliquary } from "./index.js";
import { renderTurntable } from "./turntable.js";

const hashes = (frames: Array<{ bytes: Uint8Array }>): string[] =>
  frames.map(({ bytes }) => createHash("sha256").update(bytes).digest("hex"));

const triangleDocument = (frontZ: number): Document => {
  const document = new Document();
  const scene = document.createScene("occlusion");
  const buffer = document.createBuffer("buffer");
  const addTriangle = (
    name: string,
    z: number,
    color: [number, number, number, number],
  ) => {
    const positions = document
      .createAccessor(`${name}:positions`, buffer)
      .setType("VEC3")
      .setArray(new Float32Array([-0.8, -0.8, 0, 0.8, -0.8, 0, 0, 0.8, 0]));
    const material = document
      .createMaterial(`${name}:material`)
      .setBaseColorFactor(color);
    const mesh = document
      .createMesh(`${name}:mesh`)
      .addPrimitive(
        document
          .createPrimitive()
          .setAttribute("POSITION", positions)
          .setMaterial(material),
      );
    scene.addChild(
      document.createNode(name).setMesh(mesh).setTranslation([0, 0, z]),
    );
  };
  addTriangle("red", frontZ, [1, 0, 0, 1]);
  addTriangle("blue", 0.2, [0, 0, 1, 1]);
  return document;
};

describe("renderTurntable", () => {
  it("renders_exact_policy_frame_count_at_fixed_yaws", async () => {
    const document = await new NodeIO().readBinary(
      await createReplayReliquary(),
    );

    const frames = renderTurntable(
      document,
      DEFAULT_ASSET_POLICIES.hero.turntable,
    );

    expect(
      frames.map(({ frameIndex, yawDegrees }) => ({ frameIndex, yawDegrees })),
    ).toEqual(
      Array.from({ length: 8 }, (_, frameIndex) => ({
        frameIndex,
        yawDegrees: frameIndex * 45,
      })),
    );
  });

  it("produces_expected_png_sha256_for_replay_reliquary", async () => {
    const document = await new NodeIO().readBinary(
      await createReplayReliquary(),
    );

    const actual = hashes(
      renderTurntable(document, DEFAULT_ASSET_POLICIES.hero.turntable),
    );
    expect(actual).toEqual([
      "bd3c1a66a60180ca63e06c33c159cbbfc6d1c63c643a2ff8d189e757e3d0377a",
      "bc0dc33d65259272112d79151eb44b150f825f3d4a8c6157d7bd16dadcb8f137",
      "47469cc96a2368f3670b022e02635e3d180e98a667a782fb8bdc06b660953a07",
      "56f491db26b3267c02ed6d0c8382f5f9d73d9437aed36e7f508560821f029313",
      "54222a394e3f25d089edc49068346ec8722b427f66eb5a40084df6fa22e9c8fb",
      "60d7c24b20f90224fc8b5b186f6d58535ffd2533a444df569a97cd8ce94c32a0",
      "a2c50a2c0030dbef71bcb113e8c9316036480d181a18ae9605d03d576d07d15f",
      "ac34c9e76e8a2aa0eec8e702d17e7ad3b1652d36eae9754334595175dcfe9d94",
    ]);
  });

  it("world_transform_changes_occlusion_and_frame_hash", () => {
    const config = {
      ...DEFAULT_ASSET_POLICIES.hero.turntable,
      frameCount: 4,
      width: 128,
      height: 128,
      elevationDegrees: 0,
    };

    const front = hashes(renderTurntable(triangleDocument(-0.2), config));
    const behind = hashes(renderTurntable(triangleDocument(0.4), config));

    expect(front[0]).not.toBe(behind[0]);
  });

  it("same_input_produces_identical_png_bytes", async () => {
    const document = await new NodeIO().readBinary(
      await createReplayReliquary(),
    );

    const first = renderTurntable(
      document,
      DEFAULT_ASSET_POLICIES.hero.turntable,
    );
    const second = renderTurntable(
      document,
      DEFAULT_ASSET_POLICIES.hero.turntable,
    );

    expect(second.map(({ bytes }) => bytes)).toEqual(
      first.map(({ bytes }) => bytes),
    );
  });

  it("rejects_zero_bounds_and_over_budget_geometry_before_rendering", () => {
    const zero = new Document();
    const zeroScene = zero.createScene("zero");
    const zeroBuffer = zero.createBuffer("buffer");
    const zeroMesh = zero
      .createMesh("zero")
      .addPrimitive(
        zero
          .createPrimitive()
          .setAttribute(
            "POSITION",
            zero
              .createAccessor("positions", zeroBuffer)
              .setType("VEC3")
              .setArray(new Float32Array(9)),
          ),
      );
    zeroScene.addChild(zero.createNode("zero").setMesh(zeroMesh));

    const overBudget = new Document();
    const overBudgetScene = overBudget.createScene("large");
    const overBudgetBuffer = overBudget.createBuffer("buffer");
    const overBudgetMesh = overBudget.createMesh("large").addPrimitive(
      overBudget.createPrimitive().setAttribute(
        "POSITION",
        overBudget
          .createAccessor("positions", overBudgetBuffer)
          .setType("VEC3")
          .setArray(new Float32Array((250_000 + 1) * 9)),
      ),
    );
    overBudgetScene.addChild(
      overBudget.createNode("large").setMesh(overBudgetMesh),
    );

    expect(() =>
      renderTurntable(zero, DEFAULT_ASSET_POLICIES.hero.turntable),
    ).toThrow(/non-zero bounds/i);
    expect(() =>
      renderTurntable(overBudget, DEFAULT_ASSET_POLICIES.hero.turntable),
    ).toThrow(/250,000 triangles/i);
  });
});
