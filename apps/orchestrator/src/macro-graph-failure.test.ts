import { describe, expect, it } from "vitest";

import { failureFromUnknown } from "./macro-graph.js";

describe("failureFromUnknown", () => {
  it("invalid_marker_kind_falls_back_to_workflow_run_failed", () => {
    const markedFailure =
      "Mastra step failed: FULCRUM_WORKFLOW_FAILURE:" +
      JSON.stringify({
        code: "provider-failed",
        message: "The provider rejected the request.",
        kind: "made-up-failure-kind",
        evidenceRevisionIds: [],
      });

    expect(failureFromUnknown(markedFailure)).toEqual({
      code: "workflow-run-failed",
      message: markedFailure,
      kind: "terminal",
      evidenceRevisionIds: [],
    });
  });
});
