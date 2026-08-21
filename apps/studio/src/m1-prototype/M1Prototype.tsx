/**
 * PROTOTYPE — throw away after review.
 * Three replay-only variants of the M1 creative workflow, switchable with
 * ?prototype=m1&variant=A on the existing Studio entry point.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import { api } from "../api.js";
import { MascotStage } from "./MascotStage";
import {
  concepts,
  directions,
  projectFacts,
  questions,
  stages,
  type Direction,
  type M1Stage,
} from "./replay-data";
import "./m1-prototype.css";

type VariantKey = "A" | "B" | "C";

type ConceptRevision = {
  label: string;
  image: string;
  request: string;
  model: string;
};

type ImageEditResponse = {
  imageUrl: string;
  sha256: string;
  model: string;
  costUsd: number;
};

type PrototypeState = {
  stage: M1Stage;
  direction: Direction;
  projectPrompt: string;
  projectStarted: boolean;
  question: number;
  answered: boolean;
  answers: Record<number, string>;
  answeredQuestions: number[];
  sharedUnderstandingConfirmed: boolean;
  directionApproved: boolean;
  concept: number;
  conceptPlanConfirmed: boolean;
  regeneratedConcepts: number[];
  selectedConcepts: number[];
};

type VariantProps = PrototypeState & {
  setStage: (stage: M1Stage) => void;
  chooseDirection: (direction: Direction) => void;
  setProjectPrompt: (value: string) => void;
  startProject: () => void;
  setQuestion: (index: number) => void;
  setAnswer: (index: number, value: string) => void;
  setAnswered: (value: boolean) => void;
  reopenQuestion: (index: number) => void;
  confirmSharedUnderstanding: () => void;
  approveDirection: () => void;
  setConcept: (index: number) => void;
  setConceptPlanConfirmed: (value: boolean) => void;
  regenerateConcept: (index: number) => void;
  selectConceptRevision: (index: number) => void;
};

const variantNames: Record<VariantKey, string> = {
  A: "Neon signal deck",
  B: "Voxel workshop",
  C: "Review room",
};

function getVariant(): VariantKey {
  const value = new URLSearchParams(window.location.search)
    .get("variant")
    ?.toUpperCase();
  return value === "B" || value === "C" ? value : "A";
}

function setVariantInUrl(variant: VariantKey) {
  const url = new URL(window.location.href);
  url.searchParams.set("prototype", "m1");
  url.searchParams.set("variant", variant);
  window.history.replaceState({}, "", url);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function Mark() {
  return <span className="m1-mark">F</span>;
}

function ReplayBadge() {
  return (
    <span className="m1-replay">
      Subscription ImageGen enabled · no API key
    </span>
  );
}

function StageRail({
  stage,
  onChange,
}: {
  stage: M1Stage;
  onChange: (stage: M1Stage) => void;
}) {
  const current = stages.findIndex((item) => item.id === stage);
  return (
    <nav className="m1-stage-rail" aria-label="Creative workflow">
      {stages.map((item, index) => (
        <button
          className={
            item.id === stage ? "active" : index < current ? "done" : ""
          }
          key={item.id}
          onClick={() => onChange(item.id)}
          type="button"
        >
          <i>{index < current ? "✓" : `0${index + 1}`}</i>
          <span>{item.label}</span>
          <small>{item.note}</small>
        </button>
      ))}
    </nav>
  );
}

function Art({
  className,
  label,
  src,
}: {
  className: string;
  label: string;
  src: string;
}) {
  return (
    <div className={`m1-art ${className}`} role="img" aria-label={label}>
      <img src={src} alt="" />
    </div>
  );
}

function ConceptArtwork({
  className,
  label,
  src,
  compact = false,
}: {
  className: string;
  label: string;
  src: string;
  compact?: boolean;
}) {
  return (
    <div
      className={`concept-artwork ${className} ${compact ? "compact" : ""}`}
      role="img"
      aria-label={`${label} concept artwork`}
    >
      <img src={src} alt="" />
    </div>
  );
}

function Palette({ colors }: { colors: string[] }) {
  return (
    <div className="m1-palette" aria-label="Direction palette">
      {colors.map((color) => (
        <span key={color} style={{ backgroundColor: color }} />
      ))}
    </div>
  );
}

function StateLedger({ state }: { state: PrototypeState }) {
  return (
    <aside className="m1-state-ledger">
      <span>Visible replay state</span>
      <dl>
        <div>
          <dt>Stage</dt>
          <dd>{stages.find((item) => item.id === state.stage)?.label}</dd>
        </div>
        <div>
          <dt>Direction</dt>
          <dd>{state.direction.name}</dd>
        </div>
        <div>
          <dt>Lineage</dt>
          <dd>GDS 7c41 → VB d18f</dd>
        </div>
        <div>
          <dt>Concept set</dt>
          <dd>
            {state.conceptPlanConfirmed
              ? `${state.selectedConcepts.length} kept · ${3 - state.selectedConcepts.length} open`
              : "Plan awaiting confirmation"}
          </dd>
        </div>
      </dl>
    </aside>
  );
}

function ProjectStartA(props: VariantProps) {
  return (
    <section className="project-start project-start-a">
      <aside>
        <span className="m1-kicker">01 · Shared understanding</span>
        <p>
          Start with the idea in your own words. Fulcrum will ask only the
          consequential questions that become answerable from it.
        </p>
      </aside>
      <div>
        <span className="m1-kicker">New project</span>
        <h1>What do you want to make?</h1>
        <textarea
          aria-label="Describe your project"
          onChange={(event) => props.setProjectPrompt(event.target.value)}
          placeholder="Example: A quiet third-person exploration game about maintaining the last lighthouse in a town lost to the sea…"
          value={props.projectPrompt}
        />
        <button
          className="m1-primary"
          disabled={!props.projectPrompt.trim()}
          onClick={props.startProject}
          type="button"
        >
          Begin shared understanding <span>→</span>
        </button>
      </div>
      <aside className="start-expectation">
        <span className="m1-kicker">What happens next</span>
        <strong>Question rounds</strong>
        <strong>Game Design Spec</strong>
        <strong>Explicit confirmation</strong>
        <small>Nothing visual is chosen yet.</small>
      </aside>
    </section>
  );
}

function ProjectStartB(props: VariantProps) {
  return (
    <section className="studio-start">
      <header>
        <span>PREPRODUCTION / NEW PROJECT</span>
        <i>Unsaved session</i>
      </header>
      <div>
        <span className="studio-eyebrow">Project setup</span>
        <h1>Bring the game into focus.</h1>
        <p>
          Start with the pitch you would give your team. Fulcrum turns it into
          an approved design brief before look development begins.
        </p>
        <label>
          <span>Creative brief</span>
          <small>
            Describe the player, the world, and what makes it compelling.
          </small>
        </label>
        <textarea
          aria-label="Describe your project"
          onChange={(event) => props.setProjectPrompt(event.target.value)}
          placeholder="A third-person exploration game about…"
          value={props.projectPrompt}
        />
        <button
          disabled={!props.projectPrompt.trim()}
          onClick={props.startProject}
          type="button"
        >
          Open project workspace <span>→</span>
        </button>
      </div>
    </section>
  );
}

function ProjectStartC(props: VariantProps) {
  return (
    <section className="rr-stage rr-start" key="rr-start">
      <div className="rr-start-copy">
        <span className="rr-overline">Session 01 · the room is still dark</span>
        <h1>
          Show us the game
          <em>in your head.</em>
        </h1>
        <p>
          Describe it in your own words. Fulcrum asks what matters, turns your
          answers into a brief, and waits for your approval before a single
          image is made.
        </p>
        <label className="rr-sheet">
          <span className="rr-sheet-label">The pitch</span>
          <textarea
            aria-label="Describe your project"
            onChange={(event) => props.setProjectPrompt(event.target.value)}
            placeholder="I want players to feel…"
            value={props.projectPrompt}
          />
        </label>
        <button
          className="rr-act"
          disabled={!props.projectPrompt.trim()}
          onClick={props.startProject}
          type="button"
        >
          <span>Turn on the lights</span>
          <i aria-hidden="true">→</i>
        </button>
      </div>
      <div className="rr-start-wall">
        <div className="rr-plate rr-plate-empty">
          <span className="rr-tape rr-tape-a" aria-hidden="true" />
          <span className="rr-tape rr-tape-b" aria-hidden="true" />
          <div className="rr-plate-void">
            <strong>Nothing pinned yet</strong>
            <small>Every decision you sign off gets pinned to this wall.</small>
          </div>
        </div>
        <ol className="rr-acts">
          <li>
            <i>01</i>
            <span>Align on the game</span>
          </li>
          <li>
            <i>02</i>
            <span>Choose its visual promise</span>
          </li>
          <li>
            <i>03</i>
            <span>Direct the concept images</span>
          </li>
        </ol>
      </div>
    </section>
  );
}

function FocusedInterview(props: VariantProps) {
  const item = questions[props.question] ?? questions[0]!;
  const complete = props.answeredQuestions.length === questions.length;
  if (complete)
    return (
      <section className="shared-understanding-review">
        <header>
          <span className="m1-kicker">Ready for confirmation</span>
          <h1>Is this the game Fulcrum should design?</h1>
          <p>
            Visual work stays locked until you confirm this shared
            understanding.
          </p>
        </header>
        <blockquote>{props.projectPrompt}</blockquote>
        <div className="understanding-decisions">
          {questions.map((question, index) => (
            <article key={question.branch}>
              <small>{question.branch}</small>
              <strong>{question.prompt}</strong>
              <p>{props.answers[index]}</p>
              <button onClick={() => props.reopenQuestion(index)} type="button">
                Revise answer
              </button>
            </article>
          ))}
        </div>
        <footer>
          <small>
            Prototype note: later screens use saved Hollow Signal art so you can
            compare application designs without generating nine new images.
          </small>
          <button
            className="m1-primary"
            onClick={props.confirmSharedUnderstanding}
            type="button"
          >
            Confirm shared understanding <span>→</span>
          </button>
        </footer>
      </section>
    );
  return (
    <section className="focus-interview">
      <div className="focus-context">
        <span className="m1-kicker">Current frontier</span>
        <strong>
          {props.question + 1} of {questions.length}
        </strong>
        <p>
          Two decisions can be answered now. Later branches stay hidden until
          these resolve.
        </p>
        <div className="frontier-dots">
          {questions.map((_, index) => (
            <button
              aria-label={`Question ${index + 1}`}
              className={index === props.question ? "active" : ""}
              key={index}
              onClick={() => props.setQuestion(index)}
              type="button"
            />
          ))}
        </div>
      </div>
      <article className="focus-question">
        <span className="m1-kicker">{item.branch}</span>
        <h1>{item.prompt}</h1>
        <div className="recommendation">
          <small>Fulcrum recommends</small>
          <p>{item.recommendation}</p>
          <em>{item.why}</em>
        </div>
        <textarea
          aria-label="Your answer"
          onChange={(event) =>
            props.setAnswer(props.question, event.target.value)
          }
          value={props.answers[props.question] ?? item.recommendation}
        />
        <button
          className="m1-primary"
          onClick={() => props.setAnswered(true)}
          type="button"
        >
          {props.answered ? "Update answer" : "Record answer"}
          <span>→</span>
        </button>
      </article>
      <aside className="focus-memory">
        <span className="m1-kicker">Already understood</span>
        {projectFacts.map((fact) => (
          <span key={fact}>✓ {fact}</span>
        ))}
        <button type="button">View project glossary</button>
      </aside>
    </section>
  );
}

function FocusedDirection(props: VariantProps) {
  return (
    <section className="focus-direction">
      <div className="focus-hero-art">
        <Art
          className={props.direction.artClass}
          label={`${props.direction.name} visual direction`}
          src={props.direction.image}
        />
        <div className="art-label">
          <span>{props.direction.index} / 03</span>
          <small>Visual direction</small>
        </div>
      </div>
      <aside className="focus-decision">
        <span className="m1-kicker">Choose the visual promise</span>
        <h1>{props.direction.name}</h1>
        <p>{props.direction.thesis}</p>
        <Palette colors={props.direction.palette} />
        <dl>
          <div>
            <dt>Shape</dt>
            <dd>{props.direction.shape}</dd>
          </div>
          <div>
            <dt>Surface</dt>
            <dd>{props.direction.material}</dd>
          </div>
          <div>
            <dt>Light</dt>
            <dd>{props.direction.light}</dd>
          </div>
        </dl>
        <div className="focus-actions">
          <button className="m1-secondary" type="button">
            Request a focused change
          </button>
          <button
            className="m1-primary"
            onClick={props.approveDirection}
            type="button"
          >
            Approve direction <span>→</span>
          </button>
        </div>
      </aside>
      <div className="focus-filmstrip">
        {directions.map((direction) => (
          <button
            className={direction.id === props.direction.id ? "active" : ""}
            key={direction.id}
            onClick={() => props.chooseDirection(direction)}
            type="button"
          >
            <Art
              className={direction.artClass}
              label=""
              src={direction.image}
            />
            <span>
              <i>{direction.index}</i>
              {direction.name}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

function FocusedConcepts(props: VariantProps) {
  const concept = concepts[props.concept] ?? concepts[0];
  const selected = props.selectedConcepts.includes(props.concept);
  const [packageReview, setPackageReview] = useState(false);
  const [packageApproved, setPackageApproved] = useState(false);
  const [liveRevisions, setLiveRevisions] = useState<
    Record<number, ConceptRevision[]>
  >({});
  const [viewedRevisions, setViewedRevisions] = useState<
    Record<number, string>
  >({});
  const [keptRevisions, setKeptRevisions] = useState<Record<number, string>>(
    {},
  );
  const [generatingConcept, setGeneratingConcept] = useState<number>();
  const [generationErrors, setGenerationErrors] = useState<
    Record<number, string>
  >({});
  const [changeRequests, setChangeRequests] = useState<Record<number, string>>(
    () =>
      Object.fromEntries(
        concepts.map((item, index) => [index, item.changeRequest]),
      ),
  );
  const currentChangeRequest = changeRequests[props.concept] ?? "";
  const revisionsFor = (index: number): ConceptRevision[] => {
    const item = concepts[index] ?? concepts[0];
    return [
      {
        label: "r01",
        image: item.image,
        request: "Original saved concept",
        model: "Saved ImageGen output",
      },
      ...(liveRevisions[index] ?? []),
    ];
  };
  const revisions = revisionsFor(props.concept);
  const viewedRevision =
    viewedRevisions[props.concept] ?? revisions.at(-1)?.label ?? "r01";
  const reviewedRevision =
    revisions.find(({ label }) => label === viewedRevision) ?? revisions[0]!;
  const reviewedImage = reviewedRevision.image;
  const isGenerating = generatingConcept === props.concept;
  const generationError = generationErrors[props.concept];
  const nextRevisionLabel = `r${String(revisions.length + 1).padStart(2, "0")}`;

  const generateRevision = async () => {
    const conceptIndex = props.concept;
    const requestText = currentChangeRequest.trim();
    if (!requestText || isGenerating) return;
    setGeneratingConcept(conceptIndex);
    setGenerationErrors((current) => {
      const next = { ...current };
      delete next[conceptIndex];
      return next;
    });
    try {
      const result = await api<ImageEditResponse>(
        "/api/prototype/imagegen/edit",
        {
          method: "POST",
          body: JSON.stringify({
            sourceImage: reviewedImage,
            prompt: requestText,
            conceptTitle: concept.title,
            conceptPurpose: concept.purpose,
            directionName: props.direction.name,
          }),
        },
      );
      const revision: ConceptRevision = {
        label: nextRevisionLabel,
        image: result.imageUrl,
        request: requestText,
        model: result.model,
      };
      setLiveRevisions((current) => ({
        ...current,
        [conceptIndex]: [...(current[conceptIndex] ?? []), revision],
      }));
      setViewedRevisions((current) => ({
        ...current,
        [conceptIndex]: revision.label,
      }));
      setKeptRevisions((current) => {
        const next = { ...current };
        delete next[conceptIndex];
        return next;
      });
      props.regenerateConcept(conceptIndex);
    } catch (error) {
      setGenerationErrors((current) => ({
        ...current,
        [conceptIndex]:
          error instanceof Error ? error.message : "ImageGen failed.",
      }));
    } finally {
      setGeneratingConcept(undefined);
    }
  };

  const keepAndContinue = () => {
    setKeptRevisions((current) => ({
      ...current,
      [props.concept]: viewedRevision,
    }));
    props.selectConceptRevision(props.concept);
    const next = concepts.findIndex(
      (_item, index) =>
        index !== props.concept && !props.selectedConcepts.includes(index),
    );
    if (next >= 0) props.setConcept(next);
    else setPackageReview(true);
  };

  if (!props.conceptPlanConfirmed)
    return (
      <section className="concept-plan-review">
        <header>
          <span className="m1-kicker">Before ImageGen runs</span>
          <h1>Fulcrum proposes creating these three images.</h1>
          <p>
            This list comes from the Game Design Spec you approved. The initial
            images are saved ImageGen samples and none are selected. Confirm the
            list, or describe what should change first.
          </p>
        </header>
        <div className="concept-plan-list">
          <article>
            <i>01</i>
            <span>
              <small>Player character</small>
              <strong>The Signal Keeper</strong>
              <p>
                Establishes the player fantasy, silhouette, equipment, and
                scale.
              </p>
            </span>
          </article>
          <article>
            <i>02</i>
            <span>
              <small>Central location</small>
              <strong>The Last Lighthouse</strong>
              <p>
                Shows the approved hub and the navigational anchor of the game.
              </p>
            </span>
          </article>
          <article>
            <i>03</i>
            <span>
              <small>Main threat</small>
              <strong>The Listener</strong>
              <p>
                Defines the silhouette-first threat and its non-combat
                readability.
              </p>
            </span>
          </article>
        </div>
        <label className="concept-plan-change">
          <span>Change the proposed image list</span>
          <textarea placeholder="Example: Replace the enemy concept with a flooded-street gameplay scene." />
        </label>
        <footer>
          <div>
            <strong>OpenAI subscription · ImageGen</strong>
            <small>
              Open each saved starting image, then enter your own change request
              to create live revisions through your signed-in subscription. No
              API key or metered API request.
            </small>
          </div>
          <button
            className="m1-primary"
            onClick={() => props.setConceptPlanConfirmed(true)}
            type="button"
          >
            Confirm list and open image review <span>→</span>
          </button>
        </footer>
      </section>
    );
  if (packageApproved)
    return (
      <section className="concept-complete">
        <span className="complete-mark">✓</span>
        <span className="m1-kicker">Concept package approved</span>
        <h1>M1 is complete.</h1>
        <p>
          The three kept image revisions are now the approved creative package
          for Hollow Signal. Nothing else was generated or selected.
        </p>
        <div className="complete-lineage">
          Game Design Spec → {props.direction.name} Visual Bible → approved
          concept package
        </div>
      </section>
    );

  if (packageReview)
    return (
      <section className="concept-package-review">
        <header>
          <span className="m1-kicker">Final approval</span>
          <h1>Review the concept package.</h1>
          <p>
            Detailed image review is complete. This page only confirms which
            kept revisions will become project truth.
          </p>
        </header>
        <div className="package-summary-grid">
          {concepts.map((item, index) => {
            const keptRevision = keptRevisions[index] ?? "r01";
            const keptImage =
              revisionsFor(index).find(({ label }) => label === keptRevision)
                ?.image ?? item.image;
            return (
              <article key={item.id}>
                <img src={keptImage} alt="" />
                <span>
                  <small>{item.slot}</small>
                  <strong>{item.title}</strong>
                  <i>✓ Kept · {keptRevision}</i>
                </span>
                <button
                  onClick={() => {
                    props.setConcept(index);
                    setPackageReview(false);
                  }}
                  type="button"
                >
                  Review again
                </button>
              </article>
            );
          })}
        </div>
        <footer>
          <button
            className="m1-secondary"
            onClick={() => setPackageReview(false)}
            type="button"
          >
            Back to image review
          </button>
          <button
            className="m1-primary"
            onClick={() => setPackageApproved(true)}
            type="button"
          >
            Approve concept package <span>→</span>
          </button>
        </footer>
      </section>
    );

  return (
    <section className="single-concept-review">
      <header className="single-review-heading">
        <div>
          <span className="m1-kicker">
            Image {props.concept + 1} of {concepts.length} · {concept.slot}
          </span>
          <h1>{concept.title}</h1>
        </div>
        <div className="review-progress">
          {concepts.map((item, index) => (
            <button
              className={
                index === props.concept
                  ? "active"
                  : props.selectedConcepts.includes(index)
                    ? "kept"
                    : ""
              }
              key={item.id}
              onClick={() => props.setConcept(index)}
              type="button"
            >
              <i>
                {props.selectedConcepts.includes(index) ? "✓" : `0${index + 1}`}
              </i>
              <span>{item.title}</span>
            </button>
          ))}
        </div>
      </header>

      <div className="single-review-layout">
        <div className="single-review-visual">
          <img src={reviewedImage} alt={`${concept.title} concept`} />
          <div className="single-review-caption">
            <span>{viewedRevision} · full image</span>
            <small>No crop applied</small>
          </div>
        </div>

        <aside className="single-review-controls">
          <section>
            <span className="control-label">Why this image exists</span>
            <p>{concept.purpose}</p>
          </section>
          <section className="approved-context">
            <span>Approved direction</span>
            <strong>{props.direction.name}</strong>
            <small>5 inherited visual tokens</small>
          </section>
          <section className="full-revision-history">
            <span className="control-label">Revision history</span>
            {revisions.map((revision, index) => (
              <button
                className={viewedRevision === revision.label ? "active" : ""}
                key={revision.label}
                onClick={() =>
                  setViewedRevisions((current) => ({
                    ...current,
                    [props.concept]: revision.label,
                  }))
                }
                type="button"
              >
                <span>
                  {revision.label} · {index === 0 ? "Original" : "Your request"}
                </span>
                <small>
                  {keptRevisions[props.concept] === revision.label
                    ? "Kept"
                    : "View full size"}
                </small>
              </button>
            ))}
          </section>
          <label className="image-change-request">
            <span>Tell ImageGen what should change</span>
            <textarea
              value={currentChangeRequest}
              onChange={(event) =>
                setChangeRequests((current) => ({
                  ...current,
                  [props.concept]: event.target.value,
                }))
              }
            />
            <small>
              Your exact request is sent with the image currently on screen and
              the approved {props.direction.name} direction. Unmentioned details
              are explicitly preserved.
            </small>
          </label>
          <button
            className="m1-secondary"
            onClick={generateRevision}
            disabled={!currentChangeRequest.trim() || isGenerating}
            type="button"
          >
            {isGenerating
              ? `ImageGen is creating ${nextRevisionLabel}…`
              : "Generate a new revision with ImageGen"}
          </button>
          {isGenerating && (
            <p className="image-generation-status">
              This normally takes a few minutes. Keep this page open.
            </p>
          )}
          {generationError && (
            <p className="image-generation-error" role="alert">
              {generationError}
            </p>
          )}
          {reviewedRevision.label !== "r01" && !isGenerating && (
            <p className="image-generation-result">
              {reviewedRevision.label} was created from “
              {reviewedRevision.request}” using {reviewedRevision.model}.
            </p>
          )}
          <button
            className="m1-primary"
            onClick={keepAndContinue}
            disabled={isGenerating}
            type="button"
          >
            {selected && keptRevisions[props.concept] === viewedRevision
              ? "Continue"
              : "Keep this revision and continue"}{" "}
            <span>→</span>
          </button>
          {props.selectedConcepts.length === concepts.length && (
            <button
              className="review-package-link"
              onClick={() => setPackageReview(true)}
              type="button"
            >
              Review concept package
            </button>
          )}
        </aside>
      </div>
    </section>
  );
}

function LegacyVariantA(props: VariantProps) {
  return (
    <main className="m1-prototype variant-a">
      <header className="m1-topbar">
        <div className="m1-wordmark">
          <Mark />
          <span>FULCRUM</span>
          <i>/ PROTOTYPE SESSION</i>
        </div>
        <StageRail stage={props.stage} onChange={props.setStage} />
        <ReplayBadge />
      </header>
      {props.stage === "understand" &&
        (props.projectStarted ? (
          <FocusedInterview {...props} />
        ) : (
          <ProjectStartA {...props} />
        ))}
      {props.stage === "direction" && <FocusedDirection {...props} />}
      {props.stage === "concepts" && <FocusedConcepts {...props} />}
    </main>
  );
}

function AtlasNode({
  children,
  state,
}: {
  children: React.ReactNode;
  state?: string;
}) {
  return <div className={`atlas-node ${state ?? ""}`}>{children}</div>;
}

function LegacyVariantB(props: VariantProps) {
  const question = questions[props.question] ?? questions[0]!;
  const shell = (
    <>
      <header className="atlas-header">
        <div className="m1-wordmark">
          <Mark />
          <span>FULCRUM / PROJECT ATLAS</span>
        </div>
        <div>
          <strong>Prototype session</strong>
          <ReplayBadge />
        </div>
      </header>
      <div className="atlas-toolbar">
        <span>Project map</span>
        <div className="atlas-stage-buttons">
          {stages.map((item) => (
            <button
              className={props.stage === item.id ? "active" : ""}
              key={item.id}
              onClick={() => props.setStage(item.id)}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </div>
        <span>Dependencies stay visible</span>
      </div>
    </>
  );
  if (!props.projectStarted)
    return (
      <main className="m1-prototype variant-b">
        {shell}
        <ProjectStartB {...props} />
      </main>
    );
  if (props.stage === "concepts")
    return (
      <main className="m1-prototype variant-b atlas-concept-workflow">
        {shell}
        <FocusedConcepts {...props} />
      </main>
    );
  return (
    <main className="m1-prototype variant-b">
      {shell}
      <section className="atlas-board">
        <article className="atlas-column inputs">
          <div className="atlas-column-title">
            <span>01</span>
            <h2>Project truth</h2>
            <small>Approved inputs</small>
          </div>
          <AtlasNode state="approved">
            <small>Brief</small>
            <strong>{props.projectPrompt}</strong>
          </AtlasNode>
          {projectFacts.slice(0, 3).map((fact) => (
            <AtlasNode state="approved" key={fact}>
              <small>Resolved</small>
              <span>{fact}</span>
            </AtlasNode>
          ))}
          <AtlasNode state={props.answered ? "approved" : "current"}>
            <small>Open branch</small>
            <span>What pulls the player from safety?</span>
          </AtlasNode>
        </article>
        <article className="atlas-column directions">
          <div className="atlas-column-title">
            <span>02</span>
            <h2>Visual language</h2>
            <small>3 interpretations</small>
          </div>
          {directions.map((direction) => (
            <button
              className={`atlas-direction ${direction.id === props.direction.id ? "active" : ""}`}
              key={direction.id}
              onClick={() => {
                props.chooseDirection(direction);
                props.setStage("direction");
              }}
              type="button"
            >
              <Art
                className={direction.artClass}
                label=""
                src={direction.image}
              />
              <span>
                <small>{direction.index}</small>
                <strong>{direction.name}</strong>
                <i>
                  {direction.id === props.direction.id ? "in focus" : "compare"}
                </i>
              </span>
            </button>
          ))}
          <AtlasNode state="lineage">
            <small>Visual Bible</small>
            <span>{props.direction.name} · 8 structured tokens</span>
          </AtlasNode>
        </article>
        <article className="atlas-column outputs">
          <div className="atlas-column-title">
            <span>03</span>
            <h2>Concept set</h2>
            <small>Inherited outputs</small>
          </div>
          {concepts.map((concept, index) => (
            <button
              className={`atlas-concept ${index === props.concept ? "active" : ""}`}
              key={concept.id}
              onClick={() => {
                props.setConcept(index);
                props.setStage("concepts");
              }}
              type="button"
            >
              <img
                className="atlas-concept-image"
                src={
                  props.regeneratedConcepts.includes(index)
                    ? concept.revisedImage
                    : concept.image
                }
                alt=""
              />
              <span>
                <small>{concept.slot}</small>
                <strong>{concept.title}</strong>
                <i>
                  {props.regeneratedConcepts.includes(index)
                    ? "revision r02"
                    : concept.revision}
                </i>
              </span>
            </button>
          ))}
          <button
            className="atlas-approve"
            onClick={() => props.regenerateConcept(props.concept)}
            type="button"
          >
            {props.regeneratedConcepts.includes(props.concept)
              ? "Revision connected"
              : "Revise active concept only"}
            <span>→</span>
          </button>
        </article>
        <svg
          className="atlas-lines"
          aria-hidden="true"
          viewBox="0 0 1200 720"
          preserveAspectRatio="none"
        >
          <path d="M340 172 C390 172 400 172 450 172" />
          <path d="M340 390 C390 390 400 390 450 390" />
          <path d="M750 252 C800 252 810 164 860 164" />
          <path d="M750 252 C800 252 810 338 860 338" />
          <path d="M750 252 C800 252 810 512 860 512" />
        </svg>
      </section>
      {props.stage === "understand" ? (
        <div className="atlas-session-inspector">
          {props.answeredQuestions.length === questions.length ? (
            <>
              <span>Frontier resolved</span>
              <strong>
                Confirm the shared understanding before visual work.
              </strong>
              <button onClick={props.confirmSharedUnderstanding} type="button">
                Confirm and unlock directions <span>→</span>
              </button>
            </>
          ) : (
            <>
              <span>{question.branch}</span>
              <strong>{question.prompt}</strong>
              <textarea
                aria-label="Your answer"
                onChange={(event) =>
                  props.setAnswer(props.question, event.target.value)
                }
                value={props.answers[props.question] ?? question.recommendation}
              />
              <button onClick={() => props.setAnswered(true)} type="button">
                Record node and continue <span>→</span>
              </button>
            </>
          )}
        </div>
      ) : (
        <div className="atlas-session-inspector direction-selection">
          <span>Selected visual direction</span>
          <strong>{props.direction.name}</strong>
          <i>{props.direction.thesis}</i>
          <button onClick={props.approveDirection} type="button">
            Approve this direction <span>→</span>
          </button>
        </div>
      )}
    </main>
  );
}

function BriefingDirection({
  direction,
  active,
  onClick,
}: {
  direction: Direction;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`brief-direction ${active ? "active" : ""}`}
      onClick={onClick}
      type="button"
    >
      <Art className={direction.artClass} label="" src={direction.image} />
      <span>
        <small>Direction {direction.index}</small>
        <strong>{direction.name}</strong>
        <p>{direction.thesis}</p>
      </span>
    </button>
  );
}

function LegacyVariantC(props: VariantProps) {
  const question = questions[props.question] ?? questions[0]!;
  const nav = (
    <aside className="brief-nav">
      <div className="m1-wordmark">
        <Mark />
        <span>FULCRUM</span>
      </div>
      <div className="brief-project">
        <small>Prototype session</small>
        <strong>Living brief</strong>
        <span>Your idea stays visible</span>
      </div>
      <nav>
        {stages.map((item, index) => (
          <button
            className={props.stage === item.id ? "active" : ""}
            key={item.id}
            onClick={() => props.setStage(item.id)}
            type="button"
          >
            <i>0{index + 1}</i>
            <span>
              {item.label}
              <small>{item.note}</small>
            </span>
          </button>
        ))}
      </nav>
      <div className="brief-progress">
        <span>
          <i
            style={{
              width: `${Math.round((props.answeredQuestions.length / questions.length) * 100)}%`,
            }}
          />
        </span>
        <small>
          Shared understanding {props.answeredQuestions.length} /{" "}
          {questions.length}
        </small>
      </div>
      <ReplayBadge />
    </aside>
  );
  if (!props.projectStarted)
    return (
      <main className="m1-prototype variant-c variant-c-start">
        {nav}
        <section className="brief-document">
          <header>
            <span>New working session</span>
          </header>
          <ProjectStartC {...props} />
        </section>
        <aside className="brief-dossier start-dossier">
          <span className="m1-kicker">How this version thinks</span>
          <h2>The project document is the application.</h2>
          <p>
            Questions, decisions, visual language, and approvals accumulate in
            one readable creative brief.
          </p>
        </aside>
      </main>
    );
  if (props.stage === "concepts")
    return (
      <main className="m1-prototype variant-c concept-mode">
        {nav}
        <section className="brief-document">
          <FocusedConcepts {...props} />
        </section>
      </main>
    );
  return (
    <main className="m1-prototype variant-c">
      {nav}
      <section className="brief-document">
        <header>
          <span>Working session · August 18</span>
          <button type="button">•••</button>
        </header>
        <div className="brief-copy">
          <span className="m1-kicker">Creative briefing</span>
          <h1>{props.projectPrompt}</h1>
          <p className="brief-lede">
            Fulcrum is building a living project brief as decisions resolve.
            Approvals, visual language, and concepts stay connected to this
            shared understanding.
          </p>
          <blockquote>
            “{props.projectPrompt}”<span>— original project intent</span>
          </blockquote>
          <div className="brief-facts">
            {projectFacts.map((fact) => (
              <span key={fact}>✓ {fact}</span>
            ))}
          </div>
          <div className="brief-separator">
            <span>Current decision</span>
          </div>
          <article className="brief-question">
            <small>{question.branch}</small>
            <h2>{question.prompt}</h2>
            <div>
              <span>Recommended answer</span>
              <p>{question.recommendation}</p>
              <em>{question.why}</em>
            </div>
            <textarea
              aria-label="Your answer"
              onChange={(event) =>
                props.setAnswer(props.question, event.target.value)
              }
              value={props.answers[props.question] ?? question.recommendation}
            />
            <button onClick={() => props.setAnswered(true)} type="button">
              {props.answered ? "Update this decision" : "Record this decision"}
            </button>
          </article>
          <div className="brief-separator">
            <span>Visual interpretations</span>
          </div>
          <div className="brief-directions">
            {directions.map((direction) => (
              <BriefingDirection
                active={direction.id === props.direction.id}
                direction={direction}
                key={direction.id}
                onClick={() => {
                  props.chooseDirection(direction);
                  props.setStage("direction");
                }}
              />
            ))}
          </div>
          <div className="brief-separator">
            <span>Concept proof</span>
          </div>
          <div className="brief-concepts">
            {concepts.map((concept, index) => (
              <button
                className={
                  index === props.concept
                    ? `active ${concept.artClass}`
                    : concept.artClass
                }
                key={concept.id}
                onClick={() => {
                  props.setConcept(index);
                  props.setStage("concepts");
                }}
                type="button"
              >
                <img
                  src={
                    props.regeneratedConcepts.includes(index)
                      ? concept.revisedImage
                      : concept.image
                  }
                  alt=""
                />
                <small>{concept.slot}</small>
                <strong>{concept.title}</strong>
              </button>
            ))}
          </div>
        </div>
      </section>
      <aside className="brief-dossier">
        <span className="m1-kicker">Decision dossier</span>
        <h2>
          {props.stage === "understand"
            ? "Resolve the current frontier"
            : props.stage === "direction"
              ? props.direction.name
              : (concepts[props.concept] ?? concepts[0]).title}
        </h2>
        <p>
          {props.stage === "understand"
            ? "Your answer may unlock questions about risk, reward, and session pacing."
            : props.stage === "direction"
              ? props.direction.thesis
              : (concepts[props.concept] ?? concepts[0]).note}
        </p>
        <div className="dossier-lineage">
          <small>Creative lineage</small>
          <span>Brief → GDS 7c41</span>
          <span>{props.direction.name} → VB d18f</span>
          <span>Concept set → 2 / 3</span>
        </div>
        <button
          className="m1-primary"
          onClick={
            props.stage === "understand"
              ? props.answeredQuestions.length === questions.length
                ? props.confirmSharedUnderstanding
                : () => props.setAnswered(true)
              : props.approveDirection
          }
          type="button"
        >
          {props.stage === "understand"
            ? props.answeredQuestions.length === questions.length
              ? "Confirm shared understanding"
              : "Record current decision"
            : "Approve this visual direction"}{" "}
          <span>→</span>
        </button>
      </aside>
    </main>
  );
}

function StudioHeader() {
  return (
    <header className="studio-header">
      <div className="m1-wordmark">
        <Mark />
        <span>FULCRUM</span>
      </div>
      <div className="studio-breadcrumb">
        <span>Projects</span>
        <i>/</i>
        <strong>Prototype session</strong>
        <i>/</i>
        <em>M1 Preproduction</em>
      </div>
      <div className="studio-presence">
        <span className="studio-avatar">Z</span>
        <small>Private workspace</small>
        <ReplayBadge />
      </div>
    </header>
  );
}

function StudioTools() {
  return (
    <nav className="studio-toolrail" aria-label="Workspace tools">
      <button className="active" aria-label="Creative workspace" type="button">
        ◇
      </button>
      <button aria-label="Assets" type="button">
        ▦
      </button>
      <button aria-label="Versions" type="button">
        ⑂
      </button>
      <button aria-label="Comments" type="button">
        ◌
      </button>
      <span />
      <button aria-label="Settings" type="button">
        ⌁
      </button>
    </nav>
  );
}

function StudioProjectPanel(props: VariantProps) {
  return (
    <aside className="studio-project-panel">
      <div className="studio-project-name">
        <small>ACTIVE PROJECT</small>
        <strong>
          {props.projectStarted ? "Prototype session" : "Untitled project"}
        </strong>
        <span>M1 · Creative development</span>
      </div>
      <nav aria-label="Production stages">
        {stages.map((item, index) => {
          const locked =
            (item.id === "direction" && !props.sharedUnderstandingConfirmed) ||
            (item.id === "concepts" && !props.directionApproved);
          const done =
            (item.id === "understand" && props.sharedUnderstandingConfirmed) ||
            (item.id === "direction" && props.directionApproved);
          return (
            <button
              className={`${props.stage === item.id ? "active" : ""} ${locked ? "locked" : ""}`}
              key={item.id}
              onClick={() => props.setStage(item.id)}
              type="button"
            >
              <i>{done ? "✓" : `0${index + 1}`}</i>
              <span>
                <strong>{item.label}</strong>
                <small>{locked ? "Locked" : item.note}</small>
              </span>
            </button>
          );
        })}
      </nav>
      <div className="studio-output-list">
        <small>PROJECT OUTPUTS</small>
        <span>
          <i className={props.sharedUnderstandingConfirmed ? "ready" : ""} />{" "}
          Game Design Spec
        </span>
        <span>
          <i className={props.directionApproved ? "ready" : ""} /> Visual Bible
        </span>
        <span>
          <i className={props.conceptPlanConfirmed ? "ready" : ""} /> Concept
          package
        </span>
      </div>
    </aside>
  );
}

function StudioUnderstanding(props: VariantProps) {
  const item = questions[props.question] ?? questions[0]!;
  const complete = props.answeredQuestions.length === questions.length;
  if (complete)
    return (
      <section className="studio-confirmation">
        <header>
          <span>READY FOR SIGN-OFF</span>
          <small>Game Design Spec · draft 01</small>
        </header>
        <h1>Confirm the game before look development.</h1>
        <blockquote>{props.projectPrompt}</blockquote>
        <div>
          {questions.map((question, index) => (
            <article key={question.branch}>
              <small>{question.branch}</small>
              <strong>{props.answers[index]}</strong>
              <button onClick={() => props.reopenQuestion(index)} type="button">
                Edit
              </button>
            </article>
          ))}
        </div>
        <button onClick={props.confirmSharedUnderstanding} type="button">
          Approve brief and begin look development <span>→</span>
        </button>
      </section>
    );
  return (
    <section className="studio-decision">
      <header>
        <span>DECISION FRONTIER</span>
        <small>
          {String(props.question + 1).padStart(2, "0")} /{" "}
          {String(questions.length).padStart(2, "0")}
        </small>
      </header>
      <div className="studio-decision-body">
        <span className="studio-eyebrow">{item.branch}</span>
        <h1>{item.prompt}</h1>
        <div className="studio-recommendation">
          <span>FULCRUM'S TAKE</span>
          <p>{item.recommendation}</p>
          <small>{item.why}</small>
        </div>
        <label>
          <span>Director's decision</span>
          <textarea
            aria-label="Your answer"
            onChange={(event) =>
              props.setAnswer(props.question, event.target.value)
            }
            value={props.answers[props.question] ?? item.recommendation}
          />
        </label>
      </div>
      <footer>
        <span>{props.answeredQuestions.length} decisions captured</span>
        <button onClick={() => props.setAnswered(true)} type="button">
          Lock decision <i>→</i>
        </button>
      </footer>
    </section>
  );
}

function StudioDirection(props: VariantProps) {
  return (
    <section className="studio-lookdev">
      <header>
        <div>
          <span>LOOK DEVELOPMENT</span>
          <strong>Choose one visual promise</strong>
        </div>
        <small>{props.direction.index} / 03</small>
      </header>
      <div className="studio-lookdev-image">
        <img
          src={props.direction.image}
          alt={`${props.direction.name} visual direction`}
        />
        <span>PREVIEW · VISUAL BIBLE CANDIDATE</span>
      </div>
      <div className="studio-shot-strip">
        {directions.map((direction) => (
          <button
            className={direction.id === props.direction.id ? "active" : ""}
            key={direction.id}
            onClick={() => props.chooseDirection(direction)}
            type="button"
          >
            <img src={direction.image} alt="" />
            <span>
              <small>{direction.index}</small>
              <strong>{direction.name}</strong>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

function StudioInspector(props: VariantProps) {
  const item = questions[props.question] ?? questions[0]!;
  return (
    <aside className="studio-inspector">
      <header>
        <span>INSPECTOR</span>
        <button type="button">•••</button>
      </header>
      {props.stage === "direction" ? (
        <>
          <section className="studio-direction-title">
            <small>SELECTED DIRECTION</small>
            <h2>{props.direction.name}</h2>
            <p>{props.direction.thesis}</p>
          </section>
          <Palette colors={props.direction.palette} />
          <dl>
            <div>
              <dt>Shape</dt>
              <dd>{props.direction.shape}</dd>
            </div>
            <div>
              <dt>Surface</dt>
              <dd>{props.direction.material}</dd>
            </div>
            <div>
              <dt>Light</dt>
              <dd>{props.direction.light}</dd>
            </div>
          </dl>
          <button className="studio-inspector-secondary" type="button">
            Request changes
          </button>
          <button
            className="studio-inspector-primary"
            onClick={props.approveDirection}
            type="button"
          >
            Approve direction <span>→</span>
          </button>
        </>
      ) : (
        <>
          <section className="studio-direction-title">
            <small>PROJECT INTENT</small>
            <h2>
              {props.projectStarted ? "Brief in progress" : "Waiting for pitch"}
            </h2>
            <p>
              {props.projectPrompt ||
                "The original pitch and every confirmed decision remain visible here."}
            </p>
          </section>
          <div className="studio-inspector-section">
            <span>KNOWN CONSTRAINTS</span>
            {projectFacts.slice(0, 4).map((fact) => (
              <small key={fact}>✓ {fact}</small>
            ))}
          </div>
          {props.projectStarted && (
            <div className="studio-inspector-note">
              <span>WHY THIS QUESTION</span>
              <p>{item.why}</p>
            </div>
          )}
        </>
      )}
    </aside>
  );
}

function LegacyStudioVariant(props: VariantProps) {
  return (
    <main className="m1-prototype variant-b-studio">
      <StudioHeader />
      <div className="studio-workspace">
        <StudioTools />
        <StudioProjectPanel {...props} />
        {props.stage === "concepts" ? (
          <div className="studio-concept-host">
            <FocusedConcepts {...props} />
          </div>
        ) : (
          <>
            <div className="studio-canvas">
              {!props.projectStarted ? (
                <ProjectStartB {...props} />
              ) : props.stage === "understand" ? (
                <StudioUnderstanding {...props} />
              ) : (
                <StudioDirection {...props} />
              )}
            </div>
            <StudioInspector {...props} />
          </>
        )}
      </div>
    </main>
  );
}

function ConsoleSidebar(props: VariantProps) {
  return (
    <aside className="console-sidebar">
      <div className="console-brand">
        <Mark />
        <span>FULCRUM</span>
        <small>DIRECTOR CONSOLE</small>
      </div>
      <div className="console-project">
        <small>ACTIVE PROJECT</small>
        <strong>
          {props.projectStarted ? "Prototype session" : "New project"}
        </strong>
        <span>M1 · Preproduction</span>
      </div>
      <nav aria-label="Creative workflow">
        {stages.map((item, index) => {
          const locked =
            (item.id === "direction" && !props.sharedUnderstandingConfirmed) ||
            (item.id === "concepts" && !props.directionApproved);
          const complete =
            (item.id === "understand" && props.sharedUnderstandingConfirmed) ||
            (item.id === "direction" && props.directionApproved);
          return (
            <button
              className={props.stage === item.id ? "active" : ""}
              key={item.id}
              onClick={() => props.setStage(item.id)}
              type="button"
            >
              <i>{complete ? "✓" : `0${index + 1}`}</i>
              <span>
                <strong>{item.label}</strong>
                <small>{locked ? "Not available" : item.note}</small>
              </span>
            </button>
          );
        })}
      </nav>
      <div className="console-health">
        <span>PROJECT TRUTH</span>
        <strong>
          {props.sharedUnderstandingConfirmed
            ? "Brief approved"
            : `${props.answeredQuestions.length} of ${questions.length} decisions`}
        </strong>
        <small>
          {props.directionApproved
            ? `${props.direction.name} approved`
            : "Visual direction pending"}
        </small>
      </div>
      <ReplayBadge />
    </aside>
  );
}

function ConsoleStart(props: VariantProps) {
  return (
    <section className="console-start">
      <span className="console-overline">START A CREATIVE SESSION</span>
      <h1>What are we building?</h1>
      <p>
        Give Fulcrum the unpolished pitch. The console will hold the intent in
        view while you resolve the decisions that matter.
      </p>
      <label>
        <span>PROJECT PITCH</span>
        <textarea
          aria-label="Describe your project"
          onChange={(event) => props.setProjectPrompt(event.target.value)}
          placeholder="Describe the experience in your own words…"
          value={props.projectPrompt}
        />
      </label>
      <button
        disabled={!props.projectPrompt.trim()}
        onClick={props.startProject}
        type="button"
      >
        Begin creative development <span>→</span>
      </button>
      <footer>
        <span>01 ALIGN</span>
        <i />
        <span>02 DIRECT</span>
        <i />
        <span>03 PROVE</span>
      </footer>
    </section>
  );
}

function ConsoleUnderstanding(props: VariantProps) {
  const item = questions[props.question] ?? questions[0]!;
  const complete = props.answeredQuestions.length === questions.length;
  if (complete)
    return (
      <section className="console-confirm">
        <header>
          <span>SHARED UNDERSTANDING</span>
          <small>READY TO APPROVE</small>
        </header>
        <h1>The creative brief is ready.</h1>
        <blockquote>{props.projectPrompt}</blockquote>
        <div>
          {questions.map((question, index) => (
            <article key={question.branch}>
              <small>{question.branch}</small>
              <p>{props.answers[index]}</p>
              <button onClick={() => props.reopenQuestion(index)} type="button">
                Revise
              </button>
            </article>
          ))}
        </div>
        <button onClick={props.confirmSharedUnderstanding} type="button">
          Approve and open visual direction <span>→</span>
        </button>
      </section>
    );
  return (
    <section className="console-understanding">
      <header>
        <span>DECISION {String(props.question + 1).padStart(2, "0")}</span>
        <small>
          {props.answeredQuestions.length} CAPTURED ·{" "}
          {questions.length - props.answeredQuestions.length} OPEN
        </small>
      </header>
      <div className="console-question">
        <span className="console-overline">{item.branch}</span>
        <h1>{item.prompt}</h1>
        <label>
          <span>YOUR DECISION</span>
          <textarea
            aria-label="Your answer"
            onChange={(event) =>
              props.setAnswer(props.question, event.target.value)
            }
            value={props.answers[props.question] ?? item.recommendation}
          />
        </label>
        <button onClick={() => props.setAnswered(true)} type="button">
          Commit decision <span>→</span>
        </button>
      </div>
      <aside>
        <span>FULCRUM'S READ</span>
        <p>{item.recommendation}</p>
        <small>{item.why}</small>
        <div>
          {projectFacts.slice(0, 3).map((fact) => (
            <em key={fact}>✓ {fact}</em>
          ))}
        </div>
      </aside>
    </section>
  );
}

function ConsoleDirection(props: VariantProps) {
  return (
    <section className="console-direction">
      <nav>
        {directions.map((direction) => (
          <button
            className={direction.id === props.direction.id ? "active" : ""}
            key={direction.id}
            onClick={() => props.chooseDirection(direction)}
            type="button"
          >
            <span>{direction.index}</span>
            <strong>{direction.name}</strong>
            <small>{direction.thesis}</small>
          </button>
        ))}
      </nav>
      <div className="console-direction-image">
        <img
          src={props.direction.image}
          alt={`${props.direction.name} visual direction`}
        />
        <span>FULL FRAME · {props.direction.index} / 03</span>
      </div>
      <aside>
        <span className="console-overline">SELECTED VISUAL PROMISE</span>
        <h1>{props.direction.name}</h1>
        <p>{props.direction.thesis}</p>
        <Palette colors={props.direction.palette} />
        <dl>
          <div>
            <dt>Shape</dt>
            <dd>{props.direction.shape}</dd>
          </div>
          <div>
            <dt>Surface</dt>
            <dd>{props.direction.material}</dd>
          </div>
          <div>
            <dt>Light</dt>
            <dd>{props.direction.light}</dd>
          </div>
        </dl>
        <button className="console-request" type="button">
          Request focused change
        </button>
        <button
          className="console-approve"
          onClick={props.approveDirection}
          type="button"
        >
          Approve direction <span>→</span>
        </button>
      </aside>
    </section>
  );
}

function LegacyDirectorVariant(props: VariantProps) {
  return (
    <main className="m1-prototype variant-a-console">
      <ConsoleSidebar {...props} />
      <section className="console-workspace">
        {props.stage === "concepts" ? (
          <FocusedConcepts {...props} />
        ) : !props.projectStarted ? (
          <ConsoleStart {...props} />
        ) : props.stage === "understand" ? (
          <ConsoleUnderstanding {...props} />
        ) : (
          <ConsoleDirection {...props} />
        )}
      </section>
    </main>
  );
}

function LabHeader(props: VariantProps) {
  return (
    <header className="lab-header">
      <div className="lab-brand">
        <Mark />
        <span>FULCRUM</span>
        <small>VISUAL DEVELOPMENT LAB</small>
      </div>
      <nav>
        {stages.map((item, index) => (
          <button
            className={props.stage === item.id ? "active" : ""}
            key={item.id}
            onClick={() => props.setStage(item.id)}
            type="button"
          >
            <i>0{index + 1}</i>
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
      <div>
        <span className="lab-project">PROTOTYPE SESSION</span>
        <ReplayBadge />
      </div>
    </header>
  );
}

function LabStart(props: VariantProps) {
  return (
    <section className="lab-start">
      <aside>
        <span>01</span>
        <strong>THE PITCH</strong>
        <p>
          Every visual decision begins with a shared description of the player
          experience.
        </p>
      </aside>
      <div>
        <span className="lab-overline">NEW PROJECT / M1</span>
        <h1>Give the idea a place to become visible.</h1>
        <textarea
          aria-label="Describe your project"
          onChange={(event) => props.setProjectPrompt(event.target.value)}
          placeholder="I want to make a game where…"
          value={props.projectPrompt}
        />
        <button
          disabled={!props.projectPrompt.trim()}
          onClick={props.startProject}
          type="button"
        >
          Create project canvas <span>↗</span>
        </button>
      </div>
      <aside>
        <small>NEXT</small>
        <strong>Shared understanding</strong>
        <p>Two consequential questions before any artwork is chosen.</p>
      </aside>
    </section>
  );
}

function LabUnderstanding(props: VariantProps) {
  const item = questions[props.question] ?? questions[0]!;
  const complete = props.answeredQuestions.length === questions.length;
  if (complete)
    return (
      <section className="lab-confirm">
        <div className="lab-confirm-title">
          <span>BRIEF / READY</span>
          <h1>Shared understanding</h1>
          <p>{props.projectPrompt}</p>
        </div>
        <div className="lab-confirm-decisions">
          {questions.map((question, index) => (
            <button
              key={question.branch}
              onClick={() => props.reopenQuestion(index)}
              type="button"
            >
              <small>{question.branch}</small>
              <strong>{props.answers[index]}</strong>
              <span>Edit ↗</span>
            </button>
          ))}
        </div>
        <footer>
          <small>
            Visual development remains locked until this is approved.
          </small>
          <button onClick={props.confirmSharedUnderstanding} type="button">
            Approve brief <span>→</span>
          </button>
        </footer>
      </section>
    );
  return (
    <section className="lab-understanding">
      <div className="lab-question-number">
        <span>QUESTION</span>
        <strong>0{props.question + 1}</strong>
        <small>OF 0{questions.length}</small>
      </div>
      <div className="lab-question">
        <span className="lab-overline">{item.branch}</span>
        <h1>{item.prompt}</h1>
        <div className="lab-suggestion">
          <span>RECOMMENDED START</span>
          <p>{item.recommendation}</p>
          <small>{item.why}</small>
        </div>
        <textarea
          aria-label="Your answer"
          onChange={(event) =>
            props.setAnswer(props.question, event.target.value)
          }
          value={props.answers[props.question] ?? item.recommendation}
        />
        <button onClick={() => props.setAnswered(true)} type="button">
          Place decision on canvas <span>→</span>
        </button>
      </div>
      <aside>
        <span>PROJECT INTENT</span>
        <blockquote>{props.projectPrompt}</blockquote>
        <div>
          {projectFacts.slice(0, 4).map((fact) => (
            <small key={fact}>✓ {fact}</small>
          ))}
        </div>
      </aside>
    </section>
  );
}

function LabDirection(props: VariantProps) {
  return (
    <section className="lab-direction">
      <header>
        <div>
          <span className="lab-overline">LOOK DEVELOPMENT / THREE ROUTES</span>
          <h1>Choose the world players should remember.</h1>
        </div>
        <strong>{props.direction.index} / 03</strong>
      </header>
      <div className="lab-direction-main">
        <div className="lab-art-mat">
          <img
            src={props.direction.image}
            alt={`${props.direction.name} visual direction`}
          />
          <span>NO CROP · SAVED IMAGEGEN STUDY</span>
        </div>
        <aside>
          <h2>{props.direction.name}</h2>
          <p>{props.direction.thesis}</p>
          <Palette colors={props.direction.palette} />
          <dl>
            <div>
              <dt>Shape</dt>
              <dd>{props.direction.shape}</dd>
            </div>
            <div>
              <dt>Surface</dt>
              <dd>{props.direction.material}</dd>
            </div>
            <div>
              <dt>Light</dt>
              <dd>{props.direction.light}</dd>
            </div>
          </dl>
          <button onClick={props.approveDirection} type="button">
            Select this visual direction <span>→</span>
          </button>
        </aside>
      </div>
      <nav>
        {directions.map((direction) => (
          <button
            className={direction.id === props.direction.id ? "active" : ""}
            key={direction.id}
            onClick={() => props.chooseDirection(direction)}
            type="button"
          >
            <img src={direction.image} alt="" />
            <span>
              <small>{direction.index}</small>
              <strong>{direction.name}</strong>
            </span>
          </button>
        ))}
      </nav>
    </section>
  );
}

function LegacyLabVariant(props: VariantProps) {
  return (
    <main className="m1-prototype variant-b-lab">
      <LabHeader {...props} />
      {props.stage === "concepts" ? (
        <div className="lab-concept-host">
          <FocusedConcepts {...props} />
        </div>
      ) : !props.projectStarted ? (
        <LabStart {...props} />
      ) : props.stage === "understand" ? (
        <LabUnderstanding {...props} />
      ) : (
        <LabDirection {...props} />
      )}
      <div className="lab-state">
        <span>
          {props.sharedUnderstandingConfirmed
            ? "BRIEF APPROVED"
            : `${props.answeredQuestions.length}/${questions.length} DECISIONS`}
        </span>
        <i />
        <span>
          {props.directionApproved
            ? `${props.direction.name.toUpperCase()} SELECTED`
            : "LOOK DEV OPEN"}
        </span>
        <i />
        <span>
          {props.conceptPlanConfirmed
            ? "CONCEPT PLAN APPROVED"
            : "CONCEPTS PENDING"}
        </span>
      </div>
    </main>
  );
}

void LegacyVariantA;
void LegacyStudioVariant;
void LegacyDirectorVariant;
void LegacyLabVariant;

function ForgeHud(props: VariantProps) {
  return (
    <header className="forge-hud">
      <div className="forge-logo">
        <Mark />
        <span>FULCRUM</span>
        <small>WORLD FORGE / M1</small>
      </div>
      <nav>
        {stages.map((item, index) => (
          <button
            className={props.stage === item.id ? "active" : ""}
            key={item.id}
            onClick={() => props.setStage(item.id)}
            type="button"
          >
            <i>0{index + 1}</i>
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
      <div className="forge-signal">
        <span>LIVE CREATIVE SESSION</span>
        <i />
      </div>
    </header>
  );
}

function ForgeStart(props: VariantProps) {
  return (
    <section className="forge-start">
      <div className="forge-atmosphere">
        <i />
        <i />
        <i />
      </div>
      <div className="forge-start-copy">
        <span>INITIALIZE A WORLD</span>
        <h1>
          Describe the feeling.
          <br />
          We’ll find the game.
        </h1>
        <p>
          No forms. No preselected answers. Start with the experience you want a
          player to remember.
        </p>
      </div>
      <label>
        <span>CREATIVE TRANSMISSION / 001</span>
        <textarea
          aria-label="Describe your project"
          onChange={(event) => props.setProjectPrompt(event.target.value)}
          placeholder="Transmit the idea in your own words…"
          value={props.projectPrompt}
        />
        <button
          disabled={!props.projectPrompt.trim()}
          onClick={props.startProject}
          type="button"
        >
          Enter the forge <span>↗</span>
        </button>
      </label>
      <div className="forge-coordinates">
        <span>M1 / SHARED UNDERSTANDING</span>
        <span>PRIVATE SESSION</span>
        <span>IMAGEGEN STANDBY</span>
      </div>
    </section>
  );
}

function ForgeUnderstanding(props: VariantProps) {
  const item = questions[props.question] ?? questions[0]!;
  const complete = props.answeredQuestions.length === questions.length;
  if (complete)
    return (
      <section className="forge-confirm">
        <div className="forge-confirm-orbit">
          <span>02 DECISIONS RESOLVED</span>
          <i />
        </div>
        <div className="forge-confirm-copy">
          <span>SHARED UNDERSTANDING / LOCKED IN VIEW</span>
          <h1>The world has a center now.</h1>
          <blockquote>{props.projectPrompt}</blockquote>
          <div>
            {questions.map((question, index) => (
              <button
                key={question.branch}
                onClick={() => props.reopenQuestion(index)}
                type="button"
              >
                <small>{question.branch}</small>
                <strong>{props.answers[index]}</strong>
                <i>REOPEN ↗</i>
              </button>
            ))}
          </div>
          <button
            className="forge-action"
            onClick={props.confirmSharedUnderstanding}
            type="button"
          >
            Commit the brief to project truth <span>→</span>
          </button>
        </div>
      </section>
    );
  return (
    <section className="forge-session">
      <div className="forge-session-index">
        <span>INTERROGATION</span>
        <strong>0{props.question + 1}</strong>
        <small>/ 0{questions.length}</small>
        <i />
      </div>
      <article>
        <span>{item.branch}</span>
        <h1>{item.prompt}</h1>
        <label>
          <small>DIRECTOR INPUT</small>
          <textarea
            aria-label="Your answer"
            onChange={(event) =>
              props.setAnswer(props.question, event.target.value)
            }
            value={props.answers[props.question] ?? item.recommendation}
          />
        </label>
        <button
          className="forge-action"
          onClick={() => props.setAnswered(true)}
          type="button"
        >
          Resolve this branch <span>→</span>
        </button>
      </article>
      <aside>
        <div className="forge-lens">
          <i />
          <span>FULCRUM LENS</span>
        </div>
        <p>{item.recommendation}</p>
        <small>{item.why}</small>
        <div className="forge-memory">
          {projectFacts.slice(0, 3).map((fact) => (
            <em key={fact}>✓ {fact}</em>
          ))}
        </div>
      </aside>
    </section>
  );
}

function ForgeDirection(props: VariantProps) {
  return (
    <section className="forge-direction">
      <div className="forge-art">
        <img className="forge-art-blur" src={props.direction.image} alt="" />
        <img
          className="forge-art-full"
          src={props.direction.image}
          alt={`${props.direction.name} visual direction`}
        />
        <span>FULL FRAME / NO CROP</span>
      </div>
      <nav>
        {directions.map((direction) => (
          <button
            className={direction.id === props.direction.id ? "active" : ""}
            key={direction.id}
            onClick={() => props.chooseDirection(direction)}
            type="button"
          >
            <img src={direction.image} alt="" />
            <span>
              <i>{direction.index}</i>
              <strong>{direction.name}</strong>
            </span>
          </button>
        ))}
      </nav>
      <aside>
        <span>VISUAL SIGNAL {props.direction.index} / 03</span>
        <h1>{props.direction.name}</h1>
        <p>{props.direction.thesis}</p>
        <div className="forge-token">
          <small>SHAPE</small>
          <strong>{props.direction.shape}</strong>
        </div>
        <div className="forge-token">
          <small>MATERIAL</small>
          <strong>{props.direction.material}</strong>
        </div>
        <Palette colors={props.direction.palette} />
        <button
          className="forge-action"
          onClick={props.approveDirection}
          type="button"
        >
          Make this the visual promise <span>→</span>
        </button>
      </aside>
    </section>
  );
}

function LegacyForgeVariant(props: VariantProps) {
  return (
    <main className="m1-prototype variant-a-forge">
      <ForgeHud {...props} />
      {props.stage === "concepts" ? (
        <div className="forge-concept-host">
          <FocusedConcepts {...props} />
        </div>
      ) : !props.projectStarted ? (
        <ForgeStart {...props} />
      ) : props.stage === "understand" ? (
        <ForgeUnderstanding {...props} />
      ) : (
        <ForgeDirection {...props} />
      )}
      <div className="forge-state">
        <span>
          {props.sharedUnderstandingConfirmed
            ? "WORLD MODEL STABLE"
            : `${props.answeredQuestions.length}/${questions.length} BRANCHES RESOLVED`}
        </span>
        <i />
        <span>
          {props.directionApproved
            ? `${props.direction.name.toUpperCase()} COMMITTED`
            : "VISUAL SIGNAL OPEN"}
        </span>
      </div>
    </main>
  );
}

function BoardTopbar(props: VariantProps) {
  return (
    <header className="board-topbar">
      <div>
        <Mark />
        <span>FULCRUM</span>
        <small>STORY ROOM</small>
      </div>
      <nav>
        {stages.map((item, index) => (
          <button
            className={props.stage === item.id ? "active" : ""}
            key={item.id}
            onClick={() => props.setStage(item.id)}
            type="button"
          >
            <i>{index + 1}</i>
            {item.label}
          </button>
        ))}
      </nav>
      <span>PINBOARD 01 · PRIVATE</span>
    </header>
  );
}

function BoardStart(props: VariantProps) {
  return (
    <section className="board-start">
      <svg
        className="board-thread"
        viewBox="0 0 1200 700"
        preserveAspectRatio="none"
      >
        <path d="M110 170 C340 80 410 300 610 210 S980 120 1120 280" />
        <path d="M160 560 C380 450 560 630 780 470 S1030 430 1120 540" />
      </svg>
      <aside className="board-note note-a">
        <span>THE RULE</span>
        <strong>
          Nothing visual gets chosen before the game is understood.
        </strong>
      </aside>
      <div className="board-pitch-sheet">
        <i className="board-tape" />
        <span>NEW PROJECT / FIRST PIN</span>
        <h1>Put the game on the wall.</h1>
        <p>
          Write the pitch you would give the team when the room is still empty.
        </p>
        <textarea
          aria-label="Describe your project"
          onChange={(event) => props.setProjectPrompt(event.target.value)}
          placeholder="The player is… The world is… The tension comes from…"
          value={props.projectPrompt}
        />
        <button
          disabled={!props.projectPrompt.trim()}
          onClick={props.startProject}
          type="button"
        >
          Pin the pitch <span>＋</span>
        </button>
      </div>
      <aside className="board-note note-b">
        <span>THEN</span>
        <strong>Interrogate → direct → make the proof visible.</strong>
      </aside>
      <div className="board-floor-label">M1 CREATIVE DEVELOPMENT · WALL 01</div>
    </section>
  );
}

function BoardUnderstanding(props: VariantProps) {
  const item = questions[props.question] ?? questions[0]!;
  const complete = props.answeredQuestions.length === questions.length;
  if (complete)
    return (
      <section className="board-confirm">
        <div className="board-brief-card">
          <i className="board-pin" />
          <span>ORIGINAL PITCH</span>
          <p>{props.projectPrompt}</p>
        </div>
        <div className="board-confirm-title">
          <span>READY FOR THE RED STRING</span>
          <h1>Does this wall describe the same game you have in mind?</h1>
        </div>
        <div className="board-answer-pins">
          {questions.map((question, index) => (
            <button
              key={question.branch}
              onClick={() => props.reopenQuestion(index)}
              type="button"
            >
              <i className="board-tape" />
              <small>{question.branch}</small>
              <strong>{props.answers[index]}</strong>
              <span>EDIT NOTE ↗</span>
            </button>
          ))}
        </div>
        <button
          className="board-approve"
          onClick={props.confirmSharedUnderstanding}
          type="button"
        >
          Approve the wall and begin look development <span>→</span>
        </button>
      </section>
    );
  return (
    <section className="board-question-room">
      <div className="board-brief-card">
        <i className="board-pin" />
        <span>THE PITCH</span>
        <p>{props.projectPrompt}</p>
      </div>
      <article className="board-question-sheet">
        <i className="board-tape" />
        <span>
          {item.branch} · QUESTION 0{props.question + 1}
        </span>
        <h1>{item.prompt}</h1>
        <textarea
          aria-label="Your answer"
          onChange={(event) =>
            props.setAnswer(props.question, event.target.value)
          }
          value={props.answers[props.question] ?? item.recommendation}
        />
        <button onClick={() => props.setAnswered(true)} type="button">
          Pin this decision <span>＋</span>
        </button>
      </article>
      <aside className="board-recommendation">
        <span>FULCRUM'S MARGIN NOTE</span>
        <p>{item.recommendation}</p>
        <small>{item.why}</small>
        <i>↳ Edit freely. This is not selected for you.</i>
      </aside>
      <div className="board-progress-thread">
        <span className="done">PITCH</span>
        <i />
        <span className={props.answeredQuestions.length > 0 ? "done" : ""}>
          DECISION 01
        </span>
        <i />
        <span>DECISION 02</span>
      </div>
    </section>
  );
}

function BoardDirection(props: VariantProps) {
  return (
    <section className="board-direction">
      <div className="board-direction-title">
        <span>LOOK DEVELOPMENT / PIN 0{props.direction.index}</span>
        <h1>Which print belongs at the center of the room?</h1>
      </div>
      <div className="board-print">
        <i className="board-tape tape-left" />
        <i className="board-tape tape-right" />
        <img
          src={props.direction.image}
          alt={`${props.direction.name} visual direction`}
        />
        <span>FULL PRINT · NO CROP</span>
      </div>
      <aside className="board-direction-note">
        <i className="board-pin" />
        <span>SELECTED PRINT</span>
        <h2>{props.direction.name}</h2>
        <p>{props.direction.thesis}</p>
        <dl>
          <div>
            <dt>Shape</dt>
            <dd>{props.direction.shape}</dd>
          </div>
          <div>
            <dt>Surface</dt>
            <dd>{props.direction.material}</dd>
          </div>
          <div>
            <dt>Light</dt>
            <dd>{props.direction.light}</dd>
          </div>
        </dl>
        <button onClick={props.approveDirection} type="button">
          Circle this direction <span>◯</span>
        </button>
      </aside>
      <nav>
        {directions.map((direction) => (
          <button
            className={direction.id === props.direction.id ? "active" : ""}
            key={direction.id}
            onClick={() => props.chooseDirection(direction)}
            type="button"
          >
            <img src={direction.image} alt="" />
            <span>
              <i>{direction.index}</i>
              <strong>{direction.name}</strong>
            </span>
          </button>
        ))}
      </nav>
    </section>
  );
}

function LegacyBoardVariant(props: VariantProps) {
  return (
    <main className="m1-prototype variant-b-board">
      <BoardTopbar {...props} />
      {props.stage === "concepts" ? (
        <div className="board-concept-host">
          <FocusedConcepts {...props} />
        </div>
      ) : !props.projectStarted ? (
        <BoardStart {...props} />
      ) : props.stage === "understand" ? (
        <BoardUnderstanding {...props} />
      ) : (
        <BoardDirection {...props} />
      )}
      <div className="board-state">
        <span>
          {props.sharedUnderstandingConfirmed
            ? "BRIEF PINNED"
            : `${props.answeredQuestions.length + 1} PIECES ON WALL`}
        </span>
        <span>
          {props.directionApproved
            ? `${props.direction.name} CIRCLED`
            : "LOOK DEV OPEN"}
        </span>
        <span>
          {props.conceptPlanConfirmed
            ? "CONCEPT PLAN PINNED"
            : "CONCEPTS WAITING"}
        </span>
      </div>
    </main>
  );
}

void LegacyForgeVariant;
void LegacyBoardVariant;

function CyberHeader(props: VariantProps) {
  return (
    <header className="cyber-header">
      <div className="cyber-wordmark">
        <Mark />
        <span>FULCRUM</span>
        <small>NEURAL CREATIVE SYSTEM</small>
      </div>
      <nav aria-label="Creative workflow">
        {stages.map((item, index) => {
          const activeIndex = stages.findIndex(
            (stage) => stage.id === props.stage,
          );
          return (
            <button
              className={
                item.id === props.stage
                  ? "active"
                  : index < activeIndex
                    ? "done"
                    : ""
              }
              key={item.id}
              onClick={() => props.setStage(item.id)}
              type="button"
            >
              <i>{index < activeIndex ? "✓" : `0${index + 1}`}</i>
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
      <div className="cyber-online">
        <i /> <span>IMAGEGEN LINK</span> ONLINE
      </div>
    </header>
  );
}

function CyberStart(props: VariantProps) {
  return (
    <section className="cyber-start">
      <div className="cyber-skyline" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
        <i />
      </div>
      <div className="cyber-start-copy">
        <span>NEW CREATIVE UPLINK // M1</span>
        <h1>
          JACK YOUR IDEA
          <br />
          <em>INTO THE GRID.</em>
        </h1>
        <p>
          Describe the game in your own words. Fulcrum will interrogate the
          unknowns before it generates a single frame.
        </p>
      </div>
      <label className="cyber-terminal">
        <span>
          <i /> INPUT_CHANNEL / PROJECT_PITCH
        </span>
        <textarea
          aria-label="Describe your project"
          onChange={(event) => props.setProjectPrompt(event.target.value)}
          placeholder="> What should the player feel, do, and remember?"
          value={props.projectPrompt}
        />
        <button
          disabled={!props.projectPrompt.trim()}
          onClick={props.startProject}
          type="button"
        >
          ESTABLISH UPLINK <span>↗</span>
        </button>
      </label>
      <div className="cyber-ticker" aria-hidden="true">
        <span>NO HIDDEN SELECTIONS</span>
        <span>HUMAN DIRECTED</span>
        <span>IMAGEGEN READY</span>
        <span>FULL PROVENANCE</span>
      </div>
    </section>
  );
}

function CyberUnderstanding(props: VariantProps) {
  const item = questions[props.question] ?? questions[0]!;
  const complete = props.answeredQuestions.length === questions.length;

  if (complete)
    return (
      <section className="cyber-confirm">
        <div className="cyber-confirm-signal" aria-hidden="true">
          <div>
            <i />
            <i />
            <i />
            <i />
          </div>
          <span>SYNC 100%</span>
        </div>
        <article>
          <span>SHARED UNDERSTANDING // READY TO COMMIT</span>
          <h1>THE SIGNAL IS CLEAN.</h1>
          <blockquote>{props.projectPrompt}</blockquote>
          <div className="cyber-decision-grid">
            {questions.map((question, index) => (
              <button
                key={question.branch}
                onClick={() => props.reopenQuestion(index)}
                type="button"
              >
                <small>{question.branch}</small>
                <strong>{props.answers[index]}</strong>
                <i>EDIT NODE ↗</i>
              </button>
            ))}
          </div>
          <button
            className="cyber-primary"
            onClick={props.confirmSharedUnderstanding}
            type="button"
          >
            COMMIT PROJECT TRUTH <span>→</span>
          </button>
        </article>
      </section>
    );

  return (
    <section className="cyber-interview">
      <aside className="cyber-question-map">
        <span>DECISION TREE</span>
        {questions.map((question, index) => (
          <button
            className={
              index === props.question
                ? "active"
                : props.answeredQuestions.includes(index)
                  ? "done"
                  : ""
            }
            key={question.branch}
            onClick={() =>
              props.answeredQuestions.includes(index) &&
              props.reopenQuestion(index)
            }
            type="button"
          >
            <i>
              {props.answeredQuestions.includes(index) ? "✓" : `0${index + 1}`}
            </i>
            <span>{question.branch}</span>
          </button>
        ))}
        <div className="cyber-project-read">
          <small>ORIGINAL TRANSMISSION</small>
          <p>{props.projectPrompt}</p>
        </div>
      </aside>
      <article className="cyber-question-panel">
        <span>LIVE INTERROGATION / NODE 0{props.question + 1}</span>
        <h1>{item.prompt}</h1>
        <label>
          <small>YOUR DIRECTIVE</small>
          <textarea
            aria-label="Your answer"
            onChange={(event) =>
              props.setAnswer(props.question, event.target.value)
            }
            value={props.answers[props.question] ?? item.recommendation}
          />
        </label>
        <button
          className="cyber-primary"
          onClick={() => props.setAnswered(true)}
          type="button"
        >
          LOCK THIS DECISION <span>→</span>
        </button>
      </article>
      <aside className="cyber-advisor">
        <span>FULCRUM // TACTICAL READ</span>
        <strong>{item.recommendation}</strong>
        <p>{item.why}</p>
        <div className="cyber-wave" aria-hidden="true">
          {Array.from({ length: 18 }, (_, index) => (
            <i key={index} />
          ))}
        </div>
        <small>
          You make the decision. This is a recommended starting point.
        </small>
      </aside>
    </section>
  );
}

function CyberDirection(props: VariantProps) {
  return (
    <section className="cyber-direction">
      <div className="cyber-direction-art">
        <img className="cyber-art-ghost" src={props.direction.image} alt="" />
        <img
          className="cyber-art-frame"
          src={props.direction.image}
          alt={`${props.direction.name} visual direction`}
        />
        <div className="cyber-crosshair" aria-hidden="true" />
        <span>IMAGEGEN FEED // FULL FRAME // NO CROP</span>
      </div>
      <aside className="cyber-direction-console">
        <span>VISUAL ROUTE {props.direction.index} / 03</span>
        <h1 data-text={props.direction.name}>{props.direction.name}</h1>
        <p>{props.direction.thesis}</p>
        <Palette colors={props.direction.palette} />
        <dl>
          <div>
            <dt>FORM</dt>
            <dd>{props.direction.shape}</dd>
          </div>
          <div>
            <dt>SURFACE</dt>
            <dd>{props.direction.material}</dd>
          </div>
          <div>
            <dt>LIGHT</dt>
            <dd>{props.direction.light}</dd>
          </div>
        </dl>
        <button className="cyber-secondary" type="button">
          REQUEST SIGNAL CHANGE
        </button>
        <button
          className="cyber-primary"
          onClick={props.approveDirection}
          type="button"
        >
          COMMIT THIS WORLD <span>→</span>
        </button>
      </aside>
      <nav className="cyber-direction-strip">
        {directions.map((direction) => (
          <button
            className={direction.id === props.direction.id ? "active" : ""}
            key={direction.id}
            onClick={() => props.chooseDirection(direction)}
            type="button"
          >
            <img src={direction.image} alt="" />
            <span>
              <i>{direction.index}</i>
              <strong>{direction.name}</strong>
              <small>
                {direction.id === props.direction.id ? "ON AIR" : "STANDBY"}
              </small>
            </span>
          </button>
        ))}
      </nav>
    </section>
  );
}

function VariantA(props: VariantProps) {
  return (
    <main className="m1-prototype variant-a-cyber">
      <CyberHeader {...props} />
      {props.stage === "concepts" ? (
        <div className="cyber-concept-host">
          <FocusedConcepts {...props} />
        </div>
      ) : !props.projectStarted ? (
        <CyberStart {...props} />
      ) : props.stage === "understand" ? (
        <CyberUnderstanding {...props} />
      ) : (
        <CyberDirection {...props} />
      )}
      <div className="cyber-status">
        <span>SESSION // {props.projectStarted ? "ACTIVE" : "STANDBY"}</span>
        <span>
          SYNC // {props.answeredQuestions.length}/{questions.length}
        </span>
        <span>
          WORLD //{" "}
          {props.directionApproved ? props.direction.name : "UNCOMMITTED"}
        </span>
      </div>
    </main>
  );
}

/* ------------------------------------------------------------------ *
 * Variant B — "World Forge" voxel workshop.
 * Warm paper workshop where the brief is built one block at a time.
 * All styles are scoped under .variant-b-voxel.
 * ------------------------------------------------------------------ */

