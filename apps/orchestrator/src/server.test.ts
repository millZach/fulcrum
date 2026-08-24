import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ProjectRepository } from "@fulcrum/project";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectCoordinator } from "./project-coordinator.js";
import { createFulcrumServer } from "./server.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const fixture = async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fulcrum-server-"));
  roots.push(root);
  const repository = new ProjectRepository(root);
  const create = vi.fn(async (input) => ({ input }));
  const approveConceptSet = vi.fn(async (_projectId, input) => ({ input }));
  const decideAssetPlan = vi.fn(async (_projectId, input) => ({ input }));
  const approveDirection = vi.fn(async (_projectId, input) => ({ input }));
  const coordinator = {
    create,
    approveConceptSet,
    decideAssetPlan,
    approveDirection,
    configuration: vi.fn(() => ({})),
    list: vi.fn(() => []),
  } as unknown as ProjectCoordinator;
  const app = await createFulcrumServer({
    repository,
    coordinator,
    logger: false,
  });
  return {
    ...app,
    create,
    approveConceptSet,
    decideAssetPlan,
    approveDirection,
  };
};

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

  it("concept_and_asset_plan_approvals_use_project_routing", async () => {
    const { server, repository, approveConceptSet, decideAssetPlan } =
      await fixture();
    const concept = await server.inject({
      method: "POST",
      url: "/api/projects/project-1/approvals/concept-set",
      payload: { decision: "approved" },
    });
    const plan = await server.inject({
      method: "POST",
      url: "/api/projects/project-1/approvals/asset-plan",
      payload: { decision: "approved" },
    });

    expect(concept.statusCode).toBe(200);
    expect(plan.statusCode).toBe(200);
    expect(approveConceptSet).toHaveBeenCalledWith("project-1", {
      decision: "approved",
    });
    expect(decideAssetPlan).toHaveBeenCalledWith("project-1", {
      decision: "approved",
    });
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
