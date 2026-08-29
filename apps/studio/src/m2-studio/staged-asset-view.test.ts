import {
  DEFAULT_MESHY_CONFIG,
  MESHY_STAGE_CREDITS,
  assetRigEligibility,
  assetStageOffers,
  type AssetStageView,
} from "@fulcrum/domain";
import { describe, expect, it } from "vitest";

import {
  MESHY_SETTING_DOCS,
  clipOptions,
  creditLabel,
  gateCreditPlan,
  humaniseRefusal,
  meshySettingValue,
  meshySettingsLocked,
  offerNote,
  offerViews,
  previewCaption,
  providerMarkLabels,
  rigEligibilityLabel,
  rigOverrideControl,
  shouldPollStage,
  stagedCardView,
  terminalNote,
} from "./staged-asset-view.js";

const stage = (overrides: Partial<AssetStageView> = {}): AssetStageView => ({
  assetId: "world:planned-asset:warden",
  name: "Warden",
  classification: "hero",
  poseMode: "a-pose",
  status: "review",
  stage: "geometry",
  runs: [],
  decisions: [],
  rigEligible: true,
  rigEligibilityReason: "The plan marks this hero as an a-pose humanoid.",
  rigEligibilitySource: "plan",
  progress: 100,
  offers: [],
  creditsReserved: 0,
  creditsConsumed: 20,
  updatedAt: "2026-08-28T12:00:00.000Z",
  ...overrides,
});

describe("provider mark", () => {
  it.each([
    {
      mode: "live",
      imageProvider: "openai-subscription",
      expected: { imagegen: "Live ImageGen", meshy: "Meshy live" },
    },
    {
      mode: "replay",
      imageProvider: "openai-subscription",
      expected: { imagegen: "Live ImageGen", meshy: "Meshy simulated" },
    },
    {
      mode: "live",
      imageProvider: "none",
      expected: { imagegen: "ImageGen off", meshy: "Meshy live" },
    },
    {
      mode: "replay",
      imageProvider: "none",
      expected: { imagegen: "ImageGen off", meshy: "Meshy simulated" },
    },
  ] as const)("labels $mode / $imageProvider honestly", (state) => {
    expect(providerMarkLabels(state)).toEqual(state.expected);
  });
});

describe("polling", () => {
  it("polls only while a paid task is in flight", () => {
    expect(shouldPollStage(stage({ status: "running" }))).toBe(true);
    for (const status of [
      "not-started",
      "review",
      "accepted",
      "scrapped",
      "failed",
      "expired",
    ] as const)
      expect(shouldPollStage(stage({ status }))).toBe(false);
    expect(shouldPollStage(undefined)).toBe(false);
  });
});

describe("offers", () => {
  it("renders the server's labels and prices verbatim", () => {
    const offers = assetStageOffers(
      { status: "review", stage: "geometry" },
      assetRigEligibility({ classification: "hero", poseMode: "a-pose" }),
    );
    expect(offerViews(offers)).toEqual([
      {
        decision: "texture",
        label: "Texture this geometry",
        credits: 10,
        costed: true,
        disabled: false,
        reason: undefined,
        tone: "spend",
      },
      {
        decision: "retry",
        label: "Generate new geometry",
        credits: 20,
        costed: true,
        disabled: false,
        reason: undefined,
        tone: "quiet",
      },
      {
        decision: "scrap",
        label: "Scrap this asset",
        credits: 0,
        costed: false,
        disabled: false,
        reason: undefined,
        tone: "scrap",
      },
    ]);
  });

  it("omits an ineligible rig because the card carries the reason", () => {
    const offers = assetStageOffers(
      { status: "review", stage: "texture" },
      assetRigEligibility({ classification: "kit" }),
    );
    const rig = offerViews(offers).find(({ decision }) => decision === "rig");
    expect(rig).toBeUndefined();
  });

  it("gives free decisions no price and no acknowledgement", () => {
    const offers = assetStageOffers(
      { status: "review", stage: "animation" },
      assetRigEligibility({ classification: "hero", poseMode: "a-pose" }),
    );
    expect(
      offerViews(offers).map(({ decision, costed }) => [decision, costed]),
    ).toEqual([
      ["accept", false],
      ["scrap", false],
    ]);
  });

  it("warns that a retry is a new full-price task", () => {
    expect(offerNote("retry")).toContain("full");
    expect(offerNote("accept")).toBeUndefined();
  });

  it("spells a price exactly one way", () => {
    expect(creditLabel(20)).toBe("20 CR");
  });
});

