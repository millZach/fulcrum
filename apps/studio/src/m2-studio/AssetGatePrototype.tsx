// Throwaway prototype for the single agreed M2 Images-stage flow.
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
} from "react";

import type {
  AssetReferenceSet,
  AssetStageView,
  PlannedAsset,
  ProjectSnapshot,
} from "@fulcrum/domain";

import { api, isApiError } from "../api.js";
import {
  RigEligibilityControl,
  StagedAssetScreen,
} from "./StagedAssetScreen.js";
import {
  creditLabel,
  gateCreditPlan,
  providerMarkLabels,
  stagedSubmitFailureHint,
  stagedCardView,
  type GateCreditPlan,
} from "./staged-asset-view.js";
import {
  CARDINAL_ROLE_FOR_SLOT,
  MESHY_4K_TEXTURE_CREDITS,
  MESHY_GEOMETRY_PREVIEW_CREDITS,
  MESHY_MODEL,
  SHEET_CELL_ORDER,
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
  type GenerationPath,
  type ReferenceImage,
  type ReferenceViewSlot,
  type StyleContext,
} from "./reference-contract.js";
import "./asset-gate-prototype.css";

type UiStatus = "unresolved" | "in-progress" | "resolved";

type SlotGenerationState =
  | { status: "pending"; requestId: number; message: string }
  | { status: "error"; requestId: number; message: string };

type AssetUiState = {
  status: UiStatus;
  path: GenerationPath;
  imagePrompt: string;
  meshyPrompt: string;
  references: Partial<Record<ReferenceViewSlot, ReferenceImage>>;
  slotGeneration: Partial<Record<ReferenceViewSlot, SlotGenerationState>>;
  canonicalReferenceDataUrl: string | undefined;
  revision: number;
  uploadError: string;
  resolutionLabel?: string;
};

type PrototypeImageGenerateResponse = {
  imageUrl: string;
  sha256: string;
  model: string;
  costUsd: number;
  prompt: string;
};

type PrototypeImageStoreResponse = {
  imageUrl: string;
  sha256: string;
};

const CLASSIFICATION_ORDER: AssetClassification[] = [
  "hero",
  "environment",
  "modular-kit",
  "prop",
  "procedural-reference",
];

const CLASSIFICATION_LABELS: Record<AssetClassification, string> = {
  hero: "Characters",
  environment: "Environments",
  "modular-kit": "Modular kits",
  prop: "Props",
  "procedural-reference": "Procedural references",
};

const SLOT_LABELS: Record<ReferenceViewSlot, string> = {
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

const fallbackStyleContext: StyleContext = {
  palette: [
    { name: "Moss", hex: "#60705a", role: "world base" },
    { name: "Amber", hex: "#e2a84f", role: "interactive accent" },
    { name: "Ink", hex: "#182521", role: "shadow" },
  ],
  lighting: "soft directional daylight with readable silhouettes",
  atmosphere: "grounded, tactile, and calm",
  materials: ["painted metal", "weathered wood", "matte fabric"],
  shapeLanguage: "chunky rounded forms with one clear reading axis",
};

const styleContextFor = (project: ProjectSnapshot): StyleContext =>
  project.visualBible
    ? {
        palette: project.visualBible.palette,
        lighting: project.visualBible.lighting,
        atmosphere: project.visualBible.atmosphere,
        materials: project.visualBible.materials,
        shapeLanguage: project.visualBible.shapeLanguage,
      }
    : fallbackStyleContext;

const initialStates = (
  project: ProjectSnapshot,
  assets: PlannedAsset[],
): Record<string, AssetUiState> => {
  const styleContext = styleContextFor(project);
  return Object.fromEntries(
    assets.map((asset) => {
      const template = referenceTemplateFor(asset);
      const defaultPath = template.allowedGenerationPaths[0]!;
      return [
        asset.assetId,
        {
          status: "unresolved",
          path: defaultPath,
          imagePrompt: template.buildSubjectPrompt(asset),
          meshyPrompt:
            template.buildMeshyTextPrompt?.(asset, styleContext) ?? "",
          references: {},
          slotGeneration: {},
          canonicalReferenceDataUrl: undefined,
          revision: 0,
          uploadError: "",
        } satisfies AssetUiState,
      ];
    }),
  );
};

const statusLabel = (state: AssetUiState): string => {
  if (state.status === "resolved") return "Resolved";
  if (state.status === "in-progress") return "In progress";
  return "Unresolved";
};

const pathLabel = (path: GenerationPath): string => {
  if (path === "image-refs") return "Image references";
  if (path === "text-to-3d") return "Direct Meshy text";
  return "Procedural reference";
};

/** A sentence is the floor for a prompt that spends credits on its own. */
const MIN_MESHY_PROMPT_CHARACTERS = 40;

/** The orchestrator caps a composed ImageGen request prompt at 4,000
 *  characters; the style capsule spends up to 400 of them plus a separator. */
const MAX_SUBJECT_PROMPT_INPUT = 3_000;

const meshyPromptReady = (prompt: string): boolean =>
  prompt.trim().length >= MIN_MESHY_PROMPT_CHARACTERS;

const remainingMeshyCredits = (
  project: ProjectSnapshot,
): number | undefined => {
  const budget = project.state.meshyCreditBudget;
  if (budget === undefined) return undefined;
  return (
    budget -
    (project.state.meshyCreditsConsumed ?? 0) -
    (project.state.meshyCreditsReserved ?? 0)
  );
};

type FooterStatus =
  | "unresolved"
  | "generating"
  | "needs-retry"
  | "not-saved"
  | "ready"
  | "resolved";

const FOOTER_STATUS_LABELS: Record<FooterStatus, string> = {
  unresolved: "Unresolved",
  generating: "Generating",
  "needs-retry": "Needs retry",
  /* A refused approval has to read as a refusal. The note beside this chip is
     the orchestrator's own reason, and the asset stays unresolved. */
  "not-saved": "Not saved",
  ready: "Ready to send",
  resolved: "Resolved",
};

type SlotView = "empty" | "pending" | "error" | "filled";

const slotViewFor = (
  reference: ReferenceImage | undefined,
  generation: SlotGenerationState | undefined,
): SlotView => {
  if (generation?.status === "pending") return "pending";
  if (generation?.status === "error") return "error";
  return reference ? "filled" : "empty";
};

const MAX_REFERENCE_UPLOAD_BYTES = 8 * 1024 * 1024;

const readFileAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("The uploaded image could not be read."));
    });
    reader.addEventListener("error", () =>
      reject(new Error("The uploaded image could not be read.")),
    );
    reader.readAsDataURL(file);
  });

const readBlobAsDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("The sliced image could not be encoded."));
    });
    reader.addEventListener("error", () =>
      reject(new Error("The sliced image could not be encoded.")),
    );
    reader.readAsDataURL(blob);
  });

/** Reference URIs are blob:, prototype-imagegen, or artifact URLs. Approving
 *  has to hand the orchestrator the bytes themselves, so every one of them is
 *  read back and re-encoded the same way. */
const fetchAsDataUrl = async (uri: string): Promise<string> => {
  const response = await fetch(uri);
  if (!response.ok)
    throw new Error(
      `A reference image could not be read (${response.status}).`,
    );
  return await readBlobAsDataUrl(await response.blob());
};

const canvasPngDataUrl = async (canvas: HTMLCanvasElement): Promise<string> => {
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => {
      if (result) resolve(result);
      else reject(new Error("The reference sheet could not be sliced."));
    }, "image/png");
  });
  return readBlobAsDataUrl(blob);
};

const sliceReferenceSheet = async (imageUrl: string): Promise<string[]> => {
  const response = await fetch(imageUrl);
  if (!response.ok)
    throw new Error(
      `The generated sheet could not be loaded (${response.status}).`,
    );
  const image = await createImageBitmap(await response.blob());
  try {
    const cellWidth = image.width / 2;
    const cellHeight = image.height / 2;
    if (cellWidth <= 0 || cellHeight <= 0)
      throw new Error("The generated sheet has invalid dimensions.");

    return await Promise.all(
      SHEET_CELL_ORDER.map(async (_cell, index) => {
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(cellWidth);
        canvas.height = Math.ceil(cellHeight);
        const context = canvas.getContext("2d");
        if (!context)
          throw new Error("The browser could not prepare the sheet slicer.");
        context.drawImage(
          image,
          (index % 2) * cellWidth,
          Math.floor(index / 2) * cellHeight,
          cellWidth,
          cellHeight,
          0,
          0,
          canvas.width,
          canvas.height,
        );
        return canvasPngDataUrl(canvas);
      }),
    );
  } finally {
    image.close();
  }
};

