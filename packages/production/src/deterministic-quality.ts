import { createHash } from "node:crypto";

import {
  AssetPolicySchema,
  type AssetClassification,
  type AssetDocument,
  type AssetPolicy,
  type AssetQualityMeasurements,
  type AssetQualityVector,
  type EvaluationFinding,
  type QualityGate,
  type TextureChannel,
} from "@fulcrum/domain";
import {
  Primitive,
  type Accessor,
  type Document,
  type Material,
  type Mesh,
  type Texture,
} from "@gltf-transform/core";

const buildPolicy = (
  classification: AssetClassification,
  input: Omit<AssetPolicy, "schema" | "version" | "classification">,
): AssetPolicy =>
  AssetPolicySchema.parse({
    schema: "fulcrum.asset-policy",
    version: 1,
    classification,
    ...input,
  });

const commonMaterial = {
  requireAssignedMaterial: true,
  requireNormals: true,
  warnUnusedAbove: 0,
  warnDuplicateGroupsAbove: 0,
} as const;

const commonTexture = {
  warnUnusedAbove: 0,
} as const;

export const DEFAULT_ASSET_POLICIES: Readonly<
  Record<AssetClassification, AssetPolicy>
> = Object.freeze({
  hero: buildPolicy("hero", {
    mesh: {
      maxMeshes: 64,
      maxPrimitives: 128,
      maxVertices: 300_000,
      maxTriangles: 250_000,
      minLargestExtentMeters: 0.1,
      maxLargestExtentMeters: 25,
      warnAspectRatioAbove: 8,
    },
    material: {
      ...commonMaterial,
      requiredClaimedTextureChannels: ["base-color", "metallic-roughness"],
    },
    texture: {
      ...commonTexture,
      minDimensionPx: 1024,
      maxDimensionPx: 4096,
    },
    topology: {
      maxDegenerateTriangleRatio: 0.001,
      maxNonManifoldEdges: 0,
      maxUnreferencedVertexRatio: 0.01,
      maxInconsistentWindingRatio: 0.02,
      maxNormalMismatchRatio: 0.05,
      warnBoundaryEdgeRatioAbove: 0.5,
      weldToleranceRatio: 0.00001,
    },
    turntable: {
      frameCount: 8,
      width: 256,
      height: 256,
      elevationDegrees: 15,
      paddingRatio: 0.15,
    },
    regeneration: {
      maxAttempts: 3,
      maxSameStrategyRetries: 1,
      allowedStrategies: [
        "retry-same",
        "change-prompt",
        "change-views",
        "reclassify",
      ],
    },
  }),
  kit: buildPolicy("kit", {
    mesh: {
      maxMeshes: 32,
      maxPrimitives: 64,
      maxVertices: 150_000,
      maxTriangles: 100_000,
      minLargestExtentMeters: 0.05,
      maxLargestExtentMeters: 50,
      warnAspectRatioAbove: 12,
    },
    material: {
      ...commonMaterial,
      requiredClaimedTextureChannels: ["base-color"],
    },
    texture: {
      ...commonTexture,
      minDimensionPx: 512,
      maxDimensionPx: 4096,
    },
    topology: {
      maxDegenerateTriangleRatio: 0.002,
      maxNonManifoldEdges: 0,
      maxUnreferencedVertexRatio: 0.02,
      maxInconsistentWindingRatio: 0.03,
      maxNormalMismatchRatio: 0.08,
      warnBoundaryEdgeRatioAbove: 0.65,
      weldToleranceRatio: 0.00001,
    },
    turntable: {
      frameCount: 6,
      width: 256,
      height: 256,
      elevationDegrees: 15,
      paddingRatio: 0.15,
    },
    regeneration: {
      maxAttempts: 2,
      maxSameStrategyRetries: 1,
      allowedStrategies: ["retry-same", "change-prompt", "reclassify"],
    },
  }),
  procedural: buildPolicy("procedural", {
    mesh: {
      maxMeshes: 16,
      maxPrimitives: 32,
      maxVertices: 50_000,
      maxTriangles: 30_000,
      minLargestExtentMeters: 0.01,
      maxLargestExtentMeters: 100,
      warnAspectRatioAbove: 20,
    },
    material: {
      ...commonMaterial,
      requireNormals: false,
      requiredClaimedTextureChannels: [],
    },
    texture: {
      ...commonTexture,
      minDimensionPx: 256,
      maxDimensionPx: 2048,
    },
    topology: {
      maxDegenerateTriangleRatio: 0.01,
      maxNonManifoldEdges: 0,
      maxUnreferencedVertexRatio: 0.05,
      maxInconsistentWindingRatio: 0.1,
      maxNormalMismatchRatio: 0.15,
      warnBoundaryEdgeRatioAbove: 0.8,
      weldToleranceRatio: 0.00001,
    },
    turntable: {
      frameCount: 4,
      width: 192,
      height: 192,
      elevationDegrees: 15,
      paddingRatio: 0.15,
    },
    regeneration: {
      maxAttempts: 1,
      maxSameStrategyRetries: 0,
      allowedStrategies: ["change-prompt"],
    },
  }),
  functional: buildPolicy("functional", {
    mesh: {
      maxMeshes: 32,
      maxPrimitives: 64,
      maxVertices: 100_000,
      maxTriangles: 75_000,
      minLargestExtentMeters: 0.01,
      maxLargestExtentMeters: 100,
      warnAspectRatioAbove: 20,
    },
    material: {
      ...commonMaterial,
      requiredClaimedTextureChannels: [],
    },
    texture: {
      ...commonTexture,
      minDimensionPx: 256,
      maxDimensionPx: 2048,
    },
    topology: {
      maxDegenerateTriangleRatio: 0,
      maxNonManifoldEdges: 0,
      maxUnreferencedVertexRatio: 0,
      maxInconsistentWindingRatio: 0.01,
      maxNormalMismatchRatio: 0.02,
      warnBoundaryEdgeRatioAbove: 0.5,
      weldToleranceRatio: 0.00001,
    },
    turntable: {
      frameCount: 4,
      width: 192,
      height: 192,
      elevationDegrees: 15,
      paddingRatio: 0.15,
    },
    regeneration: {
      maxAttempts: 1,
      maxSameStrategyRetries: 0,
      allowedStrategies: ["change-prompt"],
    },
  }),
});

