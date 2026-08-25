import { describe, expect, it } from "vitest";

import { resolveAssetGenerationProfile } from "./asset-generation-profile.js";

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
});
