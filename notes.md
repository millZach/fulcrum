# Fulcrum

## 2026-08-18 — Reused the Codex subscription for ImageGen

I initially treated GPT Image 2 as API-only and made Studio request a key even though Codex exposed an enabled `image_generation` capability. The fix was to detect that capability separately, invoke ImageGen through an isolated `codex exec` job, and keep the API route only as the fallback.

## 2026-08-17 — Closed the duplicate-spend crash window

I found that journaling a provider job only after its response left a narrow restart window where Fulcrum could pay for the same request twice. I now record intent and pending state before network I/O, turn interrupted calls into `submission-unknown`, and have a regression test proving Fulcrum refuses to submit that job again automatically.
