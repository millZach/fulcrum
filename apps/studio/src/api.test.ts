import { afterEach, describe, expect, it, vi } from "vitest";

import { api, ApiError, fetchArtifactJson, isApiError } from "./api.js";
import {
  answerFrontier,
  approveConceptSet,
  approveGameDesign,
  approveVisualDirection,
  changeDirection,
  approveSoundSet,
  confirmConceptPlan,
  confirmSoundPlan,
  confirmSharedUnderstanding,
  createM2Project,
  createM1Project,
  decideAssetPlan,
  getProject,
  increaseBudget,
  m1Projects,
  m2Projects,
  regenerateConcept,
  regenerateSound,
  replaceDirection,
  reviseGameDesign,
  selectConcept,
} from "./m1-api.js";
import type { ProjectSnapshot } from "@fulcrum/domain";

afterEach(() => vi.unstubAllGlobals());

describe("Studio API client", () => {
  it("loads artifact JSON through the transport module", async () => {
    const artifact = { prompt: "Exact identity-preserving prompt" };
    const fetchMock = vi.fn(async () => Response.json(artifact));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchArtifactJson("/api/artifacts/view-1")).resolves.toEqual(
      artifact,
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/artifacts/view-1");
  });

  it("preserves the artifact request error shown by the strip", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );

    await expect(fetchArtifactJson("/api/artifacts/missing")).rejects.toEqual(
      expect.objectContaining({
        name: "ApiError",
        message: "Artifact request failed with 404.",
        status: 404,
      }),
    );
  });

  it("does not advertise a JSON body for an empty POST", async () => {
    const fetchMock = vi.fn(async (_path: string, options?: RequestInit) => {
      expect(new Headers(options?.headers).has("Content-Type")).toBe(false);
      return Response.json({ status: "ok" });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      api<{ status: string }>("/api/projects/project-1/advance", {
        method: "POST",
      }),
    ).resolves.toEqual({ status: "ok" });
  });

  it("surfaces the server detail and preflight code on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: "Fulcrum could not complete the request.",
            detail:
              "Budget exhausted: ElevenLabs sound generation requires $0.05, but only $0.00 remains.",
            code: "budget-refused",
          },
          { status: 500 },
        ),
      ),
    );

    await expect(
      api("/api/projects/project-1/concept-plan/confirm"),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "ApiError",
        message:
          "Budget exhausted: ElevenLabs sound generation requires $0.05, but only $0.00 remains.",
        status: 500,
        code: "budget-refused",
      }),
    );
    await expect(
      api("/api/projects/project-1/concept-plan/confirm"),
    ).rejects.toSatisfy(
      (error) => isApiError(error) && error instanceof ApiError,
    );
  });

  it("preserves the subscription quota warning code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: "Fulcrum could not complete the request.",
            detail:
              "OpenAI subscription usage is temporarily limited. Wait for its quota or rate limit to reset, then try again.",
            code: "subscription-quota",
          },
          { status: 500 },
        ),
      ),
    );

    await expect(
      api("/api/projects/project-1/interrogation/answers"),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "subscription-quota",
        message: expect.stringMatching(/subscription usage.*limited/i),
      }),
    );
  });
});