describe("rig eligibility card copy", () => {
  it.each([
    ["auto-biped", true, "RIG: AUTO-DETECTED BIPED", "Not a biped"],
    ["auto-not-biped", false, "RIG: NOT DETECTED AS BIPED", "Mark as biped"],
    ["manual-biped", true, "RIG: MARKED BIPED BY YOU", "Not a biped"],
    [
      "manual-not-biped",
      false,
      "RIG: MARKED NOT BIPED BY YOU",
      "Mark as biped",
    ],
  ] as const)(
    "renders %s without inventing eligibility",
    (source, eligible, label, action) => {
      const view = stage({
        rigEligible: eligible,
        rigEligibilitySource: source,
      });
      expect(rigEligibilityLabel(view)).toBe(label);
      expect(rigOverrideControl(view).label).toBe(action);
    },
  );
});

describe("terminal states", () => {
  it("says a failed task was refunded", () => {
    const note = terminalNote(
      stage({ status: "failed", stage: "texture", creditsConsumed: 20 }),
    );
    expect(note?.kind).toBe("failed");
    expect(note?.detail).toContain("refunds");
    expect(note?.detail).toContain("20 CR");
  });

  it("says an expired result was billed and is not recoverable", () => {
    const note = terminalNote(
      stage({ status: "expired", stage: "geometry", creditsConsumed: 20 }),
    );
    expect(note?.detail).toContain("billed");
    expect(note?.detail).toContain("full-price");
  });

  it("is honest about credits spent on a scrapped asset", () => {
    expect(
      terminalNote(stage({ status: "scrapped", creditsConsumed: 30 }))?.detail,
    ).toContain("30 CR");
    expect(
      terminalNote(stage({ status: "scrapped", creditsConsumed: 0 }))?.detail,
    ).toContain("Nothing was charged");
  });

  it("has nothing to say while a lifecycle is still live", () => {
    expect(terminalNote(stage({ status: "review" }))).toBeUndefined();
    expect(terminalNote(stage({ status: "running" }))).toBeUndefined();
  });
});

describe("preview", () => {
  const preview = {
    glb: {
      artifactId: "a",
      sha256: "0".repeat(64),
      mediaType: "model/gltf-binary",
      byteLength: 10,
      uri: "/api/artifacts/a",
    },
    stage: "geometry" as const,
    round: 1,
    textured: false,
    rigged: false,
    animated: false,
  };

  it("captions what the viewer is showing", () => {
    expect(previewCaption(preview)).toBe("Geometry · round 1 · untextured");
    expect(
      previewCaption({
        ...preview,
        stage: "animation",
        round: 2,
        textured: true,
        rigged: true,
        animated: true,
      }),
    ).toBe("Animation · round 2 · textured · rigged · animated");
  });

  it("offers clips only once the preview carries them", () => {
    expect(clipOptions(preview)).toEqual([]);
    expect(clipOptions({ ...preview, rigged: true })).toEqual([]);
    expect(clipOptions({ ...preview, rigged: true, animated: true })).toEqual([
      "walk",
      "run",
      "none",
    ]);
    expect(clipOptions(undefined)).toEqual([]);
  });
});

