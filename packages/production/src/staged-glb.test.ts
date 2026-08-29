import { NodeIO } from "@gltf-transform/core";
import { describe, expect, it } from "vitest";

import {
  createStagedPlaceholderGlb,
  stagedShapeSeed,
  type StagedGlbVariant,
} from "./staged-glb.js";

const read = async (bytes: Uint8Array) => await new NodeIO().readBinary(bytes);

const build = (variant: StagedGlbVariant, round = 1, seed = "sentinel") =>
  createStagedPlaceholderGlb({ shapeSeed: seed, variant, round });

describe("staged placeholder GLBs", () => {
  it("strips the project id out of a planned asset id", () => {
    expect(stagedShapeSeed("6f1c-4a2b:planned-asset:harbour-crane")).toBe(
      "harbour-crane",
    );
    expect(stagedShapeSeed("no-marker")).toBe("no-marker");
  });

  it("writes a loadable untextured mesh for the geometry review", async () => {
    const document = await read(await build("geometry"));
    const primitives = document
      .getRoot()
      .listMeshes()
      .flatMap((mesh) => mesh.listPrimitives());
    expect(primitives.length).toBeGreaterThan(0);
    expect(document.getRoot().listTextures()).toHaveLength(0);
    expect(document.getRoot().listSkins()).toHaveLength(0);
    for (const primitive of primitives) {
      expect(primitive.getAttribute("POSITION")).toBeTruthy();
      expect(primitive.getAttribute("NORMAL")).toBeTruthy();
      expect(primitive.getAttribute("TEXCOORD_0")).toBeNull();
    }
  });

  it("embeds a base-colour texture for the texture review", async () => {
    const document = await read(await build("textured"));
    expect(document.getRoot().listTextures()).toHaveLength(1);
    expect(document.getRoot().listTextures()[0]!.getMimeType()).toBe(
      "image/png",
    );
    for (const primitive of document
      .getRoot()
      .listMeshes()
      .flatMap((mesh) => mesh.listPrimitives()))
      expect(primitive.getAttribute("TEXCOORD_0")).toBeTruthy();
  });

  it("skins the rigged variant and ships walk and run clips", async () => {
    const document = await read(await build("rigged"));
    const skins = document.getRoot().listSkins();
    expect(skins).toHaveLength(1);
    expect(skins[0]!.listJoints()).toHaveLength(7);
    expect(skins[0]!.getInverseBindMatrices()?.getCount()).toBe(7);
    expect(
      document
        .getRoot()
        .listAnimations()
        .map((animation) => animation.getName()),
    ).toEqual(["walk", "run"]);
    for (const primitive of document
      .getRoot()
      .listMeshes()
      .flatMap((mesh) => mesh.listPrimitives())) {
      expect(primitive.getAttribute("JOINTS_0")).toBeTruthy();
      expect(primitive.getAttribute("WEIGHTS_0")).toBeTruthy();
    }
  });

  it("stands on the ground plane so a viewer frames it the same way", async () => {
    const document = await read(await build("geometry"));
    let minimumY = Infinity;
    let maximumY = -Infinity;
    for (const primitive of document
      .getRoot()
      .listMeshes()
      .flatMap((mesh) => mesh.listPrimitives())) {
      const positions = primitive.getAttribute("POSITION")!;
      const vertex = [0, 0, 0];
      for (let index = 0; index < positions.getCount(); index += 1) {
        positions.getElement(index, vertex);
        minimumY = Math.min(minimumY, vertex[1]!);
        maximumY = Math.max(maximumY, vertex[1]!);
      }
    }
    expect(minimumY).toBeCloseTo(0, 5);
    expect(maximumY).toBeGreaterThan(1.4);
    expect(maximumY).toBeLessThan(2.1);
  });

  it("is byte-identical for the same content and different per round", async () => {
    const first = await build("geometry", 1);
    const repeat = await build("geometry", 1);
    const secondRound = await build("geometry", 2);
    const otherAsset = await build("geometry", 1, "different-asset");
    expect(Buffer.from(first).equals(Buffer.from(repeat))).toBe(true);
    expect(Buffer.from(first).equals(Buffer.from(secondRound))).toBe(false);
    expect(Buffer.from(first).equals(Buffer.from(otherAsset))).toBe(false);
  });

  /* The replay determinism record compares raw artifact bytes across two
     projects. A project id inside the GLB would make every replay world's
     assets unique and the comparison worthless, so assert the absence. */
  it("never writes project identity into the artifact bytes", async () => {
    const assetId = "13bbfef6-3e8b-4de2-b4aa-82eccad61502:planned-asset:atlas";
    const text = Buffer.from(
      await createStagedPlaceholderGlb({
        shapeSeed: stagedShapeSeed(assetId),
        variant: "rigged",
        round: 3,
      }),
    ).toString("latin1");
    expect(text).not.toContain("13bbfef6");
    expect(text).not.toContain("planned-asset");
    expect(text).not.toContain("atlas");
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});
