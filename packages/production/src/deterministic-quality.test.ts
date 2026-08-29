import {
  AssetDocumentSchema,
  AssetPolicySchema,
  type AssetDocument,
  type AssetPolicy,
} from "@fulcrum/domain";
import { Document, NodeIO, Primitive } from "@gltf-transform/core";
import { describe, expect, it } from "vitest";

import { createReplayReliquary } from "./index.js";
import {
  DEFAULT_ASSET_POLICIES,
  inspectParsedAsset,
} from "./deterministic-quality.js";

const sourceArtifact = {
  artifactId: "asset-glb",
  sha256: "a".repeat(64),
  mediaType: "model/gltf-binary",
  byteLength: 1,
  uri: "/api/artifacts/asset-glb",
};

const asset = (overrides: Partial<AssetDocument> = {}): AssetDocument =>
  AssetDocumentSchema.parse({
    assetId: "asset-1",
    name: "Quality fixture",
    classification: "hero",
    glb: sourceArtifact,
    provider: "fixture",
    model: "fixture-v1",
    sourceConceptRevisionId: "concept-1",
    externalJobId: "fixture-job",
    costUsd: 0,
    ...overrides,
  });

const policy = (overrides: Partial<AssetPolicy> = {}): AssetPolicy =>
  AssetPolicySchema.parse({
    ...DEFAULT_ASSET_POLICIES.hero,
    ...overrides,
  });

const addPrimitive = (input: {
  document: Document;
  positions: number[];
  indices?: number[];
  normals?: number[];
  meshName?: string;
  addNode?: boolean;
  translation?: [number, number, number];
  material?: ReturnType<Document["createMaterial"]>;
  mode?: ReturnType<Primitive["getMode"]>;
}) => {
  const root = input.document.getRoot();
  const scene = root.listScenes()[0] ?? input.document.createScene("scene");
  const buffer = root.listBuffers()[0] ?? input.document.createBuffer("buffer");
  const primitive = input.document
    .createPrimitive()
    .setAttribute(
      "POSITION",
      input.document
        .createAccessor("positions", buffer)
        .setType("VEC3")
        .setArray(new Float32Array(input.positions)),
    );
  if (input.indices) {
    primitive.setIndices(
      input.document
        .createAccessor("indices", buffer)
        .setType("SCALAR")
        .setArray(new Uint16Array(input.indices)),
    );
  }
  if (input.normals) {
    primitive.setAttribute(
      "NORMAL",
      input.document
        .createAccessor("normals", buffer)
        .setType("VEC3")
        .setArray(new Float32Array(input.normals)),
    );
  }
  if (input.material) primitive.setMaterial(input.material);
  if (input.mode !== undefined) primitive.setMode(input.mode);
  const mesh = input.document
    .createMesh(input.meshName ?? "mesh")
    .addPrimitive(primitive);
  if (input.addNode !== false) {
    scene.addChild(
      input.document
        .createNode(`${input.meshName ?? "mesh"}-node`)
        .setMesh(mesh)
        .setTranslation(input.translation ?? [0, 0, 0]),
    );
  }
  return { mesh, primitive, scene, buffer };
};

const triangleNormals = (count: number, z = 1): number[] =>
  Array.from({ length: count }, () => [0, 0, z]).flat();

