import { describe, expect, it } from "vitest";

import { ApiError } from "../api.js";
import {
  allSlotsSelected,
  assetFlowOwner,
  budgetRaisePrompt,
  choreographySafetyDelay,
  choreographyStep,
  currentRound,
  describeStudioError,
  directionSha256,
  firstOpenSlotId,
  formatElapsed,
  hotbarForSnapshot,
  initialConceptReviewViewState,
  liveGeneratingCopy,
  mascotForSnapshot,
  modelWaitForSnapshot,
  modelWaitForWorking,
  nextReviewSlotId,
  recordedAnswers,
  pastedImageItems,
  attachmentRoom,
  attachmentLimitMessage,
  attachmentDeliveryNote,
  clipboardCarriesText,
  reconcileConceptReviewView,
  routingCostNote,
  projectTitle,
  screenForSnapshot,
  showsMeshyCreditBudget,
  showsMeteredBudget,
  slotRevisionViews,
  soundRouteLabel,
  blockedBudgetKind,
  currentStageKey,
  hotbarNavigation,
  reviewGateRescue,
  stageHistoryScreen,
  stageHistoryUsesConceptHost,
  budgetRefusalKind,
  meshyCreditMeterView,
  moodCleanProse,
  moodCleanRules,
  moodPaletteWeight,
  moodSharedContent,
  studioCreateProjectInput,
  studioHrefForProject,
  studioStatus,
  suggestedNextBudgetUsd,
  usdSpendMeterView,
  voxelPaletteFromTokens,
  voxelWorldView,
  worldCardMeta,
} from "./snapshot-view.js";
import {
  M1InFlightActionSchema,
  type AssetPlan,
  type ConceptSlot,
  type VisualDirection,
} from "@fulcrum/domain";

const sha = (n: string) => n.repeat(64);

const baseState = {
  schemaVersion: 1 as const,
  milestone: "m1" as const,
  projectId: "p1",
  name: "M1 Creative Project",
  mode: "replay" as const,
  assetProvider: "meshy" as const,
  orchestratorProvider: "openai" as const,
  implementationProvider: "openai" as const,
  imageProvider: "none" as const,
  soundProvider: "none" as const,
  status: "awaiting-input" as const,
  stage: "interrogation" as const,
  runId: "run-1",
  budgetUsd: 1,
  spentUsd: 0,
  conceptReplacementCount: 0,
  brief: {
    entityId: "brief",
    revisionId: "brief-1",
    kind: "game-brief",
    artifact: {
      artifactId: "a1",
      sha256: sha("1"),
      mediaType: "application/json",
      byteLength: 12,
      uri: "/api/artifacts/a1",
    },
    createdAt: "2026-08-21T00:00:00.000Z",
    createdByRunId: "run-1",
  },
  createdAt: "2026-08-21T00:00:00.000Z",
  updatedAt: "2026-08-21T00:00:00.000Z",
};

const revisionRef = (entityId: string, revisionId: string, kind: string) => ({
  entityId,
  revisionId,
  kind,
  artifact: {
    artifactId: `${revisionId}-artifact`,
    sha256: sha("9"),
    mediaType: "application/json",
    byteLength: 12,
    uri: `/api/artifacts/${revisionId}-artifact`,
  },
  createdAt: "2026-08-28T00:00:00.000Z",
  createdByRunId: "run-1",
});

const namesRevision = revisionRef(
  "p1:game-name-candidates",
  "names-1",
  "game-name-candidate-set",
);
const nameRevision = revisionRef(
  "p1:game-name",
  "name-1",
  "game-name-decision",
);

const assetPlanRef = revisionRef(
  "p1:asset-plan",
  "asset-plan-r2",
  "asset-plan",
);

/** The resolved document the studio renders; only its presence is read here. */
const resolvedPlan = {
  planId: "asset-plan-r2",
  assets: [],
} as unknown as AssetPlan;

