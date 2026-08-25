import { describe, expect, it } from "vitest";

import type {
  AssetClassification,
  AssetPlan,
  PlannedAsset,
} from "@fulcrum/domain";

import {
  assetPlanSnapshotIsExact,
  layoutAssetPlanGraph,
} from "./asset-plan-graph.js";

const classifications: AssetClassification[] = [
  "hero",
  "kit",
  "procedural",
  "functional",
];

const plannedAsset = (
  assetId: string,
  name: string,
  classification: AssetClassification,
  dependsOnAssetIds: string[] = [],
): PlannedAsset =>
  ({
    assetId,
    name,
    classification,
    rationale: `${name} has a clear production purpose.`,
    sourceRefs: {
      gameDesignSpec: {
        revisionId: "gds-r1",
        sha256: "a".repeat(64),
        kind: "game-design-spec",
      },
      conceptSet: {
        revisionId: "concept-set-r1",
        sha256: "b".repeat(64),
        kind: "concept-set",
      },
      conceptSlots: [],
    },
    dependsOnAssetIds,
    ...(classification === "procedural"
      ? { procedure: { generatorId: "scatter", parameters: { count: 8 } } }
      : {}),
    acceptanceCriteria: [`${name} reads at gameplay distance.`],
  }) as PlannedAsset;

const plan = (assets: PlannedAsset[]): AssetPlan =>
  ({ planId: "plan-r1", assets }) as AssetPlan;

describe("asset-plan graph layout", () => {
  it("places every dependency in an earlier topological column", () => {
    const value = plan([
      plannedAsset("hero", "Caretaker", "hero"),
      plannedAsset("kit", "Greenhouse kit", "kit", ["hero"]),
      plannedAsset("fog", "Fog volume", "procedural", ["kit"]),
      plannedAsset("door", "Exit door", "functional", ["hero", "fog"]),
    ]);

    const layout = layoutAssetPlanGraph(value);
    const nodes = new Map(layout.nodes.map((node) => [node.assetId, node]));

    for (const asset of value.assets) {
      for (const dependencyId of asset.dependsOnAssetIds) {
        expect(nodes.get(dependencyId)!.rank).toBeLessThan(
          nodes.get(asset.assetId)!.rank,
        );
        expect(nodes.get(dependencyId)!.x).toBeLessThan(
          nodes.get(asset.assetId)!.x,
        );
      }
    }
    expect(layout.edges).toHaveLength(4);
    expect(layout.edges.every(({ path }) => path.startsWith("M "))).toBe(true);
  });

  it("groups nodes into stable classification lanes and sorts lane ties by name then id", () => {
    const value = plan([
      plannedAsset("functional", "Exit door", "functional"),
      plannedAsset("kit-z", "Wall panel", "kit"),
      plannedAsset("hero", "Caretaker", "hero"),
      plannedAsset("kit-a", "Wall panel", "kit"),
      plannedAsset("fog", "Fog volume", "procedural"),
    ]);

    const layout = layoutAssetPlanGraph(value);
    const byClass = Object.fromEntries(
      classifications.map((classification) => [
        classification,
        layout.nodes.filter((node) => node.classification === classification),
      ]),
    ) as Record<AssetClassification, typeof layout.nodes>;

    expect(Math.max(...byClass.hero.map(({ y }) => y))).toBeLessThan(
      Math.min(...byClass.kit.map(({ y }) => y)),
    );
    expect(Math.max(...byClass.kit.map(({ y }) => y))).toBeLessThan(
      Math.min(...byClass.procedural.map(({ y }) => y)),
    );
    expect(Math.max(...byClass.procedural.map(({ y }) => y))).toBeLessThan(
      Math.min(...byClass.functional.map(({ y }) => y)),
    );
    expect(byClass.kit.map(({ assetId }) => assetId)).toEqual([
      "kit-a",
      "kit-z",
    ]);
  });

  it("is identical for the same graph regardless of input ordering", () => {
    const assets = [
      plannedAsset("hero", "Caretaker", "hero"),
      plannedAsset("kit", "Greenhouse kit", "kit", ["hero"]),
      plannedAsset("fog", "Fog volume", "procedural", ["hero"]),
      plannedAsset("door", "Exit door", "functional", ["kit", "fog"]),
    ];

    expect(layoutAssetPlanGraph(plan(assets))).toEqual(
      layoutAssetPlanGraph(plan([...assets].reverse())),
    );
  });

  it("disables plan decisions when the resolved revision or source hashes disagree", () => {
    const planRevision = {
      revisionId: "asset-plan-r1",
      artifact: { sha256: "d".repeat(64) },
    };
    const sources = {
      gameDesignSpec: {
        revisionId: "gds-r1",
        artifact: { sha256: "a".repeat(64) },
      },
      conceptSet: {
        revisionId: "concept-set-r1",
        artifact: { sha256: "b".repeat(64) },
      },
    };
    const resolved = {
      provenance: {
        revisionId: "asset-plan-r1",
        sourceArtifactHashes: ["a".repeat(64), "b".repeat(64)],
      },
    };

    expect(
      assetPlanSnapshotIsExact({
        state: { assetPlan: planRevision, ...sources },
        assetPlan: resolved,
      }),
    ).toBe(true);
    expect(
      assetPlanSnapshotIsExact({
        state: { assetPlan: planRevision, ...sources },
        assetPlan: {
          provenance: { ...resolved.provenance, revisionId: "asset-plan-r0" },
        },
      }),
    ).toBe(false);
    expect(
      assetPlanSnapshotIsExact({
        state: {
          assetPlan: planRevision,
          ...sources,
          conceptSet: {
            ...sources.conceptSet,
            artifact: { sha256: "c".repeat(64) },
          },
        },
        assetPlan: resolved,
      }),
    ).toBe(false);
  });
});
