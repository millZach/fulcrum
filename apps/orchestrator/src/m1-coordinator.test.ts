import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  m1ConceptImageIdempotencyKey,
  type StructuredModelExecution,
} from "@fulcrum/creative";
import {
  M0_FIXTURE_BRIEF,
  MultiviewConceptSetSchema,
  ProviderPreflightError,
  ProviderUsageError,
  type ProjectSnapshot,
} from "@fulcrum/domain";
import { ProjectRepository } from "@fulcrum/project";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectCoordinator } from "./project-coordinator.js";
import { replayDeterminismRecord } from "./replay-determinism.test-support.js";

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const roots: string[] = [];

const temporaryRoot = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), "fulcrum-m1-coordinator-"));
  roots.push(root);
  return root;
};

afterEach(() => {
  delete process.env.FULCRUM_M1_LIVE_AUTHORIZED;
  delete process.env.FULCRUM_REPLAY_LATENCY_MS;
  delete process.env.ELEVENLABS_API_KEY;
  delete process.env.FULCRUM_FIXTURE_BRIEF;
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const M1_BRIEF =
  "Create a first-person stealth game in a cramped lunar greenhouse environment. The player cannot use weapons, must escape within eight minutes, and must read colorblind-safe alerts despite near-dark lighting and one pursuing creature.";

const answerCurrentRound = async (
  coordinator: ProjectCoordinator,
  project: ProjectSnapshot,
): Promise<ProjectSnapshot> => {
  const interrogation = project.interrogation!;
  const round = interrogation.rounds.at(-1)!;
  return await coordinator.m1.answerFrontier(project.state.projectId, {
    interrogationRevisionId: project.state.interrogation!.revisionId,
    roundId: round.roundId,
    answers: interrogation.frontier.map((question) => ({
      questionId: question.questionId,
      value:
        question.branchId === "scope.consequential-tradeoff"
          ? "Readability must win whenever the required darkness hides an alert."
          : question.branchId === "scope.adr-qualification"
            ? "Yes, this is hard to reverse after environment production and surprising without the readability tradeoff context."
            : `Resolved ${question.branchId} with one concrete, testable choice.`,
    })),
  });
};

const finishInterrogation = async (
  coordinator: ProjectCoordinator,
  project: ProjectSnapshot,
): Promise<ProjectSnapshot> => {
  let current = project;
  while (current.interrogation!.frontier.length > 0)
    current = await answerCurrentRound(coordinator, current);
  return current;
};

/** The brief signoff now ends in the naming conversation, so every flow that
 *  only wants to get past it confirms and then takes the first proposal. */
const nameTheGame = async (
  coordinator: ProjectCoordinator,
  project: ProjectSnapshot,
): Promise<ProjectSnapshot> =>
  coordinator.m1.commitGameName(project.state.projectId, {
    gameNameCandidatesRevisionId: project.state.gameNameCandidates!.revisionId,
    candidateId: project.gameNameCandidates!.candidates[0]!.candidateId,
  });

const signOffBrief = async (
  coordinator: ProjectCoordinator,
  project: ProjectSnapshot,
): Promise<ProjectSnapshot> =>
  nameTheGame(
    coordinator,
    await coordinator.m1.confirmSharedUnderstanding(project.state.projectId, {
      interrogationRevisionId: project.state.interrogation!.revisionId,
      confirmed: true,
    }),
  );

const confirmConceptPlan = async (
  coordinator: ProjectCoordinator,
  project: ProjectSnapshot,
): Promise<ProjectSnapshot> =>
  coordinator.m1.confirmConceptPlan(project.state.projectId, {
    conceptPlanRevisionId: project.state.conceptPlan!.revisionId,
    confirmed: true,
  });

const confirmSoundPlan = async (
  coordinator: ProjectCoordinator,
  project: ProjectSnapshot,
  promptOverrides?: Array<{ slotId: string; prompt: string }>,
): Promise<ProjectSnapshot> =>
  coordinator.m1.confirmSoundPlan(project.state.projectId, {
    soundPlanRevisionId: project.state.soundPlan!.revisionId,
    confirmed: true,
    ...(promptOverrides && promptOverrides.length > 0
      ? { promptOverrides }
      : {}),
  });

const approveSoundPalette = (
  coordinator: ProjectCoordinator,
  project: ProjectSnapshot,
): ProjectSnapshot =>
  coordinator.m1.approveSoundSet(project.state.projectId, {
    decision: "approved",
    targetRevisionId: project.state.soundSet!.revisionId,
    targetSha256: project.state.soundSet!.artifact.sha256,
  });

const finishM1ThroughSounds = async (
  coordinator: ProjectCoordinator,
  project: ProjectSnapshot,
): Promise<ProjectSnapshot> => {
  let current = project;
  if (current.state.stage === "concept-set-approval") {
    current = coordinator.m1.approveConceptSet(current.state.projectId, {
      decision: "approved",
      targetRevisionId: current.state.conceptSet!.revisionId,
      targetSha256: current.state.conceptSet!.artifact.sha256,
    });
  }
  if (current.state.stage === "sound-planning")
    current = await confirmSoundPlan(coordinator, current);
  if (current.state.stage === "sound-set-approval")
    current = approveSoundPalette(coordinator, current);
  return current;
};

const keepEveryGeneratedConcept = (
  coordinator: ProjectCoordinator,
  project: ProjectSnapshot,
): ProjectSnapshot => {
  let current = project;
  for (const slot of project.conceptSet!.slots) {
    current = coordinator.m1.selectConcept(current.state.projectId, {
      conceptSetRevisionId: current.state.conceptSet!.revisionId,
      slotId: slot.slotId,
      conceptRevisionId: slot.revisions.at(-1)!.revision.revisionId,
    });
  }
  return current;
};

const reachConceptApproval = async (
  coordinator: ProjectCoordinator,
  milestone: "m1" | "m2",
): Promise<ProjectSnapshot> => {
  let project = await coordinator.create({
    milestone,
    brief: M1_BRIEF,
    mode: "replay",
    imageProvider: "none",
    rightsConfirmed: true,
  });
  project = await finishInterrogation(coordinator, project);
  project = await signOffBrief(coordinator, project);
  project = await coordinator.creative.approveGameDesign(
    project.state.projectId,
    {
      decision: "approved",
      targetRevisionId: project.state.gameDesignSpec!.revisionId,
      targetSha256: project.state.gameDesignSpec!.artifact.sha256,
    },
  );
  const direction = project.visualDirections!.directions[0]!;
  const directionRevision = coordinator.repository.getRevision(
    direction.revisionId,
  );
  project = await coordinator.creative.approveDirection(
    project.state.projectId,
    {
      decision: "approved",
      targetRevisionId: directionRevision.revisionId,
      targetSha256: directionRevision.artifact.sha256,
    },
  );
  project = await coordinator.creative.confirmConceptPlan(
    project.state.projectId,
    {
      conceptPlanRevisionId: project.state.conceptPlan!.revisionId,
      confirmed: true,
    },
  );
  return project;
};

const reachM2ConceptApproval = async (
  coordinator: ProjectCoordinator,
): Promise<ProjectSnapshot> => reachConceptApproval(coordinator, "m2");

/** A finished M1 world: every concept kept, sound palette approved. */
const reachM1Complete = async (
  coordinator: ProjectCoordinator,
): Promise<ProjectSnapshot> =>
  finishM1ThroughSounds(
    coordinator,
    keepEveryGeneratedConcept(
      coordinator,
      await reachConceptApproval(coordinator, "m1"),
    ),
  );

const runM2ReplayAcceptance = async () => {
  const repository = new ProjectRepository(temporaryRoot());
  const coordinator = new ProjectCoordinator(repository);
  let project = keepEveryGeneratedConcept(
    coordinator,
    await reachM2ConceptApproval(coordinator),
  );

  project = await coordinator.approveConceptSet(project.state.projectId, {
    decision: "approved",
    targetRevisionId: project.state.conceptSet!.revisionId,
    targetSha256: project.state.conceptSet!.artifact.sha256,
  });

  expect(project.state).toMatchObject({
    stage: "complete",
    status: "complete",
  });
  expect(
    project.assetPlan?.assets.map((asset) => asset.classification),
  ).toEqual(
    expect.arrayContaining(["hero", "kit", "procedural", "functional"]),
  );

  expect(project.state.assetPlanApproval).toMatchObject({
    decision: "approved",
    decidedBy: "fulcrum:auto-finalizer",
    targetRevisionId: project.state.assetPlan!.revisionId,
  });
  expect(Object.keys(project.state.assetBatch ?? {})).toHaveLength(
    project.assetPlan!.assets.length,
  );
  expect(
    Object.values(project.state.assetBatch ?? {}).every(
      ({ validated, deterministicReport }) =>
        validated && deterministicReport !== undefined,
    ),
  ).toBe(true);

  for (const asset of project.assetPlan!.assets) {
    const entry = project.state.assetBatch?.[asset.assetId];
    const report =
      project.assetQualityEvidence?.[asset.assetId]?.deterministicReports.at(
        -1,
      );
    expect(entry).toMatchObject({
      assetId: asset.assetId,
      classification: asset.classification,
      validated: true,
    });
    expect(report?.measurements).toEqual(
      expect.objectContaining({
        mesh: expect.any(Object),
        material: expect.any(Object),
        texture: expect.any(Object),
        topology: expect.any(Object),
      }),
    );
  }

  const heroAssetId = project.assetPlan!.assets.find(
    ({ classification }) => classification === "hero",
  )!.assetId;
  const hero = project.state.assetBatch![heroAssetId]!;
  const heroEvidence = project.assetQualityEvidence![heroAssetId]!;
  expect(hero).toMatchObject({
    attemptCount: 2,
    validated: true,
    multiviewConceptSet: expect.any(Object),
  });
  expect(hero.best.revisionId).toBe(hero.current.revisionId);
  expect(heroEvidence.turntables).toHaveLength(2);
  expect(heroEvidence.semanticReports).toHaveLength(2);
  expect(heroEvidence.semanticReports[0]?.findings[0]?.evidence).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ frameIndex: 3 }),
      expect.objectContaining({ frameIndex: 4, crop: expect.any(Object) }),
      expect.objectContaining({ frameIndex: 5 }),
    ]),
  );

  const events = repository.listEvents(project.state.projectId);
  const strategyEvents = events.filter(
    ({ type, payload }) =>
      type === "asset.regeneration-strategy-selected" &&
      payload.assetId === heroAssetId,
  );
  expect(strategyEvents.map(({ payload }) => payload.strategyKind)).toEqual([
    "change-views",
    "accept-best",
  ]);
  const changeViewsRevision = repository.getRevision(
    strategyEvents[0]!.payload.decisionRevisionId as string,
  );
  expect(repository.resolveRevision(changeViewsRevision)).toMatchObject({
    strategy: {
      kind: "change-views",
      roles: ["back", "left", "right"],
      operation: "add",
    },
  });
  const bestRevisionEvents = events.filter(
    ({ type, payload }) =>
      type === "asset.best-revision-considered" &&
      payload.assetId === heroAssetId,
  );
  expect(bestRevisionEvents.map(({ payload }) => payload.result)).toEqual([
    "updated",
    "updated",
  ]);

  const multiview = MultiviewConceptSetSchema.parse(
    repository.resolveRevision(hero.multiviewConceptSet!),
  );
  expect(multiview.views.map(({ role }) => role)).toEqual([
    "front",
    "left",
    "back",
    "right",
  ]);
  const determinism = replayDeterminismRecord(repository, [
    project,
    ...strategyEvents,
    ...bestRevisionEvents,
  ]);
  repository.close();
  return determinism;
};

