---
trdd-id: CAJ5RCP9
title: Durable cache-event history that joins the OTEL ledger with the statusline feed
column: todo
created: 2026-09-02T21:52:02+0200
updated: 2026-09-03T04:59:59+0200
current-owner: main-session
task-type: feature
priority: high
min-approval-requirement: none
blocked-by: []
related: [6SPXOV0P, 5PUD8RKE, B9ERTBZ9]
requested-by: user
eht: [9SYRK6SW, IRNHEN4Z, GVA8TTJF, QSFYIHUO, N6A8VX3G, TP3BA3ED]
---

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-03

- Investigation done (`reports/cache-history/20260902_224603+0200-storage-and-join-investigation.md`):
  the forensics fact DB is sql.js SQLite, NOT DuckDB, 5,730 rows, last indexed 2026-08-12
  (18 days stale), `break_cause`/`gap_minutes` always NULL, no `cache_miss_reason` /
  `previous_message_id` columns, join match 0/0 for this session, re-index hangs >8.5 min. So
  the durable table must be built fresh in DuckDB at ingest (bodies pass), not extended from the
  fact DB. Fable advisor's 7YPQWKPG verdict notes `forensics.db` is on-disk data read outside
  DuckDB and must be routed through this card.
- Design done (`reports/trdd-caj5rcp9/20260903_044515+0200-api-calls-table-design.md`) —
  **superseded on two points by the ADVISOR VERDICT below** (2026-09-03, Fable 5.1): the original
  design assumed request/response share a filename stem (`call_id`), which is false, and included
  `cost_usd` on the durable table, which cannot be computed inside `agentlens-store` (circular
  crate dependency on `agentlens-core`). Both are corrected in the re-spec'd children below.

  **ADVISOR VERDICT (design), verbatim:** "Stop — child 1's key premise is false (request and
  response files do NOT share a stem, and response bodies carry no session_id), so the
  `api_calls` coalesce view and the `cache_turns` join would return 0 rows by construction;
  re-spec child 1 around the real keys and add a small OTLP-side link writer before any view
  work." Orchestrator-verified on 80 captured bodies (2026-09-03 04:42): 0 requests named
  `req_*`; `cc_prev_req=` present in 39/39 request `system[0]` blocks; response keys = `content,
  diagnostics, id, model, role, stop_details, stop_reason, stop_sequence, type, usage` (no
  session id); requests carry `metadata.user_id` with `device_id` + `account_uuid` (+ session id)
  — device/account ids must NOT be persisted (no-identities doctrine).

- Split into **5** depth-1 EHT children (was 4 — the advisor verdict added one), order
  1→(2,5 in parallel)→3→4:
  - **9SYRK6SW** — writer at the bodies-pass ingest site, re-spec'd to two row kinds keyed by
    their own stem (request stem=uuid, response stem=request_id), `cost_usd` dropped (first,
    unblocks everything, dispatchable now).
  - **N6A8VX3G** — NEW: persist the OTLP-side request↔response link (session_id, span_id, kind,
    stem, request_id, ts_ms) at `call_body_registry.rs` so response rows can resolve a
    `session_id` (blocked-by: none — dispatchable in parallel with 9SYRK6SW, different crate:
    `agentlens-ingest` vs `agentlens-store`).
  - **GVA8TTJF** — coalesced relation + statusline join relation + acceptance SQL, re-spec'd to
    join on the N6A8VX3G link rather than a nonexistent shared `call_id` (blocked-by: 9SYRK6SW,
    N6A8VX3G).
  - **QSFYIHUO** — migrate the 3 consumers off raw-body scanning, one file at a time, `request_id`
    lookup instead of `call_id` (blocked-by: 9SYRK6SW, GVA8TTJF; satisfies acceptance box 2
    literally — zero bodies on disk).
  - **IRNHEN4Z** — retitled to part-compaction-by-count (the real hazard at this write rate) +
    age-based retention + 24h-survives-restart check, last (blocked-by: 9SYRK6SW).

## RISKS (advisor verdict, verbatim)

"(1) If newer CC names requests `req_*` too, the pairing objection collapses — signal: `find
<spool> -name 'req_*.request.json'` → verified 0. (2) If `cc_prev_req` appears only on subagent
turn ≥2, the chain degrades to `previous_message_id` only — verified present on 39/39. (3)
Part-file count, not bytes, is the retention hazard."

- NEXT ACTION: dispatch 9SYRK6SW (re-spec) + N6A8VX3G (the link child) in parallel — they touch
  different crates (`agentlens-store` vs `agentlens-ingest`) so there is no file contention.
  Parent stays `column: todo` until all 5 EHTs are terminal (per NPT/EHT rule: parent cannot
  reach `complete` until every EHT is terminal).

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
