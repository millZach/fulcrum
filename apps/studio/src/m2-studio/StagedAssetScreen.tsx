/**
 * The staged 3D generation screen: one asset, full width, from the first paid
 * geometry task to an accepted model.
 *
 * Everything on it is read from the snapshot the orchestrator returns. The CTAs
 * are `offers[]` rendered verbatim — labels and prices both — because the gate
 * that authorizes a spend and the button that shows its price must be the same
 * list. `acknowledgedCredits` echoes the offer exactly, so a screen drawn
 * against a stale price cannot authorize a different one.
 *
 * Polling is a read of a task that is already paid for, so this screen may run
 * it on a timer; it stops the moment the task leaves `running`.
 */
import { useEffect, useRef, useState } from "react";

import type { AssetStageView, ProjectSnapshot } from "@fulcrum/domain";

import { api, isApiError } from "../api.js";
import { StagedModelViewer } from "./StagedModelViewer.js";
import {
  STAGE_LABELS,
  STAGE_RUNNING_COPY,
  clipOptions,
  creditLabel,
  offerNote,
  offerViews,
  previewCaption,
  rigEligibilityLabel,
  rigOverrideControl,
  shouldPollStage,
  terminalNote,
  type StagedClip,
  type StagedOfferView,
} from "./staged-asset-view.js";

/** Fast enough to feel live, slow enough that a stage takes several ticks. */
const POLL_INTERVAL_MS = 1_500;

const STAGE_LADDER = ["geometry", "texture", "rig", "animation"] as const;

const refusal = (error: unknown): string =>
  isApiError(error)
    ? error.detail
    : error instanceof Error
      ? error.message
      : "That request could not be completed.";

/** The instrument the progress screen is built around: a ruled paper track. */
function StageProgress({ stage }: { stage: AssetStageView }) {
  const copy = STAGE_RUNNING_COPY[stage.stage];
  return (
    <section className="agp-staged-progress">
      <span className="agp-eyebrow">
        {STAGE_LABELS[stage.stage]} task in flight
      </span>
      <h2>{copy.headline}</h2>
      <p>{copy.detail}</p>
      <div
        aria-label={`${copy.headline} ${stage.progress}%`}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={stage.progress}
        className="agp-staged-meter"
        role="progressbar"
      >
        <i aria-hidden="true">
          <b style={{ width: `${Math.max(stage.progress, 2)}%` }} />
        </i>
        <strong>{stage.progress}%</strong>
      </div>
      <small>
        {stage.creditsReserved > 0
          ? `${creditLabel(stage.creditsReserved)} reserved for this task. Nothing further is spent until you decide.`
          : "Nothing further is spent until you decide."}
      </small>
    </section>
  );
}

