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

const texturedTriangleDocument = (jpegBase64: string): Document => {
  const document = new Document();
  const scene = document.createScene("textured");
  const buffer = document.createBuffer("buffer");
  const positions = document
    .createAccessor("positions", buffer)
    .setType("VEC3")
    .setArray(new Float32Array([-0.8, -0.8, 0, 0.8, -0.8, 0, 0, 0.8, 0]));
  const textureCoordinates = document
    .createAccessor("texture-coordinates", buffer)
    .setType("VEC2")
    .setArray(new Float32Array([0, 0, 1, 0, 0.5, 1]));
  const texture = document
    .createTexture("base-color")
    .setImage(Uint8Array.from(Buffer.from(jpegBase64, "base64")))
    .setMimeType("image/jpeg");
  const material = document
    .createMaterial("textured")
    .setBaseColorFactor([1, 1, 1, 1])
    .setBaseColorTexture(texture);
  const mesh = document
    .createMesh("textured")
    .addPrimitive(
      document
        .createPrimitive()
        .setAttribute("POSITION", positions)
        .setAttribute("TEXCOORD_0", textureCoordinates)
        .setMaterial(material),
    );
  scene.addChild(document.createNode("textured").setMesh(mesh));
  return document;
};

const RED_JPEG =
  "/9j/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAACQr/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCL4Ap1/D//2Q==";
const BLUE_JPEG =
  "/9j/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAr/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAACAr/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCOcBfwK7//2Q==";

describe("renderTurntable", () => {
  it("renders_exact_policy_frame_count_at_fixed_yaws", async () => {
    const document = await new NodeIO().readBinary(
      await createReplayReliquary(),
    );

    const frames = await renderTurntable(
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
      await renderTurntable(document, DEFAULT_ASSET_POLICIES.hero.turntable),
    );
    expect(actual).toEqual([
      "e6a1112ee0cd91e842c8002601838c5bd55fcf6c43ef047afcbfaab9a915be83",
      "7b0e0c1d4c8eda95bf479fc5d256025f1ee9483a16468f2f1dfc2951f3869d47",
      "bc7548add51c02afa2908ed5fd5fdf78b292a5890d8f84cf61ebe359255cc502",
      "490252288407ae998c62a6482919f5cb6fa0651f1b284d59be6b7d3af322c879",
      "07c5b0058dff1d1e674603c599c8bd89ea5d721939afa1abcedd41a448950e84",
      "cfe4e1854d84038a51cf432eb2088f1b1768282bc4f96a8feec40abd321ea945",
      "e47b4aba10f6dc700b3a4689d8ef822f90c8c6c1736853f9d42dc592ca4d672a",
      "69b1632ad52018e994adf6634ad9840c4595981e3703658d1e3b2573b6a30671",
    ]);
  });

  it("world_transform_changes_occlusion_and_frame_hash", async () => {
    const config = {
      ...DEFAULT_ASSET_POLICIES.hero.turntable,
      frameCount: 4,
      width: 128,
      height: 128,
      elevationDegrees: 0,
    };

    const front = hashes(await renderTurntable(triangleDocument(-0.2), config));
    const behind = hashes(await renderTurntable(triangleDocument(0.4), config));

    expect(front[0]).not.toBe(behind[0]);
  });

  it("base_color_textures_change_turntable_pixels", async () => {
    const config = {
      ...DEFAULT_ASSET_POLICIES.hero.turntable,
      frameCount: 4,
      width: 128,
      height: 128,
      elevationDegrees: 0,
    };

    const red = hashes(
      await renderTurntable(texturedTriangleDocument(RED_JPEG), config),
    );
    const blue = hashes(
      await renderTurntable(texturedTriangleDocument(BLUE_JPEG), config),
    );

    expect(red).not.toEqual(blue);
  });

  it("same_input_produces_identical_png_bytes", async () => {
    const document = await new NodeIO().readBinary(
      await createReplayReliquary(),
    );

    const first = await renderTurntable(
      document,
      DEFAULT_ASSET_POLICIES.hero.turntable,
    );
    const second = await renderTurntable(
      document,
      DEFAULT_ASSET_POLICIES.hero.turntable,
    );

    expect(second.map(({ bytes }) => bytes)).toEqual(
      first.map(({ bytes }) => bytes),
    );
  });

  it("rejects_zero_bounds_and_over_budget_geometry_before_rendering", async () => {
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

    await expect(
      renderTurntable(zero, DEFAULT_ASSET_POLICIES.hero.turntable),
    ).rejects.toThrow(/non-zero bounds/i);
    await expect(
      renderTurntable(overBudget, DEFAULT_ASSET_POLICIES.hero.turntable),
    ).rejects.toThrow(/250,000 triangles/i);
  });
});