type VoxelBlock = {
  x: number;
  y: number;
  z: number;
  at: number;
  tone: "stone" | "wood" | "accent" | "glow";
};

/** The world is a plan before it is a place: every block has a level at
 *  which it gets placed, so the diorama grows with the workflow. */
const voxelBlueprint: VoxelBlock[] = [
  { x: 1, y: 1, z: 0, at: 0, tone: "stone" },
  { x: 3, y: 1, z: 0, at: 0, tone: "stone" },
  { x: 1, y: 3, z: 0, at: 0, tone: "stone" },
  { x: 2, y: 2, z: 0, at: 1, tone: "stone" },
  { x: 3, y: 3, z: 0, at: 1, tone: "wood" },
  { x: 2, y: 2, z: 1, at: 2, tone: "stone" },
  { x: 1, y: 3, z: 1, at: 2, tone: "wood" },
  { x: 2, y: 2, z: 2, at: 3, tone: "stone" },
  { x: 0, y: 2, z: 0, at: 3, tone: "wood" },
  { x: 2, y: 2, z: 3, at: 4, tone: "glow" },
  { x: 4, y: 2, z: 0, at: 4, tone: "stone" },
  { x: 3, y: 1, z: 1, at: 5, tone: "accent" },
  { x: 1, y: 1, z: 1, at: 5, tone: "accent" },
  { x: 4, y: 4, z: 0, at: 6, tone: "accent" },
];

