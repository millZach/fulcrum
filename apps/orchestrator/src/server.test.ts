import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ProjectRepository } from "@fulcrum/project";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectCoordinator } from "./project-coordinator.js";
import { createFulcrumServer } from "./server.js";

const roots: string[] = [];

type ServerOptions = NonNullable<Parameters<typeof createFulcrumServer>[0]>;
type PrototypeImagegenOptions = NonNullable<ServerOptions["prototypeImagegen"]>;
type PrototypeImageRunner = NonNullable<PrototypeImagegenOptions["runImage"]>;

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const fixture = async (
  prototypeImagegen: Omit<PrototypeImagegenOptions, "imageRoot"> = {},
) => {
  const root = mkdtempSync(path.join(tmpdir(), "fulcrum-server-"));
  roots.push(root);
  const imageRoot = path.join(root, "prototype-images");
  const repository = new ProjectRepository(root);
  const create = vi.fn(async (input) => ({ input }));
  const approveConceptSet = vi.fn(async (_projectId, input) => ({ input }));
  const approveDirection = vi.fn(async (_projectId, input) => ({ input }));
  const reopenApprovalReview = vi.fn((_projectId, input) => ({ input }));
  const continueIntoM2 = vi.fn((_projectId, input) => ({ input }));
  const suggestGameNames = vi.fn(async (_projectId, input) => ({ input }));
  const storeAttachment = vi.fn(async (_projectId, input) => ({ input }));
  const commitGameName = vi.fn(async (_projectId, input) => ({ input }));
  const coordinator = {
    create,
    approveConceptSet,
    approveDirection,
    reopenApprovalReview,
    creative: {
      continueIntoM2,
      suggestGameNames,
      commitGameName,
      storeAttachment,
    },
    configuration: vi.fn(() => ({})),
    list: vi.fn(() => []),
  } as unknown as ProjectCoordinator;
  const app = await createFulcrumServer({
    repository,
    coordinator,
    logger: false,
    prototypeImagegen: { imageRoot, ...prototypeImagegen },
  });
  return {
    ...app,
    imageRoot,
    create,
    approveConceptSet,
    approveDirection,
    reopenApprovalReview,
    continueIntoM2,
    suggestGameNames,
    commitGameName,
    storeAttachment,
  };
};

const validGeneratePayload = {
  prompt: "Create a weathered brass signal relay.",
  viewLabel: "Back",
  viewInstruction: "Render a straight-on orthographic back view.",
  assetName: "Signal relay",
};

describe("prototype ImageGen generation", () => {
  it("rejects invalid generate input with a 400", async () => {
    const { server, repository } = await fixture();
    const response = await server.inject({
      method: "POST",
      url: "/api/prototype/imagegen/generate",
      headers: { origin: "http://localhost:4311" },
      payload: { ...validGeneratePayload, prompt: "" },
    });

    expect(response.statusCode).toBe(400);
    await server.close();
    repository.close();
  });

  it("rejects an untrusted Origin before generation", async () => {
    const runImage = vi.fn<PrototypeImageRunner>();
    const { server, repository } = await fixture({ runImage });
    const response = await server.inject({
      method: "POST",
      url: "/api/prototype/imagegen/generate",
      headers: { origin: "https://evil.example" },
      payload: validGeneratePayload,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: "This request is not from a trusted studio origin.",
      detail: "This request is not from a trusted studio origin.",
    });
    expect(runImage).not.toHaveBeenCalled();
    await server.close();
    repository.close();
  });

  it("generates a new view without a reference image", async () => {
    const runImage = vi.fn<PrototypeImageRunner>(async () => ({
      bytes: Buffer.from("new generated view"),
      model: "gpt-image-test",
      costUsd: 0,
    }));
    const { server, repository } = await fixture({
      inspectProviders: () => [
        {
          provider: "openai",
          access: "subscription",
          ready: true,
          installed: true,
          authenticated: true,
          capabilities: { imageGeneration: true },
          detail: "Subscription ImageGen is ready",
        },
      ],
      runImage,
    });
    const response = await server.inject({
      method: "POST",
      url: "/api/prototype/imagegen/generate",
      headers: { origin: "http://localhost:4311" },
      payload: {
        ...validGeneratePayload,
        viewInstruction: "x".repeat(1_200),
      },
    });

    expect(response.statusCode).toBe(200);
    const runnerInput = runImage.mock.calls[0]![0];
    expect(runnerInput.referenceImages).toEqual([]);
    expect(runnerInput.prompt).toContain("x".repeat(1_200));
    expect(runnerInput.prompt).not.toContain("Input images:");
    await server.close();
    repository.close();
  });

  it("generates a derived view through the subscription runner and stores it", async () => {
    const generatedBytes = Buffer.from("generated prototype image");
    const referenceBytes = Buffer.from("canonical reference image");
    const runImage = vi.fn<PrototypeImageRunner>(async () => ({
      bytes: generatedBytes,
      model: "gpt-image-test",
      costUsd: 0,
    }));
    const { server, repository, imageRoot } = await fixture({
      inspectProviders: () => [
        {
          provider: "openai",
          access: "subscription",
          ready: true,
          installed: true,
          authenticated: true,
          capabilities: { imageGeneration: true },
          detail: "Subscription ImageGen is ready",
        },
      ],
      runImage,
    });
    const response = await server.inject({
      method: "POST",
      url: "/api/prototype/imagegen/generate",
      headers: { origin: "https://forge.tail5728ca.ts.net:8444" },
      payload: {
        ...validGeneratePayload,
        referenceImageDataUrl: `data:image/webp;base64,${referenceBytes.toString("base64")}`,
      },
    });

    const sha256 = createHash("sha256").update(generatedBytes).digest("hex");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({
        imageUrl: `/api/prototype/imagegen/images/${sha256}.png`,
        sha256,
        model: "gpt-image-test",
        costUsd: 0,
      }),
    );
    const runnerInput = runImage.mock.calls[0]![0];
    expect(runnerInput.prompt).toContain("Use case: production-reference-view");
    expect(runnerInput.prompt).toContain(
      "Required view: Back. Render a straight-on orthographic back view.",
    );
    expect(runnerInput.prompt).toContain(
      "Image 1 is the canonical reference of the same subject",
    );
    expect(runnerInput.referenceImages).toEqual([
      { bytes: referenceBytes, mediaType: "image/webp" },
    ]);
    expect(readFileSync(path.join(imageRoot, `${sha256}.png`))).toEqual(
      generatedBytes,
    );
    await server.close();
    repository.close();
  });
});

