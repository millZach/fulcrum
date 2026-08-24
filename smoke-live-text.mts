// Standalone Task K smoke: real codex CLI through ModelExecution for the three
// live-text schemas. No project, no repository, no images. Run: npx tsx smoke-live-text.mts
import { writeFileSync } from "node:fs";

import { ModelExecution } from "./packages/execution/src/index.js";
import {
  LiveInterrogationFirstRoundSchema,
  LiveDirectionSetOutputSchema,
  LiveGameDesignSpecOutputSchema,
  interrogationFirstRoundPrompt,
  interrogationFirstRoundSystemPrompt,
  gameDesignSpecPrompt,
  gameDesignSystemPrompt,
  visualDirectionSetPrompt,
  directionsSystemPrompt,
  materializeLiveQuestions,
} from "./packages/creative/src/m1-live-text.js";

const BRIEF =
  "Create a cozy third-person game about restoring a derelict mountain cable-car network. The player rides between stations, repairs machinery with salvaged parts, and befriends the marmots living in the engine rooms. Sessions should be short, calm, and end with one cable line visibly running again.";

const execution = new ModelExecution();
const out: Record<string, unknown> = {};
const t = (label: string) => {
  const start = Date.now();
  return () => (out[`${label}Ms`] = Date.now() - start);
};

// 1. First grill round
let done = t("round");
const round = await execution.generateStructured({
  provider: "openai",
  cwd: process.cwd(),
  systemPrompt: interrogationFirstRoundSystemPrompt,
  prompt: interrogationFirstRoundPrompt(BRIEF),
  schema: LiveInterrogationFirstRoundSchema,
});
done();
out.roundModel = round.model;
out.questions = round.value.questions;

// 2. Spec from brief + fabricated answers to those questions
const questions = materializeLiveQuestions(BRIEF, 1, round.value.questions);
const rounds = [
  {
    roundId: "smoke-round-1",
    questions,
    answers: questions.map((q, i) => ({
      questionId: q.questionId,
      value:
        i === 0
          ? "One full cable line runs end to end by session close, gondola moving, lights on."
          : "Keep it single-player, one valley, no combat, failure is only stalled machinery.",
      answeredBy: "smoke",
    })),
  },
];
done = t("spec");
const spec = await execution.generateStructured({
  provider: "openai",
  cwd: process.cwd(),
  systemPrompt: gameDesignSystemPrompt,
  prompt: gameDesignSpecPrompt(BRIEF, rounds as never),
  schema: LiveGameDesignSpecOutputSchema,
});
done();
out.specModel = spec.model;
out.specCoreFantasy = (spec.value as { coreFantasy?: unknown }).coreFantasy;
out.specObjective = (spec.value as { objective?: unknown }).objective;

// 3. Three directions from that spec
done = t("directions");
const directions = await execution.generateStructured({
  provider: "openai",
  cwd: process.cwd(),
  systemPrompt: directionsSystemPrompt,
  prompt: visualDirectionSetPrompt(spec.value),
  schema: LiveDirectionSetOutputSchema,
});
done();
out.directionNames = directions.value.directions.map((d) => ({
  name: d.name,
  slug: d.slug,
  palette: d.palette.map((p) => `${p.name} ${p.hex} (${p.role})`),
}));

writeFileSync(
  "/tmp/grok-tasks/smoke-live-text-result.json",
  JSON.stringify({ ...out, spec: spec.value }, null, 2),
);
console.log(JSON.stringify(out, null, 2));
