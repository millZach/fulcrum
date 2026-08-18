import { randomUUID } from "node:crypto";

import {
  AssetDocumentSchema,
  AssetEvaluationSchema,
  type AssetProvider,
  type AssetDocument,
  type AssetEvaluation,
  type ConceptDocument,
  type ProductionOutcome,
  type ProviderMode,
  type RevisionRef,
} from "@fulcrum/domain";
import { ProjectRepository } from "@fulcrum/project";
import { Document, getBounds, NodeIO, Primitive } from "@gltf-transform/core";
import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  OctahedronGeometry,
  TorusGeometry,
} from "three";

type GeneratedAsset = {
  bytes: Uint8Array;
  provider: string;
  model: string;
  externalJobId: string;
  costUsd: number;
  providerMetadata?: Record<string, unknown>;
};

const addGeometry = (
  document: Document,
  buffer: ReturnType<Document["createBuffer"]>,
  name: string,
  geometry: BufferGeometry,
  material: ReturnType<Document["createMaterial"]>,
): void => {
  geometry.computeVertexNormals();
  const positions = geometry.getAttribute("position");
  const normals = geometry.getAttribute("normal");
  if (!positions || !normals)
    throw new Error(`Geometry ${name} has no renderable attributes.`);
  const primitive = document
    .createPrimitive()
    .setAttribute(
      "POSITION",
      document
        .createAccessor(`${name}:positions`, buffer)
        .setType("VEC3")
        .setArray(new Float32Array(positions.array)),
    )
    .setAttribute(
      "NORMAL",
      document
        .createAccessor(`${name}:normals`, buffer)
        .setType("VEC3")
        .setArray(new Float32Array(normals.array)),
    )
    .setMaterial(material);
  if (geometry.index) {
    const values = Array.from(geometry.index.array);
    const max = Math.max(...values);
    primitive.setIndices(
      document
        .createAccessor(`${name}:indices`, buffer)
        .setType("SCALAR")
        .setArray(
          max > 65_535 ? new Uint32Array(values) : new Uint16Array(values),
        ),
    );
  }
  const mesh = document.createMesh(name).addPrimitive(primitive);
  document
    .getRoot()
    .listScenes()[0]
    ?.addChild(document.createNode(name).setMesh(mesh));
  geometry.dispose();
};

export const createReplayReliquary = async (): Promise<Uint8Array> => {
  const document = new Document();
  document.createScene("Fulcrum M0 Reliquary");
  const buffer = document.createBuffer("reliquary-buffer");
  const stone = document
    .createMaterial("Weathered basalt")
    .setBaseColorFactor([0.085, 0.105, 0.14, 1])
    .setMetallicFactor(0.05)
    .setRoughnessFactor(0.86);
  const edgeStone = document
    .createMaterial("Ash edge planes")
    .setBaseColorFactor([0.25, 0.29, 0.34, 1])
    .setMetallicFactor(0.02)
    .setRoughnessFactor(0.78);
  const bronze = document
    .createMaterial("Aged bronze")
    .setBaseColorFactor([0.52, 0.32, 0.16, 1])
    .setMetallicFactor(0.78)
    .setRoughnessFactor(0.42);
  const crystal = document
    .createMaterial("Cyan crystal")
    .setBaseColorFactor([0.13, 0.78, 0.86, 1])
    .setEmissiveFactor([0.12, 0.74, 0.82])
    .setMetallicFactor(0.05)
    .setRoughnessFactor(0.18);

  const base = new CylinderGeometry(1.45, 1.62, 0.32, 8).translate(0, 0.16, 0);
  addGeometry(document, buffer, "octagonal plinth", base, stone);
  const foot = new CylinderGeometry(1.26, 1.42, 0.24, 8).translate(0, 0.43, 0);
  addGeometry(document, buffer, "bronze foot", foot, bronze);
  const body = new BoxGeometry(1.9, 1.55, 1.55).translate(0, 1.27, 0);
  addGeometry(document, buffer, "stone vessel", body, stone);
  const shoulder = new CylinderGeometry(1.16, 1.34, 0.36, 8).translate(
    0,
    2.13,
    0,
  );
  addGeometry(document, buffer, "crowned shoulder", shoulder, edgeStone);
  const lid = new CylinderGeometry(0.95, 1.14, 0.24, 8).translate(0, 2.43, 0);
  addGeometry(document, buffer, "capstone", lid, stone);

  for (const [index, height] of [0.73, 1.82, 2.35].entries()) {
    const ring = new TorusGeometry(index === 1 ? 1.25 : 1.08, 0.085, 8, 32)
      .rotateX(Math.PI / 2)
      .translate(0, height, 0);
    addGeometry(document, buffer, `bronze binding ${index + 1}`, ring, bronze);
  }

  const core = new OctahedronGeometry(0.56, 0)
    .scale(0.72, 1.55, 0.72)
    .translate(0, 1.43, 0.88);
  addGeometry(document, buffer, "awakened cyan core", core, crystal);
  const coreFrameLeft = new BoxGeometry(0.16, 1.4, 0.18)
    .rotateZ(-0.16)
    .translate(-0.65, 1.42, 0.74);
  addGeometry(document, buffer, "left core guard", coreFrameLeft, bronze);
  const coreFrameRight = new BoxGeometry(0.16, 1.4, 0.18)
    .rotateZ(0.16)
    .translate(0.65, 1.42, 0.74);
  addGeometry(document, buffer, "right core guard", coreFrameRight, bronze);

  document.getRoot().getAsset().generator = "Fulcrum replay asset generator";
  return new NodeIO().writeBinary(document);
};