describe("inspectParsedAsset", () => {
  it("counts_unique_definitions_but_bounds_every_scene_instance", () => {
    const document = new Document();
    const material = document.createMaterial("material");
    const { mesh, scene } = addPrimitive({
      document,
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2],
      normals: triangleNormals(3),
      material,
    });
    scene.addChild(
      document
        .createNode("instance-2")
        .setMesh(mesh)
        .setTranslation([10, 0, 0]),
    );

    const result = inspectParsedAsset(document, asset(), policy());

    expect(result.measurements.mesh).toMatchObject({
      meshCount: 1,
      primitiveCount: 1,
      vertexCount: 3,
      triangleCount: 1,
      boundsMeters: { x: 11, y: 1, z: 0 },
    });
  });

  it("fails_non_triangle_mode_and_out_of_range_indices", () => {
    const document = new Document();
    const material = document.createMaterial("material");
    addPrimitive({
      document,
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 7],
      normals: triangleNormals(3),
      material,
      mode: Primitive.Mode.LINES!,
    });

    const result = inspectParsedAsset(document, asset(), policy());

    expect(result.passed).toBe(false);
    expect(result.gates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "primitive-mode", passed: false }),
        expect.objectContaining({ id: "primitive-indices", passed: false }),
      ]),
    );
  });

  it("detects_relative_degenerate_triangles_at_large_and_small_scales", () => {
    const inspectScale = (scale: number) => {
      const document = new Document();
      const material = document.createMaterial("material");
      addPrimitive({
        document,
        positions: [0, 0, 0, scale, 0, 0, scale * 2, scale * 1e-8, 0],
        indices: [0, 1, 2],
        normals: triangleNormals(3),
        material,
      });
      return inspectParsedAsset(
        document,
        asset(),
        policy({
          mesh: {
            ...DEFAULT_ASSET_POLICIES.hero.mesh,
            minLargestExtentMeters: 1e-12,
            maxLargestExtentMeters: 1e12,
          },
        }),
      );
    };

    expect(inspectScale(1e9).measurements.topology.degenerateTriangles).toBe(1);
    expect(inspectScale(1e-9).measurements.topology.degenerateTriangles).toBe(
      1,
    );
  });

  it("detects_non_manifold_boundary_and_same_direction_edges_after_welding", () => {
    const document = new Document();
    const material = document.createMaterial("material");
    addPrimitive({
      document,
      positions: [
        0, 0, 0, 1, 0, 0, 0, 1, 0, 0.0000001, 0, 0, 1.0000001, 0, 0, 0, -1, 0,
        1.0000002, 0, 0, 0.0000002, 0, 0, 0, 0, 1,
      ],
      normals: triangleNormals(9),
      material,
    });

    const result = inspectParsedAsset(document, asset(), policy());

    expect(result.measurements.topology.nonManifoldEdges).toBe(1);
    expect(result.measurements.topology.inconsistentWindingEdges).toBe(1);
    expect(result.measurements.topology.boundaryEdges).toBeGreaterThan(0);
    expect(result.gates).toContainEqual(
      expect.objectContaining({
        id: "topology-non-manifold-edges",
        passed: true,
        threshold: "<= 250",
      }),
    );
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        findingCode: "topology.non-manifold-edge",
        severity: "minor",
      }),
    );

    const functional = inspectParsedAsset(
      document,
      asset({ classification: "functional" }),
      DEFAULT_ASSET_POLICIES.functional,
    );
    expect(functional.gates).toContainEqual(
      expect.objectContaining({
        id: "topology-non-manifold-edges",
        passed: false,
        threshold: "<= 0",
      }),
    );
  });

  it("counts_unreferenced_vertices_and_normal_mismatches", () => {
    const document = new Document();
    const material = document.createMaterial("material");
    addPrimitive({
      document,
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 9, 9, 9],
      indices: [0, 1, 2],
      normals: triangleNormals(4, -1),
      material,
    });

    const result = inspectParsedAsset(document, asset(), policy());

    expect(result.measurements.topology.unreferencedVertices).toBe(1);
    expect(result.measurements.topology.normalMismatchTriangles).toBe(1);
  });

  it("inspects_a_dense_indexed_grid_with_bounded_memory", () => {
    const side = 449;
    const vertexCount = side * side;
    const triangleCount = (side - 1) * (side - 1) * 2;
    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const indices = new Uint32Array(triangleCount * 3);

    for (let y = 0; y < side; y += 1)
      for (let x = 0; x < side; x += 1) {
        const vertex = y * side + x;
        positions[vertex * 3] = x / (side - 1);
        positions[vertex * 3 + 1] = y / (side - 1);
        normals[vertex * 3 + 2] = 1;
      }

    let offset = 0;
    for (let y = 0; y < side - 1; y += 1)
      for (let x = 0; x < side - 1; x += 1) {
        const topLeft = y * side + x;
        const topRight = topLeft + 1;
        const bottomLeft = topLeft + side;
        const bottomRight = bottomLeft + 1;
        indices.set(
          [topLeft, topRight, bottomLeft, topRight, bottomRight, bottomLeft],
          offset,
        );
        offset += 6;
      }

    const document = new Document();
    const scene = document.createScene("dense-grid");
    const buffer = document.createBuffer("buffer");
    const material = document.createMaterial("material");
    const primitive = document
      .createPrimitive()
      .setAttribute(
        "POSITION",
        document
          .createAccessor("positions", buffer)
          .setType("VEC3")
          .setArray(positions),
      )
      .setAttribute(
        "NORMAL",
        document
          .createAccessor("normals", buffer)
          .setType("VEC3")
          .setArray(normals),
      )
      .setIndices(
        document
          .createAccessor("indices", buffer)
          .setType("SCALAR")
          .setArray(indices),
      )
      .setMaterial(material);
    const mesh = document.createMesh("dense-grid").addPrimitive(primitive);
    scene.addChild(document.createNode("dense-grid").setMesh(mesh));

    const result = inspectParsedAsset(
      document,
      asset(),
      policy({
        mesh: {
          ...DEFAULT_ASSET_POLICIES.hero.mesh,
          maxTriangles: triangleCount,
        },
      }),
    );

    expect(result.measurements.mesh).toMatchObject({
      vertexCount,
      triangleCount,
      boundsMeters: { x: 1, y: 1, z: 0 },
    });
    expect(result.measurements.topology).toEqual({
      degenerateTriangles: 0,
      nonManifoldEdges: 0,
      boundaryEdges: 4 * (side - 1),
      unreferencedVertices: 0,
      inconsistentWindingEdges: 0,
      normalMismatchTriangles: 0,
    });
  }, 30_000);

  it("finds_unused_and_signature_duplicate_materials", () => {
    const document = new Document();
    const used = document
      .createMaterial("used")
      .setBaseColorFactor([0.2, 0.4, 0.6, 1]);
    document.createMaterial("duplicate").setBaseColorFactor([0.2, 0.4, 0.6, 1]);
    document.createMaterial("unused").setBaseColorFactor([1, 0, 0, 1]);
    addPrimitive({
      document,
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2],
      normals: triangleNormals(3),
      material: used,
    });

    const result = inspectParsedAsset(document, asset(), policy());

    expect(result.measurements.material).toMatchObject({
      materialCount: 3,
      unusedMaterialCount: 2,
      duplicateMaterialGroupCount: 1,
    });
    expect(result.findings.map((finding) => finding.findingCode)).toEqual(
      expect.arrayContaining(["materials.unused", "materials.duplicate-group"]),
    );
  });

  it("fails_claimed_external_or_undersized_textures", () => {
    const document = new Document();
    const external = document
      .createTexture("external")
      .setURI("https://example.test/base.png");
    const undersized = document
      .createTexture("undersized")
      .setImage(
        Uint8Array.from(
          Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
            "base64",
          ),
        ),
      )
      .setMimeType("image/png");
    const material = document
      .createMaterial("textured")
      .setBaseColorTexture(external)
      .setMetallicRoughnessTexture(undersized);
    addPrimitive({
      document,
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2],
      normals: triangleNormals(3),
      material,
    });

    const result = inspectParsedAsset(
      document,
      asset({
        generationClaims: {
          textured: true,
          textureChannels: ["base-color", "metallic-roughness"],
        },
      }),
      policy(),
    );

    expect(result.passed).toBe(false);
    expect(result.gates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "texture-embedded", passed: false }),
        expect.objectContaining({ id: "texture-dimensions", passed: false }),
      ]),
    );
  });

  it("does_not_require_textures_for_factor_only_replay_materials", async () => {
    const document = await new NodeIO().readBinary(
      await createReplayReliquary(),
    );

    const result = inspectParsedAsset(document, asset(), policy());

    expect(result.gates.filter((gate) => gate.category === "texture")).toEqual(
      expect.arrayContaining([expect.objectContaining({ passed: true })]),
    );
    expect(
      result.gates.filter(
        (gate) => gate.category === "texture" && !gate.passed,
      ),
    ).toEqual([]);
  });
});