type Vec3 = [number, number, number];

type Triangle = {
  ordinal: number;
  indices: [number, number, number];
  positions: [Vec3, Vec3, Vec3];
  normals?: [Vec3, Vec3, Vec3];
};

export type ParsedAssetInspection = {
  passed: boolean;
  measurements: AssetQualityMeasurements;
  gates: QualityGate[];
  findings: EvaluationFinding[];
  qualityVector: AssetQualityVector;
};

const readVec3 = (accessor: Accessor, index: number): Vec3 => {
  const value = accessor.getElement(index, []);
  return [
    value[0] ?? Number.NaN,
    value[1] ?? Number.NaN,
    value[2] ?? Number.NaN,
  ];
};

const isFiniteVec3 = (value: Vec3): boolean => value.every(Number.isFinite);

const subtract = (a: Vec3, b: Vec3): Vec3 => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
];

const dot = (a: Vec3, b: Vec3): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

const lengthSquared = (value: Vec3): number => dot(value, value);

const normalize = (value: Vec3): Vec3 | undefined => {
  const squared = lengthSquared(value);
  if (!Number.isFinite(squared) || squared <= 0) return undefined;
  const inverse = 1 / Math.sqrt(squared);
  return [value[0] * inverse, value[1] * inverse, value[2] * inverse];
};

const isDegenerate = (triangle: Triangle): boolean => {
  const [a, b, c] = triangle.positions;
  if (
    triangle.indices[0] === triangle.indices[1] ||
    triangle.indices[1] === triangle.indices[2] ||
    triangle.indices[2] === triangle.indices[0]
  )
    return true;
  const ab = subtract(b, a);
  const ac = subtract(c, a);
  const bc = subtract(c, b);
  const longestEdgeSquared = Math.max(
    lengthSquared(ab),
    lengthSquared(ac),
    lengthSquared(bc),
  );
  return (
    lengthSquared(cross(ab, ac)) <=
    1e-12 * longestEdgeSquared * longestEdgeSquared
  );
};

const transformPoint = (point: Vec3, matrix: readonly number[]): Vec3 => [
  matrix[0]! * point[0] +
    matrix[4]! * point[1] +
    matrix[8]! * point[2] +
    matrix[12]!,
  matrix[1]! * point[0] +
    matrix[5]! * point[1] +
    matrix[9]! * point[2] +
    matrix[13]!,
  matrix[2]! * point[0] +
    matrix[6]! * point[1] +
    matrix[10]! * point[2] +
    matrix[14]!,
];

