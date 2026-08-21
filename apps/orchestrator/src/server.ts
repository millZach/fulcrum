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
import { M0_FIXTURE_BRIEF } from "@fulcrum/domain";
import {
  inspectExecutionProviders,
  runCodexSubscriptionImage,
} from "@fulcrum/execution";
import { createRepository } from "@fulcrum/project";
import Fastify from "fastify";
import { z, ZodError } from "zod";

import { ProjectCoordinator } from "./project-coordinator.js";
import { loadRuntimeEnvironment } from "./runtime-config.js";
import { isTrustedStudioOrigin, STUDIO_ORIGINS } from "./studio-origin.js";

const { repositoryRoot, workspaceRoot } = loadRuntimeEnvironment(
  path.dirname(fileURLToPath(import.meta.url)),
);
process.env.FULCRUM_FIXTURE_BRIEF ??= M0_FIXTURE_BRIEF;
const repository = createRepository(workspaceRoot);
const coordinator = new ProjectCoordinator(repository);
const server = Fastify({ logger: true, bodyLimit: 12 * 1024 * 1024 });
const prototypeImageRoot = path.join(workspaceRoot, "prototype-imagegen");

// Explicit studio allowlist. `origin: true` reflected any Origin, so a tab on
// this machine could call the orchestrator. CORS alone is not enough for the
// Vite proxy on :4311 — that path forwards the browser Origin and the tab
// never sees these headers — so the ImageGen POST also checks Origin below.
await server.register(cors, { origin: [...STUDIO_ORIGINS] });

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
      .regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/)
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

const prototypeSource = (
  input: z.infer<typeof PrototypeImageEditInputSchema>,
): {
  bytes: Uint8Array;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
} => {
  if (input.sourceImageDataUrl) {
    const match =
      /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(
        input.sourceImageDataUrl,
      );
    if (!match?.[1] || !match[2])
      throw new Error("The source image is invalid.");
    return {
      bytes: Buffer.from(match[2], "base64"),
      mediaType: match[1] as "image/png" | "image/jpeg" | "image/webp",
    };
  }
  const generatedMatch =
    /^\/api\/prototype\/imagegen\/images\/([a-f0-9]{64})\.png$/.exec(
      input.sourceImage!,
    );
  const sourceRoot = generatedMatch
    ? prototypeImageRoot
    : path.join(repositoryRoot, "apps", "studio", "public", "m1-prototype");
  const filename = path.basename(input.sourceImage!);
  const absolutePath = path.resolve(sourceRoot, filename);
  if (!absolutePath.startsWith(`${sourceRoot}${path.sep}`))
    throw new Error("The source image path is invalid.");
  return { bytes: readFileSync(absolutePath), mediaType: "image/png" };
};

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
  {
    onRequest: async (request, reply) => {
      if (isTrustedStudioOrigin(request.headers.origin)) return;
      return reply.status(403).send({
        error: "This request is not from a trusted studio origin.",
        detail: "This request is not from a trusted studio origin.",
      });
    },
  },
  async (request) => {
    const input = PrototypeImageEditInputSchema.parse(request.body);
    const subscription = inspectExecutionProviders().find(
      ({ provider }) => provider === "openai",
    );
    if (!subscription?.ready || !subscription.capabilities.imageGeneration)
      throw new Error(
        subscription?.detail ??
          "The signed-in OpenAI subscription ImageGen capability is unavailable.",
      );
    const source = prototypeSource(input);
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
    const result = await runCodexSubscriptionImage({
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
server.post<{ Params: { projectId: string } }>(
  "/api/projects/:projectId/approvals/visual-direction",
  async (request) =>
    coordinator.approveDirection(
      request.params.projectId,
      request.body as never,
    ),
);
server.post<{ Params: { projectId: string } }>(
  "/api/projects/:projectId/interrogation/answers",
  async (request) =>
    coordinator.m1.answerFrontier(
      request.params.projectId,
      request.body as never,
    ),
);
server.post<{ Params: { projectId: string } }>(
  "/api/projects/:projectId/interrogation/confirm",
  async (request) =>
    coordinator.m1.confirmSharedUnderstanding(
      request.params.projectId,
      request.body as never,
    ),
);
server.post<{ Params: { projectId: string } }>(
  "/api/projects/:projectId/approvals/game-design",
  async (request) =>
    coordinator.m1.approveGameDesign(
      request.params.projectId,
      request.body as never,
    ),
);
server.post<{ Params: { projectId: string } }>(
  "/api/projects/:projectId/game-design/revise",
  async (request) =>
    coordinator.m1.reviseGameDesign(
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
    coordinator.m1.replaceDirection(request.params.projectId, {
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
}>("/api/projects/:projectId/directions/:directionId/change", async (request) =>
  coordinator.m1.changeDirection(request.params.projectId, {
    ...request.body,
    directionRevisionId: request.params.directionId,
  }),
);
server.post<{
  Params: { projectId: string };
  Body: { conceptPlanRevisionId: string; confirmed: true };
}>("/api/projects/:projectId/concept-plan/confirm", async (request) =>
  coordinator.m1.confirmConceptPlan(
    request.params.projectId,
    request.body as never,
  ),
);
server.post<{
  Params: { projectId: string; slotId: string };
  Body: { conceptSetRevisionId: string; notes?: string };
}>("/api/projects/:projectId/concepts/:slotId/regenerate", async (request) =>
  coordinator.m1.regenerateConcept(request.params.projectId, {
    ...request.body,
    slotId: request.params.slotId,
  }),
);
server.post<{
  Params: { projectId: string; slotId: string };
  Body: { conceptSetRevisionId: string; conceptRevisionId: string };
}>("/api/projects/:projectId/concepts/:slotId/select", async (request) =>
  coordinator.m1.selectConcept(request.params.projectId, {
    ...request.body,
    slotId: request.params.slotId,
  }),
);
server.post<{ Params: { projectId: string } }>(
  "/api/projects/:projectId/approvals/concept-set",
  async (request) =>
    coordinator.m1.approveConceptSet(
      request.params.projectId,
      request.body as never,
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
      statusCode === 500 ? "Fulcrum could not complete the request." : message,
    detail: message,
  });
});

const port = Number(process.env.FULCRUM_ORCHESTRATOR_PORT ?? "4310");
await server.listen({ host: "127.0.0.1", port });

const shutdown = async () => {
  await server.close();
  repository.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
