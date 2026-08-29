/**
 * Pure derivations for the staged Meshy review screens.
 *
 * The orchestrator already decides what a human may do next — `offers[]` is
 * the whole CTA list, prices included — so nothing here re-derives a rule or
 * invents a price. It only turns one `AssetStageView` into the words, tones
 * and polling decision the React screens render, which keeps every one of
 * those choices testable without a DOM.
 */
import {
  MESHY_STAGE_CREDITS,
  type AssetStageOffer,
  type AssetStagePreview,
  type AssetStageView,
  type MeshyConfig,
  type MeshyStage,
  type ProjectSnapshot,
} from "@fulcrum/domain";

export type ProviderMarkLabels = {
  imagegen: "ImageGen off" | "Live ImageGen";
  meshy: "Meshy simulated" | "Meshy live";
};

export const providerMarkLabels = (
  state: Pick<ProjectSnapshot["state"], "mode" | "imageProvider">,
): ProviderMarkLabels => ({
  imagegen: state.imageProvider === "none" ? "ImageGen off" : "Live ImageGen",
  meshy: state.mode === "replay" ? "Meshy simulated" : "Meshy live",
});

/** What the progress screen says while a paid task is in flight. */
export const STAGE_RUNNING_COPY: Record<
  MeshyStage,
  { headline: string; detail: string }
> = {
  geometry: {
    headline: "Casting geometry…",
    detail:
      "Meshy is building the untextured form. Nothing else is charged until you decide what happens to it.",
  },
  texture: {
    headline: "Painting textures…",
    detail:
      "Meshy is baking the colour and material maps onto the geometry you kept.",
  },
  rig: {
    headline: "Binding the rig…",
    detail:
      "Meshy is fitting a humanoid skeleton and weighting the mesh to it.",
  },
  animation: {
    headline: "Teaching it to move…",
    detail: "Meshy is retargeting a walk and a run onto the rig you accepted.",
  },
};

/** The stage word used in headings and captions. */
export const STAGE_LABELS: Record<MeshyStage, string> = {
  geometry: "Geometry",
  texture: "Texture",
  rig: "Rig",
  animation: "Animation",
};

/**
 * The only reason to keep hitting `stages/poll`. A poll is a read of a task
 * that is already paid for, so this is safe on a timer — but the moment the
 * task settles the timer has nothing left to learn, and a review screen that
 * keeps polling would refetch the whole snapshot forever.
 */
export const shouldPollStage = (
  stage: Pick<AssetStageView, "status"> | undefined,
): boolean => stage?.status === "running";

export type StagedOfferTone = "accept" | "spend" | "quiet" | "scrap";

export type StagedOfferView = {
  decision: AssetStageOffer["decision"];
  /** The server's own label, verbatim. */
  label: string;
  credits: number;
  /** `credits > 0`, so the button carries a price and opens the ack gate. */
  costed: boolean;
  disabled: boolean;
  reason: string | undefined;
  tone: StagedOfferTone;
};

const OFFER_TONES: Record<AssetStageOffer["decision"], StagedOfferTone> = {
  accept: "accept",
  texture: "spend",
  retexture: "quiet",
  rig: "spend",
  animate: "spend",
  retry: "quiet",
  scrap: "scrap",
};

/** A note under a costed CTA that is honest about what the money buys. */
const OFFER_NOTES: Partial<Record<AssetStageOffer["decision"], string>> = {
  retry: "Starts a brand-new task at the full geometry price.",
  retexture: "Keeps this geometry and pays for a second texture pass.",
  rig: "Requires a textured humanoid in a symmetric pose.",
  animate: "Adds a walk and a run clip to the rig you kept.",
};

export const offerNote = (
  decision: AssetStageOffer["decision"],
): string | undefined => OFFER_NOTES[decision];

