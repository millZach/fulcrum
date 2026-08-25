import type {
  AssetBatchEntry,
  DeterministicAssetReport,
  EvaluationFinding,
  NormalizedCrop,
  QualityGate,
  RegenerationDecisionReport,
  SemanticAssetReport,
  TurntableManifest,
} from "@fulcrum/domain";

export type QualityEvent = {
  eventId: string;
  runId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type QualityReports = {
  deterministicReports: DeterministicAssetReport[];
  turntables: TurntableManifest[];
  semanticReports: SemanticAssetReport[];
  decisions: Array<{
    revisionId: string;
    report: RegenerationDecisionReport;
  }>;
};

export type QualityEvidenceView = {
  assetId: string;
  classification: AssetBatchEntry["classification"];
  validated: boolean;
  attemptCount: number;
  revisions: Array<{
    revisionId: string;
    best: boolean;
    latest: boolean;
  }>;
  gateGroups: Array<{
    category: QualityGate["category"];
    passedCount: number;
    failedCount: number;
    gates: QualityGate[];
  }>;
  findingGroups: Array<{
    source: "deterministic" | "semantic";
    findings: EvaluationFinding[];
  }>;
  frames: Array<{
    frameIndex: number;
    yawDegrees: number;
    artifactId: string;
    uri: string;
    overlays: Array<{
      findingId: string;
      summary: string;
      severity: EvaluationFinding["severity"];
      crop: NormalizedCrop;
    }>;
  }>;
  timeline: Array<{
    eventId: string;
    createdAt: string;
    attemptNumber: number;
    strategyKind: RegenerationDecisionReport["strategy"]["kind"];
    rationale: string;
    roles?: string[];
  }>;
};

const gateCategoryOrder: QualityGate["category"][] = [
  "mesh",
  "material",
  "texture",
  "topology",
];

export const qualityView = (
  selection: AssetBatchEntry,
  reports: QualityReports,
  events: QualityEvent[],
): QualityEvidenceView => {
  const bestRevisionId = selection.best.revisionId;
  const latestRevisionId = selection.current.revisionId;
  const deterministic = reports.deterministicReports.find(
    ({ assetRevisionId }) => assetRevisionId === bestRevisionId,
  );
  const semantic = reports.semanticReports.find(
    ({ assetRevisionId }) => assetRevisionId === bestRevisionId,
  );
  const turntable = reports.turntables.find(
    ({ assetRevisionId }) => assetRevisionId === bestRevisionId,
  );

  const gates = deterministic?.gates ?? [];
  const gateGroups = gateCategoryOrder.flatMap((category) => {
    const grouped = gates.filter((gate) => gate.category === category);
    return grouped.length === 0
      ? []
      : [
          {
            category,
            passedCount: grouped.filter(({ passed }) => passed).length,
            failedCount: grouped.filter(({ passed }) => !passed).length,
            gates: grouped,
          },
        ];
  });

  const findingGroups: QualityEvidenceView["findingGroups"] = [];
  if (deterministic?.findings.length)
    findingGroups.push({
      source: "deterministic",
      findings: deterministic.findings,
    });
  if (semantic?.findings.length)
    findingGroups.push({ source: "semantic", findings: semantic.findings });

  const frames = (turntable?.frames ?? []).map((frame) => ({
    frameIndex: frame.frameIndex,
    yawDegrees: frame.yawDegrees,
    artifactId: frame.artifact.artifactId,
    uri: frame.artifact.uri,
    overlays: (semantic?.findings ?? []).flatMap((finding) =>
      finding.evidence.flatMap((evidence) =>
        evidence.kind === "turntable-frame" &&
        evidence.artifactId === frame.artifact.artifactId &&
        evidence.frameIndex === frame.frameIndex &&
        evidence.crop
          ? [
              {
                findingId: finding.findingId,
                summary: finding.summary,
                severity: finding.severity,
                crop: evidence.crop,
              },
            ]
          : [],
      ),
    ),
  }));

  const decisions = new Map(
    reports.decisions.map(({ revisionId, report }) => [revisionId, report]),
  );
  const timeline = events.flatMap((event) => {
    if (
      event.type !== "asset.regeneration-strategy-selected" ||
      event.payload.assetId !== selection.assetId ||
      typeof event.payload.decisionRevisionId !== "string" ||
      typeof event.payload.attemptNumber !== "number"
    )
      return [];
    const decision = decisions.get(event.payload.decisionRevisionId);
    if (!decision) return [];
    return [
      {
        eventId: event.eventId,
        createdAt: event.createdAt,
        attemptNumber: event.payload.attemptNumber,
        strategyKind: decision.strategy.kind,
        rationale: decision.strategy.rationale,
        ...(decision.strategy.kind === "change-views"
          ? { roles: [...decision.strategy.roles] }
          : {}),
      },
    ];
  });

  return {
    assetId: selection.assetId,
    classification: selection.classification,
    validated: selection.validated,
    attemptCount: selection.attemptCount,
    revisions:
      bestRevisionId === latestRevisionId
        ? [{ revisionId: bestRevisionId, best: true, latest: true }]
        : [
            { revisionId: bestRevisionId, best: true, latest: false },
            { revisionId: latestRevisionId, best: false, latest: true },
          ],
    gateGroups,
    findingGroups,
    frames,
    timeline,
  };
};