describe("prototype ImageGen storage", () => {
  it("rejects an untrusted Origin", async () => {
    const { server, repository } = await fixture();
    const response = await server.inject({
      method: "POST",
      url: "/api/prototype/imagegen/store",
      headers: { origin: "https://evil.example" },
      payload: {
        imageDataUrl: `data:image/png;base64,${Buffer.from("image").toString("base64")}`,
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: "This request is not from a trusted studio origin.",
      detail: "This request is not from a trusted studio origin.",
    });
    await server.close();
    repository.close();
  });

  it("rejects invalid image data", async () => {
    const { server, repository } = await fixture();
    const response = await server.inject({
      method: "POST",
      url: "/api/prototype/imagegen/store",
      headers: { origin: "http://localhost:4311" },
      payload: { imageDataUrl: "not-an-image" },
    });

    expect(response.statusCode).toBe(400);
    await server.close();
    repository.close();
  });

  it("stores client-sliced bytes and serves them from the image route", async () => {
    const imageBytes = Buffer.from("client-sliced png quadrant");
    const sha256 = createHash("sha256").update(imageBytes).digest("hex");
    const { server, repository, imageRoot } = await fixture();
    const storeResponse = await server.inject({
      method: "POST",
      url: "/api/prototype/imagegen/store",
      headers: { origin: "http://127.0.0.1:4311" },
      payload: {
        imageDataUrl: `data:image/png;base64,${imageBytes.toString("base64")}`,
      },
    });

    expect(storeResponse.statusCode).toBe(200);
    expect(storeResponse.json()).toEqual({
      imageUrl: `/api/prototype/imagegen/images/${sha256}.png`,
      sha256,
    });
    expect(readFileSync(path.join(imageRoot, `${sha256}.png`))).toEqual(
      imageBytes,
    );

    const imageResponse = await server.inject({
      method: "GET",
      url: `/api/prototype/imagegen/images/${sha256}.png`,
    });
    expect(imageResponse.statusCode).toBe(200);
    expect(imageResponse.headers["content-type"]).toBe("image/png");
    expect(imageResponse.rawPayload).toEqual(imageBytes);
    await server.close();
    repository.close();
  });

  it("rejects decoded image data larger than 8 MB", async () => {
    const oversizedImage = Buffer.alloc(8 * 1024 * 1024 + 1);
    const { server, repository } = await fixture();
    const response = await server.inject({
      method: "POST",
      url: "/api/prototype/imagegen/store",
      headers: { origin: "http://localhost:4311" },
      payload: {
        imageDataUrl: `data:image/png;base64,${oversizedImage.toString("base64")}`,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "The stored image must be 8 MB or smaller.",
      detail: "The stored image must be 8 MB or smaller.",
    });
    await server.close();
    repository.close();
  });
});

describe("project HTTP routing", () => {
  it("post_projects_accepts_milestone_m2", async () => {
    const { server, repository, create } = await fixture();
    const response = await server.inject({
      method: "POST",
      url: "/api/projects",
      payload: { milestone: "m2", brief: "fixture" },
    });

    expect(response.statusCode).toBe(200);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ milestone: "m2" }),
    );
    await server.close();
    repository.close();
  });

  it("concept approvals use project routing", async () => {
    const { server, repository, approveConceptSet } = await fixture();
    const concept = await server.inject({
      method: "POST",
      url: "/api/projects/project-1/approvals/concept-set",
      payload: { decision: "approved" },
    });
    expect(concept.statusCode).toBe(200);
    expect(approveConceptSet).toHaveBeenCalledWith("project-1", {
      decision: "approved",
    });
    await server.close();
    repository.close();
  });

  it("has no asset-plan approval route", async () => {
    const { server, repository } = await fixture();
    const response = await server.inject({
      method: "POST",
      url: "/api/projects/project-1/approvals/asset-plan",
      payload: { decision: "approved" },
    });

    expect(response.statusCode).toBe(404);
    await server.close();
    repository.close();
  });

  it("reopen_route_returns_a_rejected_gate_to_review", async () => {
    const { server, repository, reopenApprovalReview } = await fixture();
    const response = await server.inject({
      method: "POST",
      url: "/api/projects/project-1/approvals/concept-set/reopen",
    });

    expect(response.statusCode).toBe(200);
    expect(reopenApprovalReview).toHaveBeenCalledWith("project-1", {
      gate: "concept-set",
    });
    await server.close();
    repository.close();
  });

  it("game_name_routes_forward_the_steer_and_the_choice", async () => {
    const { server, repository, suggestGameNames, commitGameName } =
      await fixture();
    const steered = await server.inject({
      method: "POST",
      url: "/api/projects/project-1/game-name/suggest",
      payload: {
        gameNameCandidatesRevisionId: "names-1",
        feedback: "Shorter, and darker.",
      },
    });
    const committed = await server.inject({
      method: "POST",
      url: "/api/projects/project-1/game-name/commit",
      payload: { gameNameCandidatesRevisionId: "names-2", name: "Saltglass" },
    });

    expect(steered.statusCode).toBe(200);
    expect(committed.statusCode).toBe(200);
    expect(suggestGameNames).toHaveBeenCalledWith("project-1", {
      gameNameCandidatesRevisionId: "names-1",
      feedback: "Shorter, and darker.",
    });
    expect(commitGameName).toHaveBeenCalledWith("project-1", {
      gameNameCandidatesRevisionId: "names-2",
      name: "Saltglass",
    });
    await server.close();
    repository.close();
  });

  it("continue_route_seeds_an_m2_world_from_an_m1_world", async () => {
    const { server, repository, continueIntoM2 } = await fixture();
    const withCap = await server.inject({
      method: "POST",
      url: "/api/projects/project-1/continue/m2",
      payload: { meshyCreditBudget: 300 },
    });
    const bare = await server.inject({
      method: "POST",
      url: "/api/projects/project-1/continue/m2",
    });

    expect(withCap.statusCode).toBe(200);
    expect(bare.statusCode).toBe(200);
    expect(continueIntoM2).toHaveBeenNthCalledWith(1, "project-1", {
      meshyCreditBudget: 300,
    });
    expect(continueIntoM2).toHaveBeenNthCalledWith(2, "project-1", {});
    await server.close();
    repository.close();
  });

  it("m0_and_m1_routes_keep_their_existing_behavior", async () => {
    const { server, repository, approveDirection } = await fixture();
    const response = await server.inject({
      method: "POST",
      url: "/api/projects/project-1/approvals/visual-direction",
      payload: { decision: "approved" },
    });

    expect(response.statusCode).toBe(200);
    expect(approveDirection).toHaveBeenCalledWith("project-1", {
      decision: "approved",
    });
    await server.close();
    repository.close();
  });
});

describe("pasted image attachment upload", () => {
  const dataUrl = `data:image/png;base64,${Buffer.from("png").toString("base64")}`;

  it("rejects an untrusted Origin", async () => {
    const { server, repository, storeAttachment } = await fixture();
    const response = await server.inject({
      method: "POST",
      url: "/api/projects/project-1/attachments",
      headers: { origin: "https://evil.example" },
      payload: { dataUrl },
    });

    expect(response.statusCode).toBe(403);
    expect(storeAttachment).not.toHaveBeenCalled();
    await server.close();
    repository.close();
  });

  it("hands the data URL to the creative coordinator", async () => {
    const { server, repository, storeAttachment } = await fixture();
    const response = await server.inject({
      method: "POST",
      url: "/api/projects/project-1/attachments",
      headers: { origin: "http://localhost:4311" },
      payload: { dataUrl },
    });

    expect(response.statusCode).toBe(200);
    expect(storeAttachment).toHaveBeenCalledWith("project-1", { dataUrl });
    await server.close();
    repository.close();
  });
});