/** Every offer the snapshot returned, in the order the snapshot returned it. */
export const offerViews = (offers: AssetStageOffer[]): StagedOfferView[] =>
  offers.map((offer) => ({
    decision: offer.decision,
    label: offer.label,
    credits: offer.credits,
    costed: offer.credits > 0,
    disabled: !offer.available,
    reason: offer.unavailableReason,
    tone: OFFER_TONES[offer.decision],
  }));

/** The quiet micro-caps explanation shown on every character gate card. */
export const rigEligibilityLabel = (
  stage: Pick<AssetStageView, "rigEligible" | "rigEligibilitySource">,
): string => {
  switch (stage.rigEligibilitySource) {
    case "manual-biped":
      return "RIG: MARKED BIPED BY YOU";
    case "manual-not-biped":
      return "RIG: MARKED NOT BIPED BY YOU";
    case "auto-biped":
      return "RIG: AUTO-DETECTED BIPED";
    case "plan":
      return "RIG: PLANNED AS BIPED";
    case "auto-not-biped":
    case "classification":
    case "none":
    default:
      return stage.rigEligible
        ? "RIG: PLANNED AS BIPED"
        : "RIG: NOT DETECTED AS BIPED";
  }
};

/** The control always states the result of pressing it. */
export const rigOverrideControl = (
  stage: Pick<AssetStageView, "rigEligible" | "rigEligibilitySource">,
): { biped: boolean; label: "Mark as biped" | "Not a biped" } => {
  const markedBiped =
    stage.rigEligibilitySource === "manual-biped" ||
    (stage.rigEligibilitySource !== "manual-not-biped" && stage.rigEligible);
  return markedBiped
    ? { biped: false, label: "Not a biped" }
    : { biped: true, label: "Mark as biped" };
};

/** "10 CR" — the one spelling of a price in this flow. */
export const creditLabel = (credits: number): string => `${credits} CR`;

export type StagedTerminalNote = {
  kind: "failed" | "expired" | "accepted" | "scrapped";
  headline: string;
  detail: string;
};

/**
 * The honest sentence for a lifecycle that is over — or, for `failed` and
 * `expired`, for one that stopped in a way the human did not choose. Meshy
 * refunds a failed task and bills an expired one, and a screen that blurred
 * the two would make a retry look free when it is not.
 */
export const terminalNote = (
  stage: Pick<
    AssetStageView,
    "status" | "stage" | "creditsConsumed" | "terminalReason"
  >,
): StagedTerminalNote | undefined => {
  const stageWord = STAGE_LABELS[stage.stage].toLowerCase();
  switch (stage.status) {
    case "failed":
      return {
        kind: "failed",
        headline: `The ${stageWord} task failed.`,
        detail: `Meshy refunds a failed task, so the ${stageWord} credits were returned and this asset has consumed ${creditLabel(stage.creditsConsumed)} in total. Retrying starts a new task.`,
      };
    case "expired":
      return {
        kind: "expired",
        headline: `Meshy deleted this ${stageWord} result.`,
        detail: `The task succeeded and was billed, then Meshy removed the file before Fulcrum could download it. It is not recoverable, so a retry is a new full-price task. ${creditLabel(stage.creditsConsumed)} consumed so far.`,
      };
    case "accepted":
      return {
        kind: "accepted",
        headline: "Accepted.",
        detail: `This model is the one the build uses. ${creditLabel(stage.creditsConsumed)} consumed across every stage it took to get here.`,
      };
    case "scrapped":
      return {
        kind: "scrapped",
        headline: "Scrapped.",
        detail:
          stage.creditsConsumed > 0
            ? `${creditLabel(stage.creditsConsumed)} was spent before this asset was scrapped. Scrapping does not refund it.`
            : "Nothing was charged for this asset.",
      };
    default:
      return undefined;
  }
};

/** "Geometry · round 2 · untextured" under the viewer. */
export const previewCaption = (preview: AssetStagePreview): string => {
  const traits = [
    preview.textured ? "textured" : "untextured",
    ...(preview.rigged ? ["rigged"] : []),
    ...(preview.animated ? ["animated"] : []),
  ];
  return `${STAGE_LABELS[preview.stage]} · round ${preview.round} · ${traits.join(" · ")}`;
};