describe("M1 snapshot adapter", () => {
  it("keeps the regenerated slot and new revision when a fresh snapshot advances the concept set", () => {
    const current = {
      ...initialConceptReviewViewState(),
      projectId: "p1",
      conceptSetRevisionId: "concept-set-r01",
      inspectingSlotId: "player-or-threat",
      viewedRevisionId: "player-or-threat-r02",
      regenNotes: "Make the threat read more clearly.",
    };

    expect(
      reconcileConceptReviewView(current, {
        state: {
          projectId: "p1",
          conceptSet: {
            entityId: "concept-set",
            revisionId: "concept-set-r02",
            kind: "concept-set",
            artifact: {
              artifactId: "concept-set-artifact",
              sha256: sha("c"),
              mediaType: "application/json",
              byteLength: 12,
              uri: "/api/artifacts/concept-set-artifact",
            },
            createdAt: "2026-08-24T00:00:00.000Z",
            createdByRunId: "run-1",
          },
        },
      }),
    ).toEqual({
      ...current,
      conceptSetRevisionId: "concept-set-r02",
    });
  });

  it("keeps concept review state when a poll reapplies the current snapshot", () => {
    const current = {
      ...initialConceptReviewViewState(),
      projectId: "p1",
      conceptSetRevisionId: "concept-set-r01",
      inspectingSlotId: "player-or-threat",
      viewedRevisionId: "player-or-threat-r01",
      regenNotes: "A draft note that the poll must not erase.",
    };

    expect(
      reconcileConceptReviewView(current, {
        state: {
          projectId: "p1",
          conceptSet: {
            entityId: "concept-set",
            revisionId: "concept-set-r01",
            kind: "concept-set",
            artifact: {
              artifactId: "concept-set-artifact",
              sha256: sha("c"),
              mediaType: "application/json",
              byteLength: 12,
              uri: "/api/artifacts/concept-set-artifact",
            },
            createdAt: "2026-08-24T00:00:00.000Z",
            createdByRunId: "run-1",
          },
        },
      }),
    ).toBe(current);
  });

  it("maps coordinator stages onto studio screens", () => {
    expect(
      screenForSnapshot({
        state: { ...baseState, stage: "interrogation" },
        interrogation: {
          rounds: [],
          frontier: [
            {
              questionId: "q1",
              branchId: "gameplay.core-loop",
              prompt: "Loop?",
              recommendation: "Name the loop.",
            },
          ],
        },
      }),
    ).toBe("interrogation");
    expect(
      screenForSnapshot({
        state: { ...baseState, stage: "interrogation" },
        interrogation: { rounds: [], frontier: [] },
      }),
    ).toBe("shared-understanding");
    /* The naming conversation is the tail of the brief stage: candidates
       proposed, no name settled yet. */
    expect(
      screenForSnapshot({
        state: {
          ...baseState,
          stage: "interrogation",
          gameNameCandidates: namesRevision,
        },
        interrogation: { rounds: [], frontier: [] },
      }),
    ).toBe("game-name");
    expect(
      screenForSnapshot({
        state: {
          ...baseState,
          stage: "interrogation",
          gameNameCandidates: namesRevision,
          gameName: nameRevision,
        },
        interrogation: { rounds: [], frontier: [] },
      }),
    ).toBe("shared-understanding");
    expect(
      screenForSnapshot({
        state: { ...baseState, stage: "game-design-approval" },
      }),
    ).toBe("game-design");
    expect(
      screenForSnapshot({
        state: { ...baseState, stage: "visual-direction-approval" },
      }),
    ).toBe("visual-direction");
    expect(
      screenForSnapshot({
        state: { ...baseState, stage: "concept-planning" },
      }),
    ).toBe("concept-plan");
    expect(
      screenForSnapshot({
        state: { ...baseState, stage: "concept-set-approval" },
      }),
    ).toBe("concept-review");
    expect(
      screenForSnapshot({
        state: { ...baseState, stage: "sound-planning" },
      }),
    ).toBe("sound-plan");
    expect(
      screenForSnapshot({
        state: { ...baseState, stage: "sound-set-approval" },
      }),
    ).toBe("sound-review");
    expect(
      screenForSnapshot({ state: { ...baseState, stage: "complete" } }),
    ).toBe("complete");
    expect(
      screenForSnapshot({ state: { ...baseState, stage: "blocked" } }),
    ).toBe("blocked");
  });

  it("maps the transient finalization stage straight to the asset gate", () => {
    const m2State = { ...baseState, milestone: "m2" as const };
    expect(
      screenForSnapshot({ state: { ...m2State, stage: "asset-planning" } }),
    ).toBe("asset-planning");
    expect(
      screenForSnapshot({
        state: { ...m2State, stage: "asset-plan-approval" },
      }),
    ).toBe("asset-batch");
    expect(
      screenForSnapshot({ state: { ...m2State, stage: "asset-batch" } }),
    ).toBe("asset-batch");
    expect(
      screenForSnapshot({
        state: { ...m2State, stage: "concept-set-approval" },
      }),
    ).toBe("concept-review");
  });

  it("gives the gate every asset stage except the one that rewrites the plan", () => {
    const m2State = {
      ...baseState,
      milestone: "m2" as const,
      assetPlan: assetPlanRef,
    };
    for (const stage of [
      "asset-plan-approval",
      "asset-batch",
      "complete",
      "blocked",
    ] as const)
      expect(
        assetFlowOwner({
          state: { ...m2State, stage },
          assetPlan: resolvedPlan,
        }),
      ).toBe("gate");
    /* A later plan amendment can leave the old plan in state while the stage
       steps back to planning. The planning screen owns that transition. */
    expect(
      assetFlowOwner({
        state: { ...m2State, stage: "asset-planning" },
        assetPlan: resolvedPlan,
      }),
    ).toBe("stage");
    expect(
      assetFlowOwner({
        state: { ...m2State, stage: "asset-plan-approval" },
        assetPlan: undefined,
      }),
    ).toBe("stage");
    expect(
      assetFlowOwner({
        state: { ...baseState, stage: "concept-set-approval" },
        assetPlan: resolvedPlan,
      }),
    ).toBe("stage");
  });

  it("uses an assets hotbar slot for M2 while retaining the M1 sounds slot", () => {
    const m1 = hotbarForSnapshot({ state: baseState });
    const m2 = hotbarForSnapshot({
      state: {
        ...baseState,
        milestone: "m2",
        stage: "asset-plan-approval",
        conceptSetApproval: {
          approvalId: "concept-approval",
          projectId: "p1",
          targetType: "concept-set",
          targetRevisionId: "concept-set-r1",
          targetSha256: "c".repeat(64),
          decision: "approved",
          decidedBy: "local-user",
          decidedAt: "2026-08-24T00:00:00.000Z",
        },
      },
    });

    expect(m1.at(-1)?.label).toBe("SOUNDS");
    expect(m2.at(-1)).toMatchObject({
      key: "assets",
      label: "ASSETS",
      active: true,
      status: "Resolving assets",
    });
  });

  it("keeps the brief slot active and unfilled while the game is being named", () => {
    const slots = hotbarForSnapshot({
      state: {
        ...baseState,
        stage: "interrogation",
        gameNameCandidates: namesRevision,
      },
      interrogation: { rounds: [], frontier: [] },
    });

    expect(slots.find((slot) => slot.key === "brief")).toMatchObject({
      active: true,
      filled: false,
      status: "Naming the game",
    });
    /* Color & mood stays locked: the brief is not signed off until the name
       is settled and the spec exists. */
    expect(slots.find((slot) => slot.key === "style")?.locked).toBe(true);
  });

  it("prefers the decided name over the spec title and the brief", () => {
    expect(
      projectTitle({
        briefText: "A cozy tide-pool salvage game.",
        gameDesignSpec: { title: "A Cozy Tide-pool Salvage Game" } as never,
        gameName: { name: "Lanternfall" } as never,
      }),
    ).toBe("Lanternfall");
    expect(
      projectTitle({
        briefText: "A cozy tide-pool salvage game.",
        gameDesignSpec: { title: "A Cozy Tide-pool Salvage Game" } as never,
      }),
    ).toBe("A Cozy Tide-pool Salvage Game");
    expect(projectTitle({ briefText: "A cozy tide-pool salvage game." })).toBe(
      "A cozy tide-pool salvage game.",
    );
  });

  it("marks the furthest reached hotbar slot as blocked, and only that one", () => {
    const slots = hotbarForSnapshot({
      state: {
        ...baseState,
        milestone: "m2",
        stage: "blocked",
        status: "blocked",
        conceptSetApproval: {
          approvalId: "concept-approval",
          projectId: "p1",
          targetType: "concept-set",
          targetRevisionId: "concept-set-r1",
          targetSha256: "c".repeat(64),
          decision: "approved",
          decidedBy: "local-user",
          decidedAt: "2026-08-24T00:00:00.000Z",
        },
        blockedReason: {
          code: "submission-unknown",
          message: "The paid asset request may have succeeded.",
          recoverable: true,
        },
      },
    });

    expect(slots.filter((slot) => slot.blocked)).toHaveLength(1);
    expect(slots.at(-1)).toMatchObject({
      key: "assets",
      blocked: true,
      active: false,
      status: "Blocked",
    });
  });

  it("reads the open frontier round and recorded answers from snapshot rounds", () => {
    const snapshot = {
      interrogation: {
        frontier: [
          {
            questionId: "q2",
            branchId: "presentation.camera-readability",
            prompt: "Camera?",
            recommendation: "Keep it simple.",
          },
        ],
        rounds: [
          {
            roundId: "round-1",
            questions: [
              {
                questionId: "q1",
                branchId: "gameplay.core-loop",
                prompt: "Loop?",
                recommendation: "Name the loop.",
              },
            ],
            answers: [
              {
                questionId: "q1",
                value: "Sneak, hide, escape.",
                origin: { source: "user" as const },
              },
            ],
            createdAt: "2026-08-21T00:00:00.000Z",
            completedAt: "2026-08-21T00:01:00.000Z",
          },
          {
            roundId: "round-2",
            questions: [
              {
                questionId: "q2",
                branchId: "presentation.camera-readability",
                prompt: "Camera?",
                recommendation: "Keep it simple.",
              },
            ],
            answers: [],
            createdAt: "2026-08-21T00:02:00.000Z",
          },
        ],
      },
    };
    expect(currentRound(snapshot)?.roundId).toBe("round-2");
    expect(recordedAnswers(snapshot)).toEqual([
      expect.objectContaining({
        roundId: "round-1",
        value: "Sneak, hide, escape.",
      }),
    ]);
  });

  it("pairs concept revisions with snapshot documents and reports selection", () => {
    const slot: ConceptSlot = {
      slotId: "hero",
      name: "Caretaker",
      purpose: "Player silhouette",
      selectedRevisionId: undefined,
      revisions: [
        {
          revision: {
            entityId: "c1",
            revisionId: "rev-1",
            kind: "concept-document",
            artifact: {
              artifactId: "img-1",
              sha256: sha("2"),
              mediaType: "image/png",
              byteLength: 12,
              uri: "/api/artifacts/img-1",
            },
            createdAt: "2026-08-21T00:00:00.000Z",
            createdByRunId: "run-1",
          },
          inheritedVisualTokens: [
            {
              tokenId: "t1",
              category: "style",
              value: "painterly",
            },
          ],
        },
      ],
    };
    const snapshot = {
      conceptSet: {
        conceptSetId: "set-1",
        sourceDirectionRevisionId: "dir-1",
        slots: [slot],
      },
      conceptDocuments: {
        hero: [
          {
            conceptId: "p1:hero",
            name: "Caretaker r01",
            prompt: "A readable caretaker",
            negativePrompt: "",
            image: {
              artifactId: "img-1",
              sha256: sha("2"),
              mediaType: "image/png",
              byteLength: 12,
              uri: "/api/artifacts/img-1",
            },
            provider: "fulcrum-replay",
            model: "m1-replay-svg-v1",
            sourceRevisionIds: ["gds-1", "dir-1"],
            ancestors: [
              {
                revisionId: "gds-1",
                sha256: sha("3"),
                kind: "game-design-spec",
              },
              {
                revisionId: "dir-1",
                sha256: sha("4"),
                kind: "structured-visual-bible",
              },
            ],
            costUsd: 0,
          },
        ],
      },
      state: {
        ...baseState,
        conceptRegenerationCounts: { hero: 1 },
      },
    };
    const views = slotRevisionViews(snapshot, slot);
    expect(views[0]?.label).toBe("r01");
    expect(views[0]?.document?.image.uri).toBe("/api/artifacts/img-1");
    expect(allSlotsSelected(snapshot)).toBe(false);
    expect(firstOpenSlotId(snapshot)).toBe("hero");
    expect(views.map((view) => view.label)).toEqual(["r01"]);
  });

  it("labels arbitrarily many slot revisions without capping at r01", () => {
    const slot: ConceptSlot = {
      slotId: "hero",
      name: "Caretaker",
      purpose: "Player silhouette",
      revisions: Array.from({ length: 6 }, (_, index) => ({
        revision: {
          entityId: "c1",
          revisionId: `rev-${index + 1}`,
          kind: "concept-document",
          artifact: {
            artifactId: `img-${index + 1}`,
            sha256: sha(String(index + 1)),
            mediaType: "image/png",
            byteLength: 12,
            uri: `/api/artifacts/img-${index + 1}`,
          },
          createdAt: "2026-08-21T00:00:00.000Z",
          createdByRunId: "run-1",
        },
        inheritedVisualTokens: [
          { tokenId: "t1", category: "style", value: "painterly" },
        ],
      })),
    };
    expect(
      slotRevisionViews({ conceptDocuments: {} }, slot).map(
        (view) => view.label,
      ),
    ).toEqual(["r01", "r02", "r03", "r04", "r05", "r06"]);
  });

  it("moves Continue off a revisited slot instead of pinning it in place", () => {
    const slotAt = (slotId: string, selected: string | undefined) =>
      ({
        slotId,
        name: slotId,
        purpose: slotId,
        revisions: [],
        ...(selected ? { selectedRevisionId: selected } : {}),
      }) as ConceptSlot;
    const setOf = (...slots: ConceptSlot[]) => ({
      conceptSet: {
        conceptSetId: "set-1",
        sourceDirectionRevisionId: "dir-1",
        slots,
      },
    });

    // The reported dead button: image 1 was already kept while image 2 is
    // still open, so Continue has to land on image 2.
    expect(
      nextReviewSlotId(
        setOf(slotAt("anchor", "rev-1"), slotAt("context", undefined)),
        "anchor",
      ),
    ).toBe("context");
    // Already-kept slots downstream are skipped, not re-shown.
    expect(
      nextReviewSlotId(
        setOf(
          slotAt("anchor", "rev-1"),
          slotAt("context", "rev-2"),
          slotAt("threat", undefined),
        ),
        "anchor",
      ),
    ).toBe("threat");
    // Keeping the last open slot wraps back to an earlier open one.
    expect(
      nextReviewSlotId(
        setOf(
          slotAt("anchor", undefined),
          slotAt("context", "rev-2"),
          slotAt("threat", "rev-3"),
        ),
        "threat",
      ),
    ).toBe("anchor");
    // Every slot kept means the package screen, not another slot.
    expect(
      nextReviewSlotId(
        setOf(slotAt("anchor", "rev-1"), slotAt("context", "rev-2")),
        "context",
      ),
    ).toBeUndefined();
    // A slot id that is no longer in the set falls back to the first open one.
    expect(
      nextReviewSlotId(
        setOf(slotAt("anchor", "rev-1"), slotAt("context", undefined)),
        "gone",
      ),
    ).toBe("context");
    expect(
      nextReviewSlotId({ conceptSet: undefined }, "anchor"),
    ).toBeUndefined();
  });

  it("exposes direction revision hashes from the additive snapshot field", () => {
    expect(
      directionSha256(
        {
          visualDirectionRevisions: {
            "dir-1": {
              entityId: "dir-1",
              revisionId: "dir-1",
              kind: "structured-visual-bible",
              artifact: {
                artifactId: "d1",
                sha256: sha("a"),
                mediaType: "application/json",
                byteLength: 8,
                uri: "/api/artifacts/d1",
              },
              createdAt: "2026-08-21T00:00:00.000Z",
              createdByRunId: "run-1",
            },
          },
        },
        "dir-1",
      ),
    ).toBe(sha("a"));
  });

  it("marks budget refusals as retryable and uses the live generating copy", () => {
    expect(
      describeStudioError(
        new ApiError(
          "Budget exhausted: ImageGen requires $0.01.",
          500,
          "budget-refused",
        ),
      ),
    ).toEqual({
      kind: "budget",
      title: "Budget cap reached",
      message: "Budget exhausted: ImageGen requires $0.01.",
      budgetRefused: true,
      creditsRefused: false,
    });
    expect(liveGeneratingCopy("live")).toBe(
      "Generating with your OpenAI subscription…",
    );
    expect(liveGeneratingCopy("replay")).toBe("Building replay concepts…");
  });

  it("turns a pinned-aspect refusal into specific recovery copy", () => {
    expect(
      describeStudioError(
        new Error("The focused change altered pinned aspect palette."),
      ),
    ).toEqual({
      kind: "pinned-aspect",
      title: "Focused change not applied",
      message:
        "Palette changed even though it is pinned, so Fulcrum kept the current direction.",
      guidance:
        "Adjust the note or unpin palette, then try again. Your note is still here.",
      pinnedAspect: "palette",
      budgetRefused: false,
      creditsRefused: false,
    });
  });

  it("presents duplicate-action rejection as a calm working notice", () => {
    expect(
      describeStudioError(
        new Error("Project p1 is already processing change."),
      ),
    ).toEqual({
      kind: "in-flight",
      title: "Previous request still working",
      message: "Fulcrum is still applying the focused change.",
      guidance: "Wait for it to finish before starting another request.",
      budgetRefused: false,
      creditsRefused: false,
    });
  });

  it("presents subscription quota pressure as a dismissible warning", () => {
    expect(
      describeStudioError(
        new ApiError(
          "OpenAI subscription usage is temporarily limited.",
          500,
          "subscription-quota",
        ),
      ),
    ).toEqual({
      kind: "quota",
      title: "Subscription limit reached",
      message: "OpenAI subscription usage is temporarily limited.",
      guidance:
        "Wait for the subscription allowance to reset, then try this generation again.",
      budgetRefused: false,
      creditsRefused: false,
    });
  });

  it("describes budget and sound routes from the selected providers", () => {
    expect(showsMeteredBudget(baseState)).toBe(false);
    expect(showsMeteredBudget({ ...baseState, milestone: "m0" })).toBe(false);
    expect(routingCostNote(baseState)).toBe(
      "Replay and local generators use no metered services.",
    );
    const subscription = {
      ...baseState,
      mode: "live" as const,
      imageProvider: "openai-subscription" as const,
    };
    expect(showsMeteredBudget(subscription)).toBe(false);
    expect(showsMeteredBudget({ ...subscription, milestone: "m2" })).toBe(
      false,
    );
    expect(showsMeshyCreditBudget({ ...subscription, milestone: "m2" })).toBe(
      true,
    );
    expect(routingCostNote(subscription)).toBe(
      "Runs on your OpenAI subscription · no metered spend.",
    );
    expect(
      showsMeteredBudget({
        ...subscription,
        soundProvider: "elevenlabs",
      }),
    ).toBe(true);
    expect(soundRouteLabel(baseState)).toBe("Replay · deterministic WAV");
    expect(soundRouteLabel(subscription)).toBe("None · deterministic WAV");
    expect(
      soundRouteLabel({ ...subscription, soundProvider: "elevenlabs" }),
    ).toBe("ElevenLabs · text-to-sound");
  });

  it("includes the required budget in a live M2 create payload", () => {
    const brief =
      "Create a compact lunar greenhouse stealth game with one readable escape route.";
    const input = {
      milestone: "m2" as const,
      brief: `  ${brief}  `,
      mode: "live" as const,
      orchestratorProvider: "openai" as const,
      implementationProvider: "openai" as const,
      imageProvider: "openai-subscription" as const,
      soundProvider: "none" as const,
      budgetUsd: 2.5,
      meshyCreditBudget: 300,
    };

    expect(showsMeteredBudget(input)).toBe(false);
    expect(showsMeshyCreditBudget(input)).toBe(true);
    expect(studioCreateProjectInput(input)).toEqual({
      milestone: "m2",
      brief,
      mode: "live",
      orchestratorProvider: "openai",
      implementationProvider: "openai",
      imageProvider: "openai-subscription",
      soundProvider: "none",
      meshyCreditBudget: 300,
      rightsConfirmed: true,
    });
  });

  it("suggests a one-dollar raise and maps bible palettes onto voxel tints", () => {
    expect(suggestedNextBudgetUsd(1)).toBe(2);
    expect(suggestedNextBudgetUsd(0.5)).toBe(1.5);
    expect(
      budgetRaisePrompt({
        state: { ...baseState, budgetUsd: 1.25, spentUsd: 0.03 },
      }),
    ).toEqual({
      spentUsd: 0.03,
      budgetUsd: 1.25,
      suggestedBudgetUsd: 2.25,
    });
    expect(
      voxelPaletteFromTokens([
        { hex: "#173B36" },
        { hex: "#B76647" },
        { hex: "#F6D36B" },
      ]),
    ).toEqual(["#173B36", "#B76647", "#F6D36B", "#F6D36B", "#F6D36B"]);
    expect(voxelPaletteFromTokens([])).toEqual([]);
    const folkcraftBible = {
      title: "Luminous Folkcraft",
      overallStyle: "folkcraft",
      shapeLanguage: "rounded",
      architecture: "stacked",
      heroProp: "lantern",
      materials: ["timber"],
      palette: [
        { name: "Deep pine", hex: "#173B36", role: "primary mass" },
        { name: "Clay", hex: "#B76647", role: "warm accent" },
        { name: "Lantern", hex: "#F6D36B", role: "gameplay focus" },
      ],
      lighting: "soft",
      atmosphere: "pollen",
      cameraLanguage: "side",
      textureLanguage: "carved",
      readabilityRules: ["keep the objective bright"],
      prohibitedStyles: [] as string[],
    };
    expect(
      voxelWorldView({
        state: baseState,
        visualBible: folkcraftBible,
      }),
    ).toEqual({ styled: false, palette: [], directionName: undefined });
    expect(
      voxelWorldView({
        state: {
          ...baseState,
          directionApproval: {
            approvalId: "a2",
            projectId: "p1",
            targetType: "visual-direction",
            targetRevisionId: "dir-1",
            targetSha256: sha("d"),
            decision: "approved",
            decidedBy: "user",
            decidedAt: "2026-08-21T00:04:00.000Z",
          },
        },
        visualBible: folkcraftBible,
      }),
    ).toEqual({
      styled: true,
      palette: ["#173B36", "#B76647", "#F6D36B", "#F6D36B", "#F6D36B"],
      directionName: "Luminous Folkcraft",
    });
  });

  it("locks later hotbar slots until the snapshot has reached them", () => {
    const slots = hotbarForSnapshot({
      state: baseState,
      interrogation: {
        rounds: [
          {
            roundId: "round-1",
            questions: [
              {
                questionId: "q1",
                branchId: "gameplay.core-loop",
                prompt: "Loop?",
                recommendation: "Name the loop.",
              },
            ],
            answers: [],
            createdAt: "2026-08-21T00:00:00.000Z",
          },
        ],
        frontier: [
          {
            questionId: "q1",
            branchId: "gameplay.core-loop",
            prompt: "Loop?",
            recommendation: "Name the loop.",
          },
        ],
      },
    });
    expect(slots.find((slot) => slot.key === "style")?.locked).toBe(true);
    expect(slots.find((slot) => slot.key === "images")?.locked).toBe(true);
    expect(slots.find((slot) => slot.key === "sounds")?.locked).toBe(true);
    expect(slots.find((slot) => slot.key === "brief")?.active).toBe(true);
  });
});

