import { describe, expect, it } from "vitest";

import { mascotFrameSeconds } from "./MascotStage.js";

describe("mascotFrameSeconds", () => {
  it("uses the render clock's full wall-time delta after throttling", () => {
    expect(mascotFrameSeconds(0.016)).toBe(0.016);
    expect(mascotFrameSeconds(12.5)).toBe(12.5);
  });

  it("does not run animation time backward", () => {
    expect(mascotFrameSeconds(-1)).toBe(0);
  });
});