describe("CreativeFrontCoordinator M2 handoff", () => {
  it("m2_concept_approval_enters_asset_planning_without_sound_artifacts", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const coordinator = new ProjectCoordinator(repository);
    let project = await reachM2ConceptApproval(coordinator);
    project = keepEveryGeneratedConcept(coordinator, project);

    project = coordinator.creative.approveConceptSet(project.state.projectId, {
      decision: "approved",
      targetRevisionId: project.state.conceptSet!.revisionId,
      targetSha256: project.state.conceptSet!.artifact.sha256,
    });

    expect(project.state.stage).toBe("asset-planning");
    expect(project.state.status).toBe("active");
    expect(project.state.soundPlan).toBeUndefined();
    expect(project.state.soundSet).toBeUndefined();
    repository.close();
  });

  it("m2_changes_requested_remains_at_concept_set_approval", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const coordinator = new ProjectCoordinator(repository);
    let project = keepEveryGeneratedConcept(
      coordinator,
      await reachM2ConceptApproval(coordinator),
    );

    project = coordinator.creative.approveConceptSet(project.state.projectId, {
      decision: "changes-requested",
      targetRevisionId: project.state.conceptSet!.revisionId,
      targetSha256: project.state.conceptSet!.artifact.sha256,
      notes: "Raise the hero silhouette.",
    });

    expect(project.state.stage).toBe("concept-set-approval");
    expect(project.state.status).toBe("awaiting-approval");
    repository.close();
  });

  it("m2_rejected_concept_set_reopens_the_gate_without_starting_macro_graph", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const coordinator = new ProjectCoordinator(repository);
    let project = keepEveryGeneratedConcept(
      coordinator,
      await reachM2ConceptApproval(coordinator),
    );

    project = coordinator.creative.approveConceptSet(project.state.projectId, {
      decision: "rejected",
      targetRevisionId: project.state.conceptSet!.revisionId,
      targetSha256: project.state.conceptSet!.artifact.sha256,
    });

    expect(project.state.stage).toBe("concept-set-approval");
    expect(project.state.status).toBe("awaiting-approval");
    expect(project.state.blockedReason).toBeUndefined();
    expect(project.state.conceptSetApproval?.decision).toBe("rejected");
    expect(
      repository
        .listEvents(project.state.projectId)
        .some(({ type }) => type.startsWith("workflow.")),
    ).toBe(false);
    repository.close();
  });

  it("m2_rejects_stale_or_unselected_concept_revisions_before_handoff", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const coordinator = new ProjectCoordinator(repository);
    let project = await reachM2ConceptApproval(coordinator);
    expect(() =>
      coordinator.creative.approveConceptSet(project.state.projectId, {
        decision: "approved",
        targetRevisionId: project.state.conceptSet!.revisionId,
        targetSha256: project.state.conceptSet!.artifact.sha256,
      }),
    ).toThrow(/selected revision/i);

    const staleTarget = project.state.conceptSet!;
    project = keepEveryGeneratedConcept(coordinator, project);
    expect(() =>
      coordinator.creative.approveConceptSet(project.state.projectId, {
        decision: "approved",
        targetRevisionId: staleTarget.revisionId,
        targetSha256: staleTarget.artifact.sha256,
      }),
    ).toThrow(/current immutable revision/i);
    repository.close();
  });

  it("m2_replay_acceptance_is_byte_and_lineage_deterministic", async () => {
    const first = await runM2ReplayAcceptance();
    const second = await runM2ReplayAcceptance();

    expect(
      second.rawArtifacts.map(({ mediaType, sha256, byteLength }) => ({
        mediaType,
        sha256,
        byteLength,
      })),
    ).toEqual(
      first.rawArtifacts.map(({ mediaType, sha256, byteLength }) => ({
        mediaType,
        sha256,
        byteLength,
      })),
    );
    expect(second.rawArtifacts).toEqual(first.rawArtifacts);
    expect(second.canonicalLineage).toBe(first.canonicalLineage);
  });
});

