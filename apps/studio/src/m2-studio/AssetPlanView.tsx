import { useEffect, useRef, useState } from "react";

import type {
  ApprovalInput,
  AssetBatchEntry,
  AssetClassification,
  PlannedAsset,
  ProjectSnapshot,
} from "@fulcrum/domain";

import { MultiviewConceptStrip } from "./MultiviewConceptStrip.js";
import {
  ASSET_PLAN_LANES,
  assetPlanSnapshotIsExact,
  layoutAssetPlanGraph,
} from "./asset-plan-graph.js";
import { assetPlanStatusForSnapshot } from "../m1-studio/snapshot-view.js";

const classLabels: Record<AssetClassification, string> = {
  hero: "Hero",
  kit: "Kit",
  procedural: "Procedural",
  functional: "Functional",
};

const statusLabels = {
  pending: "Awaiting decision",
  stale: "Stale snapshot",
  "changes-requested": "Changes requested",
  approved: "Approved",
  rejected: "Rejected",
  blocked: "Blocked",
} as const;

export function AssetPlanView({
  busy,
  project,
  onDecide,
}: {
  busy: boolean;
  project: ProjectSnapshot;
  onDecide: (decision: ApprovalInput["decision"], notes?: string) => void;
}) {
  const plan = project.assetPlan;
  const planRef = project.state.assetPlan;
  const [selectedId, setSelectedId] = useState(plan?.assets[0]?.assetId);
  const [requestingChanges, setRequestingChanges] = useState(false);
  const [notes, setNotes] = useState("");
  const previousRevision = useRef(planRef?.revisionId);
  const replaced =
    previousRevision.current !== undefined &&
    previousRevision.current !== planRef?.revisionId;
  useEffect(() => {
    previousRevision.current = planRef?.revisionId;
    setSelectedId(plan?.assets[0]?.assetId);
    setRequestingChanges(false);
    setNotes("");
  }, [planRef?.revisionId]);

  if (!plan || !planRef)
    return (
      <section className="m2-plan-missing">
        <span className="m1-kicker">Asset plan unavailable</span>
        <h1>The resolved plan document is missing.</h1>
        <p>Reload the project before making a decision.</p>
      </section>
    );

  const layout = layoutAssetPlanGraph(plan);
  const byId = new Map(plan.assets.map((asset) => [asset.assetId, asset]));
  const selected = byId.get(selectedId ?? "") ?? plan.assets[0]!;
  const status = assetPlanStatusForSnapshot(project);
  const exact = assetPlanSnapshotIsExact(project);
  const canDecide = !busy && exact && status === "pending";
  const dependencyCount = plan.assets.reduce(
    (count, asset) => count + asset.dependsOnAssetIds.length,
    0,
  );
  const laneY = Object.fromEntries(
    ASSET_PLAN_LANES.map((classification) => {
      const nodes = layout.nodes.filter(
        (node) => node.classification === classification,
      );
      return [classification, nodes[0]?.y ?? 0];
    }),
  ) as Record<AssetClassification, number>;

  return (
    <section
      className="m2-asset-plan"
      data-plan-status={status}
      data-replaced={replaced}
    >
      <header className="m2-plan-header">
        <div>
          <span className="m1-kicker">
            Asset batch · revision{" "}
            {(project.state.assetPlanReplanCount ?? 0) + 1}
          </span>
          <h1>Is this the right production batch?</h1>
        </div>
        <dl>
          <div>
            <dt>Exact hash</dt>
            <dd>{planRef.artifact.sha256.slice(0, 12)}</dd>
          </div>
          <div>
            <dt>Assets</dt>
            <dd>{plan.assets.length}</dd>
          </div>
          <div>
            <dt>Dependencies</dt>
            <dd>{dependencyCount}</dd>
          </div>
          <div data-state={status}>
            <dt>State</dt>
            <dd>{statusLabels[status]}</dd>
          </div>
        </dl>
      </header>

      {!exact && (
        <p className="m2-plan-integrity" role="alert">
          The resolved plan does not match the current revision and approved
          source hashes. Reload before deciding.
        </p>
      )}

      <section
        className="m2-policy-strip"
        aria-label="Stored class handling policy"
      >
        {ASSET_PLAN_LANES.map((classification) => {
          const policy = plan.handling[classification];
          return (
            <article data-class={classification} key={classification}>
              <span>{classLabels[classification]}</span>
              <strong>{policy.productionRoute}</strong>
              <small>
                {policy.conceptViews} · {policy.deterministicQa} QA ·{" "}
                {policy.semanticQa} semantic
              </small>
            </article>
          );
        })}
      </section>

      <div className="m2-plan-workspace">
        <div className="m2-plan-graph-scroll">
          <svg
            aria-label="Asset dependency graph"
            className="m2-plan-graph"
            height={layout.height}
            key={planRef.revisionId}
            role="img"
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            width={layout.width}
          >
            <defs>
              <marker
                id={`asset-arrow-${planRef.revisionId}`}
                markerHeight="8"
                markerWidth="8"
                orient="auto"
                refX="7"
                refY="4"
              >
                <path d="M 0 0 L 8 4 L 0 8 z" />
              </marker>
            </defs>
            {ASSET_PLAN_LANES.map((classification) =>
              laneY[classification] > 0 ? (
                <text
                  className="m2-lane-label"
                  key={classification}
                  x="8"
                  y={laneY[classification] + 18}
                >
                  {classLabels[classification]}
                </text>
              ) : null,
            )}
            <g className="m2-plan-edges">
              {layout.edges.map((edge) => (
                <path
                  d={edge.path}
                  key={`${edge.fromAssetId}:${edge.toAssetId}`}
                  markerEnd={`url(#asset-arrow-${planRef.revisionId})`}
                />
              ))}
            </g>
            <g className="m2-plan-nodes">
              {layout.nodes.map((node) => {
                const asset = byId.get(node.assetId)!;
                return (
                  <foreignObject
                    height={node.height}
                    key={node.assetId}
                    width={node.width}
                    x={node.x}
                    y={node.y}
                  >
                    <button
                      aria-pressed={selected.assetId === asset.assetId}
                      className="m2-graph-node"
                      data-class={asset.classification}
                      onClick={() => setSelectedId(asset.assetId)}
                      type="button"
                    >
                      <span>
                        <b>{asset.name}</b>
                        <i>{classLabels[asset.classification]}</i>
                      </span>
                      <small>{asset.rationale}</small>
                    </button>
                  </foreignObject>
                );
              })}
            </g>
          </svg>
        </div>

        <AssetPlanInspector
          asset={selected}
          batchEntry={project.state.assetBatch?.[selected.assetId]}
        />
      </div>

      <footer className="m2-plan-actions">
        <div>
          {requestingChanges ? (
            <label>
              <span>What must change?</span>
              <textarea
                autoFocus
                maxLength={1000}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="Name the asset, dependency, or handling change."
                value={notes}
              />
            </label>
          ) : (
            <span>
              Approval binds revision <code>{planRef.revisionId}</code> to its
              exact hash.
            </span>
          )}
        </div>
        <div>
          <button
            className="m2-reject"
            disabled={!canDecide}
            onClick={() => onDecide("rejected")}
            type="button"
          >
            Reject
          </button>
          {requestingChanges ? (
            <>
              <button
                className="m1-secondary"
                disabled={busy}
                onClick={() => setRequestingChanges(false)}
                type="button"
              >
                Cancel
              </button>
              <button
                className="m1-primary"
                disabled={!canDecide || !notes.trim()}
                onClick={() => onDecide("changes-requested", notes.trim())}
                type="button"
              >
                Send change request
              </button>
            </>
          ) : (
            <>
              <button
                className="m1-secondary"
                disabled={
                  !canDecide || (project.state.assetPlanReplanCount ?? 0) >= 1
                }
                onClick={() => setRequestingChanges(true)}
                type="button"
              >
                Request changes
              </button>
              <button
                className="m1-primary"
                disabled={!canDecide}
                onClick={() => onDecide("approved")}
                type="button"
              >
                Approve batch <span>→</span>
              </button>
            </>
          )}
        </div>
      </footer>
    </section>
  );
}