const answeredRound = {
  roundId: "round-1",
  questions: [
    {
      questionId: "q1",
      branchId: "gameplay.core-loop",
      prompt: "Loop?",
      recommendation: "Name the loop.",
    },
    {
      questionId: "q2",
      branchId: "presentation.camera-readability",
      prompt: "Camera?",
      recommendation: "Keep it simple.",
    },
  ],
  answers: [
    {
      questionId: "q1",
      value: "Sneak, hide, escape.",
      origin: { source: "user" as const },
    },
    {
      questionId: "q2",
      value: "Side-on.",
      origin: { source: "user" as const },
    },
  ],
  createdAt: "2026-08-21T00:00:00.000Z",
  completedAt: "2026-08-21T00:01:00.000Z",
};

const slot = (slotId: string, selectedRevisionId?: string) => ({
  slotId,
  name: slotId,
  purpose: "Silhouette",
  revisions: [] as ConceptSlot["revisions"],
  ...(selectedRevisionId ? { selectedRevisionId } : {}),
});

describe("mascotForSnapshot", () => {
  it("parks on start with zero decisions before a project exists", () => {
    expect(mascotForSnapshot(null)).toEqual({
      screen: "start",
      decisions: 0,
      visible: true,
    });
  });

  it("counts project creation and completed answers on the question screen", () => {
    expect(
      mascotForSnapshot({
        state: baseState,
        interrogation: {
          rounds: [answeredRound],
          frontier: [
            {
              questionId: "q3",
              branchId: "tone.mood",
              prompt: "Mood?",
              recommendation: "Quiet.",
            },
          ],
        },
      }),
    ).toEqual({ screen: "question", decisions: 3, visible: true });
  });

  it("stays on signoff until shared understanding is confirmed", () => {
    expect(
      mascotForSnapshot({
        state: baseState,
        interrogation: { rounds: [answeredRound], frontier: [] },
      }),
    ).toEqual({ screen: "signoff", decisions: 3, visible: true });
  });

  it("is monotonic as the snapshot advances, including after a mid-flow reload", () => {
    const interrogationDone = {
      rounds: [answeredRound],
      frontier: [] as [],
      sharedUnderstanding: {
        confirmed: true as const,
        confirmedBy: "user",
        confirmedAt: "2026-08-21T00:02:00.000Z",
      },
    };
    const gdsApproval = {
      approvalId: "a1",
      projectId: "p1",
      targetType: "game-design" as const,
      targetRevisionId: "gds-1",
      targetSha256: sha("g"),
      decision: "approved" as const,
      decidedBy: "user",
      decidedAt: "2026-08-21T00:03:00.000Z",
    };
    const directionApproval = {
      approvalId: "a2",
      projectId: "p1",
      targetType: "visual-direction" as const,
      targetRevisionId: "dir-1",
      targetSha256: sha("d"),
      decision: "approved" as const,
      decidedBy: "user",
      decidedAt: "2026-08-21T00:04:00.000Z",
    };
    const created = mascotForSnapshot({
      state: baseState,
      interrogation: { rounds: [], frontier: [] },
    }).decisions;
    const answered = mascotForSnapshot({
      state: baseState,
      interrogation: { rounds: [answeredRound], frontier: [] },
    }).decisions;
    const understood = mascotForSnapshot({
      state: { ...baseState, stage: "game-design-approval" },
      interrogation: interrogationDone,
    });
    const gdsApproved = mascotForSnapshot({
      state: {
        ...baseState,
        stage: "visual-direction-approval",
        gameDesignApproval: gdsApproval,
      },
      interrogation: interrogationDone,
    });
    const directionApproved = mascotForSnapshot({
      state: {
        ...baseState,
        stage: "concept-planning",
        gameDesignApproval: gdsApproval,
        directionApproval,
      },
      interrogation: interrogationDone,
    });
    const oneSlot = mascotForSnapshot({
      state: {
        ...baseState,
        stage: "concept-set-approval",
        gameDesignApproval: gdsApproval,
        directionApproval,
      },
      interrogation: interrogationDone,
      conceptSet: {
        conceptSetId: "set-1",
        sourceDirectionRevisionId: "dir-1",
        slots: [slot("hero", "rev-1"), slot("creature"), slot("place")],
      },
    });
    const packaged = mascotForSnapshot({
      state: {
        ...baseState,
        stage: "concept-set-approval",
        gameDesignApproval: gdsApproval,
        directionApproval,
      },
      interrogation: interrogationDone,
      conceptSet: {
        conceptSetId: "set-1",
        sourceDirectionRevisionId: "dir-1",
        slots: [
          slot("hero", "rev-1"),
          slot("creature", "rev-2"),
          slot("place", "rev-3"),
        ],
      },
    });
    const soundPlanned = mascotForSnapshot({
      state: {
        ...baseState,
        stage: "sound-planning",
        gameDesignApproval: gdsApproval,
        directionApproval,
        conceptSetApproval: {
          approvalId: "a3",
          projectId: "p1",
          targetType: "concept-set",
          targetRevisionId: "set-1",
          targetSha256: sha("c"),
          decision: "approved",
          decidedBy: "user",
          decidedAt: "2026-08-21T00:05:00.000Z",
        },
      },
      interrogation: interrogationDone,
      conceptSet: {
        conceptSetId: "set-1",
        sourceDirectionRevisionId: "dir-1",
        slots: [
          slot("hero", "rev-1"),
          slot("creature", "rev-2"),
          slot("place", "rev-3"),
        ],
      },
    });
    const complete = mascotForSnapshot({
      state: {
        ...baseState,
        stage: "complete",
        gameDesignApproval: gdsApproval,
        directionApproval,
        conceptSetApproval: {
          approvalId: "a3",
          projectId: "p1",
          targetType: "concept-set",
          targetRevisionId: "set-1",
          targetSha256: sha("c"),
          decision: "approved",
          decidedBy: "user",
          decidedAt: "2026-08-21T00:05:00.000Z",
        },
        soundSetApproval: {
          approvalId: "a4",
          projectId: "p1",
          targetType: "sound-set",
          targetRevisionId: "snd-1",
          targetSha256: sha("s"),
          decision: "approved",
          decidedBy: "user",
          decidedAt: "2026-08-21T00:06:00.000Z",
        },
      },
      interrogation: interrogationDone,
      conceptSet: {
        conceptSetId: "set-1",
        sourceDirectionRevisionId: "dir-1",
        slots: [
          slot("hero", "rev-1"),
          slot("creature", "rev-2"),
          slot("place", "rev-3"),
        ],
      },
    });

    expect(created).toBe(1);
    expect(answered).toBe(3);
    expect(understood).toEqual({
      screen: "signoff",
      decisions: 4,
      /* The game-design-approval screen is a full-width reading layout: Rusty
         is hidden there via the data-mascot="off" pattern. */
      visible: false,
    });
    expect(gdsApproved).toEqual({
      screen: "direction",
      decisions: 5,
      visible: true,
    });
    expect(directionApproved).toEqual({
      screen: "concepts",
      decisions: 6,
      visible: true,
    });
    expect(oneSlot.decisions).toBe(7);
    expect(oneSlot.visible).toBe(true);
    expect(packaged).toEqual({
      screen: "package",
      decisions: 9,
      visible: true,
    });
    expect(soundPlanned).toEqual({
      screen: "concepts",
      decisions: 10,
      visible: true,
    });
    expect(complete).toEqual({
      screen: "package",
      decisions: 11,
      visible: true,
    });
    expect(created).toBeLessThan(answered);
    expect(answered).toBeLessThan(understood.decisions);
    expect(understood.decisions).toBeLessThan(gdsApproved.decisions);
    expect(gdsApproved.decisions).toBeLessThan(directionApproved.decisions);
    expect(directionApproved.decisions).toBeLessThan(oneSlot.decisions);
    expect(oneSlot.decisions).toBeLessThan(packaged.decisions);
    expect(packaged.decisions).toBeLessThan(soundPlanned.decisions);
    expect(soundPlanned.decisions).toBeLessThan(complete.decisions);
  });

  it("rebuilds the same decision count from stage when approval fields are missing", () => {
    expect(
      mascotForSnapshot({
        state: { ...baseState, stage: "concept-planning" },
      }).decisions,
    ).toBe(4);
  });

  it("hides on the game-design reading screen", () => {
    expect(
      mascotForSnapshot({
        state: { ...baseState, stage: "game-design-approval" },
        interrogation: { rounds: [answeredRound], frontier: [] },
      }).visible,
    ).toBe(false);
  });

  it("hides on single-slot review and on blocked", () => {
    expect(
      mascotForSnapshot(
        {
          state: { ...baseState, stage: "concept-set-approval" },
          conceptSet: {
            conceptSetId: "set-1",
            sourceDirectionRevisionId: "dir-1",
            slots: [slot("hero"), slot("creature")],
          },
        },
        { slotReview: true },
      ),
    ).toEqual({ screen: "concepts", decisions: 4, visible: false });
    expect(
      mascotForSnapshot({
        state: {
          ...baseState,
          stage: "blocked",
          blockedReason: {
            code: "budget-exhausted",
            message: "Stop.",
            recoverable: true,
          },
        },
      }),
    ).toEqual({ screen: "question", decisions: 1, visible: false });
  });
});