const voxelPlate = Array.from({ length: 25 }, (_value, index) => ({
  x: index % 5,
  y: Math.floor(index / 5),
}));

/** Painter order for the isometric camera: far blocks first. */
const voxelDrawOrder = [...voxelBlueprint].sort(
  (a, b) => a.x + a.y + a.z - (b.x + b.y + b.z),
);

const voxelMaxLevel = 6;

/** Height of the finished stack on a tile, so the builder stands on top of
 *  whatever is already there instead of hovering in mid air. */
function voxelStack(x: number, y: number, level: number) {
  return voxelBlueprint.reduce(
    (top, block) =>
      block.at <= level && block.x === x && block.y === y
        ? Math.max(top, block.z + 1)
        : top,
    0,
  );
}

/** Where the builder plants his feet to place a given block: the first
 *  neighbouring tile still on the plate. */
function voxelBuildSpot(block: VoxelBlock, level: number) {
  const candidates = [
    [block.x + 1, block.y],
    [block.x, block.y + 1],
    [block.x - 1, block.y],
    [block.x, block.y - 1],
  ];
  for (const [x, y] of candidates) {
    if (x === undefined || y === undefined) continue;
    if (x < 0 || x > 4 || y < 0 || y > 4) continue;
    return { x, y, z: voxelStack(x, y, level) };
  }
  return { x: block.x, y: block.y, z: block.z };
}

