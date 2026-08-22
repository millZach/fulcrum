import { describe, expect, it } from "vitest";

import { ApiError } from "../api.js";
import {
  allSlotsSelected,
  budgetRaisePrompt,
  currentRound,
  describeStudioError,
  directionSha256,
  firstOpenSlotId,
  hotbarForSnapshot,
  liveGeneratingCopy,
  mascotForSnapshot,
  recordedAnswers,
  screenForSnapshot,
  slotRevisionViews,
  suggestedNextBudgetUsd,
  voxelPaletteFromTokens,
  voxelWorldView,
} from "./snapshot-view.js";
import type { ConceptSlot } from "@fulcrum/domain";

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
      message: "Budget exhausted: ImageGen requires $0.01.",
      budgetRefused: true,
    });
    expect(liveGeneratingCopy("live")).toBe(
      "Generating with your OpenAI subscription…",
    );
    expect(liveGeneratingCopy("replay")).toBe("Building replay concepts…");
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
      visible: true,
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
    expect(complete).toEqual({
      screen: "package",
      decisions: 10,
      visible: true,
    });
    expect(created).toBeLessThan(answered);
    expect(answered).toBeLessThan(understood.decisions);
    expect(understood.decisions).toBeLessThan(gdsApproved.decisions);
    expect(gdsApproved.decisions).toBeLessThan(directionApproved.decisions);
    expect(directionApproved.decisions).toBeLessThan(oneSlot.decisions);
    expect(oneSlot.decisions).toBeLessThan(packaged.decisions);
    expect(packaged.decisions).toBeLessThan(complete.decisions);
  });

  it("rebuilds the same decision count from stage when approval fields are missing", () => {
    expect(
      mascotForSnapshot({
        state: { ...baseState, stage: "concept-planning" },
      }).decisions,
    ).toBe(4);
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
