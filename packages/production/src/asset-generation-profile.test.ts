import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveAssetGenerationProfile } from "./asset-generation-profile.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveAssetGenerationProfile", () => {
  it.each([
    ["meshy", "live"],
    ["tripo", "live"],
    ["meshy", "replay"],
    ["tripo", "replay"],
  ] as const)(
    "%s_%s_does_not_advertise_prompt_change_input",
    (provider, mode) => {
      expect(resolveAssetGenerationProfile(provider, mode).promptInput).toEqual(
        { supported: false },
      );
    },
  );

  it("live_meshy_profile_supports_meshy_6_multiview_but_not_meshy_5", () => {
    vi.stubEnv("FULCRUM_MESHY_MODEL", "meshy-6");
    expect(
      resolveAssetGenerationProfile("meshy", "live").multiviewImageInput
        .supported,
    ).toBe(true);

    vi.stubEnv("FULCRUM_MESHY_MODEL", "meshy-5");
    expect(
      resolveAssetGenerationProfile("meshy", "live").multiviewImageInput
        .supported,
    ).toBe(false);
  });
});
