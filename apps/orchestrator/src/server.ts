import path from "node:path";
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";

import cors from "@fastify/cors";
import {
  M0_FIXTURE_BRIEF,
  isProviderPreflightError,
  isProviderUsageError,
  type IncreaseBudgetInput,
} from "@fulcrum/domain";
import {
  inspectExecutionProviders,
  runCodexSubscriptionImage,
} from "@fulcrum/execution";
import { createRepository, type ProjectRepository } from "@fulcrum/project";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";

import { ProjectCoordinator } from "./project-coordinator.js";
import { loadRuntimeEnvironment } from "./runtime-config.js";
import { isTrustedStudioOrigin, STUDIO_ORIGINS } from "./studio-origin.js";

const prototypeImageDataUrlPattern =
  /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_PROTOTYPE_IMAGE_BYTES = 8 * 1024 * 1024;

const PrototypeImageEditInputSchema = z
  .object({
    sourceImage: z
      .string()
      .regex(
        /^(?:\/m1-prototype\/[a-z0-9-]+\.png|\/api\/prototype\/imagegen\/images\/[a-f0-9]{64}\.png)$/,
      )
      .optional(),
    sourceImageDataUrl: z
      .string()
      .regex(prototypeImageDataUrlPattern)
      .optional(),
    prompt: z.string().trim().min(1).max(2_000),
    conceptTitle: z.string().trim().min(1).max(200),
    conceptPurpose: z.string().trim().min(1).max(500),
    directionName: z.string().trim().min(1).max(200),
  })
  .refine(
    ({ sourceImage, sourceImageDataUrl }) =>
      Boolean(sourceImage) !== Boolean(sourceImageDataUrl),
    "Provide exactly one source image.",
  );

const PrototypeImageGenerateInputSchema = z.object({
  prompt: z.string().trim().min(1).max(4_000),
  viewLabel: z.string().trim().min(1).max(80),
  viewInstruction: z.string().trim().min(1).max(1_200),
  assetName: z.string().trim().min(1).max(200),
  referenceImageDataUrl: z
    .string()
    .regex(prototypeImageDataUrlPattern)
    .optional(),
});

const PrototypeImageStoreInputSchema = z.object({
  imageDataUrl: z.string().regex(prototypeImageDataUrlPattern),
});

const prototypeDataUrlSource = (
  dataUrl: string,
): {
  bytes: Uint8Array;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
} => {
  const match =
    /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match?.[1] || !match[2]) throw new Error("The source image is invalid.");
  return {
    bytes: Buffer.from(match[2], "base64"),
    mediaType: match[1] as "image/png" | "image/jpeg" | "image/webp",
  };
};

const prototypeSource = (
  input: z.infer<typeof PrototypeImageEditInputSchema>,
  roots: { prototypeImageRoot: string; repositoryRoot: string },
): {
  bytes: Uint8Array;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
} => {
  if (input.sourceImageDataUrl)
    return prototypeDataUrlSource(input.sourceImageDataUrl);
  const generatedMatch =
    /^\/api\/prototype\/imagegen\/images\/([a-f0-9]{64})\.png$/.exec(
      input.sourceImage!,
    );
  const sourceRoot = generatedMatch
    ? roots.prototypeImageRoot
    : path.join(
        roots.repositoryRoot,
        "apps",
        "studio",
        "public",
        "m1-prototype",
      );
  const filename = path.basename(input.sourceImage!);
  const absolutePath = path.resolve(sourceRoot, filename);
  if (!absolutePath.startsWith(`${sourceRoot}${path.sep}`))
    throw new Error("The source image path is invalid.");
  return { bytes: readFileSync(absolutePath), mediaType: "image/png" };
};

/**
 * The guard every route that writes browser-chosen bytes, or spends a
 * signed-in subscription, is mounted behind. Shared so a new route of that
 * kind cannot quietly ship without it.
 */
const trustedStudioOriginOnly = {
  onRequest: async (request: FastifyRequest, reply: FastifyReply) => {
    if (isTrustedStudioOrigin(request.headers.origin)) return;
    return reply.status(403).send({
      error: "This request is not from a trusted studio origin.",
      detail: "This request is not from a trusted studio origin.",
    });
  },
};

