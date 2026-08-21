import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  ConceptSetSchema,
  ConceptPlanSchema,
  GameDesignSpecSchema,
  InterrogationStateSchema,
  M1ConceptDocumentSchema,
  StructuredVisualBibleSchema,
  VisualDirectionSetSchema,
  type ConceptSet,
  type ConceptPlan,
  type GameDesignSpec,
  type InformationOrigin,
  type InterrogationAnswer,
  type InterrogationQuestion,
  type InterrogationState,
  type M1ConceptDocument,
  type RevisionRef,
  type StructuredVisualBible,
  type VisualDirection,
  type VisualDirectionSet,
  type VisualToken,
} from "@fulcrum/domain";
import { ProjectRepository } from "@fulcrum/project";
import sharp from "sharp";

export type { ConceptPlan } from "@fulcrum/domain";

const SKILL_NAMES = ["grill-with-docs", "grilling", "domain-modeling"] as const;

type SkillName = (typeof SKILL_NAMES)[number];

export type M1CreativeContext = {
  projectId: string;
  runId: string;
};

export type SkillProvisioningRecord = {
  status: "ready";
  entrypoint: "grill-with-docs";
  capabilities: Array<{
    name: SkillName;
    version: 1;
    sha256: string;
  }>;
};

export type ProjectGlossary = {
  sourceInterrogationRevisionId: string;
  terms: Array<{ term: string; meaning: string }>;
};

export type ArchitectureDecisionRecord = {
  title: string;
  status: "accepted";
  context: string;
  decision: string;
  consequences: string[];
  sourceInterrogationRevisionId: string;
};

export type SharedUnderstandingArtifacts = {
  interrogation: RevisionRef;
  gameDesignSpec: RevisionRef;
  glossary: RevisionRef;
  adr?: RevisionRef;
};

export type FocusedDirectionChange = {
  sourceDirectionRevisionId: string;
  resultDirectionRevisionId: string;
  change: string;
  pinnedAspects: Array<{
    name: string;
    before: string;
    after: string;
  }>;
};

