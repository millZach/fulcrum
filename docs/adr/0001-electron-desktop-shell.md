# ADR 0001 — Electron as the desktop shell

- Status: accepted
- Date: 2026-08-20
- Decision maker: Zach

## Context

Fulcrum's end goal is a standalone desktop application for Windows and
macOS. Today the studio runs in a browser against an orchestrator HTTP
server on localhost, which exists only as a prototyping convenience and
carries a real drawback: the open port is reachable by any page in the
user's browser (see the M1 audit finding on the ungated ImageGen
endpoint).

Two shells were considered: Electron (bundled Chromium + Node) and
Tauri (OS webview + Rust core, other runtimes as sidecar processes).

## Decision

Fulcrum will ship as an **Electron** application. One codebase covers
Windows, macOS, and Linux.

Two Fulcrum-specific facts decided it:

1. **The orchestrator is Node.** The coordinator, SQLite persistence,
   artifact store, provider adapters, `sharp`, and CLI shell-outs all
   run on Node. In Electron they move into the main process nearly
   unchanged, and the localhost HTTP port is replaced by IPC — which
   structurally removes the drive-by spend surface. In Tauri the same
   code would survive only as a bundled Node sidecar behind a local
   port, keeping the weakest part of the current architecture.
2. **Rendering consistency.** The studio's design (World Forge,
   `:has()` choreography, react-three-fiber mascot) is developed and
   visually verified against Chromium. Tauri renders through WKWebView
   (Safari engine) on macOS, which would require re-verifying every
   screen on a second engine. Electron guarantees the shipped pixels
   match the developed pixels on both platforms.

Tauri's genuine advantages — installer size, memory footprint, stricter
webview security defaults, mobile targets — do not bear on a
workstation pro tool that loads only its own UI and shells out to
Blender and AI CLIs.

## Consequences

- The studio ↔ orchestrator boundary stays behind one thin API module
  so the HTTP transport can be swapped for Electron IPC without a
  rewrite. Avoid browser-tab-specific APIs in the studio.
- Packaging waits until the studio graduates from prototype to the
  coordinator-backed UI; nothing blocks on Electron today.
- Native-module rebuilds (`sharp`, SQLite) must target Electron's Node
  version at packaging time; `node:sqlite` requires the bundled Node to
  be ≥ 22.5, otherwise swap to a userland SQLite driver.
- Distribution to other users would require each user's own signed-in
  provider CLIs; revisit auth at that point, not before.
