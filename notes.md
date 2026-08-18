# Fulcrum

## 2026-08-18 — The first live run found three integration seams

I found that the orchestrator loaded `.env` relative to its package, a bodyless polling POST still advertised JSON, and Meshy's valid 1.9 m output rendered tiny in the authored arena camera. I fixed root-relative runtime configuration, made JSON headers conditional on an actual body, and normalized provider GLBs to the 3.2 m review target before grounding them. The same paid Meshy job resumed safely throughout, passed all six QA gates, and consumed 30 credits without a duplicate submission.

## 2026-08-18 — Reused the Codex subscription for ImageGen

I initially treated GPT Image 2 as API-only and made Studio request a key even though Codex exposed an enabled `image_generation` capability. The fix was to detect that capability separately, invoke ImageGen through an isolated `codex exec` job, and keep the API route only as the fallback.

## 2026-08-17 — Closed the duplicate-spend crash window

I found that journaling a provider job only after its response left a narrow restart window where Fulcrum could pay for the same request twice. I now record intent and pending state before network I/O, turn interrupted calls into `submission-unknown`, and have a regression test proving Fulcrum refuses to submit that job again automatically.
