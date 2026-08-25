import type { AssetPolicy } from "@fulcrum/domain";
import { type Document, Primitive } from "@gltf-transform/core";

import { encodePngRgba } from "./png.js";

const MAX_TURNTABLE_TRIANGLES = 250_000;
const BACKGROUND: [number, number, number, number] = [22, 27, 36, 255];

type Vec3 = [number, number, number];

type WorldTriangle = {
  ordinal: number;
  points: [Vec3, Vec3, Vec3];
  normal: Vec3;
  baseColor: [number, number, number, number];
};

type ScreenVertex = { x: number; y: number; depth: number };

export type RenderedTurntableFrame = {
  frameIndex: number;
  yawDegrees: number;
  bytes: Uint8Array;
};

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

const normalize = (value: Vec3): Vec3 => {
  const length = Math.sqrt(dot(value, value));
  if (!Number.isFinite(length) || length === 0)
    throw new Error("Turntable encountered a zero or non-finite direction.");
  return [value[0] / length, value[1] / length, value[2] / length];
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

const edge = (
  start: ScreenVertex,
  end: ScreenVertex,
  x: number,
  y: number,
): number =>
  (end.x - start.x) * (y - start.y) - (end.y - start.y) * (x - start.x);

const isTopLeft = (start: ScreenVertex, end: ScreenVertex): boolean => {
  const dy = end.y - start.y;
  const dx = end.x - start.x;
  return dy < 0 || (dy === 0 && dx > 0);
};

const containsEdge = (value: number, topLeft: boolean): boolean =>
  value > 0 || (value === 0 && topLeft);

const toByte = (linearValue: number): number => {
  const value = Math.min(1, Math.max(0, linearValue));
  const srgb =
    value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
  return Math.round(srgb * 255);
};

const renderFrame = (
  triangles: readonly WorldTriangle[],
  center: Vec3,
  radius: number,
  config: AssetPolicy["turntable"],
  yawDegrees: number,
): Uint8Array => {
  const yaw = (yawDegrees * Math.PI) / 180;
  const elevation = (config.elevationDegrees * Math.PI) / 180;
  const centerToCamera = normalize([
    Math.sin(yaw) * Math.cos(elevation),
    Math.sin(elevation),
    -Math.cos(yaw) * Math.cos(elevation),
  ]);
  const forward: Vec3 = [
    -centerToCamera[0],
    -centerToCamera[1],
    -centerToCamera[2],
  ];
  const right = normalize(cross([0, 1, 0], forward));
  const up = normalize(cross(forward, right));
  const halfHeight = radius * (1 + config.paddingRatio);
  const halfWidth = halfHeight * (config.width / config.height);
  const rgba = new Uint8Array(config.width * config.height * 4);
  for (let pixel = 0; pixel < config.width * config.height; pixel += 1)
    rgba.set(BACKGROUND, pixel * 4);
  const depth = new Float64Array(config.width * config.height);
  depth.fill(Number.POSITIVE_INFINITY);
  const ordinal = new Int32Array(config.width * config.height);
  ordinal.fill(2_147_483_647);
  const light = normalize([0.4, 0.8, -0.6]);

  for (const triangle of triangles) {
    let projected = triangle.points.map((point): ScreenVertex => {
      const relative = subtract(point, center);
      const cameraX = dot(relative, right);
      const cameraY = dot(relative, up);
      return {
        x: (cameraX / halfWidth / 2 + 0.5) * config.width,
        y: (0.5 - cameraY / halfHeight / 2) * config.height,
        depth: dot(relative, forward),
      };
    }) as [ScreenVertex, ScreenVertex, ScreenVertex];
    let area = edge(projected[0], projected[1], projected[2].x, projected[2].y);
    if (!Number.isFinite(area) || area === 0) continue;
    if (area < 0) {
      projected = [projected[0], projected[2], projected[1]];
      area = -area;
    }
    const minimumX = Math.max(
      0,
      Math.floor(Math.min(...projected.map((point) => point.x))),
    );
    const maximumX = Math.min(
      config.width - 1,
      Math.ceil(Math.max(...projected.map((point) => point.x))) - 1,
    );
    const minimumY = Math.max(
      0,
      Math.floor(Math.min(...projected.map((point) => point.y))),
    );
    const maximumY = Math.min(
      config.height - 1,
      Math.ceil(Math.max(...projected.map((point) => point.y))) - 1,
    );
    const edge0TopLeft = isTopLeft(projected[1], projected[2]);
    const edge1TopLeft = isTopLeft(projected[2], projected[0]);
    const edge2TopLeft = isTopLeft(projected[0], projected[1]);
    const lighting = 0.35 + 0.65 * Math.max(0, dot(triangle.normal, light));
    const color = [
      toByte(triangle.baseColor[0] * lighting),
      toByte(triangle.baseColor[1] * lighting),
      toByte(triangle.baseColor[2] * lighting),
      255,
    ];

    for (let y = minimumY; y <= maximumY; y += 1)
      for (let x = minimumX; x <= maximumX; x += 1) {
        const sampleX = x + 0.5;
        const sampleY = y + 0.5;
        const weight0 = edge(projected[1], projected[2], sampleX, sampleY);
        const weight1 = edge(projected[2], projected[0], sampleX, sampleY);
        const weight2 = edge(projected[0], projected[1], sampleX, sampleY);
        if (
          !containsEdge(weight0, edge0TopLeft) ||
          !containsEdge(weight1, edge1TopLeft) ||
          !containsEdge(weight2, edge2TopLeft)
        )
          continue;
        const sampleDepth =
          (weight0 * projected[0].depth +
            weight1 * projected[1].depth +
            weight2 * projected[2].depth) /
          area;
        const pixel = y * config.width + x;
        if (
          sampleDepth > depth[pixel]! ||
          (sampleDepth === depth[pixel] && triangle.ordinal >= ordinal[pixel]!)
        )
          continue;
        depth[pixel] = sampleDepth;
        ordinal[pixel] = triangle.ordinal;
        rgba.set(color, pixel * 4);
      }
  }
  return encodePngRgba(config.width, config.height, rgba);
};

export const renderTurntable = (
  document: Document,
  config: AssetPolicy["turntable"],
): RenderedTurntableFrame[] => {
  let definitionTriangleCount = 0;
  for (const mesh of document.getRoot().listMeshes())
    for (const primitive of mesh.listPrimitives()) {
      if (primitive.getMode() !== Primitive.Mode.TRIANGLES)
        throw new Error("Turntable accepts triangle primitives only.");
      const positions = primitive.getAttribute("POSITION");
      if (!positions)
        throw new Error("Turntable primitive is missing POSITION data.");
      const drawCount =
        primitive.getIndices()?.getCount() ?? positions.getCount();
      if (drawCount % 3 !== 0)
        throw new Error("Turntable primitive has an incomplete triangle.");
      definitionTriangleCount += drawCount / 3;
    }
  if (definitionTriangleCount > MAX_TURNTABLE_TRIANGLES)
    throw new Error("Turntable refuses assets above 250,000 triangles.");

  const scene = document.getRoot().listScenes()[0];
  if (!scene) throw new Error("Turntable requires a default scene.");
  const minimum: Vec3 = [Infinity, Infinity, Infinity];
  const maximum: Vec3 = [-Infinity, -Infinity, -Infinity];
  const triangles: WorldTriangle[] = [];
  let triangleOrdinal = 0;
  scene.traverse((node) => {
    const mesh = node.getMesh();
    if (!mesh) return;
    const matrix = node.getWorldMatrix();
    for (const primitive of mesh.listPrimitives()) {
      const positions = primitive.getAttribute("POSITION");
      if (!positions) continue;
      const indices = primitive.getIndices();
      const drawCount = indices?.getCount() ?? positions.getCount();
      const readIndex = (offset: number): number =>
        indices ? (indices.getElement(offset, [])[0] ?? -1) : offset;
      for (let offset = 0; offset < drawCount; offset += 3) {
        const vertexIndices = [
          readIndex(offset),
          readIndex(offset + 1),
          readIndex(offset + 2),
        ];
        if (
          vertexIndices.some(
            (index) =>
              !Number.isInteger(index) ||
              index < 0 ||
              index >= positions.getCount(),
          )
        )
          throw new Error("Turntable primitive index exceeds POSITION bounds.");
        const points = vertexIndices.map((index) => {
          const value = positions.getElement(index, []);
          const point: Vec3 = [
            value[0] ?? Number.NaN,
            value[1] ?? Number.NaN,
            value[2] ?? Number.NaN,
          ];
          if (!point.every(Number.isFinite))
            throw new Error("Turntable encountered non-finite POSITION data.");
          return transformPoint(point, matrix);
        }) as [Vec3, Vec3, Vec3];
        for (const point of points)
          for (let axis = 0; axis < 3; axis += 1) {
            minimum[axis] = Math.min(minimum[axis]!, point[axis]!);
            maximum[axis] = Math.max(maximum[axis]!, point[axis]!);
          }
        const face = cross(
          subtract(points[1], points[0]),
          subtract(points[2], points[0]),
        );
        const squaredArea = dot(face, face);
        if (!Number.isFinite(squaredArea) || squaredArea === 0) {
          triangleOrdinal += 1;
          continue;
        }
        const material = primitive.getMaterial();
        const baseColor = material?.getBaseColorFactor() ?? [0.5, 0.5, 0.5, 1];
        triangles.push({
          ordinal: triangleOrdinal,
          points,
          normal: normalize(face),
          baseColor: [baseColor[0], baseColor[1], baseColor[2], baseColor[3]],
        });
        triangleOrdinal += 1;
      }
    }
  });

  const center: Vec3 = [
    (minimum[0] + maximum[0]) / 2,
    (minimum[1] + maximum[1]) / 2,
    (minimum[2] + maximum[2]) / 2,
  ];
  const radius = Math.sqrt(
    ((maximum[0] - minimum[0]) / 2) ** 2 +
      ((maximum[1] - minimum[1]) / 2) ** 2 +
      ((maximum[2] - minimum[2]) / 2) ** 2,
  );
  if (!Number.isFinite(radius) || radius <= 0)
    throw new Error("Turntable requires finite, non-zero bounds.");

  return Array.from({ length: config.frameCount }, (_, frameIndex) => {
    const yawDegrees = (360 * frameIndex) / config.frameCount;
    return {
      frameIndex,
      yawDegrees,
      bytes: renderFrame(triangles, center, radius, config, yawDegrees),
    };
  });
};