describe("M1 API client", () => {
  const snapshot = { state: { projectId: "p1", milestone: "m1" } };

  it("posts create with milestone m1 and typed M1 routes", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, options?: RequestInit) => {
        calls.push({
          path,
          body: options?.body ? JSON.parse(String(options.body)) : undefined,
        });
        return Response.json(snapshot);
      }),
    );

    await createM1Project({
      brief:
        "Create a first-person stealth game in a cramped lunar greenhouse.",
      mode: "replay",
      budgetUsd: 1,
      rightsConfirmed: true,
    });
    await getProject("p1");
    await answerFrontier("p1", {
      interrogationRevisionId: "int-1",
      roundId: "round-1",
      answers: [{ questionId: "q1", value: "A concrete choice." }],
    });
    await confirmSharedUnderstanding("p1", {
      interrogationRevisionId: "int-2",
      confirmed: true,
    });
    await approveGameDesign("p1", {
      targetType: "game-design",
      targetRevisionId: "gds-1",
      targetSha256: "a".repeat(64),
      decision: "approved",
    });
    await reviseGameDesign("p1", {
      gameDesignSpecRevisionId: "gds-1",
      change: "Limit the slice to one greenhouse room.",
    });
    await replaceDirection("p1", {
      directionSetRevisionId: "set-1",
      directionRevisionId: "dir-3",
      notes: "Make it feel like layered theatre flats.",
    });
    await changeDirection("p1", {
      directionSetRevisionId: "set-1",
      directionRevisionId: "dir-1",
      change: "Add restrained electrically charged wind streaks.",
      pinnedAspects: ["palette", "shape language"],
    });
    await approveVisualDirection("p1", {
      targetType: "visual-direction",
      targetRevisionId: "dir-1",
      targetSha256: "b".repeat(64),
      decision: "approved",
    });
    await confirmConceptPlan("p1", {
      conceptPlanRevisionId: "plan-1",
      confirmed: true,
      promptOverrides: [
        {
          slotId: "gameplay-anchor",
          prompt: "TASK-J-API-EDIT pixel-perfect lunar airlock",
        },
      ],
    });
    await regenerateConcept("p1", {
      conceptSetRevisionId: "set-c",
      slotId: "hero",
      notes: "Sharpen the silhouette.",
    });
    await selectConcept("p1", {
      conceptSetRevisionId: "set-c",
      slotId: "hero",
      conceptRevisionId: "concept-2",
    });
    await approveConceptSet("p1", {
      targetType: "concept-set",
      targetRevisionId: "set-c",
      targetSha256: "c".repeat(64),
      decision: "approved",
    });
    await confirmSoundPlan("p1", {
      soundPlanRevisionId: "plan-s",
      confirmed: true,
      promptOverrides: [
        {
          slotId: "core-loop-foley",
          prompt: "TASK-M-API-EDIT lunar airlock hiss",
        },
      ],
    });
    await regenerateSound("p1", {
      soundSetRevisionId: "set-s",
      slotId: "core-loop-foley",
      notes: "Make the hiss shorter.",
    });
    await approveSoundSet("p1", {
      targetType: "sound-set",
      targetRevisionId: "set-s",
      targetSha256: "d".repeat(64),
      decision: "approved",
    });
    await increaseBudget("p1", { budgetUsd: 2 });

    expect(calls).toEqual([
      {
        path: "/api/projects",
        body: expect.objectContaining({
          milestone: "m1",
          mode: "replay",
          rightsConfirmed: true,
        }),
      },
      { path: "/api/projects/p1", body: undefined },
      {
        path: "/api/projects/p1/interrogation/answers",
        body: expect.objectContaining({
          interrogationRevisionId: "int-1",
          roundId: "round-1",
        }),
      },
      {
        path: "/api/projects/p1/interrogation/confirm",
        body: { interrogationRevisionId: "int-2", confirmed: true },
      },
      {
        path: "/api/projects/p1/approvals/game-design",
        body: expect.objectContaining({
          targetType: "game-design",
          decision: "approved",
        }),
      },
      {
        path: "/api/projects/p1/game-design/revise",
        body: expect.objectContaining({
          gameDesignSpecRevisionId: "gds-1",
        }),
      },
      {
        path: "/api/projects/p1/directions/dir-3/replace",
        body: {
          directionSetRevisionId: "set-1",
          notes: "Make it feel like layered theatre flats.",
        },
      },
      {
        path: "/api/projects/p1/directions/dir-1/change",
        body: expect.objectContaining({
          change: "Add restrained electrically charged wind streaks.",
          pinnedAspects: ["palette", "shape language"],
        }),
      },
      {
        path: "/api/projects/p1/approvals/visual-direction",
        body: expect.objectContaining({ targetType: "visual-direction" }),
      },
      {
        path: "/api/projects/p1/concept-plan/confirm",
        body: {
          conceptPlanRevisionId: "plan-1",
          confirmed: true,
          promptOverrides: [
            {
              slotId: "gameplay-anchor",
              prompt: "TASK-J-API-EDIT pixel-perfect lunar airlock",
            },
          ],
        },
      },
      {
        path: "/api/projects/p1/concepts/hero/regenerate",
        body: {
          conceptSetRevisionId: "set-c",
          notes: "Sharpen the silhouette.",
        },
      },
      {
        path: "/api/projects/p1/concepts/hero/select",
        body: {
          conceptSetRevisionId: "set-c",
          conceptRevisionId: "concept-2",
        },
      },
      {
        path: "/api/projects/p1/approvals/concept-set",
        body: expect.objectContaining({ targetType: "concept-set" }),
      },
      {
        path: "/api/projects/p1/sound-plan/confirm",
        body: {
          soundPlanRevisionId: "plan-s",
          confirmed: true,
          promptOverrides: [
            {
              slotId: "core-loop-foley",
              prompt: "TASK-M-API-EDIT lunar airlock hiss",
            },
          ],
        },
      },
      {
        path: "/api/projects/p1/sounds/core-loop-foley/regenerate",
        body: {
          soundSetRevisionId: "set-s",
          notes: "Make the hiss shorter.",
        },
      },
      {
        path: "/api/projects/p1/approvals/sound-set",
        body: expect.objectContaining({ targetType: "sound-set" }),
      },
      {
        path: "/api/projects/p1/budget",
        body: { budgetUsd: 2 },
      },
    ]);
  });

  it("omits empty regenerate notes and keeps M0 projects out of the M1 list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_path: string, options?: RequestInit) => {
        expect(JSON.parse(String(options?.body))).toEqual({
          conceptSetRevisionId: "set-c",
        });
        return Response.json(snapshot);
      }),
    );
    await regenerateConcept("p1", {
      conceptSetRevisionId: "set-c",
      slotId: "hero",
    });
    expect(
      m1Projects([
        { state: { milestone: "m0" } } as ProjectSnapshot,
        { state: { milestone: "m1" } } as ProjectSnapshot,
      ]),
    ).toHaveLength(1);
  });
});