/** The builder sprite, drawn as pixel art: one ink pass (every structural part
 *  grown by a pixel) then the colour pass on top, which is what gives the
 *  chunky workshop outline without hand-placing outline pixels. */
type VoxelSpriteRect = [number, number, number, number, string];

const voxelBuilderBody: VoxelSpriteRect[] = [
  [5, 0, 6, 2, "hat"],
  [3, 2, 10, 2, "hat"],
  [4, 4, 8, 5, "skin"],
  [3, 9, 10, 2, "scarf"],
  [4, 11, 8, 5, "suit"],
  [2, 11, 2, 4, "suit"],
  [4, 16, 3, 4, "boot"],
  [9, 16, 3, 4, "boot"],
];

const voxelBuilderDetail: VoxelSpriteRect[] = [
  [3, 3, 10, 1, "hat-shade"],
  [6, 6, 1, 2, "ink"],
  [9, 6, 1, 2, "ink"],
  [6, 12, 4, 3, "suit-shade"],
  [4, 19, 3, 1, "ink"],
  [9, 19, 3, 1, "ink"],
];

const voxelBuilderArm: VoxelSpriteRect[] = [
  [12, 11, 2, 4, "suit"],
  [13, 5, 1, 7, "wood"],
  [11, 2, 5, 3, "steel"],
];

