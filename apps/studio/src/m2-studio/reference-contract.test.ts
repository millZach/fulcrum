import { describe, expect, it } from "vitest";

import type { PlannedAsset } from "@fulcrum/domain";

import {
  CARDINAL_ROLE_FOR_SLOT,
  MESHY_4K_TEXTURE_CREDITS,
  MESHY_GEOMETRY_PREVIEW_CREDITS,
  MESHY_MODEL,
  REFERENCE_TEMPLATES,
  SHEET_CELL_ORDER,
  STYLE_CAPSULE_MAX_CHARACTERS,
  SUBJECT_PROMPT_MAX_CHARACTERS,
  VIEW_INSTRUCTIONS,
  assertValidReferenceUploadSelection,
  buildSheetInstruction,
  buildStyleCapsule,
  classifyAsset,
  composeImagegenPrompt,
  isMeshyRouted,
  referenceTemplateFor,
  slotForCardinalRole,
  transitionAssetResolution,
  type AssetClassification,
  type AssetResolution,
  type ReferenceImage,
  type ReferenceViewSlot,
  type StyleContext,
} from "./reference-contract.js";

const plannedAsset = (
  classification: PlannedAsset["classification"],
  overrides: Partial<PlannedAsset> = {},
): PlannedAsset =>
  ({
    assetId: `asset-${classification}`,
    name: `${classification} asset`,
    classification,
    rationale: "It must read clearly during play.",
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
    dependsOnAssetIds: [],
    ...(classification === "procedural"
      ? {
          procedure: {
            generatorId: "fulcrum.scatter.v1",
            parameters: { density: 0.5, avoidLane: true },
          },
        }
      : {}),
    acceptanceCriteria: ["The silhouette reads at gameplay distance."],
    ...overrides,
  }) as PlannedAsset;

const styleContext: StyleContext = {
  palette: [
    { name: "Moss", hex: "#526b45", role: "base" },
    { name: "Amber", hex: "#d69a45", role: "accent" },
    { name: "Ink", hex: "#192126", role: "shadow" },
  ],
  lighting: "soft overcast daylight",
  atmosphere: "humid air with faint pollen",
  materials: ["aged brass", "painted wood"],
  shapeLanguage: "rounded organic masses over a hard mechanical core",
};

/* The shape of the live "Pursuing Greenhouse Organism" project that produced
   the 1,800-character prompt this split replaced: six named palette entries
   and multi-sentence lighting and atmosphere paragraphs. */
const verboseStyleContext: StyleContext = {
  palette: [
    { name: "Canopy Black", hex: "#07110d", role: "dominant shadow" },
    { name: "Chlorophyll Deep", hex: "#173f2b", role: "vegetation mass" },
    { name: "Glasshouse Pale", hex: "#c8d8c4", role: "structural glass" },
    { name: "Spore Amber", hex: "#e0a548", role: "interactive accent" },
    { name: "Rot Violet", hex: "#5a3663", role: "threat tell" },
    { name: "Mineral Grey", hex: "#8b9490", role: "neutral filler" },
  ],
  lighting:
    "Light enters from a single high canopy break and falls off fast. Fill light is bounced, never direct. Interactive surfaces catch a warm rim so they read before anything else does.",
  atmosphere:
    "Humid, close, and slightly rotten. Volumetric haze thickens with distance. Spore drift moves constantly at the edge of frame and never settles.",
  materials: ["wet glass", "fibrous plant matter", "corroded steel"],
  shapeLanguage:
    "Swelling organic bulk pushing against rigid orthogonal framing. Nothing symmetric.",
};

const image = (slot: ReferenceImage["slot"]): ReferenceImage => ({
  slot,
  uri: `blob:${slot}`,
  source: "generated",
});

