---
trdd-id: CAJ5RCP9
title: Durable cache-event history that joins the OTEL ledger with the statusline feed
column: todo
created: 2026-09-02T21:52:02+0200
updated: 2026-09-03T04:47:31+0200
current-owner: main-session
task-type: feature
priority: high
min-approval-requirement: none
blocked-by: []
related: [6SPXOV0P, 5PUD8RKE, B9ERTBZ9]
requested-by: user
eht: [9SYRK6SW, IRNHEN4Z, GVA8TTJF, QSFYIHUO]
---

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-03

- Investigation done (`reports/cache-history/20260902_224603+0200-storage-and-join-investigation.md`):
  the forensics fact DB is sql.js SQLite, NOT DuckDB, 5,730 rows, last indexed 2026-08-12
  (18 days stale), `break_cause`/`gap_minutes` always NULL, no `cache_miss_reason` /
  `previous_message_id` columns, join match 0/0 for this session, re-index hangs >8.5 min. So
  the durable table must be built fresh in DuckDB at ingest (bodies pass), not extended from the
  fact DB. Fable advisor's 7YPQWKPG verdict notes `forensics.db` is on-disk data read outside
  DuckDB and must be routed through this card.
- Design done (`reports/trdd-caj5rcp9/20260903_044515+0200-api-calls-table-design.md`): write
  site is `ingest_body` (`agentlens-store/src/lib.rs:323`, called from `pass.rs:486` before the
  settle/delete gate); `api_call` schema is one row per ingested FILE (request XOR response),
  keyed by `call_id` = filename stem (NOT `previous_message_id` — measured-dead for pairing);
  storage rides the existing store's single DuckDB connection as a 5th staging table, flushed by
  the existing `flush_detailed` loop, ≈20.5 MB/30 days, negligible vs the SSD budget; 90-day
  filename-epoch retention sweep (no existing store prunes today, per doctrine); `api_calls`
  (coalesced per-call) and `cache_turns` (statusline join) views with `union_by_name := true`
  load-bearing; three raw-body scanners (`cache_event_log.rs`, `cache_break_timeline.rs`,
  `burn/investigator_scan.rs::scan_window`) migrate to SELECT off the durable table.
  Split into 4 depth-1 EHT children, order 1→2→3→4:
  - **9SYRK6SW** — writer at the bodies-pass ingest site (first, unblocks everything, dispatchable now).
  - **IRNHEN4Z** — retention chore + 24h-survives-restart size verification (blocked-by 9SYRK6SW).
  - **GVA8TTJF** — coalesced view + statusline join view + acceptance SQL (blocked-by 9SYRK6SW;
    measures the real join match rate the investigation had 0 rows to test).
  - **QSFYIHUO** — migrate the 3 consumers off raw-body scanning, one file at a time (blocked-by
    9SYRK6SW and GVA8TTJF; satisfies acceptance box 2 literally — zero bodies on disk).
- NEXT ACTION: dispatch 9SYRK6SW (the writer) — it is unblocked and everything else depends on
  its output. Parent stays `column: todo` until all 4 EHTs are terminal (per NPT/EHT rule:
  parent cannot reach `complete` until every EHT is terminal).

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