describe("M1Coordinator replay path", () => {
  it("persists a multi-round interview across restart and completes an M1 concept set", async () => {
    const root = temporaryRoot();
    const firstRepository = new ProjectRepository(root);
    const first = new ProjectCoordinator(firstRepository);
    let project = await first.create({
      milestone: "m1",
      brief: M1_BRIEF,
      mode: "replay",
      imageProvider: "none",
      budgetUsd: 1,
      rightsConfirmed: true,
    });

    expect(project.state.milestone).toBe("m1");
    expect(project.state.stage).toBe("interrogation");
    expect(project.state.status).toBe("awaiting-input");
    expect(project.state.creativeCapabilities).toBeDefined();
    expect(project.interrogation?.frontier.length).toBeGreaterThan(0);
    expect(
      project.interrogation?.frontier.every(
        (question) => question.recommendation.length > 0,
      ),
    ).toBe(true);

    const staleInterrogationId = project.state.interrogation!.revisionId;
    project = await answerCurrentRound(first, project);
    expect(project.interrogation?.rounds.length).toBeGreaterThan(1);
    firstRepository.close();

    const repository = new ProjectRepository(root);
    const coordinator = new ProjectCoordinator(repository);
    project = coordinator.snapshot(project.state.projectId);
    expect(project.state.interrogation?.revisionId).not.toBe(
      staleInterrogationId,
    );
    await expect(
      coordinator.m1.answerFrontier(project.state.projectId, {
        interrogationRevisionId: staleInterrogationId,
        roundId: project.interrogation!.rounds.at(-1)!.roundId,
        answers: project.interrogation!.frontier.map((question) => ({
          questionId: question.questionId,
          value: "A stale duplicate answer.",
        })),
      }),
    ).rejects.toThrow(/changed after this view loaded/i);

    project = await finishInterrogation(coordinator, project);
    expect(project.interrogation?.rounds.length).toBeGreaterThanOrEqual(3);
    expect(project.interrogation?.frontier).toEqual([]);
    project = await signOffBrief(coordinator, project);
    expect(project.state.stage).toBe("game-design-approval");
    expect(project.state.gameDesignSpec).toBeDefined();
    expect(project.state.projectGlossary).toBeDefined();
    expect(project.state.decisionRecords?.length).toBeGreaterThan(0);

    project = await coordinator.m1.approveGameDesign(project.state.projectId, {
      decision: "changes-requested",
      targetRevisionId: project.state.gameDesignSpec!.revisionId,
      targetSha256: project.state.gameDesignSpec!.artifact.sha256,
      notes: "Clarify the proof boundary before approval.",
    });
    expect(project.state.stage).toBe("game-design-approval");
    expect(project.state.status).toBe("awaiting-approval");
    const changesRequestedGameDesign = project.state.gameDesignSpec!;
    await expect(
      coordinator.m1.approveGameDesign(project.state.projectId, {
        decision: "approved",
        targetRevisionId: changesRequestedGameDesign.revisionId,
        targetSha256: changesRequestedGameDesign.artifact.sha256,
      }),
    ).rejects.toThrow(/revise the Game Design Spec/i);
    project = await coordinator.m1.reviseGameDesign(project.state.projectId, {
      gameDesignSpecRevisionId: changesRequestedGameDesign.revisionId,
      change:
        "The proof boundary is one greenhouse room, one pursuer, and one eight-minute escape.",
    });
    expect(project.state.gameDesignSpec?.revisionId).not.toBe(
      changesRequestedGameDesign.revisionId,
    );
    expect(project.gameDesignSpec?.gameplayConstraints).toContain(
      "The proof boundary is one greenhouse room, one pursuer, and one eight-minute escape.",
    );
    project = await coordinator.m1.approveGameDesign(project.state.projectId, {
      decision: "approved",
      targetRevisionId: project.state.gameDesignSpec!.revisionId,
      targetSha256: project.state.gameDesignSpec!.artifact.sha256,
    });
    expect(project.state.stage).toBe("visual-direction-approval");
    expect(project.visualDirections?.directions).toHaveLength(3);
    for (const direction of project.visualDirections!.directions) {
      expect(
        project.visualDirectionRevisions?.[direction.revisionId]?.artifact
          .sha256,
      ).toMatch(/^[a-f0-9]{64}$/);
    }

    const selectedBefore = project.visualDirections!.directions[0];
    const directionRevision = repository.getRevision(selectedBefore.revisionId);
    project = await coordinator.approveDirection(project.state.projectId, {
      decision: "changes-requested",
      targetRevisionId: directionRevision.revisionId,
      targetSha256: directionRevision.artifact.sha256,
      notes: "Keep this direction available while applying a focused revision.",
    } as never);
    expect(project.state.stage).toBe("visual-direction-approval");

    const originalSet = project.visualDirections!;
    const replacementTarget = originalSet.directions[2];
    process.env.FULCRUM_REPLAY_LATENCY_MS = "50";
    const replacementPending = coordinator.m1.replaceDirection(
      project.state.projectId,
      {
        directionSetRevisionId: project.state.visualDirectionSet!.revisionId,
        directionRevisionId: replacementTarget.revisionId,
        notes:
          "Make the third option feel built from translucent layered theatre flats.",
      },
    );
    expect(coordinator.snapshot(project.state.projectId).inFlight?.action).toBe(
      "replace",
    );
    project = await replacementPending;
    delete process.env.FULCRUM_REPLAY_LATENCY_MS;
    expect(project.state.directionReplacementCount).toBe(1);
    expect(project.visualDirections?.directions[0].revisionId).toBe(
      originalSet.directions[0].revisionId,
    );
    expect(project.visualDirections?.directions[1].revisionId).toBe(
      originalSet.directions[1].revisionId,
    );
    expect(project.visualDirections?.directions[2].revisionId).not.toBe(
      replacementTarget.revisionId,
    );
    await expect(
      coordinator.m1.replaceDirection(project.state.projectId, {
        directionSetRevisionId: project.state.visualDirectionSet!.revisionId,
        directionRevisionId: project.visualDirections!.directions[1].revisionId,
        notes: "A second replacement should not be allowed.",
      }),
    ).rejects.toThrow(/allowance has been used/i);

    project = await coordinator.approveDirection(project.state.projectId, {
      decision: "approved",
      targetRevisionId: directionRevision.revisionId,
      targetSha256: directionRevision.artifact.sha256,
    } as never);
    expect(project.state.stage).toBe("concept-planning");
    expect(project.state.directionApproval?.decision).toBe("approved");
    expect(project.state.conceptPlan).toBeDefined();
    expect(project.conceptPlan?.slots.length).toBeGreaterThanOrEqual(1);
    expect(project.conceptSet).toBeUndefined();
    project = await confirmConceptPlan(coordinator, project);
    expect(project.state.stage).toBe("concept-set-approval");
    expect(project.conceptSet?.slots.length).toBeGreaterThanOrEqual(1);
    expect(project.conceptSet?.slots.length).toBeLessThanOrEqual(3);
    expect(Object.keys(project.conceptDocuments ?? {})).toEqual(
      project.conceptSet!.slots.map((slot) => slot.slotId),
    );
    expect(
      project.conceptSet!.slots.every(
        ({ selectedRevisionId }) => !selectedRevisionId,
      ),
    ).toBe(true);
    project = keepEveryGeneratedConcept(coordinator, project);

    project = coordinator.m1.approveConceptSet(project.state.projectId, {
      decision: "changes-requested",
      targetRevisionId: project.state.conceptSet!.revisionId,
      targetSha256: project.state.conceptSet!.artifact.sha256,
      notes: "Increase the electrical tension without losing the palette.",
    });
    expect(project.state.stage).toBe("concept-set-approval");
    expect(project.state.status).toBe("awaiting-approval");

    const conceptsBeforeDirectionChange = project.conceptSet!;
    const paletteBefore = selectedBefore.visualBible.palette;
    await expect(
      coordinator.m1.changeDirection(project.state.projectId, {
        directionSetRevisionId: project.state.visualDirectionSet!.revisionId,
        directionRevisionId: project.state.selectedVisualDirectionRevisionId!,
        change: "Rebalance the emphasis toward the objective",
        pinnedAspects: ["palette", "shape language"],
      }),
    ).rejects.toThrow(/could not be classified/i);
    const afterRejectedChange = coordinator.snapshot(project.state.projectId);
    expect(afterRejectedChange.state.focusedDirectionChangeCount ?? 0).toBe(0);
    expect(afterRejectedChange.state.visualDirectionSet?.revisionId).toBe(
      project.state.visualDirectionSet?.revisionId,
    );
    process.env.FULCRUM_REPLAY_LATENCY_MS = "50";
    const changePending = coordinator.m1.changeDirection(
      project.state.projectId,
      {
        directionSetRevisionId: project.state.visualDirectionSet!.revisionId,
        directionRevisionId: project.state.selectedVisualDirectionRevisionId!,
        change:
          "Keep the palette exactly as it is and add restrained electrically charged wind streaks around active threats.",
        pinnedAspects: ["palette", "shape language"],
      },
    );
    expect(coordinator.snapshot(project.state.projectId).inFlight?.action).toBe(
      "change",
    );
    project = await changePending;
    delete process.env.FULCRUM_REPLAY_LATENCY_MS;
    expect(project.state.stage).toBe("visual-direction-approval");
    expect(project.state.directionApproval).toBeUndefined();
    expect(project.state.focusedDirectionChangeCount).toBe(1);
    expect(project.state.focusedDirectionChange).toBeDefined();
    const selectedAfter = project.visualDirections!.directions.find(
      (direction) =>
        direction.revisionId ===
        project.state.selectedVisualDirectionRevisionId,
    )!;
    expect(selectedAfter.revisionId).not.toBe(selectedBefore.revisionId);
    expect(selectedAfter.visualBible.palette).toEqual(paletteBefore);
    expect(project.conceptSet?.sourceDirectionRevisionId).toBe(
      selectedAfter.revisionId,
    );
    const rebasedConceptSetRevisionId = project.state.conceptSet!.revisionId;

    const staleSlots = project.conceptSet!.slots.filter(
      (slot) => !slot.selectedRevisionId,
    );
    const unaffectedSlots = project.conceptSet!.slots.filter(
      (slot) => slot.selectedRevisionId,
    );
    expect(staleSlots.length).toBeGreaterThan(0);
    expect(unaffectedSlots.length).toBeGreaterThan(0);
    const unaffectedSelections = new Map(
      unaffectedSlots.map((slot) => [slot.slotId, slot.selectedRevisionId]),
    );
    for (const [slotId, selectedRevisionId] of unaffectedSelections)
      expect(
        project.conceptSet!.slots.find((slot) => slot.slotId === slotId)
          ?.selectedRevisionId,
      ).toBe(selectedRevisionId);

    const descendantDirection = repository.getRevision(
      selectedAfter.revisionId,
    );
    project = await coordinator.approveDirection(project.state.projectId, {
      decision: "approved",
      targetRevisionId: descendantDirection.revisionId,
      targetSha256: descendantDirection.artifact.sha256,
    } as never);
    expect(project.state.stage).toBe("concept-set-approval");
    expect(project.state.directionApproval?.targetRevisionId).toBe(
      selectedAfter.revisionId,
    );
    expect(project.state.conceptSet?.revisionId).toBe(
      rebasedConceptSetRevisionId,
    );

    expect(() =>
      coordinator.m1.approveConceptSet(project.state.projectId, {
        decision: "approved",
        targetRevisionId: project.state.conceptSet!.revisionId,
        targetSha256: project.state.conceptSet!.artifact.sha256,
      }),
    ).toThrow(/selected revision/i);

    for (const staleSlot of staleSlots) {
      const staleRevision = staleSlot.revisions.at(-1)!;
      expect(staleRevision.staleReason).toBeDefined();
      const priorPrompt =
        project.conceptDocuments?.[staleSlot.slotId]?.at(-1)?.prompt;
      const priorBase =
        project.conceptDocuments?.[staleSlot.slotId]?.at(-1)?.basePrompt;
      expect(priorBase).toBeTruthy();
      const conceptSetRevisionBeforeRegeneration =
        project.state.conceptSet!.revisionId;
      project = await coordinator.m1.regenerateConcept(
        project.state.projectId,
        {
          conceptSetRevisionId: project.state.conceptSet!.revisionId,
          slotId: staleSlot.slotId,
          notes:
            "Carry the updated electrical threat language into this concept.",
        },
      );
      const regeneratedSlot = project.conceptSet!.slots.find(
        (slot) => slot.slotId === staleSlot.slotId,
      )!;
      expect(regeneratedSlot.selectedRevisionId).toBeUndefined();
      const regenerated = regeneratedSlot.revisions.at(-1)!;
      expect(regenerated.staleReason).toBeUndefined();
      const regeneratedPrompt =
        project.conceptDocuments?.[staleSlot.slotId]?.at(-1);
      expect(regeneratedPrompt?.basePrompt).toBe(priorBase);
      expect(regeneratedPrompt?.prompt).toBe(
        `${priorBase} Focused alternate request: Carry the updated electrical threat language into this concept.`,
      );
      expect(regeneratedPrompt?.prompt).not.toContain(
        "electrically charged wind streaks",
      );
      expect(priorPrompt).not.toContain("electrically charged wind streaks");
      expect(() =>
        coordinator.m1.selectConcept(project.state.projectId, {
          conceptSetRevisionId: conceptSetRevisionBeforeRegeneration,
          slotId: staleSlot.slotId,
          conceptRevisionId: regenerated.revision.revisionId,
        }),
      ).toThrow(/changed after this view loaded/i);
      expect(() =>
        coordinator.m1.selectConcept(project.state.projectId, {
          conceptSetRevisionId: project.state.conceptSet!.revisionId,
          slotId: staleSlot.slotId,
          conceptRevisionId: staleRevision.revision.revisionId,
        }),
      ).toThrow(/stale and cannot be selected/i);
      project = coordinator.m1.selectConcept(project.state.projectId, {
        conceptSetRevisionId: project.state.conceptSet!.revisionId,
        slotId: staleSlot.slotId,
        conceptRevisionId: regenerated.revision.revisionId,
      });
      expect(
        project.conceptSet!.slots.find(
          (slot) => slot.slotId === staleSlot.slotId,
        )?.selectedRevisionId,
      ).toBe(regenerated.revision.revisionId);
      expect(project.state.conceptRegenerationCounts?.[staleSlot.slotId]).toBe(
        1,
      );
    }
    for (const [slotId, selectedRevisionId] of unaffectedSelections)
      expect(
        project.conceptSet!.slots.find((slot) => slot.slotId === slotId)
          ?.selectedRevisionId,
      ).toBe(selectedRevisionId);
    expect(project.conceptSet?.sourceDirectionRevisionId).not.toBe(
      conceptsBeforeDirectionChange.sourceDirectionRevisionId,
    );

    const validState = repository.getProject(project.state.projectId);
    repository.saveProject({
      ...validState,
      directionApproval: {
        ...validState.directionApproval!,
        targetSha256: "0".repeat(64),
      },
    });
    expect(() =>
      coordinator.m1.approveConceptSet(project.state.projectId, {
        decision: "approved",
        targetRevisionId: project.state.conceptSet!.revisionId,
        targetSha256: project.state.conceptSet!.artifact.sha256,
      }),
    ).toThrow(/source direction hash/i);
    repository.saveProject(validState);
    project = coordinator.snapshot(project.state.projectId);

    project = coordinator.m1.approveConceptSet(project.state.projectId, {
      decision: "approved",
      targetRevisionId: project.state.conceptSet!.revisionId,
      targetSha256: project.state.conceptSet!.artifact.sha256,
    });
    expect(project.state.status).toBe("awaiting-input");
    expect(project.state.stage).toBe("sound-planning");
    expect(project.state.conceptSetApproval?.targetSha256).toBe(
      project.state.conceptSet?.artifact.sha256,
    );
    expect(project.soundPlan?.slots.length).toBeGreaterThanOrEqual(4);
    expect(project.soundPlan?.slots.length).toBeLessThanOrEqual(6);
    expect(project.soundSet).toBeUndefined();
    const shownSoundPlanId = project.state.soundPlan!.revisionId;
    const foley = project.soundPlan!.slots[0]!;
    const editedFoley =
      "TASK-M-EDIT lunar airlock hiss, send this verbatim to the renderer.";
    project = await confirmSoundPlan(coordinator, project, [
      { slotId: foley.slotId, prompt: editedFoley },
    ]);
    expect(project.state.soundPlan!.revisionId).not.toBe(shownSoundPlanId);
    expect(project.state.stage).toBe("sound-set-approval");
    expect(project.soundDocuments?.[foley.slotId]?.[0]?.prompt).toBe(
      editedFoley,
    );
    expect(
      project.soundSet?.slots.every((slot) => slot.selectedRevisionId),
    ).toBe(true);
    for (const slot of project.soundSet!.slots) {
      const document = project.soundDocuments?.[slot.slotId]?.[0];
      expect(document?.audio.mediaType).toBe("audio/wav");
      expect(document?.provider).toBe("fulcrum-wav");
    }
    const staleSoundSet = project.state.soundSet!;
    project = await coordinator.m1.regenerateSound(project.state.projectId, {
      soundSetRevisionId: project.state.soundSet!.revisionId,
      slotId: foley.slotId,
      notes: "Make the hiss shorter.",
    });
    expect(() =>
      coordinator.m1.approveSoundSet(project.state.projectId, {
        decision: "approved",
        targetRevisionId: staleSoundSet.revisionId,
        targetSha256: staleSoundSet.artifact.sha256,
      }),
    ).toThrow(/does not match the current immutable revision/i);
    project = approveSoundPalette(coordinator, project);
    expect(project.state.status).toBe("complete");
    expect(project.state.stage).toBe("complete");
    expect(project.state.soundSetApproval?.targetSha256).toBe(
      project.state.soundSet?.artifact.sha256,
    );
    const eventTypes = repository
      .listEvents(project.state.projectId)
      .map((event) => event.type);
    expect(eventTypes).toContain("creative.capabilities-provisioned");
    expect(eventTypes).toContain("approval.concept-set-decided");
    expect(eventTypes).toContain("sound-plan.created");
    expect(eventTypes).toContain("sound-plan.edited");
    expect(eventTypes).toContain("sound.generated");
    expect(eventTypes).toContain("sound.regenerated");
    expect(eventTypes).toContain("approval.sound-set-decided");
    expect(eventTypes.some((type) => type.startsWith("asset."))).toBe(false);
    expect(eventTypes.some((type) => type.startsWith("scene."))).toBe(false);
    expect(JSON.stringify(project.state)).not.toMatch(/base64|api[_-]?key/i);
    repository.close();
  });

  it("fails closed for live M1 and keeps omitted milestone on the M0 path", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const coordinator = new ProjectCoordinator(repository);
    await expect(
      coordinator.create({
        milestone: "m1",
        brief: M1_BRIEF,
        mode: "live",
        imageProvider: "none",
        budgetUsd: 1,
        rightsConfirmed: true,
      }),
    ).rejects.toThrow(/FULCRUM_M1_LIVE_AUTHORIZED=true/);
    expect(repository.listProjects()).toEqual([]);

    let rejected = await coordinator.create({
      milestone: "m1",
      brief: M1_BRIEF,
      mode: "replay",
      imageProvider: "none",
      budgetUsd: 1,
      rightsConfirmed: true,
    });
    rejected = await finishInterrogation(coordinator, rejected);
    rejected = await signOffBrief(coordinator, rejected);
    rejected = await coordinator.m1.approveGameDesign(
      rejected.state.projectId,
      {
        decision: "rejected",
        targetRevisionId: rejected.state.gameDesignSpec!.revisionId,
        targetSha256: rejected.state.gameDesignSpec!.artifact.sha256,
      },
    );
    expect(rejected.state.stage).toBe("game-design-approval");
    expect(rejected.state.status).toBe("awaiting-approval");
    expect(rejected.state.blockedReason).toBeUndefined();

    const m0 = await coordinator.create({
      brief: M0_FIXTURE_BRIEF,
      mode: "replay",
      imageProvider: "none",
      budgetUsd: 1,
      rightsConfirmed: true,
    });
    expect(m0.state.milestone).toBe("m0");
    expect(m0.state.stage).toBe("visual-direction-approval");
    expect(m0.concept?.image.mediaType).toBe("image/png");
    repository.close();
  });

  it("defaults omitted soundProvider to none and reports ElevenLabs unreadiness", async () => {
    delete process.env.ELEVENLABS_API_KEY;
    process.env.FULCRUM_FIXTURE_BRIEF = M0_FIXTURE_BRIEF;
    const repository = new ProjectRepository(temporaryRoot());
    const coordinator = new ProjectCoordinator(repository);
    const configuration = coordinator.configuration();
    expect(
      configuration.soundProviders.find(({ provider }) => provider === "none"),
    ).toMatchObject({ ready: true, missingConfiguration: [] });
    expect(
      configuration.soundProviders.find(
        ({ provider }) => provider === "elevenlabs",
      ),
    ).toMatchObject({
      ready: false,
      missingConfiguration: ["ELEVENLABS_API_KEY"],
    });
    const project = await coordinator.create({
      milestone: "m1",
      brief: M1_BRIEF,
      mode: "replay",
      imageProvider: "none",
      budgetUsd: 1,
      rightsConfirmed: true,
    });
    expect(project.state.soundProvider).toBe("none");
    repository.close();
  });

  it("regenerates the same slot more than once and keeps revision labels", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const coordinator = new ProjectCoordinator(repository);
    let project = await coordinator.create({
      milestone: "m1",
      brief: M1_BRIEF,
      mode: "replay",
      imageProvider: "none",
      budgetUsd: 1,
      rightsConfirmed: true,
    });
    project = await finishInterrogation(coordinator, project);
    project = await signOffBrief(coordinator, project);
    project = await coordinator.m1.approveGameDesign(project.state.projectId, {
      decision: "approved",
      targetRevisionId: project.state.gameDesignSpec!.revisionId,
      targetSha256: project.state.gameDesignSpec!.artifact.sha256,
    });
    const direction = project.visualDirections!.directions[0];
    const directionRevision = repository.getRevision(direction.revisionId);
    project = await coordinator.approveDirection(project.state.projectId, {
      decision: "approved",
      targetRevisionId: directionRevision.revisionId,
      targetSha256: directionRevision.artifact.sha256,
    } as never);
    project = await confirmConceptPlan(coordinator, project);

    const slotId = project.conceptSet!.slots[0]!.slotId;
    for (let index = 0; index < 3; index += 1) {
      project = await coordinator.m1.regenerateConcept(
        project.state.projectId,
        {
          conceptSetRevisionId: project.state.conceptSet!.revisionId,
          slotId,
          notes: `Replay revision ${index + 2}.`,
        },
      );
    }
    const slot = project.conceptSet!.slots.find(
      (item) => item.slotId === slotId,
    )!;
    expect(slot.revisions).toHaveLength(4);
    expect(project.state.conceptRegenerationCounts?.[slotId]).toBe(3);
    expect(
      project.conceptDocuments?.[slotId]?.map((document) => document.name),
    ).toEqual([
      expect.stringMatching(/r01$/),
      expect.stringMatching(/r02$/),
      expect.stringMatching(/r03$/),
      expect.stringMatching(/r04$/),
    ]);
    repository.close();
  });

  it("stales a regenerated slot on a focused direction change so it can be regenerated again", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const coordinator = new ProjectCoordinator(repository);
    let project = await coordinator.create({
      milestone: "m1",
      brief: M1_BRIEF,
      mode: "replay",
      imageProvider: "none",
      budgetUsd: 1,
      rightsConfirmed: true,
    });
    project = await finishInterrogation(coordinator, project);
    project = await signOffBrief(coordinator, project);
    project = await coordinator.m1.approveGameDesign(project.state.projectId, {
      decision: "approved",
      targetRevisionId: project.state.gameDesignSpec!.revisionId,
      targetSha256: project.state.gameDesignSpec!.artifact.sha256,
    });
    const direction = project.visualDirections!.directions[0];
    const directionRevision = repository.getRevision(direction.revisionId);
    project = await coordinator.approveDirection(project.state.projectId, {
      decision: "approved",
      targetRevisionId: directionRevision.revisionId,
      targetSha256: directionRevision.artifact.sha256,
    } as never);
    project = await confirmConceptPlan(coordinator, project);

    const target = project.conceptSet!.slots.find(
      (slot) => slot.slotId === "gameplay-anchor",
    )!;
    project = await coordinator.m1.regenerateConcept(project.state.projectId, {
      conceptSetRevisionId: project.state.conceptSet!.revisionId,
      slotId: target.slotId,
      notes: "Use an alternate before changing direction.",
    });
    const regenerated = project
      .conceptSet!.slots.find((slot) => slot.slotId === target.slotId)!
      .revisions.at(-1)!;
    project = coordinator.m1.selectConcept(project.state.projectId, {
      conceptSetRevisionId: project.state.conceptSet!.revisionId,
      slotId: target.slotId,
      conceptRevisionId: regenerated.revision.revisionId,
    });
    const before = project.state;
    expect(before.conceptRegenerationCounts?.[target.slotId]).toBe(1);

    project = await coordinator.m1.changeDirection(project.state.projectId, {
      directionSetRevisionId: before.visualDirectionSet!.revisionId,
      directionRevisionId: before.selectedVisualDirectionRevisionId!,
      change: "Add charged wind streaks that affect the gameplay anchor.",
      pinnedAspects: ["palette", "shape language"],
    });
    expect(project.state.stage).toBe("visual-direction-approval");
    expect(project.state.focusedDirectionChangeCount).toBe(1);
    const rebased = project.conceptSet!.slots.find(
      (slot) => slot.slotId === target.slotId,
    )!;
    expect(rebased.selectedRevisionId).toBeUndefined();
    expect(rebased.revisions.at(-1)?.staleReason).toBeDefined();
    expect(project.state.conceptRegenerationCounts?.[target.slotId]).toBe(1);

    const changedDirection = repository.getRevision(
      project.state.selectedVisualDirectionRevisionId!,
    );
    project = await coordinator.approveDirection(project.state.projectId, {
      decision: "approved",
      targetRevisionId: changedDirection.revisionId,
      targetSha256: changedDirection.artifact.sha256,
    } as never);
    project = await coordinator.m1.regenerateConcept(project.state.projectId, {
      conceptSetRevisionId: project.state.conceptSet!.revisionId,
      slotId: target.slotId,
      notes: "Carry the charged wind streaks into this slot again.",
    });
    expect(project.state.conceptRegenerationCounts?.[target.slotId]).toBe(2);
    expect(
      project.conceptSet!.slots.find((slot) => slot.slotId === target.slotId)
        ?.revisions,
    ).toHaveLength(3);
    repository.close();
  });

  it("raises budget only after a project has a metered route", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const coordinator = new ProjectCoordinator(repository);
    let project = await coordinator.create({
      milestone: "m1",
      brief: M1_BRIEF,
      mode: "replay",
      imageProvider: "none",
      budgetUsd: 1,
      rightsConfirmed: true,
    });
    expect(() =>
      coordinator.increaseBudget(project.state.projectId, { budgetUsd: 2 }),
    ).toThrow(/no metered routes/i);
    repository.saveProject({
      ...repository.getProject(project.state.projectId),
      mode: "live",
      orchestratorProvider: "openai-api",
    });
    project = coordinator.snapshot(project.state.projectId);
    expect(() =>
      coordinator.increaseBudget(project.state.projectId, { budgetUsd: 1 }),
    ).toThrow(/greater than the current \$1\.00 cap/i);
    expect(() =>
      coordinator.increaseBudget(project.state.projectId, { budgetUsd: 0.5 }),
    ).toThrow(/greater than the current \$1\.00 cap/i);
    expect(() =>
      coordinator.increaseBudget(project.state.projectId, { budgetUsd: 0 }),
    ).toThrow();
    project = coordinator.increaseBudget(project.state.projectId, {
      budgetUsd: 2.5,
    });
    expect(project.state.budgetUsd).toBe(2.5);
    expect(project.state.spentUsd).toBe(0);
    const increased = repository
      .listEvents(project.state.projectId)
      .find((event) => event.type === "budget.increased");
    expect(increased?.payload).toEqual({
      previousBudgetUsd: 1,
      budgetUsd: 2.5,
    });

    repository.saveProject({
      ...repository.getProject(project.state.projectId),
      mode: "replay",
      orchestratorProvider: "openai",
    });
    project = coordinator.snapshot(project.state.projectId);

    project = await finishInterrogation(coordinator, project);
    project = await signOffBrief(coordinator, project);
    repository.saveProject({
      ...repository.getProject(project.state.projectId),
      status: "blocked",
      stage: "blocked",
      blockedReason: {
        code: "workflow-phase-failed",
        message: "The orchestrator provider returned an unusable response.",
        recoverable: false,
      },
    });
    project = coordinator.snapshot(project.state.projectId);
    expect(project.state.stage).toBe("blocked");
    expect(() =>
      coordinator.increaseBudget(project.state.projectId, { budgetUsd: 4 }),
    ).toThrow(/completed or blocked/i);
    repository.close();
  });

  it("carries mechanics-first and visual-first briefs through the same replay seam", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const coordinator = new ProjectCoordinator(repository);
    const briefs = [
      "Create a top-down single-player train-routing action puzzle where the player switches tracks under time pressure, avoids collisions, and clears one compact rail yard; the mechanics and camera are fixed but the visual identity is deliberately open.",
      "Create a solemn world inside a flooded white-ceramic observatory lit by bioluminescent algae, with a tiny masked caretaker as the hero; the atmosphere is clear but the playable loop, objective, and camera still need definition.",
    ];

    for (const brief of briefs) {
      let project = await coordinator.create({
        milestone: "m1",
        brief,
        mode: "replay",
        imageProvider: "none",
        budgetUsd: 1,
        rightsConfirmed: true,
      });
      project = await finishInterrogation(coordinator, project);
      project = await signOffBrief(coordinator, project);
      expect(project.gameDesignSpec?.facts[0]?.text).toContain(brief);
      project = await coordinator.m1.approveGameDesign(
        project.state.projectId,
        {
          decision: "approved",
          targetRevisionId: project.state.gameDesignSpec!.revisionId,
          targetSha256: project.state.gameDesignSpec!.artifact.sha256,
        },
      );
      expect(project.visualDirections?.directions).toHaveLength(3);
      const direction = project.visualDirections!.directions[0];
      const directionRevision = repository.getRevision(direction.revisionId);
      project = await coordinator.approveDirection(project.state.projectId, {
        decision: "approved",
        targetRevisionId: directionRevision.revisionId,
        targetSha256: directionRevision.artifact.sha256,
      } as never);
      project = await confirmConceptPlan(coordinator, project);
      expect(project.conceptSet?.slots.length).toBeGreaterThanOrEqual(1);
      expect(project.conceptSet?.slots.length).toBeLessThanOrEqual(3);
      project = keepEveryGeneratedConcept(coordinator, project);
      project = await finishM1ThroughSounds(coordinator, project);
      expect(project.state.status).toBe("complete");
      expect(project.state.stage).toBe("complete");
      expect(project.soundSet?.slots.length).toBeGreaterThanOrEqual(4);
    }
    repository.close();
  });
});