const stableId = (prefix: string, value: string): string =>
  `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;

const now = (): string => new Date().toISOString();

const normalize = (value: string): string => value.trim().toLowerCase();

const sentence = (value: string): string => {
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (!cleaned) return cleaned;
  return /[.!?]$/.test(cleaned) ? cleaned : `${cleaned}.`;
};

const writeRevision = <T>(
  repository: ProjectRepository,
  context: M1CreativeContext,
  entity: string,
  kind: string,
  value: T,
): RevisionRef =>
  repository.writeRevision({
    projectId: context.projectId,
    entityId: `${context.projectId}:${entity}`,
    kind,
    value,
    runId: context.runId,
  });

type DecisionNode = {
  branchId: string;
  dependencies: string[];
  prompt: string;
  recommendation: string;
  applies?: (brief: string, answerText: string) => boolean;
};

const DESIGN_TREE: DecisionNode[] = [
  {
    branchId: "experience.player-promise",
    dependencies: [],
    prompt:
      "What should the player be able to say they accomplished at the end of one successful session?",
    recommendation:
      "Name one observable accomplishment that expresses the brief's central fantasy.",
  },
  {
    branchId: "gameplay.core-loop",
    dependencies: [],
    prompt:
      "Which repeatable actions form the smallest satisfying playable loop?",
    recommendation:
      "Choose three to five player actions with a clear objective and failure pressure.",
  },
  {
    branchId: "scope.proof-boundary",
    dependencies: [],
    prompt:
      "What is the smallest slice that proves this idea without implying a full game?",
    recommendation:
      "Limit the slice to one player role, one environment, and one complete encounter or session.",
  },
  {
    branchId: "presentation.camera-readability",
    dependencies: ["gameplay.core-loop"],
    prompt:
      "Which camera and readability rule best support the agreed player actions?",
    recommendation:
      "Use the least complex camera that keeps the objective, threats, and traversal choices readable.",
  },
  {
    branchId: "gameplay.success-failure",
    dependencies: ["experience.player-promise", "gameplay.core-loop"],
    prompt:
      "What ends the slice in success, and what pressure can cause failure?",
    recommendation:
      "Define one visible success condition and one recoverable source of failure pressure.",
  },
  {
    branchId: "scope.consequential-tradeoff",
    dependencies: ["scope.proof-boundary"],
    prompt:
      "Which tension should the design resolve deliberately instead of averaging both sides?",
    recommendation:
      "Prefer moment-to-moment readability over decorative density when the two conflict.",
  },
  {
    branchId: "scope.adr-qualification",
    dependencies: ["scope.consequential-tradeoff"],
    prompt:
      "Is this tradeoff both hard to reverse and surprising without its context? Explain both, or answer no.",
    recommendation:
      "Confirm only when reversal would be materially costly and a future contributor would not understand the choice without its tradeoff context.",
  },
  {
    branchId: "scope.constraint-resolution",
    dependencies: [
      "scope.consequential-tradeoff",
      "presentation.camera-readability",
    ],
    prompt:
      "How should the chosen tradeoff behave when the project's strongest constraint is under pressure?",
    recommendation:
      "Write one priority rule that can decide the conflict consistently during production.",
    applies: (brief, answerText) =>
      /\b(must|cannot|constraint|strict|limited|require|tension|but)\b/i.test(
        `${brief} ${answerText}`,
      ),
  },
];

const recomputeFrontier = (
  brief: string,
  rounds: InterrogationState["rounds"],
): InterrogationQuestion[] => {
  const asked = new Set(
    rounds.flatMap((round) =>
      round.questions.map((question) => question.branchId),
    ),
  );
  const resolved = new Set(
    rounds.flatMap((round) => {
      const answered = new Set(
        round.answers.map((answer) => answer.questionId),
      );
      return round.questions
        .filter((question) => answered.has(question.questionId))
        .map((question) => question.branchId);
    }),
  );
  const answerText = rounds
    .flatMap((round) => round.answers.map((answer) => answer.value))
    .join(" ");
  return DESIGN_TREE.filter(
    (node) =>
      !asked.has(node.branchId) &&
      node.dependencies.every((dependency) => resolved.has(dependency)) &&
      (node.applies?.(brief, answerText) ?? true),
  ).map((node) => {
    const dependencyAnswers = rounds
      .flatMap((round) =>
        round.questions.map((question) => ({ question, round })),
      )
      .filter(({ question }) => node.dependencies.includes(question.branchId))
      .flatMap(({ question, round }) =>
        round.answers
          .filter((answer) => answer.questionId === question.questionId)
          .map((answer) => answer.value),
      )
      .join(" | ");
    return {
      questionId: stableId(
        "question",
        `${brief}:${node.branchId}:${dependencyAnswers}`,
      ),
      branchId: node.branchId,
      prompt: node.prompt,
      recommendation: node.recommendation,
    };
  });
};

const getAnswers = (state: InterrogationState): InterrogationAnswer[] =>
  state.rounds.flatMap((round) => round.answers);

const answerForBranch = (
  state: InterrogationState,
  branchId: string,
): string | undefined => {
  const questionIds = new Set(
    state.rounds
      .flatMap((round) => round.questions)
      .filter((question) => question.branchId === branchId)
      .map((question) => question.questionId),
  );
  return getAnswers(state).find((answer) => questionIds.has(answer.questionId))
    ?.value;
};

const inferCamera = (brief: string, state: InterrogationState): string => {
  const combined = `${brief} ${answerForBranch(state, "presentation.camera-readability") ?? ""}`;
  const known = [
    "first-person",
    "third-person",
    "top-down",
    "isometric",
    "side-scrolling",
    "fixed camera",
  ].find((camera) => normalize(combined).includes(camera));
  return (
    known ?? "Elevated three-quarter camera with a stable gameplay horizon"
  );
};

const inferGenre = (brief: string): string => {
  const lower = normalize(brief);
  const candidates: Array<[string, string]> = [
    ["puzzle", "Puzzle adventure"],
    ["racing", "Action racing"],
    ["strategy", "Tactical strategy"],
    ["survival", "Survival adventure"],
    ["platform", "Action platformer"],
    ["extraction", "Extraction action"],
  ];
  return (
    candidates.find(([needle]) => lower.includes(needle))?.[1] ??
    "Focused action adventure"
  );
};

const titleFromBrief = (brief: string): string => {
  const subject = brief
    .replace(/^(create|build|make|design)\s+/i, "")
    .split(/[.!?]/)[0]
    ?.trim();
  if (!subject) return "Untitled Fulcrum Project";
  const words = subject.split(/\s+/).slice(0, 6);
  return words
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
};

const verbsFrom = (value: string): string[] => {
  const known = [
    "move",
    "explore",
    "fight",
    "dodge",
    "build",
    "collect",
    "solve",
    "race",
    "steer",
    "hide",
    "climb",
    "trade",
    "defend",
    "escape",
  ].filter((verb) => normalize(value).includes(verb));
  return known.length >= 2 ? known : ["move", "interact", "commit"];
};

const buildGameDesignSpec = (
  brief: string,
  state: InterrogationState,
): GameDesignSpec => {
  const playerPromise =
    answerForBranch(state, "experience.player-promise") ??
    "Complete one readable expression of the project's central fantasy.";
  const loop =
    answerForBranch(state, "gameplay.core-loop") ??
    "Explore, act, read the result, and advance toward the objective.";
  const scope =
    answerForBranch(state, "scope.proof-boundary") ??
    "One role, one environment, and one complete encounter.";
  const outcome =
    answerForBranch(state, "gameplay.success-failure") ??
    "Reach the objective before the encounter pressure closes the opportunity.";
  const tradeoff =
    answerForBranch(state, "scope.consequential-tradeoff") ??
    "Protect gameplay readability when presentation and interaction compete.";
  const constraintResolution = answerForBranch(
    state,
    "scope.constraint-resolution",
  );
  const camera = inferCamera(brief, state);
  const origin = (reference: string): InformationOrigin => ({
    source: "user",
    reference,
  });
  const sentences = loop
    .split(/[,;]|\bthen\b/i)
    .map((part) => sentence(part))
    .filter(Boolean)
    .slice(0, 5);
  return GameDesignSpecSchema.parse({
    title: titleFromBrief(brief),
    genre: inferGenre(brief),
    camera,
    coreFantasy: sentence(playerPromise),
    coreLoop:
      sentences.length > 0
        ? sentences
        : ["Enter the slice.", "Act toward its objective.", "Resolve it."],
    playerVerbs: verbsFrom(`${brief} ${loop}`),
    objective: sentence(outcome),
    sessionMinutes: normalize(brief).includes("short") ? 8 : 12,
    gameplayConstraints: [
      sentence(scope),
      sentence(camera),
      sentence(tradeoff),
      ...(constraintResolution ? [sentence(constraintResolution)] : []),
    ],
    facts: [
      {
        statementId: stableId("fact", brief),
        text: sentence(brief),
        kind: "fact",
        origin: { source: "brief", reference: "initial brief" },
      },
      {
        statementId: stableId("fact", outcome),
        text: sentence(outcome),
        kind: "fact",
        origin: origin("gameplay.success-failure"),
      },
    ],
    assumptions: [
      {
        statementId: stableId("assumption", scope),
        text: sentence(scope),
        kind: "assumption",
        origin: origin("scope.proof-boundary"),
      },
    ],
  });
};

const buildGlossary = (
  state: InterrogationState,
  sourceRevisionId: string,
): ProjectGlossary => ({
  sourceInterrogationRevisionId: sourceRevisionId,
  terms: [
    {
      term: "Player promise",
      meaning:
        answerForBranch(state, "experience.player-promise") ??
        "The accomplishment a successful session delivers.",
    },
    {
      term: "Playable slice",
      meaning:
        answerForBranch(state, "scope.proof-boundary") ??
        "The smallest complete proof of the game idea.",
    },
    {
      term: "Success condition",
      meaning:
        answerForBranch(state, "gameplay.success-failure") ??
        "The observable event that completes the slice.",
    },
  ],
});

const buildAdr = (
  state: InterrogationState,
  sourceRevisionId: string,
): ArchitectureDecisionRecord | undefined => {
  const decision = answerForBranch(state, "scope.consequential-tradeoff");
  const qualification = answerForBranch(state, "scope.adr-qualification");
  if (!decision || !qualification || !qualifiesForAdr(decision, qualification))
    return undefined;
  return {
    title: "Resolve the slice's primary design tension",
    status: "accepted",
    context: `The interview identified a consequential tradeoff that affects both gameplay readability and visual direction. Qualification: ${sentence(qualification)}`,
    decision: sentence(decision),
    consequences: [
      "Downstream directions must express the chosen side of the tradeoff.",
      "A later reversal creates a descendant revision rather than rewriting this decision.",
    ],
    sourceInterrogationRevisionId: sourceRevisionId,
  };
};

const qualifiesForAdr = (decision: string, qualification: string): boolean => {
  const expressesTradeoff =
    /\b(over|instead|versus|vs\.?|sacrifice|prioriti[sz]e|prefer|at the cost of|even if|when .* conflict|must win|takes precedence|always wins)\b/i.test(
      decision,
    );
  const hasDurableConsequence =
    /\b(camera|control|combat|multiplayer|network|platform|production|readab|route|scope|session|simulation|visual|weather|world)\w*/i.test(
      decision,
    );
  const explicitlyAffirmed = /\b(yes|confirmed|both)\b/i.test(qualification);
  const hardToReverse =
    /\b(hard|costly|expensive|difficult|impractical|impossible)\s+to\s+(reverse|change|undo)\b|\birreversible\b/i.test(
      qualification,
    );
  const surprisingWithoutContext =
    /\b(surpris\w*|unexpected|non-obvious|not obvious)\b.*\bcontext\b|\bwithout\b.*\bcontext\b/i.test(
      qualification,
    );
  return (
    decision.trim().length >= 40 &&
    expressesTradeoff &&
    hasDurableConsequence &&
    explicitlyAffirmed &&
    hardToReverse &&
    surprisingWithoutContext
  );
};

type DirectionTemplate = {
  slug: string;
  name: string;
  rationale: string;
  overallStyle: string;
  shapeLanguage: string;
  materials: string[];
  palette: StructuredVisualBible["palette"];
  lighting: string;
  atmosphere: string;
  textureLanguage: string;
};

const DIRECTION_TEMPLATES: DirectionTemplate[] = [
  {
    slug: "luminous-folkcraft",
    name: "Luminous Folkcraft",
    rationale:
      "Friendly carved forms and luminous gameplay accents make the objective immediately legible.",
    overallStyle:
      "Painterly folkcraft with hand-carved forms and restrained detail",
    shapeLanguage:
      "Rounded stacked masses cut by one clear directional gesture",
    materials: [
      "painted timber",
      "matte stone",
      "woven fiber",
      "soft emission",
    ],
    palette: [
      { name: "Deep pine", hex: "#173B36", role: "primary mass" },
      { name: "Clay", hex: "#B76647", role: "warm accent" },
      { name: "Lantern", hex: "#F6D36B", role: "gameplay focus" },
    ],
    lighting: "Soft overcast fill with a warm objective glow",
    atmosphere: "Quiet drifting pollen and shallow teal haze",
    textureLanguage:
      "Broad brush planes, visible carved edges, sparse markings",
  },
  {
    slug: "monumental-ink",
    name: "Monumental Ink",
    rationale:
      "Severe graphic silhouettes turn every important choice into a high-contrast landmark.",
    overallStyle: "Graphic ink-wash fantasy with monumental negative space",
    shapeLanguage:
      "Tall wedges, hard diagonals, and compressed supporting forms",
    materials: [
      "blackened stone",
      "brushed iron",
      "chalk mineral",
      "sharp emission",
    ],
    palette: [
      { name: "Ink", hex: "#11131A", role: "primary mass" },
      { name: "Parchment", hex: "#D8D0B8", role: "edge separation" },
      { name: "Signal red", hex: "#E05A47", role: "gameplay focus" },
    ],
    lighting: "Hard raking key with deep graphic shadows",
    atmosphere: "Layered ink fog with sparse ember flecks",
    textureLanguage: "Dry-brush edges, flat value fields, no ornamental noise",
  },
  {
    slug: "weathered-storybook",
    name: "Weathered Storybook",
    rationale:
      "A grounded storybook treatment gives the world history without sacrificing navigational clarity.",
    overallStyle:
      "Weathered storybook realism with simplified production-ready surfaces",
    shapeLanguage:
      "Broad grounded bases, asymmetric arches, and compact hero silhouettes",
    materials: [
      "weathered plaster",
      "oxidized copper",
      "dark oak",
      "clouded glass",
    ],
    palette: [
      { name: "Storm blue", hex: "#33475B", role: "primary mass" },
      { name: "Verdigris", hex: "#5E9C8B", role: "world accent" },
      { name: "Beacon gold", hex: "#F0B95A", role: "gameplay focus" },
    ],
    lighting: "Low golden break through a cool storm ambience",
    atmosphere: "Wind-driven mist and subtle particulate depth",
    textureLanguage:
      "Large weathered patches with quiet hand-painted edge wear",
  },
];

const tokensFor = (template: DirectionTemplate): VisualToken[] => [
  {
    tokenId: `${template.slug}:style`,
    category: "style",
    value: template.overallStyle,
  },
  {
    tokenId: `${template.slug}:prohibited`,
    category: "prohibited-style",
    value: "photoreal noise, glossy generic sci-fi, decorative clutter",
  },
  {
    tokenId: `${template.slug}:shape`,
    category: "shape",
    value: template.shapeLanguage,
  },
  {
    tokenId: `${template.slug}:silhouette`,
    category: "silhouette",
    value: "One dominant readable mass with a single focal gesture",
  },
  ...template.palette.map((entry, index) => ({
    tokenId: `${template.slug}:palette:${index}`,
    category: (entry.role === "gameplay focus"
      ? "gameplay-color"
      : "palette") as VisualToken["category"],
    value: `${entry.name} ${entry.hex}`,
    role: entry.role,
  })),
  ...template.materials.map((material, index) => ({
    tokenId: `${template.slug}:material:${index}`,
    category: "material" as const,
    value: material,
  })),
  {
    tokenId: `${template.slug}:surface`,
    category: "surface",
    value: template.textureLanguage,
  },
  {
    tokenId: `${template.slug}:lighting`,
    category: "lighting",
    value: template.lighting,
  },
  {
    tokenId: `${template.slug}:atmosphere`,
    category: "atmosphere",
    value: template.atmosphere,
  },
  {
    tokenId: `${template.slug}:camera`,
    category: "camera",
    value: "Three-quarter presentation with an unobstructed gameplay horizon",
  },
  {
    tokenId: `${template.slug}:scale`,
    category: "scale",
    value: "Human-scale reference remains visible beside the objective",
  },
  {
    tokenId: `${template.slug}:readability`,
    category: "readability",
    value:
      "The objective color is unique and the focal silhouette survives thumbnail size",
  },
];

const bibleFor = (
  template: DirectionTemplate,
  spec: GameDesignSpec,
): StructuredVisualBible => {
  const briefFact =
    spec.facts.find(({ origin }) => origin.source === "brief")?.text ??
    spec.coreFantasy;
  return StructuredVisualBibleSchema.parse({
    title: template.name,
    overallStyle: template.overallStyle,
    shapeLanguage: template.shapeLanguage,
    architecture: `A ${spec.genre.toLowerCase()} space interpreting this approved premise without reversal: ${briefFact}`,
    heroProp: `A visual anchor for the fantasy "${spec.coreFantasy}" and objective "${spec.objective}"`,
    materials: template.materials,
    palette: template.palette,
    lighting: template.lighting,
    atmosphere: template.atmosphere,
    cameraLanguage: `${spec.camera}; keep the active objective unobstructed`,
    textureLanguage: template.textureLanguage,
    readabilityRules: [
      "Reserve the gameplay-focus color for actionable goals",
      "Preserve the dominant silhouette at thumbnail size",
      "Keep traversal edges distinct from decorative surfaces",
      ...spec.gameplayConstraints,
    ],
    prohibitedStyles: [
      "photoreal noise",
      "generic glossy science fiction",
      "decorative clutter over gameplay edges",
    ],
    tokens: [
      ...tokensFor(template),
      {
        tokenId: `${template.slug}:project-world`,
        category: "project-world",
        value: briefFact,
        role: "approved premise",
      },
      {
        tokenId: `${template.slug}:approved-gameplay-constraint`,
        category: "readability",
        value: spec.gameplayConstraints.join(" "),
        role: "approved gameplay constraint",
      },
    ],
  });
};

const contextualRationale = (
  template: DirectionTemplate,
  spec: GameDesignSpec,
): string => {
  const briefFact =
    spec.facts.find(({ origin }) => origin.source === "brief")?.text ??
    spec.coreFantasy;
  return [
    template.rationale,
    `Approved project premise: ${briefFact}`,
    `Player fantasy: ${spec.coreFantasy}`,
    `Camera and readability: ${spec.camera}.`,
    `Constraints: ${spec.gameplayConstraints.join(" ")}`,
  ].join(" ");
};

const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const previewSvg = (bible: StructuredVisualBible, seed: string): string => {
  const [base, accent, focus] = bible.palette;
  const shift = Number.parseInt(
    createHash("sha256").update(seed).digest("hex").slice(0, 2),
    16,
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="600" viewBox="0 0 960 600">
  <defs>
    <linearGradient id="sky" x2="0" y2="1"><stop stop-color="${base?.hex ?? "#18202A"}"/><stop offset="1" stop-color="#090B0F"/></linearGradient>
    <radialGradient id="glow"><stop stop-color="${focus?.hex ?? "#F3C96A"}" stop-opacity=".9"/><stop offset="1" stop-color="${focus?.hex ?? "#F3C96A"}" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="960" height="600" fill="url(#sky)"/>
  <circle cx="${460 + (shift % 80)}" cy="270" r="190" fill="url(#glow)" opacity=".35"/>
  <path d="M0 455 L150 342 L278 412 L414 268 L566 398 L744 305 L960 438 L960 600 L0 600Z" fill="${accent?.hex ?? "#657080"}" opacity=".58"/>
  <path d="M0 506 L205 431 L340 479 L540 390 L714 466 L960 414 L960 600 L0 600Z" fill="#0B0E13" opacity=".82"/>
  <path d="M390 458 L420 226 L480 172 L540 226 L570 458Z" fill="${base?.hex ?? "#20242C"}" stroke="${accent?.hex ?? "#8B7760"}" stroke-width="12"/>
  <path d="M454 250 L480 211 L506 250 L495 386 L480 420 L465 386Z" fill="${focus?.hex ?? "#F3C96A"}" stroke="#FFF3D1" stroke-width="6"/>
  <text x="48" y="68" fill="#F5F0E7" font-family="sans-serif" font-size="30" font-weight="700">${escapeXml(bible.title)}</text>
  <text x="49" y="101" fill="#D4CEC2" font-family="sans-serif" font-size="16">REPLAY DIRECTION STUDY</text>
  </svg>`;
};