function voxelSpritePass(rects: VoxelSpriteRect[], ink: boolean) {
  return rects.map(([x, y, w, h, tone]) => (
    <rect
      className={ink ? "vx-b-ink" : `vx-b-${tone}`}
      height={ink ? h + 2 : h}
      key={`${ink ? "i" : "c"}-${x}-${y}-${tone}`}
      width={ink ? w + 2 : w}
      x={ink ? x - 1 : x}
      y={ink ? y - 1 : y}
    />
  ));
}

function VoxelBuilder({
  build,
  level,
}: {
  build: { seq: number; block: VoxelBlock } | null;
  level: number;
}) {
  const spot = build ? voxelBuildSpot(build.block, level) : null;
  return (
    <div
      className="vx-pin vx-builder"
      data-building={build ? "true" : "false"}
      style={
        spot
          ? ({
              "--bx": spot.x + 0.5,
              "--by": spot.y + 0.5,
              "--bz": spot.z,
            } as CSSProperties)
          : undefined
      }
    >
      <span className="vx-pin-anchor">
        <span className="vx-builder-hop" key={build ? build.seq : "idle"}>
          <span className="vx-builder-body">
            <svg
              className="vx-builder-art"
              shapeRendering="crispEdges"
              viewBox="-1 -1 18 22"
            >
              <g>{voxelSpritePass(voxelBuilderBody, true)}</g>
              <g>{voxelSpritePass(voxelBuilderBody, false)}</g>
              <g>{voxelSpritePass(voxelBuilderDetail, false)}</g>
              <g className="vx-builder-arm">
                {voxelSpritePass(voxelBuilderArm, true)}
                {voxelSpritePass(voxelBuilderArm, false)}
              </g>
            </svg>
          </span>
          <span className="vx-builder-dust">
            <i />
            <i />
            <i />
          </span>
        </span>
      </span>
    </div>
  );
}