describe("gate card", () => {
  it("offers the first paid step before anything has started", () => {
    expect(
      stagedCardView(undefined, { meshyRouted: true, geometryCredits: 20 }),
    ).toMatchObject({ action: "start", startCredits: 20 });
  });

  it("switches to opening the screen once a lifecycle exists", () => {
    expect(
      stagedCardView(stage({ status: "running", progress: 33 }), {
        meshyRouted: true,
        geometryCredits: 20,
      }),
    ).toMatchObject({
      action: "open",
      startCredits: 0,
      statusLabel: "Generating",
      detail: "Geometry · 33%",
    });
    expect(
      stagedCardView(stage({ status: "accepted", creditsConsumed: 35 }), {
        meshyRouted: true,
        geometryCredits: 20,
      }).detail,
    ).toContain("35 CR");
  });

  it("never offers Meshy to an asset that is not routed there", () => {
    expect(
      stagedCardView(undefined, { meshyRouted: false, geometryCredits: 20 }),
    ).toMatchObject({ action: "none", statusLabel: "Agent-built" });
  });

  it("badges only the cost a human is actually about to commit", () => {
    expect(
      stagedCardView(undefined, {
        meshyRouted: true,
        geometryCredits: MESHY_STAGE_CREDITS.geometry,
      }).badge,
    ).toBe("20 CR to start");
    expect(
      stagedCardView(stage({ status: "not-started", creditsConsumed: 0 }), {
        meshyRouted: true,
        geometryCredits: MESHY_STAGE_CREDITS.geometry,
      }).badge,
    ).toBe("20 CR to start");
    expect(
      stagedCardView(undefined, { meshyRouted: false, geometryCredits: 20 })
        .badge,
    ).toBe("Agent-built");
  });

  it("defers the first paid step while the plan is unapproved", () => {
    const card = stagedCardView(undefined, {
      meshyRouted: true,
      geometryCredits: 20,
      spendLock: "The asset plan needs approval before geometry can start.",
    });
    expect(card).toMatchObject({
      action: "start",
      status: "deferred",
      statusLabel: "Deferred",
      startCredits: 20,
    });
    /* The reason is the card's own visible copy, not a tooltip: the row under
       the button says why the button cannot be pressed. */
    expect(card.detail).toBe(card.blockedReason);
    expect(card.blockedReason).toContain("needs approval");
  });

  it("leaves an already-paid lifecycle alone when the plan is unapproved", () => {
    /* Unreachable in practice — nothing starts without an approval — but the
       screen behind a started asset is a record, not a spend, so a lock must
       never take its way in away. */
    expect(
      stagedCardView(stage({ status: "review", creditsConsumed: 20 }), {
        meshyRouted: true,
        geometryCredits: 20,
        spendLock: "The asset plan needs approval before geometry can start.",
      }),
    ).toMatchObject({ action: "open", blockedReason: undefined });
  });

  it("never defers an asset that was never going to Meshy", () => {
    expect(
      stagedCardView(undefined, {
        meshyRouted: false,
        geometryCredits: 20,
        spendLock: "The asset plan needs approval before geometry can start.",
      }),
    ).toMatchObject({ action: "none", blockedReason: undefined });
  });

  it("drops the badge once the strip below it reports real credits", () => {
    for (const status of [
      "running",
      "review",
      "accepted",
      "scrapped",
      "failed",
      "expired",
    ] as const)
      expect(
        stagedCardView(stage({ status, creditsConsumed: 30 }), {
          meshyRouted: true,
          geometryCredits: 20,
        }).badge,
      ).toBeUndefined();
  });
});

