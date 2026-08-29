import type { AssetProvider, ProviderMode } from "@fulcrum/domain";
import type { ProjectRepository } from "@fulcrum/project";

import type {
  AssetGenerationAdapter,
  MultiviewImageInputCapability,
} from "./asset-generation.js";
import {
  FULCRUM_MESHY_MODEL,
  MeshyAssetAdapter,
  meshyMultiviewCapability,
} from "./meshy-adapter.js";
import { createReplayAssetAdapter } from "./replay-asset-adapter.js";
import {
  TripoAssetAdapter,
  tripoMultiviewCapability,
} from "./tripo-adapter.js";

const REPLAY_MODEL_PROFILES = {
  meshy: FULCRUM_MESHY_MODEL,
  tripo: "v2.5-20250123",
} as const satisfies Record<AssetProvider, string>;

export type AssetGenerationProfile = {
  modelVersion: string;
  multiviewImageInput: MultiviewImageInputCapability;
  promptInput: { supported: boolean };
};

export const resolveAssetGenerationProfile = (
  provider: AssetProvider,
  mode: ProviderMode,
): AssetGenerationProfile => {
  const modelVersion =
    mode === "replay"
      ? REPLAY_MODEL_PROFILES[provider]
      : provider === "meshy"
        ? (process.env.FULCRUM_MESHY_MODEL ?? FULCRUM_MESHY_MODEL)
        : (process.env.FULCRUM_TRIPO_MODEL_VERSION ?? "unconfigured");
  return {
    modelVersion,
    promptInput: { supported: false },
    multiviewImageInput:
      provider === "meshy"
        ? meshyMultiviewCapability(modelVersion)
        : tripoMultiviewCapability(modelVersion),
  };
};

export const createAssetGenerationAdapter = (
  repository: ProjectRepository,
  provider: AssetProvider,
  mode: ProviderMode,
): AssetGenerationAdapter => {
  const profile = resolveAssetGenerationProfile(provider, mode);
  const providerAdapter =
    provider === "meshy"
      ? new MeshyAssetAdapter(repository, profile.modelVersion)
      : new TripoAssetAdapter(repository, profile.modelVersion);
  return mode === "replay"
    ? createReplayAssetAdapter(providerAdapter)
    : providerAdapter;
};