/** The stage shell is keyed per screen, so the diorama unmounts between two
 *  decisions and a plain ref can never see the level go up. One module-level
 *  watermark survives those remounts — only ever one workflow diorama is on
 *  screen at a time — which is what lets the builder react to a placement that
 *  happened during the screen change. */
let voxelSeenLevel: number | null = null;

function voxelFreshBlock(level: number) {
  return [...voxelDrawOrder].reverse().find((block) => block.at === level);
}

function voxelLevel(props: VariantProps) {
  return (
    (props.projectStarted ? 1 : 0) +
    props.answeredQuestions.length +
    (props.sharedUnderstandingConfirmed ? 1 : 0) +
    (props.directionApproved ? 1 : 0) +
    (props.selectedConcepts.length > 0 ? 1 : 0)
  );
}

function VoxelCube({
  tone = "stone",
  className = "",
}: {
  tone?: string;
  className?: string;
}) {
  return (
    <span className={`vx-cube ${className}`.trim()} data-tone={tone}>
      <span className="vx-face vx-top" />
      <span className="vx-face vx-south" />
      <span className="vx-face vx-east" />
    </span>
  );
}

/* Retired from variant B: Rusty Rover does the block-placement duty on every
   World Forge screen now. The sprite stays in the file because the finale
   choreography and the other prototypes still reference its styles. */
void VoxelBuilder;

function VoxelWorld({
  level,
  direction,
  styled,
  size = "md",
  follows = true,
}: {
  level: number;
  direction: Direction;
  styled: boolean;
  size?: "sm" | "md" | "lg";
  /** false for the finale diorama, which is a fixed tableau rather than a
   *  running record of the workflow and stages its own choreography. */
  follows?: boolean;
}) {
  const tint = styled
    ? ({
        "--vx-stone": direction.palette[2],
        "--vx-wood": direction.palette[1],
        "--vx-accent": direction.palette[3],
        "--vx-glow": direction.palette[3],
        "--vx-ground": direction.palette[0],
        "--vx-ground-alt": direction.palette[4],
      } as CSSProperties)
    : undefined;

  /* A decision just placed a block. Derived during render (not in an effect)
     so the fresh block carries its delayed drop in the very same commit as
     data-on — otherwise the cube lands before the builder gets there. */
  const buildSeq = useRef(0);
  const [build, setBuild] = useState<{
    seq: number;
    block: VoxelBlock;
  } | null>(() => {
    if (!follows || voxelSeenLevel === null || level <= voxelSeenLevel) {
      return null;
    }
    const fresh = voxelFreshBlock(level);
    return fresh ? { seq: 0, block: fresh } : null;
  });
  const seenLevel = useRef(level);
  if (follows && seenLevel.current !== level) {
    const grew = level > seenLevel.current;
    seenLevel.current = level;
    buildSeq.current += 1;
    const fresh = grew ? voxelFreshBlock(level) : undefined;
    setBuild(fresh ? { seq: buildSeq.current, block: fresh } : null);
  }
  useEffect(() => {
    if (follows) voxelSeenLevel = level;
  }, [follows, level]);

  return (
    <div
      aria-hidden="true"
      className={`vx-world vx-world-${size}`}
      data-styled={styled ? "true" : "false"}
      style={tint}
    >
      <span className="vx-sun" />
      <span className="vx-cloud vx-cloud-a" />
      <span className="vx-cloud vx-cloud-b" />
      <div className="vx-scene">
        <div className="vx-base">
          <span className="vx-face vx-top" />
          <span className="vx-face vx-south" />
          <span className="vx-face vx-east" />
        </div>
        <div className="vx-plate">
          {voxelPlate.map((tile) => (
            <i
              key={`${tile.x}-${tile.y}`}
              style={
                {
                  "--x": tile.x,
                  "--y": tile.y,
                  "--tile": (tile.x + tile.y) % 2,
                } as CSSProperties
              }
            />
          ))}
        </div>
        {voxelDrawOrder
          .filter((block) => block.at <= level + 2)
          .map((block) => (
            <div
              className="vx-block"
              /* The level a block belongs to is on the element as well as in
                 its style, so the mascot can aim the block in his hands at the
                 tile the next decision lights up. */
              data-at={block.at}
              data-fresh={build && block.at === level ? "true" : "false"}
              data-on={block.at <= level ? "true" : "false"}
              data-tone={block.tone}
              key={`${block.x}-${block.y}-${block.z}`}
              style={
                {
                  "--x": block.x,
                  "--y": block.y,
                  "--z": block.z,
                  "--at": block.at,
                } as CSSProperties
              }
            >
              <span className="vx-face vx-top" />
              <span className="vx-face vx-south" />
              <span className="vx-face vx-east" />
            </div>
          ))}
        {/* Living details. Inert everywhere until the finale reveals them.
            The flag carries a hook of its own: the element is a zero-size
            point in the scene's own 3D space, so its rect *is* the summit —
            which is what the mascot aims the flag in his claws at. */}
        <div
          className="vx-pin vx-flag"
          data-mascot-flag="true"
          style={{ "--bx": 2.5, "--by": 2.5, "--bz": 4 } as CSSProperties}
        >
          <span className="vx-pin-anchor">
            <b />
            <i />
          </span>
        </div>
      </div>
      {/* Chimney smoke lives outside the 3D scene on purpose: inside it, a
          billboard sitting on a cube's top face gets sorted behind that cube
          no matter how far it is pushed toward the camera. Its position is the
          same isometric projection done by hand, so it still lands on the
          front house. */}
      <div className="vx-smoke" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
    </div>
  );
}

function VoxelTopbar(props: VariantProps) {
  const title = props.projectPrompt.trim();
  return (
    <header className="vx-topbar">
      <div className="vx-brand">
        <VoxelCube className="vx-cube-brand" tone="glow" />
        <span>
          <strong>FULCRUM</strong>
          <small>WORLD FORGE</small>
        </span>
      </div>
      <div className="vx-plaque">
        <small>WORLD SLOT 01</small>
        <strong>
          {title
            ? title.length > 62
              ? `${title.slice(0, 62)}…`
              : title
            : "Untitled world"}
        </strong>
      </div>
      <div className="vx-session">
        <i />
        AUTOSAVED
      </div>
    </header>
  );
}