const fakeImageRunner = () =>
  vi.fn(async ({ prompt }: { prompt: string }) => {
    expect(prompt.length).toBeGreaterThan(0);
    return { bytes: PNG_1x1, model: "gpt-image-2", costUsd: 0 };
  });

const LIVE_NAMES = {
  candidates: [
    { name: "Glasshouse Run", rationale: "The escape happens under glass." },
    { name: "Pollenfall", rationale: "One word for the drifting greenhouse." },
    {
      name: "The Quiet Airlock",
      rationale: "Names the exit you are running for.",
    },
    {
      name: "Keeper of the Vines",
      rationale: "Puts the role in front of the place.",
    },
  ],
};

const LIVE_SPEC = {
  title: "Lunar Greenhouse Escape",
  genre: "First-person stealth",
  camera: "First-person camera with a readable alert horizon",
  coreFantasy: "Slip the pursuing creature and escape the greenhouse alive.",
  coreLoop: [
    "Read the darkened rows",
    "Move without raising an alert",
    "Reach the airlock before the timer closes",
  ],
  playerVerbs: ["move", "hide", "escape"],
  objective: "Reach the airlock within eight minutes without being caught.",
  sessionMinutes: 8,
  gameplayConstraints: [
    "One greenhouse room, one pursuer, and one eight-minute escape.",
    "Alerts must stay colorblind-safe in near-dark lighting.",
  ],
  facts: [
    {
      statementId: "fact-brief",
      text: "The slice is a cramped lunar greenhouse escape.",
      kind: "fact" as const,
      origin: { source: "brief" as const, reference: "initial brief" },
    },
  ],
  assumptions: [
    {
      statementId: "assumption-scope",
      text: "One pursuer is enough to prove the stealth loop.",
      kind: "assumption" as const,
      origin: { source: "user" as const, reference: "scope.proof-boundary" },
    },
  ],
};

