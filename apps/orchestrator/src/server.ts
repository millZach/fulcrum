import path from "node:path";
import { createReadStream } from "node:fs";

import cors from "@fastify/cors";
import { M0_FIXTURE_BRIEF } from "@fulcrum/domain";
import { createRepository } from "@fulcrum/project";
import "dotenv/config";
import Fastify from "fastify";
import { ZodError } from "zod";

import { M0Coordinator } from "./coordinator.js";

process.env.FULCRUM_FIXTURE_BRIEF ??= M0_FIXTURE_BRIEF;
const workspaceRoot = path.resolve(
  process.cwd(),
  process.env.FULCRUM_WORKSPACE_ROOT ?? "workspace",
);
const repository = createRepository(workspaceRoot);
const coordinator = new M0Coordinator(repository);
const server = Fastify({ logger: true, bodyLimit: 12 * 1024 * 1024 });

await server.register(cors, { origin: true });

server.get("/api/health", async () => ({ status: "ok" }));
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