describe("Images-stage reference contract", () => {
  it("defines a non-empty instruction for every reference view slot", () => {
    const slots: ReferenceViewSlot[] = [
      "front",
      "back",
      "left",
      "right",
      "playable-area-wide-shot",
      "component-sheet",
      "front-three-quarter",
      "left-three-quarter",
      "back-three-quarter",
      "right-three-quarter",
      "mood-reference",
    ];

    expect(Object.keys(VIEW_INSTRUCTIONS).sort()).toEqual([...slots].sort());
    for (const slot of slots) {
      expect(VIEW_INSTRUCTIONS[slot].trim()).not.toBe("");
    }
  });

  it("maps hero views to the four sheet cells in slot order", () => {
    const instruction = buildSheetInstruction(
      REFERENCE_TEMPLATES.hero.requiredViewSlots,
      {
        front: "Front",
        back: "Back",
        left: "Left",
        right: "Right",
        "playable-area-wide-shot": "Playable area",
        "component-sheet": "Component sheet",
        "front-three-quarter": "Front three-quarter",
        "left-three-quarter": "Left three-quarter",
        "back-three-quarter": "Back three-quarter",
        "right-three-quarter": "Right three-quarter",
        "mood-reference": "Mood reference",
      },
    );

    expect(SHEET_CELL_ORDER).toEqual([
      "top-left",
      "top-right",
      "bottom-left",
      "bottom-right",
    ]);
    expect(instruction).toContain(
      `Top-left cell: Front view — ${VIEW_INSTRUCTIONS.front}`,
    );
    expect(instruction).toContain(
      `Top-right cell: Back view — ${VIEW_INSTRUCTIONS.back}`,
    );
    expect(instruction).toContain(
      `Bottom-left cell: Left view — ${VIEW_INSTRUCTIONS.left}`,
    );
    expect(instruction).toContain(
      `Bottom-right cell: Right view — ${VIEW_INSTRUCTIONS.right}`,
    );
  });

  it("maps turntable views to the same four sheet cells", () => {
    const labels: Record<ReferenceViewSlot, string> = {
      front: "Front",
      back: "Back",
      left: "Left",
      right: "Right",
      "playable-area-wide-shot": "Playable area",
      "component-sheet": "Component sheet",
      "front-three-quarter": "Front three-quarter",
      "left-three-quarter": "Left three-quarter",
      "back-three-quarter": "Back three-quarter",
      "right-three-quarter": "Right three-quarter",
      "mood-reference": "Mood reference",
    };
    const instruction = buildSheetInstruction(
      REFERENCE_TEMPLATES.prop.requiredViewSlots,
      labels,
      "front-three-quarter",
    );

    expect(instruction).toContain("Top-left cell: Front three-quarter view");
    expect(instruction).toContain("Top-right cell: Left three-quarter view");
    expect(instruction).toContain("Bottom-left cell: Back three-quarter view");
    expect(instruction).toContain(
      "Bottom-right cell: Right three-quarter view",
    );
    expect(instruction).toContain(
      "Image 1 is the canonical Front three-quarter view in the top-left cell",
    );
    expect(instruction.length).toBeLessThanOrEqual(1_200);
  });

  it("maps the live planned-asset vocabulary to UI classifications", () => {
    expect(classifyAsset(plannedAsset("hero", { poseMode: "a-pose" }))).toBe(
      "hero",
    );
    expect(
      classifyAsset(
        plannedAsset("hero", {
          name: "Playable arena",
          rationale: "The environment defines every navigation lane.",
        }),
      ),
    ).toBe("environment");
    expect(
      classifyAsset(
        plannedAsset("hero", {
          name: "Hero prop signal device",
          rationale: "The object carries the core interaction.",
        }),
      ),
    ).toBe("prop");
    expect(classifyAsset(plannedAsset("kit"))).toBe("modular-kit");
    expect(classifyAsset(plannedAsset("procedural"))).toBe(
      "procedural-reference",
    );
    expect(classifyAsset(plannedAsset("functional"))).toBe(
      "procedural-reference",
    );
  });

  it("defines the locked view slots, upload behavior, and generation paths", () => {
    expect(REFERENCE_TEMPLATES.hero.requiredViewSlots).toEqual([
      "front",
      "back",
      "left",
      "right",
    ]);
    expect(REFERENCE_TEMPLATES.hero.uploadRules.singleUpload).toEqual({
      canonicalSlot: "front",
      deriveRemainingViews: true,
    });
    expect(REFERENCE_TEMPLATES.hero.uploadRules.allowMultiple).toBe(false);
    expect(REFERENCE_TEMPLATES.prop.requiredViewSlots).toHaveLength(4);
    expect(
      REFERENCE_TEMPLATES["procedural-reference"].allowedGenerationPaths,
    ).toEqual(["procedural"]);
    expect(
      REFERENCE_TEMPLATES["procedural-reference"].buildMeshyTextPrompt,
    ).toBeUndefined();
  });

  it("rejects a multi-file reference upload selection", () => {
    expect(() =>
      assertValidReferenceUploadSelection(
        REFERENCE_TEMPLATES.hero.uploadRules,
        [{ type: "image/png" }, { type: "image/webp" }],
      ),
    ).toThrow("Select exactly one reference image");
  });

  it("builds a concise subject brief that names the asset, role, and constraints", () => {
    const asset = plannedAsset("hero", {
      name: "Caretaker",
      poseMode: "t-pose",
      rationale:
        "The caretaker is the player's only ally. It must be recognizable from behind at forty meters.",
      acceptanceCriteria: [
        "The silhouette reads at gameplay distance.",
        "The lantern arm stays visible from every side.",
        "Fabric folds do not break the outline.",
      ],
    });

    const prompt = referenceTemplateFor(asset).buildSubjectPrompt(asset);

    expect(prompt).toContain("Caretaker");
    expect(prompt).toContain("front, back, left, right");
    expect(prompt).toContain("t-pose");
    expect(prompt).toContain("Role: The caretaker is the player's only ally.");
    expect(prompt).toContain(
      "Must hold: The silhouette reads at gameplay distance; The lantern arm stays visible from every side.",
    );
    // The third criterion is dropped: two constraints are the ceiling.
    expect(prompt).not.toContain("Fabric folds");
    expect(prompt.length).toBeLessThanOrEqual(SUBJECT_PROMPT_MAX_CHARACTERS);
  });

  it("keeps every suggested subject prompt free of color and mood content", () => {
    const classifications: AssetClassification[] = [
      "hero",
      "environment",
      "modular-kit",
      "prop",
      "procedural-reference",
    ];

    for (const classification of classifications) {
      const prompt = REFERENCE_TEMPLATES[classification].buildSubjectPrompt(
        plannedAsset(
          classification === "modular-kit"
            ? "kit"
            : classification === "procedural-reference"
              ? "procedural"
              : "hero",
          { name: `${classification} subject` },
        ),
      );

      expect(prompt.length).toBeLessThanOrEqual(SUBJECT_PROMPT_MAX_CHARACTERS);
      expect(prompt).not.toMatch(/#[0-9a-fA-F]{6}/);
      expect(prompt.toLowerCase()).not.toContain("palette");
      expect(prompt.toLowerCase()).not.toContain("lighting");
      expect(prompt.toLowerCase()).not.toContain("atmosphere");
      expect(prompt.toLowerCase()).not.toContain("acceptance criteria");
    }
  });

  it("condenses a verbose visual bible into one short style capsule", () => {
    const capsule = buildStyleCapsule(verboseStyleContext);

    expect(capsule).toBe(
      "Palette: Canopy Black #07110d (dominant shadow), Chlorophyll Deep #173f2b (vegetation mass), Glasshouse Pale #c8d8c4 (structural glass). " +
        "Lighting: Light enters from a single high canopy break and falls off fast. " +
        "Atmosphere: Humid, close, and slightly rotten. " +
        "Shape language: Swelling organic bulk pushing against rigid orthogonal framing.",
    );
    expect(capsule.length).toBeLessThanOrEqual(STYLE_CAPSULE_MAX_CHARACTERS);
    // Three colors is the ceiling; the tail of the palette is dropped.
    expect(capsule).not.toContain("Rot Violet");
  });

  it("never lets a capsule overrun its budget", () => {
    const capsule = buildStyleCapsule({
      ...verboseStyleContext,
      palette: verboseStyleContext.palette.map((token) => ({
        ...token,
        role: `${token.role} across every readable surface in the shipped build`,
      })),
    });

    expect(capsule.length).toBeLessThanOrEqual(STYLE_CAPSULE_MAX_CHARACTERS);
  });

  it("appends the capsule to suggested and human-typed subjects alike", () => {
    const asset = plannedAsset("hero", { name: "Caretaker" });
    const capsule = buildStyleCapsule(styleContext);
    const suggested = referenceTemplateFor(asset).buildSubjectPrompt(asset);
    const typed = "A stooped lantern-bearer made of woven roots.";

    expect(composeImagegenPrompt(suggested, capsule)).toBe(
      `${suggested}\n\n${capsule}`,
    );
    expect(composeImagegenPrompt(typed, capsule)).toBe(
      `${typed}\n\n${capsule}`,
    );
    // Composing twice is the double-injection failure mode; the subject half
    // never carries mood content, so a single append is the whole contract.
    expect(
      composeImagegenPrompt(suggested, capsule).split(capsule),
    ).toHaveLength(2);
  });

  it("sends the subject alone when no capsule exists", () => {
    expect(composeImagegenPrompt("  A woven-root lantern-bearer.  ", "")).toBe(
      "A woven-root lantern-bearer.",
    );
  });

  it("builds the direct Meshy text prompt without reference-view instructions", () => {
    const asset = plannedAsset("hero", {
      name: "Signal relay prop",
      rationale: "This device opens the exit gate.",
    });
    const buildPrompt = referenceTemplateFor(asset).buildMeshyTextPrompt;

    expect(buildPrompt).toBeDefined();
    const prompt = buildPrompt!(asset, styleContext);
    expect(prompt).toContain("production-ready 3D prop");
    expect(prompt).toContain("Signal relay prop");
    expect(prompt).toContain("humid air with faint pollen");
    expect(prompt).not.toContain("turntable");
  });

  /* Both figures are charged by a staged route — geometry by stages/start,
     texture by the texture decision — which is what earns them the right to be
     printed. The Images stage itself charges nothing and names no number. */
  it("names only the two credit figures a staged route actually charges", () => {
    expect(MESHY_MODEL).toBe("meshy-6");
    expect(MESHY_GEOMETRY_PREVIEW_CREDITS).toBe(20);
    expect(MESHY_4K_TEXTURE_CREDITS).toBe(10);
  });

  it("routes hero and kit work to Meshy and leaves the rest to the agent", () => {
    expect(isMeshyRouted(plannedAsset("hero"))).toBe(true);
    expect(isMeshyRouted(plannedAsset("kit"))).toBe(true);
    expect(isMeshyRouted(plannedAsset("procedural"))).toBe(false);
    expect(isMeshyRouted(plannedAsset("functional"))).toBe(false);
  });

  /* Meshy's multi-image endpoint knows four orthographic directions, so every
     template's slots have to land in that vocabulary, uniquely, with a front. */
  it("maps every template's slots onto distinct cardinal roles", () => {
    for (const template of Object.values(REFERENCE_TEMPLATES)) {
      const roles = template.requiredViewSlots.map(
        (slot) => CARDINAL_ROLE_FOR_SLOT[slot],
      );
      expect(new Set(roles).size).toBe(roles.length);
      expect(roles).toContain("front");
      for (const slot of template.requiredViewSlots)
        expect(
          slotForCardinalRole(template, CARDINAL_ROLE_FOR_SLOT[slot]),
        ).toBe(slot);
    }
    expect(CARDINAL_ROLE_FOR_SLOT["front-three-quarter"]).toBe("front");
    expect(CARDINAL_ROLE_FOR_SLOT["component-sheet"]).toBe("front");
    expect(
      slotForCardinalRole(REFERENCE_TEMPLATES["modular-kit"], "left"),
    ).toBeUndefined();
  });

  /* Approving is free: it persists what Meshy will be shown and spends
     nothing, so there is no acknowledgment step to price. */
  it("resolves an image path as soon as the reference set is complete", () => {
    const asset = plannedAsset("hero", { poseMode: "a-pose" });
    const unresolved: AssetResolution = { status: "unresolved" };
    const inProgress = transitionAssetResolution(asset, unresolved, {
      type: "start",
      path: "image-refs",
    });

    expect(inProgress).toEqual({
      status: "in-progress",
      path: "image-refs",
    });
    const resolved = transitionAssetResolution(asset, inProgress, {
      type: "approve-references",
      references: [
        image("front"),
        image("back"),
        image("left"),
        image("right"),
      ],
    });

    expect(resolved).toEqual({
      status: "resolved",
      kind: "approved-references",
      path: "image-refs",
      references: [
        image("front"),
        image("back"),
        image("left"),
        image("right"),
      ],
      meshyModel: "meshy-6",
    });
    expect(Object.keys(resolved)).not.toContain("acknowledgedCreditCost");
  });

  it("rejects one image URI reused across distinct required views", () => {
    const asset = plannedAsset("hero", { poseMode: "a-pose" });
    const duplicateUri = "blob:one-image";

    expect(() =>
      transitionAssetResolution(
        asset,
        { status: "in-progress", path: "image-refs" },
        {
          type: "approve-references",
          references: [
            { ...image("front"), uri: duplicateUri },
            { ...image("back"), uri: duplicateUri },
            { ...image("left"), uri: duplicateUri },
            { ...image("right"), uri: duplicateUri },
          ],
        },
      ),
    ).toThrow("unique image URI");
  });

  it("records the edited prompt for text-to-3D without pricing it", () => {
    const asset = plannedAsset("kit");
    const inProgress = transitionAssetResolution(
      asset,
      { status: "unresolved" },
      { type: "start", path: "text-to-3d" },
    );

    expect(
      transitionAssetResolution(asset, inProgress, {
        type: "approve-text-prompt",
        prompt: "  Build   a modular greenhouse kit.  ",
      }),
    ).toEqual({
      status: "resolved",
      kind: "approved-text-prompt",
      path: "text-to-3d",
      prompt: "Build a modular greenhouse kit.",
      meshyModel: "meshy-6",
    });
  });

  it("refuses to re-approve an asset that is already resolved", () => {
    const asset = plannedAsset("hero", { poseMode: "a-pose" });
    const references = [
      image("front"),
      image("back"),
      image("left"),
      image("right"),
    ];
    const resolved = transitionAssetResolution(
      asset,
      { status: "in-progress", path: "image-refs" },
      { type: "approve-references", references },
    );

    expect(() =>
      transitionAssetResolution(asset, resolved, {
        type: "approve-references",
        references,
      }),
    ).toThrow("cannot transition again");
  });

  it("resolves procedural work with one approved agent reference", () => {
    const asset = plannedAsset("procedural");
    const inProgress = transitionAssetResolution(
      asset,
      { status: "unresolved" },
      { type: "start", path: "procedural" },
    );

    expect(
      transitionAssetResolution(asset, inProgress, {
        type: "approve-procedural-reference",
        reference: image("mood-reference"),
      }),
    ).toEqual({
      status: "resolved",
      kind: "approved-procedural-reference",
      path: "procedural",
      reference: image("mood-reference"),
    });
  });

  it("rejects disallowed paths, incomplete sets, and mismatched events", () => {
    const procedural = plannedAsset("functional");
    expect(() =>
      transitionAssetResolution(
        procedural,
        { status: "unresolved" },
        { type: "start", path: "text-to-3d" },
      ),
    ).toThrow("do not allow the text-to-3d path");

    const hero = plannedAsset("hero", { poseMode: "a-pose" });
    expect(() =>
      transitionAssetResolution(
        hero,
        { status: "in-progress", path: "image-refs" },
        {
          type: "approve-references",
          references: [image("front"), image("back")],
        },
      ),
    ).toThrow("fill every required view exactly once");
    expect(() =>
      transitionAssetResolution(
        hero,
        { status: "in-progress", path: "text-to-3d" },
        {
          type: "approve-references",
          references: [
            image("front"),
            image("back"),
            image("left"),
            image("right"),
          ],
        },
      ),
    ).toThrow("does not match the text-to-3d path");
  });
});