const selectedDirection = (
  set: VisualDirectionSet,
  revisionId: string,
): VisualDirection => {
  const direction = set.directions.find(
    (candidate) => candidate.revisionId === revisionId,
  );
  if (!direction)
    throw new Error(`Direction revision ${revisionId} is not in this set.`);
  return direction;
};

const resolveStructuredVisualBibleRevision = (
  repository: ProjectRepository,
  revisionId: string,
): {
  revision: RevisionRef;
  bible: StructuredVisualBible;
  sourceRevisionIds: string[];
} => {
  const revision = repository.getRevision(revisionId);
  const stored = repository.resolveRevision<unknown>(revision);
  const envelope =
    typeof stored === "object" && stored !== null
      ? (stored as { value?: unknown; sourceRevisionIds?: unknown })
      : {};
  return {
    revision,
    bible: StructuredVisualBibleSchema.parse(envelope.value ?? stored),
    sourceRevisionIds: Array.isArray(envelope.sourceRevisionIds)
      ? envelope.sourceRevisionIds.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
  };
};

const PINNED_ASPECTS: Record<string, (bible: StructuredVisualBible) => string> =
  {
    "overall style": (bible) => bible.overallStyle,
    style: (bible) => bible.overallStyle,
    "shape language": (bible) => bible.shapeLanguage,
    shape: (bible) => bible.shapeLanguage,
    palette: (bible) => JSON.stringify(bible.palette),
    materials: (bible) => JSON.stringify(bible.materials),
    lighting: (bible) => bible.lighting,
    atmosphere: (bible) => bible.atmosphere,
    camera: (bible) => bible.cameraLanguage,
    readability: (bible) => JSON.stringify(bible.readabilityRules),
  };

