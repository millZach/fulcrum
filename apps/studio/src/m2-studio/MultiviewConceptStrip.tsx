import { useState } from "react";

import type { AssetBatchEntry } from "@fulcrum/domain";

import {
  createMultiviewViewLoader,
  multiviewLoading,
  multiviewSummary,
  type MultiviewLoading,
  type MultiviewReady,
} from "./multiview-view.js";

const loadMultiview = createMultiviewViewLoader(async (uri) => {
  const response = await fetch(uri);
  if (!response.ok)
    throw new Error(`Artifact request failed with ${response.status}.`);
  return await response.json();
});

type ExpandedState =
  MultiviewLoading | MultiviewReady | { kind: "error"; message: string };

export function MultiviewConceptStrip({
  entry,
}: {
  entry: AssetBatchEntry | undefined;
}) {
  const summary = multiviewSummary(entry);
  const [expanded, setExpanded] = useState(false);
  const [state, setState] = useState<ExpandedState>();
  if (summary.kind === "hidden") return null;

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (!next || state) return;
    setState(multiviewLoading(summary.revision));
    void loadMultiview(summary.revision)
      .then(setState)
      .catch((error: unknown) =>
        setState({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
  };

  return (
    <section className="m2-multiview" data-expanded={expanded}>
      <button
        aria-expanded={expanded}
        className="m2-multiview-toggle"
        onClick={toggle}
        type="button"
      >
        <span>{summary.label}</span>
        <i aria-hidden="true">{expanded ? "−" : "+"}</i>
      </button>
      {expanded && state?.kind === "loading" && (
        <p className="m2-multiview-message" role="status">
          {state.label}
        </p>
      )}
      {expanded && state?.kind === "error" && (
        <p className="m2-multiview-message m2-multiview-error">
          One or more view artifacts could not be loaded. {state.message}
        </p>
      )}
      {expanded && state?.kind === "ready" && (
        <div className="m2-multiview-body">
          <div className="m2-multiview-meta">
            <span>Identity anchor</span>
            <code>{state.anchorHash.slice(0, 12)}</code>
            <details>
              <summary>Full anchor hash</summary>
              <code>{state.anchorHash}</code>
            </details>
          </div>
          <div className="m2-multiview-views">
            {state.views.map((view) => (
              <figure key={view.role}>
                <img
                  alt={`${view.label} 3D input view`}
                  loading="lazy"
                  src={view.imageUri}
                />
                <figcaption>
                  <span>{view.label}</span>
                  <code>{view.revisionId}</code>
                </figcaption>
                <details>
                  <summary>Exact prompt sent</summary>
                  <p>{view.prompt}</p>
                  <code>{view.promptHash}</code>
                </details>
              </figure>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
