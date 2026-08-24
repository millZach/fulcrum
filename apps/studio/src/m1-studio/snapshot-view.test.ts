import { describe, expect, it } from "vitest";

import { ApiError } from "../api.js";
import {
  allSlotsSelected,
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
  recordedAnswers,
  reconcileConceptReviewView,
  routingCostNote,
  screenForSnapshot,
  showsMeteredBudget,
  slotRevisionViews,
  soundRouteLabel,
  suggestedNextBudgetUsd,
  voxelPaletteFromTokens,
  voxelWorldView,
} from "./snapshot-view.js";
import { M1InFlightActionSchema, type ConceptSlot } from "@fulcrum/domain";

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
    });
  });

  it("describes budget and sound routes from the selected providers", () => {
    expect(showsMeteredBudget(baseState)).toBe(false);
    expect(routingCostNote(baseState)).toBe(
      "Replay and local generators use no metered services.",
    );
    const subscription = {
      ...baseState,
      mode: "live" as const,
      imageProvider: "openai-subscription" as const,
    };
    expect(showsMeteredBudget(subscription)).toBe(false);
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
      "Writing the Game Design Spec…",
    );
    expect(modelWaitForWorking("confirm", "live")!.hint).toContain(
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
        title: "Writing the Game Design Spec…",
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
