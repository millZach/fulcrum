import { describe, expect, it } from "vitest";

import { resolveStudioRoute } from "./studio-route.js";

describe("studio routing", () => {
  it.each([
    ["bare root", "", "m1"],
    ["explicit M0", "?studio=m0", "m0"],
    [
      "M1 project deep link",
      "?studio=m1&project=0e291ab1-88da-4be1-9ada-745599f7d18d",
      "m1",
    ],
  ] as const)("routes %s", (_label, search, expected) => {
    expect(resolveStudioRoute(search)).toBe(expected);
  });
});