describe("formatElapsed", () => {
  it("formats seconds as m:ss", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(7)).toBe("0:07");
    expect(formatElapsed(59)).toBe("0:59");
    expect(formatElapsed(60)).toBe("1:00");
    expect(formatElapsed(98.8)).toBe("1:38");
    expect(formatElapsed(605)).toBe("10:05");
  });

  it("never goes negative", () => {
    expect(formatElapsed(-3)).toBe("0:00");
  });
});

describe("modelWaitForWorking", () => {
  it("maps every model-backed operation to a titled wait", () => {
    for (const label of [
      "create",
      ...M1InFlightActionSchema.options,
      "generate-sounds",
      "regenerate-sound",
    ]) {
      const view = modelWaitForWorking(label, "live");
      expect(view, label).toBeDefined();
      expect(view!.title.length).toBeGreaterThan(0);
      expect(view!.hint.length).toBeGreaterThan(0);
    }
  });

  it("uses the plain-words stage copy with real expectations", () => {
    expect(modelWaitForWorking("answers", "live")).toEqual({
      title: "Interrogation round underway…",
      hint: "Fulcrum is writing the next round · usually 15–40 seconds",
    });
    expect(modelWaitForWorking("confirm", "live")!.title).toBe(
      "Naming your game…",
    );
    expect(modelWaitForWorking("name-game", "live")!.title).toBe(
      "Writing the Game Design Spec…",
    );
    expect(modelWaitForWorking("name-game", "live")!.hint).toContain(
      "1–2 minutes",
    );
    expect(modelWaitForWorking("approve-gds", "live")!.title).toBe(
      "Inventing visual directions…",
    );
  });

  it("swaps the expectation line for replay projects", () => {
    expect(modelWaitForWorking("confirm", "replay")!.hint).toContain("Replay");
  });

  it("maps fast, model-free mutations to nothing", () => {
    for (const label of [
      "",
      "select",
      "approve-set",
      "approve-sounds",
      "approve-direction",
      "gds-decision",
      "raise-budget",
    ]) {
      expect(modelWaitForWorking(label, "live"), label).toBeUndefined();
    }
  });
});

