---
trdd-id: 1FEIW17E
title: get_body_writers — identify and rank the Claude sessions writing raw OTEL bodies
column: human_review
created: 2026-07-15T10:25:46+0200
updated: 2026-08-02T11:34:56+0200
current-owner: main
task-type: feature
scope: project
parent-trdd: K3WDPR7M
npt: []
eht: []
---

# get_body_writers — identify and rank the raw-body writer sessions

## ⏵ STATE — 2026-07-15 ~10:58 — LANDED + LIVE-VERIFIED

Implemented, tested (13 tests, suite 1198 green), bundled (esbuild OK, symbol in bundle),
deployed (server restart, pid 47700), live-verified over the CLI: 45 writers found, 6 ACTIVE
(top: 5.38 MB/min perfect-skill-suggester session 65af6f9e). Docs: CHANGELOG 2.7.0 + skill
SKILL.md. CLI flags are underscore-style (`--window_min`, generated from the live schema).
Awaiting user review → complete.

**USER request (2026-07-15, verbatim):** "identify exactly the claude sessions that are writing raw
bodies, and rank them according to the writing rate and total written. (this should be also added as
a command to the diagnostic cli tool)"

## Why

Until a Claude session is restarted it keeps `OTEL_LOG_RAW_API_BODIES` from its launch env and keeps
writing ~0.7–1.9 MB request bodies per LLM call into `~/.agentlens/otel-bodies/`. The user needs to
know WHICH sessions those are (to restart exactly them) and how much each one costs (rate + total).

## Design

New MCP tool `get_body_writers` (auto-exposed as `agentlenspro get_body_writers` — the CLI discovers
tools from the live schema, so one registration serves both surfaces).

**Attribution unit = the request body.** Requests carry `metadata.user_id` (escaped JSON with
`session_id`) in the tail — the same bounded 6KB read `extractRequestAttribution` already does.
Response bodies carry NO session metadata (realtime chain attribution via `previous_message_id`
exists in BodiesActivityTracker but lags one call and never covers a session's last response), and
requests dominate bytes by ~an order of magnitude (they re-serialize the whole conversation), so
responses are reported IN AGGREGATE, never guessed per-session.

**Two sources, merged without double counting:**
1. **Live dir scan** (`~/.agentlens/otel-bodies`) — stat every file; bounded-read every `.request.json`
   for session+model. Gives the NOW picture: recent rate (bytes in `--window-min`, default 30) and
   the `active` flag (wrote within `--active-min`, default 10).
2. **Store totals** (`SELECT session_id … FROM body WHERE kind='request' GROUP BY session_id` over
   `allOf(store,'body')`) — all-time ingested history per session (capture-ts correct post schema-v2).
   Overlap resolution: one query for recent `src_name`s; a live file whose name is already a store
   row is NOT re-counted — `totalBytes = storeBytes + liveNotIngestedBytes`, exact union.

**Enrichment:** session cards (`getSessions()`) map sessionId → workspace/source so the user can find
the terminal to restart. Rows the cards don't know keep `workspace: null` — never guessed.

**Ranking:** `rateMBmin` desc, then `totalBytes` desc. Null-session bytes land in one explicit
"unattributed" row (never silently dropped). Result carries a preformatted `text` table so the CLI
digest is directly readable.

## Files

- `src/bodyWriters.ts` (NEW) — `scanLiveBodyWriters` (fs), `queryStoreWriterTotals` (SQL),
  `buildBodyWritersReport` (pure merge/rank/format).
- `src/mcpServer.ts` — TOOLS entry + handler + `getStore?` accessor on McpServerOptions.
- `standalone/server.ts` — pass the live store handle through.
- `src/test/bodyWriters.test.ts` (NEW) — scan on synthetic fixtures, merge/rank rules, real-store
  SQL round-trip (no mocks).
- Docs: CHANGELOG, README, skill SKILL.md.

## DERIVED tasks

- Store may be absent/closed (server booting, store disabled) → tool must degrade to live-scan-only
  with an explicit note, never throw.
- Live dir may be absent (fresh install) → `available: false`, no crash.
- Deploy law (CLAUDE.md): feature exists at runtime only after `node esbuild.js` SUCCEEDS and
  `agentlenspro server restart` — verify the tool answers over the CLI before reporting done.
- Server restart happens while the wad verifier (K3WDPR7M Phase C) runs — safe: the verifier holds
  its own in-memory DuckDB instance and file handles; the server only appends new parts.

## Verify

`pnpm run compile` green; new mocha tests pass in `out/test/test/bodyWriters.test.js`; live
`agentlenspro get_body_writers` returns ranked writers with the known-active session(s) on top.

## Approval log

- 2026-08-02 — AI review PASSED (ai_review backlog audit): implementation verified present in the code first-hand, not from prose. Column ai_review → human_review; the remaining gate is the human. Evidence: reports/ai-review-audit/20260802_113207+0200-batchA-diagnostics.md