function VoxelHotbar(props: VariantProps) {
  const slots: Array<{
    key: string;
    label: string;
    tone: string;
    filled: boolean;
    status: string;
    stage?: M1Stage;
    locked: boolean;
    active: boolean;
  }> = [
    {
      key: "pitch",
      label: "PITCH",
      tone: "wood",
      filled: props.projectStarted,
      status: props.projectStarted ? "Locked in" : "Empty slot",
      locked: false,
      active: !props.projectStarted,
    },
    {
      key: "brief",
      label: "BRIEF",
      tone: "accent",
      filled: props.sharedUnderstandingConfirmed,
      status: props.sharedUnderstandingConfirmed
        ? "Signed off"
        : `${props.answeredQuestions.length} of ${questions.length} answered`,
      stage: "understand",
      locked: !props.projectStarted,
      active: props.projectStarted && props.stage === "understand",
    },
    {
      key: "style",
      label: "STYLE",
      tone: "glow",
      filled: props.directionApproved,
      status: props.directionApproved
        ? props.direction.name
        : props.sharedUnderstandingConfirmed
          ? "Choose one"
          : "Needs brief",
      stage: "direction",
      locked: !props.sharedUnderstandingConfirmed,
      active: props.projectStarted && props.stage === "direction",
    },
    {
      key: "images",
      label: "IMAGES",
      tone: "stone",
      filled: props.selectedConcepts.length === concepts.length,
      status: props.directionApproved
        ? `${props.selectedConcepts.length} of ${concepts.length} kept`
        : "Needs style",
      stage: "concepts",
      locked: !props.directionApproved,
      active: props.projectStarted && props.stage === "concepts",
    },
  ];

  return (
    <footer className="vx-hotbar" aria-label="Workflow hotbar">
      {slots.map((slot, index) => (
        <button
          className="vx-slot"
          data-active={slot.active ? "true" : "false"}
          data-filled={slot.filled ? "true" : "false"}
          data-locked={slot.locked ? "true" : "false"}
          disabled={!slot.stage || slot.locked}
          key={slot.key}
          onClick={() => slot.stage && props.setStage(slot.stage)}
          type="button"
        >
          <em>{index + 1}</em>
          <span className="vx-slot-item">
            {slot.filled ? (
              <VoxelCube className="vx-cube-slot" tone={slot.tone} />
            ) : (
              <i className="vx-slot-empty" />
            )}
          </span>
          <span className="vx-slot-copy">
            <strong>{slot.label}</strong>
            <small>{slot.status}</small>
          </span>
        </button>
      ))}
    </footer>
  );
}

/** Every World Forge screen is handed the level Rusty has actually built to,
 *  not the level the clicks have bought: the diorama grows when he puts the
 *  block down, which is what makes his trip the cause of it. */
type VoxelProps = VariantProps & { level: number };

function VoxelStart(props: VoxelProps) {
  const level = props.level;
  const placed = voxelBlueprint.filter((block) => block.at <= level).length;
  return (
    <section className="vx-start">
      <div className="vx-start-copy">
        <span className="vx-kicker">
          <i />
          New world · slot 01
        </span>
        <h1>
          Build the game
          <br />
          one block
          <br />
          at a time.
        </h1>
        <p>
          Describe the game you want. The forge turns it into a brief, a visual
          language, and the first real artwork — and you approve every block
          before it is placed.
        </p>
        <label className="vx-composer">
          <span className="vx-composer-head">
            <strong>Name the world you want to build</strong>
            <small>{props.projectPrompt.trim().length} chars</small>
          </span>
          <textarea
            aria-label="Describe your project"
            onChange={(event) => props.setProjectPrompt(event.target.value)}
            placeholder="A game where the player…"
            value={props.projectPrompt}
          />
          <span className="vx-composer-foot">
            <small>Replay prototype · subscription ImageGen · no API key</small>
            <button
              className="vx-primary"
              disabled={!props.projectPrompt.trim()}
              onClick={props.startProject}
              type="button"
            >
              Create world <i>▸</i>
            </button>
          </span>
        </label>
      </div>
      <div className="vx-start-world">
        <VoxelWorld
          direction={props.direction}
          level={level}
          size="lg"
          styled={false}
        />
        <div className="vx-world-readout">
          <span>Build plan</span>
          <strong>
            {placed} of {voxelBlueprint.length} blocks placed · ghosted blocks
            are waiting on your decisions
          </strong>
        </div>
      </div>
    </section>
  );
}

function VoxelQuestion(props: VoxelProps) {
  const item = questions[props.question] ?? questions[0]!;
  const level = props.level;
  /* Same unit as the start-page plaque: the diorama's own block count, so the
     sidebar meter and the plaque never tell two different stories. */
  const placed = voxelBlueprint.filter((block) => block.at <= level).length;
  return (
    <section className="vx-understand">
      <aside className="vx-rail">
        <div className="vx-rail-head">
          <span className="vx-kicker">
            <i />
            Build log
          </span>
          <h2>Understand the game</h2>
        </div>
        <ol className="vx-quests">
          {questions.map((question, index) => (
            <li
              data-state={
                index === props.question
                  ? "active"
                  : props.answeredQuestions.includes(index)
                    ? "done"
                    : "open"
              }
              key={question.branch}
            >
              <i>{props.answeredQuestions.includes(index) ? "✓" : index + 1}</i>
              <span>{question.branch}</span>
            </li>
          ))}
        </ol>
        {/* Rusty's home on every question screen: he is mounted once, outside
            the stage, and docks himself into this frame by measuring it. */}
        <div className="vx-rail-world" data-mascot-frame="capture">
          <VoxelWorld
            direction={props.direction}
            level={level}
            size="sm"
            styled={false}
          />
        </div>
        <div className="vx-meter">
          <span>
            <small>Blocks placed</small>
            <strong>
              {placed} / {voxelBlueprint.length}
            </strong>
          </span>
          <i>
            <b
              style={{ width: `${(placed / voxelBlueprint.length) * 100}%` }}
            />
          </i>
        </div>
      </aside>

      <article className="vx-question">
        <header>
          <span className="vx-tag">
            Question {props.question + 1} of {questions.length}
          </span>
          <span className="vx-tag vx-tag-ghost">{item.branch}</span>
        </header>
        <h1>{item.prompt}</h1>
        <p className="vx-why">{item.why}</p>
        <div className="vx-advisor">
          <span className="vx-advisor-face" aria-hidden="true">
            <i />
            <i />
          </span>
          <p>
            <strong>Forge guide</strong>
            {item.recommendation}
          </p>
        </div>
        <label className="vx-answer">
          <span>Your answer — edit anything you disagree with</span>
          <textarea
            aria-label="Your answer"
            onChange={(event) =>
              props.setAnswer(props.question, event.target.value)
            }
            value={props.answers[props.question] ?? item.recommendation}
          />
        </label>
        <footer>
          <small>
            Nothing is generated until the whole brief is signed off.
          </small>
          <button
            className="vx-primary"
            onClick={() => props.setAnswered(true)}
            type="button"
          >
            Place this block <i>▸</i>
          </button>
        </footer>
      </article>
    </section>
  );
}

function VoxelSignoff(props: VoxelProps) {
  return (
    <section className="vx-signoff">
      <div className="vx-signoff-world">
        <VoxelWorld
          direction={props.direction}
          level={props.level}
          size="md"
          styled={false}
        />
        <span className="vx-stamp">Brief complete</span>
      </div>
      <article className="vx-brief">
        <span className="vx-kicker">
          <i />
          World brief · review before saving
        </span>
        <h1>This is what Fulcrum understood.</h1>
        <blockquote>{props.projectPrompt}</blockquote>
        <div className="vx-brief-rows">
          {questions.map((question, index) => (
            <button
              key={question.branch}
              onClick={() => props.reopenQuestion(index)}
              type="button"
            >
              <small>{question.branch}</small>
              <strong>{props.answers[index]}</strong>
              <i>Edit</i>
            </button>
          ))}
        </div>
        <button
          className="vx-primary vx-primary-wide"
          onClick={props.confirmSharedUnderstanding}
          type="button"
        >
          Save brief & unlock look dev <i>▸</i>
        </button>
      </article>
    </section>
  );
}

function VoxelUnderstanding(props: VoxelProps) {
  return props.answeredQuestions.length === questions.length ? (
    <VoxelSignoff {...props} />
  ) : (
    <VoxelQuestion {...props} />
  );
}

function VoxelDirection(props: VoxelProps) {
  return (
    <section className="vx-direction">
      <header className="vx-direction-head">
        <span className="vx-kicker">
          <i />
          Look dev unlocked
        </span>
        <h1>Choose your world style.</h1>
        <p>Three visual promises — not three camera angles.</p>
      </header>

      <div className="vx-screen">
        <img
          alt={`${props.direction.name} visual direction`}
          src={props.direction.image}
        />
        <span className="vx-screen-tag">
          preview_{props.direction.index}.png · full frame
        </span>
      </div>

      <aside className="vx-spec">
        <span className="vx-tag">Cartridge {props.direction.index}</span>
        <h2>{props.direction.name}</h2>
        <p>{props.direction.thesis}</p>
        <dl>
          <div>
            <dt>Shape</dt>
            <dd>{props.direction.shape}</dd>
          </div>
          <div>
            <dt>Material</dt>
            <dd>{props.direction.material}</dd>
          </div>
          <div>
            <dt>Light</dt>
            <dd>{props.direction.light}</dd>
          </div>
        </dl>
        <button
          className="vx-primary vx-primary-wide"
          onClick={props.approveDirection}
          type="button"
        >
          Load this world <i>▸</i>
        </button>
      </aside>

      <nav className="vx-cartridges" aria-label="Visual directions">
        {directions.map((direction) => (
          <button
            data-active={direction.id === props.direction.id ? "true" : "false"}
            key={direction.id}
            onClick={() => props.chooseDirection(direction)}
            type="button"
          >
            <img alt="" src={direction.image} />
            <span>
              <small>Cartridge {direction.index}</small>
              <strong>{direction.name}</strong>
            </span>
            <em aria-hidden="true">
              {direction.palette.slice(0, 4).map((color) => (
                <i key={color} style={{ backgroundColor: color }} />
              ))}
            </em>
          </button>
        ))}
      </nav>

      {/* Rusty's home on the look-dev screen: nothing is built here, so he
          simply moves into the preview shelf and sits at the end of it,
          watching the world he has built wear its new palette. */}
      <div className="vx-restyle" data-mascot-frame="panel">
        <VoxelWorld
          direction={props.direction}
          level={props.level}
          size="sm"
          styled
        />
        <span>Your world in {props.direction.name}</span>
      </div>
    </section>
  );
}