const LIVE_DIRECTION = (
  slug: string,
  name: string,
  hex: [string, string, string],
) => ({
  slug,
  name,
  rationale: `${name} interprets the approved greenhouse stealth fantasy.`,
  overallStyle: `${name} style with readable greenhouse masses`,
  shapeLanguage: "Broad planter masses with one sharp airlock gesture",
  materials: ["frosted glass", "patinated copper", "dark soil"],
  palette: [
    { name: "Night glass", hex: hex[0], role: "primary mass" },
    { name: "Copper vein", hex: hex[1], role: "world accent" },
    { name: "Alert lime", hex: hex[2], role: "gameplay focus" },
  ],
  lighting: "Cool lunar fill with a single warm airlock glow",
  atmosphere: "Thin condensation and slow drifting pollen",
  textureLanguage: "Broad frosted planes with sparse mineral wear",
});

const defaultLiveTextExecution = (): StructuredModelExecution & {
  calls: Array<{ systemPrompt: string }>;
} => {
  const calls: Array<{ systemPrompt: string }> = [];
  return {
    calls,
    generateStructured: (async (input) => {
      calls.push({ systemPrompt: input.systemPrompt });
      const tagged = (tag: string) => input.systemPrompt.includes(tag);
      const value = tagged("[m1-interrogation-round]")
        ? {
            questions: [
              {
                branchId: "experience.player-promise",
                prompt:
                  "What one observable escape should a successful greenhouse run prove?",
                recommendation:
                  "Name a visible airlock extraction the player can complete once.",
              },
              {
                branchId: "gameplay.core-loop",
                prompt:
                  "Which stealth actions form the smallest satisfying greenhouse loop?",
                recommendation:
                  "Choose three to five actions with a clear failure pressure.",
              },
            ],
          }
        : tagged("[m1-interrogation-next]")
          ? { understandingComplete: true, questions: [] }
          : tagged("[m1-game-names]")
            ? LIVE_NAMES
            : tagged("[m1-game-design]") || tagged("[m1-game-design-revise]")
              ? LIVE_SPEC
              : tagged("[m1-directions]")
                ? {
                    directions: [
                      LIVE_DIRECTION("glass-tide", "Glass Tide", [
                        "#173B36",
                        "#B76647",
                        "#F6D36B",
                      ]),
                      LIVE_DIRECTION("ink-rows", "Ink Rows", [
                        "#11131A",
                        "#D8D0B8",
                        "#E05A47",
                      ]),
                      LIVE_DIRECTION("copper-weather", "Copper Weather", [
                        "#33475B",
                        "#5E9C8B",
                        "#F0B95A",
                      ]),
                    ],
                  }
                : tagged("[m1-direction-replace]")
                  ? LIVE_DIRECTION("paper-theatre", "Paper Theatre", [
                      "#33263F",
                      "#77A98F",
                      "#F1A85B",
                    ])
                  : tagged("[m1-direction-focused-change]")
                    ? {
                        title: "Focused Greenhouse Revision",
                        rationale: "Apply the requested focused change.",
                        overallStyle: "Revised greenhouse style",
                        shapeLanguage: "Unchanged planter masses",
                        materials: ["frosted glass", "patinated copper"],
                        palette: [
                          {
                            name: "Night glass",
                            hex: "#173B36",
                            role: "primary mass",
                          },
                          {
                            name: "Copper vein",
                            hex: "#B76647",
                            role: "world accent",
                          },
                          {
                            name: "Alert lime",
                            hex: "#F6D36B",
                            role: "gameplay focus",
                          },
                        ],
                        lighting: "Hard midnight moonlight through the glass",
                        atmosphere:
                          "Thin condensation and slow drifting pollen",
                        textureLanguage: "Broad frosted planes",
                        cameraLanguage:
                          "First-person camera with a readable alert horizon",
                        readabilityRules: [
                          "Reserve the gameplay-focus color for actionable goals",
                        ],
                      }
                    : (() => {
                        throw new Error(
                          `Unexpected live text prompt: ${input.systemPrompt.slice(0, 80)}`,
                        );
                      })();
      const parsed = input.schema.safeParse(value);
      if (!parsed.success)
        throw new Error(
          "The selected execution provider returned no valid structured result.",
        );
      return {
        value: parsed.data,
        model: "fake-m1-text",
        provider: input.provider,
      };
    }) as StructuredModelExecution["generateStructured"],
  };
};

const liveCoordinator = (
  repository: ProjectRepository,
  imageRunner = fakeImageRunner(),
  execution: StructuredModelExecution = defaultLiveTextExecution(),
) => new ProjectCoordinator(repository, { imageRunner, execution });

const reachConceptPlanning = async (
  coordinator: ProjectCoordinator,
): Promise<ProjectSnapshot> => {
  let project = await coordinator.create({
    milestone: "m1",
    brief: M1_BRIEF,
    mode: "live",
    imageProvider: "openai-subscription",
    rightsConfirmed: true,
  });
  project = await finishInterrogation(coordinator, project);
  project = await signOffBrief(coordinator, project);
  project = await coordinator.m1.approveGameDesign(project.state.projectId, {
    decision: "approved",
    targetRevisionId: project.state.gameDesignSpec!.revisionId,
    targetSha256: project.state.gameDesignSpec!.artifact.sha256,
  });
  const direction = project.visualDirections!.directions[0];
  const directionRevision = coordinator.repository.getRevision(
    direction.revisionId,
  );
  return await coordinator.approveDirection(project.state.projectId, {
    decision: "approved",
    targetRevisionId: directionRevision.revisionId,
    targetSha256: directionRevision.artifact.sha256,
  } as never);
};

describe("M1Coordinator live path", () => {
  it("refuses unauthorized live create without writing a project", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const coordinator = liveCoordinator(repository);
    await expect(
      coordinator.create({
        milestone: "m1",
        brief: M1_BRIEF,
        mode: "live",
        imageProvider: "openai-subscription",
        budgetUsd: 1,
        rightsConfirmed: true,
      }),
    ).rejects.toThrow(/Set FULCRUM_M1_LIVE_AUTHORIZED=true/);
    expect(repository.listProjects()).toEqual([]);
    repository.close();
  });

  it("generates a live subscription concept set without budget records", async () => {
    process.env.FULCRUM_M1_LIVE_AUTHORIZED = "true";
    const repository = new ProjectRepository(temporaryRoot());
    const runner = fakeImageRunner();
    const coordinator = liveCoordinator(repository, runner);
    let project = await reachConceptPlanning(coordinator);
    project = await confirmConceptPlan(coordinator, project);
    expect(project.state.stage).toBe("concept-set-approval");
    expect(runner).toHaveBeenCalledTimes(project.conceptSet!.slots.length);
    expect(
      Object.values(project.conceptDocuments ?? {}).every((documents) =>
        documents.every(
          (document) => document.provider === "openai-subscription",
        ),
      ),
    ).toBe(true);
    const sourceRevisionIds = [
      project.state.gameDesignSpec!.revisionId,
      project.state.selectedVisualDirectionRevisionId!,
      project.state.conceptPlan!.revisionId,
    ];
    for (const slot of project.conceptSet!.slots) {
      const document = project.conceptDocuments?.[slot.slotId]?.[0];
      expect(document).toBeDefined();
      const submission = repository.getSubmissionByKey(
        m1ConceptImageIdempotencyKey({
          projectId: project.state.projectId,
          slotId: slot.slotId,
          sourceRevisionIds,
          attempt: 0,
          mode: "live",
          imageProvider: "openai-subscription",
          prompt: document!.prompt,
        }),
      );
      expect(submission?.status).toBe("ready");
      expect(submission?.resultRevisionId).toBe(
        slot.revisions[0]?.revision.revisionId,
      );
    }
    expect(repository.getProject(project.state.projectId).spentUsd).toBe(0);
    expect(
      repository
        .listEvents(project.state.projectId)
        .filter((event) => event.type === "budget.reserved"),
    ).toHaveLength(0);
    repository.close();
  });

  it("propagates subscription image quota pressure without recording spend", async () => {
    process.env.FULCRUM_M1_LIVE_AUTHORIZED = "true";
    const repository = new ProjectRepository(temporaryRoot());
    const runner = vi.fn(async () => {
      throw Object.assign(new Error("ImageGen quota exceeded"), {
        status: 429,
      });
    });
    const coordinator = liveCoordinator(repository, runner);
    const project = await reachConceptPlanning(coordinator);

    await expect(confirmConceptPlan(coordinator, project)).rejects.toSatisfy(
      (error) =>
        error instanceof ProviderUsageError &&
        error.code === "subscription-quota" &&
        /subscription usage.*limited/i.test(error.message),
    );
    expect(runner).toHaveBeenCalledTimes(1);
    expect(repository.getProject(project.state.projectId).spentUsd).toBe(0);
    expect(
      repository
        .listEvents(project.state.projectId)
        .some((event) => event.type === "budget.reserved"),
    ).toBe(false);
    repository.close();
  });

  it("generates subscription concepts when the normalized project budget is zero", async () => {
    process.env.FULCRUM_M1_LIVE_AUTHORIZED = "true";
    const repository = new ProjectRepository(temporaryRoot());
    const runner = fakeImageRunner();
    const coordinator = liveCoordinator(repository, runner);
    let project = await reachConceptPlanning(coordinator);
    expect(project.state.budgetUsd).toBe(0);
    project = await confirmConceptPlan(coordinator, project);

    expect(project.state.stage).toBe("concept-set-approval");
    expect(runner).toHaveBeenCalledTimes(project.conceptSet!.slots.length);
    expect(project.state.spentUsd).toBe(0);
    expect(
      repository
        .listEvents(project.state.projectId)
        .some((event) => event.type === "budget.refused"),
    ).toBe(false);
    repository.close();
  });

  it("regenerates subscription concepts without changing USD spend", async () => {
    process.env.FULCRUM_M1_LIVE_AUTHORIZED = "true";
    const repository = new ProjectRepository(temporaryRoot());
    const runner = fakeImageRunner();
    const coordinator = liveCoordinator(repository, runner);
    let project = await reachConceptPlanning(coordinator);
    project = await confirmConceptPlan(coordinator, project);
    const slotId = project.conceptSet!.slots[0]!.slotId;
    project = await coordinator.m1.regenerateConcept(project.state.projectId, {
      conceptSetRevisionId: project.state.conceptSet!.revisionId,
      slotId,
      notes: "Raise the airlock silhouette without using metered spend.",
    });
    expect(runner).toHaveBeenCalledTimes(project.conceptSet!.slots.length + 1);
    expect(project.state.conceptRegenerationCounts?.[slotId]).toBe(1);
    expect(project.state.spentUsd).toBe(0);
    expect(
      project.conceptSet!.slots.find((item) => item.slotId === slotId)
        ?.revisions,
    ).toHaveLength(2);
    expect(() =>
      coordinator.increaseBudget(project.state.projectId, { budgetUsd: 5 }),
    ).toThrow(/no metered routes/i);
    repository.close();
  });

  it("sends an edited slot prompt byte-for-byte and preserves that base across regens", async () => {
    process.env.FULCRUM_M1_LIVE_AUTHORIZED = "true";
    const repository = new ProjectRepository(temporaryRoot());
    const runner = fakeImageRunner();
    const coordinator = liveCoordinator(repository, runner);
    let project = await reachConceptPlanning(coordinator);
    const slot = project.conceptPlan!.slots[0]!;
    expect(slot.prompt).toBeTruthy();
    const edited =
      "TASK-J-EDITED-PROMPT a pixel-perfect lunar airlock, nothing else.";
    const shownRevisionId = project.state.conceptPlan!.revisionId;
    project = await coordinator.m1.confirmConceptPlan(project.state.projectId, {
      conceptPlanRevisionId: shownRevisionId,
      confirmed: true,
      promptOverrides: [{ slotId: slot.slotId, prompt: edited }],
    });
    expect(project.state.conceptPlan!.revisionId).not.toBe(shownRevisionId);
    expect(
      repository
        .listEvents(project.state.projectId)
        .some(
          (event) =>
            event.type === "concept-plan.edited" &&
            (event.payload as { editedSlotIds?: string[] })
              .editedSlotIds?.[0] === slot.slotId,
        ),
    ).toBe(true);
    const document = project.conceptDocuments![slot.slotId]![0]!;
    expect(document.prompt).toBe(edited);
    expect(document.basePrompt).toBe(edited);
    expect(runner.mock.calls.some((call) => call[0].prompt === edited)).toBe(
      true,
    );

    project = await coordinator.m1.regenerateConcept(project.state.projectId, {
      conceptSetRevisionId: project.state.conceptSet!.revisionId,
      slotId: slot.slotId,
      notes: "Make the airlock taller",
    });
    const regen = project.conceptDocuments![slot.slotId]!.at(-1)!;
    expect(regen.basePrompt).toBe(edited);
    expect(regen.prompt).toBe(
      `${edited} Focused alternate request: Make the airlock taller.`,
    );

    project = await coordinator.m1.regenerateConcept(project.state.projectId, {
      conceptSetRevisionId: project.state.conceptSet!.revisionId,
      slotId: slot.slotId,
      notes: "Shift the key light left",
    });
    const second = project.conceptDocuments![slot.slotId]!.at(-1)!;
    expect(second.basePrompt).toBe(edited);
    expect(second.prompt).toBe(
      `${edited} Focused alternate request: Shift the key light left.`,
    );
    expect(second.prompt).not.toContain("Make the airlock taller");
    repository.close();
  });

  it("does not reuse an unedited image when a fresh project confirms an edited prompt", async () => {
    process.env.FULCRUM_M1_LIVE_AUTHORIZED = "true";
    const repository = new ProjectRepository(temporaryRoot());
    const runner = fakeImageRunner();
    const coordinator = liveCoordinator(repository, runner);
    let unedited = await reachConceptPlanning(coordinator);
    const slotId = unedited.conceptPlan!.slots[0]!.slotId;
    const proposed = unedited.conceptPlan!.slots[0]!.prompt!;
    unedited = await confirmConceptPlan(coordinator, unedited);
    const uneditedDocument = unedited.conceptDocuments![slotId]![0]!;
    expect(uneditedDocument.prompt).toBe(proposed);
    const uneditedKey = m1ConceptImageIdempotencyKey({
      projectId: unedited.state.projectId,
      slotId,
      sourceRevisionIds: [
        unedited.state.gameDesignSpec!.revisionId,
        unedited.state.selectedVisualDirectionRevisionId!,
        unedited.state.conceptPlan!.revisionId,
      ],
      attempt: 0,
      mode: "live",
      imageProvider: "openai-subscription",
      prompt: uneditedDocument.prompt,
    });

    const repository2 = new ProjectRepository(temporaryRoot());
    const runner2 = fakeImageRunner();
    const coordinator2 = liveCoordinator(repository2, runner2);
    let edited = await reachConceptPlanning(coordinator2);
    const editedSlot = edited.conceptPlan!.slots[0]!;
    const editedPrompt =
      "TASK-J-IDEMPOTENCY-EDIT unique greenhouse airlock prompt";
    const originalPlanId = edited.state.conceptPlan!.revisionId;
    edited = await coordinator2.m1.confirmConceptPlan(edited.state.projectId, {
      conceptPlanRevisionId: originalPlanId,
      confirmed: true,
      promptOverrides: [{ slotId: editedSlot.slotId, prompt: editedPrompt }],
    });
    expect(edited.state.conceptPlan!.revisionId).not.toBe(originalPlanId);
    const editedDocument = edited.conceptDocuments![editedSlot.slotId]![0]!;
    expect(editedDocument.prompt).toBe(editedPrompt);
    const editedKey = m1ConceptImageIdempotencyKey({
      projectId: edited.state.projectId,
      slotId: editedSlot.slotId,
      sourceRevisionIds: [
        edited.state.gameDesignSpec!.revisionId,
        edited.state.selectedVisualDirectionRevisionId!,
        edited.state.conceptPlan!.revisionId,
      ],
      attempt: 0,
      mode: "live",
      imageProvider: "openai-subscription",
      prompt: editedDocument.prompt,
    });
    expect(editedKey).not.toBe(uneditedKey);
    expect(repository.getSubmissionByKey(uneditedKey)?.resultRevisionId).toBe(
      unedited.conceptSet!.slots[0]!.revisions[0]!.revision.revisionId,
    );
    expect(repository2.getSubmissionByKey(editedKey)?.resultRevisionId).toBe(
      edited.conceptSet!.slots.find((item) => item.slotId === editedSlot.slotId)
        ?.revisions[0]?.revision.revisionId,
    );
    expect(
      runner2.mock.calls.some((call) => call[0].prompt === editedPrompt),
    ).toBe(true);
    expect(runner2.mock.calls.some((call) => call[0].prompt === proposed)).toBe(
      false,
    );
    repository.close();
    repository2.close();
  });

  it("rejects unknown slot ids and whitespace-only prompt overrides", async () => {
    process.env.FULCRUM_M1_LIVE_AUTHORIZED = "true";
    const repository = new ProjectRepository(temporaryRoot());
    const coordinator = liveCoordinator(repository);
    const project = await reachConceptPlanning(coordinator);
    await expect(
      coordinator.m1.confirmConceptPlan(project.state.projectId, {
        conceptPlanRevisionId: project.state.conceptPlan!.revisionId,
        confirmed: true,
        promptOverrides: [{ slotId: "not-a-slot", prompt: "A valid prompt." }],
      }),
    ).rejects.toThrow(/no slot not-a-slot/);
    await expect(
      coordinator.m1.confirmConceptPlan(project.state.projectId, {
        conceptPlanRevisionId: project.state.conceptPlan!.revisionId,
        confirmed: true,
        promptOverrides: [
          {
            slotId: project.conceptPlan!.slots[0]!.slotId,
            prompt: "   ",
          },
        ],
      }),
    ).rejects.toThrow(/is empty/);
    repository.close();
  });
});

