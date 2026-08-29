/**
 * The Meshy configuration section of the studio's settings sheet.
 *
 * Every default here is a rule paid for in credits rather than a preference,
 * so each setting carries a tooltip that says what it does and when you would
 * change it — and never what it costs. A price belongs at the button that
 * spends it, in the layout, where someone about to spend can see it without
 * hovering anything.
 *
 * The orchestrator refuses a change while any asset has a paid task in flight,
 * because Meshy already holds the old settings. That refusal is surfaced
 * verbatim rather than pre-empted, so the panel and the server never disagree
 * about which world is locked.
 */
import { useState } from "react";

import type { MeshyConfig, ProjectSnapshot } from "@fulcrum/domain";

import { api, isApiError } from "../api.js";
import {
  MESHY_SETTING_DOCS,
  humaniseRefusal,
  meshySettingValue,
  meshySettingsLocked,
  type MeshySettingKey,
} from "./staged-asset-view.js";

const MIN_TARGET_POLYCOUNT = 10_000;
const MAX_TARGET_POLYCOUNT = 300_000;

function SettingRow({
  children,
  detail,
  docKey,
  label,
  open,
  onToggle,
  tooltip,
}: {
  children: React.ReactNode;
  detail: string;
  docKey: MeshySettingKey;
  label: string;
  open: boolean;
  onToggle: () => void;
  tooltip: string;
}) {
  const tooltipId = `vx-meshy-tip-${docKey}`;
  return (
    <div className="vx-meshy-row" data-open={open || undefined}>
      <div className="vx-meshy-label">
        <span>{label}</span>
        <button
          aria-controls={tooltipId}
          aria-expanded={open}
          aria-label={`What ${label.toLowerCase()} does`}
          className="vx-meshy-info"
          onClick={onToggle}
          type="button"
        >
          i
        </button>
      </div>
      <div className="vx-meshy-control">{children}</div>
      <small className="vx-meshy-detail">{detail}</small>
      {open && (
        <p className="vx-meshy-tooltip" id={tooltipId} role="tooltip">
          {tooltip}
        </p>
      )}
    </div>
  );
}

