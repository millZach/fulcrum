# Fulcrum — project instructions

## Subagents: GPT (gpt-5.6-sol) only (overrules the global Opus 5 rule)

In this project, ALL subagent work — coding, research, verification,
audits, writing, design review — runs on **gpt-5.6-sol** through the
Codex CLI at **xhigh** reasoning effort. Do not use Claude (Opus 5) or
Grok subagents here; this deliberately overrules the global user
CLAUDE.md rule. Claude orchestrates the GPT subagents and reviews their
output; GPT does the work. (Replaced the Grok-only rule on 2026-08-22
at Zach's request. A Grok run already in flight when this rule landed
finishes normally.)

Standard invocation (headless, single-turn):

```bash
codex exec --model gpt-5.6-sol -c model_reasoning_effort="xhigh" \
  --cd /home/zach/projects/Fulcrum -s workspace-write \
  -o <last-message.txt> - < <task.md>
```

- Model is **gpt-5.6-sol** at **xhigh** effort for every subagent.
  Verified 2026-08-22: `-s workspace-write` headless runs really do
  edit files (no silent-cancel failure mode), and `--strict-config`
  accepts `model_reasoning_effort="xhigh"`.
- **No fast mode headless** (checked 2026-08-22): the account rejects a
  `gpt-5.6-sol-fast` model with a 400, `fast_mode` is not a config key,
  and the `features.fast_mode` flag (already enabled) only affects the
  interactive UI. If a fast variant appears later, prefer it for
  mechanical tasks.
- Pipe multi-paragraph task briefs via stdin (`- < task.md`); use
  `--output-schema <file>` when the result must be parsed, and
  `-o <file>` to capture the final message. Run independent tasks in
  parallel as background Bash tasks.
- If a run stalls on approvals, add `--approve-for-me` before reaching
  for anything more permissive; never use
  `--dangerously-bypass-approvals-and-sandbox`.
- Review GPT's output before accepting it into the repo — orchestrator
  reviews everything.
