import { randomUUID } from "node:crypto";

import { ConceptProduction, CreativeDevelopment } from "@fulcrum/creative";
import {
  ApprovalInputSchema,
  AssetProviderSchema,
  ConfigurationStatusSchema,
  CreateProjectInputSchema,
  ExecutionProviderSchema,
  ImageProviderSchema,
  ProjectSnapshotSchema,
  type ApprovalInput,
  type ConfigurationStatus,
  type CreateProjectInput,
  type ProjectSnapshot,
  type ProjectState,
} from "@fulcrum/domain";
import {
  inspectExecutionProviders,
  preferredOpenAIImageProvider,
  preferredOpenAIProvider,
} from "@fulcrum/execution";
import { AssetProduction, AssetQuality } from "@fulcrum/production";
import { ProjectRepository } from "@fulcrum/project";
import { SceneAuthoring } from "@fulcrum/scene";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

const WorkflowInputSchema = z.object({ projectId: z.string().min(1) });
const WorkflowOutputSchema = z.object({
  projectId: z.string(),
  status: z.string(),
  stage: z.string(),
});

const now = () => new Date().toISOString();

export class M0Coordinator {
  private readonly creative: CreativeDevelopment;
  private readonly concepts: ConceptProduction;
  private readonly assets: AssetProduction;
  private readonly quality: AssetQuality;
  private readonly scenes: SceneAuthoring;
  private readonly phaseWorkflow;

  constructor(readonly repository: ProjectRepository) {
    this.creative = new CreativeDevelopment(repository);
    this.concepts = new ConceptProduction(repository);
    this.assets = new AssetProduction(repository);
    this.quality = new AssetQuality(repository);
    this.scenes = new SceneAuthoring(repository);
    const coordinatePhase = createStep({
      id: "coordinate-m0-phase",
      description:
        "Executes one idempotent M0 production phase from durable project state.",
      inputSchema: WorkflowInputSchema,
      outputSchema: WorkflowOutputSchema,
      execute: async ({ inputData }) => {
        const state = await this.advanceOne(inputData.projectId);
        return {
          projectId: state.projectId,
          status: state.status,
          stage: state.stage,
        };
      },
    });
    this.phaseWorkflow = createWorkflow({
      id: "fulcrum-m0-phase",
      description:
        "Coordinates a single restart-safe phase of the Fulcrum M0 artifact lineage.",
      inputSchema: WorkflowInputSchema,
      outputSchema: WorkflowOutputSchema,
    })
      .then(coordinatePhase)
      .commit();
  }