export class AssetProduction {
  constructor(private readonly repository: ProjectRepository) {}

  async ensure(input: {
    projectId: string;
    runId: string;
    mode: ProviderMode;
    assetProvider: AssetProvider;
    concept: RevisionRef;
  }): Promise<ProductionOutcome<RevisionRef>> {
    const idempotencyKey = `asset:${input.projectId}:${input.concept.artifact.sha256}:${input.mode}:${input.assetProvider}`;
    const prior = this.repository.getSubmissionByKey(idempotencyKey);
    if (prior?.status === "ready" && prior.resultRevisionId) {
      return {
        status: "ready",
        requestId: prior.requestId,
        value: this.repository.getRevision(prior.resultRevisionId),
      };
    }
    if (prior?.status === "failed" || prior?.status === "submission-unknown") {
      return {
        status: "failed",
        requestId: prior.requestId,
        error: {
          code:
            prior.status === "submission-unknown"
              ? "submission-unknown"
              : "asset-generation-failed",
          message:
            prior.status === "submission-unknown"
              ? `The ${input.assetProvider} submission outcome is ambiguous; Fulcrum will not create another paid job automatically.`
              : "The previous asset job failed and requires user-directed regeneration.",
          recoverable: true,
        },
      };
    }
    if (
      input.mode === "live" &&
      prior &&
      (prior.status === "intent-recorded" ||
        (prior.status === "pending" && !prior.externalJobId))
    ) {
      this.repository.updateSubmission(prior.requestId, {
        status: "submission-unknown",
      });
      return {
        status: "failed",
        requestId: prior.requestId,
        error: {
          code: "submission-unknown",
          message: `${input.assetProvider} may have accepted this request before interruption; Fulcrum will not risk duplicate spend.`,
          recoverable: true,
        },
      };
    }
    const concept = this.repository.resolveRevision<ConceptDocument>(
      input.concept,
    );
    const submission =
      prior ??
      this.repository.recordSubmissionIntent({
        projectId: input.projectId,
        operation: "image-to-model",
        provider:
          input.mode === "replay" ? "fulcrum-replay" : input.assetProvider,
        idempotencyKey,
        payload: {
          conceptRevisionId: input.concept.revisionId,
          imageArtifactId: concept.image.artifactId,
        },
      });
    try {
      let generated: GeneratedAsset | undefined;
      if (input.mode === "replay") {
        generated = {
          bytes: await createReplayReliquary(),
          provider: "fulcrum-replay",
          model: "parametric-reliquary-v1",
          externalJobId: `replay-${input.concept.artifact.sha256.slice(0, 12)}`,
          costUsd: 0,
        };
      } else if (submission.status === "pending" && submission.externalJobId) {
        let inspected;
        try {
          inspected =
            input.assetProvider === "meshy"
              ? await this.inspectMeshyJob(submission.externalJobId)
              : await this.inspectTripoJob(submission.externalJobId);
        } catch (error) {
          this.repository.updateSubmission(submission.requestId, {
            status: "pending",
            payload: {
              ...submission.payload,
              lastPollError:
                error instanceof Error ? error.message : String(error),
            },
          });
          return {
            status: "pending",
            requestId: submission.requestId,
            resumeAfter: new Date(Date.now() + 5_000).toISOString(),
          };
        }
        if (inspected.status === "pending")
          return {
            status: "pending",
            requestId: submission.requestId,
            resumeAfter: inspected.resumeAfter,
          };
        if (inspected.status === "failed") {
          this.repository.updateSubmission(submission.requestId, {
            status: "failed",
            payload: {
              ...submission.payload,
              provider: input.assetProvider,
              providerError: inspected.error,
            },
          });
          return {
            status: "failed",
            requestId: submission.requestId,
            error: {
              code: `${input.assetProvider}-job-failed`,
              message: inspected.error,
              recoverable: true,
            },
          };
        }
        generated = inspected.asset;
      } else {
        this.repository.updateSubmission(submission.requestId, {
          status: "pending",
          payload: {
            ...submission.payload,
            providerCallStartedAt: new Date().toISOString(),
          },
        });
        let job;
        try {
          job =
            input.assetProvider === "meshy"
              ? await this.submitMeshyJob(input.projectId, concept)
              : await this.submitTripoJob(input.projectId, concept);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          this.repository.updateSubmission(submission.requestId, {
            status: "submission-unknown",
            payload: { ...submission.payload, error: message },
          });
          return {
            status: "failed",
            requestId: submission.requestId,
            error: { code: "submission-unknown", message, recoverable: true },
          };
        }
        this.repository.updateSubmission(submission.requestId, {
          status: "pending",
          externalJobId: job.taskId,
          payload: {
            ...submission.payload,
            submittedAt: new Date().toISOString(),
          },
        });
        return {
          status: "pending",
          requestId: submission.requestId,
          resumeAfter: new Date(Date.now() + 5_000).toISOString(),
        };
      }

      const glb = this.repository.putArtifact(
        input.projectId,
        generated.bytes,
        "model/gltf-binary",
      );
      const asset: AssetDocument = AssetDocumentSchema.parse({
        assetId: `${input.projectId}:reliquary-asset`,
        name: "Ancient Reliquary",
        classification: "hero",
        glb,
        provider: generated.provider,
        model: generated.model,
        sourceConceptRevisionId: input.concept.revisionId,
        externalJobId: generated.externalJobId,
        costUsd: generated.costUsd,
      });
      const revision = this.repository.writeRevision({
        projectId: input.projectId,
        entityId: asset.assetId,
        kind: "asset-document",
        value: asset,
        runId: input.runId,
      });
      this.repository.updateSubmission(submission.requestId, {
        status: "ready",
        resultRevisionId: revision.revisionId,
        payload: {
          ...submission.payload,
          ...(generated.providerMetadata ?? {}),
        },
      });
      this.repository.appendEvent({
        projectId: input.projectId,
        runId: input.runId,
        type: "asset.completed",
        payload: {
          revisionId: revision.revisionId,
          glbArtifactId: glb.artifactId,
        },
      });
      return {
        status: "ready",
        requestId: submission.requestId,
        value: revision,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.repository.updateSubmission(submission.requestId, {
        status: "failed",
        payload: { ...submission.payload, error: message },
      });
      return {
        status: "failed",
        requestId: submission.requestId,
        error: { code: "asset-generation-failed", message, recoverable: true },
      };
    }
  }

  private async submitMeshyJob(
    projectId: string,
    concept: ConceptDocument,
  ): Promise<{ taskId: string }> {
    const apiKey = process.env.MESHY_API_KEY;
    const model = process.env.FULCRUM_MESHY_MODEL;
    if (!apiKey || !model) {
      throw new Error(
        "Live Meshy generation requires MESHY_API_KEY and FULCRUM_MESHY_MODEL.",
      );
    }
    const reservedCost = Number(
      process.env.FULCRUM_MESHY_RESERVE_USD ?? "0.50",
    );
    this.repository.reserveBudget(projectId, reservedCost, "Meshy image-to-3D");
    const imageBytes = this.repository.readArtifact(concept.image);
    const imageUrl = `data:${concept.image.mediaType};base64,${Buffer.from(imageBytes).toString("base64")}`;
    const response = await fetch(
      "https://api.meshy.ai/openapi/v1/image-to-3d",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          image_url: imageUrl,
          model_type: "standard",
          ai_model: model,
          should_texture: true,
          enable_pbr: true,
          texture_resolution: "2k",
          should_remesh: false,
          image_enhancement: false,
          ...(model === "meshy-6" ? { remove_lighting: true } : {}),
          moderation: true,
          target_formats: ["glb"],
        }),
      },
    );
    const body = (await response.json()) as {
      result?: string;
      message?: string;
      detail?: string;
    };
    if (!response.ok || !body.result) {
      throw new Error(
        body.message ??
          body.detail ??
          `Meshy task submission failed (${response.status}).`,
      );
    }
    return { taskId: body.result };
  }

  private async inspectMeshyJob(
    taskId: string,
  ): Promise<
    | { status: "pending"; resumeAfter: string }
    | { status: "failed"; error: string }
    | { status: "ready"; asset: GeneratedAsset }
  > {
    const apiKey = process.env.MESHY_API_KEY;
    const model = process.env.FULCRUM_MESHY_MODEL;
    if (!apiKey || !model) {
      throw new Error(
        "Meshy polling requires MESHY_API_KEY and FULCRUM_MESHY_MODEL.",
      );
    }
    const response = await fetch(
      `https://api.meshy.ai/openapi/v1/image-to-3d/${encodeURIComponent(taskId)}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    const body = (await response.json()) as {
      status?: string;
      progress?: number;
      model_urls?: { glb?: string };
      task_error?: { message?: string };
      consumed_credits?: number;
      message?: string;
    };
    if (!response.ok || !body.status) {
      throw new Error(
        body.message ?? `Meshy polling failed (${response.status}).`,
      );
    }
    if (["PENDING", "IN_PROGRESS"].includes(body.status)) {
      return {
        status: "pending",
        resumeAfter: new Date(Date.now() + 5_000).toISOString(),
      };
    }
    if (body.status !== "SUCCEEDED") {
      return {
        status: "failed",
        error: `Meshy task ended with status ${body.status}: ${body.task_error?.message || "unknown error"}.`,
      };
    }
    const modelUrl = body.model_urls?.glb;
    if (!modelUrl) {
      return {
        status: "failed",
        error: "Meshy completed without a downloadable GLB.",
      };
    }
    const modelResponse = await fetch(modelUrl);
    if (!modelResponse.ok) {
      return {
        status: "failed",
        error: `Meshy GLB download failed (${modelResponse.status}).`,
      };
    }
    return {
      status: "ready",
      asset: {
        bytes: new Uint8Array(await modelResponse.arrayBuffer()),
        provider: "meshy",
        model,
        externalJobId: taskId,
        costUsd: Number(process.env.FULCRUM_MESHY_RESERVE_USD ?? "0.50"),
        providerMetadata: {
          consumedCredits: body.consumed_credits ?? null,
          providerProgress: body.progress ?? 100,
        },
      },
    };
  }

  private async submitTripoJob(
    projectId: string,
    concept: ConceptDocument,
  ): Promise<{ taskId: string }> {
    const apiKey = process.env.TRIPO_API_KEY;
    const modelVersion = process.env.FULCRUM_TRIPO_MODEL_VERSION;
    if (!apiKey || !modelVersion)
      throw new Error(
        "Live asset generation requires TRIPO_API_KEY and FULCRUM_TRIPO_MODEL_VERSION.",
      );
    const reservedCost = Number(
      process.env.FULCRUM_TRIPO_RESERVE_USD ?? "0.50",
    );
    this.repository.reserveBudget(
      projectId,
      reservedCost,
      "Tripo image-to-model",
    );
    const imageBytes = this.repository.readArtifact(concept.image);
    const imageBuffer = new ArrayBuffer(imageBytes.byteLength);
    new Uint8Array(imageBuffer).set(imageBytes);
    const form = new FormData();
    form.append(
      "file",
      new Blob([imageBuffer], { type: concept.image.mediaType }),
      "concept.png",
    );
    const uploadResponse = await fetch(
      "https://api.tripo3d.ai/v2/openapi/upload/sts",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      },
    );
    const upload = (await uploadResponse.json()) as {
      data?: { image_token?: string };
      message?: string;
    };
    if (!uploadResponse.ok || !upload.data?.image_token)
      throw new Error(
        upload.message ?? `Tripo upload failed (${uploadResponse.status}).`,
      );
    const taskResponse = await fetch("https://api.tripo3d.ai/v2/openapi/task", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "image_to_model",
        model_version: modelVersion,
        file: { type: "png", file_token: upload.data.image_token },
      }),
    });
    const task = (await taskResponse.json()) as {
      data?: { task_id?: string };
      message?: string;
    };
    if (!taskResponse.ok || !task.data?.task_id)
      throw new Error(
        task.message ??
          `Tripo task submission failed (${taskResponse.status}).`,
      );
    return { taskId: task.data.task_id };
  }

  private async inspectTripoJob(
    taskId: string,
  ): Promise<
    | { status: "pending"; resumeAfter: string }
    | { status: "failed"; error: string }
    | { status: "ready"; asset: GeneratedAsset }
  > {
    const apiKey = process.env.TRIPO_API_KEY;
    const modelVersion = process.env.FULCRUM_TRIPO_MODEL_VERSION;
    if (!apiKey || !modelVersion)
      throw new Error("Tripo polling requires its API key and model version.");
    const response = await fetch(
      `https://api.tripo3d.ai/v2/openapi/task/${encodeURIComponent(taskId)}`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
      },
    );
    const body = (await response.json()) as {
      data?: {
        status?: string;
        output?: { pbr_model?: string; model?: string };
        consumed_credit?: number;
      };
      message?: string;
    };
    if (!response.ok || !body.data?.status)
      throw new Error(
        body.message ?? `Tripo polling failed (${response.status}).`,
      );
    if (["queued", "running"].includes(body.data.status)) {
      return {
        status: "pending",
        resumeAfter: new Date(Date.now() + 5_000).toISOString(),
      };
    }
    if (body.data.status !== "success")
      return {
        status: "failed",
        error: `Tripo task ended with status ${body.data.status}.`,
      };
    const modelUrl = body.data.output?.pbr_model ?? body.data.output?.model;
    if (!modelUrl)
      return {
        status: "failed",
        error: "Tripo completed without a downloadable model.",
      };
    const modelResponse = await fetch(modelUrl);
    if (!modelResponse.ok)
      return {
        status: "failed",
        error: `Tripo model download failed (${modelResponse.status}).`,
      };
    return {
      status: "ready",
      asset: {
        bytes: new Uint8Array(await modelResponse.arrayBuffer()),
        provider: "tripo",
        model: modelVersion,
        externalJobId: taskId,
        costUsd: Number(process.env.FULCRUM_TRIPO_RESERVE_USD ?? "0.50"),
      },
    };
  }
}