describe("M1Coordinator live creative text", () => {
  it("exposes and clears an in-flight interrogation action after success", async () => {
    process.env.FULCRUM_M1_LIVE_AUTHORIZED = "true";
    const repository = new ProjectRepository(temporaryRoot());
    const execution = defaultLiveTextExecution();
    const original = execution.generateStructured.bind(execution);
    let release!: () => void;
    let markStarted!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    execution.generateStructured = async (input) => {
      if (input.systemPrompt.includes("[m1-interrogation-next]")) {
        markStarted();
        await blocked;
      }
      return await original(input);
    };
    const coordinator = liveCoordinator(
      repository,
      fakeImageRunner(),
      execution,
    );
    const project = await coordinator.create({
      milestone: "m1",
      brief: M1_BRIEF,
      mode: "live",
      imageProvider: "openai-subscription",
      budgetUsd: 1,
      rightsConfirmed: true,
    });

    const pending = answerCurrentRound(coordinator, project);
    await started;
    const waiting = coordinator.snapshot(
      project.state.projectId,
    ) as ProjectSnapshot & {
      inFlight?: { action: string; startedAt: string };
    };
    expect(waiting.inFlight).toEqual({
      action: "answers",
      startedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });

    release();
    await pending;
    expect(
      (
        coordinator.snapshot(project.state.projectId) as ProjectSnapshot & {
          inFlight?: unknown;
        }
      ).inFlight,
    ).toBeUndefined();
    repository.close();
  });

  it("coalesces a duplicate POST while the same model action is in flight", async () => {
    process.env.FULCRUM_M1_LIVE_AUTHORIZED = "true";
    const repository = new ProjectRepository(temporaryRoot());
    const execution = defaultLiveTextExecution();
    const original = execution.generateStructured.bind(execution);
    let nextRoundCalls = 0;
    let release!: () => void;
    let markStarted!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    execution.generateStructured = async (input) => {
      if (input.systemPrompt.includes("[m1-interrogation-next]")) {
        nextRoundCalls += 1;
        markStarted();
        await blocked;
      }
      return await original(input);
    };
    const coordinator = liveCoordinator(
      repository,
      fakeImageRunner(),
      execution,
    );
    const project = await coordinator.create({
      milestone: "m1",
      brief: M1_BRIEF,
      mode: "live",
      imageProvider: "openai-subscription",
      budgetUsd: 1,
      rightsConfirmed: true,
    });

    const first = answerCurrentRound(coordinator, project);
    await started;
    const duplicate = answerCurrentRound(coordinator, project);
    await Promise.resolve();
    expect(nextRoundCalls).toBe(1);

    release();
    const [firstResult, duplicateResult] = await Promise.all([
      first,
      duplicate,
    ]);
    expect(duplicateResult.state.interrogation?.revisionId).toBe(
      firstResult.state.interrogation?.revisionId,
    );
    expect(nextRoundCalls).toBe(1);
    repository.close();
  });

  it("clears an in-flight marker when the model action fails", async () => {
    process.env.FULCRUM_M1_LIVE_AUTHORIZED = "true";
    const repository = new ProjectRepository(temporaryRoot());
    const execution = defaultLiveTextExecution();
    const original = execution.generateStructured.bind(execution);
    let release!: () => void;
    let markStarted!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    execution.generateStructured = async (input) => {
      if (input.systemPrompt.includes("[m1-interrogation-next]")) {
        markStarted();
        await blocked;
        throw new Error("forced model failure");
      }
      return await original(input);
    };
    const coordinator = liveCoordinator(
      repository,
      fakeImageRunner(),
      execution,
    );
    const project = await coordinator.create({
      milestone: "m1",
      brief: M1_BRIEF,
      mode: "live",
      imageProvider: "openai-subscription",
      budgetUsd: 1,
      rightsConfirmed: true,
    });

    const pending = answerCurrentRound(coordinator, project);
    await started;
    expect(coordinator.snapshot(project.state.projectId).inFlight?.action).toBe(
      "answers",
    );
    release();
    await expect(pending).rejects.toThrow(/m1-interrogation-round/i);
    expect(
      coordinator.snapshot(project.state.projectId).inFlight,
    ).toBeUndefined();
    repository.close();
  });

  it("persists the first live frontier across restart without a second model call", async () => {
    process.env.FULCRUM_M1_LIVE_AUTHORIZED = "true";
    const root = temporaryRoot();
    const execution = defaultLiveTextExecution();
    const firstRepository = new ProjectRepository(root);
    const first = liveCoordinator(
      firstRepository,
      fakeImageRunner(),
      execution,
    );
    const created = await first.create({
      milestone: "m1",
      brief: M1_BRIEF,
      mode: "live",
      imageProvider: "openai-subscription",
      budgetUsd: 1,
      rightsConfirmed: true,
    });
    expect(created.interrogation?.frontier).toHaveLength(2);
    expect(created.interrogation?.frontier[0]?.prompt).toMatch(/greenhouse/);
    const firstCalls = execution.calls.length;
    expect(firstCalls).toBe(1);
    firstRepository.close();

    const repository = new ProjectRepository(root);
    const restarted = liveCoordinator(repository, fakeImageRunner(), execution);
    const snapshot = restarted.snapshot(created.state.projectId);
    expect(
      snapshot.interrogation?.frontier.map((question) => question.prompt),
    ).toEqual(
      created.interrogation?.frontier.map((question) => question.prompt),
    );
    expect(execution.calls.length).toBe(firstCalls);
    repository.close();
  });

  it("keeps an invalid live spec retryable without wedging the interrogation stage", async () => {
    process.env.FULCRUM_M1_LIVE_AUTHORIZED = "true";
    const repository = new ProjectRepository(temporaryRoot());
    let specTurns = 0;
    const execution = defaultLiveTextExecution();
    const original = execution.generateStructured.bind(execution);
    execution.generateStructured = async (input) => {
      if (input.systemPrompt.includes("[m1-game-design]")) {
        specTurns += 1;
        if (specTurns === 1) {
          execution.calls.push({ systemPrompt: input.systemPrompt });
          throw new Error(
            "The selected execution provider returned no valid structured result.",
          );
        }
      }
      return await original(input);
    };
    const coordinator = liveCoordinator(
      repository,
      fakeImageRunner(),
      execution,
    );
    let project = await coordinator.create({
      milestone: "m1",
      brief: M1_BRIEF,
      mode: "live",
      imageProvider: "openai-subscription",
      budgetUsd: 1,
      rightsConfirmed: true,
    });
    project = await finishInterrogation(coordinator, project);
    project = await coordinator.m1.confirmSharedUnderstanding(
      project.state.projectId,
      {
        interrogationRevisionId: project.state.interrogation!.revisionId,
        confirmed: true,
      },
    );
    expect(project.state.stage).toBe("interrogation");
    expect(project.gameNameCandidates?.candidates).toHaveLength(4);
    /* The spec is drafted when the name is committed, so that is where an
       invalid live spec now surfaces — and the naming batch has to survive
       it. */
    await expect(nameTheGame(coordinator, project)).rejects.toThrow(
      /could not parse a valid m1-game-design result/i,
    );
    const afterFailure = coordinator.snapshot(project.state.projectId);
    expect(afterFailure.state.stage).toBe("interrogation");
    expect(afterFailure.state.gameDesignSpec).toBeUndefined();
    expect(afterFailure.state.gameName).toBeUndefined();
    project = await nameTheGame(coordinator, afterFailure);
    expect(project.state.stage).toBe("game-design-approval");
    expect(project.state.name).toBe(LIVE_NAMES.candidates[0]!.name);
    /* The user's choice titles the spec, not the model's own suggestion. */
    expect(project.gameDesignSpec?.title).toBe(LIVE_NAMES.candidates[0]!.name);
    expect(specTurns).toBe(2);
    repository.close();
  });

  it("refuses live confirmation while the frontier still has questions", async () => {
    process.env.FULCRUM_M1_LIVE_AUTHORIZED = "true";
    const repository = new ProjectRepository(temporaryRoot());
    const coordinator = liveCoordinator(repository);
    const project = await coordinator.create({
      milestone: "m1",
      brief: M1_BRIEF,
      mode: "live",
      imageProvider: "openai-subscription",
      budgetUsd: 1,
      rightsConfirmed: true,
    });
    expect(project.interrogation?.frontier.length).toBeGreaterThan(0);
    await expect(
      coordinator.m1.confirmSharedUnderstanding(project.state.projectId, {
        interrogationRevisionId: project.state.interrogation!.revisionId,
        confirmed: true,
      }),
    ).rejects.toThrow(/frontier is unresolved/);
    repository.close();
  });
});

