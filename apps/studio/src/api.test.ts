import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "./api.js";

afterEach(() => vi.unstubAllGlobals());

describe("Studio API client", () => {
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
});
