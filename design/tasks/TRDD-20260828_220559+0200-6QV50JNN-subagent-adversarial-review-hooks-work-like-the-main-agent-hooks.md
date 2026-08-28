---
trdd-id: 6QV50JNN
title: Verify the SubagentStop adversarial-review hooks fire and gate exactly like the main-agent Stop hooks
column: todo
created: 2026-08-28T22:05:59+0200
updated: 2026-08-28T22:05:59+0200
current-owner: claude-agentlenspro
task-type: audit
project-id: agentlenspro
---

# Subagent adversarial-review hooks must work like the main agent's

USER goal (2026-08-28): *"ensure the new hooks for adversarial review of the last turn for the
subagents are working fine like the existing hooks for the main agent."*

## What exists (read, not yet exercised)

`~/.claude/settings.json` registers, for BOTH `Stop` and `SubagentStop`:
`node "$HOME/.claude/hooks/{stop,subagent-stop}-spawn-review-fork.js"`, then `agentlenspro hook`
(capture), then `agentlenspro review-gate` (10 s timeout). The main-agent pair is proven in daily
use (it demanded a fork on this very session's edits). The subagent pair has no evidence yet.

## Method

1. Diff the two scripts: the subagent variant must differ ONLY in what a subagent transcript looks
   like (its own `session_id`, `messages[0]` is the injected prompt — see CLAUDE.md ctxvis notes);
   any other divergence is a defect.
2. Spawn a real subagent (lean-worker) that edits a throwaway file in an isolated worktree, and
   capture: did `SubagentStop` fire (`agentlenspro hook-events`), did the review-fork script
   demand a fork, did `review-gate` block/allow with the same verdict shape as the main hook.
3. Repeat with a subagent that edits nothing: the hooks must stay silent (no false demand).
4. The demand cap (20/session) and the 2-consecutive-unmet give-up must count PER agent, not
   drain the main agent's budget.

## Acceptance

- [ ] a runnable check (`scripts/test-subagent-stop-review-fork.js`, mirroring
      `test-stop-spawn-review-fork.js`) covers edit / no-edit / cap cases and passes
- [ ] one real spawned-subagent run recorded here with the hook-event ids as evidence
- [ ] any divergence found is fixed in the hook script (user scope) and re-run

## Notes and lessons learned