const focusedChangeCategory = (change: string): VisualToken["category"] => {
  const value = normalize(change);
  if (/\b(style|stylized|stylised)\b/.test(value)) return "style";
  if (/\b(color|colour|palette)\b/.test(value)) return "palette";
  if (/\b(material|metal|stone|wood)\b/.test(value)) return "material";
  if (/\b(texture|surface|wear)\b/.test(value)) return "surface";
  if (/\b(shape|form|silhouette)\b/.test(value)) return "shape";
  if (/\b(light|lighting|shadow|sun)\b/.test(value)) return "lighting";
  if (/\b(atmosphere|fog|mist|weather|haze)\b/.test(value)) return "atmosphere";
  if (/\b(camera|view|lens)\b/.test(value)) return "camera";
  if (/\b(readability|readable|contrast)\b/.test(value)) return "readability";
  return "vfx";
};

const tokenCategoriesForSlot = (slotId: string): VisualToken["category"][] => {
  const shared: VisualToken["category"][] = [
    "style",
    "project-world",
    "prohibited-style",
    "palette",
    "gameplay-color",
    "lighting",
    "atmosphere",
    "camera",
    "readability",
  ];
  if (slotId.includes("environment"))
    return [...shared, "shape", "material", "surface", "scale"];
  return [
    ...shared,
    "shape",
    "silhouette",
    "material",
    "surface",
    "scale",
    "vfx",
  ];
};

const visualTokenSignature = (tokens: VisualToken[]): string =>
  tokens
    .map(
      ({ category, role, value }) =>
        `${category}\u0000${role ?? ""}\u0000${value}`,
    )
    .sort()
    .join("\u0001");

const conceptPrompt = (
  slot: ConceptPlan["slots"][number],
  spec: GameDesignSpec,
  tokens: VisualToken[],
  regenerationNote?: string,
): string =>
  [
    `Production concept for ${slot.name}.`,
    `Purpose: ${slot.purpose}.`,
    `Gameplay context: ${spec.objective}`,
    ...tokens.map(
      (token) =>
        `${token.category}${token.role ? ` (${token.role})` : ""}: ${token.value}.`,
    ),
    ...(regenerationNote
      ? [`Focused alternate request: ${sentence(regenerationNote)}`]
      : []),
    "No text, UI, logos, or unrelated project history.",
  ].join(" ");