const textureHash = (texture: Texture | null): string | null => {
  if (!texture) return null;
  const image = texture.getImage();
  if (image) return createHash("sha256").update(image).digest("hex");
  return texture.getURI() ? `external:${texture.getURI()}` : "missing";
};

const materialTextures = (
  material: Material,
): Array<{ channel: TextureChannel; texture: Texture }> => {
  const values: Array<[TextureChannel, Texture | null]> = [
    ["base-color", material.getBaseColorTexture()],
    ["metallic-roughness", material.getMetallicRoughnessTexture()],
    ["normal", material.getNormalTexture()],
    ["occlusion", material.getOcclusionTexture()],
    ["emissive", material.getEmissiveTexture()],
  ];
  return values.flatMap(([channel, texture]) =>
    texture ? [{ channel, texture }] : [],
  );
};

const materialSignature = (material: Material): string =>
  JSON.stringify({
    baseColor: material.getBaseColorFactor(),
    metallic: material.getMetallicFactor(),
    roughness: material.getRoughnessFactor(),
    emissive: material.getEmissiveFactor(),
    alphaMode: material.getAlphaMode(),
    alphaCutoff: material.getAlphaCutoff(),
    doubleSided: material.getDoubleSided(),
    textures: materialTextures(material).map(({ channel, texture }) => [
      channel,
      textureHash(texture),
    ]),
  });

const canonicalFindingId = (
  assetId: string,
  findingCode: string,
  summary: string,
): string =>
  `finding-${createHash("sha256")
    .update(JSON.stringify([assetId, findingCode, summary]))
    .digest("hex")}`;

const inspectPrimitive = (
  primitive: Primitive,
  ordinalBase: number,
): {
  triangles: Triangle[];
  vertexCount: number;
  referencedVertices: Set<number>;
  positionAccessor?: Accessor;
  errors: {
    mode: boolean;
    positions: boolean;
    indices: boolean;
    triples: boolean;
    normals: boolean;
  };
} => {
  const positions = primitive.getAttribute("POSITION");
  const normals = primitive.getAttribute("NORMAL");
  const indices = primitive.getIndices();
  const errors = {
    mode: primitive.getMode() !== Primitive.Mode.TRIANGLES,
    positions: !positions || positions.getType() !== "VEC3",
    indices: false,
    triples: false,
    normals: false,
  };
  if (!positions)
    return {
      triangles: [],
      vertexCount: 0,
      referencedVertices: new Set(),
      errors,
    };

  const vertexCount = positions.getCount();
  const referencedVertices = new Set<number>();
  const drawIndices: number[] = [];
  if (indices) {
    for (let index = 0; index < indices.getCount(); index += 1) {
      const value = indices.getElement(index, [])[0];
      if (
        value === undefined ||
        !Number.isInteger(value) ||
        value < 0 ||
        value >= vertexCount
      ) {
        errors.indices = true;
        drawIndices.push(-1);
      } else {
        drawIndices.push(value);
        referencedVertices.add(value);
      }
    }
  } else {
    for (let index = 0; index < vertexCount; index += 1) {
      drawIndices.push(index);
      referencedVertices.add(index);
    }
  }
  if (drawIndices.length % 3 !== 0) errors.triples = true;

  const triangles: Triangle[] = [];
  for (let offset = 0; offset + 2 < drawIndices.length; offset += 3) {
    const triangleIndices: [number, number, number] = [
      drawIndices[offset]!,
      drawIndices[offset + 1]!,
      drawIndices[offset + 2]!,
    ];
    if (triangleIndices.some((value) => value < 0)) continue;
    const trianglePositions: [Vec3, Vec3, Vec3] = [
      readVec3(positions, triangleIndices[0]),
      readVec3(positions, triangleIndices[1]),
      readVec3(positions, triangleIndices[2]),
    ];
    if (!trianglePositions.every(isFiniteVec3)) {
      errors.positions = true;
      continue;
    }
    let triangleNormals: [Vec3, Vec3, Vec3] | undefined;
    if (normals && normals.getType() === "VEC3") {
      triangleNormals = [
        readVec3(normals, triangleIndices[0]),
        readVec3(normals, triangleIndices[1]),
        readVec3(normals, triangleIndices[2]),
      ];
      if (!triangleNormals.every((normal) => normalize(normal) !== undefined))
        errors.normals = true;
    } else {
      errors.normals = true;
    }
    triangles.push({
      ordinal: ordinalBase + triangles.length,
      indices: triangleIndices,
      positions: trianglePositions,
      ...(triangleNormals ? { normals: triangleNormals } : {}),
    });
  }

  return {
    triangles,
    vertexCount,
    referencedVertices,
    positionAccessor: positions,
    errors,
  };
};