  configuration(): ConfigurationStatus {
    const commonMissing = ["FULCRUM_M0_BUDGET_USD"].filter(
      (name) => !process.env[name],
    );
    const configuredBudget = Number(process.env.FULCRUM_M0_BUDGET_USD);
    if (
      (!Number.isFinite(configuredBudget) || configuredBudget <= 0) &&
      !commonMissing.includes("FULCRUM_M0_BUDGET_USD")
    ) {
      commonMissing.push("FULCRUM_M0_BUDGET_USD");
    }
    const providerMissing = {
      meshy: ["MESHY_API_KEY", "FULCRUM_MESHY_MODEL"].filter(
        (name) => !process.env[name],
      ),
      tripo: ["TRIPO_API_KEY", "FULCRUM_TRIPO_MODEL_VERSION"].filter(
        (name) => !process.env[name],
      ),
    };
    const defaultAssetProvider = AssetProviderSchema.catch("meshy").parse(
      process.env.FULCRUM_ASSET_PROVIDER,
    );
    const executionProviders = inspectExecutionProviders();
    const preferredOpenAI = preferredOpenAIProvider(executionProviders);
    const configuredOrchestrator = ExecutionProviderSchema.safeParse(
      process.env.FULCRUM_ORCHESTRATOR_PROVIDER,
    );
    const defaultOrchestratorProvider = configuredOrchestrator.success
      ? configuredOrchestrator.data
      : preferredOpenAI;
    const configuredImplementation = ExecutionProviderSchema.safeParse(
      process.env.FULCRUM_IMPLEMENTATION_PROVIDER,
    );
    const defaultImplementationProvider = configuredImplementation.success
      ? configuredImplementation.data
      : preferredOpenAI;
    const configuredImage = ImageProviderSchema.safeParse(
      process.env.FULCRUM_IMAGE_PROVIDER,
    );
    const defaultImageProvider = configuredImage.success
      ? configuredImage.data
      : preferredOpenAIImageProvider(executionProviders);
    const openAISubscription = executionProviders.find(
      ({ provider }) => provider === "openai",
    )!;
    const subscriptionImageReady =
      openAISubscription.ready &&
      openAISubscription.capabilities.imageGeneration;
    const imageProviderMissing = {
      "openai-subscription": subscriptionImageReady
        ? []
        : [
            openAISubscription.ready
              ? "Codex ImageGen is not enabled"
              : openAISubscription.detail,
          ],
      none: [],
      "openai-gpt-image-2": ["OPENAI_API_KEY"].filter(
        (name) => !process.env[name],
      ),
      "custom-api": [
        "FULCRUM_IMAGE_API_URL",
        "FULCRUM_IMAGE_API_KEY",
        "FULCRUM_IMAGE_API_MODEL",
      ].filter((name) => !process.env[name]),
    };
    const imageProviderDetail = {
      "openai-subscription": subscriptionImageReady
        ? "Signed-in Codex · ImageGen · GPT Image 2"
        : imageProviderMissing["openai-subscription"].join(" · "),
      "openai-gpt-image-2": process.env.OPENAI_API_KEY
        ? "OpenAI API · GPT Image 2"
        : "OpenAI API fallback needs OPENAI_API_KEY",
      "custom-api":
        imageProviderMissing["custom-api"].length === 0
          ? `Custom API · ${process.env.FULCRUM_IMAGE_API_MODEL}`
          : `Custom API needs ${imageProviderMissing["custom-api"].join(" · ")}`,
      none: "Disabled · procedural concept renderer",
    };
    const imageProviders = ImageProviderSchema.options.map((provider) => ({
      provider,
      ready: imageProviderMissing[provider].length === 0,
      missingConfiguration: imageProviderMissing[provider],
      detail: imageProviderDetail[provider],
    }));
    const assetProviders = (["meshy", "tripo"] as const).map((provider) => {
      const missingConfiguration = providerMissing[provider];
      return {
        provider,
        ready: missingConfiguration.length === 0,
        missingConfiguration,
      };
    });
    const defaultReadiness = assetProviders.find(
      ({ provider }) => provider === defaultAssetProvider,
    )!;
    const defaultOrchestratorReadiness = executionProviders.find(
      ({ provider }) => provider === defaultOrchestratorProvider,
    )!;
    const defaultImageReadiness = imageProviders.find(
      ({ provider }) => provider === defaultImageProvider,
    )!;
    const missingLiveConfiguration = [
      ...commonMissing,
      ...defaultReadiness.missingConfiguration,
      ...defaultImageReadiness.missingConfiguration,
      ...(defaultOrchestratorReadiness.ready
        ? []
        : [defaultOrchestratorReadiness.detail]),
    ];
    return ConfigurationStatusSchema.parse({
      defaultMode:
        process.env.FULCRUM_PROVIDER_MODE === "live" ? "live" : "replay",
      defaultAssetProvider,
      defaultOrchestratorProvider,
      defaultImplementationProvider,
      defaultImageProvider,
      liveReady: missingLiveConfiguration.length === 0,
      missingLiveConfiguration,
      executionProviders,
      imageProviders,
      assetProviders,
      fixtureBrief: process.env.FULCRUM_FIXTURE_BRIEF,
      ...(Number.isFinite(configuredBudget) && configuredBudget > 0
        ? { m0BudgetUsd: configuredBudget }
        : {}),
    });
  }