export type StagedClip = "walk" | "run" | "none";

/** The clip toggle only earns its place once a preview actually carries clips. */
export const clipOptions = (
  preview: AssetStagePreview | undefined,
): StagedClip[] => (preview?.animated ? ["walk", "run", "none"] : []);

export type StagedCardAction = "start" | "open" | "none";

export type StagedCardView = {
  statusLabel: string;
  /** Uppercase key for `data-stage-status`, so CSS can tone the card. */
  status: AssetStageView["status"] | "unavailable" | "deferred";
  action: StagedCardAction;
  /**
   * Why the start CTA renders disabled — the refusal this button would earn,
   * said before it is pressed. An enabled button whose only outcome is a
   * server refusal is the thing this field exists to prevent.
   */
  blockedReason: string | undefined;
  /** Credits the start CTA is about to authorize. Zero once started. */
  startCredits: number;
  /**
   * The card's own price line. Geometry is the only cost a human commits to
   * by opening this asset — texture, rig and animation are separate decisions
   * taken later — so that is the most the badge may ever promise. Once a
   * lifecycle exists the badge goes away entirely: the staged strip directly
   * below it already reports real consumed credits, and a second number here
   * could only repeat or contradict it.
   */
  badge: string | undefined;
  detail: string;
};

const STATUS_LABELS: Record<AssetStageView["status"], string> = {
  "not-started": "Not started",
  running: "Generating",
  review: "Awaiting review",
  accepted: "Accepted",
  scrapped: "Scrapped",
  failed: "Failed",
  expired: "Expired",
};

/**
 * What one gate card says about its 3D lifecycle. `meshyRouted` is the gate's
 * own routing call: a procedural reference never goes to Meshy, so it gets no
 * CTA rather than a disabled one. `spendLock` is the server's standing refusal
 * — an unapproved asset plan — which only ever reaches a card that has not
 * started: a lifecycle that exists was already paid for, and its screen is a
 * record rather than a spend.
 */
export const stagedCardView = (
  stage: AssetStageView | undefined,
  options: {
    meshyRouted: boolean;
    geometryCredits: number;
    spendLock?: string | undefined;
  },
): StagedCardView => {
  if (!options.meshyRouted)
    return {
      statusLabel: "Agent-built",
      status: "unavailable",
      action: "none",
      blockedReason: undefined,
      startCredits: 0,
      badge: "Agent-built",
      detail: "This asset never goes to Meshy.",
    };
  if (!stage || stage.status === "not-started")
    return options.spendLock
      ? {
          statusLabel: "Deferred",
          status: "deferred",
          action: "start",
          blockedReason: options.spendLock,
          startCredits: options.geometryCredits,
          badge: `${creditLabel(options.geometryCredits)} to start`,
          detail: options.spendLock,
        }
      : {
          statusLabel: STATUS_LABELS["not-started"],
          status: "not-started",
          action: "start",
          blockedReason: undefined,
          startCredits: options.geometryCredits,
          badge: `${creditLabel(options.geometryCredits)} to start`,
          detail: "Geometry is the first paid step.",
        };
  return {
    statusLabel: STATUS_LABELS[stage.status],
    status: stage.status,
    action: "open",
    blockedReason: undefined,
    startCredits: 0,
    badge: undefined,
    detail:
      stage.status === "running"
        ? `${STAGE_LABELS[stage.stage]} · ${stage.progress}%`
        : `${STAGE_LABELS[stage.stage]} · ${creditLabel(stage.creditsConsumed)} consumed`,
  };
};

/* ---------------------------- Gate credit header --------------------------- */

/** One row of the gate's inventory, reduced to what a price can be read off. */
export type GateCreditEntry = {
  /** False for an agent-built or procedural asset, which is never priced. */
  meshyRouted: boolean;
  stage: AssetStageView | undefined;
};

