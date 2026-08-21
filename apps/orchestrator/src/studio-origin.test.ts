import { describe, expect, it } from "vitest";

import { isTrustedStudioOrigin, STUDIO_ORIGINS } from "./studio-origin.js";

describe("studio origin allowlist", () => {
  it("accepts the studio origins and a missing Origin header", () => {
    expect([...STUDIO_ORIGINS]).toEqual([
      "http://localhost:4311",
      "http://127.0.0.1:4311",
      "http://forge.tail5728ca.ts.net:4311",
    ]);
    for (const origin of STUDIO_ORIGINS)
      expect(isTrustedStudioOrigin(origin)).toBe(true);
    expect(isTrustedStudioOrigin(undefined)).toBe(true);
    expect(isTrustedStudioOrigin("")).toBe(true);
  });

  it("rejects untrusted, opaque, and multi-value Origin headers", () => {
    expect(isTrustedStudioOrigin("https://evil.example")).toBe(false);
    expect(isTrustedStudioOrigin("http://localhost:4310")).toBe(false);
    expect(isTrustedStudioOrigin("https://localhost:4311")).toBe(false);
    expect(isTrustedStudioOrigin("null")).toBe(false);
    expect(isTrustedStudioOrigin(["http://localhost:4311"])).toBe(false);
  });
});
