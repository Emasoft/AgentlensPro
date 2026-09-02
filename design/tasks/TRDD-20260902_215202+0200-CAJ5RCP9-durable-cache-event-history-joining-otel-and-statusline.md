---
trdd-id: CAJ5RCP9
title: Durable cache-event history that joins the OTEL ledger with the statusline feed
column: todo
created: 2026-09-02T21:52:02+0200
updated: 2026-09-02T21:52:02+0200
current-owner: main-session
task-type: feature
priority: high
min-approval-requirement: none
blocked-by: []
related: [6SPXOV0P, 5PUD8RKE, B9ERTBZ9]
requested-by: user
---

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-02

- NEXT ACTION: read-only investigation of the forensics fact DB (`run_diagnostics_sql`) schema
  + retention, and the statusline parquet schema (`statusline_usage.rs`) — establish whether
  per-call cache facts (cache_creation/cache_read buckets, TTL tier, `cache_miss_reason`,
  `previous_message_id`, session id) are ALREADY durably stored anywhere before designing a new
  table. Then get advisor review of the design. Then implement.
- Nothing implemented yet. This card is intake only.

## WHY

USER directive (2026-09-02, verbatim): "make the system smarter. duckdb can use sql to
compare/intersect the otel logs with the statusline cache events to get the full picture.. i
want a full history of the cache events, so we can use to identify the root causes".

Today's evidence the history evaporates: the per-call cache facts exist only in the OTEL
response BODIES, which the bodies pass ingests and then DELETES (`server.log`: "bodies pass:
ingested 108, deleted 108"). `get_cache_event_log` scans those bodies and, for an hour with far
more calls than that, reported `responseFilesTotal: 5` — the ledger is a snapshot of whatever
bodies happen to still be on disk, not a history. The statusline feed (parquet store, one row
per 3s sample) carries the harness's own per-turn write%/cost/model/session id, but no miss
reason — so neither source alone answers "why did this turn cold-write".

## GOAL

- One durable DuckDB/parquet table of per-API-call cache facts, written at ingest time —
  BEFORE the response body is deleted by the bodies pass.
- A SQL view joining that table to the statusline samples on `session_id` + the turn's
  input-bucket tuple / time window.
- The existing cache tools (`get_cache_event_log`, `get_cache_break_timeline`, burn
  investigation) read the durable table, not raw bodies still on disk.
- Queryable ad-hoc via `run_diagnostics_sql`.

## NON-GOALS

- No new MCP server (standing rule: MCP servers are banned from Claude Code on this machine).
- No change to what Claude Code itself sends over OTLP.

## OPEN QUESTIONS

- Does `run_diagnostics_sql`'s forensics fact DB already hold these per-call cache facts? If
  yes, this card becomes "extend the existing table + add the join view + fix retention",
  not "build a new table".
- Exact join-key precision: is `session_id` + nearest-time-window enough, or does pairing
  need something sturdier (per doctrine in CLAUDE.md, `previous_message_id` pairing is
  measured-dead — most requests have no successor call).
- Retention/size budget for a growing per-call table — apply the doctrine in
  `.claude/project/memory/ssd-write-economics.md` before picking a retention window.

## ACCEPTANCE

- [ ] A 24h cache-event history survives a server restart (durable store, not in-memory).
- [ ] `get_cache_break_timeline` for a session reconstructs entirely from the durable table
      with ZERO response bodies present on disk for that session.
- [ ] One SQL query (documented) lists every cold write in the last N hours with its
      `cache_miss_reason` AND the statusline write% for the same turn, joined.
- [ ] Size/retention policy for the new table is documented and matches the SSD-write-economics
      doctrine.

## Approval log

## Notes and lessons learned
