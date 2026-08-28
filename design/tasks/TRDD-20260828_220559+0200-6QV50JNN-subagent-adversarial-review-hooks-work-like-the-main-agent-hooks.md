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

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-08-28

**Step 1 done (diff + registrations):** report
`reports/hooks/20260828_235343+0200-review-fork-hooks-diff.md`. 14 hunks: 10 legitimate
subagent-vs-main differences, 2 divergent, 2 cosmetic. Counters are per-agent (distinct file
prefixes and keys) — that part is right.

**Defect found and FIXED (the one that mattered):** `agentlenspro review-gate` was written to
replace the loose `.js` scripts, but `--install-hooks` never removed them, so BOTH gates ran on
every Stop AND every SubagentStop against the same transcript and the same tmp state file —
breakers burned at double rate (`MAX_CONSECUTIVE=2` gone after ONE unmet turn). Verified in
`~/.claude/settings.json` and by the identical file-name derivation in `reviewGate.ts:147/225` vs
the scripts. Fix: `hookInstall.ts` `LEGACY_REVIEW_SCRIPTS` (stripped on install/uninstall),
test in `cliMatchers.test.ts`. Applied to this machine with `node standalone/cli.js
--install-hooks` (see the commit for the before/after arrays).

**Two divergences still open in the `.js` scripts (now unregistered here, but they are the
"source of truth" the verb was ported from):** (b7) the subagent variant reads the WHOLE
`agent_transcript_path` with no size cap, where the main variant tails 4 MiB; (b13) a state-file
write failure aborts the subagent demand but not the main one. Check whether `reviewGate.ts`
inherited either before touching the scripts.

**NEXT ACTION:** step 2 of the Method — spawn a real subagent that edits a throwaway file in an
isolated worktree and capture the SubagentStop fire (`agentlenspro hook-events`), the demand,
and the `review-gate` verdict; then the no-edit control.

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