describe("modelWaitForSnapshot", () => {
  it("derives the reload banner and preserves the server start time", () => {
    const startedAt = "2026-08-24T15:00:12.000Z";
    expect(
      modelWaitForSnapshot({
        state: baseState,
        inFlight: { action: "confirm", startedAt },
      }),
    ).toEqual({
      action: "confirm",
      startedAt,
      banner: {
        title: "Naming your game…",
        hint: "Replay is offline · this stays quick",
      },
    });
  });
});

describe("choreographyStep", () => {
  const MAX = 6;

  it("syncs instantly when the project changes (reload / open / home)", () => {
    expect(
      choreographyStep(
        { projectId: undefined, decisions: 0 },
        { projectId: "p1", decisions: 9, screen: "interrogation" },
        MAX,
      ),
    ).toEqual({ kind: "sync" });
    expect(
      choreographyStep(
        { projectId: "p1", decisions: 9 },
        { projectId: undefined, decisions: 0, screen: "home" },
        MAX,
      ),
    ).toEqual({ kind: "sync" });
  });

  it("does nothing when the decision count is unchanged", () => {
    expect(
      choreographyStep(
        { projectId: "p1", decisions: 5 },
        { projectId: "p1", decisions: 5, screen: "interrogation" },
        MAX,
      ),
    ).toEqual({ kind: "none" });
  });

  it("clamps down without choreography if the count ever shrinks", () => {
    expect(
      choreographyStep(
        { projectId: "p1", decisions: 5 },
        { projectId: "p1", decisions: 3, screen: "interrogation" },
        MAX,
      ),
    ).toEqual({ kind: "sync" });
  });

  it("queues one level-stride trip per world level in interrogation", () => {
    expect(
      choreographyStep(
        { projectId: "p1", decisions: 0 },
        { projectId: "p1", decisions: 4, screen: "interrogation" },
        MAX,
      ),
    ).toEqual({ kind: "trips", count: 4, stride: "level" });
    expect(
      choreographyStep(
        { projectId: "p1", decisions: 1 },
        { projectId: "p1", decisions: 5, screen: "interrogation" },
        MAX,
      ),
    ).toEqual({ kind: "trips", count: 4, stride: "level" });
    expect(
      choreographyStep(
        { projectId: "p1", decisions: 4 },
        { projectId: "p1", decisions: 8, screen: "interrogation" },
        MAX,
      ),
    ).toEqual({ kind: "trips", count: 2, stride: "level" });
  });

  it("collapses decisions past the blueprint cap into a single trip", () => {
    expect(
      choreographyStep(
        { projectId: "p1", decisions: 0 },
        { projectId: "p1", decisions: 8, screen: "interrogation" },
        MAX,
      ),
    ).toEqual({ kind: "trips", count: 6, stride: "level" });
    expect(
      choreographyStep(
        { projectId: "p1", decisions: 9 },
        { projectId: "p1", decisions: 13, screen: "interrogation" },
        MAX,
      ),
    ).toEqual({ kind: "trips", count: 1, stride: "level" });
    expect(
      choreographyStep(
        { projectId: "p1", decisions: 5 },
        { projectId: "p1", decisions: 9, screen: "interrogation" },
        MAX,
      ),
    ).toEqual({ kind: "trips", count: 1, stride: "level" });
  });

  it("keeps the prototype collapse on every non-interrogation screen", () => {
    expect(
      choreographyStep(
        { projectId: "p1", decisions: 5 },
        { projectId: "p1", decisions: 10, screen: "shared-understanding" },
        MAX,
      ),
    ).toEqual({ kind: "trips", count: 1, stride: "all" });
    expect(
      choreographyStep(
        { projectId: "p1", decisions: 10 },
        { projectId: "p1", decisions: 11, screen: "game-design" },
        MAX,
      ),
    ).toEqual({ kind: "trips", count: 1, stride: "all" });
  });
});

