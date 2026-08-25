import {
  RegenerationStrategySchema,
  type AssetClassification,
  type AssetPolicy,
  type AssetQualityVector,
  type EvaluationFinding,
  type RegenerationAttempt,
  type RegenerationStrategy,
} from "@fulcrum/domain";

export type QualityVectorComparison =
  "candidate-dominates" | "incumbent-dominates" | "equal" | "incomparable";

const semanticRank: Record<AssetQualityVector["semanticVerdict"], number> = {
  pass: 0,
  revise: 1,
  "not-run": 2,
};

const qualityDimensions = (quality: AssetQualityVector): number[] => [
  quality.hardGateFailures,
  quality.criticalFindings,
  quality.majorFindings,
  quality.minorFindings,
  semanticRank[quality.semanticVerdict],
];

export const compareQualityVectors = (
  incumbent: AssetQualityVector,
  candidate: AssetQualityVector,
): QualityVectorComparison => {
  const incumbentDimensions = qualityDimensions(incumbent);
  const candidateDimensions = qualityDimensions(candidate);
  const candidateNoWorse = candidateDimensions.every(
    (value, index) => value <= incumbentDimensions[index]!,
  );
  const candidateBetter = candidateDimensions.some(
    (value, index) => value < incumbentDimensions[index]!,
  );
  const incumbentNoWorse = incumbentDimensions.every(
    (value, index) => value <= candidateDimensions[index]!,
  );
  const incumbentBetter = incumbentDimensions.some(
    (value, index) => value < candidateDimensions[index]!,
  );
  if (candidateNoWorse && candidateBetter) return "candidate-dominates";
  if (incumbentNoWorse && incumbentBetter) return "incumbent-dominates";
  if (!candidateBetter && !incumbentBetter) return "equal";
  return "incomparable";
};

export const bestRegenerationAttempt = (
  attempts: readonly RegenerationAttempt[],
): RegenerationAttempt => {
  const first = attempts[0];
  if (!first) throw new Error("Best selection requires at least one attempt.");
  return attempts.slice(1).reduce((best, candidate) => {
    return compareQualityVectors(
      best.qualityVector,
      candidate.qualityVector,
    ) === "candidate-dominates"
      ? candidate
      : best;
  }, first);
};

export type DecideRegenerationInput = {
  assetId: string;
  currentAttempt: RegenerationAttempt;
  attemptHistory: RegenerationAttempt[];
  currentFindings: EvaluationFinding[];
  failedGateIds: string[];
  priorStrategies: RegenerationStrategy[];
  policy: AssetPolicy;
  providerSupportsMultiview: boolean;
  providerSupportsPromptChanges: boolean;
  permissibleClassifications: AssetClassification[];
  failureCode?: string;
};

const fallbackPrompt: Record<string, string> = {
  "concept-fidelity":
    "Restore the required concept features and remove unsupported visual changes.",
  "material-separation":
    "Separate the material regions with clearer boundaries and value contrast.",
  style: "Match the approved shape language and rendering style more closely.",
};

const findingCriterion = (finding: EvaluationFinding): string =>
  finding.findingCode.replace(/^semantic\./, "");