export function MeshySettings({
  onSnapshot,
  project,
}: {
  onSnapshot: (next: ProjectSnapshot) => void;
  project: ProjectSnapshot;
}) {
  const config = project.meshyConfig;
  const [openTip, setOpenTip] = useState<MeshySettingKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<
    { tone: "saved" | "refused"; text: string } | undefined
  >(undefined);
  const [heightDraft, setHeightDraft] = useState<string | null>(null);
  const [polycountDraft, setPolycountDraft] = useState<string | null>(null);

  if (project.state.milestone !== "m2" || !config) return null;

  const locked = meshySettingsLocked(project.assetStages);

  const patch = (change: Partial<MeshyConfig>) => {
    setBusy(true);
    setMessage(undefined);
    api<ProjectSnapshot>(
      `/api/projects/${project.state.projectId}/settings/meshy`,
      { method: "POST", body: JSON.stringify(change) },
    )
      .then((next) => {
        onSnapshot(next);
        setMessage({ tone: "saved", text: "Saved to this world." });
      })
      .catch((cause: unknown) => {
        setMessage({
          tone: "refused",
          text: humaniseRefusal(
            isApiError(cause)
              ? cause.detail
              : cause instanceof Error
                ? cause.message
                : "That change was refused.",
            project.assetStages,
          ),
        });
      })
      .finally(() => setBusy(false));
  };

  const disabled = busy || locked;
  const row = (key: MeshySettingKey) => {
    const doc = MESHY_SETTING_DOCS.find((entry) => entry.key === key)!;
    return {
      docKey: key,
      label: doc.label,
      tooltip: doc.tooltip,
      open: openTip === key,
      onToggle: () => setOpenTip((current) => (current === key ? null : key)),
    };
  };

  return (
    <section className="vx-meshy-settings">
      <div className="vx-meshy-head">
        <span className="vx-routing-row-title">Meshy configuration</span>
        <small>
          {locked
            ? "Locked while a paid task is in flight — Meshy already holds these settings."
            : "Applies to every 3D task this world sends from now on."}
        </small>
      </div>

      {message && (
        <p className="vx-meshy-message" data-tone={message.tone} role="status">
          {message.text}
        </p>
      )}

      <div className="vx-meshy-grid">
        <SettingRow
          {...row("modelVersion")}
          detail="Pinned. A repoint is a silent price change."
        >
          <span className="vx-meshy-static">
            {meshySettingValue(config, "modelVersion")}
          </span>
        </SettingRow>

        <SettingRow {...row("topology")} detail="Engine-ready triangles.">
          <span className="vx-meshy-static">
            {meshySettingValue(config, "topology")}
          </span>
        </SettingRow>

        <SettingRow
          {...row("targetPolycount")}
          detail={`Floor ${MIN_TARGET_POLYCOUNT.toLocaleString("en-US")} · ceiling ${MAX_TARGET_POLYCOUNT.toLocaleString("en-US")}`}
        >
          <input
            aria-label="Requested polycount"
            disabled={disabled}
            max={MAX_TARGET_POLYCOUNT}
            min={MIN_TARGET_POLYCOUNT}
            onBlur={() => {
              const value = Number(polycountDraft);
              setPolycountDraft(null);
              if (
                polycountDraft === null ||
                !Number.isFinite(value) ||
                value === config.targetPolycount
              )
                return;
              patch({ targetPolycount: Math.round(value) });
            }}
            onChange={(event) => setPolycountDraft(event.target.value)}
            step={1_000}
            type="number"
            value={polycountDraft ?? String(config.targetPolycount)}
          />
        </SettingRow>

        <SettingRow
          {...row("textureResolution")}
          detail="4K and 2K are billed the same."
        >
          <select
            aria-label="Texture resolution"
            disabled={disabled}
            onChange={(event) =>
              patch({
                textureResolution: event.target
                  .value as MeshyConfig["textureResolution"],
              })
            }
            value={config.textureResolution}
          >
            <option value="4k">4K</option>
            <option value="2k">2K</option>
          </select>
        </SettingRow>

        <SettingRow
          {...row("poseMode")}
          detail="Rigging needs a symmetric pose."
        >
          <select
            aria-label="Pose mode"
            disabled={disabled}
            onChange={(event) =>
              patch({ poseMode: event.target.value as MeshyConfig["poseMode"] })
            }
            value={config.poseMode}
          >
            <option value="a-pose">A-pose</option>
            <option value="t-pose">T-pose</option>
          </select>
        </SettingRow>

        <SettingRow
          {...row("realWorldHeightMeters")}
          detail="Metres, measured from an origin at the feet."
        >
          <input
            aria-label="Real-world height in metres"
            disabled={disabled}
            max={100}
            min={0.1}
            onBlur={() => {
              const value = Number(heightDraft);
              setHeightDraft(null);
              if (
                heightDraft === null ||
                heightDraft.trim() === "" ||
                !Number.isFinite(value) ||
                value <= 0 ||
                value === config.realWorldHeightMeters
              )
                return;
              patch({ realWorldHeightMeters: value });
            }}
            onChange={(event) => setHeightDraft(event.target.value)}
            placeholder="Meshy default"
            step={0.1}
            type="number"
            value={heightDraft ?? config.realWorldHeightMeters ?? ""}
          />
        </SettingRow>

        <SettingRow
          {...row("deliveredPolycountPreset")}
          detail="Intent for whatever reduces the mesh downstream."
        >
          <select
            aria-label="Delivered detail preset"
            disabled={disabled}
            onChange={(event) =>
              patch({
                deliveredPolycountPreset: event.target
                  .value as MeshyConfig["deliveredPolycountPreset"],
              })
            }
            value={config.deliveredPolycountPreset}
          >
            <option value="background">Background · 2,000 tris</option>
            <option value="standard">Standard · 6,000 tris</option>
            <option value="hero">Hero · 10,000 tris</option>
          </select>
        </SettingRow>

        <SettingRow
          {...row("removeLighting")}
          detail="Keeps your scene lighting the only lighting."
        >
          <button
            aria-pressed={config.removeLighting}
            className="vx-meshy-toggle"
            disabled={disabled}
            onClick={() => patch({ removeLighting: !config.removeLighting })}
            type="button"
          >
            {meshySettingValue(config, "removeLighting")}
          </button>
        </SettingRow>

        <SettingRow
          {...row("imageEnhancement")}
          detail="Cleans references before Meshy reads them."
        >
          <button
            aria-pressed={config.imageEnhancement}
            className="vx-meshy-toggle"
            disabled={disabled}
            onClick={() =>
              patch({ imageEnhancement: !config.imageEnhancement })
            }
            type="button"
          >
            {meshySettingValue(config, "imageEnhancement")}
          </button>
        </SettingRow>
      </div>
    </section>
  );
}