describe("choreographySafetyDelay", () => {
  const MAX = 6;

  it("gives every queued visible-level trip its own watchdog window", () => {
    expect(choreographySafetyDelay(0, 4, MAX)).toBe(96_000);
    expect(choreographySafetyDelay(4, 8, MAX)).toBe(48_000);
    expect(choreographySafetyDelay(5, 9, MAX)).toBe(24_000);
  });

  it("re-arms from the remaining queue after each placement", () => {
    expect(choreographySafetyDelay(1, 4, MAX)).toBe(72_000);
    expect(choreographySafetyDelay(3, 4, MAX)).toBe(24_000);
  });

  it("keeps one watchdog window for cap-collapsed work and none at truth", () => {
    expect(choreographySafetyDelay(6, 10, MAX)).toBe(24_000);
    expect(choreographySafetyDelay(10, 10, MAX)).toBeUndefined();
  });
});

/* ---------- budget refusals: two caps, one wire code ---------------------- */

describe("budget refusals", () => {
  const usdRefusal = new ApiError(
    "Budget exhausted: ImageGen requires $0.20, but only $0.05 remains.",
    500,
    "budget-refused",
  );
  const creditRefusal = new ApiError(
    "Meshy credit budget exhausted: hero-prop requires 30 credits, but 10 remain.",
    500,
    "budget-refused",
  );

  it("separates a Meshy credit stop from a USD stop under the same code", () => {
    expect(budgetRefusalKind(usdRefusal)).toBe("usd");
    expect(budgetRefusalKind(creditRefusal)).toBe("meshy-credits");
    expect(
      budgetRefusalKind(new Error("The forge could not read that brief.")),
    ).toBeUndefined();
  });

  it("routes a USD refusal to the raise-USD-budget flow", () => {
    const view = describeStudioError(usdRefusal);
    expect(view.kind).toBe("budget");
    expect(view.title).toBe("Budget cap reached");
    expect(view.budgetRefused).toBe(true);
    expect(view.creditsRefused).toBe(false);
  });

  it("routes a Meshy credit refusal to the raise-credit-cap flow", () => {
    const view = describeStudioError(creditRefusal);
    expect(view.kind).toBe("meshy-credits");
    expect(view.title).toBe("Meshy credit cap reached");
    /* The recovery a USD raise cannot buy must not be offered here. */
    expect(view.budgetRefused).toBe(false);
    expect(view.creditsRefused).toBe(true);
    expect(view.guidance).toContain("Meshy credit cap");
  });

  it("leaves a non-budget refusal on the generic path", () => {
    const view = describeStudioError(
      new Error("The forge refused: the brief names a real trademark."),
    );
    expect(view.kind).toBe("refusal");
    expect(view.budgetRefused).toBe(false);
    expect(view.creditsRefused).toBe(false);
  });

  it("reads a blocked project's cap from the stored refusal, not its routing", () => {
    expect(
      blockedBudgetKind({
        code: "budget-refused",
        message: creditRefusal.message,
      }),
    ).toBe("meshy-credits");
    expect(
      blockedBudgetKind({
        code: "budget-refused",
        message: usdRefusal.message,
      }),
    ).toBe("usd");
    expect(
      blockedBudgetKind({
        code: "submission-unknown",
        message: "We do not know if the Meshy credit charge landed.",
      }),
    ).toBeUndefined();
    expect(blockedBudgetKind(undefined)).toBeUndefined();
  });
});

/* ---------- the spend meter ---------------------------------------------- */

describe("spend meters", () => {
  it("splits a Meshy cap into billed, reserved and remaining", () => {
    const view = meshyCreditMeterView({
      meshyCreditBudget: 100,
      meshyCreditsConsumed: 20,
      meshyCreditsReserved: 20,
    })!;
    expect(view.usedPercent).toBe(20);
    expect(view.reservedPercent).toBe(20);
    expect(view.label).toBe("60 credits left");
    expect(view.ariaLabel).toBe(
      "Meshy credits: 20 used, 20 reserved, 60 credits left of 100 credits.",
    );
    expect(view.tone).toBe("steady");
  });

  it("shifts to amber past three quarters committed and red past nine tenths", () => {
    const at = (consumed: number) =>
      meshyCreditMeterView({
        meshyCreditBudget: 100,
        meshyCreditsConsumed: consumed,
        meshyCreditsReserved: 0,
      })!.tone;
    expect(at(75)).toBe("steady");
    expect(at(76)).toBe("attention");
    expect(at(90)).toBe("attention");
    expect(at(91)).toBe("alert");
  });

  it("has no meter to draw without a cap", () => {
    expect(meshyCreditMeterView({})).toBeUndefined();
    expect(usdSpendMeterView({ budgetUsd: 0, spentUsd: 0 })).toBeUndefined();
  });

  it("clamps a cap that reconciled past full instead of overdrawing the track", () => {
    const view = meshyCreditMeterView({
      meshyCreditBudget: 100,
      meshyCreditsConsumed: 90,
      meshyCreditsReserved: 40,
    })!;
    expect(view.usedPercent).toBe(90);
    expect(view.reservedPercent).toBe(10);
    expect(view.label).toBe("0 credits left");
    expect(view.tone).toBe("alert");
    expect(view.committedRatio).toBe(1);
  });

  it("draws dollars with no reserved run and drops it from the aria-label", () => {
    const view = usdSpendMeterView({ budgetUsd: 25, spentUsd: 5 })!;
    expect(view.usedPercent).toBe(20);
    expect(view.reservedPercent).toBe(0);
    expect(view.label).toBe("$20.00 left");
    expect(view.ariaLabel).toBe(
      "Metered spend: $5.00 used, $20.00 left of $25.00.",
    );
  });
});

/* ---------- one world list, both milestones ------------------------------- */

describe("worldCardMeta", () => {
  it("leads with the milestone so a merged list stays scannable", () => {
    expect(
      worldCardMeta({
        milestone: "m2",
        mode: "live",
        stage: "blocked",
        status: "blocked",
      }),
    ).toBe("m2 · live · Blocked");
  });

  it("keeps the mode and the shared status label it always showed", () => {
    expect(
      worldCardMeta({
        milestone: "m1",
        mode: "replay",
        stage: "visual-direction-approval",
        status: "awaiting-approval",
      }),
    ).toBe(
      `m1 · replay · ${
        studioStatus({
          stage: "visual-direction-approval",
          status: "awaiting-approval",
        }).label
      }`,
    );
  });
});

