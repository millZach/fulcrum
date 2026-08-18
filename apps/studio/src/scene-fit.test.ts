import { describe, expect, it } from "vitest";

import {
  fitAssetToGround,
  M0_RELIQUARY_TARGET_EXTENT_METERS,
} from "./scene-fit.js";

describe("fitAssetToGround", () => {
  it("centers, grounds, and normalizes provider output to the authored size", () => {
    const fit = fitAssetToGround({
      min: [-0.95, -0.45, -0.7],
      max: [0.95, 0.44, 1.2],
    });

    expect(fit.scale).toBeCloseTo(M0_RELIQUARY_TARGET_EXTENT_METERS / 1.9);
    expect(fit.position[0]).toBeCloseTo(0);
    expect(fit.position[1]).toBeCloseTo(0.45 * fit.scale);
    expect(fit.position[2]).toBeCloseTo(-0.25 * fit.scale);
  });

  it("falls back safely when bounds cannot be normalized", () => {
    expect(fitAssetToGround({ min: [0, 0, 0], max: [0, 0, 0] })).toEqual({
      position: [0, 0, 0],
      scale: 1,
    });
  });
});