export type GateCreditPlan = {
  /** Assets this gate would ever send to Meshy. Zero hides the whole chip. */
  meshyAssetCount: number;
  /** Meshy-routed assets that have not authorized geometry yet. */
  unstartedCount: number;
  /** Geometry for everything unstarted — the only committed number here. */
  creditsToStart: number;
  /** What the started assets have already spent, across every stage. */
  creditsConsumed: number;
  /** The big mono figure. */
  headline: string;
  /** The sentence under it, without the wallet's remaining balance. */
  detail: string;
};

const hasLifecycle = (stage: AssetStageView | undefined): boolean =>
  stage !== undefined && stage.status !== "not-started";

/**
 * What the whole plan costs, said honestly. There is no such thing as a price
 * "to resolve all assets" under the staged flow: geometry is the only stage a
 * human commits to up front, and every stage after it is a separate decision
 * taken one asset at a time. So this quotes a floor — geometry for what has
 * not started — plus what the started assets have actually consumed, and never
 * a total that pretends the later decisions are already made.
 */
export const gateCreditPlan = (
  entries: readonly GateCreditEntry[],
): GateCreditPlan => {
  const routed = entries.filter((entry) => entry.meshyRouted);
  const unstartedCount = routed.filter(
    (entry) => !hasLifecycle(entry.stage),
  ).length;
  const creditsToStart = unstartedCount * MESHY_STAGE_CREDITS.geometry;
  const creditsConsumed = routed.reduce(
    (total, entry) => total + (entry.stage?.creditsConsumed ?? 0),
    0,
  );

  const detail =
    unstartedCount === 0
      ? "consumed · later stages are decided per asset"
      : creditsConsumed === 0
        ? "to start all geometry · texture and rig are decided per asset"
        : `to start ${unstartedCount} more · ${creditLabel(creditsConsumed)} consumed so far`;

  return {
    meshyAssetCount: routed.length,
    unstartedCount,
    creditsToStart,
    creditsConsumed,
    headline: creditLabel(
      unstartedCount === 0 ? creditsConsumed : creditsToStart,
    ),
    detail,
  };
};

/* ------------------------------ Meshy settings ----------------------------- */

export type MeshySettingKey =
  | "modelVersion"
  | "topology"
  | "targetPolycount"
  | "textureResolution"
  | "poseMode"
  | "realWorldHeightMeters"
  | "deliveredPolycountPreset"
  | "removeLighting"
  | "imageEnhancement";

export type MeshySettingDoc = {
  key: MeshySettingKey;
  label: string;
  /**
   * Two or three full sentences: what the setting does, and when you would
   * change it. Never a price — a tooltip that quotes credits puts the cost
   * somewhere the user is not spending. Costs live in the layout, at the
   * button that spends them.
   */
  tooltip: string;
};

