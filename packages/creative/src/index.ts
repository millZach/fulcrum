import { createHash, randomUUID } from "node:crypto";

import {
  ConceptDocumentSchema,
  CreativeOutputSchema,
  type ConceptDocument,
  type CreativeOutput,
  type ExecutionProvider,
  type ImageProvider,
  type ProductionOutcome,
  type ProviderMode,
  type RevisionRef,
  type VisualBible,
} from "@fulcrum/domain";
import {
  ModelExecution,
  runCodexSubscriptionImage,
  type SubscriptionImageRunner,
} from "@fulcrum/execution";
import { ProjectRepository } from "@fulcrum/project";
import OpenAI from "openai";
import sharp from "sharp";

const replayCreativeOutput: CreativeOutput = CreativeOutputSchema.parse({
  gameDesign: {
    title: "The Last Reliquary",
    genre: "Third-person fantasy extraction arena",
    camera:
      "Elevated three-quarter chase camera with a readable combat horizon",
    coreFantasy:
      "Break into a forbidden arena, wake an ancient vault, and escape with its power.",
    coreLoop: [
      "Enter the arena and read its risk routes",
      "Fight or evade guardians while charging the reliquary",
      "Claim the awakened core",
      "Reach an extraction gate before the arena seals",
    ],
    playerVerbs: ["move", "dodge", "strike", "channel", "loot", "extract"],
    objective: "Awaken the central reliquary and extract its crystal core.",
    sessionMinutes: 12,
    gameplayConstraints: [
      "The reliquary must remain identifiable from the arena perimeter",
      "Traversal silhouettes must stay clear during combat",
      "A complete run must fit inside fifteen minutes",
    ],
    assumptions: [
      "One playable character is sufficient for M0",
      "The M0 slice proves production flow, not a complete combat system",
    ],
  },
  visualBible: {
    title: "Waking Stone",
    overallStyle:
      "Painterly, hand-sculpted fantasy with bold masses and restrained surface noise",
    shapeLanguage:
      "Squat stacked stone volumes cut by thin, deliberate bronze arcs and one sharp crystal",
    architecture:
      "Monolithic arena ruins arranged in broad concentric terraces",
    heroProp:
      "A waist-high ancient reliquary with a protected cyan crystal heart",
    materials: [
      "charcoal basalt",
      "aged bronze",
      "luminous cyan crystal",
      "desaturated moss",
    ],
    palette: [
      { name: "Night basalt", hex: "#171A21", role: "primary mass" },
      { name: "Ash stone", hex: "#4B5260", role: "edge planes" },
      { name: "Old bronze", hex: "#9A7145", role: "structural accent" },
      { name: "Core cyan", hex: "#5DE4E7", role: "focal emission" },
      { name: "Fog blue", hex: "#253646", role: "atmosphere" },
    ],
    lighting:
      "Cool moonlit ambience with a warm grazing key and cyan light from the core",
    atmosphere:
      "Thin blue ground fog with quiet drifting motes around the awakened object",
    cameraLanguage:
      "Low three-quarter hero views with generous negative space and a stable horizon",
    textureLanguage:
      "Broad chipped planes, hand-painted value grouping, sparse high-frequency detail",
    readabilityRules: [
      "The cyan core is the brightest element",
      "Bronze bands never occupy more visual area than the stone body",
      "The silhouette reads as a protected vessel rather than a weapon or doorway",
    ],
    prohibitedStyles: [
      "photorealism",
      "high-gloss sci-fi",
      "ornamental filigree",
      "visual noise",
    ],
  },
});

export type CreativeContext = {
  projectId: string;
  runId: string;
  brief: string;
  mode: ProviderMode;
  orchestratorProvider: ExecutionProvider;
};

export class CreativeDevelopment {
  constructor(
    private readonly repository: ProjectRepository,
    private readonly execution = new ModelExecution(),
  ) {}

