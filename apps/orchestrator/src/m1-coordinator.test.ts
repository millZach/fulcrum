import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { M0_FIXTURE_BRIEF, type ProjectSnapshot } from "@fulcrum/domain";
import { ProjectRepository } from "@fulcrum/project";
import { afterEach, describe, expect, it } from "vitest";

import { ProjectCoordinator } from "./project-coordinator.js";

const roots: string[] = [];

const temporaryRoot = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), "fulcrum-m1-coordinator-"));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const M1_BRIEF =
  "Create a first-person stealth game in a cramped lunar greenhouse environment. The player cannot use weapons, must escape within eight minutes, and must read colorblind-safe alerts despite near-dark lighting and one pursuing creature.";

const answerCurrentRound = (
  coordinator: ProjectCoordinator,
  project: ProjectSnapshot,
): ProjectSnapshot => {
  const interrogation = project.interrogation!;
  const round = interrogation.rounds.at(-1)!;
  return coordinator.m1.answerFrontier(project.state.projectId, {
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

const finishInterrogation = (
  coordinator: ProjectCoordinator,
  project: ProjectSnapshot,
): ProjectSnapshot => {
  let current = project;
  while (current.interrogation!.frontier.length > 0)
    current = answerCurrentRound(coordinator, current);
  return current;
};

const confirmConceptPlan = async (
  coordinator: ProjectCoordinator,
  project: ProjectSnapshot,
): Promise<ProjectSnapshot> =>
  coordinator.m1.confirmConceptPlan(project.state.projectId, {
    conceptPlanRevisionId: project.state.conceptPlan!.revisionId,
    confirmed: true,
  });

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
    project = answerCurrentRound(first, project);
    expect(project.interrogation?.rounds.length).toBeGreaterThan(1);
    firstRepository.close();

    const repository = new ProjectRepository(root);
    const coordinator = new ProjectCoordinator(repository);
    project = coordinator.snapshot(project.state.projectId);
    expect(project.state.interrogation?.revisionId).not.toBe(
      staleInterrogationId,
    );
    expect(() =>
      coordinator.m1.answerFrontier(project.state.projectId, {
        interrogationRevisionId: staleInterrogationId,
        roundId: project.interrogation!.rounds.at(-1)!.roundId,
        answers: project.interrogation!.frontier.map((question) => ({
          questionId: question.questionId,
          value: "A stale duplicate answer.",
        })),
      }),
    ).toThrow(/changed after this view loaded/i);

    project = finishInterrogation(coordinator, project);
    expect(project.interrogation?.rounds.length).toBeGreaterThanOrEqual(3);
    expect(project.interrogation?.frontier).toEqual([]);
    project = coordinator.m1.confirmSharedUnderstanding(
      project.state.projectId,
      {
        interrogationRevisionId: project.state.interrogation!.revisionId,
        confirmed: true,
      },
    );
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
    project = coordinator.m1.reviseGameDesign(project.state.projectId, {
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
    project = await coordinator.m1.replaceDirection(project.state.projectId, {
      directionSetRevisionId: project.state.visualDirectionSet!.revisionId,
      directionRevisionId: replacementTarget.revisionId,
      notes:
        "Make the third option feel built from translucent layered theatre flats.",
    });
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
    project = await coordinator.m1.changeDirection(project.state.projectId, {
      directionSetRevisionId: project.state.visualDirectionSet!.revisionId,
      directionRevisionId: project.state.selectedVisualDirectionRevisionId!,
      change:
        "Add restrained electrically charged wind streaks around active threats.",
      pinnedAspects: ["palette", "shape language"],
    });
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
      expect(
        project.conceptDocuments?.[staleSlot.slotId]?.at(-1)?.prompt,
      ).toContain("electrically charged wind streaks");
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
    expect(project.state.status).toBe("complete");
    expect(project.state.stage).toBe("complete");
    expect(project.state.conceptSetApproval?.targetSha256).toBe(
      project.state.conceptSet?.artifact.sha256,
    );
    const eventTypes = repository
      .listEvents(project.state.projectId)
      .map((event) => event.type);
    expect(eventTypes).toContain("creative.capabilities-provisioned");
    expect(eventTypes).toContain("approval.concept-set-decided");
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
    ).rejects.toThrow(/live M1 is not yet authorized or supported/i);

    let rejected = await coordinator.create({
      milestone: "m1",
      brief: M1_BRIEF,
      mode: "replay",
      imageProvider: "none",
      budgetUsd: 1,
      rightsConfirmed: true,
    });
    rejected = finishInterrogation(coordinator, rejected);
    rejected = coordinator.m1.confirmSharedUnderstanding(
      rejected.state.projectId,
      {
        interrogationRevisionId: rejected.state.interrogation!.revisionId,
        confirmed: true,
      },
    );
    rejected = await coordinator.m1.approveGameDesign(
      rejected.state.projectId,
      {
        decision: "rejected",
        targetRevisionId: rejected.state.gameDesignSpec!.revisionId,
        targetSha256: rejected.state.gameDesignSpec!.artifact.sha256,
      },
    );
    expect(rejected.state.stage).toBe("blocked");
    expect(rejected.state.blockedReason?.recoverable).toBe(false);

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

  it("rejects a direction rebase that would deadlock an exhausted concept slot", async () => {
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
    project = finishInterrogation(coordinator, project);
    project = coordinator.m1.confirmSharedUnderstanding(
      project.state.projectId,
      {
        interrogationRevisionId: project.state.interrogation!.revisionId,
        confirmed: true,
      },
    );
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
      notes: "Use the single allowed alternate before changing direction.",
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

    await expect(
      coordinator.m1.changeDirection(project.state.projectId, {
        directionSetRevisionId: before.visualDirectionSet!.revisionId,
        directionRevisionId: before.selectedVisualDirectionRevisionId!,
        change: "Add charged wind streaks that affect the gameplay anchor.",
        pinnedAspects: ["palette", "shape language"],
      }),
    ).rejects.toThrow(/regeneration allowance is already used/i);
    const restored = coordinator.snapshot(project.state.projectId);
    expect(restored.state.stage).toBe("concept-set-approval");
    expect(restored.state.visualDirectionSet?.revisionId).toBe(
      before.visualDirectionSet?.revisionId,
    );
    expect(restored.state.selectedVisualDirectionRevisionId).toBe(
      before.selectedVisualDirectionRevisionId,
    );
    expect(restored.state.conceptSet?.revisionId).toBe(
      before.conceptSet?.revisionId,
    );
    expect(restored.state.directionApproval).toEqual(before.directionApproval);
    expect(restored.state.focusedDirectionChangeCount).toBe(0);
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
      project = finishInterrogation(coordinator, project);
      project = coordinator.m1.confirmSharedUnderstanding(
        project.state.projectId,
        {
          interrogationRevisionId: project.state.interrogation!.revisionId,
          confirmed: true,
        },
      );
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
      project = coordinator.m1.approveConceptSet(project.state.projectId, {
        decision: "approved",
        targetRevisionId: project.state.conceptSet!.revisionId,
        targetSha256: project.state.conceptSet!.artifact.sha256,
      });
      expect(project.state.status).toBe("complete");
    }
    repository.close();
  });
});
