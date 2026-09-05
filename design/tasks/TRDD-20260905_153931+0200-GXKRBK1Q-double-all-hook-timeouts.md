---
trdd-id: GXKRBK1Q
title: Double every hook timeout the installer writes and every hook's own network budget
column: ai_review
created: 2026-09-05T15:39:31+0200
updated: 2026-09-05T18:08:21+0200
current-owner: main-session
task-type: bugfix
priority: high
min-approval-requirement: none
scope: project
project-id: agentlenspro
related: [3EZ6SJ2Z, X4YTS5BF]
relevant-rules: []
implementation-commits: [52155adf]
---

# Double every hook timeout the installer writes and every hook's own network budget

## ⏵ AI-REVIEW VERDICT 2026-09-05 — APPROVE. Ready for `human_review`; the USER makes that move.

Review report: `reports/ai-review/20260905_180731+0200-GXKRBK1Q-ai-review.md` (lean-worker: read the
`52155adf` hunks, ran `check-types` 0, `compile-tests` 0, scoped `cliMatchers` mocha 12/0, read the
live `~/.claude/settings.json`). Re-checked first-hand by the orchestrator at 18:08: `hookInstall.ts`
:185/:194/:203/:207 carry 10/10/20/10; `hookHandlers.ts:240` default 2 and `:268` default 4 (inner <
outer); `setup.ts:297-298` verify env `'4'`/`'4'`; the live settings.json counts 15 `hook` + 2 `gate` +
2 `review-supervisor` at 10 and 2 `review-gate` at 20, the one foreign 30 s hook untouched. The claim
the reviewer did not re-run — box 2's bundle content — was checked here instead: `standalone/cli.js`
(16:00) carries `timeout: 10` ×3 and `timeout: 20` ×1, the four matcher values; four `timeout: 5`
literals remain in the bundle from code paths outside the matcher fns (origin not traced — not in
this card's scope, which is the four installer entries plus the two network budgets).

## Approval log

- 2026-09-05T18:08:21+0200 — ORCHESTRATOR decision: accepted the 18:07 AI-review APPROVE after the
  first-hand re-check above. Vetoable at `human_review`. The running sessions still need a restart to
  pick up the doubled ceilings (installer output) — the USER's move, not a box here.
- 2026-09-05T18:12:10+0200 — the review fork on `a01a4703` asked for the source of truth instead of
  re-implemented counters; settled: `agentlenspro setup --dry-run` → "21 agentlens hook entries (0
  stale generation(s))", hooks step "registrations current / none" (the installer's own
  `isOurHookCommand` view, not a token counter); `git blame -L 240,240` and `-L 268,268
  src/cli/hookHandlers.ts` → `52155adf`, so the cited lines are HEAD-accurate (the reviewer's
  :237/:266 were a different revision); `standalone/cli.js` mtime is 16:00:55, three seconds after
  `52155adf` (16:00:52), so the bundle is from the committed source and the STATE's "16:05" is a
  loose time, not a stale bundle. The four `timeout: 5` literals are not in `src/cli` or
  `standalone/cli.ts` (grep 0) — they come from other bundled modules and are outside this card.

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-09-05T16:06:03+0200

**`ai_review` — all three boxes met and measured.** Code in `52155adf`; the owner machine converged
at 16:05 (setup exit 0, read-back 10/10/20/10 on 21 timed entries). The column went
`dev → testing → ai_review` in ONE edit at 16:06: the `testing` evidence is the scoped mocha run and
the convergence read-back above; the board never showed the card in `testing`. Note the new ceilings
are in the FILE — running Claude Code sessions still enforce the old ones until they restart (the
installer's own line). Nothing left but the review.
Reviewer: the full mocha suite was NOT run for this change (killed at 15-min load-avg 164 after ~10
min); the three suites that import the touched modules (agentGate, cliMatchers, hookScripts) ran
green with `--no-config`, 73/0.

USER order 2026-09-05 15:38: "relax the timeouts of all hooks.. they must be doubled".

## Current values (✓ VERIFIED)

Outer — the `timeout` the installer writes into `~/.claude/settings.json` (`src/cli/hookInstall.ts`):

| hook | fn | now | new |
|---|---|---|---|
| lifecycle forwarder (async) | `lifecycleMatcher` `:179` | 5 s | 10 s |
| burn gate (sync, agent-launch + image Read) | `gateMatcher` `:189` | 5 s | 10 s |
| review gate (sync, Stop/SubagentStop) | `reviewGateMatcher` `:198` | 10 s | 20 s |
| review supervisor | `reviewSupervisorMatcher` `:202` | 5 s | 10 s |

The live `~/.claude/settings.json` carries exactly these values today (22 agentlenspro hook entries:
5 s everywhere, 10 s on the two review-gate entries).

Inner — the budget a hook gives its own HTTP call, which must stay inside the outer ceiling:
`src/cli/hookHandlers.ts:239` default `AGENTLENS_HOOK_TIMEOUT` 1 s → 2 s and `:266` default
`AGENTLENS_GATE_TIMEOUT` 2 s → 4 s; `src/cli/setup.ts:297-298` verify-exec env for both 2 → 4, and
the `:301` comment that named "the 2 s above". Sweep for stale numbers (`skills/`, README, ARCHITECTURE,
CLAUDE.md, `src/**`): no other site names the old values.

## Why the sync gate's doubling is acceptable

The 5 s gate comment (`hookInstall.ts:182-187`) already records the trade: the stall only occurs when
the server is WEDGED and the call is an agent launch or an image Read; a gate that times out first
under load fails OPEN and misses the disaster it exists to deny. At the loads this machine runs
(load-avg 16–26 measured today, 130+ on 2026-08-14) the user's report is that the ceilings are hit;
doubling trades a rarer 10 s worst-case stall for fewer silently-dropped captures and fewer gates
failing open.

## Acceptance

- [x] The four matcher fns write 10/10/20/10; the hook and gate network defaults are doubled; the
      setup verify env is doubled (`52155adf`). One test pinned the old gate value — `cliMatchers.test.ts:33`
      failed `10 !== 5` on the first scoped run and was raised on purpose; the `timeout: 5` at `:59` is
      a FOREIGN janitor hook that must survive and was left alone.
- [x] `pnpm run check-types` 0; `node esbuild.js` exit 0 and `standalone/cli.js` carries `timeout: 20`
      (the CLI bundle is what `setup` runs; `agentlenspro` on this machine resolves to it).
- [x] `agentlenspro setup --yes` (or `--install-hooks`) converges the live settings.json through
      `safeConfigEdit`; `python3` read-back shows 10/10/20/10 on all 21 timed agentlenspro entries and
      the foreign hooks untouched. Done 16:05: setup exit 0, hooks step "installed/migrated, PASS",
      final self-test PASS; read-back 15 `hook` + 2 `gate` + 2 `supervisor` at 10, 2 `review-gate` at
      20 (21 timed entries — the 22nd is the untimed pending-prompt cat), the foreign 30 s
      `git_safety_guard` hook untouched. The installer itself prints "restart Claude Code sessions to
      pick up the hook change"; whether CC ≥ 2.1.240 reloads live is a LOCAL memory note, not verified here.

## Notes and lessons learned