  async create(input: CreateProjectInput): Promise<ProjectSnapshot> {
    const parsed = CreateProjectInputSchema.parse(input);
    if (parsed.mode === "live") {
      const configuration = this.configuration();
      const assetReadiness = configuration.assetProviders.find(
        ({ provider }) => provider === parsed.assetProvider,
      );
      const orchestratorReadiness = configuration.executionProviders.find(
        ({ provider }) => provider === parsed.orchestratorProvider,
      );
      const imageReadiness = configuration.imageProviders.find(
        ({ provider }) => provider === parsed.imageProvider,
      );
      const missing = [
        ...(assetReadiness?.missingConfiguration ?? ["unknown 3D provider"]),
        ...(imageReadiness?.missingConfiguration ?? ["unknown image provider"]),
        ...(orchestratorReadiness?.ready
          ? []
          : [orchestratorReadiness?.detail ?? "unknown orchestrator provider"]),
      ];
      if (missing.length > 0) {
        throw new Error(`Live mode is not configured: ${missing.join(", ")}.`);
      }
      if (
        !configuration.m0BudgetUsd ||
        parsed.budgetUsd > configuration.m0BudgetUsd
      ) {
        throw new Error(
          `Live M0 budget must be positive and no greater than the configured $${configuration.m0BudgetUsd?.toFixed(2) ?? "0.00"} cap.`,
        );
      }
    }
    const projectId = randomUUID();
    const runId = randomUUID();
    const createdAt = now();
    this.repository.reserveProject(projectId, createdAt);
    const brief = this.repository.writeRevision({
      projectId,
      entityId: `${projectId}:brief`,
      kind: "game-brief",
      value: { text: parsed.brief, rightsConfirmed: parsed.rightsConfirmed },
      runId,
    });
    this.repository.createProject({
      schemaVersion: 1,
      milestone: "m0",
      projectId,
      name: "The Last Reliquary",
      mode: parsed.mode,
      assetProvider: parsed.assetProvider,
      orchestratorProvider: parsed.orchestratorProvider,
      implementationProvider: parsed.implementationProvider,
      imageProvider: parsed.imageProvider,
      status: "active",
      stage: "creative-development",
      runId,
      budgetUsd: parsed.budgetUsd,
      spentUsd: 0,
      conceptReplacementCount: 0,
      brief,
      createdAt,
      updatedAt: createdAt,
    });
    this.repository.appendEvent({
      projectId,
      runId,
      type: "project.created",
      payload: {
        mode: parsed.mode,
        assetProvider: parsed.assetProvider,
        orchestratorProvider: parsed.orchestratorProvider,
        implementationProvider: parsed.implementationProvider,
        imageProvider: parsed.imageProvider,
        budgetUsd: parsed.budgetUsd,
        rightsConfirmed: true,
      },
    });
    await this.advance(projectId);
    return this.snapshot(projectId);
  }

  async advance(projectId: string): Promise<ProjectSnapshot> {
    for (let index = 0; index < 8; index += 1) {
      const before = this.repository.getProject(projectId);
      if (["awaiting-approval", "blocked", "complete"].includes(before.status))
        break;
      const workflowRunId = randomUUID();
      this.repository.saveProject({ ...before, workflowRunId });
      const run = await this.phaseWorkflow.createRun({
        runId: workflowRunId,
        resourceId: projectId,
      });
      const result = await run.start({ inputData: { projectId } });
      if (result.status === "failed") {
        const message =
          result.error instanceof Error
            ? result.error.message
            : String(result.error ?? "Unknown workflow failure");
        this.block(projectId, "workflow-phase-failed", message, true);
        break;
      }
      const after = this.repository.getProject(projectId);
      if (after.stage === before.stage && after.status === before.status) break;
    }
    return this.snapshot(projectId);
  }

