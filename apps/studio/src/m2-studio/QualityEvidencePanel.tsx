import { useEffect, useMemo, useState } from "react";

import type {
  AssetBatchEntry,
  AssetQualityEvidence,
  PlannedAsset,
} from "@fulcrum/domain";

import { MultiviewConceptStrip } from "./MultiviewConceptStrip.js";
import { qualityView } from "./quality-view.js";

const titleCase = (value: string): string =>
  value
    .split("-")
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");

export function QualityEvidencePanel({
  asset,
  entry,
  evidence,
}: {
  asset: PlannedAsset | undefined;
  entry: AssetBatchEntry;
  evidence: AssetQualityEvidence | undefined;
}) {
  const view = useMemo(
    () =>
      qualityView(
        entry,
        evidence ?? {
          deterministicReports: [],
          turntables: [],
          semanticReports: [],
          decisions: [],
          events: [],
        },
        evidence?.events ?? [],
      ),
    [entry, evidence],
  );
  const firstCitedFrame =
    view.frames.find(({ overlays }) => overlays.length > 0)?.frameIndex ??
    view.frames[0]?.frameIndex;
  const [frameIndex, setFrameIndex] = useState(firstCitedFrame);
  useEffect(
    () => setFrameIndex(firstCitedFrame),
    [entry.assetId, firstCitedFrame],
  );
  const frame =
    view.frames.find((candidate) => candidate.frameIndex === frameIndex) ??
    view.frames[0];

  return (
    <section className="m2-quality-panel">
      <header className="m2-quality-header">
        <div>
          <span className="m1-kicker">
            Quality evidence · {entry.classification}
          </span>
          <h1>{asset?.name ?? entry.assetId}</h1>
          <p>
            {entry.validated
              ? `Validated after ${entry.attemptCount} ${entry.attemptCount === 1 ? "attempt" : "attempts"}.`
              : "This asset needs user direction before production can continue."}
          </p>
        </div>
        <div className="m2-quality-revisions" aria-label="Asset revisions">
          {view.revisions.map((revision) => (
            <span key={revision.revisionId}>
              <code>{revision.revisionId}</code>
              {revision.best && <b>Best</b>}
              {revision.latest && <b>Latest</b>}
            </span>
          ))}
        </div>
      </header>

      <MultiviewConceptStrip entry={entry} />

      {frame && (
        <section className="m2-turntable-evidence">
          <div className="m2-frame-stage">
            <img
              alt={`Turntable frame ${frame.frameIndex} at ${frame.yawDegrees} degrees`}
              src={frame.uri}
            />
            {frame.overlays.map((overlay) => (
              <span
                aria-label={overlay.summary}
                className={`m2-crop-overlay severity-${overlay.severity}`}
                key={overlay.findingId}
                style={{
                  left: `${overlay.crop.x * 100}%`,
                  top: `${overlay.crop.y * 100}%`,
                  width: `${overlay.crop.width * 100}%`,
                  height: `${overlay.crop.height * 100}%`,
                }}
              >
                <i>{overlay.findingId.slice(0, 6)}</i>
              </span>
            ))}
          </div>
          <div className="m2-frame-strip" aria-label="Turntable frames">
            {view.frames.map((candidate) => (
              <button
                aria-pressed={candidate.frameIndex === frame.frameIndex}
                data-cited={candidate.overlays.length > 0}
                key={candidate.frameIndex}
                onClick={() => setFrameIndex(candidate.frameIndex)}
                type="button"
              >
                <img alt="" src={candidate.uri} />
                <span>{candidate.yawDegrees}°</span>
                {candidate.overlays.length > 0 && <i>Cited</i>}
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="m2-quality-groups">
        <section>
          <h2>Deterministic gates</h2>
          {view.gateGroups.length === 0 ? (
            <p className="m2-empty-evidence">No deterministic gate report.</p>
          ) : (
            view.gateGroups.map((group) => (
              <div className="m2-gate-group" key={group.category}>
                <header>
                  <strong>{titleCase(group.category)}</strong>
                  <span>
                    {group.failedCount > 0
                      ? `${group.failedCount} failed`
                      : `${group.passedCount} passed`}
                  </span>
                </header>
                <ul>
                  {group.gates.map((gate) => (
                    <li data-passed={gate.passed} key={gate.id}>
                      <i aria-hidden="true">{gate.passed ? "✓" : "!"}</i>
                      <span>
                        <strong>{gate.label}</strong>
                        <small>
                          Actual {String(gate.actual)} · {gate.threshold}
                        </small>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </section>
        <section>
          <h2>Findings</h2>
          {view.findingGroups.length === 0 ? (
            <p className="m2-empty-evidence">No quality findings.</p>
          ) : (
            view.findingGroups.map((group) => (
              <div className="m2-finding-group" key={group.source}>
                <header>
                  <strong>{titleCase(group.source)}</strong>
                  <span>{group.findings.length}</span>
                </header>
                <ul>
                  {group.findings.map((finding) => {
                    const citedFrame = finding.evidence.find(
                      (item) => item.kind === "turntable-frame",
                    )?.frameIndex;
                    return (
                      <li key={finding.findingId}>
                        <span
                          className={`m2-severity severity-${finding.severity}`}
                        >
                          {finding.severity}
                        </span>
                        <strong>{finding.summary}</strong>
                        {finding.suggestedAction && (
                          <small>{finding.suggestedAction}</small>
                        )}
                        {citedFrame !== undefined && (
                          <button
                            onClick={() => setFrameIndex(citedFrame)}
                            type="button"
                          >
                            View cited frame {citedFrame}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
          )}
        </section>
      </div>

      {view.timeline.length > 0 && (
        <section className="m2-strategy-timeline">
          <h2>Regeneration history</h2>
          <ol>
            {view.timeline.map((item) => (
              <li key={item.eventId}>
                <i aria-hidden="true" />
                <div>
                  <span>
                    Attempt {item.attemptNumber + 1} ·{" "}
                    {titleCase(item.strategyKind)}
                  </span>
                  <p>{item.rationale}</p>
                  {item.roles && <small>Views: {item.roles.join(", ")}</small>}
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}
    </section>
  );
}
