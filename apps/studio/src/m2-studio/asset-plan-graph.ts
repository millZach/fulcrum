import type {
  AssetClassification,
  AssetPlan,
  PlannedAsset,
} from "@fulcrum/domain";

export type AssetPlanGraphLayout = {
  width: number;
  height: number;
  nodes: Array<{
    assetId: string;
    classification: AssetClassification;
    rank: number;
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
  edges: Array<{
    fromAssetId: string;
    toAssetId: string;
    path: string;
  }>;
};

export const ASSET_PLAN_LANES: readonly AssetClassification[] = [
  "hero",
  "kit",
  "procedural",
  "functional",
];

const NODE_WIDTH = 224;
const NODE_HEIGHT = 78;
const COLUMN_GAP = 112;
const ROW_GAP = 18;
const LANE_GAP = 28;
const GRAPH_LEFT = 116;
const GRAPH_TOP = 38;
const GRAPH_RIGHT = 48;
const GRAPH_BOTTOM = 30;

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const compareAssets = (left: PlannedAsset, right: PlannedAsset): number =>
  compareText(left.name, right.name) ||
  compareText(left.assetId, right.assetId);

type ExactPlanSnapshot = {
  state: {
    assetPlan?:
      { revisionId: string; artifact: { sha256: string } } | undefined;
    gameDesignSpec?:
      { revisionId: string; artifact: { sha256: string } } | undefined;
    conceptSet?:
      { revisionId: string; artifact: { sha256: string } } | undefined;
  };
  assetPlan?:
    | {
        provenance: { revisionId: string; sourceArtifactHashes: string[] };
      }
    | undefined;
};

export const assetPlanSnapshotIsExact = (
  snapshot: ExactPlanSnapshot,
): boolean => {
  const { assetPlan, gameDesignSpec, conceptSet } = snapshot.state;
  if (!assetPlan || !gameDesignSpec || !conceptSet || !snapshot.assetPlan)
    return false;
  if (snapshot.assetPlan.provenance.revisionId !== assetPlan.revisionId)
    return false;
  const hashes = new Set(snapshot.assetPlan.provenance.sourceArtifactHashes);
  return (
    hashes.has(gameDesignSpec.artifact.sha256) &&
    hashes.has(conceptSet.artifact.sha256)
  );
};

const ranksFor = (assets: readonly PlannedAsset[]): Map<string, number> => {
  const byId = new Map(assets.map((asset) => [asset.assetId, asset]));
  const indegree = new Map(
    assets.map((asset) => [
      asset.assetId,
      asset.dependsOnAssetIds.filter((dependencyId) => byId.has(dependencyId))
        .length,
    ]),
  );
  const dependents = new Map(
    assets.map((asset) => [asset.assetId, [] as PlannedAsset[]]),
  );
  for (const asset of assets) {
    for (const dependencyId of asset.dependsOnAssetIds) {
      dependents.get(dependencyId)?.push(asset);
    }
  }
  for (const values of dependents.values()) values.sort(compareAssets);

  const ready = assets
    .filter((asset) => indegree.get(asset.assetId) === 0)
    .sort(compareAssets);
  const ranks = new Map(assets.map((asset) => [asset.assetId, 0]));
  const visited = new Set<string>();

  while (ready.length > 0) {
    const asset = ready.shift()!;
    visited.add(asset.assetId);
    for (const dependent of dependents.get(asset.assetId) ?? []) {
      ranks.set(
        dependent.assetId,
        Math.max(
          ranks.get(dependent.assetId) ?? 0,
          (ranks.get(asset.assetId) ?? 0) + 1,
        ),
      );
      const nextDegree = (indegree.get(dependent.assetId) ?? 0) - 1;
      indegree.set(dependent.assetId, nextDegree);
      if (nextDegree === 0) {
        ready.push(dependent);
        ready.sort(compareAssets);
      }
    }
  }

  // AssetPlanSchema rejects cycles. Keeping a deterministic fallback here
  // makes the layout total for stale or partially loaded documents.
  for (const asset of assets.filter(({ assetId }) => !visited.has(assetId))) {
    ranks.set(asset.assetId, 0);
  }
  return ranks;
};

export const layoutAssetPlanGraph = (plan: AssetPlan): AssetPlanGraphLayout => {
  const assets = [...plan.assets];
  const ranks = ranksFor(assets);
  const maxRank = Math.max(0, ...ranks.values());
  const nodes: AssetPlanGraphLayout["nodes"] = [];
  let laneTop = GRAPH_TOP;

  for (const classification of ASSET_PLAN_LANES) {
    const laneAssets = assets
      .filter((asset) => asset.classification === classification)
      .sort(
        (left, right) =>
          (ranks.get(left.assetId) ?? 0) - (ranks.get(right.assetId) ?? 0) ||
          compareAssets(left, right),
      );
    const laneHeight = Math.max(
      NODE_HEIGHT,
      laneAssets.length * NODE_HEIGHT +
        Math.max(0, laneAssets.length - 1) * ROW_GAP,
    );
    laneAssets.forEach((asset, index) => {
      nodes.push({
        assetId: asset.assetId,
        classification,
        rank: ranks.get(asset.assetId) ?? 0,
        x:
          GRAPH_LEFT +
          (ranks.get(asset.assetId) ?? 0) * (NODE_WIDTH + COLUMN_GAP),
        y: laneTop + index * (NODE_HEIGHT + ROW_GAP),
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      });
    });
    laneTop += laneHeight + LANE_GAP;
  }

  const nodeById = new Map(nodes.map((node) => [node.assetId, node]));
  const edges = assets
    .flatMap((asset) =>
      asset.dependsOnAssetIds.map((dependencyId) => ({
        fromAssetId: dependencyId,
        toAssetId: asset.assetId,
      })),
    )
    .filter(
      (edge) => nodeById.has(edge.fromAssetId) && nodeById.has(edge.toAssetId),
    )
    .sort(
      (left, right) =>
        compareText(left.fromAssetId, right.fromAssetId) ||
        compareText(left.toAssetId, right.toAssetId),
    )
    .map(({ fromAssetId, toAssetId }) => {
      const from = nodeById.get(fromAssetId)!;
      const to = nodeById.get(toAssetId)!;
      const startX = from.x + from.width;
      const startY = from.y + from.height / 2;
      const endX = to.x;
      const endY = to.y + to.height / 2;
      const controlOffset = Math.max(42, (endX - startX) / 2);
      return {
        fromAssetId,
        toAssetId,
        path: `M ${startX} ${startY} C ${startX + controlOffset} ${startY}, ${endX - controlOffset} ${endY}, ${endX} ${endY}`,
      };
    });

  return {
    width:
      GRAPH_LEFT +
      (maxRank + 1) * NODE_WIDTH +
      maxRank * COLUMN_GAP +
      GRAPH_RIGHT,
    height: laneTop - LANE_GAP + GRAPH_BOTTOM,
    nodes,
    edges,
  };
};