export const decideRegeneration = (
  input: DecideRegenerationInput,
): RegenerationStrategy => {
  const attempts = [...input.attemptHistory, input.currentAttempt].sort(
    (left, right) => left.attemptNumber - right.attemptNumber,
  );
  const best = bestRegenerationAttempt(attempts);
  const currentQuality = input.currentAttempt.qualityVector;
  const fullyPassed =
    currentQuality.hardGateFailures === 0 &&
    currentQuality.criticalFindings === 0 &&
    currentQuality.semanticVerdict === "pass";
  if (fullyPassed)
    return RegenerationStrategySchema.parse({
      kind: "accept-best",
      rationale: "Deterministic and semantic quality checks passed.",
      reasonFindingIds: [],
      assetRevisionId: best.asset.revisionId,
    });

  const atAttemptCap =
    input.currentAttempt.attemptNumber + 1 >=
      input.policy.regeneration.maxAttempts ||
    attempts.length >= input.policy.regeneration.maxAttempts;
  if (atAttemptCap) {
    const viable =
      best.qualityVector.hardGateFailures === 0 &&
      best.qualityVector.criticalFindings === 0 &&
      best.qualityVector.semanticVerdict === "pass";
    return viable
      ? RegenerationStrategySchema.parse({
          kind: "accept-best",
          rationale:
            "The attempt cap was reached; retain the viable Pareto-best revision.",
          reasonFindingIds: input.currentFindings.map(
            (finding) => finding.findingId,
          ),
          assetRevisionId: best.asset.revisionId,
        })
      : RegenerationStrategySchema.parse({
          kind: "give-up-user",
          rationale:
            "The attempt cap was reached without a revision that passes all required quality checks.",
          reasonFindingIds: input.currentFindings.map(
            (finding) => finding.findingId,
          ),
          message:
            "Every attempted asset has a hard gate failure, critical finding, or rejected semantic verdict. User direction is required.",
        });
  }

  const priorKinds = input.priorStrategies.map((strategy) => strategy.kind);
  const viewFinding = input.currentFindings.find((finding) => {
    const criterion = findingCriterion(finding);
    return (
      finding.severity === "major" &&
      (criterion === "silhouette-readability" ||
        criterion === "view-consistency")
    );
  });
  if (
    input.policy.classification === "hero" &&
    viewFinding &&
    input.providerSupportsMultiview &&
    input.policy.regeneration.allowedStrategies.includes("change-views") &&
    !priorKinds.includes("change-views")
  )
    return RegenerationStrategySchema.parse({
      kind: "change-views",
      rationale:
        "Direct rear and side concept evidence is needed before another asset attempt.",
      reasonFindingIds: [viewFinding.findingId],
      operation: "add",
      roles: ["back", "left", "right"],
      brief:
        viewFinding.suggestedAction ??
        "Define the rear silhouette and both side transitions without changing the approved front identity.",
    });

  const promptFindings = input.currentFindings
    .filter((finding) => {
      const criterion = findingCriterion(finding);
      return (
        criterion === "concept-fidelity" ||
        criterion === "material-separation" ||
        finding.category === "style"
      );
    })
    .slice(0, 3);
  if (
    promptFindings.length > 0 &&
    input.providerSupportsPromptChanges &&
    input.policy.regeneration.allowedStrategies.includes("change-prompt")
  )
    return RegenerationStrategySchema.parse({
      kind: "change-prompt",
      rationale:
        "The semantic findings can be translated into bounded prompt changes.",
      reasonFindingIds: promptFindings.map((finding) => finding.findingId),
      changes: promptFindings.map((finding) => {
        const criterion = findingCriterion(finding);
        return {
          findingId: finding.findingId,
          addToPrompt:
            finding.suggestedAction ??
            fallbackPrompt[criterion] ??
            fallbackPrompt.style,
        };
      }),
    });

  const classificationFinding = input.currentFindings.find(
    (finding) => findingCriterion(finding) === "classification-fit",
  );
  const reclassificationTarget =
    input.policy.classification === "hero" &&
    input.permissibleClassifications.includes("kit")
      ? "kit"
      : input.policy.classification === "kit" &&
          input.permissibleClassifications.includes("hero")
        ? "hero"
        : undefined;
  if (
    classificationFinding &&
    reclassificationTarget &&
    input.policy.regeneration.allowedStrategies.includes("reclassify")
  )
    return RegenerationStrategySchema.parse({
      kind: "reclassify",
      rationale: classificationFinding.summary,
      reasonFindingIds: [classificationFinding.findingId],
      from: input.policy.classification,
      to: reclassificationTarget,
    });

  const retryableFailure =
    (input.failedGateIds.length === 1 &&
      ["texture-claims", "texture-embedded"].includes(
        input.failedGateIds[0]!,
      )) ||
    input.failureCode === "provider-output-missing";
  const sameStrategyRetries = priorKinds.filter(
    (kind) => kind === "retry-same",
  ).length;
  if (
    retryableFailure &&
    sameStrategyRetries < input.policy.regeneration.maxSameStrategyRetries &&
    input.policy.regeneration.allowedStrategies.includes("retry-same")
  )
    return RegenerationStrategySchema.parse({
      kind: "retry-same",
      rationale:
        "The failure is isolated and may clear with one identical provider retry.",
      reasonFindingIds: input.currentFindings.map(
        (finding) => finding.findingId,
      ),
    });

  return RegenerationStrategySchema.parse({
    kind: "give-up-user",
    rationale: "No allowed automatic strategy addresses the remaining failure.",
    reasonFindingIds: input.currentFindings.map((finding) => finding.findingId),
    bestAssetRevisionId:
      best.qualityVector.hardGateFailures === 0
        ? best.asset.revisionId
        : undefined,
    message:
      "Fulcrum cannot choose another safe automatic regeneration strategy. User direction is required.",
  });
};
