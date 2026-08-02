---
trdd-id: 1XM0YSWQ
title: get_account_burners — who exhausted a given OAuth account's rate-limit window, ranked
column: complete
created: 2026-07-15T10:48:21+0200
updated: 2026-08-02T14:25:00+0200
current-owner: main
task-type: feature
scope: project
parent-trdd: BURNWDGT
npt: []
eht: []
---

# get_account_burners — who exhausted a given account's window

## ⏵ STATE — 2026-07-15 ~13:30 — v3: `--interval` selector (last/current/by-date), LIVE-VERIFIED

USER follow-up: choose the window interval. `until_iso` REPLACED by `--interval` (no legacy —
`resolveWindowUntil`): `last` (default = rotation-out moment), `current` (ends now), or an ISO date
(window ending at/including it); an unparseable value returns a named error, never a silent fallback.
Also exported `eventsForAccountInWindow` as the ONE shared attribution rule (now reused by the new
`get_window_eta`, TRDD-8ZMZ4I6B — cost-based ETA). Suite 1228 green, deployed pid 13647, all four
interval modes live-verified (current→462 calls tail, last→1247 until 10:20, date→806, bad→error).

## ⏵ STATE — 2026-07-15 ~11:35 — v2 LANDED (dual tables + project rollup + exhaustion marker), LIVE-VERIFIED [SUPERSEDED by v3 above]

USER follow-up implemented same day: (1) PROJECT/agent rollup — sessions pooled by workspace,
explicit cache-created + cache-read token columns; (2) BOTH windows (5h + 7d tables) in one call —
`window_hours` arg REMOVED (no legacy); (3) MOST LIKELY EXHAUSTED marker: fill% against calibrated
capacity — own `observed` calibration first, else a SAME-PLAN account's as a labeled proxy
(`resolveWindowCapacity`), else `undetermined` (never guessed). Suite 1215 green, deployed pid
74161, live: the owner account's 5h at **85%** vs 7d at 53% of the Max-20x proxy capacity → the 5h window
forced the rotation. 5h top: ai-maestro 25%, ANIME2SVG 19%, llm-externalizer 14%. 7d top:
ai-maestro 25% ($594, 3 sessions), ANIME2SVG 19% ($872), janitor 17%. Docs updated in place.
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
previous account) names the top burner sessions of the owner account's exhausted window with shares.

## Approval log

- 2026-08-02 — AI review PASSED (ai_review backlog audit): implementation verified present in the code first-hand, not from prose. Column ai_review → human_review; the remaining gate is the human. Evidence: reports/ai-review-audit/20260802_113207+0200-batchA-diagnostics.md
- 2026-08-02 — HUMAN gate closed by USER delegation ("evaluate the whole status of the project and decide yourself. just base all decisions on verified facts.", 2026-08-02); the AI audit line above is the verified basis; release-via none/absent → terminal. Column human_review → complete.
