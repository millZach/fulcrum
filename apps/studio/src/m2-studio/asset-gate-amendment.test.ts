import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { PlannedAsset, ProjectSnapshot } from "@fulcrum/domain";

import { AssetGatePrototype } from "./AssetGatePrototype.js";

const ancestor = (revisionId: string, kind: string) => ({
  revisionId,
  sha256: revisionId.padEnd(64, "a").slice(0, 64),
  kind,
});

const character = (assetId: string, name: string): PlannedAsset => ({
  assetId,
  name,
  classification: "hero",
  rationale: "A readable character actor for the staged gate.",
  sourceRefs: {
    gameDesignSpec: ancestor("gds-1", "game-design-spec"),
    conceptSet: ancestor("concept-set-1", "concept-set"),
    conceptSlots: [
      {
        slotId: "gameplay-anchor",
        concept: ancestor("concept-1", "m1-concept"),
      },
    ],
  },
  dependsOnAssetIds: [],
  acceptanceCriteria: ["Readable at gameplay distance."],
});

const project = (): ProjectSnapshot =>
  ({
    state: {
      projectId: "gate-amendment-project",
      mode: "replay",
      assetProvider: "meshy",
      imageProvider: "openai-subscription",
      meshyCreditBudget: 200,
      meshyCreditsReserved: 0,
      meshyCreditsConsumed: 0,
    },
    briefText: "Gate amendment view fixture.",
    assetPlan: {
      assets: [
        character("gate-amendment-project:planned-asset:boss", "Boss"),
        character(
          "gate-amendment-project:planned-asset:character-amendment-scout",
          "Character Scout Slot",
        ),
        character(
          "gate-amendment-project:planned-asset:character-amendment-rival",
          "Character Rival Slot",
        ),
      ],
    },
    assetStages: {},
  }) as ProjectSnapshot;

describe("asset gate section amendments", () => {
  it("renders_one_section_chat_per_gate_section_and_the_new_slots", () => {
    const html = renderToStaticMarkup(
      createElement(AssetGatePrototype, { project: project() }),
    );

    expect(html.match(/class="agp-section-chat"/g)).toHaveLength(5);
    for (const section of [
      "hero",
      "environment",
      "modular-kit",
      "prop",
      "procedural-reference",
    ])
      expect(html).toContain(`id="asset-plan-amend-${section}"`);
    expect(html).toContain("Character Scout Slot");
    expect(html).toContain("Character Rival Slot");
    expect(html).toContain("No slots in this section yet.");
  });
});