describe("approval gate rejection stays reviewable", () => {
  const reachVisualDirectionApproval = async (
    coordinator: ProjectCoordinator,
  ): Promise<ProjectSnapshot> => {
    let project = await coordinator.create({
      milestone: "m1",
      brief: M1_BRIEF,
      mode: "replay",
      imageProvider: "none",
      budgetUsd: 1,
      rightsConfirmed: true,
    });
    project = await finishInterrogation(coordinator, project);
    project = await signOffBrief(coordinator, project);
    return await coordinator.m1.approveGameDesign(project.state.projectId, {
      decision: "approved",
      targetRevisionId: project.state.gameDesignSpec!.revisionId,
      targetSha256: project.state.gameDesignSpec!.artifact.sha256,
    });
  };

  it("a_rejected_direction_can_be_rejected_again_then_a_different_one_approved", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const coordinator = new ProjectCoordinator(repository);
    let project = await reachVisualDirectionApproval(coordinator);
    const directions = project.visualDirections!.directions;
    const first = repository.getRevision(directions[0]!.revisionId);
    const reject = {
      decision: "rejected" as const,
      targetRevisionId: first.revisionId,
      targetSha256: first.artifact.sha256,
    };

    project = await coordinator.m1.approveDirection(
      project.state.projectId,
      reject,
    );
    expect(project.state).toMatchObject({
      status: "awaiting-approval",
      stage: "visual-direction-approval",
    });
    expect(project.state.blockedReason).toBeUndefined();

    project = await coordinator.m1.approveDirection(
      project.state.projectId,
      reject,
    );
    expect(project.state).toMatchObject({
      status: "awaiting-approval",
      stage: "visual-direction-approval",
    });
    expect(project.state.directionApproval?.decision).toBe("rejected");
    expect(project.state.selectedVisualDirectionRevisionId).toBeUndefined();
    expect(
      project.visualDirections?.directions.map((d) => d.revisionId),
    ).toEqual(directions.map((d) => d.revisionId));

    const second = repository.getRevision(directions[1]!.revisionId);
    project = await coordinator.m1.approveDirection(project.state.projectId, {
      decision: "approved",
      targetRevisionId: second.revisionId,
      targetSha256: second.artifact.sha256,
    });

    expect(project.state.stage).toBe("concept-planning");
    expect(project.state.selectedVisualDirectionRevisionId).toBe(
      second.revisionId,
    );
    repository.close();
  });

  it("a_direction_block_persisted_before_the_fix_is_rescuable", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const coordinator = new ProjectCoordinator(repository);
    const project = await reachVisualDirectionApproval(coordinator);
    const projectId = project.state.projectId;
    repository.saveProject({
      ...repository.getProject(projectId),
      status: "blocked",
      stage: "blocked",
      blockedReason: {
        code: "visual-direction-not-approved",
        message:
          "A visual direction must be approved before concepts can be generated.",
        recoverable: false,
      },
    });

    expect(coordinator.snapshot(projectId).state.blockedReason).toMatchObject({
      code: "visual-direction-not-approved",
      recoverable: true,
      reviewGate: "visual-direction",
      resumeStage: "visual-direction-approval",
    });

    const reopened = coordinator.reopenApprovalReview(projectId, {
      gate: "visual-direction",
    });

    expect(reopened.state).toMatchObject({
      status: "awaiting-approval",
      stage: "visual-direction-approval",
    });
    expect(reopened.state.blockedReason).toBeUndefined();
    expect(reopened.visualDirections?.directions).toHaveLength(
      project.visualDirections!.directions.length,
    );

    const direction = repository.getRevision(
      reopened.visualDirections!.directions[0]!.revisionId,
    );
    const approvedAgain = await coordinator.m1.approveDirection(projectId, {
      decision: "approved",
      targetRevisionId: direction.revisionId,
      targetSha256: direction.artifact.sha256,
    });

    expect(approvedAgain.state.stage).toBe("concept-planning");
    repository.close();
  });

  it("a_concept_set_block_persisted_before_the_fix_is_rescuable", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const coordinator = new ProjectCoordinator(repository);
    const project = keepEveryGeneratedConcept(
      coordinator,
      await reachM2ConceptApproval(coordinator),
    );
    const projectId = project.state.projectId;
    repository.saveProject({
      ...repository.getProject(projectId),
      status: "blocked",
      stage: "blocked",
      blockedReason: {
        code: "concept-set-not-approved",
        message: "The concept set was not approved.",
        recoverable: false,
      },
    });

    const reopened = coordinator.reopenApprovalReview(projectId, {
      gate: "concept-set",
    });

    expect(reopened.state).toMatchObject({
      status: "awaiting-approval",
      stage: "concept-set-approval",
    });
    expect(reopened.state.blockedReason).toBeUndefined();
    expect(reopened.state.conceptSet?.revisionId).toBe(
      project.state.conceptSet?.revisionId,
    );
    expect(
      repository
        .listEvents(projectId)
        .some(({ type }) => type.startsWith("workflow.")),
    ).toBe(false);

    const approvedAgain = coordinator.creative.approveConceptSet(projectId, {
      decision: "approved",
      targetRevisionId: reopened.state.conceptSet!.revisionId,
      targetSha256: reopened.state.conceptSet!.artifact.sha256,
    });

    expect(approvedAgain.state.stage).toBe("asset-planning");
    repository.close();
  });
});

describe("continuing a finished M1 world into M2", () => {
  it("seeds an M2 world at asset planning from the approved M1 package", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const coordinator = new ProjectCoordinator(repository);
    const source = await reachM1Complete(coordinator);
    const sourceId = source.state.projectId;
    const sourceStateBefore = repository.getProject(sourceId);
    const sourceEventsBefore = repository.listEvents(sourceId).length;

    const continued = coordinator.creative.continueIntoM2(sourceId, {});
    const state = continued.state;

    expect(state.projectId).not.toBe(sourceId);
    expect(state).toMatchObject({
      milestone: "m2",
      stage: "asset-planning",
      status: "active",
      soundProvider: "none",
      mode: source.state.mode,
      orchestratorProvider: source.state.orchestratorProvider,
      imageProvider: source.state.imageProvider,
      assetProvider: source.state.assetProvider,
      spentUsd: 0,
    });
    expect(state.name).toBe(source.gameDesignSpec!.title);
    expect(state.continuedFrom).toMatchObject({
      projectId: sourceId,
      milestone: "m1",
      conceptSetRevisionId: source.state.conceptSet!.revisionId,
      gameDesignSpecRevisionId: source.state.gameDesignSpec!.revisionId,
      visualDirectionRevisionId: source.state.visualBible!.revisionId,
    });

    // The approved package is referenced, so lineage and hashes are identical.
    expect(state.gameDesignSpec).toEqual(source.state.gameDesignSpec);
    expect(state.conceptSet).toEqual(source.state.conceptSet);
    expect(state.visualBible).toEqual(source.state.visualBible);
    expect(state.visualDirectionSet).toEqual(source.state.visualDirectionSet);
    expect(state.conceptPlan).toEqual(source.state.conceptPlan);
    expect(state.interrogation).toEqual(source.state.interrogation);
    expect(state.brief).toEqual(source.state.brief);
    expect(state.selectedVisualDirectionRevisionId).toBe(
      source.state.selectedVisualDirectionRevisionId,
    );

    // The approvals are new, because an approval belongs to one project.
    for (const [approval, targetType, revision] of [
      [state.gameDesignApproval, "game-design", state.gameDesignSpec],
      [state.directionApproval, "visual-direction", state.visualBible],
      [state.conceptSetApproval, "concept-set", state.conceptSet],
    ] as const) {
      expect(approval).toMatchObject({
        projectId: state.projectId,
        targetType,
        decision: "approved",
        targetRevisionId: revision!.revisionId,
        targetSha256: revision!.artifact.sha256,
      });
    }
    expect(state.gameDesignApproval?.approvalId).not.toBe(
      source.state.gameDesignApproval?.approvalId,
    );

    // Nothing is generated, submitted, or carried from M1 sound work.
    expect(state.assetPlan).toBeUndefined();
    expect(state.assetBatch).toBeUndefined();
    expect(state.soundPlan).toBeUndefined();
    expect(state.soundSet).toBeUndefined();
    expect(state.soundSetApproval).toBeUndefined();
    expect(continued.soundSet).toBeUndefined();
    expect(
      repository
        .listEvents(state.projectId)
        .map(({ type }) => type)
        .sort(),
    ).toEqual(["project.continued-into-m2", "project.created"]);

    // The source world is never written to.
    expect(repository.getProject(sourceId)).toEqual(sourceStateBefore);
    expect(repository.listEvents(sourceId)).toHaveLength(sourceEventsBefore);

    // The seeded snapshot resolves the whole referenced creative package.
    expect(continued.gameDesignSpec).toEqual(source.gameDesignSpec);
    expect(continued.conceptSet).toEqual(source.conceptSet);
    expect(continued.conceptDocuments).toEqual(source.conceptDocuments);
    expect(continued.briefText).toBe(source.briefText);
    repository.close();
  });

  it("plans the asset batch on the seeded world end to end in replay", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const coordinator = new ProjectCoordinator(repository);
    const source = await reachM1Complete(coordinator);
    const seeded = coordinator.creative.continueIntoM2(
      source.state.projectId,
      {},
    );

    const project = await coordinator.advance(seeded.state.projectId);

    expect(project.state.stage).toBe("complete");
    expect(project.state.status).toBe("complete");
    expect(
      project.assetPlan?.assets.map(({ classification }) => classification),
    ).toEqual(
      expect.arrayContaining(["hero", "kit", "procedural", "functional"]),
    );
    expect(
      project.assetPlan?.assets[0]?.sourceRefs.gameDesignSpec,
    ).toMatchObject({
      revisionId: source.state.gameDesignSpec!.revisionId,
      sha256: source.state.gameDesignSpec!.artifact.sha256,
    });

    expect(project.state.assetPlanApproval).toMatchObject({
      decision: "approved",
      decidedBy: "fulcrum:auto-finalizer",
      targetRevisionId: project.state.assetPlan!.revisionId,
    });
    expect(Object.keys(project.state.assetBatch ?? {})).toHaveLength(
      project.assetPlan!.assets.length,
    );
    // The finished M1 source is still finished, and still M1.
    const sourceAfter = repository.getProject(source.state.projectId);
    expect(sourceAfter.milestone).toBe("m1");
    expect(sourceAfter.stage).toBe("complete");
    expect(sourceAfter.assetPlan).toBeUndefined();
    repository.close();
  });

  it("continues twice into two independent M2 worlds", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const coordinator = new ProjectCoordinator(repository);
    const source = await reachM1Complete(coordinator);

    const first = coordinator.creative.continueIntoM2(
      source.state.projectId,
      {},
    );
    const second = coordinator.creative.continueIntoM2(
      source.state.projectId,
      {},
    );

    expect(second.state.projectId).not.toBe(first.state.projectId);
    expect(second.state.continuedFrom?.projectId).toBe(source.state.projectId);
    const planned = await coordinator.advance(first.state.projectId);
    expect(planned.state.stage).toBe("complete");
    // The sibling is untouched by its twin's planning run.
    const sibling = repository.getProject(second.state.projectId);
    expect(sibling.stage).toBe("asset-planning");
    expect(sibling.assetPlan).toBeUndefined();
    repository.close();
  });

  it("refuses a world that has not approved its concept set", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const coordinator = new ProjectCoordinator(repository);
    const project = keepEveryGeneratedConcept(
      coordinator,
      await reachConceptApproval(coordinator, "m1"),
    );

    expect(() =>
      coordinator.creative.continueIntoM2(project.state.projectId, {}),
    ).toThrow(/approved concept set/i);
    repository.close();
  });

  it("refuses to continue a world that is already an M2 world", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const coordinator = new ProjectCoordinator(repository);
    const project = keepEveryGeneratedConcept(
      coordinator,
      await reachM2ConceptApproval(coordinator),
    );

    expect(() =>
      coordinator.creative.continueIntoM2(project.state.projectId, {}),
    ).toThrow(/Only an M1 world/i);
    repository.close();
  });
});