function AssetPlanInspector({
  asset,
  batchEntry,
}: {
  asset: PlannedAsset;
  batchEntry: AssetBatchEntry | undefined;
}) {
  return (
    <aside className="m2-plan-inspector">
      <span className="m1-kicker">
        {classLabels[asset.classification]} asset
      </span>
      <h2>{asset.name}</h2>
      <p>{asset.rationale}</p>
      <section>
        <h3>Acceptance criteria</h3>
        <ul>
          {asset.acceptanceCriteria.map((criterion) => (
            <li key={criterion}>{criterion}</li>
          ))}
        </ul>
      </section>
      <section>
        <h3>Sources</h3>
        <dl>
          {asset.sourceRefs.conceptSlots.map((source) => (
            <div key={source.slotId}>
              <dt>{source.slotId}</dt>
              <dd>{source.concept.revisionId}</dd>
            </div>
          ))}
        </dl>
        <details>
          <summary>Exact source hashes</summary>
          <code>{asset.sourceRefs.gameDesignSpec.sha256}</code>
          <code>{asset.sourceRefs.conceptSet.sha256}</code>
          {asset.sourceRefs.conceptSlots.map((source) => (
            <code key={source.slotId}>{source.concept.sha256}</code>
          ))}
        </details>
      </section>
      {asset.procedure && (
        <section>
          <h3>Procedure</h3>
          <strong>{asset.procedure.generatorId}</strong>
          <dl>
            {Object.entries(asset.procedure.parameters).map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{String(value)}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      <MultiviewConceptStrip entry={batchEntry} />
    </aside>
  );
}
