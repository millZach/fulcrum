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
      maxNonManifoldEdges: 250,
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
      maxNonManifoldEdges: 100,
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
      maxNonManifoldEdges: 30,
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

type PrimitiveInspection = {
  triangleCount: number;
  vertexCount: number;
  referencedVertexCount: number;
  positionAccessor?: Accessor;
  errors: {
    mode: boolean;
    positions: boolean;
    indices: boolean;
    triples: boolean;
    normals: boolean;
  };
};

export type ParsedAssetInspection = {
  passed: boolean;
  measurements: AssetQualityMeasurements;
  gates: QualityGate[];
  findings: EvaluationFinding[];
  qualityVector: AssetQualityVector;
};

const readVec3Into = (
  accessor: Accessor,
  index: number,
  target: Vec3,
): Vec3 => {
  target[0] = Number.NaN;
  target[1] = Number.NaN;
  target[2] = Number.NaN;
  accessor.getElement(index, target);
  target.length = 3;
  return target;
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

const isDegenerate = (
  indexA: number,
  indexB: number,
  indexC: number,
  a: Vec3,
  b: Vec3,
  c: Vec3,
): boolean => {
  if (indexA === indexB || indexB === indexC || indexC === indexA) return true;
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

const transformPointInto = (
  point: Vec3,
  matrix: readonly number[],
  target: Vec3,
): Vec3 => {
  target[0] =
    matrix[0]! * point[0] +
    matrix[4]! * point[1] +
    matrix[8]! * point[2] +
    matrix[12]!;
  target[1] =
    matrix[1]! * point[0] +
    matrix[5]! * point[1] +
    matrix[9]! * point[2] +
    matrix[13]!;
  target[2] =
    matrix[2]! * point[0] +
    matrix[6]! * point[1] +
    matrix[10]! * point[2] +
    matrix[14]!;
  return target;
};

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

type TriangleVisitor = (
  indexA: number,
  indexB: number,
  indexC: number,
  positionA: Vec3,
  positionB: Vec3,
  positionC: Vec3,
  normalA?: Vec3,
  normalB?: Vec3,
  normalC?: Vec3,
) => void;

const readPrimitiveIndex = (
  indices: Accessor,
  offset: number,
  vertexCount: number,
  target: number[],
): number => {
  target[0] = Number.NaN;
  const value = indices.getElement(offset, target)[0];
  return value !== undefined &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < vertexCount
    ? value
    : -1;
};

const visitPrimitiveTriangles = (
  primitive: Primitive,
  visitor: TriangleVisitor,
  invalidPosition?: () => void,
): void => {
  const positions = primitive.getAttribute("POSITION");
  if (!positions) return;
  const normals = primitive.getAttribute("NORMAL");
  const indices = primitive.getIndices();
  const vertexCount = positions.getCount();
  const drawCount = indices?.getCount() ?? vertexCount;
  const indexTarget: number[] = [Number.NaN];
  const positionA: Vec3 = [Number.NaN, Number.NaN, Number.NaN];
  const positionB: Vec3 = [Number.NaN, Number.NaN, Number.NaN];
  const positionC: Vec3 = [Number.NaN, Number.NaN, Number.NaN];
  const normalA: Vec3 = [Number.NaN, Number.NaN, Number.NaN];
  const normalB: Vec3 = [Number.NaN, Number.NaN, Number.NaN];
  const normalC: Vec3 = [Number.NaN, Number.NaN, Number.NaN];

  for (let offset = 0; offset + 2 < drawCount; offset += 3) {
    const indexA = indices
      ? readPrimitiveIndex(indices, offset, vertexCount, indexTarget)
      : offset;
    const indexB = indices
      ? readPrimitiveIndex(indices, offset + 1, vertexCount, indexTarget)
      : offset + 1;
    const indexC = indices
      ? readPrimitiveIndex(indices, offset + 2, vertexCount, indexTarget)
      : offset + 2;
    if (indexA < 0 || indexB < 0 || indexC < 0) continue;

    readVec3Into(positions, indexA, positionA);
    readVec3Into(positions, indexB, positionB);
    readVec3Into(positions, indexC, positionC);
    if (
      !isFiniteVec3(positionA) ||
      !isFiniteVec3(positionB) ||
      !isFiniteVec3(positionC)
    ) {
      invalidPosition?.();
      continue;
    }

    if (normals && normals.getType() === "VEC3") {
      readVec3Into(normals, indexA, normalA);
      readVec3Into(normals, indexB, normalB);
      readVec3Into(normals, indexC, normalC);
      visitor(
        indexA,
        indexB,
        indexC,
        positionA,
        positionB,
        positionC,
        normalA,
        normalB,
        normalC,
      );
    } else {
      visitor(indexA, indexB, indexC, positionA, positionB, positionC);
    }
  }
};

const inspectPrimitive = (primitive: Primitive): PrimitiveInspection => {
  const positions = primitive.getAttribute("POSITION");
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
      triangleCount: 0,
      vertexCount: 0,
      referencedVertexCount: 0,
      errors,
    };

  const vertexCount = positions.getCount();
  let referencedVertexCount = 0;
  if (indices) {
    const referencedVertices = new Uint8Array(vertexCount);
    const indexTarget: number[] = [Number.NaN];
    for (let index = 0; index < indices.getCount(); index += 1) {
      const value = readPrimitiveIndex(
        indices,
        index,
        vertexCount,
        indexTarget,
      );
      if (value < 0) {
        errors.indices = true;
      } else if (referencedVertices[value] === 0) {
        referencedVertices[value] = 1;
        referencedVertexCount += 1;
      }
    }
  } else {
    referencedVertexCount = vertexCount;
  }
  const drawCount = indices?.getCount() ?? vertexCount;
  if (drawCount % 3 !== 0) errors.triples = true;

  let triangleCount = 0;
  visitPrimitiveTriangles(
    primitive,
    (
      _indexA,
      _indexB,
      _indexC,
      _positionA,
      _positionB,
      _positionC,
      normalA,
      normalB,
      normalC,
    ) => {
      triangleCount += 1;
      if (
        !normalA ||
        !normalB ||
        !normalC ||
        normalize(normalA) === undefined ||
        normalize(normalB) === undefined ||
        normalize(normalC) === undefined
      )
        errors.normals = true;
    },
    () => {
      errors.positions = true;
    },
  );

  return {
    triangleCount,
    vertexCount,
    referencedVertexCount,
    positionAccessor: positions,
    errors,
  };
};

const tableCapacityFor = (maximumEntries: number): number => {
  let capacity = 16;
  while (capacity * 0.7 < maximumEntries) capacity *= 2;
  return capacity;
};

const hashNumbers = (first: number, second: number, third: number): number => {
  let hash = Math.imul(first, 0x9e3779b1);
  hash ^= Math.imul(second, 0x85ebca6b);
  hash ^= Math.imul(third, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
};

class WeldGrid {
  private readonly xCoordinates: Float64Array;
  private readonly yCoordinates: Float64Array;
  private readonly zCoordinates: Float64Array;
  private readonly cells: Array<number[] | undefined>;
  private readonly mask: number;

  constructor(maximumEntries: number) {
    const capacity = tableCapacityFor(maximumEntries);
    this.xCoordinates = new Float64Array(capacity);
    this.yCoordinates = new Float64Array(capacity);
    this.zCoordinates = new Float64Array(capacity);
    this.cells = new Array<number[] | undefined>(capacity);
    this.mask = capacity - 1;
  }

  get(x: number, y: number, z: number): number[] | undefined {
    let slot = hashNumbers(x, y, z) & this.mask;
    while (this.cells[slot] !== undefined) {
      if (
        this.xCoordinates[slot] === x &&
        this.yCoordinates[slot] === y &&
        this.zCoordinates[slot] === z
      )
        return this.cells[slot];
      slot = (slot + 1) & this.mask;
    }
    return undefined;
  }

  append(x: number, y: number, z: number, id: number): void {
    let slot = hashNumbers(x, y, z) & this.mask;
    while (this.cells[slot] !== undefined) {
      if (
        this.xCoordinates[slot] === x &&
        this.yCoordinates[slot] === y &&
        this.zCoordinates[slot] === z
      ) {
        this.cells[slot]!.push(id);
        return;
      }
      slot = (slot + 1) & this.mask;
    }
    this.xCoordinates[slot] = x;
    this.yCoordinates[slot] = y;
    this.zCoordinates[slot] = z;
    this.cells[slot] = [id];
  }
}

class TriangleSet {
  private readonly first: Float64Array;
  private readonly second: Float64Array;
  private readonly third: Float64Array;
  private readonly occupied: Uint8Array;
  private readonly mask: number;

  constructor(maximumEntries: number) {
    const capacity = tableCapacityFor(maximumEntries);
    this.first = new Float64Array(capacity);
    this.second = new Float64Array(capacity);
    this.third = new Float64Array(capacity);
    this.occupied = new Uint8Array(capacity);
    this.mask = capacity - 1;
  }

  add(valueA: number, valueB: number, valueC: number): boolean {
    let first = valueA;
    let second = valueB;
    let third = valueC;
    if (first > second) {
      const swap = first;
      first = second;
      second = swap;
    }
    if (second > third) {
      const swap = second;
      second = third;
      third = swap;
    }
    if (first > second) {
      const swap = first;
      first = second;
      second = swap;
    }

    let slot = hashNumbers(first, second, third) & this.mask;
    while (this.occupied[slot] !== 0) {
      if (
        this.first[slot] === first &&
        this.second[slot] === second &&
        this.third[slot] === third
      )
        return false;
      slot = (slot + 1) & this.mask;
    }
    this.first[slot] = first;
    this.second[slot] = second;
    this.third[slot] = third;
    this.occupied[slot] = 1;
    return true;
  }
}

class EdgeTable {
  private readonly lowerVertices: Float64Array;
  private readonly upperVertices: Float64Array;
  private readonly counts: Float64Array;
  private readonly directionMasks: Uint8Array;
  private readonly duplicateDirections: Uint8Array;
  private readonly mask: number;
  private _size = 0;
  private _boundaryEdges = 0;
  private _nonManifoldEdges = 0;
  private _inconsistentWindingEdges = 0;

  constructor(maximumEntries: number) {
    const capacity = tableCapacityFor(maximumEntries);
    this.lowerVertices = new Float64Array(capacity);
    this.upperVertices = new Float64Array(capacity);
    this.counts = new Float64Array(capacity);
    this.directionMasks = new Uint8Array(capacity);
    this.duplicateDirections = new Uint8Array(capacity);
    this.mask = capacity - 1;
  }

  add(from: number, to: number): void {
    const lower = Math.min(from, to);
    const upper = Math.max(from, to);
    const direction = from === lower ? 1 : 2;
    let slot = hashNumbers(lower, upper, 0) & this.mask;
    while (this.counts[slot] !== 0) {
      if (
        this.lowerVertices[slot] === lower &&
        this.upperVertices[slot] === upper
      ) {
        const count = this.counts[slot]!;
        if (count === 1) this._boundaryEdges -= 1;
        if (count === 2) this._nonManifoldEdges += 1;
        if (
          this.duplicateDirections[slot] === 0 &&
          (this.directionMasks[slot]! & direction) !== 0
        ) {
          this.duplicateDirections[slot] = 1;
          this._inconsistentWindingEdges += 1;
        }
        this.counts[slot] = count + 1;
        this.directionMasks[slot]! |= direction;
        return;
      }
      slot = (slot + 1) & this.mask;
    }

    this.lowerVertices[slot] = lower;
    this.upperVertices[slot] = upper;
    this.counts[slot] = 1;
    this.directionMasks[slot] = direction;
    this._size += 1;
    this._boundaryEdges += 1;
  }

  get size(): number {
    return this._size;
  }

  get boundaryEdges(): number {
    return this._boundaryEdges;
  }

  get nonManifoldEdges(): number {
    return this._nonManifoldEdges;
  }

  get inconsistentWindingEdges(): number {
    return this._inconsistentWindingEdges;
  }
}

const topologyForMesh = (
  mesh: Mesh,
  toleranceRatio: number,
  inspections: ReadonlyMap<Primitive, PrimitiveInspection>,
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
  const primitives = mesh.listPrimitives();
  const primitiveResults = primitives.map((primitive) =>
    inspections.get(primitive)!,
  );
  const minimum: Vec3 = [Infinity, Infinity, Infinity];
  const maximum: Vec3 = [-Infinity, -Infinity, -Infinity];
  const point: Vec3 = [Number.NaN, Number.NaN, Number.NaN];
  for (const result of primitiveResults) {
    if (!result.positionAccessor) continue;
    for (let index = 0; index < result.vertexCount; index += 1) {
      readVec3Into(result.positionAccessor, index, point);
      if (!isFiniteVec3(point)) continue;
      for (let axis = 0; axis < 3; axis += 1) {
        minimum[axis] = Math.min(minimum[axis]!, point[axis]!);
        maximum[axis] = Math.max(maximum[axis]!, point[axis]!);
      }
    }
  }
  const diagonal = Number.isFinite(minimum[0])
    ? Math.sqrt(lengthSquared(subtract(maximum, minimum)))
    : 0;
  const tolerance = Math.max(diagonal * toleranceRatio, 1e-9);
  const maximumWeldedPointCount = primitiveResults.reduce(
    (sum, result) => sum + result.vertexCount,
    0,
  );
  const cells = new WeldGrid(maximumWeldedPointCount);
  const weldedPoints = new Float64Array(maximumWeldedPointCount * 3);
  let weldedPointCount = 0;
  const weld = (position: Vec3): number => {
    const coordinateX = Math.floor(position[0] / tolerance);
    const coordinateY = Math.floor(position[1] / tolerance);
    const coordinateZ = Math.floor(position[2] / tolerance);
    let match: number | undefined;
    for (let dx = -1; dx <= 1; dx += 1)
      for (let dy = -1; dy <= 1; dy += 1)
        for (let dz = -1; dz <= 1; dz += 1) {
          const candidates = cells.get(
            coordinateX + dx,
            coordinateY + dy,
            coordinateZ + dz,
          );
          if (!candidates) continue;
          for (const candidate of candidates) {
            const candidateOffset = candidate * 3;
            const differenceX = weldedPoints[candidateOffset]! - position[0];
            const differenceY =
              weldedPoints[candidateOffset + 1]! - position[1];
            const differenceZ =
              weldedPoints[candidateOffset + 2]! - position[2];
            if (
              differenceX * differenceX +
                differenceY * differenceY +
                differenceZ * differenceZ <=
                tolerance * tolerance &&
              (match === undefined || candidate < match)
            )
              match = candidate;
          }
        }
    if (match !== undefined) return match;
    const id = weldedPointCount;
    const weldedOffset = id * 3;
    weldedPoints[weldedOffset] = position[0];
    weldedPoints[weldedOffset + 1] = position[1];
    weldedPoints[weldedOffset + 2] = position[2];
    weldedPointCount += 1;
    cells.append(coordinateX, coordinateY, coordinateZ, id);
    return id;
  };

  const maximumTriangleCount = primitiveResults.reduce(
    (sum, result) => sum + result.triangleCount,
    0,
  );
  const edges = new EdgeTable(maximumTriangleCount * 3);
  const triangleKeys = new TriangleSet(maximumTriangleCount);
  let duplicateTriangles = 0;
  let degenerateTriangles = 0;
  let normalMismatchTriangles = 0;
  let triangleCount = 0;
  let unreferencedVertices = 0;
  for (
    let primitiveIndex = 0;
    primitiveIndex < primitives.length;
    primitiveIndex += 1
  ) {
    const primitive = primitives[primitiveIndex]!;
    const result = primitiveResults[primitiveIndex]!;
    if (result.positionAccessor && result.positionAccessor.getCount() > 0) {
      unreferencedVertices +=
        result.positionAccessor.getCount() - result.referencedVertexCount;
    }
    visitPrimitiveTriangles(
      primitive,
      (
        indexA,
        indexB,
        indexC,
        positionA,
        positionB,
        positionC,
        normalA,
        normalB,
        normalC,
      ) => {
        triangleCount += 1;
        const degenerate = isDegenerate(
          indexA,
          indexB,
          indexC,
          positionA,
          positionB,
          positionC,
        );
        if (degenerate) degenerateTriangles += 1;
        if (degenerate === false && normalA && normalB && normalC) {
          const faceNormal = normalize(
            cross(
              subtract(positionB, positionA),
              subtract(positionC, positionA),
            ),
          );
          const normalizedA = normalize(normalA);
          const normalizedB = normalize(normalB);
          const normalizedC = normalize(normalC);
          const average =
            normalizedA && normalizedB && normalizedC
              ? normalize([
                  0 + normalizedA[0] + normalizedB[0] + normalizedC[0],
                  0 + normalizedA[1] + normalizedB[1] + normalizedC[1],
                  0 + normalizedA[2] + normalizedB[2] + normalizedC[2],
                ])
              : undefined;
          if (!faceNormal || !average || dot(faceNormal, average) < 0)
            normalMismatchTriangles += 1;
        }

        const weldedA = weld(positionA);
        const weldedB = weld(positionB);
        const weldedC = weld(positionC);
        if (!triangleKeys.add(weldedA, weldedB, weldedC))
          duplicateTriangles += 1;
        if (degenerate) return;
        edges.add(weldedA, weldedB);
        edges.add(weldedB, weldedC);
        edges.add(weldedC, weldedA);
      },
    );
  }
  return {
    degenerateTriangles,
    nonManifoldEdges: edges.nonManifoldEdges,
    boundaryEdges: edges.boundaryEdges,
    unreferencedVertices,
    inconsistentWindingEdges: edges.inconsistentWindingEdges,
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
  const primitiveResults = primitives.map(inspectPrimitive);
  const inspections = new Map<Primitive, PrimitiveInspection>();
  for (let index = 0; index < primitives.length; index += 1)
    inspections.set(primitives[index]!, primitiveResults[index]!);
  const vertexCount = primitiveResults.reduce(
    (sum, result) => sum + result.vertexCount,
    0,
  );
  const triangleCount = primitiveResults.reduce(
    (sum, result) => sum + result.triangleCount,
    0,
  );

  const minimum: Vec3 = [Infinity, Infinity, Infinity];
  const maximum: Vec3 = [-Infinity, -Infinity, -Infinity];
  const local: Vec3 = [Number.NaN, Number.NaN, Number.NaN];
  const world: Vec3 = [Number.NaN, Number.NaN, Number.NaN];
  const scene = root.listScenes()[0];
  scene?.traverse((node) => {
    const mesh = node.getMesh();
    if (!mesh) return;
    const matrix = node.getWorldMatrix();
    for (const primitive of mesh.listPrimitives()) {
      const positions = primitive.getAttribute("POSITION");
      if (!positions) continue;
      for (let index = 0; index < positions.getCount(); index += 1) {
        readVec3Into(positions, index, local);
        if (!isFiniteVec3(local)) continue;
        transformPointInto(local, matrix, world);
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
    topologyForMesh(mesh, policy.topology.weldToleranceRatio, inspections),
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
  if (topology.nonManifoldEdges > 0)
    finding(
      "topology.non-manifold-edge",
      "geometry",
      `${topology.nonManifoldEdges} non-manifold welded ${topology.nonManifoldEdges === 1 ? "edge was" : "edges were"} found; the ${policy.classification} cap is ${policy.topology.maxNonManifoldEdges}.`,
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