  async approveDirection(
    projectId: string,
    input: ApprovalInput,
  ): Promise<ProjectSnapshot> {
    const parsed = ApprovalInputSchema.parse(input);
    const state = this.repository.getProject(projectId);
    if (
      state.stage !== "visual-direction-approval" ||
      !state.concept ||
      !state.visualBible
    ) {
      throw new Error(
        "This project is not awaiting visual-direction approval.",
      );
    }
    const decision = this.repository.recordApproval({
      approvalId: randomUUID(),
      projectId,
      targetType: "visual-direction",
      targetRevisionId: state.concept.revisionId,
      targetSha256: state.concept.artifact.sha256,
      decision: parsed.decision,
      ...(parsed.notes ? { notes: parsed.notes } : {}),
      decidedBy: "local-creative-director",
      decidedAt: now(),
    });
    this.repository.appendEvent({
      projectId,
      runId: state.runId,
      type: "approval.visual-direction-decided",
      payload: {
        decision: decision.decision,
        targetRevisionId: decision.targetRevisionId,
      },
    });
    if (
      decision.decision === "changes-requested" &&
      state.conceptReplacementCount < 1
    ) {
      const {
        concept: _concept,
        directionApproval: _priorApproval,
        ...base
      } = state;
      this.repository.saveProject({
        ...base,
        directionApproval: decision,
        conceptReplacementCount: state.conceptReplacementCount + 1,
        status: "active",
        stage: "creative-development",
      });
      await this.advance(projectId);
      return this.snapshot(projectId);
    }
    if (decision.decision !== "approved") {
      this.repository.saveProject({
        ...state,
        directionApproval: decision,
        status: "blocked",
        stage: "blocked",
        blockedReason: {
          code: "visual-direction-not-approved",
          message:
            "The visual direction was not approved. Concept replacement is the next bounded recovery slice.",
          recoverable: true,
        },
      });
      return this.snapshot(projectId);
    }
    this.repository.saveProject({
      ...state,
      directionApproval: decision,
      status: "active",
      stage: "asset-production",
    });
    await this.advance(projectId);
    return this.snapshot(projectId);
  }

  approveSlice(projectId: string, input: ApprovalInput): ProjectSnapshot {
    const parsed = ApprovalInputSchema.parse(input);
    const state = this.repository.getProject(projectId);
    if (state.stage !== "visual-slice-approval" || !state.scene) {
      throw new Error("This project is not awaiting visual-slice approval.");
    }
    const decision = this.repository.recordApproval({
      approvalId: randomUUID(),
      projectId,
      targetType: "visual-slice",
      targetRevisionId: state.scene.revisionId,
      targetSha256: state.scene.artifact.sha256,
      decision: parsed.decision,
      ...(parsed.notes ? { notes: parsed.notes } : {}),
      decidedBy: "local-creative-director",
      decidedAt: now(),
    });
    this.repository.saveProject({
      ...state,
      sliceApproval: decision,
      status: "complete",
      stage: "complete",
    });
    this.repository.appendEvent({
      projectId,
      runId: state.runId,
      type: "approval.visual-slice-decided",
      payload: {
        decision: decision.decision,
        targetRevisionId: decision.targetRevisionId,
      },
    });
    return this.snapshot(projectId);
  }

