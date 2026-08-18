---
trdd-id: 8ZMZ4I6B
title: get_window_eta — cost-based time-to-exhaustion of the current account's rate-limit windows
column: completed
created: 2026-07-15T13:16:18+0200
updated: 2026-08-18T12:45:00+0200
current-owner: main
task-type: feature
scope: project
parent-trdd: BURNWDGT
npt: []
eht: []
---

# get_window_eta — cost-based ETA to window exhaustion

## ⏵ STATE — 2026-07-15 ~13:30 — LANDED + LIVE-VERIFIED

Implemented (`src/windowEta.ts`), tested (8 tests, suite 1228 green), bundled + deployed (pid
13647), live-verified. Correct rolling-window behavior confirmed: at $1.09/min NEITHER window
exhausts — 5h plateaus far under cap, 7d plateaus at ~$11,024 of the $12,283 cap (90%). The verdict
correctly says it would take a sustained higher burst (the rotation trigger is a spike, not steady
rate). Docs: CHANGELOG 2.7.0 + skill. Awaiting user review → complete.

**USER request (2026-07-15, verbatim):** "compute the estimate time remaining to exhaust the current
5d window at the current total cost rate (i think anthropic computes the window limits by costs, not
by tokens). add this command too to the cli."

## Design (the load-bearing decisions)

`get_window_eta` (default `--account current`, `--rate_window_min 30`).

**COST-based, not token-based.** The existing `WindowConsumption.minutesToExhaustion` projects on
tokens — wrong here, because Anthropic meters the window by cost and cache-read (~96% of the stream)
is weighted ~0.1×. ETA projects on dollars: remaining $ cap ÷ current $/min.

**Per-account rate.** Rate limits are per OAuth account, so the $/min is THIS account's own burn
(events attributed by the machine account-state timeline via the shared
`eventsForAccountInWindow` — same rule the burners tables use), not the machine-wide total. A
concurrent session on another token never shortens this account's ETA.

**THE correctness fix — rolling-window plateau.** A 5h/7d window SHEDS consumption older than its
length, so at steady rate r it plateaus at `r × windowLength`. If that plateau is below the cap the
window can NEVER exhaust at that rate — a naive `remaining/rate` there is a fiction (the first live
run reported "5h exhausts in 19h 54m" for a 5h window, which is impossible). The ETA now gates on
`steadyStateFillUsd ≥ cap`: only then is `remaining/rate` reported; otherwise `etaReason: 'plateau'`
and the verdict says it won't exhaust at the current rate (naming the closest window's plateau %).

**Capacity** reuses `resolveWindowCapacity` (own observed calibration → same-plan proxy, labeled →
none/undetermined, never guessed). `etaReason ∈ projected|over-limit|no-capacity|idle|plateau`.

## Files
- `src/windowEta.ts` (NEW): `buildWindowEtaReport`, `humanEta`, `WindowEtaSection`/`WindowEtaReport`.
- `src/accountBurners.ts`: exported `eventsForAccountInWindow` (shared attribution rule).
- `src/mcpServer.ts`: TOOLS entry + handler (reuses the getConsumptionEvents accessor + loadBurnConfig).
- `src/test/windowEta.test.ts` (NEW, 8 tests incl. the rolling-window plateau + per-account rate).
- Docs: CHANGELOG, skill.

## Verify
`pnpm run compile` green; windowEta tests pass; live `agentlenspro get_window_eta` shows honest
plateau verdict when the rate is below what any window needs, a finite ETA when it isn't.

## Approval log

- 2026-08-02 — AI review PASSED (ai_review backlog audit): implementation verified present in the code first-hand, not from prose. Column ai_review → human_review; the remaining gate is the human. Evidence: reports/ai-review-audit/20260802_113207+0200-batchA-diagnostics.md
- 2026-08-02 — HUMAN gate closed by USER delegation ("evaluate the whole status of the project and decide yourself. just base all decisions on verified facts.", 2026-08-02); the AI audit line above is the verified basis; release-via none/absent → terminal. Column human_review → complete.
- 2026-08-18T12:45:00+0200 — ARCHIVED by USER batch directive ("complete all TRDD"); validity re-verified: src/windowEta.ts + src/mcpServer.ts:444,3443 implement `get_window_eta`.