  async develop(context: CreativeContext): Promise<{
    gameDesign: RevisionRef;
    visualBible: RevisionRef;
  }> {
    const briefHash = createHash("sha256").update(context.brief).digest("hex");
    const idempotencyKey = `creative:${context.projectId}:${briefHash}:${context.mode}:${context.orchestratorProvider}`;
    const prior = this.repository.getSubmissionByKey(idempotencyKey);
    if (prior?.status === "ready" && prior.resultRevisionId) {
      const gameDesignRevisionId = prior.payload.gameDesignRevisionId;
      if (typeof gameDesignRevisionId !== "string") {
        throw new Error(
          "Creative submission is ready but its game-design lineage is incomplete.",
        );
      }
      return {
        gameDesign: this.repository.getRevision(gameDesignRevisionId),
        visualBible: this.repository.getRevision(prior.resultRevisionId),
      };
    }
    if (prior && context.mode === "live") {
      if (prior.status !== "failed" && prior.status !== "submission-unknown") {
        this.repository.updateSubmission(prior.requestId, {
          status: "submission-unknown",
        });
      }
      throw new Error(
        prior.status === "failed"
          ? "The live creative request previously failed and requires user-directed retry."
          : "The live creative request may have been submitted before interruption; Fulcrum will not spend again automatically.",
      );
    }
    const submission =
      prior ??
      this.repository.recordSubmissionIntent({
        projectId: context.projectId,
        operation: "structured-creative-development",
        provider:
          context.mode === "replay"
            ? "fulcrum-replay"
            : context.orchestratorProvider,
        idempotencyKey,
        payload: {
          briefHash,
          role: "orchestrator",
          executionProvider: context.orchestratorProvider,
        },
      });
    try {
      if (context.mode === "live") {
        this.repository.updateSubmission(submission.requestId, {
          status: "pending",
        });
        if (context.orchestratorProvider === "openai-api") {
          this.repository.reserveBudget(
            context.projectId,
            Number(process.env.FULCRUM_OPENAI_TEXT_RESERVE_USD ?? "0.25"),
            "OpenAI API orchestration",
          );
        }
      }
      const generated =
        context.mode === "replay"
          ? {
              value: replayCreativeOutput,
              model: "replay-creative-v1",
            }
          : await this.developWithExecutionProvider(
              context.brief,
              context.orchestratorProvider,
            );
      const output = generated.value;
      const gameDesign = this.repository.writeRevision({
        projectId: context.projectId,
        entityId: `${context.projectId}:game-design`,
        kind: "game-design-digest",
        value: output.gameDesign,
        runId: context.runId,
      });
      const visualBible = this.repository.writeRevision({
        projectId: context.projectId,
        entityId: `${context.projectId}:visual-bible`,
        kind: "visual-bible",
        value: output.visualBible,
        runId: context.runId,
      });
      this.repository.updateSubmission(submission.requestId, {
        status: "ready",
        resultRevisionId: visualBible.revisionId,
        payload: {
          ...submission.payload,
          gameDesignRevisionId: gameDesign.revisionId,
          model: generated.model,
        },
      });
      this.repository.appendEvent({
        projectId: context.projectId,
        runId: context.runId,
        type: "creative.completed",
        payload: {
          gameDesignRevisionId: gameDesign.revisionId,
          visualBibleRevisionId: visualBible.revisionId,
        },
      });
      return { gameDesign, visualBible };
    } catch (error) {
      this.repository.updateSubmission(submission.requestId, {
        status: context.mode === "live" ? "submission-unknown" : "failed",
        payload: {
          ...submission.payload,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
  }

  private async developWithExecutionProvider(
    brief: string,
    provider: ExecutionProvider,
  ): Promise<{ value: CreativeOutput; model: string }> {
    const selectedModel =
      provider === "openai-api"
        ? process.env.FULCRUM_OPENAI_API_MODEL
        : process.env[`FULCRUM_${provider.toUpperCase()}_ORCHESTRATOR_MODEL`];
    const result = await this.execution.generateStructured({
      provider,
      ...(selectedModel ? { model: selectedModel } : {}),
      cwd: process.env.FULCRUM_REPOSITORY_ROOT ?? process.cwd(),
      systemPrompt:
        "You are Fulcrum's orchestration model and creative director. Convert the brief into a concise, internally consistent game-design digest and visual bible. Declare assumptions; do not invent licensed characters or brands. Do not edit files or execute tools for this planning task.",
      prompt: brief,
      schema: CreativeOutputSchema,
    });
    return { value: result.value, model: result.model };
  }
}

const conceptPrompt = (bible: VisualBible, attempt: number): string =>
  [
    "Single prop concept sheet, no text or UI.",
    ...(attempt > 0
      ? [
          "Alternate approved-scope interpretation: emphasize the protected-vessel silhouette with a slimmer crystal and broader stone shoulders.",
        ]
      : []),
    bible.heroProp,
    `Style: ${bible.overallStyle}.`,
    `Shape language: ${bible.shapeLanguage}.`,
    `Materials: ${bible.materials.join(", ")}.`,
    `Lighting: ${bible.lighting}.`,
    "Centered three-quarter view, isolated on a dark atmospheric ground, production concept art, clear silhouette.",
  ].join(" ");

const conceptSvg = (bible: VisualBible, attempt: number): string => {
  const palette = new Map(
    bible.palette.map((entry) => [entry.name, entry.hex]),
  );
  const cyan =
    attempt > 0 ? "#78E7D1" : (palette.get("Core cyan") ?? "#5DE4E7");
  const bronze = palette.get("Old bronze") ?? "#9A7145";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <radialGradient id="bg"><stop offset="0" stop-color="#304859"/><stop offset=".58" stop-color="#171c25"/><stop offset="1" stop-color="#090b10"/></radialGradient>
    <linearGradient id="stone" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#657080"/><stop offset=".35" stop-color="#313845"/><stop offset="1" stop-color="#12151c"/></linearGradient>
    <linearGradient id="metal"><stop stop-color="#d0a36c"/><stop offset=".45" stop-color="${bronze}"/><stop offset="1" stop-color="#503621"/></linearGradient>
    <radialGradient id="crystal"><stop stop-color="#ffffff"/><stop offset=".2" stop-color="${cyan}"/><stop offset=".72" stop-color="#1496a5"/><stop offset="1" stop-color="#063844"/></radialGradient>
    <filter id="glow"><feGaussianBlur stdDeviation="24"/></filter>
    <filter id="shadow"><feGaussianBlur stdDeviation="18"/></filter>
  </defs>
  <rect width="1024" height="1024" fill="url(#bg)"/>
  <ellipse cx="520" cy="790" rx="315" ry="76" fill="#05070a" opacity=".78" filter="url(#shadow)"/>
  <circle cx="520" cy="475" r="165" fill="${cyan}" opacity=".18" filter="url(#glow)"/>
  <path d="M287 686 L334 356 L405 287 L619 287 L704 357 L753 686 L685 760 L348 760 Z" fill="url(#stone)" stroke="#8a94a1" stroke-width="9"/>
  <path d="M337 391 L415 319 L610 319 L683 392 L653 425 L375 425 Z" fill="#252b34"/>
  <path d="M315 567 Q512 510 726 567 L735 640 Q515 586 304 640 Z" fill="url(#metal)" stroke="#d2a16b" stroke-width="7"/>
  <path d="M359 397 Q512 449 674 397 L663 459 Q512 510 348 459 Z" fill="url(#metal)" stroke="#c28c55" stroke-width="7"/>
  <path d="M444 407 L512 340 L580 407 L556 596 L512 654 L468 596 Z" fill="url(#crystal)" stroke="#a7ffff" stroke-width="9"/>
  <path d="M512 350 L512 641 L468 590 L445 410 Z" fill="#e0ffff" opacity=".18"/>
  <path d="M365 681 L401 501 L447 486 L456 682 Z M568 486 L620 505 L662 681 L559 682 Z" fill="#181d25" stroke="#59626e" stroke-width="8"/>
  <path d="M348 699 L680 699 L645 770 L379 770 Z" fill="#20262f" stroke="#6e7783" stroke-width="9"/>
  <path d="M383 745 L642 745" stroke="${bronze}" stroke-width="18" opacity=".9"/>
  <g fill="#b6f9f6" opacity=".6"><circle cx="310" cy="302" r="4"/><circle cx="742" cy="416" r="5"/><circle cx="274" cy="533" r="3"/><circle cx="701" cy="281" r="3"/><circle cx="754" cy="610" r="4"/></g>
  </svg>`;
};

export class ConceptProduction {
  constructor(
    private readonly repository: ProjectRepository,
    private readonly subscriptionImage: SubscriptionImageRunner = runCodexSubscriptionImage,
  ) {}

  async ensure(input: {
    projectId: string;
    runId: string;
    mode: ProviderMode;
    imageProvider: ImageProvider;
    gameDesign: RevisionRef;
    visualBible: RevisionRef;
    attempt?: number;
  }): Promise<ProductionOutcome<RevisionRef>> {
    const attempt = input.attempt ?? 0;
    const idempotencyKey = `concept:${input.projectId}:${input.visualBible.artifact.sha256}:${input.mode}:${input.imageProvider}:${attempt}`;
    const prior = this.repository.getSubmissionByKey(idempotencyKey);
    if (prior?.status === "ready" && prior.resultRevisionId) {
      return {
        status: "ready",
        requestId: prior.requestId,
        value: this.repository.getRevision(prior.resultRevisionId),
      };
    }
    if (prior && input.mode === "live") {
      if (prior.status !== "failed" && prior.status !== "submission-unknown") {
        this.repository.updateSubmission(prior.requestId, {
          status: "submission-unknown",
        });
      }
      return {
        status: "failed",
        requestId: prior.requestId,
        error: {
          code:
            prior.status === "failed"
              ? "concept-generation-failed"
              : "submission-unknown",
          message:
            prior.status === "failed"
              ? "The live concept request previously failed and requires user-directed retry."
              : "The live concept request may have reached OpenAI before interruption; Fulcrum will not spend again automatically.",
          recoverable: true,
        },
      };
    }
    const bible = this.repository.resolveRevision<VisualBible>(
      input.visualBible,
    );
    const prompt = conceptPrompt(bible, attempt);
    const submission =
      prior ??
      this.repository.recordSubmissionIntent({
        projectId: input.projectId,
        operation: "concept-image",
        provider:
          input.mode === "replay"
            ? "fulcrum-replay"
            : input.imageProvider === "none"
              ? "fulcrum-renderer"
              : input.imageProvider,
        idempotencyKey,
        payload: {
          prompt,
          visualBibleRevisionId: input.visualBible.revisionId,
        },
      });
    try {
      if (input.mode === "live") {
        this.repository.updateSubmission(submission.requestId, {
          status: "pending",
        });
      }
      const generated =
        input.mode === "replay"
          ? {
              bytes: await sharp(Buffer.from(conceptSvg(bible, attempt)))
                .png()
                .toBuffer(),
              model: "replay-svg-v1",
              costUsd: 0,
            }
          : await this.generateLiveConcept(
              input.projectId,
              prompt,
              bible,
              attempt,
              input.imageProvider,
            );
      const image = this.repository.putArtifact(
        input.projectId,
        generated.bytes,
        "image/png",
      );
      const document: ConceptDocument = ConceptDocumentSchema.parse({
        conceptId: `${input.projectId}:reliquary-concept`,
        name: "Ancient Reliquary",
        prompt,
        negativePrompt: bible.prohibitedStyles.join(", "),
        image,
        provider:
          input.mode === "replay"
            ? "fulcrum-replay"
            : input.imageProvider === "none"
              ? "fulcrum-renderer"
              : input.imageProvider,
        model: generated.model,
        sourceRevisionIds: [
          input.gameDesign.revisionId,
          input.visualBible.revisionId,
        ],
        costUsd: generated.costUsd,
      });
      const revision = this.repository.writeRevision({
        projectId: input.projectId,
        entityId: document.conceptId,
        kind: "concept-document",
        value: document,
        runId: input.runId,
      });
      this.repository.updateSubmission(submission.requestId, {
        status: "ready",
        resultRevisionId: revision.revisionId,
      });
      this.repository.appendEvent({
        projectId: input.projectId,
        runId: input.runId,
        type: "concept.completed",
        payload: {
          revisionId: revision.revisionId,
          imageArtifactId: image.artifactId,
        },
      });
      return {
        status: "ready",
        requestId: submission.requestId,
        value: revision,
      };
    } catch (error) {
      this.repository.updateSubmission(submission.requestId, {
        status: input.mode === "live" ? "submission-unknown" : "failed",
        payload: {
          ...submission.payload,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return {
        status: "failed",
        requestId: submission.requestId,
        error: {
          code: "concept-generation-failed",
          message: error instanceof Error ? error.message : String(error),
          recoverable: true,
        },
      };
    }
  }

  private async generateLiveConcept(
    projectId: string,
    prompt: string,
    bible: VisualBible,
    attempt: number,
    provider: ImageProvider,
  ): Promise<{ bytes: Uint8Array; model: string; costUsd: number }> {
    if (provider === "none") {
      return {
        bytes: await sharp(Buffer.from(conceptSvg(bible, attempt)))
          .png()
          .toBuffer(),
        model: "procedural-svg-v1",
        costUsd: 0,
      };
    }
    if (provider === "openai-subscription") {
      const generated = await this.subscriptionImage({ prompt });
      return {
        ...generated,
        bytes: await sharp(generated.bytes).png().toBuffer(),
      };
    }
    if (provider === "custom-api")
      return await this.generateWithCustomApi(projectId, prompt);
    const apiKey = process.env.OPENAI_API_KEY;
    const model = "gpt-image-2";
    if (!apiKey) {
      throw new Error(
        "GPT Image 2 concept generation requires OPENAI_API_KEY.",
      );
    }
    const reservedCost = Number(
      process.env.FULCRUM_OPENAI_IMAGE_RESERVE_USD ?? "0.20",
    );
    this.repository.reserveBudget(
      projectId,
      reservedCost,
      "OpenAI concept image",
    );
    const client = new OpenAI({ apiKey });
    const result = await client.images.generate({
      model,
      prompt,
      size: "1024x1024",
      quality: "medium",
      output_format: "png",
    });
    const base64 = result.data?.[0]?.b64_json;
    if (!base64)
      throw new Error("OpenAI image generation returned no image data.");
    return {
      bytes: Buffer.from(base64, "base64"),
      model,
      costUsd: reservedCost,
    };
  }

  private async generateWithCustomApi(
    projectId: string,
    prompt: string,
  ): Promise<{ bytes: Uint8Array; model: string; costUsd: number }> {
    const url = process.env.FULCRUM_IMAGE_API_URL;
    const apiKey = process.env.FULCRUM_IMAGE_API_KEY;
    const model = process.env.FULCRUM_IMAGE_API_MODEL;
    if (!url || !apiKey || !model) {
      throw new Error(
        "Custom image generation requires FULCRUM_IMAGE_API_URL, FULCRUM_IMAGE_API_KEY, and FULCRUM_IMAGE_API_MODEL.",
      );
    }
    const reservedCost = Number(
      process.env.FULCRUM_IMAGE_API_RESERVE_USD ?? "0.25",
    );
    this.repository.reserveBudget(
      projectId,
      reservedCost,
      "Custom concept image API",
    );
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        prompt,
        size: "1024x1024",
        quality: "medium",
        output_format: "png",
      }),
    });
    if (!response.ok)
      throw new Error(`Custom image API failed (${response.status}).`);
    const payload = (await response.json()) as {
      data?: Array<{ b64_json?: string; url?: string }>;
    };
    const first = payload.data?.[0];
    let bytes: Uint8Array;
    if (first?.b64_json) bytes = Buffer.from(first.b64_json, "base64");
    else if (first?.url) {
      const image = await fetch(first.url);
      if (!image.ok)
        throw new Error(`Custom image download failed (${image.status}).`);
      bytes = new Uint8Array(await image.arrayBuffer());
    } else throw new Error("Custom image API returned no image data.");
    return { bytes, model, costUsd: reservedCost };
  }
}

export const createApprovalId = () => randomUUID();