export const createFulcrumServer = async (
  options: {
    repository?: ProjectRepository;
    coordinator?: ProjectCoordinator;
    logger?: boolean;
    prototypeImagegen?: {
      imageRoot?: string;
      inspectProviders?: typeof inspectExecutionProviders;
      runImage?: typeof runCodexSubscriptionImage;
    };
  } = {},
) => {
  const { repositoryRoot, workspaceRoot } = loadRuntimeEnvironment(
    path.dirname(fileURLToPath(import.meta.url)),
  );
  process.env.FULCRUM_FIXTURE_BRIEF ??= M0_FIXTURE_BRIEF;
  const repository = options.repository ?? createRepository(workspaceRoot);
  const coordinator = options.coordinator ?? new ProjectCoordinator(repository);
  const server = Fastify({
    logger: options.logger ?? true,
    bodyLimit: 12 * 1024 * 1024,
  });
  const prototypeImageRoot =
    options.prototypeImagegen?.imageRoot ??
    path.join(workspaceRoot, "prototype-imagegen");
  const inspectPrototypeImageProviders =
    options.prototypeImagegen?.inspectProviders ?? inspectExecutionProviders;
  const runPrototypeImage =
    options.prototypeImagegen?.runImage ?? runCodexSubscriptionImage;
  await server.register(cors, { origin: [...STUDIO_ORIGINS] });

  server.get("/api/health", async () => ({ status: "ok" }));
  server.get<{ Params: { sha256: string } }>(
    "/api/prototype/imagegen/images/:sha256.png",
    async (request, reply) => {
      const sha256 = z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(request.params.sha256);
      const absolutePath = path.join(prototypeImageRoot, `${sha256}.png`);
      if (!existsSync(absolutePath))
        return reply.status(404).send({ error: "Image revision not found." });
      reply.header("Content-Type", "image/png");
      reply.header("Cache-Control", "public, immutable, max-age=31536000");
      return reply.send(createReadStream(absolutePath));
    },
  );
  server.post(
    "/api/prototype/imagegen/edit",
    trustedStudioOriginOnly,
    async (request) => {
      const input = PrototypeImageEditInputSchema.parse(request.body);
      const subscription = inspectPrototypeImageProviders().find(
        ({ provider }) => provider === "openai",
      );
      if (!subscription?.ready || !subscription.capabilities.imageGeneration)
        throw new Error(
          subscription?.detail ??
            "The signed-in OpenAI subscription ImageGen capability is unavailable.",
        );
      const source = prototypeSource(input, {
        prototypeImageRoot,
        repositoryRoot,
      });
      const finalPrompt = [
        "Use case: precise-object-edit",
        "Asset type: polished game concept art",
        `Primary request: ${input.prompt}`,
        "Input images: Image 1 is the edit target.",
        `Subject: ${input.conceptTitle}`,
        `Purpose: ${input.conceptPurpose}`,
        `Approved visual direction: ${input.directionName}`,
        "Constraints: Make only the requested change. Preserve the subject identity, approved visual direction, environment, lighting, color language, composition, and all unrelated details.",
        "Avoid: text, UI, logos, watermarks, additional characters, unrelated objects, and unrequested redesigns.",
      ].join("\n");
      const result = await runPrototypeImage({
        prompt: finalPrompt,
        referenceImages: [source],
      });
      const sha256 = createHash("sha256").update(result.bytes).digest("hex");
      mkdirSync(prototypeImageRoot, { recursive: true });
      const absolutePath = path.join(prototypeImageRoot, `${sha256}.png`);
      if (!existsSync(absolutePath)) writeFileSync(absolutePath, result.bytes);
      return {
        imageUrl: `/api/prototype/imagegen/images/${sha256}.png`,
        sha256,
        model: result.model,
        costUsd: result.costUsd,
        prompt: finalPrompt,
      };
    },
  );
  server.post(
    "/api/prototype/imagegen/store",
    trustedStudioOriginOnly,
    async (request, reply) => {
      const input = PrototypeImageStoreInputSchema.parse(request.body);
      const { bytes } = prototypeDataUrlSource(input.imageDataUrl);
      if (bytes.byteLength > MAX_PROTOTYPE_IMAGE_BYTES)
        return reply.status(400).send({
          error: "The stored image must be 8 MB or smaller.",
          detail: "The stored image must be 8 MB or smaller.",
        });
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      mkdirSync(prototypeImageRoot, { recursive: true });
      const absolutePath = path.join(prototypeImageRoot, `${sha256}.png`);
      if (!existsSync(absolutePath)) writeFileSync(absolutePath, bytes);
      return {
        imageUrl: `/api/prototype/imagegen/images/${sha256}.png`,
        sha256,
      };
    },
  );
  server.post(
    "/api/prototype/imagegen/generate",
    trustedStudioOriginOnly,
    async (request) => {
      const input = PrototypeImageGenerateInputSchema.parse(request.body);
      const subscription = inspectPrototypeImageProviders().find(
        ({ provider }) => provider === "openai",
      );
      if (!subscription?.ready || !subscription.capabilities.imageGeneration)
        throw new Error(
          subscription?.detail ??
            "The signed-in OpenAI subscription ImageGen capability is unavailable.",
        );
      const referenceImages = input.referenceImageDataUrl
        ? [prototypeDataUrlSource(input.referenceImageDataUrl)]
        : [];
      const isFourViewSheet = input.viewLabel === "Four-view reference sheet";
      const finalPrompt = [
        "Use case: production-reference-view",
        "Asset type: game production reference sheet view",
        `Primary request: ${input.prompt}`,
        `Required view: ${input.viewLabel}. ${input.viewInstruction}`,
        ...(referenceImages.length > 0
          ? [
              isFourViewSheet
                ? "Input images: Image 1 is the canonical reference of the same subject. Preserve the subject's identity, silhouette, proportions, materials, and palette exactly. Match Image 1 exactly in the cell named by the required sheet instruction; render the other cells as the same subject from their assigned views."
                : "Input images: Image 1 is the canonical reference of the same subject. Preserve the subject's identity, silhouette, proportions, materials, and palette exactly; render that same subject from the required view. Do not copy Image 1's camera angle.",
            ]
          : []),
        `Subject: ${input.assetName}`,
        isFourViewSheet
          ? "Constraints: exactly four depictions of one subject identity, one per assigned cell, on a clean neutral background with consistent studio lighting; no text, labels, UI, watermarks, or extra props."
          : "Constraints: exactly one subject on a clean neutral background, consistent studio lighting, no text, labels, UI, watermarks, or extra props.",
      ].join("\n");
      const result = await runPrototypeImage({
        prompt: finalPrompt,
        referenceImages,
      });
      const sha256 = createHash("sha256").update(result.bytes).digest("hex");
      mkdirSync(prototypeImageRoot, { recursive: true });
      const absolutePath = path.join(prototypeImageRoot, `${sha256}.png`);
      if (!existsSync(absolutePath)) writeFileSync(absolutePath, result.bytes);
      return {
        imageUrl: `/api/prototype/imagegen/images/${sha256}.png`,
        sha256,
        model: result.model,
        costUsd: result.costUsd,
        prompt: finalPrompt,
      };
    },
  );
  server.get("/api/configuration", async () => coordinator.configuration());
  server.get("/api/projects", async () => coordinator.list());
  server.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId",
    async (request) => coordinator.snapshot(request.params.projectId),
  );
  server.post("/api/projects", async (request) =>
    coordinator.create(request.body as never),
  );
  server.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/advance",
    async (request) => coordinator.advance(request.params.projectId),
  );
  server.post<{ Params: { projectId: string }; Body: IncreaseBudgetInput }>(
    "/api/projects/:projectId/budget",
    async (request) =>
      coordinator.increaseBudget(request.params.projectId, request.body),
  );
  server.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/approvals/visual-direction",
    async (request) =>
      coordinator.approveDirection(
        request.params.projectId,
        request.body as never,
      ),
  );
  /* Images pasted into a free-text box. Guarded like the paid prototype
     routes rather than like the other project routes: this one writes bytes
     the browser chose, so an arbitrary tab on the machine should not be able
     to fill the workspace through it. */
  server.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/attachments",
    trustedStudioOriginOnly,
    async (request) =>
      coordinator.creative.storeAttachment(
        request.params.projectId,
        request.body as never,
      ),
  );
  server.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/interrogation/answers",
    async (request) =>
      coordinator.creative.answerFrontier(
        request.params.projectId,
        request.body as never,
      ),
  );
  server.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/interrogation/confirm",
    async (request) =>
      coordinator.creative.confirmSharedUnderstanding(
        request.params.projectId,
        request.body as never,
      ),
  );
  server.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/game-name/suggest",
    async (request) =>
      coordinator.creative.suggestGameNames(
        request.params.projectId,
        request.body as never,
      ),
  );
  server.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/game-name/commit",
    async (request) =>
      coordinator.creative.commitGameName(
        request.params.projectId,
        request.body as never,
      ),
  );
  server.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/continue/m2",
    async (request) =>
      coordinator.creative.continueIntoM2(
        request.params.projectId,
        request.body ?? {},
      ),
  );
  server.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/approvals/game-design",
    async (request) =>
      coordinator.creative.approveGameDesign(
        request.params.projectId,
        request.body as never,
      ),
  );
  server.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/game-design/revise",
    async (request) =>
      coordinator.creative.reviseGameDesign(
        request.params.projectId,
        request.body as never,
      ),
  );
  server.post<{
    Params: { projectId: string; directionId: string };
    Body: { directionSetRevisionId: string; notes: string };
  }>(
    "/api/projects/:projectId/directions/:directionId/replace",
    async (request) =>
      coordinator.creative.replaceDirection(request.params.projectId, {
        ...request.body,
        directionRevisionId: request.params.directionId,
      }),
  );
  server.post<{
    Params: { projectId: string; directionId: string };
    Body: {
      directionSetRevisionId: string;
      change: string;
      pinnedAspects: string[];
    };
  }>(
    "/api/projects/:projectId/directions/:directionId/change",
    async (request) =>
      coordinator.creative.changeDirection(request.params.projectId, {
        ...request.body,
        directionRevisionId: request.params.directionId,
      }),
  );
  server.post<{
    Params: { projectId: string };
    Body: {
      conceptPlanRevisionId: string;
      confirmed: true;
      promptOverrides?: Array<{ slotId: string; prompt: string }>;
    };
  }>("/api/projects/:projectId/concept-plan/confirm", async (request) =>
    coordinator.creative.confirmConceptPlan(
      request.params.projectId,
      request.body as never,
    ),
  );
  server.post<{
    Params: { projectId: string; slotId: string };
    Body: { conceptSetRevisionId: string; notes?: string };
  }>("/api/projects/:projectId/concepts/:slotId/regenerate", async (request) =>
    coordinator.creative.regenerateConcept(request.params.projectId, {
      ...request.body,
      slotId: request.params.slotId,
    }),
  );
  server.post<{
    Params: { projectId: string; slotId: string };
    Body: { conceptSetRevisionId: string; conceptRevisionId: string };
  }>("/api/projects/:projectId/concepts/:slotId/select", async (request) =>
    coordinator.creative.selectConcept(request.params.projectId, {
      ...request.body,
      slotId: request.params.slotId,
    }),
  );
  server.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/approvals/concept-set",
    async (request) =>
      coordinator.approveConceptSet(
        request.params.projectId,
        request.body as never,
      ),
  );
  server.post<{ Params: { projectId: string; gate: string } }>(
    "/api/projects/:projectId/approvals/:gate/reopen",
    async (request) =>
      coordinator.reopenApprovalReview(request.params.projectId, {
        gate: request.params.gate,
      }),
  );
  server.post<{
    Params: { projectId: string };
    Body: {
      soundPlanRevisionId: string;
      confirmed: true;
      promptOverrides?: Array<{ slotId: string; prompt: string }>;
    };
  }>("/api/projects/:projectId/sound-plan/confirm", async (request) =>
    coordinator.creative.confirmSoundPlan(
      request.params.projectId,
      request.body as never,
    ),
  );
  server.post<{
    Params: { projectId: string; slotId: string };
    Body: { soundSetRevisionId: string; notes?: string };
  }>("/api/projects/:projectId/sounds/:slotId/regenerate", async (request) =>
    coordinator.creative.regenerateSound(request.params.projectId, {
      ...request.body,
      slotId: request.params.slotId,
    }),
  );
  server.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/approvals/sound-set",
    async (request) =>
      coordinator.creative.approveSoundSet(
        request.params.projectId,
        request.body as never,
      ),
  );
  server.post<{
    Params: { projectId: string };
    Body: { section: string; request: string };
  }>(
    "/api/projects/:projectId/asset-plan/amend",
    trustedStudioOriginOnly,
    async (request) =>
      await coordinator.amendAssetPlan(request.params.projectId, request.body),
  );
  /* The reference views a human approved in the Images stage. It spends
     nothing, but it writes browser-chosen bytes and decides what the next
     geometry task is built from, so it is origin-guarded like the other
     byte-writing routes rather than open like the plain project routes. */
  server.post<{ Params: { projectId: string; assetId: string } }>(
    "/api/projects/:projectId/assets/:assetId/references",
    trustedStudioOriginOnly,
    async (request) =>
      await coordinator.storeAssetReferences(request.params.projectId, {
        ...((request.body as Record<string, unknown> | null) ?? {}),
        assetId: request.params.assetId,
      }),
  );
  /* Live detection may use the signed-in vision provider. The route is also
     the lazy backfill for projects whose reference set predates detection. */
  server.post<{ Params: { projectId: string; assetId: string } }>(
    "/api/projects/:projectId/assets/:assetId/biped-detection",
    trustedStudioOriginOnly,
    async (request) =>
      await coordinator.detectAssetBiped(
        request.params.projectId,
        request.params.assetId,
      ),
  );
  server.post<{
    Params: { projectId: string; assetId: string };
    Body: { biped: boolean; poseMode?: "a-pose" | "t-pose" };
  }>(
    "/api/projects/:projectId/assets/:assetId/rig-eligibility",
    trustedStudioOriginOnly,
    async (request) =>
      coordinator.overrideAssetRigEligibility(request.params.projectId, {
        ...request.body,
        assetId: request.params.assetId,
      }),
  );
  /* The staged asset gate. `start`, `decide` and `settings/meshy` can each
     authorize Meshy spend, so they are separate explicit routes; `poll` is a
     read of a task already paid for and is safe to call on a timer. */
  server.post<{
    Params: { projectId: string; assetId: string };
  }>("/api/projects/:projectId/assets/:assetId/stages/start", async (request) =>
    coordinator.startAssetStage(request.params.projectId, {
      assetId: request.params.assetId,
    }),
  );
  server.post<{
    Params: { projectId: string; assetId: string };
  }>("/api/projects/:projectId/assets/:assetId/stages/poll", async (request) =>
    coordinator.pollAssetStage(
      request.params.projectId,
      request.params.assetId,
    ),
  );
  server.post<{
    Params: { projectId: string; assetId: string };
    Body: {
      decision: string;
      acknowledgedCredits: number;
      note?: string;
    };
  }>(
    "/api/projects/:projectId/assets/:assetId/stages/decide",
    async (request) =>
      coordinator.decideAssetStage(request.params.projectId, {
        ...request.body,
        assetId: request.params.assetId,
      }),
  );
  server.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/settings/meshy",
    async (request) =>
      coordinator.updateMeshyConfig(
        request.params.projectId,
        request.body ?? {},
      ),
  );
  server.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/approvals/visual-slice",
    async (request) =>
      coordinator.approveSlice(request.params.projectId, request.body as never),
  );
  server.post<{ Params: { projectId: string }; Body: { dataUrl: string } }>(
    "/api/projects/:projectId/review-image",
    async (request) =>
      coordinator.storeReviewImage(
        request.params.projectId,
        request.body.dataUrl,
      ),
  );
  server.get<{ Params: { artifactId: string } }>(
    "/api/artifacts/:artifactId",
    async (request, reply) => {
      const record = repository.getArtifactRecord(request.params.artifactId);
      reply.header("Content-Type", record.ref.mediaType);
      reply.header("ETag", `\"${record.ref.sha256}\"`);
      reply.header("Cache-Control", "public, immutable, max-age=31536000");
      return reply.send(createReadStream(record.absolutePath));
    },
  );

  server.setErrorHandler((error, _request, reply) => {
    const message = error instanceof Error ? error.message : String(error);
    const statusCode =
      error instanceof ZodError
        ? 400
        : message.includes("does not exist")
          ? 404
          : 500;
    server.log.error(error);
    return reply.status(statusCode).send({
      error:
        statusCode === 500
          ? "Fulcrum could not complete the request."
          : message,
      detail: message,
      ...(isProviderPreflightError(error) || isProviderUsageError(error)
        ? { code: error.code }
        : {}),
    });
  });

  return { server, repository, coordinator };
};

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const { server, repository } = await createFulcrumServer();
  const port = Number(process.env.FULCRUM_ORCHESTRATOR_PORT ?? "4310");
  await server.listen({ host: "127.0.0.1", port });
  const shutdown = async () => {
    await server.close();
    repository.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