function VariantB(props: VariantProps) {
  const screenKey = !props.projectStarted
    ? "start"
    : props.stage === "understand"
      ? props.answeredQuestions.length === questions.length
        ? "signoff"
        : `question-${props.question}`
      : props.stage;
  /* Which corner of the screen Rusty gets. The canvas itself is mounted once,
     outside the keyed stage, so a screen change moves him — it never makes him
     poof in again. */
  const mascotScreen = !props.projectStarted
    ? "start"
    : props.stage === "understand"
      ? props.answeredQuestions.length === questions.length
        ? "signoff"
        : "question"
      : props.stage === "concepts" &&
          props.selectedConcepts.length === concepts.length
        ? /* The final gallery uses every pixel it has, so once all three images
             are kept he climbs up to the header rule and watches from there. */
          "package"
        : props.stage;

  /* Which of the shared concepts component's four screens is showing. It owns
     that state privately, so the only honest way to read it is to watch what
     it renders — the same thing the stylesheet does with :has(). Decoration
     only: nothing here ever feeds back into the shared workflow. */
  const conceptHost = useRef<HTMLDivElement>(null);
  const [conceptScreen, setConceptScreen] = useState("");
  useLayoutEffect(() => {
    const node = conceptHost.current;
    if (!node) {
      setConceptScreen("");
      return;
    }
    const read = () =>
      setConceptScreen(node.firstElementChild?.className ?? "");
    read();
    const observer = new MutationObserver(read);
    /* subtree, because the shared component keeps the same <div> across all
       four of its screens and only swaps its className: watching the host's
       own attributes would never see a single one of them. */
    observer.observe(node, {
      attributeFilter: ["class"],
      attributes: true,
      childList: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }, [props.stage]);
  /* The image-review pages are a photograph and its controls, edge to edge:
     there is no corner left for him that is not on top of a button, so he
     steps off those screens entirely and comes back — still seated, never
     re-poofed — on the one after. */
  const showMascot = conceptScreen !== "single-concept-review";
  const finished = conceptScreen === "concept-complete";

  /* The flag on the finished world is his to plant. It stays out of the
     diorama until the one he is carrying lands on the summit, and the timer is
     insurance only — reduced motion, a canvas that never came up, a browser
     with no WebGL at all still get their flag. */
  const [flagPlaced, setFlagPlaced] = useState(false);
  useEffect(() => {
    if (!finished) {
      setFlagPlaced(false);
      return;
    }
    const timer = window.setTimeout(() => setFlagPlaced(true), 13000);
    return () => window.clearTimeout(timer);
  }, [finished]);
  const plantFlag = useCallback(() => setFlagPlaced(true), []);

  /* One block per decision: the same count the diorama grows by. */
  const decisions = voxelLevel(props);
  /* …but it grows when Rusty gets there, not when the click lands. He fetches
     a block and walks it over, and the cube it becomes drops into the grid the
     moment his does — so the diorama is a record of what he has built rather
     than a counter that happens to have a mascot next to it. A collapsed
     backlog catches up in one go, because he only makes the one trip. */
  const built = useRef(decisions);
  const [shown, setShown] = useState(decisions);
  const level = Math.min(shown, decisions);
  built.current = decisions;
  useEffect(() => {
    /* Reopening a question takes a block back off the world straight away. */
    setShown((current) => (current > decisions ? decisions : current));
  }, [decisions]);
  useEffect(() => {
    if (shown >= decisions) return;
    /* Insurance, not choreography: a trip is 11 s at the very worst, so this
       only ever fires if the canvas never came up at all. */
    const timer = window.setTimeout(() => setShown(decisions), 24000);
    return () => window.clearTimeout(timer);
  }, [decisions, shown]);

  const [forged, setForged] = useState(0);
  useEffect(() => {
    if (!forged) return;
    const timer = window.setTimeout(() => setForged(0), 900);
    return () => window.clearTimeout(timer);
  }, [forged]);
  const place = useCallback(() => {
    setShown(built.current);
    setForged((count) => count + 1);
  }, []);

  return (
    <main
      className="m1-prototype variant-b-voxel"
      data-forged={forged ? "true" : "false"}
      data-stage={props.stage}
    >
      <div className="vx-paper" aria-hidden="true" />
      <VoxelTopbar {...props} />
      {props.stage === "concepts" ? (
        <div className="vx-stage vx-stage-concepts">
          <div className="voxel-concept-host" ref={conceptHost}>
            <FocusedConcepts {...props} />
          </div>
          {/* Decoration only: revealed by CSS :has() once the shared component
              reaches its completion screen, so the finished world is the last
              thing you see. Never affects the shared concepts logic. */}
          <div
            className="vx-finale"
            data-flag={flagPlaced ? "placed" : "pending"}
            data-mascot-frame="finale"
          >
            <VoxelWorld
              direction={props.direction}
              follows={false}
              level={voxelMaxLevel}
              size="md"
              styled
            />
            <span>World forged · {props.direction.name}</span>
          </div>
        </div>
      ) : (
        <div className="vx-stage" key={screenKey}>
          {!props.projectStarted ? (
            <VoxelStart {...props} level={level} />
          ) : props.stage === "understand" ? (
            <VoxelUnderstanding {...props} level={level} />
          ) : (
            <VoxelDirection {...props} level={level} />
          )}
        </div>
      )}
      {showMascot ? (
        <MascotStage
          decisions={decisions}
          onFlagPlaced={plantFlag}
          onPlace={place}
          screen={mascotScreen}
        />
      ) : null}
      <VoxelHotbar {...props} />
    </main>
  );
}

/* ------------------------------------------------------------------ *
 * Variant C — "The Review Room".
 * A near-black screening room. One warm spotlight. Decisions get pinned
 * to the wall on a red thread and stamped when they are signed off.
 * ------------------------------------------------------------------ */

const rrDust = Array.from({ length: 16 }, (_value, index) => ({
  left: `${4 + ((index * 41) % 92)}%`,
  top: `${8 + ((index * 27) % 78)}%`,
  size: `${1 + ((index * 7) % 3)}px`,
  drift: `${((index * 23) % 44) - 22}px`,
  duration: `${13 + ((index * 5) % 11)}s`,
  delay: `-${(index * 1.7) % 13}s`,
  fade: `${0.16 + ((index * 3) % 5) / 18}`,
}));

function rrPrefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Local-only ceremony: hold the commit for one beat so the APPROVED stamp
 * can land before the shared state machine advances. No shared state is
 * changed — the same handler runs, just a moment later.
 */
function useSignOff(commit: () => void, delay = 760) {
  const [signing, setSigning] = useState(false);
  const timer = useRef<number>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const sign = () => {
    if (signing) return;
    if (rrPrefersReducedMotion()) {
      commit();
      return;
    }
    setSigning(true);
    timer.current = window.setTimeout(commit, delay);
  };
  return [signing, sign] as const;
}

function RoomAmbience({ focus }: { focus: string }) {
  return (
    <div className={`rr-room rr-room-${focus}`} aria-hidden="true">
      <div className="rr-wall" />
      <div className="rr-beam" />
      <div className="rr-dust">
        {rrDust.map((mote, index) => (
          <i
            key={index}
            style={
              {
                left: mote.left,
                top: mote.top,
                width: mote.size,
                height: mote.size,
                "--rr-drift": mote.drift,
                "--rr-dur": mote.duration,
                "--rr-delay": mote.delay,
                "--rr-fade": mote.fade,
              } as CSSProperties
            }
          />
        ))}
      </div>
      <div className="rr-grain" />
    </div>
  );
}

function ReviewHeader(props: VariantProps) {
  const stageStatus = (id: M1Stage) => {
    if (id === "understand")
      return props.sharedUnderstandingConfirmed ? "done" : "open";
    if (id === "direction")
      return !props.sharedUnderstandingConfirmed
        ? "locked"
        : props.directionApproved
          ? "done"
          : "open";
    return !props.directionApproved
      ? "locked"
      : props.selectedConcepts.length === concepts.length
        ? "done"
        : "open";
  };
  return (
    <header className="rr-topbar">
      <div className="rr-brand">
        <Mark />
        <b>Fulcrum</b>
        <i>The Review Room</i>
      </div>
      <nav className="rr-thread" aria-label="Creative workflow">
        {stages.map((item, index) => {
          const status = stageStatus(item.id);
          return (
            <button
              className={`rr-mark is-${status}${
                props.stage === item.id ? " is-current" : ""
              }`}
              key={item.id}
              onClick={() => props.setStage(item.id)}
              type="button"
            >
              <i aria-hidden="true">
                {status === "done" ? "✓" : `0${index + 1}`}
              </i>
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
      <span className="rr-slate">
        <em aria-hidden="true" />
        Subscription ImageGen · no API key
      </span>
    </header>
  );
}

function ReviewSignOff(props: VariantProps) {
  const [signing, sign] = useSignOff(props.confirmSharedUnderstanding);
  return (
    <section className="rr-stage rr-signoff" key="rr-signoff">
      <div className="rr-signoff-head">
        <span className="rr-overline">Shared understanding · sign-off</span>
        <h1>
          This is the game
          <em>we are making.</em>
        </h1>
      </div>
      <blockquote>
        <span>The pitch, as you wrote it</span>
        {props.projectPrompt}
      </blockquote>
      <div className="rr-cards">
        {questions.map((question, index) => (
          <button
            className="rr-card"
            key={question.branch}
            onClick={() => props.reopenQuestion(index)}
            type="button"
          >
            <span className="rr-pin" aria-hidden="true" />
            <small>{question.branch}</small>
            <strong>{props.answers[index]}</strong>
            <i>Reopen ↗</i>
          </button>
        ))}
      </div>
      <div className="rr-signoff-act">
        <p>
          Nothing visual is generated until this brief is signed. Reopen any
          card to change your answer.
        </p>
        <button
          className={`rr-act rr-act-lg${signing ? " is-signing" : ""}`}
          onClick={sign}
          type="button"
        >
          <span>{signing ? "Signed" : "Approve the brief"}</span>
          <i aria-hidden="true">→</i>
        </button>
      </div>
      {signing && (
        <span className="rr-stamp" aria-hidden="true">
          Approved
        </span>
      )}
    </section>
  );
}

function ReviewUnderstanding(props: VariantProps) {
  const item = questions[props.question] ?? questions[0]!;
  if (props.answeredQuestions.length === questions.length)
    return <ReviewSignOff {...props} />;
  return (
    <section className="rr-stage rr-understand" key="rr-understand">
      <div className="rr-take">
        <span className="rr-overline">
          Take {String(props.question + 1).padStart(2, "0")} · {item.branch}
        </span>
        <h1>{item.prompt}</h1>
        <label className="rr-sheet">
          <span className="rr-sheet-label">Your direction</span>
          <textarea
            aria-label="Your answer"
            onChange={(event) =>
              props.setAnswer(props.question, event.target.value)
            }
            value={props.answers[props.question] ?? item.recommendation}
          />
        </label>
        <button
          className="rr-act"
          onClick={() => props.setAnswered(true)}
          type="button"
        >
          <span>Commit decision</span>
          <i aria-hidden="true">→</i>
        </button>
      </div>
      <aside className="rr-aside">
        <article className="rr-card rr-card-note">
          <span className="rr-pin" aria-hidden="true" />
          <small>Fulcrum recommends</small>
          <strong>{item.recommendation}</strong>
          <em>{item.why}</em>
        </article>
        <ul className="rr-facts">
          {projectFacts.slice(0, 3).map((fact) => (
            <li key={fact}>
              <i aria-hidden="true">✓</i>
              {fact}
            </li>
          ))}
        </ul>
        <div className="rr-counter">
          <b>
            {props.answeredQuestions.length}/{questions.length}
          </b>
          <span>decisions on the wall</span>
        </div>
      </aside>
    </section>
  );
}

function ReviewDirection(props: VariantProps) {
  const [signing, sign] = useSignOff(props.approveDirection);
  return (
    <section className="rr-stage rr-direction" key="rr-direction">
      <figure className="rr-plate rr-plate-hero">
        <span className="rr-tape rr-tape-a" aria-hidden="true" />
        <span className="rr-tape rr-tape-b" aria-hidden="true" />
        <img
          key={props.direction.id}
          src={props.direction.image}
          alt={`${props.direction.name} visual direction`}
        />
        <figcaption>
          <span>Plate {props.direction.index} / 03</span>
          <small>Full frame · no crop</small>
        </figcaption>
        {signing && (
          <span className="rr-stamp rr-stamp-plate" aria-hidden="true">
            Approved
          </span>
        )}
      </figure>
      <aside className="rr-notes">
        <span className="rr-overline">Reel 02 · visual direction</span>
        <h1>{props.direction.name}</h1>
        <p>{props.direction.thesis}</p>
        <dl className="rr-tokens">
          <div>
            <dt>Shape</dt>
            <dd>{props.direction.shape}</dd>
          </div>
          <div>
            <dt>Surface</dt>
            <dd>{props.direction.material}</dd>
          </div>
          <div>
            <dt>Light</dt>
            <dd>{props.direction.light}</dd>
          </div>
        </dl>
        <Palette colors={props.direction.palette} />
        <div className="rr-notes-act">
          <button className="rr-ghost" type="button">
            Leave a note
          </button>
          <button
            className={`rr-act${signing ? " is-signing" : ""}`}
            onClick={sign}
            type="button"
          >
            <span>{signing ? "Signed" : "Approve the look"}</span>
            <i aria-hidden="true">→</i>
          </button>
        </div>
      </aside>
      <div className="rr-strip">
        <span className="rr-strip-label">On the wall</span>
        <div className="rr-strip-row">
          {directions.map((direction) => (
            <button
              className={`rr-thumb${
                direction.id === props.direction.id ? " is-current" : ""
              }`}
              key={direction.id}
              onClick={() => props.chooseDirection(direction)}
              type="button"
            >
              <img src={direction.image} alt="" />
              <span>
                <i>{direction.index}</i>
                <strong>{direction.name}</strong>
              </span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

function VariantC(props: VariantProps) {
  const focus = !props.projectStarted ? "start" : props.stage;
  return (
    <main className="m1-prototype variant-c-review">
      <RoomAmbience focus={focus} />
      <ReviewHeader {...props} />
      {!props.projectStarted ? (
        <ProjectStartC {...props} />
      ) : props.stage === "understand" ? (
        <ReviewUnderstanding {...props} />
      ) : props.stage === "direction" ? (
        <ReviewDirection {...props} />
      ) : (
        <div className="review-concept-host" key="rr-concepts">
          <FocusedConcepts {...props} />
        </div>
      )}
      <div className="rr-statusline">
        <span>
          <i aria-hidden="true" />
          {props.projectStarted ? "Prototype session" : "Untitled project"}
        </span>
        <span>
          {props.sharedUnderstandingConfirmed
            ? "Brief approved"
            : `${props.answeredQuestions.length} / ${questions.length} decisions`}
        </span>
        <span>
          {props.directionApproved
            ? `${props.direction.name} approved`
            : "Look dev pending"}
        </span>
        <span>
          {props.selectedConcepts.length} / {concepts.length} images kept
        </span>
      </div>
    </main>
  );
}

function PrototypeSwitcher({ current }: { current: VariantKey }) {
  const variants: VariantKey[] = ["A", "B", "C"];
  const cycle = (offset: number) => {
    const index = variants.indexOf(current);
    setVariantInUrl(
      variants[(index + offset + variants.length) % variants.length]!,
    );
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable='true']")) return;
      if (event.key === "ArrowLeft") cycle(-1);
      if (event.key === "ArrowRight") cycle(1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  if (!import.meta.env.DEV) return null;
  return (
    <div
      className="prototype-switcher"
      role="toolbar"
      aria-label="Prototype variant switcher"
    >
      <button
        aria-label="Previous variant"
        onClick={() => cycle(-1)}
        type="button"
      >
        ←
      </button>
      <span>
        <small>COMPARE APP DESIGN · STATE IS SHARED</small>
        <strong>
          {current} — {variantNames[current]}
        </strong>
      </span>
      <button aria-label="Next variant" onClick={() => cycle(1)} type="button">
        →
      </button>
    </div>
  );
}

export function M1Prototype() {
  const [variant, setVariant] = useState<VariantKey>(getVariant);
  const [stage, setRawStage] = useState<M1Stage>("understand");
  const [direction, setDirection] = useState(directions[0]!);
  const [projectPrompt, setProjectPrompt] = useState("");
  const [projectStarted, setProjectStarted] = useState(false);
  const [question, setQuestion] = useState(0);
  const [answers, setAnswers] = useState<Record<number, string>>(() =>
    Object.fromEntries(
      questions.map((item, index) => [index, item.recommendation]),
    ),
  );
  const [answeredQuestions, setAnsweredQuestions] = useState<number[]>([]);
  const [sharedUnderstandingConfirmed, setSharedUnderstandingConfirmed] =
    useState(false);
  const [directionApproved, setDirectionApproved] = useState(false);
  const [concept, setConcept] = useState(0);
  const [conceptPlanConfirmed, setConceptPlanConfirmed] = useState(false);
  const [regeneratedConcepts, setRegeneratedConcepts] = useState<number[]>([]);
  const [selectedConcepts, setSelectedConcepts] = useState<number[]>([]);

  const setStage = (nextStage: M1Stage) => {
    if (nextStage === "direction" && !sharedUnderstandingConfirmed) return;
    if (nextStage === "concepts" && !directionApproved) return;
    setRawStage(nextStage);
  };

  const startProject = () => {
    if (!projectPrompt.trim()) return;
    setProjectStarted(true);
  };

  const setAnswer = (index: number, value: string) =>
    setAnswers((current) => ({ ...current, [index]: value }));

  const setAnswered = (value: boolean) => {
    const nextAnswered = value
      ? Array.from(new Set([...answeredQuestions, question]))
      : answeredQuestions.filter((index) => index !== question);
    setAnsweredQuestions(nextAnswered);
    if (value) {
      const nextQuestion = questions.findIndex(
        (_item, index) => !nextAnswered.includes(index),
      );
      if (nextQuestion >= 0) setQuestion(nextQuestion);
    }
  };

  const reopenQuestion = (index: number) => {
    setQuestion(index);
    setAnsweredQuestions((current) =>
      current.filter((answeredIndex) => answeredIndex !== index),
    );
  };

  const confirmSharedUnderstanding = () => {
    if (answeredQuestions.length !== questions.length) return;
    setSharedUnderstandingConfirmed(true);
    setRawStage("direction");
  };

  const chooseDirection = (nextDirection: Direction) => {
    setDirection(nextDirection);
    setDirectionApproved(false);
    setConceptPlanConfirmed(false);
    setRegeneratedConcepts([]);
    setSelectedConcepts([]);
  };

  const approveDirection = () => {
    setDirectionApproved(true);
    setRawStage("concepts");
  };

  const regenerateConcept = (index: number) => {
    setRegeneratedConcepts((current) =>
      current.includes(index) ? current : [...current, index],
    );
    setSelectedConcepts((current) =>
      current.filter((selectedIndex) => selectedIndex !== index),
    );
  };

  const selectConceptRevision = (index: number) =>
    setSelectedConcepts((current) =>
      current.includes(index) ? current : [...current, index],
    );

  useEffect(() => {
    const sync = () => setVariant(getVariant());
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  const state = useMemo(
    () => ({
      stage,
      direction,
      projectPrompt,
      projectStarted,
      question,
      answered: answeredQuestions.includes(question),
      answers,
      answeredQuestions,
      sharedUnderstandingConfirmed,
      directionApproved,
      concept,
      conceptPlanConfirmed,
      regeneratedConcepts,
      selectedConcepts,
    }),
    [
      stage,
      direction,
      projectPrompt,
      projectStarted,
      question,
      answers,
      answeredQuestions,
      sharedUnderstandingConfirmed,
      directionApproved,
      concept,
      conceptPlanConfirmed,
      regeneratedConcepts,
      selectedConcepts,
    ],
  );
  const props: VariantProps = {
    ...state,
    setStage,
    chooseDirection,
    setProjectPrompt,
    startProject,
    setQuestion,
    setAnswer,
    setAnswered,
    reopenQuestion,
    confirmSharedUnderstanding,
    approveDirection,
    setConcept,
    setConceptPlanConfirmed,
    regenerateConcept,
    selectConceptRevision,
  };

  return (
    <>
      {variant === "A" && <VariantA {...props} />}
      {variant === "B" && <VariantB {...props} />}
      {variant === "C" && <VariantC {...props} />}
      <PrototypeSwitcher current={variant} />
    </>
  );
}