describe("naming the game between the brief and the spec", () => {
  const reachNaming = async (
    coordinator: ProjectCoordinator,
  ): Promise<ProjectSnapshot> => {
    const created = await coordinator.create({
      milestone: "m1",
      brief: M1_BRIEF,
      mode: "replay",
      imageProvider: "none",
      rightsConfirmed: true,
    });
    const answered = await finishInterrogation(coordinator, created);
    return await coordinator.m1.confirmSharedUnderstanding(
      answered.state.projectId,
      {
        interrogationRevisionId: answered.state.interrogation!.revisionId,
        confirmed: true,
      },
    );
  };

  it("signing off the brief proposes names instead of writing the spec", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const coordinator = new ProjectCoordinator(repository);
    const project = await reachNaming(coordinator);

    expect(project.state).toMatchObject({
      stage: "interrogation",
      status: "awaiting-input",
    });
    expect(project.state.gameDesignSpec).toBeUndefined();
    expect(project.state.gameName).toBeUndefined();
    expect(project.gameNameCandidates?.round).toBe(1);
    expect(project.gameNameCandidates?.candidates).toHaveLength(4);
    expect(
      repository
        .listEvents(project.state.projectId)
        .filter(({ type }) => type === "game-name.candidates-proposed"),
    ).toHaveLength(1);
    repository.close();
  });

  it("steers the batch as many times as the user wants without generating anything", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const coordinator = new ProjectCoordinator(repository);
    let project = await reachNaming(coordinator);
    const firstNames = project.gameNameCandidates!.candidates.map(
      ({ name }) => name,
    );

    project = await coordinator.m1.suggestGameNames(project.state.projectId, {
      gameNameCandidatesRevisionId:
        project.state.gameNameCandidates!.revisionId,
      feedback: "Shorter, and darker.",
    });
    expect(project.gameNameCandidates?.round).toBe(2);
    expect(project.gameNameCandidates?.feedback).toBe("Shorter, and darker.");
    const secondNames = project.gameNameCandidates!.candidates.map(
      ({ name }) => name,
    );
    expect(secondNames.some((name) => firstNames.includes(name))).toBe(false);

    project = await coordinator.m1.suggestGameNames(project.state.projectId, {
      gameNameCandidatesRevisionId:
        project.state.gameNameCandidates!.revisionId,
      feedback: "Now lose the article.",
    });
    expect(project.gameNameCandidates?.round).toBe(3);
    expect(project.state.stage).toBe("interrogation");
    expect(project.state.gameDesignSpec).toBeUndefined();
    repository.close();
  });

  it("commits a chosen candidate, titles the spec with it, and moves to the spec gate", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const coordinator = new ProjectCoordinator(repository);
    let project = await reachNaming(coordinator);
    project = await coordinator.m1.suggestGameNames(project.state.projectId, {
      gameNameCandidatesRevisionId:
        project.state.gameNameCandidates!.revisionId,
      feedback: "Shorter, and darker.",
    });
    const chosen = project.gameNameCandidates!.candidates[1]!;

    project = await coordinator.m1.commitGameName(project.state.projectId, {
      gameNameCandidatesRevisionId:
        project.state.gameNameCandidates!.revisionId,
      candidateId: chosen.candidateId,
    });

    expect(project.state).toMatchObject({
      stage: "game-design-approval",
      status: "awaiting-approval",
      name: chosen.name,
    });
    expect(project.gameName).toMatchObject({
      name: chosen.name,
      origin: "candidate",
      candidateId: chosen.candidateId,
      rounds: 2,
    });
    expect(project.gameDesignSpec?.title).toBe(chosen.name);
    expect(
      repository
        .listEvents(project.state.projectId)
        .filter(({ type }) => type === "game-name.decided")
        .map(({ payload }) => payload.name),
    ).toEqual([chosen.name]);
    repository.close();
  });

  it("takes a name the user typed instead", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const coordinator = new ProjectCoordinator(repository);
    let project = await reachNaming(coordinator);
    project = await coordinator.m1.commitGameName(project.state.projectId, {
      gameNameCandidatesRevisionId:
        project.state.gameNameCandidates!.revisionId,
      name: "  Saltglass  ",
    });

    expect(project.state.name).toBe("Saltglass");
    expect(project.gameName).toMatchObject({
      name: "Saltglass",
      origin: "custom",
      rounds: 1,
    });
    expect(project.gameName?.candidateId).toBeUndefined();
    expect(project.gameDesignSpec?.title).toBe("Saltglass");
    repository.close();
  });

  it("refuses a stale batch, an unknown candidate, both-or-neither input, and a second naming", async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const coordinator = new ProjectCoordinator(repository);
    const project = await reachNaming(coordinator);
    const candidates = project.state.gameNameCandidates!.revisionId;
    const first = project.gameNameCandidates!.candidates[0]!;

    await expect(
      coordinator.m1.commitGameName(project.state.projectId, {
        gameNameCandidatesRevisionId: "not-the-current-batch",
        candidateId: first.candidateId,
      }),
    ).rejects.toThrow(/name candidates changed/i);
    await expect(
      coordinator.m1.commitGameName(project.state.projectId, {
        gameNameCandidatesRevisionId: candidates,
        candidateId: "name-not-in-this-batch",
      }),
    ).rejects.toThrow(/not in the current batch/i);
    await expect(
      coordinator.m1.commitGameName(project.state.projectId, {
        gameNameCandidatesRevisionId: candidates,
        candidateId: first.candidateId,
        name: "Both At Once",
      }),
    ).rejects.toThrow(/Choose one proposed name or type one of your own/i);
    await expect(
      coordinator.m1.commitGameName(project.state.projectId, {
        gameNameCandidatesRevisionId: candidates,
      }),
    ).rejects.toThrow(/Choose one proposed name or type one of your own/i);

    const named = await coordinator.m1.commitGameName(project.state.projectId, {
      gameNameCandidatesRevisionId: candidates,
      name: "Saltglass",
    });
    expect(named.state.gameName).toBeDefined();
    await expect(
      coordinator.m1.suggestGameNames(project.state.projectId, {
        gameNameCandidatesRevisionId: candidates,
        feedback: "One more batch.",
      }),
    ).rejects.toThrow(/not in the interrogation stage|already has a name/i);
    repository.close();
  });
});

describe("pasted image attachments", () => {
  const swatchDataUrl = `data:image/png;base64,${PNG_1x1.toString("base64")}`;

  const replayProject = async () => {
    const repository = new ProjectRepository(temporaryRoot());
    const coordinator = new ProjectCoordinator(repository);
    const project = await coordinator.create({
      milestone: "m1",
      brief: M1_BRIEF,
      mode: "replay",
      imageProvider: "none",
      rightsConfirmed: true,
    });
    return { coordinator, repository, project };
  };

  it("stores a pasted image and admits a replay world will not read it", async () => {
    const { coordinator, repository, project } = await replayProject();
    const stored = await coordinator.creative.storeAttachment(
      project.state.projectId,
      { dataUrl: swatchDataUrl },
    );

    expect(stored.reachesModel).toBe(false);
    expect(stored.attachment.mediaType).toBe("image/png");
    expect(stored.attachment.uri).toBe(
      `/api/artifacts/${stored.attachment.artifactId}`,
    );
    expect(
      repository
        .listEvents(project.state.projectId)
        .some((event) => event.type === "attachment.stored"),
    ).toBe(true);
    repository.close();
  });

  it("records the attachment on the answer it was pasted into", async () => {
    const { coordinator, repository, project } = await replayProject();
    const stored = await coordinator.creative.storeAttachment(
      project.state.projectId,
      { dataUrl: swatchDataUrl },
    );
    const round = project.interrogation!.rounds.at(-1)!;
    const [first, ...rest] = project.interrogation!.frontier;
    const answered = await coordinator.m1.answerFrontier(
      project.state.projectId,
      {
        interrogationRevisionId: project.state.interrogation!.revisionId,
        roundId: round.roundId,
        answers: [
          {
            questionId: first!.questionId,
            value: "It should read like this reference.",
            attachmentArtifactIds: [stored.attachment.artifactId],
          },
          ...rest.map((question) => ({
            questionId: question.questionId,
            value: `Resolved ${question.branchId} with one concrete choice.`,
          })),
        ],
      },
    );

    const recorded = answered.interrogation!.rounds[0]!.answers.find(
      (answer) => answer.questionId === first!.questionId,
    );
    expect(recorded?.attachments?.[0]?.sha256).toBe(stored.attachment.sha256);
    /* Untouched answers keep the shape they had before attachments existed. */
    expect(
      answered.interrogation!.rounds[0]!.answers.filter(
        (answer) => answer.attachments !== undefined,
      ),
    ).toHaveLength(1);
    repository.close();
  });

  it("refuses an artifact id that belongs to another project", async () => {
    const { coordinator, repository, project } = await replayProject();
    const other = await coordinator.create({
      milestone: "m1",
      brief: M1_BRIEF,
      mode: "replay",
      imageProvider: "none",
      rightsConfirmed: true,
    });
    const foreign = await coordinator.creative.storeAttachment(
      other.state.projectId,
      { dataUrl: swatchDataUrl },
    );
    const round = project.interrogation!.rounds.at(-1)!;

    await expect(
      coordinator.m1.answerFrontier(project.state.projectId, {
        interrogationRevisionId: project.state.interrogation!.revisionId,
        roundId: round.roundId,
        answers: project.interrogation!.frontier.map((question, index) => ({
          questionId: question.questionId,
          value: `Resolved ${question.branchId}.`,
          ...(index === 0
            ? { attachmentArtifactIds: [foreign.attachment.artifactId] }
            : {}),
        })),
      }),
    ).rejects.toThrow(/does not exist/);
    repository.close();
  });
});