describe("studioHrefForProject", () => {
  it("points a cross-milestone world at the studio that can draw it", () => {
    expect(
      studioHrefForProject("http://localhost:4310/?studio=m1", {
        milestone: "m2",
        projectId: "p2",
      }),
    ).toBe("http://localhost:4310/?studio=m2&project=p2");
  });

  it("replaces a stale project param rather than appending to it", () => {
    expect(
      studioHrefForProject("http://localhost:4310/?studio=m2&project=p2", {
        milestone: "m1",
        projectId: "p1",
      }),
    ).toBe("http://localhost:4310/?studio=m1&project=p1");
  });

  it("keeps every unrelated param on the page", () => {
    expect(
      studioHrefForProject("http://localhost:4310/?studio=m1&debug=1", {
        milestone: "m2",
        projectId: "p2",
      }),
    ).toBe("http://localhost:4310/?studio=m2&debug=1&project=p2");
  });
});

/* ---------- the rail reads the shared formatter --------------------------- */

describe("hotbar tones", () => {
  it("gives the current tile the same tone the header pill wears", () => {
    const waiting = hotbarForSnapshot({
      state: {
        ...baseState,
        stage: "game-design-approval",
        status: "awaiting-approval",
      },
    });
    const current = waiting.find((slot) => slot.active);
    expect(current?.statusTone).toBe(
      studioStatus({
        stage: "game-design-approval",
        status: "awaiting-approval",
      }).tone,
    );
    expect(current?.statusTone).toBe("attention");
    expect(
      waiting.filter((slot) => slot.statusTone !== undefined),
    ).toHaveLength(1);
  });

  it("marks the blocked tile from the shared tone, not just the blocked stage", () => {
    const blocked = hotbarForSnapshot({
      state: { ...baseState, stage: "concept-planning", status: "blocked" },
    });
    expect(blocked.some((slot) => slot.blocked)).toBe(true);
    expect(blocked.find((slot) => slot.blocked)?.statusTone).toBe("blocked");
  });
});

/** One visual direction, differing from its siblings only where a test says
 *  so, so the shared-content diff has something real to hoist. */
const direction = (
  name: string,
  bible: Partial<VisualDirection["visualBible"]>,
): VisualDirection => ({
  directionId: `dir-${name}`,
  revisionId: `rev-${name}`,
  name,
  rationale:
    "Constraints: TBD. The greenhouse is lit only by grow lamps and one failing sodium strip.",
  visualBible: {
    title: name,
    overallStyle: "folkcraft",
    shapeLanguage: "rounded and soft",
    architecture: "stacked",
    heroProp: "lantern",
    materials: ["timber"],
    palette: [
      { name: "Deep pine", hex: "#173B36", role: "primary mass" },
      { name: "Clay", hex: "#B76647", role: "warm accent" },
      { name: "Lantern", hex: "#F6D36B", role: "gameplay focus" },
    ],
    lighting: "Warm key from below.",
    atmosphere: "Pollen hangs in every beam.",
    cameraLanguage: "Locked side-on.",
    textureLanguage: "Carved and planed.",
    readabilityRules: [
      "first-person.",
      "Alert colours stay legible for deuteranopia.",
    ],
    prohibitedStyles: ["photoreal noise"],
    tokens: [{ tokenId: "t1", category: "style", value: "folkcraft" }],
    ...bible,
  },
  preview: {
    artifact: {
      artifactId: `art-${name}`,
      uri: `file:///${name}.png`,
      mediaType: "image/png",
      sha256: sha("e"),
      byteLength: 1,
    },
    sourceGameDesignRevisionId: "gds-1",
    sourceVisualBibleRevisionId: "vb-1",
  },
});

/* ---------- mood helpers -------------------------------------------------- */

describe("mood helpers", () => {
  it("weights a swatch by the job the model gave the colour", () => {
    expect(moodPaletteWeight("primary mass")).toBe(4);
    expect(moodPaletteWeight("Background field")).toBe(4);
    expect(moodPaletteWeight("gameplay accent")).toBe(1.4);
    expect(moodPaletteWeight("emissive marker")).toBe(1.4);
    expect(moodPaletteWeight("secondary")).toBe(2.2);
    expect(moodPaletteWeight("")).toBe(2.2);
  });

  it("strips instruction scaffolding out of model prose", () => {
    expect(
      moodCleanProse(
        "Player fantasy: Name one observable accomplishment. The greenhouse is lit only by grow lamps.",
      ),
    ).toBe("The greenhouse is lit only by grow lamps.");
    /* A long lead is copy in its own right: it keeps the lead and loses only
       the order that follows it. */
    expect(
      moodCleanProse(
        "The corridor narrows toward the airlock and the light fails: Describe the intended emotional beat.",
      ),
    ).toBe("The corridor narrows toward the airlock and the light fails.");
    expect(moodCleanProse("Constraints: TBD.")).toBe("");
    expect(moodCleanProse("Too short.")).toBe("");
  });

  it("keeps only rules that are at least a clause", () => {
    expect(
      moodCleanRules([
        "first-person.",
        "Alert colours stay legible for deuteranopia.",
        "TBD",
      ]),
    ).toEqual(["Alert colours stay legible for deuteranopia."]);
  });

  it("hoists what every direction states identically", () => {
    const shared = moodSharedContent([
      direction("Ember", { lighting: "Warm key from below." }),
      direction("Frost", { lighting: "Cold key from above." }),
      direction("Ash", { lighting: "Cold key from above." }),
    ]);
    /* Lighting differs, so it stays on the cards. */
    expect(shared.facets).not.toContain("lighting");
    expect(shared.facets).toContain("atmosphere");
    expect(shared.readabilityRules).toEqual([
      "Alert colours stay legible for deuteranopia.",
    ]);
    expect(shared.prohibitedStyles).toEqual(["photoreal noise"]);
  });

  it("hoists nothing when there is only one direction to compare", () => {
    expect(moodSharedContent([direction("Ember", {})])).toEqual({
      facets: [],
      description: [],
      readabilityRules: [],
      prohibitedStyles: [],
    });
  });
});

/* ---------- the rescue affordance ---------------------------------------- */

describe("reviewGateRescue", () => {
  it("names the decision, not the failure, when a gate rejection blocked the world", () => {
    const rescue = reviewGateRescue({
      milestone: "m1",
      status: "blocked",
      blockedReason: {
        code: "concept-set-not-approved",
        message: "Concept set was not approved.",
        recoverable: true,
        failureKind: "user-action-required",
        resumeStage: "concept-set-approval",
        reviewGate: "concept-set",
      },
    });
    expect(rescue?.gate).toBe("concept-set");
    expect(rescue?.headline).toBe("You rejected the concept package.");
    expect(rescue?.actionLabel).toBe("Reopen concept set review");
    /* The promise the button has to keep: reopening is free. */
    expect(rescue?.body).toContain("Nothing is generated or spent");
  });

  it("rescues legacy rejection blocks that carry only the code", () => {
    expect(
      reviewGateRescue({
        milestone: "m1",
        status: "blocked",
        blockedReason: {
          code: "visual-direction-not-approved",
          message: "Not approved.",
          recoverable: false,
        },
      })?.gate,
    ).toBe("visual-direction");
  });

  it("leaves a workflow failure alone — there is no review to reopen", () => {
    expect(
      reviewGateRescue({
        milestone: "m1",
        status: "blocked",
        blockedReason: {
          code: "imagegen-timeout",
          message: "Image call timed out.",
          recoverable: true,
          failureKind: "retryable",
          resumeStage: "concept-generation",
        },
      }),
    ).toBeUndefined();
    expect(
      reviewGateRescue({ milestone: "m1", status: "active" }),
    ).toBeUndefined();
  });

  it("does not offer the removed asset-plan review gate", () => {
    expect(
      reviewGateRescue({
        milestone: "m2",
        status: "blocked",
        blockedReason: {
          code: "asset-plan-not-approved",
          message: "Not approved.",
          recoverable: true,
          reviewGate: "asset-plan",
        },
      }),
    ).toBeUndefined();
  });

  it("covers every gate, so no rejection can land on an unlabelled screen", () => {
    for (const gate of [
      "game-design",
      "visual-direction",
      "concept-set",
      "sound-set",
    ] as const) {
      const rescue = reviewGateRescue({
        milestone: "m1",
        status: "blocked",
        blockedReason: {
          code: `${gate}-not-approved`,
          message: "Not approved.",
          recoverable: true,
          reviewGate: gate,
        },
      });
      expect(rescue?.gate).toBe(gate);
      expect(rescue?.headline.length).toBeGreaterThan(0);
      expect(rescue?.actionLabel.toLowerCase()).toContain("reopen");
    }
  });
});