export class AssetQuality {
  constructor(private readonly repository: ProjectRepository) {}

  async evaluate(input: {
    projectId: string;
    runId: string;
    asset: RevisionRef;
  }): Promise<{ revision: RevisionRef; evaluation: AssetEvaluation }> {
    const asset = this.repository.resolveRevision<AssetDocument>(input.asset);
    const document = await new NodeIO().readBinary(
      this.repository.readArtifact(asset.glb),
    );
    const root = document.getRoot();
    const meshes = root.listMeshes();
    const primitives: Primitive[] = meshes.flatMap((mesh) =>
      mesh.listPrimitives(),
    );
    const vertexCount = primitives.reduce(
      (sum, primitive) =>
        sum + (primitive.getAttribute("POSITION")?.getCount() ?? 0),
      0,
    );
    const triangleCount = primitives.reduce((sum, primitive) => {
      const indices = primitive.getIndices();
      return (
        sum +
        Math.floor(
          (indices?.getCount() ??
            primitive.getAttribute("POSITION")?.getCount() ??
            0) / 3,
        )
      );
    }, 0);
    const scene = root.listScenes()[0];
    if (!scene) throw new Error("Asset GLB contains no scene.");
    const bounds = getBounds(scene);
    const size = {
      x: Math.max(0, bounds.max[0] - bounds.min[0]),
      y: Math.max(0, bounds.max[1] - bounds.min[1]),
      z: Math.max(0, bounds.max[2] - bounds.min[2]),
    };
    const gates = [
      {
        id: "mesh-present",
        label: "At least one mesh",
        passed: meshes.length > 0,
        detail: `${meshes.length} mesh(es)`,
      },
      {
        id: "triangles-present",
        label: "Renderable triangles",
        passed: triangleCount > 0,
        detail: `${triangleCount.toLocaleString()} triangles`,
      },
      {
        id: "triangle-budget",
        label: "M0 triangle budget",
        passed: triangleCount <= 500_000,
        detail: `${triangleCount.toLocaleString()} / 500,000`,
      },
      {
        id: "materials-present",
        label: "At least one material",
        passed: root.listMaterials().length > 0,
        detail: `${root.listMaterials().length} material(s)`,
      },
      {
        id: "claimed-textures-present",
        label: "Claimed textures are embedded",
        passed:
          !["meshy", "tripo"].includes(asset.provider) ||
          root.listTextures().length > 0,
        detail: ["meshy", "tripo"].includes(asset.provider)
          ? `${root.listTextures().length} embedded texture(s)`
          : "Replay asset makes no texture claim",
      },
      {
        id: "sane-bounds",
        label: "Sane authored bounds",
        passed:
          Math.max(size.x, size.y, size.z) <= 50 &&
          Math.min(size.x, size.y, size.z) >= 0.05,
        detail: `${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)} m`,
      },
    ];
    const evaluation: AssetEvaluation = AssetEvaluationSchema.parse({
      evaluationId: randomUUID(),
      assetRevisionId: input.asset.revisionId,
      passed: gates.every((gate) => gate.passed),
      measurements: {
        meshCount: meshes.length,
        primitiveCount: primitives.length,
        vertexCount,
        triangleCount,
        materialCount: root.listMaterials().length,
        textureCount: root.listTextures().length,
        animationCount: root.listAnimations().length,
        boundsMeters: size,
      },
      gates,
      evaluatedAt: new Date().toISOString(),
    });
    const revision = this.repository.writeRevision({
      projectId: input.projectId,
      entityId: `${asset.assetId}:quality`,
      kind: "asset-evaluation",
      value: evaluation,
      runId: input.runId,
    });
    this.repository.appendEvent({
      projectId: input.projectId,
      runId: input.runId,
      type: "asset.quality-evaluated",
      payload: {
        revisionId: revision.revisionId,
        passed: evaluation.passed,
        triangleCount,
      },
    });
    return { revision, evaluation };
  }
}
