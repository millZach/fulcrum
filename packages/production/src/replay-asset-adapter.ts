import { createHash } from "node:crypto";

import {
  type AdapterJobRef,
  type AssetGenerationAdapter,
  type AssetGenerationJob,
  type ExternalJobState,
  type MultiviewImageInputCapability,
} from "./asset-generation.js";
import { createReplayReliquary } from "./replay-reliquary.js";

class ReplayAssetAdapter implements AssetGenerationAdapter {
  readonly id = "fulcrum-replay" as const;
  readonly multiviewImageInput: MultiviewImageInputCapability;
  private readonly jobs = new Map<
    string,
    Promise<{ bytes: Uint8Array; rearDefined: boolean }>
  >();

  constructor(private readonly liveAdapter: AssetGenerationAdapter) {
    this.multiviewImageInput = liveAdapter.multiviewImageInput;
  }

  requestFingerprint(job: AssetGenerationJob): string {
    return this.liveAdapter.requestFingerprint(job);
  }

  async submit(
    job: AssetGenerationJob,
    idempotencyKey: string,
  ): Promise<AdapterJobRef> {
    const rearDefined =
      job.imageInput.kind === "multiview" && job.regeneration !== undefined;
    const taskId = `replay-${createHash("sha256")
      .update(idempotencyKey)
      .digest("hex")
      .slice(0, 16)}-${rearDefined ? "rear" : "baseline"}`;
    this.jobs.set(
      taskId,
      createReplayReliquary(rearDefined ? "rear-defined" : "baseline").then(
        (bytes) => ({ bytes, rearDefined }),
      ),
    );
    return {
      taskId,
      jobKind:
        job.imageInput.kind === "multiview" ? "multi-image" : "single-image",
      stage: job.stage ?? "complete",
    };
  }

  async inspect(job: AdapterJobRef): Promise<ExternalJobState> {
    const generated = await (this.jobs.get(job.taskId) ??
      createReplayReliquary(
        job.taskId.endsWith("-rear") ? "rear-defined" : "baseline",
      ).then((bytes) => ({
        bytes,
        rearDefined: job.taskId.endsWith("-rear"),
      })));
    return {
      status: "ready",
      asset: {
        bytes: generated.bytes,
        provider: "fulcrum-replay",
        model: generated.rearDefined
          ? "parametric-reliquary-rear-defined-v2"
          : "parametric-reliquary-v1",
        externalJobId: job.taskId,
        costUsd: 0,
        generationClaims: { textured: false, textureChannels: [] },
      },
    };
  }
}

export const createReplayAssetAdapter = (
  liveAdapter: AssetGenerationAdapter,
): AssetGenerationAdapter => new ReplayAssetAdapter(liveAdapter);
