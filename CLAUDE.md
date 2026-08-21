# Fulcrum — project instructions

## Subagents: Grok only (overrules the global Opus 5 rule)

In this project, ALL subagent work — coding, research, verification,
audits, writing, design review — runs on **Grok** through the Grok Build
CLI. Do not use Claude (Opus 5) subagents here; this deliberately
overrules the global user CLAUDE.md rule. Claude orchestrates the Grok
subagents and reviews their output; Grok does the work.

Standard invocation (headless, single-turn):

```bash
grok --model grok-4.6 --reasoning-effort xhigh --prompt-file <task.md> \
  --cwd /home/zach/projects/Fulcrum --permission-mode auto --max-turns 150
```

- Model is **grok-4.6** at **xhigh** reasoning effort, for every subagent.
- **Permission mode must be `auto` for headless runs.** In print mode
  (`-p` / `--prompt-file`) the first tool call that needs interactive
  approval cancels the whole run with `stopReason: "cancelled"` and
  exit 0 — `acceptEdits` and `dontAsk` both hit this and the agent
  silently does nothing (verified 2026-08-21). `--always-approve` is
  blocked by the Claude Code permission classifier; don't use it.
- Prefer `--prompt-file` over `-p` for multi-paragraph task briefs;
  `--output-format json` (or `--json-schema`) when the result needs to
  be parsed; run several in parallel as background Bash tasks when the
  work is independent.
- Review Grok's output before accepting it into the repo — orchestrator
  reviews everything.
- (Context: as of 2026-08-20 the account's CLI exposes only `grok-4.6`
  and `grok-4.5`; the `grok-4.6-fast` variant is not available.)