type WeldedEdge = { directions: string[] };

const topologyForMesh = (
  mesh: Mesh,
  toleranceRatio: number,
): {
  degenerateTriangles: number;
  nonManifoldEdges: number;
  boundaryEdges: number;
  unreferencedVertices: number;
  inconsistentWindingEdges: number;
  normalMismatchTriangles: number;
  edgeCount: number;
  duplicateTriangles: number;
  triangleCount: number;
} => {
  const primitiveResults = mesh
    .listPrimitives()
    .map((primitive, index) => inspectPrimitive(primitive, index * 1_000_000));
  const points = primitiveResults.flatMap((result) =>
    result.positionAccessor
      ? Array.from({ length: result.vertexCount }, (_, index) =>
          readVec3(result.positionAccessor!, index),
        ).filter(isFiniteVec3)
      : [],
  );
  const minimum: Vec3 = [Infinity, Infinity, Infinity];
  const maximum: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const point of points) {
    for (let axis = 0; axis < 3; axis += 1) {
      minimum[axis] = Math.min(minimum[axis]!, point[axis]!);
      maximum[axis] = Math.max(maximum[axis]!, point[axis]!);
    }
  }
  const diagonal = Number.isFinite(minimum[0])
    ? Math.sqrt(lengthSquared(subtract(maximum, minimum)))
    : 0;
  const tolerance = Math.max(diagonal * toleranceRatio, 1e-9);
  const cells = new Map<string, number[]>();
  const weldedPoints: Vec3[] = [];
  const weld = (point: Vec3): number => {
    const coordinate = point.map((value) => Math.floor(value / tolerance));
    let match: number | undefined;
    for (let dx = -1; dx <= 1; dx += 1)
      for (let dy = -1; dy <= 1; dy += 1)
        for (let dz = -1; dz <= 1; dz += 1) {
          const key = `${coordinate[0]! + dx}:${coordinate[1]! + dy}:${coordinate[2]! + dz}`;
          for (const candidate of cells.get(key) ?? []) {
            if (
              lengthSquared(subtract(weldedPoints[candidate]!, point)) <=
                tolerance * tolerance &&
              (match === undefined || candidate < match)
            )
              match = candidate;
          }
        }
    if (match !== undefined) return match;
    const id = weldedPoints.length;
    weldedPoints.push(point);
    const key = `${coordinate[0]}:${coordinate[1]}:${coordinate[2]}`;
    cells.set(key, [...(cells.get(key) ?? []), id]);
    return id;
  };

  const edges = new Map<string, WeldedEdge>();
  const triangleKeys = new Set<string>();
  let duplicateTriangles = 0;
  let degenerateTriangles = 0;
  let normalMismatchTriangles = 0;
  let triangleCount = 0;
  let unreferencedVertices = 0;
  for (const result of primitiveResults) {
    if (result.positionAccessor && result.positionAccessor.getCount() > 0) {
      unreferencedVertices +=
        result.positionAccessor.getCount() - result.referencedVertices.size;
    }
    for (const triangle of result.triangles) {
      triangleCount += 1;
      const degenerate = isDegenerate(triangle);
      if (degenerate) degenerateTriangles += 1;
      if (!degenerate && triangle.normals) {
        const faceNormal = normalize(
          cross(
            subtract(triangle.positions[1], triangle.positions[0]),
            subtract(triangle.positions[2], triangle.positions[0]),
          ),
        );
        const normals = triangle.normals.map(normalize);
        const average = normals.every(Boolean)
          ? normalize([
              normals.reduce((sum, normal) => sum + normal![0], 0),
              normals.reduce((sum, normal) => sum + normal![1], 0),
              normals.reduce((sum, normal) => sum + normal![2], 0),
            ])
          : undefined;
        if (!faceNormal || !average || dot(faceNormal, average) < 0)
          normalMismatchTriangles += 1;
      }
      const welded = triangle.positions.map(weld) as [number, number, number];
      const triangleKey = [...welded].sort((a, b) => a - b).join(":");
      if (triangleKeys.has(triangleKey)) duplicateTriangles += 1;
      else triangleKeys.add(triangleKey);
      if (degenerate) continue;
      for (const [from, to] of [
        [welded[0], welded[1]],
        [welded[1], welded[2]],
        [welded[2], welded[0]],
      ] as Array<[number, number]>) {
        const key = from < to ? `${from}:${to}` : `${to}:${from}`;
        const edge = edges.get(key) ?? { directions: [] };
        edge.directions.push(`${from}:${to}`);
        edges.set(key, edge);
      }
    }
  }

  let boundaryEdges = 0;
  let nonManifoldEdges = 0;
  let inconsistentWindingEdges = 0;
  for (const edge of edges.values()) {
    if (edge.directions.length === 1) boundaryEdges += 1;
    if (edge.directions.length > 2) nonManifoldEdges += 1;
    if (new Set(edge.directions).size < edge.directions.length)
      inconsistentWindingEdges += 1;
  }
  return {
    degenerateTriangles,
    nonManifoldEdges,
    boundaryEdges,
    unreferencedVertices,
    inconsistentWindingEdges,
    normalMismatchTriangles,
    edgeCount: edges.size,
    duplicateTriangles,
    triangleCount,
  };
};

