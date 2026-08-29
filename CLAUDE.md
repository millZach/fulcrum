# Fulcrum — project instructions

## Subagents
- All subagents in this project — coding, review, and any other delegated work — run on GPT-5.6 Sol via the Codex plugin: agent type `codex:codex-rescue`, model `gpt-5.6-sol`, `model_reasoning_effort="xhigh"`.
- This overrides the global "run all subagents on Opus 5" rule for this project. Claude (Fable) still orchestrates, reviews the produced work, and dispatches follow-up agents for anything found.
- (Decided 2026-08-29; replaces an earlier request to use Grok 4.6 for coding subagents.)