  storeReviewImage(projectId: string, dataUrl: string): ProjectSnapshot {
    const state = this.repository.getProject(projectId);
    if (!state.scene)
      throw new Error(
        "A scene must exist before a review image can be stored.",
      );
    const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!match?.[1])
      throw new Error("Review image must be a base64 PNG data URL.");
    const bytes = Buffer.from(match[1], "base64");
    if (bytes.byteLength < 100)
      throw new Error("Review image is unexpectedly small.");
    const reviewImage = this.repository.putArtifact(
      projectId,
      bytes,
      "image/png",
    );
    this.repository.saveProject({ ...state, reviewImage });
    this.repository.appendEvent({
      projectId,
      runId: state.runId,
      type: "scene.review-image-stored",
      payload: {
        artifactId: reviewImage.artifactId,
        sceneRevisionId: state.scene.revisionId,
      },
    });
    return this.snapshot(projectId);
  }

  snapshot(projectId: string): ProjectSnapshot {
    const state = this.repository.getProject(projectId);
    const brief = this.repository.resolveRevision<{ text: string }>(
      state.brief,
    );
    return ProjectSnapshotSchema.parse({
      state,
      briefText: brief.text,
      ...(state.gameDesign
        ? { gameDesign: this.repository.resolveRevision(state.gameDesign) }
        : {}),
      ...(state.visualBible
        ? { visualBible: this.repository.resolveRevision(state.visualBible) }
        : {}),
      ...(state.concept
        ? { concept: this.repository.resolveRevision(state.concept) }
        : {}),
      ...(state.asset
        ? { asset: this.repository.resolveRevision(state.asset) }
        : {}),
      ...(state.assetEvaluation
        ? {
            assetEvaluation: this.repository.resolveRevision(
              state.assetEvaluation,
            ),
          }
        : {}),
      ...(state.scene
        ? { scene: this.repository.resolveRevision(state.scene) }
        : {}),
    });
  }

  list(): ProjectSnapshot[] {
    return this.repository
      .listProjects()
      .map((project) => this.snapshot(project.projectId));
  }

  private async advanceOne(projectId: string): Promise<ProjectState> {
    const state = this.repository.getProject(projectId);
    if (state.stage === "creative-development") {
      const brief = this.repository.resolveRevision<{ text: string }>(
        state.brief,
      );
      const creative =
        state.gameDesign && state.visualBible
          ? { gameDesign: state.gameDesign, visualBible: state.visualBible }
          : await this.creative.develop({
              projectId,
              runId: state.runId,
              brief: brief.text,
              mode: state.mode,
              orchestratorProvider: state.orchestratorProvider,
            });
      const concept = await this.concepts.ensure({
        projectId,
        runId: state.runId,
        mode: state.mode,
        imageProvider: state.imageProvider,
        gameDesign: creative.gameDesign,
        visualBible: creative.visualBible,
        attempt: state.conceptReplacementCount,
      });
      if (concept.status === "failed")
        return this.block(
          projectId,
          concept.error.code,
          concept.error.message,
          concept.error.recoverable,
        );
      const latest = this.repository.getProject(projectId);
      if (concept.status === "pending")
        return this.repository.saveProject({ ...latest, ...creative });
      return this.repository.saveProject({
        ...latest,
        ...creative,
        concept: concept.value,
        status: "awaiting-approval",
        stage: "visual-direction-approval",
      });
    }
    if (state.stage === "asset-production") {
      if (!state.concept)
        return this.block(
          projectId,
          "missing-concept",
          "Asset production has no approved concept.",
          false,
        );
      const outcome = await this.assets.ensure({
        projectId,
        runId: state.runId,
        mode: state.mode,
        assetProvider: state.assetProvider,
        concept: state.concept,
      });
      if (outcome.status === "failed")
        return this.block(
          projectId,
          outcome.error.code,
          outcome.error.message,
          outcome.error.recoverable,
        );
      if (outcome.status === "pending") {
        this.repository.appendEvent({
          projectId,
          runId: state.runId,
          type: "asset.pending",
          payload: {
            requestId: outcome.requestId,
            resumeAfter: outcome.resumeAfter,
          },
        });
        return this.repository.getProject(projectId);
      }
      const latest = this.repository.getProject(projectId);
      return this.repository.saveProject({
        ...latest,
        asset: outcome.value,
        stage: "asset-quality",
      });
    }
    if (state.stage === "asset-quality") {
      if (!state.asset)
        return this.block(
          projectId,
          "missing-asset",
          "Asset quality has no GLB revision.",
          false,
        );
      const result = await this.quality.evaluate({
        projectId,
        runId: state.runId,
        asset: state.asset,
      });
      if (!result.evaluation.passed) {
        return this.repository.saveProject({
          ...state,
          assetEvaluation: result.revision,
          status: "blocked",
          stage: "blocked",
          blockedReason: {
            code: "asset-quality-failed",
            message: "The generated GLB failed deterministic M0 gates.",
            recoverable: true,
          },
        });
      }
      return this.repository.saveProject({
        ...state,
        assetEvaluation: result.revision,
        stage: "scene-composition",
      });
    }
    if (state.stage === "scene-composition") {
      if (!state.asset || !state.visualBible)
        return this.block(
          projectId,
          "missing-scene-input",
          "Scene composition is missing its asset or visual bible.",
          false,
        );
      const scene = this.scenes.compose({
        projectId,
        runId: state.runId,
        asset: state.asset,
        visualBible: state.visualBible,
      });
      return this.repository.saveProject({
        ...state,
        scene: scene.revision,
        status: "awaiting-approval",
        stage: "visual-slice-approval",
      });
    }
    return state;
  }

  private block(
    projectId: string,
    code: string,
    message: string,
    recoverable: boolean,
  ): ProjectState {
    const state = this.repository.getProject(projectId);
    return this.repository.saveProject({
      ...state,
      status: "blocked",
      stage: "blocked",
      blockedReason: { code, message, recoverable },
    });
  }
}