export const inspectParsedAsset = (
  document: Document,
  asset: AssetDocument,
  policy: AssetPolicy,
): ParsedAssetInspection => {
  const root = document.getRoot();
  const meshes = root.listMeshes();
  const primitives = meshes.flatMap((mesh) => mesh.listPrimitives());
  const primitiveResults = primitives.map((primitive, index) =>
    inspectPrimitive(primitive, index * 1_000_000),
  );
  const vertexCount = primitiveResults.reduce(
    (sum, result) => sum + result.vertexCount,
    0,
  );
  const triangleCount = primitiveResults.reduce(
    (sum, result) => sum + result.triangles.length,
    0,
  );

  const minimum: Vec3 = [Infinity, Infinity, Infinity];
  const maximum: Vec3 = [-Infinity, -Infinity, -Infinity];
  const scene = root.listScenes()[0];
  scene?.traverse((node) => {
    const mesh = node.getMesh();
    if (!mesh) return;
    const matrix = node.getWorldMatrix();
    for (const primitive of mesh.listPrimitives()) {
      const positions = primitive.getAttribute("POSITION");
      if (!positions) continue;
      for (let index = 0; index < positions.getCount(); index += 1) {
        const local = readVec3(positions, index);
        if (!isFiniteVec3(local)) continue;
        const world = transformPoint(local, matrix);
        if (!isFiniteVec3(world)) continue;
        for (let axis = 0; axis < 3; axis += 1) {
          minimum[axis] = Math.min(minimum[axis]!, world[axis]!);
          maximum[axis] = Math.max(maximum[axis]!, world[axis]!);
        }
      }
    }
  });
  const boundsMeters = {
    x: Number.isFinite(minimum[0]) ? Math.max(0, maximum[0] - minimum[0]) : 0,
    y: Number.isFinite(minimum[1]) ? Math.max(0, maximum[1] - minimum[1]) : 0,
    z: Number.isFinite(minimum[2]) ? Math.max(0, maximum[2] - minimum[2]) : 0,
  };

  const topologyParts = meshes.map((mesh) =>
    topologyForMesh(mesh, policy.topology.weldToleranceRatio),
  );
  const sumTopology = (key: keyof (typeof topologyParts)[number]): number =>
    topologyParts.reduce((sum, part) => sum + part[key], 0);
  const topology = {
    degenerateTriangles: sumTopology("degenerateTriangles"),
    nonManifoldEdges: sumTopology("nonManifoldEdges"),
    boundaryEdges: sumTopology("boundaryEdges"),
    unreferencedVertices: sumTopology("unreferencedVertices"),
    inconsistentWindingEdges: sumTopology("inconsistentWindingEdges"),
    normalMismatchTriangles: sumTopology("normalMismatchTriangles"),
  };

  const materials = root.listMaterials();
  const usedMaterials = new Set(
    primitives.flatMap((primitive) => {
      const material = primitive.getMaterial();
      return material ? [material] : [];
    }),
  );
  const unassignedPrimitiveCount = primitives.filter(
    (primitive) => !primitive.getMaterial(),
  ).length;
  const signatureCounts = new Map<string, number>();
  for (const material of materials) {
    const signature = materialSignature(material);
    signatureCounts.set(signature, (signatureCounts.get(signature) ?? 0) + 1);
  }
  const duplicateMaterialGroupCount = [...signatureCounts.values()].filter(
    (count) => count > 1,
  ).length;

  const textures = root.listTextures();
  const referencedByChannel = new Map<TextureChannel, Set<Texture>>();
  for (const material of usedMaterials)
    for (const { channel, texture } of materialTextures(material)) {
      const channelTextures = referencedByChannel.get(channel) ?? new Set();
      channelTextures.add(texture);
      referencedByChannel.set(channel, channelTextures);
    }
  const referencedTextures = new Set(
    [...referencedByChannel.values()].flatMap((value) => [...value]),
  );
  const embeddedTextures = textures.filter((texture) => texture.getImage());
  const dimensions = embeddedTextures.flatMap((texture) => {
    const size = texture.getSize();
    return size ? [size[0], size[1]] : [];
  });

  const measurements: AssetQualityMeasurements = {
    mesh: {
      meshCount: meshes.length,
      primitiveCount: primitives.length,
      vertexCount,
      triangleCount,
      boundsMeters,
    },
    material: {
      materialCount: materials.length,
      unassignedPrimitiveCount,
      unusedMaterialCount: materials.filter(
        (material) => !usedMaterials.has(material),
      ).length,
      duplicateMaterialGroupCount,
    },
    texture: {
      textureCount: textures.length,
      embeddedCount: embeddedTextures.length,
      referencedCount: referencedTextures.size,
      unusedCount: textures.filter(
        (texture) => !referencedTextures.has(texture),
      ).length,
      smallestDimensionPx: dimensions.length ? Math.min(...dimensions) : 0,
      largestDimensionPx: dimensions.length ? Math.max(...dimensions) : 0,
    },
    topology,
  };

  const sourceEvidence = [asset.glb.artifactId];
  const gates: QualityGate[] = [];
  const gate = (
    id: string,
    category: QualityGate["category"],
    label: string,
    passed: boolean,
    actual: QualityGate["actual"],
    threshold: string,
  ) =>
    gates.push({
      id,
      category,
      label,
      passed,
      actual,
      threshold,
      evidenceArtifactIds: sourceEvidence,
    });
  const largestExtent = Math.max(
    boundsMeters.x,
    boundsMeters.y,
    boundsMeters.z,
  );
  gate(
    "mesh-count",
    "mesh",
    "Mesh definition count",
    meshes.length > 0 && meshes.length <= policy.mesh.maxMeshes,
    meshes.length,
    `1..${policy.mesh.maxMeshes}`,
  );
  gate(
    "primitive-count",
    "mesh",
    "Primitive definition count",
    primitives.length > 0 && primitives.length <= policy.mesh.maxPrimitives,
    primitives.length,
    `1..${policy.mesh.maxPrimitives}`,
  );
  gate(
    "vertex-count",
    "mesh",
    "Vertex budget",
    vertexCount > 0 && vertexCount <= policy.mesh.maxVertices,
    vertexCount,
    `1..${policy.mesh.maxVertices}`,
  );
  gate(
    "triangle-count",
    "mesh",
    "Triangle budget",
    triangleCount > 0 && triangleCount <= policy.mesh.maxTriangles,
    triangleCount,
    `1..${policy.mesh.maxTriangles}`,
  );
  gate(
    "bounds-largest-extent",
    "mesh",
    "Largest world-space extent",
    largestExtent >= policy.mesh.minLargestExtentMeters &&
      largestExtent <= policy.mesh.maxLargestExtentMeters,
    largestExtent,
    `${policy.mesh.minLargestExtentMeters}..${policy.mesh.maxLargestExtentMeters} m`,
  );
  gate(
    "primitive-mode",
    "mesh",
    "Triangle primitive mode",
    primitiveResults.every((result) => !result.errors.mode),
    primitiveResults.filter((result) => result.errors.mode).length,
    "0 invalid primitives",
  );
  gate(
    "primitive-positions",
    "mesh",
    "Finite VEC3 positions",
    primitiveResults.every((result) => !result.errors.positions),
    primitiveResults.filter((result) => result.errors.positions).length,
    "0 invalid primitives",
  );
  gate(
    "primitive-indices",
    "mesh",
    "Indices within accessor bounds",
    primitiveResults.every((result) => !result.errors.indices),
    primitiveResults.filter((result) => result.errors.indices).length,
    "0 invalid primitives",
  );
  gate(
    "primitive-triples",
    "mesh",
    "Complete triangle triples",
    primitiveResults.every((result) => !result.errors.triples),
    primitiveResults.filter((result) => result.errors.triples).length,
    "0 incomplete primitives",
  );
  gate(
    "material-assignment",
    "material",
    "Primitive material assignment",
    !policy.material.requireAssignedMaterial || unassignedPrimitiveCount === 0,
    unassignedPrimitiveCount,
    policy.material.requireAssignedMaterial
      ? "0 unassigned primitives"
      : "not required",
  );
  gate(
    "normals",
    "material",
    "Finite non-zero vertex normals",
    !policy.material.requireNormals ||
      primitiveResults.every((result) => !result.errors.normals),
    primitiveResults.filter((result) => result.errors.normals).length,
    policy.material.requireNormals ? "0 invalid primitives" : "not required",
  );

  const claimedChannels = new Set<TextureChannel>(
    asset.generationClaims?.textureChannels ?? [],
  );
  if (asset.generationClaims?.textured)
    for (const channel of policy.material.requiredClaimedTextureChannels)
      claimedChannels.add(channel);
  const relevantChannels = new Set<TextureChannel>([
    ...claimedChannels,
    ...referencedByChannel.keys(),
  ]);
  const missingClaimedChannels = [...claimedChannels].filter(
    (channel) => !referencedByChannel.get(channel)?.size,
  );
  const relevantTextures = new Set(
    [...relevantChannels].flatMap((channel) => [
      ...(referencedByChannel.get(channel) ?? []),
    ]),
  );
  const externalTextures = [...relevantTextures].filter(
    (texture) => !texture.getImage(),
  );
  const undecodableTextures = [...relevantTextures].filter(
    (texture) => texture.getImage() && !texture.getSize(),
  );
  const outOfRangeTextures = [...relevantTextures].filter((texture) => {
    const size = texture.getSize();
    if (!size) return false;
    return (
      Math.min(size[0], size[1]) < policy.texture.minDimensionPx ||
      Math.max(size[0], size[1]) > policy.texture.maxDimensionPx
    );
  });
  gate(
    "texture-claims",
    "texture",
    "Claimed texture channels",
    missingClaimedChannels.length === 0,
    missingClaimedChannels.join(",") || "all present",
    "all claimed channels present",
  );
  gate(
    "texture-embedded",
    "texture",
    "Referenced images are embedded",
    externalTextures.length === 0,
    externalTextures.length,
    "0 external or missing images",
  );
  gate(
    "texture-decodable",
    "texture",
    "Embedded image dimensions are readable",
    undecodableTextures.length === 0,
    undecodableTextures.length,
    "0 undecodable images",
  );
  gate(
    "texture-dimensions",
    "texture",
    "Referenced texture dimensions",
    outOfRangeTextures.length === 0,
    outOfRangeTextures.length,
    `${policy.texture.minDimensionPx}..${policy.texture.maxDimensionPx} px`,
  );

  const edgeCount = sumTopology("edgeCount");
  const topologyTriangleCount = sumTopology("triangleCount");
  const ratio = (numerator: number, denominator: number): number =>
    denominator > 0 ? numerator / denominator : 0;
  gate(
    "topology-degenerate-ratio",
    "topology",
    "Degenerate triangle ratio",
    ratio(topology.degenerateTriangles, topologyTriangleCount) <=
      policy.topology.maxDegenerateTriangleRatio,
    ratio(topology.degenerateTriangles, topologyTriangleCount),
    `<= ${policy.topology.maxDegenerateTriangleRatio}`,
  );
  gate(
    "topology-non-manifold-edges",
    "topology",
    "Non-manifold edges",
    topology.nonManifoldEdges <= policy.topology.maxNonManifoldEdges,
    topology.nonManifoldEdges,
    `<= ${policy.topology.maxNonManifoldEdges}`,
  );
  gate(
    "topology-unreferenced-ratio",
    "topology",
    "Unreferenced vertex ratio",
    ratio(topology.unreferencedVertices, vertexCount) <=
      policy.topology.maxUnreferencedVertexRatio,
    ratio(topology.unreferencedVertices, vertexCount),
    `<= ${policy.topology.maxUnreferencedVertexRatio}`,
  );
  gate(
    "topology-winding-ratio",
    "topology",
    "Inconsistent winding edge ratio",
    ratio(topology.inconsistentWindingEdges, edgeCount) <=
      policy.topology.maxInconsistentWindingRatio,
    ratio(topology.inconsistentWindingEdges, edgeCount),
    `<= ${policy.topology.maxInconsistentWindingRatio}`,
  );
  gate(
    "topology-normal-mismatch-ratio",
    "topology",
    "Face and vertex normal mismatch ratio",
    ratio(topology.normalMismatchTriangles, topologyTriangleCount) <=
      policy.topology.maxNormalMismatchRatio,
    ratio(topology.normalMismatchTriangles, topologyTriangleCount),
    `<= ${policy.topology.maxNormalMismatchRatio}`,
  );

  const findings: EvaluationFinding[] = [];
  const finding = (
    findingCode: string,
    category: EvaluationFinding["category"],
    summary: string,
    severity: EvaluationFinding["severity"] = "minor",
  ) =>
    findings.push({
      findingId: canonicalFindingId(asset.assetId, findingCode, summary),
      findingCode,
      rubricVersion: "deterministic-quality-v1",
      category,
      summary,
      evidenceArtifactIds: sourceEvidence,
      evidence: [{ artifactId: asset.glb.artifactId, kind: "source-asset" }],
      severity,
      confidence: 1,
      ownerModule: "asset-production",
    });
  const nonzeroExtents = Object.values(boundsMeters).filter(
    (value) => value > 0,
  );
  const aspectRatio = nonzeroExtents.length
    ? Math.max(...nonzeroExtents) / Math.min(...nonzeroExtents)
    : Number.POSITIVE_INFINITY;
  if (aspectRatio > policy.mesh.warnAspectRatioAbove)
    finding(
      "mesh.aspect-ratio",
      "geometry",
      `World-space aspect ratio ${aspectRatio.toFixed(4)} exceeds ${policy.mesh.warnAspectRatioAbove}.`,
    );
  if (
    measurements.material.unusedMaterialCount > policy.material.warnUnusedAbove
  )
    finding(
      "materials.unused",
      "materials",
      `${measurements.material.unusedMaterialCount} material definitions are unused.`,
    );
  if (duplicateMaterialGroupCount > policy.material.warnDuplicateGroupsAbove)
    finding(
      "materials.duplicate-group",
      "materials",
      `${duplicateMaterialGroupCount} canonical material signature groups contain duplicates.`,
    );
  if (measurements.texture.unusedCount > policy.texture.warnUnusedAbove)
    finding(
      "textures.unused",
      "materials",
      `${measurements.texture.unusedCount} texture definitions are unused.`,
    );
  if (
    ratio(topology.boundaryEdges, edgeCount) >
    policy.topology.warnBoundaryEdgeRatioAbove
  )
    finding(
      "topology.boundary-edge-ratio",
      "geometry",
      `Boundary edges account for ${ratio(topology.boundaryEdges, edgeCount).toFixed(6)} of welded edges.`,
    );
  const duplicateTriangles = sumTopology("duplicateTriangles");
  if (duplicateTriangles > 0)
    finding(
      "topology.duplicate-triangle",
      "geometry",
      `${duplicateTriangles} duplicate welded triangle triplets were found.`,
      "major",
    );

  const hardGateFailures = gates.filter((item) => !item.passed).length;
  const qualityVector: AssetQualityVector = {
    hardGateFailures,
    criticalFindings: findings.filter((item) => item.severity === "critical")
      .length,
    majorFindings: findings.filter((item) => item.severity === "major").length,
    minorFindings: findings.filter((item) => item.severity === "minor").length,
    semanticVerdict: "not-run",
  };
  return {
    passed: hardGateFailures === 0,
    measurements,
    gates,
    findings,
    qualityVector,
  };
};
