import { describe, expect, it } from "vitest";

import { workflowErrorMessage } from "./workflow-error.js";

describe("workflowErrorMessage", () => {
  it("keeps useful failure details without allowing unbounded object output", () => {
    expect(workflowErrorMessage("plain failure")).toBe("plain failure");
    expect(workflowErrorMessage(new Error("error failure"))).toBe(
      "error failure",
    );
    expect(
      workflowErrorMessage({ error: new Error("nested error failure") }),
    ).toBe("nested error failure");
    expect(workflowErrorMessage({ code: "schema-rejected" })).toBe(
      '{"code":"schema-rejected"}',
    );
    expect(workflowErrorMessage({ details: "x".repeat(3_000) })).toHaveLength(
      2_000,
    );
  });
});