describe("M2 API client", () => {
  it("creates, filters, and posts exact asset-plan decisions", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, options?: RequestInit) => {
        calls.push({
          path,
          body: options?.body ? JSON.parse(String(options.body)) : undefined,
        });
        return Response.json({ state: { projectId: "p2", milestone: "m2" } });
      }),
    );

    await createM2Project({
      milestone: "m1",
      brief:
        "Create a first-person stealth game in a cramped lunar greenhouse.",
      mode: "replay",
      budgetUsd: 1,
      rightsConfirmed: true,
    });
    await decideAssetPlan("p2", {
      targetType: "asset-plan",
      targetRevisionId: "asset-plan-r1",
      targetSha256: "e".repeat(64),
      decision: "approved",
    });
    await decideAssetPlan("p2", {
      targetType: "asset-plan",
      targetRevisionId: "asset-plan-r2",
      targetSha256: "f".repeat(64),
      decision: "changes-requested",
      notes: "Split the greenhouse wall kit by material family.",
    });

    expect(calls).toEqual([
      {
        path: "/api/projects",
        body: expect.objectContaining({ milestone: "m2", mode: "replay" }),
      },
      {
        path: "/api/projects/p2/approvals/asset-plan",
        body: {
          targetType: "asset-plan",
          targetRevisionId: "asset-plan-r1",
          targetSha256: "e".repeat(64),
          decision: "approved",
        },
      },
      {
        path: "/api/projects/p2/approvals/asset-plan",
        body: {
          targetType: "asset-plan",
          targetRevisionId: "asset-plan-r2",
          targetSha256: "f".repeat(64),
          decision: "changes-requested",
          notes: "Split the greenhouse wall kit by material family.",
        },
      },
    ]);
  });

  it("keeps M1 and M2 project lists separate", () => {
    const projects = [
      { state: { milestone: "m1", projectId: "p1" } },
      { state: { milestone: "m2", projectId: "p2" } },
      { state: { milestone: "m0", projectId: "p0" } },
    ] as ProjectSnapshot[];

    expect(m1Projects(projects).map(({ state }) => state.projectId)).toEqual([
      "p1",
    ]);
    expect(m2Projects(projects).map(({ state }) => state.projectId)).toEqual([
      "p2",
    ]);
  });
});