/* ---------- hotbar back-navigation ---------------------------------------- */

describe("hotbar navigation", () => {
  const atStyle = hotbarForSnapshot({
    state: {
      ...baseState,
      stage: "visual-direction-approval",
      status: "awaiting-approval",
    },
  });

  it("finds the tile the world is standing on", () => {
    expect(currentStageKey(atStyle)).toBe("style");
    expect(
      currentStageKey(
        hotbarForSnapshot({
          state: { ...baseState, stage: "concept-planning", status: "blocked" },
        }),
      ),
    ).toBe("images");
  });

  it("opens the past and leaves the future shut", () => {
    const nav = hotbarNavigation(atStyle, undefined);
    const navigable = nav.filter((slot) => slot.navigable).map((s) => s.key);
    expect(navigable).toEqual(["pitch", "brief", "style"]);
    expect(nav.every((slot) => !slot.viewing)).toBe(true);
  });

  it("marks exactly the tile being viewed", () => {
    const nav = hotbarNavigation(atStyle, "brief");
    expect(nav.filter((slot) => slot.viewing).map((s) => s.key)).toEqual([
      "brief",
    ]);
  });

  it("keeps a locked tile shut even when the world has run past it", () => {
    const nav = hotbarNavigation(
      atStyle.map((slot) =>
        slot.key === "brief" ? { ...slot, locked: true } : slot,
      ),
      undefined,
    );
    expect(nav.find((slot) => slot.key === "brief")?.navigable).toBe(false);
  });

  it("opens every tile once the world is finished and none is current", () => {
    const done = atStyle.map((slot) => ({
      ...slot,
      active: false,
      blocked: false,
      locked: false,
    }));
    expect(hotbarNavigation(done, undefined).every((s) => s.navigable)).toBe(
      true,
    );
  });
});

describe("stageHistoryScreen", () => {
  const empty = {
    interrogation: undefined,
    gameDesignSpec: undefined,
    visualDirections: undefined,
    conceptSet: undefined,
    soundSet: undefined,
    assetPlan: undefined,
  };

  it("always has the pitch, because the brief is what made the world", () => {
    expect(stageHistoryScreen(empty, "pitch")).toBe("pitch-record");
  });

  it("prefers the signed spec over the interrogation it came from", () => {
    expect(
      stageHistoryScreen(
        { ...empty, interrogation: {} as never, gameDesignSpec: {} as never },
        "brief",
      ),
    ).toBe("game-design");
    expect(
      stageHistoryScreen({ ...empty, interrogation: {} as never }, "brief"),
    ).toBe("shared-understanding");
  });

  it("reads a stage's record off the artifact that stage produced", () => {
    expect(
      stageHistoryScreen(
        { ...empty, visualDirections: { directions: [{}] } as never },
        "style",
      ),
    ).toBe("visual-direction");
    expect(
      stageHistoryScreen(
        { ...empty, conceptSet: { slots: [{}] } as never },
        "images",
      ),
    ).toBe("concept-review");
    expect(
      stageHistoryScreen(
        { ...empty, soundSet: { slots: [{}] } as never },
        "sounds",
      ),
    ).toBe("sound-review");
    expect(stageHistoryScreen(empty, "assets")).toBe("unavailable");
  });

  it("says so rather than rendering an empty screen when the record is gone", () => {
    for (const key of ["brief", "style", "images", "sounds", "assets"] as const)
      expect(stageHistoryScreen(empty, key)).toBe("unavailable");
    /* An empty list is not a record either. */
    expect(
      stageHistoryScreen(
        { ...empty, visualDirections: { directions: [] } as never },
        "style",
      ),
    ).toBe("unavailable");
  });

  it("routes the wide screens through the concept host and the narrow ones past it", () => {
    expect(stageHistoryUsesConceptHost("concept-review")).toBe(true);
    expect(stageHistoryUsesConceptHost("sound-review")).toBe(true);
    expect(stageHistoryUsesConceptHost("unavailable")).toBe(true);
    /* `.concept-complete` is only repainted for this skin inside the host, so
       the two record cards have to be in it or they render dark-on-dark. */
    expect(stageHistoryUsesConceptHost("pitch-record")).toBe(true);
    expect(stageHistoryUsesConceptHost("game-design")).toBe(false);
    expect(stageHistoryUsesConceptHost("visual-direction")).toBe(false);
    expect(stageHistoryUsesConceptHost("shared-understanding")).toBe(false);
  });
});

describe("pasted image attachments", () => {
  it("takes only image files out of a clipboard payload", () => {
    expect(
      pastedImageItems([
        { kind: "string", type: "text/plain" },
        { kind: "file", type: "image/png" },
        { kind: "file", type: "application/pdf" },
        { kind: "file", type: "image/webp" },
        { kind: "file", type: "image/gif" },
      ]),
    ).toEqual([
      { kind: "file", type: "image/png" },
      { kind: "file", type: "image/webp" },
    ]);
  });

  it("keeps an ordinary text paste when the payload carries both", () => {
    expect(
      clipboardCarriesText([
        { kind: "file", type: "image/png" },
        { kind: "string", type: "text/plain" },
      ]),
    ).toBe(true);
    expect(clipboardCarriesText([{ kind: "file", type: "image/png" }])).toBe(
      false,
    );
  });

  it("counts down the remaining room and never goes negative", () => {
    expect(attachmentRoom(0)).toBe(4);
    expect(attachmentRoom(3)).toBe(1);
    expect(attachmentRoom(9)).toBe(0);
    expect(attachmentLimitMessage()).toContain("at most 4 images");
  });

  it("says where a pasted image actually goes on each route", () => {
    expect(
      attachmentDeliveryNote({
        mode: "live",
        orchestratorProvider: "openai",
      }),
    ).toBe("Sent to openai with this answer.");
    expect(
      attachmentDeliveryNote({
        mode: "replay",
        orchestratorProvider: "openai",
      }),
    ).toBe("Replay world: saved with this answer, but no model reads it.");
    expect(
      attachmentDeliveryNote({
        mode: "live",
        orchestratorProvider: "grok",
      }),
    ).toContain("text-only");
    expect(
      attachmentDeliveryNote(
        { mode: "replay", orchestratorProvider: "openai" },
        "this steer",
      ),
    ).toBe("Replay world: saved with this steer, but no model reads it.");
  });

  it("carries an answer's attachments onto the recorded transcript row", () => {
    const attachment = {
      artifactId: "artifact-1",
      sha256: "a".repeat(64),
      mediaType: "image/png",
      byteLength: 42,
      uri: "/api/artifacts/artifact-1",
    };
    const rows = recordedAnswers({
      interrogation: {
        rounds: [
          {
            roundId: "round-1",
            questions: [
              {
                questionId: "q1",
                branchId: "gameplay.core-loop",
                prompt: "Which actions?",
                recommendation: "Pick three.",
              },
              {
                questionId: "q2",
                branchId: "scope.proof-boundary",
                prompt: "Smallest slice?",
                recommendation: "One arena.",
              },
            ],
            answers: [
              {
                questionId: "q1",
                value: "Explore, charge, defend",
                origin: { source: "user", reference: "round-1" },
                attachments: [attachment],
              },
              {
                questionId: "q2",
                value: "One arena",
                origin: { source: "user", reference: "round-1" },
              },
            ],
            createdAt: "2026-08-28T00:00:00.000Z",
            completedAt: "2026-08-28T00:01:00.000Z",
          },
        ],
        frontier: [],
      },
    });

    expect(rows[0]?.attachments).toEqual([attachment]);
    expect(rows[1]?.attachments).toEqual([]);
  });
});