/** Where this asset is along Meshy's four stages, and what it has cost. */
function StageLadder({ stage }: { stage: AssetStageView }) {
  const reached = new Set(stage.runs.map((run) => run.stage));
  return (
    <ol className="agp-staged-ladder">
      {STAGE_LADDER.map((step) => (
        <li
          data-current={step === stage.stage || undefined}
          data-reached={reached.has(step) || undefined}
          key={step}
        >
          <i aria-hidden="true" />
          <span>{STAGE_LABELS[step]}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * The paper trail beside the viewer: every task this asset has run, what each
 * one cost, and whether Meshy's rigger will take it. It is the answer to "why
 * is Rig greyed out" and "what have I already paid for", in one column.
 */
export function RigEligibilityControl({
  busy,
  onOverride,
  stage,
}: {
  busy: boolean;
  onOverride: (biped: boolean) => void;
  stage: AssetStageView;
}) {
  const control = rigOverrideControl(stage);
  return (
    <span className="agp-rig-eligibility">
      <small data-eligible={stage.rigEligible || undefined}>
        {rigEligibilityLabel(stage)}
      </small>
      <button
        disabled={busy}
        onClick={() => onOverride(control.biped)}
        type="button"
      >
        {control.label}
      </button>
    </span>
  );
}

function StageRecord({
  busy,
  onOverride,
  stage,
}: {
  busy: boolean;
  onOverride: (biped: boolean) => void;
  stage: AssetStageView;
}) {
  return (
    <aside className="agp-staged-record">
      <div>
        <span className="agp-eyebrow">Task record</span>
        <ol>
          {stage.runs.map((run) => (
            <li
              data-status={run.status}
              key={`${run.stage}-${run.round}-${run.requestId}`}
            >
              <strong>
                {STAGE_LABELS[run.stage]} · round {run.round}
              </strong>
              <small>
                {run.status}
                {run.consumedCredits !== undefined
                  ? ` · ${creditLabel(run.consumedCredits)}`
                  : ` · ${creditLabel(run.reservedCredits)} reserved`}
              </small>
            </li>
          ))}
        </ol>
      </div>
      <div>
        <span className="agp-eyebrow">Rigging</span>
        <RigEligibilityControl
          busy={busy}
          onOverride={onOverride}
          stage={stage}
        />
        <p data-eligible={stage.rigEligible || undefined}>
          {stage.rigEligibilityReason}
        </p>
      </div>
    </aside>
  );
}

function DecisionBar({
  busy,
  offers,
  onDecide,
}: {
  busy: boolean;
  offers: StagedOfferView[];
  onDecide: (offer: StagedOfferView) => void;
}) {
  if (offers.length === 0) return null;
  return (
    <footer className="agp-staged-decisions">
      <span className="agp-eyebrow">Your call</span>
      <div className="agp-staged-offers">
        {offers.map((offer) => (
          <div
            className="agp-staged-offer"
            data-tone={offer.tone}
            key={offer.decision}
          >
            <button
              className="agp-staged-cta"
              data-tone={offer.tone}
              disabled={busy || offer.disabled}
              onClick={() => onDecide(offer)}
              type="button"
            >
              <span>{offer.label}</span>
              {offer.costed && (
                <b className="agp-staged-price">{creditLabel(offer.credits)}</b>
              )}
            </button>
            {offer.disabled ? (
              <small className="agp-staged-blocked">{offer.reason}</small>
            ) : (
              offerNote(offer.decision) && (
                <small>{offerNote(offer.decision)}</small>
              )
            )}
          </div>
        ))}
      </div>
    </footer>
  );
}

/** The same acknowledgement contract the image gate uses, for one decision. */
function StagedCreditDialog({
  assetName,
  offer,
  simulated,
  onCancel,
  onConfirm,
}: {
  assetName: string;
  offer: StagedOfferView;
  /** A replay world never reaches Meshy, and must not imply that it does. */
  simulated: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);
  return (
    <dialog
      aria-labelledby="agp-staged-credit-title"
      className="agp-credit-modal"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      ref={dialogRef}
    >
      <button
        aria-label="Close credit confirmation"
        autoFocus
        className="agp-modal-close"
        onClick={onCancel}
        type="button"
      >
        ×
      </button>
      <span className="agp-credit-icon" aria-hidden="true">
        cr
      </span>
      <span className="agp-eyebrow">Credit acknowledgment</span>
      <h2 id="agp-staged-credit-title">
        {offer.label} — {assetName}?
      </h2>
      <p>
        This starts a new Meshy task. The credits are committed the moment it is
        submitted, whether or not you keep the result.
      </p>
      <div className="agp-credit-total">
        <span>This decision</span>
        <strong>{offer.credits} credits</strong>
      </div>
      {offerNote(offer.decision) && <small>{offerNote(offer.decision)}</small>}
      {simulated && (
        <small>
          This world is in replay. Meshy is simulated locally, so confirming
          submits nothing and spends no real credits.
        </small>
      )}
      <div className="agp-modal-actions">
        <button className="agp-secondary" onClick={onCancel} type="button">
          Keep reviewing
        </button>
        <button className="agp-credit-button" onClick={onConfirm} type="button">
          Acknowledge {offer.credits} credits &amp; send
        </button>
      </div>
    </dialog>
  );
}

export function StagedAssetScreen({
  assetId,
  onBack,
  onSnapshot,
  project,
}: {
  assetId: string;
  onBack: () => void;
  onSnapshot: (next: ProjectSnapshot) => void;
  project: ProjectSnapshot;
}) {
  const stage = project.assetStages?.[assetId];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState<StagedOfferView | null>(null);
  const [clip, setClip] = useState<StagedClip>("walk");
  const inFlight = useRef(false);
  const snapshotRef = useRef(onSnapshot);
  snapshotRef.current = onSnapshot;

  const base = `/api/projects/${project.state.projectId}/assets/${encodeURIComponent(assetId)}/stages`;
  const running = shouldPollStage(stage);

  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      if (inFlight.current) return;
      inFlight.current = true;
      api<ProjectSnapshot>(`${base}/poll`, { method: "POST" })
        .then((next) => {
          if (!cancelled) snapshotRef.current(next);
        })
        .catch((cause) => {
          if (!cancelled) setError(refusal(cause));
        })
        .finally(() => {
          inFlight.current = false;
        });
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [base, running]);

  const send = (offer: StagedOfferView) => {
    setBusy(true);
    setError(undefined);
    api<ProjectSnapshot>(`${base}/decide`, {
      method: "POST",
      body: JSON.stringify({
        decision: offer.decision,
        acknowledgedCredits: offer.credits,
      }),
    })
      .then((next) => snapshotRef.current(next))
      .catch((cause) => setError(refusal(cause)))
      .finally(() => setBusy(false));
  };

  const overrideRigEligibility = (biped: boolean) => {
    setBusy(true);
    setError(undefined);
    api<ProjectSnapshot>(
      `/api/projects/${project.state.projectId}/assets/${encodeURIComponent(assetId)}/rig-eligibility`,
      {
        method: "POST",
        body: JSON.stringify({ biped }),
      },
    )
      .then((next) => snapshotRef.current(next))
      .catch((cause) => setError(refusal(cause)))
      .finally(() => setBusy(false));
  };

  if (!stage)
    return (
      <section className="agp-staged agp-surface">
        <p className="agp-staged-empty">
          This asset has no 3D lifecycle yet.
          <button className="agp-secondary" onClick={onBack} type="button">
            Back to assets
          </button>
        </p>
      </section>
    );

  const offers = offerViews(stage.offers);
  const terminal = terminalNote(stage);
  const clips = clipOptions(stage.preview);

  return (
    <section className="agp-staged agp-surface">
      <header className="agp-staged-head">
        <button className="agp-back" onClick={onBack} type="button">
          <i aria-hidden="true">←</i>
          <span>All assets</span>
        </button>
        <div className="agp-focus-title">
          <span className="agp-kicker">
            3D generation · {STAGE_LABELS[stage.stage]}
          </span>
          <h1>{stage.name}</h1>
        </div>
        <div className="agp-staged-ledger">
          {project.state.mode === "replay" && (
            <span className="agp-staged-simulated">
              <small>Replay</small>
              <strong>Meshy simulated</strong>
            </span>
          )}
          <span>
            <small>Consumed</small>
            <strong>{creditLabel(stage.creditsConsumed)}</strong>
          </span>
          {stage.creditsReserved > 0 && (
            <span>
              <small>Reserved</small>
              <strong>{creditLabel(stage.creditsReserved)}</strong>
            </span>
          )}
        </div>
      </header>

      <StageLadder stage={stage} />

      {error && (
        <p className="agp-staged-error" role="alert">
          {error}
        </p>
      )}

      <main
        className="agp-staged-body"
        data-rail={stage.runs.length > 0 || undefined}
      >
        <div className="agp-staged-main">
          {stage.status === "running" && <StageProgress stage={stage} />}

          {terminal && (
            <div
              className="agp-staged-plaque"
              data-kind={terminal.kind}
              data-solo={!stage.preview || undefined}
            >
              <strong>{terminal.headline}</strong>
              <p>{terminal.detail}</p>
              {stage.terminalReason &&
                (terminal.kind === "failed" || terminal.kind === "expired") && (
                  <small>{stage.terminalReason}</small>
                )}
            </div>
          )}

          {stage.preview && stage.status !== "running" && (
            <div className="agp-staged-stage">
              <StagedModelViewer
                caption={previewCaption(stage.preview)}
                clip={clips.length > 0 ? clip : "none"}
                uri={stage.preview.glb.uri}
              />
              {clips.length > 0 && (
                <div className="agp-staged-clips" role="group">
                  <span className="agp-eyebrow">Clip</span>
                  {clips.map((option) => (
                    <button
                      className="agp-staged-clip"
                      data-active={option === clip || undefined}
                      key={option}
                      onClick={() => setClip(option)}
                      type="button"
                    >
                      {option}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        {stage.runs.length > 0 && (
          <StageRecord
            busy={busy}
            onOverride={overrideRigEligibility}
            stage={stage}
          />
        )}
      </main>

      <DecisionBar
        busy={busy}
        offers={offers}
        onDecide={(offer) => {
          if (offer.costed) {
            setPending(offer);
            return;
          }
          send(offer);
        }}
      />

      {pending && (
        <StagedCreditDialog
          assetName={stage.name}
          offer={pending}
          simulated={project.state.mode === "replay"}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const offer = pending;
            setPending(null);
            send(offer);
          }}
        />
      )}
    </section>
  );
}