const conceptSvg = (
  slot: ConceptPlan["slots"][number],
  tokens: VisualToken[],
  attempt: number,
): string => {
  const colors = tokens
    .filter((token) => ["palette", "gameplay-color"].includes(token.category))
    .map((token) => token.value.match(/#[0-9A-Fa-f]{6}/)?.[0])
    .filter((value): value is string => Boolean(value));
  const [base = "#23313A", accent = "#A77A55", focus = "#F0C85A"] = colors;
  const offset = attempt * 42;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="768" height="768" viewBox="0 0 768 768">
  <defs><radialGradient id="bg"><stop stop-color="${base}"/><stop offset="1" stop-color="#090B0F"/></radialGradient><filter id="blur"><feGaussianBlur stdDeviation="22"/></filter></defs>
  <rect width="768" height="768" fill="url(#bg)"/>
  <circle cx="${384 + offset}" cy="350" r="210" fill="${focus}" opacity=".2" filter="url(#blur)"/>
  <path d="M170 590 L${295 + offset} 280 L${384 + offset} 190 L${475 + offset} 280 L600 590Z" fill="${accent}" opacity=".76"/>
  <path d="M250 610 L${325 + offset} 350 L${384 + offset} 278 L${443 + offset} 350 L518 610Z" fill="#151A20" stroke="${focus}" stroke-width="10"/>
  <circle cx="${384 + offset}" cy="390" r="54" fill="${focus}" stroke="#FFF8DE" stroke-width="8"/>
  <text x="42" y="58" fill="#F6F0E8" font-family="sans-serif" font-size="26" font-weight="700">${escapeXml(slot.name)}</text>
  <text x="43" y="88" fill="#D4CEC2" font-family="sans-serif" font-size="14">REPLAY CONCEPT ${attempt + 1}</text>
  </svg>`;
};

/**
 * The complete offline M1 creative seam. The coordinator owns workflow stage,
 * approvals, safety counters, and live authorization; this module owns only
 * deterministic creative transformations and immutable persistence.
 */
export class M1CreativeDevelopment {
  constructor(private readonly repository: ProjectRepository) {}

  provisionSkillChain(context: M1CreativeContext): RevisionRef {
    const manifests = new Map<SkillName, string>();
    const capabilities = SKILL_NAMES.map((name) => {
      const path = fileURLToPath(
        new URL(`../skills/${name}/SKILL.md`, import.meta.url),
      );
      const manifest = readFileSync(path, "utf8");
      if (!manifest.includes(`name: ${name}`))
        throw new Error(`Bundled creative capability ${name} is invalid.`);
      manifests.set(name, manifest);
      return {
        name,
        version: 1 as const,
        sha256: createHash("sha256").update(manifest).digest("hex"),
      };
    });
    const grill = manifests.get("grill-with-docs");
    if (
      !grill ||
      !grill.includes("disable-model-invocation: true") ||
      !grill.includes("- grilling") ||
      !grill.includes("- domain-modeling")
    )
      throw new Error("The bundled creative interview entrypoint is missing.");
    const record: SkillProvisioningRecord = {
      status: "ready",
      entrypoint: "grill-with-docs",
      capabilities,
    };
    return writeRevision(
      this.repository,
      context,
      "creative-capabilities",
      "creative-capability-provisioning",
      record,
    );
  }

  beginInterrogation(context: M1CreativeContext & { brief: string }): {
    capabilities: RevisionRef;
    interrogation: RevisionRef;
  } {
    if (!context.brief.trim()) throw new Error("A project brief is required.");
    const capabilities = this.provisionSkillChain(context);
    const questions = recomputeFrontier(context.brief, []);
    const state = InterrogationStateSchema.parse({
      rounds: [
        {
          roundId: stableId("round", `${context.brief}:1`),
          questions,
          answers: [],
          createdAt: now(),
        },
      ],
      frontier: questions,
    });
    const interrogation = writeRevision(
      this.repository,
      context,
      "interrogation",
      "interrogation-state",
      { ...state, sourceRevisionIds: [capabilities.revisionId] },
    );
    return { capabilities, interrogation };
  }

  answerCurrentFrontier(
    context: M1CreativeContext & {
      brief: string;
      interrogation: RevisionRef;
      roundId: string;
      answers: Array<{ questionId: string; value: string }>;
    },
  ): RevisionRef {
    const state = InterrogationStateSchema.parse(
      this.repository.resolveRevision<InterrogationState>(
        context.interrogation,
      ),
    );
    if (state.sharedUnderstanding)
      throw new Error("The interrogation is already confirmed.");
    const round = state.rounds.at(-1);
    if (!round || round.roundId !== context.roundId)
      throw new Error("Answers must target the current frontier round.");
    const expected = new Set(
      state.frontier.map((question) => question.questionId),
    );
    const received = new Set(
      context.answers.map((answer) => answer.questionId),
    );
    if (
      expected.size !== received.size ||
      [...expected].some((questionId) => !received.has(questionId))
    )
      throw new Error(
        "Every question in the current frontier must be answered once.",
      );
    if (received.size !== context.answers.length)
      throw new Error("A frontier question cannot be answered more than once.");

    const answers = context.answers.map((answer) => ({
      questionId: answer.questionId,
      value: answer.value,
      origin: { source: "user" as const, reference: context.roundId },
    }));
    const completedRound = { ...round, answers, completedAt: now() };
    const priorRounds = state.rounds.slice(0, -1);
    const rounds = [...priorRounds, completedRound];
    const frontier = recomputeFrontier(context.brief, rounds);
    if (frontier.length > 0) {
      rounds.push({
        roundId: stableId(
          "round",
          `${context.brief}:${rounds.length + 1}:${frontier.map((question) => question.questionId).join(":")}`,
        ),
        questions: frontier,
        answers: [],
        createdAt: now(),
      });
    }
    const next = InterrogationStateSchema.parse({ rounds, frontier });
    return writeRevision(
      this.repository,
      context,
      "interrogation",
      "interrogation-state",
      { ...next, sourceRevisionIds: [context.interrogation.revisionId] },
    );
  }

  confirmSharedUnderstanding(
    context: M1CreativeContext & {
      brief: string;
      interrogation: RevisionRef;
      confirmedBy: string;
    },
  ): SharedUnderstandingArtifacts {
    const state = InterrogationStateSchema.parse(
      this.repository.resolveRevision<InterrogationState>(
        context.interrogation,
      ),
    );
    if (state.frontier.length > 0)
      throw new Error(
        "Shared understanding cannot be confirmed while the frontier is unresolved.",
      );
    if (state.rounds.some((round) => !round.completedAt))
      throw new Error(
        "Every interrogation round must be complete before confirmation.",
      );
    if (recomputeFrontier(context.brief, state.rounds).length > 0)
      throw new Error(
        "Shared understanding cannot be confirmed while the decision tree has an eligible unresolved branch.",
      );
    const confirmed = InterrogationStateSchema.parse({
      ...state,
      sharedUnderstanding: {
        confirmed: true,
        confirmedBy: context.confirmedBy,
        confirmedAt: now(),
      },
    });
    const interrogation = writeRevision(
      this.repository,
      context,
      "interrogation",
      "interrogation-state",
      {
        ...confirmed,
        sourceRevisionIds: [context.interrogation.revisionId],
      },
    );
    const gameDesignSpec = writeRevision(
      this.repository,
      context,
      "game-design-spec",
      "game-design-spec",
      {
        ...buildGameDesignSpec(context.brief, confirmed),
        sourceRevisionIds: [interrogation.revisionId],
      },
    );
    const glossary = writeRevision(
      this.repository,
      context,
      "project-glossary",
      "project-glossary",
      buildGlossary(confirmed, interrogation.revisionId),
    );
    const adrValue = buildAdr(confirmed, interrogation.revisionId);
    const result: SharedUnderstandingArtifacts = {
      interrogation,
      gameDesignSpec,
      glossary,
    };
    if (adrValue)
      result.adr = writeRevision(
        this.repository,
        context,
        "adr-primary-design-tension",
        "architecture-decision-record",
        adrValue,
      );
    return result;
  }

  reviseGameDesignSpec(
    context: M1CreativeContext & {
      gameDesignSpec: RevisionRef;
      change: string;
    },
  ): RevisionRef {
    const current = GameDesignSpecSchema.parse(
      this.repository.resolveRevision<GameDesignSpec>(context.gameDesignSpec),
    );
    const requestedDecision = sentence(context.change);
    if (!requestedDecision)
      throw new Error("A Game Design Spec change request is required.");
    const descendant = GameDesignSpecSchema.parse({
      ...current,
      gameplayConstraints: [
        ...new Set([...current.gameplayConstraints, requestedDecision]),
      ],
      facts: [
        ...current.facts,
        {
          statementId: stableId(
            "fact",
            `${context.gameDesignSpec.revisionId}:${requestedDecision}`,
          ),
          text: requestedDecision,
          kind: "fact",
          origin: {
            source: "user",
            reference: `revision of ${context.gameDesignSpec.revisionId}`,
          },
        },
      ],
    });
    return writeRevision(
      this.repository,
      context,
      "game-design-spec",
      "game-design-spec",
      {
        ...descendant,
        sourceRevisionIds: [context.gameDesignSpec.revisionId],
      },
    );
  }

  async generateVisualDirections(
    context: M1CreativeContext & { gameDesignSpec: RevisionRef },
  ): Promise<RevisionRef> {
    const spec = GameDesignSpecSchema.parse(
      this.repository.resolveRevision<GameDesignSpec>(context.gameDesignSpec),
    );
    const directions = await Promise.all(
      DIRECTION_TEMPLATES.map((template) =>
        this.createDirection(context, spec, context.gameDesignSpec, template),
      ),
    );
    const set = VisualDirectionSetSchema.parse({
      directionSetId: stableId(
        "direction-set",
        context.gameDesignSpec.revisionId,
      ),
      directions,
    });
    return writeRevision(
      this.repository,
      context,
      "visual-direction-set",
      "visual-direction-set",
      { ...set, sourceRevisionIds: [context.gameDesignSpec.revisionId] },
    );
  }

  async replaceUnselectedDirection(
    context: M1CreativeContext & {
      gameDesignSpec: RevisionRef;
      directionSet: RevisionRef;
      directionRevisionId: string;
      selectedDirectionRevisionId: string;
      notes: string;
    },
  ): Promise<RevisionRef> {
    if (context.directionRevisionId === context.selectedDirectionRevisionId)
      throw new Error("The selected direction cannot be replaced.");
    const set = VisualDirectionSetSchema.parse(
      this.repository.resolveRevision<VisualDirectionSet>(context.directionSet),
    );
    const target = selectedDirection(set, context.directionRevisionId);
    selectedDirection(set, context.selectedDirectionRevisionId);
    const spec = GameDesignSpecSchema.parse(
      this.repository.resolveRevision<GameDesignSpec>(context.gameDesignSpec),
    );
    const replacementTemplate: DirectionTemplate = {
      ...DIRECTION_TEMPLATES[2]!,
      slug: stableId("redirected", `${target.directionId}:${context.notes}`),
      name: "Redirected Material Theatre",
      rationale: sentence(context.notes),
      overallStyle: `Material-theatre interpretation: ${sentence(context.notes)}`,
      shapeLanguage:
        "Layered stage-like masses with a deliberately exposed focal plane",
      materials: [
        "cut paper",
        "patinated metal",
        "rough mineral",
        "diffuse glow",
      ],
      palette: [
        { name: "Night plum", hex: "#33263F", role: "primary mass" },
        { name: "Mineral mint", hex: "#77A98F", role: "world accent" },
        { name: "Stage amber", hex: "#F1A85B", role: "gameplay focus" },
      ],
    };
    const replacement = await this.createDirection(
      context,
      spec,
      context.gameDesignSpec,
      replacementTemplate,
      target.revisionId,
    );
    const directions = set.directions.map((direction) =>
      direction.revisionId === target.revisionId ? replacement : direction,
    ) as [VisualDirection, VisualDirection, VisualDirection];
    return writeRevision(
      this.repository,
      context,
      "visual-direction-set",
      "visual-direction-set",
      {
        ...VisualDirectionSetSchema.parse({
          directionSetId: set.directionSetId,
          directions,
        }),
        sourceRevisionIds: [
          context.directionSet.revisionId,
          target.revisionId,
          replacement.revisionId,
        ],
      },
    );
  }

  async makeFocusedDirectionChange(
    context: M1CreativeContext & {
      gameDesignSpec: RevisionRef;
      directionSet: RevisionRef;
      directionRevisionId: string;
      change: string;
      pinnedAspects: string[];
    },
  ): Promise<{ directionSet: RevisionRef; changeRecord: RevisionRef }> {
    if (context.pinnedAspects.length === 0)
      throw new Error("At least one aspect must be pinned.");
    const set = VisualDirectionSetSchema.parse(
      this.repository.resolveRevision<VisualDirectionSet>(context.directionSet),
    );
    const target = selectedDirection(set, context.directionRevisionId);
    const snapshots = context.pinnedAspects.map((name) => {
      const accessor = PINNED_ASPECTS[normalize(name)];
      if (!accessor) throw new Error(`Unsupported pinned aspect: ${name}`);
      return { name, accessor, before: accessor(target.visualBible) };
    });
    const category = focusedChangeCategory(context.change);
    const pinnedNames = new Set(snapshots.map(({ name }) => normalize(name)));
    const pinnedTargets: Partial<Record<VisualToken["category"], string[]>> = {
      style: ["style", "overall style"],
      shape: ["shape", "shape language"],
      palette: ["palette"],
      material: ["materials"],
      lighting: ["lighting"],
      atmosphere: ["atmosphere"],
      camera: ["camera"],
      readability: ["readability"],
    };
    if (pinnedTargets[category]?.some((name) => pinnedNames.has(name)))
      throw new Error(
        `The focused change targets pinned aspect ${pinnedTargets[category]!.find((name) => pinnedNames.has(name))}.`,
      );
    const changed = StructuredVisualBibleSchema.parse({
      ...target.visualBible,
      title: `${target.visualBible.title} — Focused Revision`,
      ...(category === "style"
        ? {
            overallStyle: `${target.visualBible.overallStyle}; ${sentence(context.change)}`,
          }
        : {}),
      ...(category === "shape"
        ? {
            shapeLanguage: `${target.visualBible.shapeLanguage}; ${sentence(context.change)}`,
          }
        : {}),
      ...(category === "material"
        ? {
            materials: [
              ...target.visualBible.materials,
              sentence(context.change),
            ],
          }
        : {}),
      ...(category === "surface"
        ? {
            textureLanguage: `${target.visualBible.textureLanguage}; ${sentence(context.change)}`,
          }
        : {}),
      ...(category === "lighting"
        ? {
            lighting: `${target.visualBible.lighting}; ${sentence(context.change)}`,
          }
        : {}),
      ...(category === "atmosphere"
        ? {
            atmosphere: `${target.visualBible.atmosphere}; ${sentence(context.change)}`,
          }
        : {}),
      ...(category === "camera"
        ? {
            cameraLanguage: `${target.visualBible.cameraLanguage}; ${sentence(context.change)}`,
          }
        : {}),
      ...(category === "readability"
        ? {
            readabilityRules: [
              ...target.visualBible.readabilityRules,
              sentence(context.change),
            ],
          }
        : {}),
      tokens: [
        ...target.visualBible.tokens,
        {
          tokenId: stableId("focused-change", context.change),
          category,
          value: sentence(context.change),
          role: "focused revision",
        },
      ],
    });
    const bibleRevision = writeRevision(
      this.repository,
      context,
      `visual-bible:${target.directionId}`,
      "structured-visual-bible",
      {
        sourceRevisionIds: [
          context.gameDesignSpec.revisionId,
          target.revisionId,
        ],
        value: changed,
      },
    );
    const previewArtifact = this.repository.putArtifact(
      context.projectId,
      await sharp(Buffer.from(previewSvg(changed, bibleRevision.revisionId)))
        .png()
        .toBuffer(),
      "image/png",
    );
    const changedDirection: VisualDirection = {
      ...target,
      revisionId: bibleRevision.revisionId,
      name: changed.title,
      rationale: `${target.rationale} Focused change: ${sentence(context.change)}`,
      visualBible: changed,
      preview: {
        artifact: previewArtifact,
        sourceGameDesignRevisionId: context.gameDesignSpec.revisionId,
        sourceVisualBibleRevisionId: bibleRevision.revisionId,
      },
    };
    const directions = set.directions.map((direction) =>
      direction.revisionId === target.revisionId ? changedDirection : direction,
    ) as [VisualDirection, VisualDirection, VisualDirection];
    const directionSet = writeRevision(
      this.repository,
      context,
      "visual-direction-set",
      "visual-direction-set",
      {
        ...VisualDirectionSetSchema.parse({
          directionSetId: set.directionSetId,
          directions,
        }),
        sourceRevisionIds: [
          context.directionSet.revisionId,
          target.revisionId,
          changedDirection.revisionId,
        ],
      },
    );
    const record: FocusedDirectionChange = {
      sourceDirectionRevisionId: target.revisionId,
      resultDirectionRevisionId: changedDirection.revisionId,
      change: context.change,
      pinnedAspects: snapshots.map(({ name, accessor, before }) => ({
        name,
        before,
        after: accessor(changed),
      })),
    };
    if (record.pinnedAspects.some((aspect) => aspect.before !== aspect.after))
      throw new Error("A focused change altered a pinned aspect.");
    const changeRecord = writeRevision(
      this.repository,
      context,
      `focused-change:${target.directionId}`,
      "focused-direction-change",
      record,
    );
    return { directionSet, changeRecord };
  }

  planConcepts(
    context: M1CreativeContext & {
      brief: string;
      gameDesignSpec: RevisionRef;
      directionSet: RevisionRef;
      selectedDirectionRevisionId: string;
    },
  ): RevisionRef {
    const set = VisualDirectionSetSchema.parse(
      this.repository.resolveRevision<VisualDirectionSet>(context.directionSet),
    );
    selectedDirection(set, context.selectedDirectionRevisionId);
    const lower = normalize(context.brief);
    const slots: ConceptPlan["slots"] = [
      {
        slotId: "gameplay-anchor",
        name: "Gameplay Anchor",
        purpose:
          "Define the subject or objective that carries the core interaction",
        tokenCategories: tokenCategoriesForSlot("gameplay-anchor"),
      },
    ];
    if (
      /(world|environment|arena|forest|city|island|dungeon|track|level|room)/.test(
        lower,
      )
    )
      slots.push({
        slotId: "environment-context",
        name: "Environment Context",
        purpose: "Show the gameplay anchor inside the readable playable space",
        tokenCategories: tokenCategoriesForSlot("environment-context"),
      });
    if (
      /(character|hero|creature|pilot|player|enemy|guardian|keeper)/.test(lower)
    )
      slots.push({
        slotId: "player-or-threat",
        name: "Player or Threat",
        purpose: "Establish scale, role, and silhouette for the primary actor",
        tokenCategories: tokenCategoriesForSlot("player-or-threat"),
      });
    const plan = ConceptPlanSchema.parse({
      sourceGameDesignRevisionId: context.gameDesignSpec.revisionId,
      sourceDirectionRevisionId: context.selectedDirectionRevisionId,
      slots: slots.slice(0, 3),
    });
    return writeRevision(
      this.repository,
      context,
      "concept-plan",
      "concept-plan",
      plan,
    );
  }

  async generateConceptSet(
    context: M1CreativeContext & {
      gameDesignSpec: RevisionRef;
      directionSet: RevisionRef;
      selectedDirectionRevisionId: string;
      conceptPlan: RevisionRef;
    },
  ): Promise<RevisionRef> {
    const spec = GameDesignSpecSchema.parse(
      this.repository.resolveRevision<GameDesignSpec>(context.gameDesignSpec),
    );
    const set = VisualDirectionSetSchema.parse(
      this.repository.resolveRevision<VisualDirectionSet>(context.directionSet),
    );
    const direction = selectedDirection(
      set,
      context.selectedDirectionRevisionId,
    );
    const plan = ConceptPlanSchema.parse(
      this.repository.resolveRevision<ConceptPlan>(context.conceptPlan),
    );
    if (
      plan.sourceGameDesignRevisionId !== context.gameDesignSpec.revisionId ||
      plan.sourceDirectionRevisionId !== direction.revisionId
    )
      throw new Error(
        "The concept plan does not descend from these approvals.",
      );
    const slots = await Promise.all(
      plan.slots.map(async (slot) => {
        const inheritedVisualTokens = direction.visualBible.tokens.filter(
          (token) => slot.tokenCategories.includes(token.category),
        );
        const revision = await this.createConceptRevision({
          ...context,
          spec,
          slot,
          inheritedVisualTokens,
          sourceRevisionIds: [
            context.gameDesignSpec.revisionId,
            direction.revisionId,
            context.conceptPlan.revisionId,
          ],
          attempt: 0,
        });
        return {
          slotId: slot.slotId,
          name: slot.name,
          purpose: slot.purpose,
          revisions: [{ revision, inheritedVisualTokens }],
        };
      }),
    );
    const conceptSet = ConceptSetSchema.parse({
      conceptSetId: stableId("concept-set", context.conceptPlan.revisionId),
      sourceDirectionRevisionId: direction.revisionId,
      slots,
    });
    return writeRevision(
      this.repository,
      context,
      "concept-set",
      "concept-set",
      {
        ...conceptSet,
        sourceRevisionIds: [
          context.gameDesignSpec.revisionId,
          direction.revisionId,
          context.conceptPlan.revisionId,
        ],
      },
    );
  }

  rebaseConceptSetForDirectionChange(
    context: M1CreativeContext & {
      conceptSet: RevisionRef;
      directionSet: RevisionRef;
      previousDirectionRevisionId: string;
      newDirectionRevisionId: string;
    },
  ): RevisionRef {
    const set = ConceptSetSchema.parse(
      this.repository.resolveRevision<ConceptSet>(context.conceptSet),
    );
    if (set.sourceDirectionRevisionId !== context.previousDirectionRevisionId)
      throw new Error(
        "The concept set does not descend from the previous selected direction.",
      );
    const directions = VisualDirectionSetSchema.parse(
      this.repository.resolveRevision<VisualDirectionSet>(context.directionSet),
    );
    const nextDirection = selectedDirection(
      directions,
      context.newDirectionRevisionId,
    );
    const storedDirection = resolveStructuredVisualBibleRevision(
      this.repository,
      nextDirection.revisionId,
    );
    if (
      !storedDirection.sourceRevisionIds.includes(
        context.previousDirectionRevisionId,
      )
    )
      throw new Error(
        "The new selected direction is not a focused descendant of the previous direction.",
      );

    const slots = set.slots.map((slot) => {
      const relevantCategories = tokenCategoriesForSlot(slot.slotId);
      const nextTokens = nextDirection.visualBible.tokens.filter((token) =>
        relevantCategories.includes(token.category),
      );
      const revisions = slot.revisions.map((conceptRevision) => {
        const changed =
          visualTokenSignature(conceptRevision.inheritedVisualTokens) !==
          visualTokenSignature(nextTokens);
        return changed
          ? {
              ...conceptRevision,
              staleReason: `Inherited visual tokens changed from direction ${context.previousDirectionRevisionId} to ${context.newDirectionRevisionId}.`,
            }
          : conceptRevision;
      });
      const selected = revisions.find(
        ({ revision }) => revision.revisionId === slot.selectedRevisionId,
      );
      return selected?.staleReason
        ? {
            slotId: slot.slotId,
            name: slot.name,
            purpose: slot.purpose,
            revisions,
          }
        : { ...slot, revisions };
    });
    const rebased = ConceptSetSchema.parse({
      ...set,
      sourceDirectionRevisionId: context.newDirectionRevisionId,
      slots,
    });
    return writeRevision(
      this.repository,
      context,
      "concept-set",
      "concept-set",
      {
        ...rebased,
        sourceRevisionIds: [
          context.conceptSet.revisionId,
          context.previousDirectionRevisionId,
          context.newDirectionRevisionId,
          context.directionSet.revisionId,
        ],
      },
    );
  }

  async regenerateConceptSlot(
    context: M1CreativeContext & {
      gameDesignSpec: RevisionRef;
      conceptSet: RevisionRef;
      slotId: string;
      notes?: string;
    },
  ): Promise<RevisionRef> {
    const spec = GameDesignSpecSchema.parse(
      this.repository.resolveRevision<GameDesignSpec>(context.gameDesignSpec),
    );
    const set = ConceptSetSchema.parse(
      this.repository.resolveRevision<ConceptSet>(context.conceptSet),
    );
    const target = set.slots.find((slot) => slot.slotId === context.slotId);
    if (!target)
      throw new Error(`Concept slot ${context.slotId} does not exist.`);
    const previousRevision =
      target.revisions.find(
        (revision) =>
          revision.revision.revisionId === target.selectedRevisionId,
      ) ?? target.revisions.at(-1);
    if (!previousRevision)
      throw new Error("The target slot has no concept revision to regenerate.");
    const priorDocument = M1ConceptDocumentSchema.parse(
      this.repository.resolveRevision<M1ConceptDocument>(
        previousRevision.revision,
      ),
    );
    const selectedDirection = resolveStructuredVisualBibleRevision(
      this.repository,
      set.sourceDirectionRevisionId,
    );
    const inheritedVisualTokens = selectedDirection.bible.tokens.filter(
      (token) => tokenCategoriesForSlot(target.slotId).includes(token.category),
    );
    const slot: ConceptPlan["slots"][number] = {
      slotId: target.slotId,
      name: target.name,
      purpose: target.purpose,
      tokenCategories: tokenCategoriesForSlot(target.slotId),
    };
    const revision = await this.createConceptRevision({
      ...context,
      spec,
      slot,
      inheritedVisualTokens,
      sourceRevisionIds: [
        ...priorDocument.sourceRevisionIds,
        set.sourceDirectionRevisionId,
        previousRevision.revision.revisionId,
        context.conceptSet.revisionId,
      ],
      attempt: target.revisions.length,
      ...(context.notes ? { regenerationNote: context.notes } : {}),
    });
    const slots = set.slots.map((candidate) =>
      candidate.slotId === target.slotId
        ? {
            ...candidate,
            revisions: [
              ...candidate.revisions,
              {
                revision,
                inheritedVisualTokens,
              },
            ],
          }
        : candidate,
    );
    return writeRevision(
      this.repository,
      context,
      "concept-set",
      "concept-set",
      {
        ...ConceptSetSchema.parse({ ...set, slots }),
        sourceRevisionIds: [context.conceptSet.revisionId, revision.revisionId],
      },
    );
  }

  selectConceptRevision(
    context: M1CreativeContext & {
      conceptSet: RevisionRef;
      slotId: string;
      conceptRevisionId: string;
    },
  ): RevisionRef {
    const set = ConceptSetSchema.parse(
      this.repository.resolveRevision<ConceptSet>(context.conceptSet),
    );
    const slot = set.slots.find(
      (candidate) => candidate.slotId === context.slotId,
    );
    if (!slot)
      throw new Error(`Concept slot ${context.slotId} does not exist.`);
    const selection = slot.revisions.find(
      ({ revision }) => revision.revisionId === context.conceptRevisionId,
    );
    if (!selection)
      throw new Error(
        `Concept revision ${context.conceptRevisionId} is not in slot ${context.slotId}.`,
      );
    if (selection.staleReason)
      throw new Error(
        `Concept revision ${context.conceptRevisionId} is stale and cannot be selected.`,
      );
    const slots = set.slots.map((candidate) =>
      candidate.slotId === slot.slotId
        ? { ...candidate, selectedRevisionId: selection.revision.revisionId }
        : candidate,
    );
    return writeRevision(
      this.repository,
      context,
      "concept-set",
      "concept-set",
      {
        ...ConceptSetSchema.parse({ ...set, slots }),
        sourceRevisionIds: [
          context.conceptSet.revisionId,
          selection.revision.revisionId,
        ],
      },
    );
  }

  private async createDirection(
    context: M1CreativeContext,
    spec: GameDesignSpec,
    gameDesignSpec: RevisionRef,
    template: DirectionTemplate,
    sourceDirectionRevisionId?: string,
  ): Promise<VisualDirection> {
    const bible = bibleFor(template, spec);
    const sourceRevisionIds = [gameDesignSpec.revisionId];
    if (sourceDirectionRevisionId)
      sourceRevisionIds.push(sourceDirectionRevisionId);
    const bibleRevision = writeRevision(
      this.repository,
      context,
      `visual-bible:${template.slug}`,
      "structured-visual-bible",
      { sourceRevisionIds, value: bible },
    );
    const artifact = this.repository.putArtifact(
      context.projectId,
      await sharp(Buffer.from(previewSvg(bible, bibleRevision.revisionId)))
        .png()
        .toBuffer(),
      "image/png",
    );
    return {
      directionId: `${context.projectId}:${template.slug}`,
      revisionId: bibleRevision.revisionId,
      name: template.name,
      rationale: contextualRationale(template, spec),
      visualBible: bible,
      preview: {
        artifact,
        sourceGameDesignRevisionId: gameDesignSpec.revisionId,
        sourceVisualBibleRevisionId: bibleRevision.revisionId,
      },
    };
  }

  private async createConceptRevision(
    input: M1CreativeContext & {
      spec: GameDesignSpec;
      slot: ConceptPlan["slots"][number];
      inheritedVisualTokens: VisualToken[];
      sourceRevisionIds: string[];
      attempt: number;
      regenerationNote?: string;
    },
  ): Promise<RevisionRef> {
    if (input.inheritedVisualTokens.length === 0)
      throw new Error(
        "A concept cannot be compiled without approved visual tokens.",
      );
    const prompt = conceptPrompt(
      input.slot,
      input.spec,
      input.inheritedVisualTokens,
      input.regenerationNote,
    );
    const image = this.repository.putArtifact(
      input.projectId,
      await sharp(
        Buffer.from(
          conceptSvg(input.slot, input.inheritedVisualTokens, input.attempt),
        ),
      )
        .png()
        .toBuffer(),
      "image/png",
    );
    const sourceRevisions = [...new Set(input.sourceRevisionIds)].map(
      (revisionId) => this.repository.getRevision(revisionId),
    );
    const document = M1ConceptDocumentSchema.parse({
      conceptId: `${input.projectId}:${input.slot.slotId}`,
      name: `${input.slot.name} r${String(input.attempt + 1).padStart(2, "0")}`,
      prompt,
      negativePrompt: input.inheritedVisualTokens
        .filter((token) => token.category === "prohibited-style")
        .map((token) => token.value)
        .join(", "),
      image,
      provider: "fulcrum-replay",
      model: "m1-replay-svg-v1",
      sourceRevisionIds: sourceRevisions.map(({ revisionId }) => revisionId),
      ancestors: sourceRevisions.map(({ revisionId, artifact, kind }) => ({
        revisionId,
        sha256: artifact.sha256,
        kind,
      })),
      costUsd: 0,
    });
    return writeRevision(
      this.repository,
      input,
      `concept:${input.slot.slotId}`,
      "concept-document",
      document,
    );
  }
}