const runWithConcurrency = async <Item,>(
  items: readonly Item[],
  concurrency: number,
  task: (item: Item) => Promise<void>,
): Promise<void> => {
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      if (item !== undefined) await task(item);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
};

const referencesFor = (
  state: AssetUiState,
  slots: readonly ReferenceViewSlot[],
): ReferenceImage[] =>
  slots.flatMap((slot) => {
    const reference = state.references[slot];
    return reference ? [reference] : [];
  });

/** What a resolved card says under its name. No credit figure: approving
 *  spends nothing, and the staged card owns everything that does. */
const resolutionLabelFor = (path: GenerationPath, views: number): string => {
  if (path === "procedural") return "Approved agent reference";
  if (path === "text-to-3d") return "Text prompt approved";
  return `Approved references · ${views} ${views === 1 ? "view" : "views"}`;
};

/**
 * Turns a persisted reference set back into the slots this asset's template
 * renders. Returns the same object when nothing would change, so the
 * hydration effect settles after one pass instead of looping.
 */
const hydrateApprovedSet = (
  state: AssetUiState,
  asset: PlannedAsset,
  set: AssetReferenceSet,
): AssetUiState => {
  const template = referenceTemplateFor(asset);
  const references: Partial<Record<ReferenceViewSlot, ReferenceImage>> = {};
  for (const view of set.views) {
    const slot = slotForCardinalRole(template, view.role);
    if (slot)
      references[slot] = { slot, uri: view.image.uri, source: view.source };
  }
  const path: GenerationPath = template.allowedGenerationPaths.includes(
    "image-refs",
  )
    ? "image-refs"
    : template.allowedGenerationPaths[0]!;
  const resolutionLabel = resolutionLabelFor(
    path,
    Object.keys(references).length,
  );
  const settled =
    state.status === "resolved" &&
    state.path === path &&
    state.resolutionLabel === resolutionLabel &&
    template.requiredViewSlots.every(
      (slot) => state.references[slot]?.uri === references[slot]?.uri,
    );
  return settled
    ? state
    : {
        ...state,
        status: "resolved",
        path,
        references,
        slotGeneration: {},
        uploadError: "",
        resolutionLabel,
      };
};

function PrototypeMark({ state }: { state: ProjectSnapshot["state"] }) {
  const labels = providerMarkLabels(state);
  return (
    <div className="agp-prototype-mark" data-mode={state.mode}>
      <strong>Prototype</strong>
      <span>{labels.imagegen}</span>
      <i aria-hidden="true" />
      <span>{labels.meshy}</span>
    </div>
  );
}

function ProgressCount({
  resolved,
  total,
}: {
  resolved: number;
  total: number;
}) {
  const percentage = total === 0 ? 0 : Math.round((resolved / total) * 100);
  return (
    <div
      aria-label={resolved + " of " + total + " assets resolved"}
      className="agp-progress"
    >
      <span>
        <strong>{resolved + " of " + total}</strong>
        <small>assets resolved</small>
      </span>
      <i aria-hidden="true">
        <b style={{ width: percentage + "%" }} />
      </i>
    </div>
  );
}

function CreditPlan({
  plan,
  remainingCredits,
}: {
  plan: GateCreditPlan;
  remainingCredits: number | undefined;
}) {
  const overBudget =
    remainingCredits !== undefined && plan.creditsToStart > remainingCredits;
  return (
    <div className="agp-credit-plan" data-over={overBudget || undefined}>
      <strong>{plan.headline}</strong>
      <small>
        {plan.detail}
        {remainingCredits === undefined
          ? ""
          : " · " + remainingCredits + " remaining"}
      </small>
    </div>
  );
}

function EmptyThumbnail({
  classification,
}: {
  classification: AssetClassification;
}) {
  return (
    <span className="agp-empty-thumbnail" data-classification={classification}>
      <i aria-hidden="true" />
      <small>No reference yet</small>
    </span>
  );
}