export const MESHY_SETTING_DOCS: MeshySettingDoc[] = [
  {
    key: "modelVersion",
    label: "Model version",
    tooltip:
      "The exact Meshy generation model every task in this world is sent to. Fulcrum pins it instead of tracking Meshy's floating latest tag, because a silent repoint changes both what the mesh looks like and what it bills. You would only change this deliberately, after checking the new model's rate card and re-approving what it produces.",
  },
  {
    key: "topology",
    label: "Topology",
    tooltip:
      "Whether Meshy returns triangles or quads. Fulcrum asks for triangles because that is what every runtime engine consumes and it is the only topology Meshy's remesher is reliable at. Quads are worth asking for only when a human is going to open the mesh in a modelling tool and edit its loops by hand.",
  },
  {
    key: "targetPolycount",
    label: "Requested polycount",
    tooltip:
      "How many triangles Meshy is asked to produce. There is a floor here on purpose: Meshy's remesher decides which detail to throw away, and at low targets it removes silhouette rather than density, so a cheap-looking request comes back as a broken form. Raise it when an asset is a hero the camera gets close to; leave it at the floor otherwise and reduce downstream instead.",
  },
  {
    key: "textureResolution",
    label: "Texture resolution",
    tooltip:
      "The pixel size of the base colour and material maps Meshy bakes. 4K is the default because Meshy charges the same for it as for 2K, so choosing less buys nothing. Drop to 2K only when something downstream — an engine import limit, or a memory budget you have actually measured — needs the smaller maps.",
  },
  {
    key: "poseMode",
    label: "Pose mode",
    tooltip:
      "The stance Meshy is asked to build humanoid characters in. Rigging needs limbs held clear of the body and symmetric left to right, which is what A-pose and T-pose both give; anything else and the auto-rigger mis-fits the skeleton. A-pose sits closer to a natural idle and deforms better at the shoulder, so it is the default unless a downstream tool insists on T-pose.",
  },
  {
    key: "realWorldHeightMeters",
    label: "Real-world height",
    tooltip:
      "How tall the delivered model is in metres, measured from an origin at its feet. Setting it means an asset arrives at the scale your world already uses instead of at Meshy's 1.7 m assumption, so a door and the character walking through it agree without a fixup. Leave it empty when an asset has no meaningful real-world size, such as a piece of terrain.",
  },
  {
    key: "deliveredPolycountPreset",
    label: "Delivered detail",
    tooltip:
      "The triangle budget the finished asset is meant to hit in the game, which is a different number from what Meshy is asked for. Fulcrum never decimates the mesh itself, so this is intent recorded for whatever tool does the reduction later. Set it by how the asset is used: background dressing, ordinary staged prop, or a hero the player looks at up close.",
  },
  {
    key: "removeLighting",
    label: "Remove baked lighting",
    tooltip:
      "Strips the highlights and shadows Meshy's texture pass paints into the base colour map. Leaving them in double-lights the asset once your own scene lighting is on it, which is what makes generated models look flat and dirty in engine. Turn it off only if you want the reference image's lighting preserved as art, and the asset is never lit at runtime.",
  },
  {
    key: "imageEnhancement",
    label: "Image enhancement",
    tooltip:
      "Lets Meshy clean up the reference images before it reads them — denoising, sharpening and lifting contrast on the subject. It helps most when references came from a generator that left soft or noisy edges, which is the usual case here. Turn it off when a reference is already crisp and you want Meshy reading exactly the pixels you approved.",
  },
];

/** The rendered value of one setting, so the section can be read as a list. */
export const meshySettingValue = (
  config: MeshyConfig,
  key: MeshySettingKey,
): string => {
  switch (key) {
    case "modelVersion":
      return config.modelVersion;
    case "topology":
      return config.topology;
    case "targetPolycount":
      return `${config.targetPolycount.toLocaleString("en-US")} tris`;
    case "textureResolution":
      return config.textureResolution.toUpperCase();
    case "poseMode":
      return config.poseMode === "a-pose" ? "A-pose" : "T-pose";
    case "realWorldHeightMeters":
      return config.realWorldHeightMeters === undefined
        ? "Meshy default"
        : `${config.realWorldHeightMeters} m`;
    case "deliveredPolycountPreset":
      return config.deliveredPolycountPreset;
    case "removeLighting":
      return config.removeLighting ? "On" : "Off";
    case "imageEnhancement":
      return config.imageEnhancement ? "On" : "Off";
  }
};

/** True while any asset has a paid task in flight — the server refuses edits then. */
export const meshySettingsLocked = (
  stages: Record<string, AssetStageView> | undefined,
): boolean =>
  Object.values(stages ?? {}).some((stage) => stage.status === "running");

/**
 * A server refusal, shown as written but with asset ids swapped for the names
 * on the cards. The server names an asset the only way it can — by its id —
 * and a settings sheet that answers "locked while
 * <uuid>:planned-asset:gameplay-anchor" reads like a stack trace. Only the
 * identifier is substituted; the sentence the server chose is left alone.
 */
export const humaniseRefusal = (
  detail: string,
  stages: Record<string, AssetStageView> | undefined,
): string => {
  let text = detail;
  for (const stage of Object.values(stages ?? {}))
    text = text.split(stage.assetId).join(stage.name);
  return text;
};
