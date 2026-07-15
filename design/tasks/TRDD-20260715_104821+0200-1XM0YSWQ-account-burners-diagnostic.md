---
trdd-id: 1XM0YSWQ
title: get_account_burners — who exhausted a given OAuth account's rate-limit window, ranked
column: ai_review
created: 2026-07-15T10:48:21+0200
updated: 2026-07-15T11:10:00+0200
current-owner: main
task-type: feature
scope: project
parent-trdd: BURNWDGT
npt: []
eht: []
---

# get_account_burners — who exhausted a given account's window

## ⏵ STATE — 2026-07-15 ~11:10 — LANDED + LIVE-VERIFIED

Implemented, tested (13 tests, suite 1211 green), bundled + deployed (pid 94779), live-verified:
previous account = fmuaddib@gmail.com (75099fe9, rotated out 10:20+0200). Its final 5h window:
1,247 calls, 76.1M equiv, $507 across 11 sessions — top 3 = ai-maestro MANAGER 25%, ANIME2SVG 19%,
llm-externalizer 14% (58% combined). 7d: 452.5M equiv / $2,972 — ANIME2SVG 19% ($872) the single
biggest. Coverage full (oldest event Jul 7 < window start). Docs: CHANGELOG 2.7.0 + skill.
Awaiting user review → complete.

**USER request (2026-07-15, verbatim):** "who is responsible for exhausting most of the previous 5h
or 7d window of the previous account (i had to rotate account because the sudden spike exhausted the
previous one)? (this is another command to add to the cli)"

## Gap

`investigate_burn` ranks window culprits but has NO account filter (pools all accounts in the
timeframe); `get_window_budget --accountId` is per-account but has NO per-session ranking. The
question "who burned the PREVIOUS account's window" needs both: per-account scoping × per-session
ranking.

## Design

New MCP tool `get_account_burners` (auto-exposed as `agentlenspro get_account_burners`).

**Account resolution** from the machine's account-state timeline (`~/.agentlens/account-state.ndjson`,
the change-detected rotation log): consecutive records collapse into SEGMENTS
`[{accountId, email, plan, startMs, endMs}]`. `--account` accepts `previous` (default — the account of
the segment immediately before the current one), `current`, a uuid prefix, or an email.

**Attribution is TIME-based, not card-based.** One keychain OAuth token is active machine-wide at a
time, and running sessions pick up the rotated token — so a session alive across a rotation burns TWO
accounts' windows. `ConsumptionEvent.accountUuid` comes from `card.accountId` (one value per session)
and cannot express that. An event belongs to the target account iff its `ts` falls inside one of the
TARGET's segments ∩ the requested window `[until − windowHours, until]`. `until` defaults to the
target's last-active instant (the rotation-out moment) — exactly "the window that got exhausted".

**Consumption events** = the burn monitor's own deduped stream (`gatherConsumptionEvents`: OTEL
api_request timeline events, statusline billing deltas for no-OTEL sessions) via a new
`getConsumptionEvents` accessor on McpServerOptions (the server already gathers this for the burn
tick — `gatherBurn()`).

**Ranking** by billable-weighted tokens (BILLABLE_WEIGHTS: output 5×, cacheRead 0.1×, cacheCreate
1.25×) — the truthful window-fill metric — with cost, raw tokens, bucket split, per-session share,
top attribution (agent:/skill:/compaction/main), workspace/model from cards. COVERAGE is disclosed:
when the oldest available event is younger than the window start, the report says so instead of
silently under-reporting.

## Files

- `src/accountBurners.ts` (NEW) — `segmentsFromRecords` (pure), `readAccountSegments` (fs wrapper),
  `resolveTargetAccount`, `buildAccountBurnersReport` (pure merge/rank/format, preformatted `text`).
- `src/mcpServer.ts` — TOOLS entry + handler + `getConsumptionEvents?` accessor.
- `standalone/server.ts` — pass `() => gatherBurn().events`.
- `src/test/accountBurners.test.ts` (NEW) — segments, previous/current/prefix/email resolution,
  cross-rotation exclusion, ranking/shares, coverage disclosure, text rendering.
- Docs: CHANGELOG, skill SKILL.md.

## DERIVED tasks

- Cross-rotation sessions: per-event-ts attribution (above) — the card-level accountUuid would
  mis-pool; a test pins the exclusion.
- Timeline absent/torn (fresh install): degrade with an explicit error naming the file, never throw.
- 7d windows may exceed event retention: coverage disclosure (oldestEventMs vs windowStart).
- Deploy law: esbuild success + server restart + live CLI verification before reporting done.

## Verify

`pnpm run compile` green; new tests pass; live `agentlenspro get_account_burners` (default =
previous account) names the top burner sessions of fmuaddib's exhausted window with shares.
