export type AssetBounds = {
  min: [number, number, number];
  max: [number, number, number];
};

export type AssetFit = {
  position: [number, number, number];
  scale: number;
};

export const M0_RELIQUARY_TARGET_EXTENT_METERS = 3.2;

export const fitAssetToGround = (
  bounds: AssetBounds,
  targetExtent = M0_RELIQUARY_TARGET_EXTENT_METERS,
): AssetFit => {
  const size = bounds.max.map((value, index) => value - bounds.min[index]!) as [
    number,
    number,
    number,
  ];
  const sourceExtent = Math.max(...size);
  if (
    !Number.isFinite(sourceExtent) ||
    sourceExtent <= 0 ||
    !Number.isFinite(targetExtent) ||
    targetExtent <= 0
  ) {
    return { position: [0, 0, 0], scale: 1 };
  }

  const scale = targetExtent / sourceExtent;
  const centerX = (bounds.min[0] + bounds.max[0]) / 2;
  const centerZ = (bounds.min[2] + bounds.max[2]) / 2;
  return {
    position: [-centerX * scale, -bounds.min[1] * scale, -centerZ * scale],
    scale,
  };
};