describe("gate credit plan", () => {
  const routed = (overrides: Partial<AssetStageView> = {}) => ({
    meshyRouted: true,
    stage: stage(overrides),
  });

  it("quotes geometry only before anything has been spent", () => {
    const plan = gateCreditPlan([
      { meshyRouted: true, stage: undefined },
      { meshyRouted: true, stage: undefined },
      routed({ status: "not-started", creditsConsumed: 0 }),
    ]);
    expect(plan).toMatchObject({
      meshyAssetCount: 3,
      unstartedCount: 3,
      creditsToStart: 3 * MESHY_STAGE_CREDITS.geometry,
      creditsConsumed: 0,
      headline: "60 CR",
      detail: "to start all geometry · texture and rig are decided per asset",
    });
    /* The old lump sum (geometry + texture per asset) must not reappear. */
    expect(plan.creditsToStart).not.toBe(
      3 * (MESHY_STAGE_CREDITS.geometry + MESHY_STAGE_CREDITS.texture),
    );
  });

  it("splits what is left to start from what is already consumed", () => {
    expect(
      gateCreditPlan([
        routed({ status: "review", stage: "texture", creditsConsumed: 60 }),
        routed({ status: "accepted", stage: "animation", creditsConsumed: 38 }),
        { meshyRouted: true, stage: undefined },
      ]),
    ).toMatchObject({
      meshyAssetCount: 3,
      unstartedCount: 1,
      creditsToStart: 20,
      creditsConsumed: 98,
      headline: "20 CR",
      detail: "to start 1 more · 98 CR consumed so far",
    });
  });

  it("reports the real total once every asset has started", () => {
    expect(
      gateCreditPlan([
        routed({ status: "accepted", stage: "texture", creditsConsumed: 30 }),
        routed({ status: "accepted", stage: "animation", creditsConsumed: 38 }),
      ]),
    ).toMatchObject({
      unstartedCount: 0,
      creditsToStart: 0,
      creditsConsumed: 68,
      headline: "68 CR",
      detail: "consumed · later stages are decided per asset",
    });
  });

  it("never prices an agent-built asset", () => {
    const plan = gateCreditPlan([
      routed({ status: "review", creditsConsumed: 20 }),
      { meshyRouted: true, stage: undefined },
      { meshyRouted: false, stage: undefined },
      { meshyRouted: false, stage: undefined },
    ]);
    expect(plan).toMatchObject({
      meshyAssetCount: 2,
      unstartedCount: 1,
      creditsToStart: 20,
      creditsConsumed: 20,
    });
    expect(
      gateCreditPlan([{ meshyRouted: false, stage: undefined }]),
    ).toMatchObject({
      meshyAssetCount: 0,
      creditsToStart: 0,
      creditsConsumed: 0,
    });
  });
});

describe("meshy settings", () => {
  it("never quotes a price in a tooltip", () => {
    for (const doc of MESHY_SETTING_DOCS) {
      expect(doc.tooltip).not.toMatch(/credit|\bCR\b|\$|price|cost/i);
      /* Two or three full sentences, per the tooltip contract. */
      const sentences = doc.tooltip
        .split(/(?<=\.)\s+/)
        .filter((part) => part.trim().length > 0);
      expect(sentences.length).toBeGreaterThanOrEqual(2);
      expect(sentences.length).toBeLessThanOrEqual(3);
    }
  });

  it("documents every setting the schema carries", () => {
    expect(MESHY_SETTING_DOCS.map(({ key }) => key).sort()).toEqual(
      Object.keys({
        ...DEFAULT_MESHY_CONFIG,
        realWorldHeightMeters: undefined,
      }).sort(),
    );
  });

  it("renders values a human can read", () => {
    expect(meshySettingValue(DEFAULT_MESHY_CONFIG, "targetPolycount")).toBe(
      "10,000 tris",
    );
    expect(meshySettingValue(DEFAULT_MESHY_CONFIG, "textureResolution")).toBe(
      "4K",
    );
    expect(meshySettingValue(DEFAULT_MESHY_CONFIG, "poseMode")).toBe("A-pose");
    expect(
      meshySettingValue(DEFAULT_MESHY_CONFIG, "realWorldHeightMeters"),
    ).toBe("Meshy default");
    expect(
      meshySettingValue(
        { ...DEFAULT_MESHY_CONFIG, realWorldHeightMeters: 1.8 },
        "realWorldHeightMeters",
      ),
    ).toBe("1.8 m");
  });

  it("locks the section exactly while a task is in flight", () => {
    expect(meshySettingsLocked(undefined)).toBe(false);
    expect(meshySettingsLocked({ a: stage({ status: "review" }) })).toBe(false);
    expect(
      meshySettingsLocked({
        a: stage({ status: "review" }),
        b: stage({ status: "running" }),
      }),
    ).toBe(true);
  });

  it("names the asset a refusal blames instead of quoting its id", () => {
    const stages = { a: stage({ status: "running" }) };
    expect(
      humaniseRefusal(
        "Meshy settings are locked while world:planned-asset:warden has a texture task in flight.",
        stages,
      ),
    ).toBe(
      "Meshy settings are locked while Warden has a texture task in flight.",
    );
  });

  it("leaves a refusal it cannot decode exactly as the server wrote it", () => {
    expect(humaniseRefusal("The world is offline.", undefined)).toBe(
      "The world is offline.",
    );
  });
});
