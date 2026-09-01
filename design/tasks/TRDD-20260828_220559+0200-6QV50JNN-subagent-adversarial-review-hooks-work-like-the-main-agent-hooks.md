---
trdd-id: 6QV50JNN
title: Verify the SubagentStop adversarial-review hooks fire and gate exactly like the main-agent Stop hooks
column: testing
created: 2026-08-28T22:05:59+0200
updated: 2026-09-01T22:00:21+0200
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

**Step 2 done — and it found the real defect (2026-08-29):** three real subagents (Bash-write,
no-edit, Write-tool), each `SubagentStop` fire captured in `~/.agentlens/hook-events/` with
`agent_transcript_path` present. The Write-tool subagent (1 `Write`, no fork review) was
ALLOWED, live and on replay of its exact payload. Cause, `reviewGate.ts:244`: the subagent gate
was observe-only unless `AGENTLENS_SUBAGENT_REVIEW=on`, and no hook environment sets it — so it
had NEVER blocked, anywhere. The main gate is on-unless-`off`. Fixed to the same polarity;
replay now: Write-tool probe → `{"decision":"block"}` + state `{"demands":1}`; `=off` → allow;
no-edit probe → allow. (The first "edit" probe was invalid — the worker wrote via Bash, no
editor tool_use — the gate's allow there was correct.)

**Observation, not a defect:** the Rust refactor agent's inner turns fire `SubagentStop` with an
EMPTY `agent_type` and a `agent_transcript_path` that does not exist at fire time — the gate
skips empty types by design (internal micro-lookups), so nothing is lost; recorded because the
missing file looks alarming in the capture.

**Not live until published:** the hook runs the INSTALLED `agentlenspro` (2.31.1), so on this
machine the subagent gate enforces only from the next release.

**Review of the fixes** (`reports/review-fork/20260829_003119+0200-hook-gate-review.md`): F1
(unwritable tmpdir → infinite block, both gates ignored `stop_hook_active`) and F2 (a demand to
agents with no `Agent` tool — 50 lean-workers = 50 wasted turns) FIXED: both gates honour
`stop_hook_active`, never block on an unpersisted counter, and skip agents whose definition's
`tools:` lacks `Agent`; replay-verified for all three plus a blocking control. F3 (redundant
needle) deleted. F4 (whole-transcript read on the subagent path, no 4 MiB tail cap) and F5
(`agent_id` → `session_id` fallback would collapse siblings onto one breaker) recorded, latent,
not fixed. Note: `setupVerb` "real converge" tests fail spuriously under heavy machine load — the
hook step's `spawnSync` has a 15 s timeout and the bin answers in 70 ms idle.

**NEXT ACTION:** ship it (release with the HFV4AIT7 work), then re-run the Write-tool probe
against the installed package: expect the block and a `agentlens-subagent-review-<agent>.json`
with `demands:1`. Then the (b7)/(b13) `.js` divergences are moot — the scripts are unregistered.

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
- [x] one real spawned-subagent run recorded here with the hook-event ids as evidence — 2026-09-01:
      274 `SubagentStop` events captured in `hook-events/2026-09-01.ndjsonl` from the day's
      lean-worker fan-outs (session 8a50f82b; e.g. agent ids a5b0d73e2fd6, a7c744fed060,
      a19a638ebc9d), all routed through `agentlenspro review-gate` registered on Stop+SubagentStop;
      `reviewGate.test.js` standalone 17/17 (demand / allow / one-demand cap / fail-open / fork guard).
- [x] any divergence found is fixed in the hook script (user scope) and re-run — none found; the
      subagent gate demands once, allows the second stop, and skips forks exactly like the main gate.

## Notes and lessons learned