function SectionAmendmentChat({
  busy,
  disabled,
  error,
  label,
  request,
  section,
  onChange,
  onSubmit,
}: {
  busy: boolean;
  disabled: boolean;
  error: string | undefined;
  label: string;
  request: string;
  section: AssetClassification;
  onChange: (request: string) => void;
  onSubmit: () => void;
}) {
  const inputId = `asset-plan-amend-${section}`;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit();
  };
  return (
    <div className="agp-section-chat">
      <form onSubmit={submit}>
        <label htmlFor={inputId}>Amend section</label>
        <input
          aria-describedby={error ? `${inputId}-error` : undefined}
          disabled={disabled}
          id={inputId}
          maxLength={1_000}
          onChange={(event) => onChange(event.target.value)}
          placeholder={`Add or change ${label.toLowerCase()}…`}
          type="text"
          value={request}
        />
        <button
          disabled={disabled || request.trim().length === 0}
          type="submit"
        >
          {busy ? "Working…" : "Send"}
        </button>
      </form>
      {error && (
        <p id={`${inputId}-error`} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function Overview({
  assets,
  projectState,
  states,
  stages,
  starting,
  resolvedCount,
  creditPlan,
  remainingCredits,
  onOpen,
  onOpenStage,
  onOverrideRig,
  onStart,
  overridingRig,
  amendmentErrors,
  amendmentRequests,
  amendingSection,
  onAmend,
  onAmendmentRequest,
}: {
  assets: PlannedAsset[];
  projectState: ProjectSnapshot["state"];
  states: Record<string, AssetUiState>;
  stages: Record<string, AssetStageView>;
  /** The asset whose first geometry task is being authorized right now. */
  starting: string | null;
  resolvedCount: number;
  creditPlan: GateCreditPlan;
  remainingCredits: number | undefined;
  onOpen: (assetId: string) => void;
  onOpenStage: (assetId: string) => void;
  onOverrideRig: (assetId: string, biped: boolean) => void;
  onStart: (assetId: string) => void;
  overridingRig: string | null;
  amendmentErrors: Partial<Record<AssetClassification, string>>;
  amendmentRequests: Partial<Record<AssetClassification, string>>;
  amendingSection: AssetClassification | null;
  onAmend: (section: AssetClassification) => void;
  onAmendmentRequest: (section: AssetClassification, request: string) => void;
}) {
  const groups = CLASSIFICATION_ORDER.map((classification) => ({
    classification,
    assets: assets.filter((asset) => classifyAsset(asset) === classification),
  }));

  return (
    <section className="agp-overview agp-surface">
      <header className="agp-overview-head">
        <div className="agp-title-block">
          <span className="agp-kicker">Stage 4 · Images</span>
          <h1>Resolve the visual inputs.</h1>
          <p>
            Choose how each asset gets its visual direction. Free references
            stay editable until you approve them.
          </p>
        </div>
        <div className="agp-head-meta">
          <PrototypeMark state={projectState} />
          <ProgressCount resolved={resolvedCount} total={assets.length} />
          {creditPlan.meshyAssetCount > 0 && (
            <CreditPlan plan={creditPlan} remainingCredits={remainingCredits} />
          )}
        </div>
      </header>

      <main className="agp-inventory">
        {groups.map(({ classification, assets: groupedAssets }) => (
          <section className="agp-group" key={classification}>
            <header>
              <div className="agp-group-heading">
                <h2>{CLASSIFICATION_LABELS[classification]}</h2>
                <span>
                  {groupedAssets.length}{" "}
                  {groupedAssets.length === 1 ? "asset" : "assets"}
                </span>
              </div>
              <SectionAmendmentChat
                busy={amendingSection === classification}
                disabled={amendingSection !== null}
                error={amendmentErrors[classification]}
                label={CLASSIFICATION_LABELS[classification]}
                onChange={(request) =>
                  onAmendmentRequest(classification, request)
                }
                onSubmit={() => onAmend(classification)}
                request={amendmentRequests[classification] ?? ""}
                section={classification}
              />
            </header>
            {groupedAssets.length === 0 ? (
              <p className="agp-group-empty">No slots in this section yet.</p>
            ) : (
              <div className="agp-node-grid">
                {groupedAssets.map((asset) => {
                  const state = states[asset.assetId];
                  if (!state) return null;
                  const firstReference = referencesFor(
                    state,
                    referenceTemplateFor(asset).requiredViewSlots,
                  )[0];
                  // The group heading already names the procedural route, so the
                  // subtitle only earns its line when it says something new.
                  const subtitle =
                    state.status === "resolved"
                      ? state.resolutionLabel
                      : state.path === "procedural"
                        ? undefined
                        : pathLabel(state.path);
                  const stage = stages[asset.assetId];
                  const card = stagedCardView(stage, {
                    meshyRouted: isMeshyRouted(asset),
                    geometryCredits: MESHY_GEOMETRY_PREVIEW_CREDITS,
                  });
                  const submitFailureHint = stage?.submitFailure
                    ? stagedSubmitFailureHint(stage.submitFailure.reason)
                    : undefined;
                  return (
                    <div className="agp-node-shell" key={asset.assetId}>
                      <button
                        className="agp-asset-node"
                        data-status={state.status}
                        onClick={() => onOpen(asset.assetId)}
                        type="button"
                      >
                        {firstReference ? (
                          <span className="agp-node-preview">
                            <img
                              alt={asset.name + " reference preview"}
                              src={firstReference.uri}
                            />
                          </span>
                        ) : (
                          <EmptyThumbnail classification={classification} />
                        )}
                        <span className="agp-node-copy">
                          <span
                            className="agp-status"
                            data-status={state.status}
                          >
                            <i aria-hidden="true" />
                            {statusLabel(state)}
                          </span>
                          <strong>{asset.name}</strong>
                          {subtitle && <small>{subtitle}</small>}
                        </span>
                        {/* The badge slot is always rendered, empty or not, so
                          the arrow keeps one height across a row of cards in
                          different stage states. */}
                        <span className="agp-node-meta">
                          <b>{card.badge ?? ""}</b>
                          <i aria-hidden="true">→</i>
                        </span>
                      </button>
                      {(card.action !== "none" || stage) && (
                        <div
                          className="agp-node-stage"
                          data-stage-status={card.status}
                        >
                          <span className="agp-node-stage-copy">
                            <strong>{card.statusLabel}</strong>
                            <small>{card.detail}</small>
                            {stage?.submitFailure && (
                              <span
                                className="agp-staged-card-error"
                                role="alert"
                              >
                                <strong>{stage.submitFailure.reason}</strong>
                                {submitFailureHint && (
                                  <small>{submitFailureHint}</small>
                                )}
                              </span>
                            )}
                            {stage && (
                              <RigEligibilityControl
                                busy={overridingRig !== null}
                                onOverride={(biped) =>
                                  onOverrideRig(asset.assetId, biped)
                                }
                                stage={stage}
                              />
                            )}
                          </span>
                          {card.action === "start" ? (
                            <button
                              className="agp-credit-button agp-node-generate"
                              disabled={
                                starting !== null ||
                                card.blockedReason !== undefined
                              }
                              onClick={() => onStart(asset.assetId)}
                              type="button"
                            >
                              {starting === asset.assetId
                                ? "Submitting…"
                                : "Generate with Meshy"}
                              <span>{creditLabel(card.startCredits)}</span>
                            </button>
                          ) : card.action === "open" ? (
                            <button
                              className="agp-primary agp-node-generate"
                              onClick={() => onOpenStage(asset.assetId)}
                              type="button"
                            >
                              {card.status === "running"
                                ? "Watch progress"
                                : card.status === "review"
                                  ? "Review the model"
                                  : "Open the model"}
                            </button>
                          ) : null}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        ))}
      </main>
    </section>
  );
}

function PathChooser({
  asset,
  state,
  onChange,
}: {
  asset: PlannedAsset;
  state: AssetUiState;
  onChange: (path: GenerationPath) => void;
}) {
  const template = referenceTemplateFor(asset);
  if (template.allowedGenerationPaths.length === 1)
    return (
      <div className="agp-procedural-path">
        <span className="agp-step-number">01</span>
        <div>
          <strong>Procedural reference</strong>
          <p>
            Make one reference for the coding agent. This asset never goes to
            Meshy and costs no credits.
          </p>
        </div>
      </div>
    );

  return (
    <section className="agp-path-section">
      <div className="agp-section-heading">
        <span className="agp-step-number">01</span>
        <div>
          <h2>Choose a path</h2>
          <p>You can switch until this asset is resolved.</p>
        </div>
      </div>
      <div className="agp-path-chooser">
        <button
          aria-pressed={state.path === "image-refs"}
          disabled={state.status === "resolved"}
          onClick={() => onChange("image-refs")}
          type="button"
        >
          <i aria-hidden="true" className="agp-path-image-icon" />
          <span>
            <strong>Build from images</strong>
            <small>
              Generate free references or upload one. Meshy uses the approved
              set.
            </small>
          </span>
          <b aria-hidden="true" />
        </button>
        <button
          aria-pressed={state.path === "text-to-3d"}
          disabled={state.status === "resolved"}
          onClick={() => onChange("text-to-3d")}
          type="button"
        >
          <i aria-hidden="true" className="agp-path-text-icon">
            Aa
          </i>
          <span>
            <strong>Send text to Meshy</strong>
            <small>
              Skip references and resolve this asset with an editable 3D prompt.
            </small>
          </span>
          <b aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}

function UploadTarget({
  asset,
  disabled,
  onFiles,
}: {
  asset: PlannedAsset;
  disabled: boolean;
  onFiles: (files: FileList | File[]) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const template = referenceTemplateFor(asset);
  const handleDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragging(false);
    if (!disabled && event.dataTransfer.files.length > 0)
      onFiles(event.dataTransfer.files);
  };
  const handlePicker = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files?.length) onFiles(event.target.files);
    event.target.value = "";
  };

  return (
    <label
      className="agp-upload"
      data-disabled={disabled}
      data-dragging={dragging}
      onDragEnter={(event) => {
        event.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDragOver={(event) => event.preventDefault()}
      onDrop={handleDrop}
    >
      <input
        accept={template.uploadRules.acceptedMimeTypes.join(",")}
        disabled={disabled}
        multiple={template.uploadRules.allowMultiple}
        onChange={handlePicker}
        type="file"
      />
      <i aria-hidden="true">↑</i>
      <span>
        <strong>Drop one image here</strong>
        <small>
          or choose a PNG, JPEG, or WebP · it becomes the{" "}
          {SLOT_LABELS[template.uploadRules.singleUpload.canonicalSlot]} view ·
          8 MB max
        </small>
      </span>
      <b>Choose file</b>
    </label>
  );
}

function ReferenceWorkspace({
  asset,
  state,
  styleCapsule,
  onGenerate,
  onPrompt,
  onRetry,
  onUpload,
}: {
  asset: PlannedAsset;
  state: AssetUiState;
  styleCapsule: string;
  onGenerate: () => void;
  onPrompt: (prompt: string) => void;
  onRetry: () => void;
  onUpload: (files: FileList | File[]) => void;
}) {
  const template = referenceTemplateFor(asset);
  const filled = referencesFor(state, template.requiredViewSlots);
  const complete = filled.length === template.requiredViewSlots.length;
  const isResolved = state.status === "resolved";
  const isGenerating = template.requiredViewSlots.some(
    (slot) => state.slotGeneration[slot]?.status === "pending",
  );
  const failedCount = template.requiredViewSlots.filter(
    (slot) => state.slotGeneration[slot]?.status === "error",
  ).length;
  const hasFailedSlots = failedCount > 0;
  const totalSlots = template.requiredViewSlots.length;
  const readyCount = template.requiredViewSlots.filter(
    (slot) => state.references[slot] && !state.slotGeneration[slot],
  ).length;

  return (
    <section className="agp-reference-workspace">
      <div className="agp-compose-panel">
        <div className="agp-section-heading">
          <span className="agp-step-number">02</span>
          <div>
            <h2>Make the reference set</h2>
            <p>
              ImageGen runs through your signed-in OpenAI subscription. Describe
              the subject; the approved look is added for you.
            </p>
          </div>
        </div>
        <label className="agp-prompt">
          <span>Subject prompt</span>
          <textarea
            disabled={isResolved}
            maxLength={MAX_SUBJECT_PROMPT_INPUT}
            onChange={(event) => onPrompt(event.target.value)}
            rows={7}
            value={state.imagePrompt}
          />
        </label>
        {styleCapsule && (
          <details className="agp-capsule">
            <summary>
              <span className="agp-capsule-name">Style capsule</span>
              <span className="agp-capsule-state">attached on send</span>
              <i aria-hidden="true" />
            </summary>
            <p>{styleCapsule}</p>
          </details>
        )}
        <div className="agp-compose-actions">
          {hasFailedSlots && (
            <button
              className="agp-primary"
              disabled={isResolved || isGenerating}
              onClick={onRetry}
              type="button"
            >
              Retry failed views
            </button>
          )}
          <button
            className={hasFailedSlots ? "agp-secondary" : "agp-primary"}
            disabled={isResolved || isGenerating || !state.imagePrompt.trim()}
            onClick={onGenerate}
            type="button"
          >
            {isGenerating
              ? "Generating references…"
              : complete
                ? "Regenerate complete set"
                : "Generate free references"}
          </button>
        </div>
        <div className="agp-divider">
          <span>or use your own image</span>
        </div>
        <UploadTarget
          asset={asset}
          disabled={isResolved || isGenerating}
          onFiles={onUpload}
        />
        {state.uploadError && (
          <p className="agp-upload-error">{state.uploadError}</p>
        )}
      </div>

      <div className="agp-reference-panel">
        <div className="agp-reference-heading">
          <div>
            <span className="agp-eyebrow">Reference set</span>
            <h2>
              {readyCount + " of " + totalSlots}{" "}
              {totalSlots === 1 ? "view" : "views"} ready
            </h2>
          </div>
          {state.revision > 0 && (
            <span className="agp-revision">
              Revision {String(state.revision).padStart(2, "0")}
            </span>
          )}
        </div>
        {hasFailedSlots && (
          <p className="agp-reference-alert" role="status">
            <i aria-hidden="true">!</i>
            <strong>
              {failedCount + " of " + totalSlots}{" "}
              {totalSlots === 1 ? "view" : "views"} failed
            </strong>
            <small>Retry to generate them again.</small>
          </p>
        )}
        <div className="agp-reference-grid" data-count={totalSlots}>
          {template.requiredViewSlots.map((slot) => {
            const reference = state.references[slot];
            const generation = state.slotGeneration[slot];
            const slotView = slotViewFor(reference, generation);
            return (
              <figure data-generation={generation?.status} key={slot}>
                <div className="agp-slot-visual" data-slot-view={slotView}>
                  {slotView === "error" ? (
                    <span className="agp-slot-error" role="alert">
                      <i aria-hidden="true">!</i>
                      <strong>{SLOT_LABELS[slot]} didn’t generate</strong>
                      <small>{generation?.message}</small>
                      <button
                        className="agp-slot-retry"
                        disabled={isResolved || isGenerating}
                        onClick={onRetry}
                        type="button"
                      >
                        Retry
                      </button>
                    </span>
                  ) : slotView === "pending" ? (
                    <>
                      {reference && (
                        <img alt="" aria-hidden="true" src={reference.uri} />
                      )}
                      <span
                        aria-live="polite"
                        className="agp-slot-pending"
                        role="status"
                      >
                        <i aria-hidden="true" />
                        <strong>{generation?.message}</strong>
                      </span>
                    </>
                  ) : slotView === "filled" && reference ? (
                    <img
                      alt={asset.name + " " + SLOT_LABELS[slot] + " reference"}
                      src={reference.uri}
                    />
                  ) : (
                    <span className="agp-slot-empty">
                      <i aria-hidden="true" />
                    </span>
                  )}
                </div>
                <figcaption>
                  <strong>{SLOT_LABELS[slot]}</strong>
                  <small className="agp-slot-state" data-state={slotView}>
                    {slotView === "pending"
                      ? "Generating"
                      : slotView === "error"
                        ? "Needs retry"
                        : reference?.source === "uploaded"
                          ? "Your upload"
                          : reference
                            ? "ImageGen"
                            : "Empty"}
                  </small>
                </figcaption>
              </figure>
            );
          })}
        </div>
        {template.uploadRules.singleUpload.deriveRemainingViews && (
          <p className="agp-derive-note">
            One upload fills the canonical{" "}
            {SLOT_LABELS[
              template.uploadRules.singleUpload.canonicalSlot
            ].toLowerCase()}{" "}
            view. ImageGen derives the remaining views from that same subject.
          </p>
        )}
      </div>
    </section>
  );
}

function TextWorkspace({
  asset,
  state,
  onPrompt,
}: {
  asset: PlannedAsset;
  state: AssetUiState;
  onPrompt: (prompt: string) => void;
}) {
  const promptReady = meshyPromptReady(state.meshyPrompt);
  return (
    <section className="agp-text-workspace">
      <div className="agp-section-heading">
        <span className="agp-step-number">02</span>
        <div>
          <h2>Prepare the 3D prompt</h2>
          <p>
            This route needs no reference images. Approving records the prompt
            for this asset and costs nothing.
          </p>
        </div>
      </div>
      <label className="agp-prompt agp-text-prompt">
        <span>Direct Meshy text prompt</span>
        <textarea
          disabled={state.status === "resolved"}
          onChange={(event) => onPrompt(event.target.value)}
          placeholder="Describe what Meshy should build — subject, silhouette, materials, and scale."
          rows={12}
          value={state.meshyPrompt}
        />
      </label>
      <aside>
        <span>Output route</span>
        <strong>{MESHY_MODEL.replace("-", " ")}</strong>
        <p>
          The staged card spends {MESHY_GEOMETRY_PREVIEW_CREDITS} credits on
          geometry when you start it, and {MESHY_4K_TEXTURE_CREDITS} more on the
          4K texture after you have seen the mesh.
        </p>
      </aside>
      <p
        className="agp-text-valid"
        data-requirement={!promptReady || undefined}
      >
        {promptReady ? (
          <>
            A text-only plan is a complete and valid resolution for{" "}
            <strong>{asset.name}</strong>.
          </>
        ) : (
          <>Write at least a sentence describing what Meshy should build.</>
        )}
      </p>
    </section>
  );
}

function FocusedAsset({
  asset,
  projectState,
  state,
  assets,
  states,
  resolvedCount,
  onApprove,
  onBack,
  onGenerate,
  onImagePrompt,
  onMeshyPrompt,
  onNext,
  onPath,
  onRetry,
  onUpload,
  approving,
  approveError,
  styleCapsule,
}: {
  asset: PlannedAsset;
  projectState: ProjectSnapshot["state"];
  state: AssetUiState;
  assets: PlannedAsset[];
  states: Record<string, AssetUiState>;
  resolvedCount: number;
  styleCapsule: string;
  onApprove: () => void;
  onBack: () => void;
  onGenerate: () => void;
  onImagePrompt: (prompt: string) => void;
  onMeshyPrompt: (prompt: string) => void;
  onNext: () => void;
  onPath: (path: GenerationPath) => void;
  onRetry: () => void;
  onUpload: (files: FileList | File[]) => void;
  /** Set while the approved set is being saved to the project. */
  approving: boolean;
  approveError: string | undefined;
}) {
  const template = referenceTemplateFor(asset);
  const requiredReferences = referencesFor(state, template.requiredViewSlots);
  const referencesComplete =
    requiredReferences.length === template.requiredViewSlots.length;
  const referencesSettled = template.requiredViewSlots.every(
    (slot) => !state.slotGeneration[slot],
  );
  const nextExists = assets.some(
    (candidate) =>
      candidate.assetId !== asset.assetId &&
      states[candidate.assetId]?.status !== "resolved",
  );
  const canApprove =
    state.path === "text-to-3d"
      ? meshyPromptReady(state.meshyPrompt)
      : referencesComplete && referencesSettled;
  const procedural = state.path === "procedural";

  const usesReferences = state.path !== "text-to-3d";
  const totalViews = template.requiredViewSlots.length;
  const generatingViews = template.requiredViewSlots.some(
    (slot) => state.slotGeneration[slot]?.status === "pending",
  );
  const failedViews = template.requiredViewSlots.filter(
    (slot) => state.slotGeneration[slot]?.status === "error",
  ).length;
  const readyViews = template.requiredViewSlots.filter(
    (slot) => state.references[slot] && !state.slotGeneration[slot],
  ).length;
  const viewNoun = totalViews === 1 ? "view" : "views";

  const footerStatus: FooterStatus =
    state.status === "resolved"
      ? "resolved"
      : approveError
        ? "not-saved"
        : usesReferences && generatingViews
          ? "generating"
          : usesReferences && failedViews > 0
            ? "needs-retry"
            : canApprove
              ? "ready"
              : "unresolved";

  const readyNote = procedural
    ? "Approve one reference for the coding agent."
    : usesReferences
      ? "Approving is free. Geometry starts from the staged card."
      : "Approving is free. Nothing is submitted here.";
  const waitingNote = !usesReferences
    ? "Write at least a sentence describing what Meshy should build."
    : generatingViews
      ? "Generating the reference set…"
      : failedViews > 0
        ? `Retry ${failedViews} failed ${failedViews === 1 ? "view" : "views"} to continue.`
        : `Needs ${totalViews} of ${totalViews} ${viewNoun} — ${readyViews} ready`;
  const footerNote =
    approveError ??
    (state.status === "resolved"
      ? state.resolutionLabel
      : approving
        ? "Saving the approved set to this project…"
        : canApprove
          ? readyNote
          : waitingNote);

  return (
    <section className="agp-focus agp-surface">
      <header className="agp-focus-head">
        <button className="agp-back" onClick={onBack} type="button">
          <i aria-hidden="true">←</i>
          <span>All images</span>
        </button>
        <div className="agp-focus-title">
          <span className="agp-kicker">
            {CLASSIFICATION_LABELS[classifyAsset(asset)]} · {statusLabel(state)}
          </span>
          <h1>{asset.name}</h1>
        </div>
        <div className="agp-head-meta agp-focus-meta">
          <PrototypeMark state={projectState} />
          <ProgressCount resolved={resolvedCount} total={assets.length} />
        </div>
      </header>

      <main className="agp-focus-body">
        <section className="agp-asset-brief">
          <div>
            <span className="agp-eyebrow">Why this asset exists</span>
            <p>{asset.rationale}</p>
          </div>
          <div>
            <span className="agp-eyebrow">Done means</span>
            <ul>
              {asset.acceptanceCriteria.map((criterion, index) => (
                <li key={`${asset.assetId}-criterion-${index}`}>{criterion}</li>
              ))}
            </ul>
          </div>
        </section>

        <PathChooser asset={asset} onChange={onPath} state={state} />

        {state.path === "text-to-3d" ? (
          <TextWorkspace asset={asset} onPrompt={onMeshyPrompt} state={state} />
        ) : (
          <ReferenceWorkspace
            asset={asset}
            onGenerate={onGenerate}
            onPrompt={onImagePrompt}
            onRetry={onRetry}
            onUpload={onUpload}
            state={state}
            styleCapsule={styleCapsule}
          />
        )}
      </main>

      <footer className="agp-focus-footer">
        <div className="agp-footer-status">
          <span className="agp-status" data-status={footerStatus}>
            <i aria-hidden="true" />
            {FOOTER_STATUS_LABELS[footerStatus]}
          </span>
          <small>{footerNote}</small>
        </div>
        <div className="agp-footer-actions">
          <button
            className="agp-next"
            disabled={!nextExists}
            onClick={onNext}
            type="button"
          >
            Next unresolved asset <i aria-hidden="true">→</i>
          </button>
          {state.status !== "resolved" ? (
            /* Free, so it wears the ordinary primary skin. The gold
               credit-button skin is reserved for CTAs that actually spend. */
            <button
              className="agp-primary"
              disabled={!canApprove || approving}
              onClick={onApprove}
              type="button"
            >
              {approving
                ? "Saving…"
                : procedural
                  ? "Approve reference for build"
                  : state.path === "text-to-3d"
                    ? "Approve the 3D prompt"
                    : "Approve references"}
            </button>
          ) : (
            <div className="agp-resolved-mark">
              <i aria-hidden="true">✓</i>
              Asset resolved
            </div>
          )}
        </div>
      </footer>
    </section>
  );
}

export function AssetGatePrototype({
  project,
  onSnapshot,
}: {
  project: ProjectSnapshot;
  /** Hands a route's returned snapshot back to the studio's project state. */
  onSnapshot?: (next: ProjectSnapshot) => void;
}) {
  const assets = project.assetPlan?.assets ?? [];
  const stages = project.assetStages ?? {};
  const [stagedAssetId, setStagedAssetId] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const [overridingRig, setOverridingRig] = useState<string | null>(null);
  const [stageError, setStageError] = useState<string | undefined>(undefined);
  const [states, setStates] = useState<Record<string, AssetUiState>>(() =>
    initialStates(project, assets),
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [approving, setApproving] = useState<string | null>(null);
  const [approveError, setApproveError] = useState<string | undefined>(
    undefined,
  );
  const [amendmentRequests, setAmendmentRequests] = useState<
    Partial<Record<AssetClassification, string>>
  >({});
  const [amendmentErrors, setAmendmentErrors] = useState<
    Partial<Record<AssetClassification, string>>
  >({});
  const [amendingSection, setAmendingSection] =
    useState<AssetClassification | null>(null);
  const previousObjectUrls = useRef(new Set<string>());
  const generationSequence = useRef(0);
  const activeGenerations = useRef(new Map<string, number>());
  const canonicalFiles = useRef(new Map<string, File>());
  const detectionRequests = useRef(new Set<string>());
  const plannedAssetSignatures = useRef(
    new Map(assets.map((asset) => [asset.assetId, JSON.stringify(asset)])),
  );

  /* A successful amendment changes the project prop without remounting this
     gate. Add fresh slots to the local Images-stage state, remove deleted
     slots, and reset a genuinely changed unresolved slot to its new prompt. */
  useEffect(() => {
    const defaults = initialStates(project, assets);
    const nextSignatures = new Map(
      assets.map((asset) => [asset.assetId, JSON.stringify(asset)]),
    );
    setStates((current) => {
      const next = Object.fromEntries(
        assets.map((asset) => {
          const unchanged =
            plannedAssetSignatures.current.get(asset.assetId) ===
            nextSignatures.get(asset.assetId);
          const preserved = current[asset.assetId];
          return [
            asset.assetId,
            unchanged && preserved ? preserved : defaults[asset.assetId]!,
          ];
        }),
      );
      const currentIds = Object.keys(current);
      return currentIds.length === assets.length &&
        assets.every((asset) => next[asset.assetId] === current[asset.assetId])
        ? current
        : next;
    });
    plannedAssetSignatures.current = nextSignatures;
  }, [assets, project]);

  useEffect(() => {
    const currentObjectUrls = new Set(
      Object.values(states).flatMap((state) =>
        Object.values(state.references).flatMap((reference) =>
          reference?.uri.startsWith("blob:") ? [reference.uri] : [],
        ),
      ),
    );
    previousObjectUrls.current.forEach((uri) => {
      if (!currentObjectUrls.has(uri)) URL.revokeObjectURL(uri);
    });
    previousObjectUrls.current = currentObjectUrls;
  }, [states]);

  useEffect(
    () => () => {
      previousObjectUrls.current.forEach((uri) => URL.revokeObjectURL(uri));
    },
    [],
  );

  /* Hydration. A reference set only exists in the project because somebody
     approved it, so a reload shows the approved views and the resolved state
     rather than empty slots and a "no reference yet" thumbnail. */
  const referenceSets = project.assetReferenceSets;
  useEffect(() => {
    if (!referenceSets) return;
    setStates((current) => {
      const hydrated = Object.entries(referenceSets).flatMap(
        ([assetId, set]) => {
          const liveState = current[assetId];
          const asset = assets.find(
            (candidate) => candidate.assetId === assetId,
          );
          if (!liveState || !asset) return [];
          const next = hydrateApprovedSet(liveState, asset, set);
          return next === liveState ? [] : [[assetId, next] as const];
        },
      );
      return hydrated.length === 0
        ? current
        : { ...current, ...Object.fromEntries(hydrated) };
    });
  }, [referenceSets, assets]);

  /* Old worlds can already have approved references but no verdict. One lazy
     request per front-image hash backfills them without asking for an upload. */
  useEffect(() => {
    if (!referenceSets) return;
    for (const asset of assets) {
      const set = referenceSets[asset.assetId];
      const stage = stages[asset.assetId];
      const front = set?.views.find(({ role }) => role === "front");
      if (!front || stage?.classification !== "hero" || stage.bipedDetection)
        continue;
      const requestKey = `${asset.assetId}:${front.image.sha256}`;
      if (detectionRequests.current.has(requestKey)) continue;
      detectionRequests.current.add(requestKey);
      void api<ProjectSnapshot>(
        `/api/projects/${project.state.projectId}/assets/${encodeURIComponent(asset.assetId)}/biped-detection`,
        { method: "POST" },
      )
        .then((next) => onSnapshot?.(next))
        .catch((cause: unknown) => {
          setStageError(
            isApiError(cause)
              ? cause.detail
              : cause instanceof Error
                ? cause.message
                : "Biped detection could not inspect the approved front view.",
          );
        });
    }
  }, [assets, onSnapshot, project.state.projectId, referenceSets, stages]);

  const selected = useMemo(
    () => assets.find((asset) => asset.assetId === selectedId),
    [assets, selectedId],
  );
  /* Single-sourced from the approved Color & Mood and appended to every
     ImageGen request below, whether the subject was suggested or typed. */
  const styleCapsule = useMemo(
    () => buildStyleCapsule(styleContextFor(project)),
    [project],
  );
  const resolvedCount = assets.filter(
    (asset) => states[asset.assetId]?.status === "resolved",
  ).length;

  const updateSelected = (
    update: (state: AssetUiState, asset: PlannedAsset) => AssetUiState,
  ) => {
    if (!selected) return;
    setStates((current) => ({
      ...current,
      [selected.assetId]: update(current[selected.assetId]!, selected),
    }));
  };

  const selectPath = (path: GenerationPath) =>
    updateSelected((state) => ({
      ...state,
      status: state.status === "resolved" ? "resolved" : "in-progress",
      path,
    }));

  const setImagePrompt = (imagePrompt: string) =>
    updateSelected((state) => ({
      ...state,
      status: state.status === "resolved" ? "resolved" : "in-progress",
      imagePrompt,
    }));

  const setMeshyPrompt = (meshyPrompt: string) =>
    updateSelected((state) => ({
      ...state,
      status: state.status === "resolved" ? "resolved" : "in-progress",
      meshyPrompt,
    }));

  const failPendingSlots = (
    assetId: string,
    requestId: number,
    slots: readonly ReferenceViewSlot[],
    message: string,
  ) => {
    setStates((current) => {
      const liveState = current[assetId];
      if (!liveState || liveState.status === "resolved") return current;
      const slotGeneration = { ...liveState.slotGeneration };
      let changed = false;
      for (const slot of slots) {
        const generation = slotGeneration[slot];
        if (
          generation?.status === "pending" &&
          generation.requestId === requestId
        ) {
          slotGeneration[slot] = {
            status: "error",
            requestId,
            message,
          };
          changed = true;
        }
      }
      if (!changed) return current;
      return {
        ...current,
        [assetId]: { ...liveState, slotGeneration },
      };
    });
  };

  const runSlotGeneration = async ({
    assetId,
    assetName,
    imagePrompt,
    referenceImageDataUrl,
    requestId,
    slots,
  }: {
    assetId: string;
    assetName: string;
    imagePrompt: string;
    referenceImageDataUrl?: string;
    requestId: number;
    slots: readonly ReferenceViewSlot[];
  }) => {
    await runWithConcurrency(slots, 2, async (slot) => {
      try {
        const result = await api<PrototypeImageGenerateResponse>(
          "/api/prototype/imagegen/generate",
          {
            method: "POST",
            body: JSON.stringify({
              prompt: composeImagegenPrompt(imagePrompt, styleCapsule),
              viewLabel: SLOT_LABELS[slot],
              viewInstruction: VIEW_INSTRUCTIONS[slot],
              assetName,
              ...(referenceImageDataUrl ? { referenceImageDataUrl } : {}),
            }),
          },
        );
        setStates((current) => {
          const liveState = current[assetId];
          const liveGeneration = liveState?.slotGeneration[slot];
          if (
            !liveState ||
            liveState.status === "resolved" ||
            liveGeneration?.status !== "pending" ||
            liveGeneration.requestId !== requestId
          )
            return current;
          const slotGeneration = { ...liveState.slotGeneration };
          delete slotGeneration[slot];
          return {
            ...current,
            [assetId]: {
              ...liveState,
              references: {
                ...liveState.references,
                [slot]: {
                  slot,
                  uri: result.imageUrl,
                  source: "generated",
                },
              },
              slotGeneration,
            },
          };
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "ImageGen failed.";
        failPendingSlots(assetId, requestId, [slot], message);
      }
    });
  };

  const runSheetGeneration = async ({
    assetId,
    assetName,
    imagePrompt,
    referenceImageDataUrl,
    canonicalSlot,
    requestId,
    slots,
  }: {
    assetId: string;
    assetName: string;
    imagePrompt: string;
    referenceImageDataUrl?: string;
    canonicalSlot?: ReferenceViewSlot;
    requestId: number;
    slots: readonly ReferenceViewSlot[];
  }) => {
    try {
      const sheet = await api<PrototypeImageGenerateResponse>(
        "/api/prototype/imagegen/generate",
        {
          method: "POST",
          body: JSON.stringify({
            prompt: composeImagegenPrompt(imagePrompt, styleCapsule),
            viewLabel: "Four-view reference sheet",
            viewInstruction: buildSheetInstruction(
              slots,
              SLOT_LABELS,
              canonicalSlot,
            ),
            assetName,
            ...(referenceImageDataUrl ? { referenceImageDataUrl } : {}),
          }),
        },
      );
      if (activeGenerations.current.get(assetId) !== requestId) return;

      const quadrants = await sliceReferenceSheet(sheet.imageUrl);
      if (activeGenerations.current.get(assetId) !== requestId) return;

      const storedViews = await Promise.all(
        slots.flatMap((slot, index) =>
          slot === canonicalSlot
            ? []
            : [
                api<PrototypeImageStoreResponse>(
                  "/api/prototype/imagegen/store",
                  {
                    method: "POST",
                    body: JSON.stringify({ imageDataUrl: quadrants[index]! }),
                  },
                ).then((stored) => [slot, stored.imageUrl] as const),
              ],
        ),
      );
      setStates((current) => {
        const liveState = current[assetId];
        if (!liveState || liveState.status === "resolved") return current;
        const requestIsCurrent = slots.every((slot) => {
          const generation = liveState.slotGeneration[slot];
          return (
            generation?.status === "pending" &&
            generation.requestId === requestId
          );
        });
        if (!requestIsCurrent) return current;

        const references = { ...liveState.references };
        for (const [slot, imageUrl] of storedViews)
          references[slot] = {
            slot,
            uri: imageUrl,
            source: "generated",
          };
        const slotGeneration = { ...liveState.slotGeneration };
        for (const slot of slots) delete slotGeneration[slot];
        return {
          ...current,
          [assetId]: { ...liveState, references, slotGeneration },
        };
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Four-view generation failed.";
      failPendingSlots(assetId, requestId, slots, message);
    }
  };

  const generate = () => {
    if (!selected) return;
    const asset = selected;
    const assetId = asset.assetId;
    const state = states[assetId];
    const imagePrompt = state?.imagePrompt.trim();
    if (
      !state ||
      state.status === "resolved" ||
      !imagePrompt ||
      activeGenerations.current.has(assetId)
    )
      return;
    const template = referenceTemplateFor(asset);
    const slots = [...template.requiredViewSlots];
    const sheetMode = slots.length === SHEET_CELL_ORDER.length;
    const requestId = ++generationSequence.current;
    canonicalFiles.current.delete(assetId);
    activeGenerations.current.set(assetId, requestId);
    setStates((current) => {
      const liveState = current[assetId];
      if (!liveState || liveState.status === "resolved") return current;
      return {
        ...current,
        [assetId]: {
          ...liveState,
          status: "in-progress",
          slotGeneration: Object.fromEntries(
            slots.map((slot) => [
              slot,
              {
                status: "pending",
                requestId,
                message: sheetMode
                  ? "Generating four-view sheet…"
                  : `Generating ${SLOT_LABELS[slot]}…`,
              },
            ]),
          ),
          canonicalReferenceDataUrl: undefined,
          revision: liveState.revision + 1,
          uploadError: "",
        },
      };
    });
    const generation = sheetMode
      ? runSheetGeneration({
          assetId,
          assetName: asset.name,
          imagePrompt,
          requestId,
          slots,
        })
      : runSlotGeneration({
          assetId,
          assetName: asset.name,
          imagePrompt,
          requestId,
          slots,
        });
    void generation.finally(() => {
      if (activeGenerations.current.get(assetId) === requestId)
        activeGenerations.current.delete(assetId);
    });
  };

  const retryFailed = () => {
    if (!selected) return;
    const asset = selected;
    const assetId = asset.assetId;
    const state = states[assetId];
    if (
      !state ||
      state.status === "resolved" ||
      activeGenerations.current.has(assetId)
    )
      return;
    const template = referenceTemplateFor(asset);
    const sheetMode =
      template.requiredViewSlots.length === SHEET_CELL_ORDER.length;
    const slots = sheetMode
      ? [...template.requiredViewSlots]
      : template.requiredViewSlots.filter(
          (slot) =>
            state.slotGeneration[slot]?.status === "error" ||
            !state.references[slot],
        );
    if (slots.length === 0) return;
    const requestId = ++generationSequence.current;
    const imagePrompt = state.imagePrompt.trim();
    if (!imagePrompt) return;
    activeGenerations.current.set(assetId, requestId);
    setStates((current) => {
      const liveState = current[assetId];
      if (!liveState || liveState.status === "resolved") return current;
      return {
        ...current,
        [assetId]: {
          ...liveState,
          slotGeneration: {
            ...liveState.slotGeneration,
            ...Object.fromEntries(
              slots.map((slot) => [
                slot,
                {
                  status: "pending",
                  requestId,
                  message: sheetMode
                    ? "Generating four-view sheet…"
                    : `Generating ${SLOT_LABELS[slot]}…`,
                },
              ]),
            ),
          },
          uploadError: "",
        },
      };
    });
    void (async () => {
      let referenceImageDataUrl = state.canonicalReferenceDataUrl;
      if (!referenceImageDataUrl) {
        const canonicalFile = canonicalFiles.current.get(assetId);
        if (canonicalFile) {
          referenceImageDataUrl = await readFileAsDataUrl(canonicalFile);
          setStates((current) => {
            const liveState = current[assetId];
            if (!liveState || liveState.status === "resolved") return current;
            const stillCurrent = slots.some(
              (slot) => liveState.slotGeneration[slot]?.requestId === requestId,
            );
            if (!stillCurrent) return current;
            return {
              ...current,
              [assetId]: {
                ...liveState,
                canonicalReferenceDataUrl: referenceImageDataUrl,
              },
            };
          });
        }
      }
      if (sheetMode)
        await runSheetGeneration({
          assetId,
          assetName: asset.name,
          imagePrompt,
          ...(referenceImageDataUrl
            ? {
                referenceImageDataUrl,
                canonicalSlot: template.uploadRules.singleUpload.canonicalSlot,
              }
            : {}),
          requestId,
          slots,
        });
      else
        await runSlotGeneration({
          assetId,
          assetName: asset.name,
          imagePrompt,
          ...(referenceImageDataUrl ? { referenceImageDataUrl } : {}),
          requestId,
          slots,
        });
    })()
      .catch((error) => {
        const message =
          error instanceof Error
            ? error.message
            : "The uploaded image could not be read.";
        failPendingSlots(assetId, requestId, slots, message);
      })
      .finally(() => {
        if (activeGenerations.current.get(assetId) === requestId)
          activeGenerations.current.delete(assetId);
      });
  };

  const upload = (files: FileList | File[]) => {
    if (!selected || files.length === 0) return;
    const asset = selected;
    const assetId = asset.assetId;
    const state = states[assetId];
    if (
      !state ||
      state.status === "resolved" ||
      activeGenerations.current.has(assetId)
    )
      return;
    const template = referenceTemplateFor(asset);
    const selectedFiles = Array.from(files);
    try {
      assertValidReferenceUploadSelection(template.uploadRules, selectedFiles);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Choose one valid image.";
      setStates((current) => {
        const liveState = current[assetId];
        if (!liveState || liveState.status === "resolved") return current;
        return {
          ...current,
          [assetId]: { ...liveState, uploadError: message },
        };
      });
      return;
    }
    const file = selectedFiles[0]!;
    if (file.size > MAX_REFERENCE_UPLOAD_BYTES) {
      setStates((current) => {
        const liveState = current[assetId];
        if (!liveState || liveState.status === "resolved") return current;
        return {
          ...current,
          [assetId]: {
            ...liveState,
            uploadError: "Choose an image that is 8 MB or smaller.",
          },
        };
      });
      return;
    }
    const uri = URL.createObjectURL(file);
    const canonicalSlot = template.uploadRules.singleUpload.canonicalSlot;
    const deriveSlots = template.uploadRules.singleUpload.deriveRemainingViews
      ? template.requiredViewSlots.filter((slot) => slot !== canonicalSlot)
      : [];
    const sheetMode =
      template.requiredViewSlots.length === SHEET_CELL_ORDER.length;
    const generationSlots = sheetMode
      ? [...template.requiredViewSlots]
      : deriveSlots;
    const requestId = ++generationSequence.current;
    if (deriveSlots.length > 0)
      activeGenerations.current.set(assetId, requestId);
    canonicalFiles.current.set(assetId, file);
    setStates((current) => {
      const liveState = current[assetId];
      if (!liveState || liveState.status === "resolved") {
        URL.revokeObjectURL(uri);
        return current;
      }
      return {
        ...current,
        [assetId]: {
          ...liveState,
          status: "in-progress",
          references: {
            ...liveState.references,
            [canonicalSlot]: {
              slot: canonicalSlot,
              uri,
              source: "uploaded",
            },
          },
          slotGeneration: Object.fromEntries(
            generationSlots.map((slot) => [
              slot,
              {
                status: "pending",
                requestId,
                message: sheetMode
                  ? "Generating four-view sheet…"
                  : `Generating ${SLOT_LABELS[slot]}…`,
              },
            ]),
          ),
          canonicalReferenceDataUrl: undefined,
          revision: liveState.revision + 1,
          uploadError: "",
        },
      };
    });
    if (deriveSlots.length === 0) return;

    void readFileAsDataUrl(file)
      .then(async (referenceImageDataUrl) => {
        setStates((current) => {
          const liveState = current[assetId];
          if (!liveState || liveState.status === "resolved") return current;
          const stillCurrent = generationSlots.some(
            (slot) => liveState.slotGeneration[slot]?.requestId === requestId,
          );
          if (!stillCurrent) return current;
          return {
            ...current,
            [assetId]: {
              ...liveState,
              canonicalReferenceDataUrl: referenceImageDataUrl,
            },
          };
        });
        if (sheetMode)
          await runSheetGeneration({
            assetId,
            assetName: asset.name,
            imagePrompt: state.imagePrompt.trim(),
            referenceImageDataUrl,
            canonicalSlot,
            requestId,
            slots: generationSlots,
          });
        else
          await runSlotGeneration({
            assetId,
            assetName: asset.name,
            imagePrompt: state.imagePrompt.trim(),
            referenceImageDataUrl,
            requestId,
            slots: deriveSlots,
          });
      })
      .catch((error) => {
        const message =
          error instanceof Error
            ? error.message
            : "The uploaded image could not be read.";
        failPendingSlots(assetId, requestId, generationSlots, message);
      })
      .finally(() => {
        if (activeGenerations.current.get(assetId) === requestId)
          activeGenerations.current.delete(assetId);
      });
  };

  /** Runs the pure resolution state machine and records what it produced. */
  const resolveLocally = (asset: PlannedAsset, state: AssetUiState) => {
    const template = referenceTemplateFor(asset);
    setStates((current) => {
      const liveState = current[asset.assetId];
      if (!liveState || liveState.status === "resolved") return current;
      try {
        const started = transitionAssetResolution(
          asset,
          { status: "unresolved" },
          { type: "start", path: state.path },
        );
        const references = referencesFor(liveState, template.requiredViewSlots);
        const resolved =
          state.path === "image-refs"
            ? transitionAssetResolution(asset, started, {
                type: "approve-references",
                references,
              })
            : state.path === "procedural"
              ? transitionAssetResolution(asset, started, {
                  type: "approve-procedural-reference",
                  reference: references[0]!,
                })
              : transitionAssetResolution(asset, started, {
                  type: "approve-text-prompt",
                  prompt: liveState.meshyPrompt,
                });
        if (resolved.status !== "resolved") return current;
        return {
          ...current,
          [asset.assetId]: {
            ...liveState,
            status: "resolved",
            resolutionLabel: resolutionLabelFor(state.path, references.length),
          },
        };
      } catch {
        return current;
      }
    });
  };

  /**
   * Approving.
   *
   * Nothing here spends a credit, but the reference views are the only input
   * the staged geometry request has, so the approved set is persisted to the
   * project *before* the asset is marked resolved. A failed upload leaves the
   * asset unresolved and says why — a client-only "resolved" would promise
   * Meshy a set the server has never seen.
   */
  const approve = () => {
    if (!selected || approving) return;
    const asset = selected;
    const assetId = asset.assetId;
    const state = states[assetId];
    if (!state || state.status === "resolved") return;
    const template = referenceTemplateFor(asset);

    if (state.path === "text-to-3d") {
      resolveLocally(asset, state);
      return;
    }

    const references = referencesFor(state, template.requiredViewSlots);
    setApproving(assetId);
    setApproveError(undefined);
    void (async () => {
      try {
        const views = await Promise.all(
          references.map(async (reference) => ({
            role: CARDINAL_ROLE_FOR_SLOT[reference.slot],
            source: reference.source,
            dataUrl: await fetchAsDataUrl(reference.uri),
          })),
        );
        const next = await api<ProjectSnapshot>(
          `/api/projects/${project.state.projectId}/assets/${encodeURIComponent(assetId)}/references`,
          { method: "POST", body: JSON.stringify({ views }) },
        );
        resolveLocally(asset, state);
        onSnapshot?.(next);
      } catch (cause: unknown) {
        setApproveError(
          isApiError(cause)
            ? cause.detail
            : cause instanceof Error
              ? cause.message
              : "The approved references could not be saved.",
        );
      } finally {
        setApproving(null);
      }
    })();
  };

  /* The one place the gate authorizes a Meshy spend: 20 credits of geometry,
     after which the staged screen owns everything about this asset. */
  const startStage = (assetId: string) => {
    if (starting) return;
    setStarting(assetId);
    setStageError(undefined);
    api<ProjectSnapshot>(
      `/api/projects/${project.state.projectId}/assets/${encodeURIComponent(assetId)}/stages/start`,
      { method: "POST" },
    )
      .then((next) => {
        onSnapshot?.(next);
        setStagedAssetId(assetId);
      })
      .catch((cause: unknown) => {
        setStageError(
          isApiError(cause)
            ? cause.detail
            : cause instanceof Error
              ? cause.message
              : "Meshy could not be started for this asset.",
        );
      })
      .finally(() => setStarting(null));
  };

  const overrideRig = (assetId: string, biped: boolean) => {
    if (overridingRig) return;
    setOverridingRig(assetId);
    setStageError(undefined);
    api<ProjectSnapshot>(
      `/api/projects/${project.state.projectId}/assets/${encodeURIComponent(assetId)}/rig-eligibility`,
      { method: "POST", body: JSON.stringify({ biped }) },
    )
      .then((next) => onSnapshot?.(next))
      .catch((cause: unknown) => {
        setStageError(
          isApiError(cause)
            ? cause.detail
            : cause instanceof Error
              ? cause.message
              : "The rig eligibility decision could not be saved.",
        );
      })
      .finally(() => setOverridingRig(null));
  };

  const amendSection = (section: AssetClassification) => {
    if (amendingSection) return;
    const request = amendmentRequests[section]?.trim();
    if (!request) return;
    setAmendingSection(section);
    setAmendmentErrors((current) => ({
      ...current,
      [section]: undefined,
    }));
    api<ProjectSnapshot>(
      `/api/projects/${encodeURIComponent(project.state.projectId)}/asset-plan/amend`,
      {
        method: "POST",
        body: JSON.stringify({ section, request }),
      },
    )
      .then((next) => {
        onSnapshot?.(next);
        setAmendmentRequests((current) => ({
          ...current,
          [section]: "",
        }));
      })
      .catch((cause: unknown) => {
        setAmendmentErrors((current) => ({
          ...current,
          [section]: isApiError(cause)
            ? cause.detail
            : cause instanceof Error
              ? cause.message
              : "Fulcrum could not amend this section.",
        }));
      })
      .finally(() => setAmendingSection(null));
  };

  const openNextUnresolved = () => {
    if (!selected || assets.length === 0) return;
    const currentIndex = assets.findIndex(
      (asset) => asset.assetId === selected.assetId,
    );
    for (let offset = 1; offset <= assets.length; offset += 1) {
      const candidate = assets[(currentIndex + offset) % assets.length]!;
      if (states[candidate.assetId]?.status !== "resolved") {
        setSelectedId(candidate.assetId);
        return;
      }
    }
  };

  if (assets.length === 0)
    return (
      <section className="agp agp-empty">
        <PrototypeMark state={project.state} />
        <h1>No planned assets yet.</h1>
        <p>The Images stage will appear after the asset plan is ready.</p>
      </section>
    );

  const selectedState = selected ? states[selected.assetId] : undefined;
  const creditPlan = gateCreditPlan(
    assets.map((asset) => ({
      meshyRouted: isMeshyRouted(asset),
      stage: stages[asset.assetId],
    })),
  );
  const remainingCredits = remainingMeshyCredits(project);

  if (stagedAssetId)
    return (
      <div className="agp">
        <StagedAssetScreen
          assetId={stagedAssetId}
          onBack={() => setStagedAssetId(null)}
          onSnapshot={(next) => onSnapshot?.(next)}
          project={project}
        />
      </div>
    );

  return (
    <div className="agp">
      {stageError && (
        <p className="agp-staged-error" role="alert">
          {stageError}
        </p>
      )}
      {selected && selectedState ? (
        <FocusedAsset
          asset={selected}
          assets={assets}
          onApprove={approve}
          onBack={() => {
            setSelectedId(null);
          }}
          onGenerate={generate}
          onImagePrompt={setImagePrompt}
          onMeshyPrompt={setMeshyPrompt}
          onNext={openNextUnresolved}
          onPath={selectPath}
          onRetry={retryFailed}
          onUpload={upload}
          approving={approving === selected.assetId}
          approveError={approveError}
          resolvedCount={resolvedCount}
          projectState={project.state}
          state={selectedState}
          states={states}
          styleCapsule={styleCapsule}
        />
      ) : (
        <Overview
          amendmentErrors={amendmentErrors}
          amendmentRequests={amendmentRequests}
          amendingSection={amendingSection}
          assets={assets}
          onAmend={amendSection}
          onAmendmentRequest={(section, request) => {
            setAmendmentRequests((current) => ({
              ...current,
              [section]: request,
            }));
            if (amendmentErrors[section])
              setAmendmentErrors((current) => ({
                ...current,
                [section]: undefined,
              }));
          }}
          onOpen={(assetId) => {
            setSelectedId(assetId);
          }}
          onOpenStage={(assetId) => setStagedAssetId(assetId)}
          onOverrideRig={overrideRig}
          onStart={startStage}
          creditPlan={creditPlan}
          projectState={project.state}
          remainingCredits={remainingCredits}
          resolvedCount={resolvedCount}
          stages={stages}
          overridingRig={overridingRig}
          starting={starting}
          states={states}
        />
      )}
    </div>
  );
}
