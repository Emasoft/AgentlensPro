---
trdd-id: GVA8TTJF
title: api_calls coalesced view, cache_turns statusline join, and the acceptance SQL
column: planned
created: 2026-09-03T04:47:31+0200
updated: 2026-09-03T04:59:59+0200
current-owner: main-session
task-type: feature
priority: high
min-approval-requirement: none
parent-trdd: CAJ5RCP9
created-by: main-session
npt: []
eht: []
blocked-by: [9SYRK6SW, N6A8VX3G]
---

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-03

- **RE-SPEC per Fable advisor verdict on CAJ5RCP9 (2026-09-03):** `api_calls` must coalesce TWO
  row kinds keyed by DIFFERENT stems (request stem = uuid, response stem = `request_id`) — no
  shared `call_id` to `GROUP BY` on directly. And response rows carry no `session_id` on their
  own — this view's join can only resolve one once N6A8VX3G's link table exists. Both changes are
  now reflected in `blocked-by` and the WHAT below.
- Design source: `reports/trdd-caj5rcp9/20260903_044515+0200-api-calls-table-design.md` §4-5
  (acceptance SQL block) — superseded on the coalescing-key point by the advisor verdict.
- Blocked on 9SYRK6SW (the writer) and N6A8VX3G (the OTLP-side link) — needs real rows AND a real
  session_id link to test the join match rate against; the investigation report had 0 rows to
  test with.
- NEXT ACTION: once both are landed, create the two views and run the acceptance query against
  live data to measure the actual statusline join match rate.

## WHY

`api_call` is one row per ingested FILE (request XOR response); consumers need one row per CALL
and a join to the statusline samples to get write% for the same turn. Card CAJ5RCP9 acceptance
box 3 requires exactly this joined query to exist and be documented.

## WHAT

Views cannot be `CREATE VIEW`ed persistently — every DuckDB connection here opens per call
(`bodies_evidence.rs:70`, `transcript_sql.rs:401`, `statusline_store.rs:229`) — so expose these as
Rust relation builders via `run_transcript_sql` (`transcript_sql.rs:245`, the `relation_for`
pattern), not as SQL `CREATE VIEW` statements:

- `api_calls` relation: joins the `N6A8VX3G` link table to `read_parquet('store/api_calls/*.parquet',
  union_by_name := true)` on `stem`, so both request-kind and response-kind rows resolve a
  `session_id` (response rows get theirs from the link, not from their own row) — then coalesces
  per real call using the link's `request_id`↔uuid pairing (NOT a shared `call_id`, which does not
  exist — see STATE). `union_by_name := true` is load-bearing (schema-generation columns added
  later must not break older parts, per `ssd-write-economics.md`'s sibling trap and
  `statusline-capture-and-store.md` ATOM-7YR1-KLSM).
- `cache_turns` relation: first collapse the statusline stream to one row per turn (design doc §4
  note), then join to `api_calls` on `session_id` + the 4 raw token-bucket columns +
  `abs(epoch delta) <= 60`. Subagent calls share the parent's `session_id` but never appear in the
  main statusline stream — expect false negatives there, disambiguated by `cc_is_subagent` (body
  side) / `agent.name` + `query_source` (OTEL side, `spanstore/src/lib.rs:306-309`), not treated as
  join bugs.
- The acceptance query (design doc §5, "every cold write in the last N hours with its miss reason
  and the statusline write% for the same turn") — document it in this card's body and make it
  runnable via `run_transcript_sql`. (The OTEL↔SQL join proper — reading OTEL's ndjson/gz segments
  directly, `spanstore/src/lib.rs:3-5` — waits on 7YPQWKPG step 4; this card's join is body-table
  to statusline-parquet only.)

## MEASURE (not just implement)

- Run the acceptance query against real data once 9SYRK6SW has been live long enough to
  accumulate rows. Record the actual match rate between `api_calls` and the statusline feed —
  the design doc flags two known degraders (statusline's ≤1-sample/10s throttle collapsing
  bursts; `union_by_name` degrading silently on an all-missing column) and expects some
  unmatched rows, not zero.
- If the match rate is unexpectedly low, apply the ATOM-7YR1-KLSM fix (a zero-row typed template
  unioned first) before concluding the join key itself is broken.

## ACCEPTANCE

- [ ] `api_calls` view returns one row per `call_id` with request+response fields coalesced.
- [ ] `cache_turns` view joins successfully and returns a non-trivial number of matched rows
      against live data (not the 0/0 the investigation measured).
- [ ] The acceptance SQL (card CAJ5RCP9 box 3) runs via `run_diagnostics_sql` and returns
      `cache_miss_reason` + statusline write% for real cold writes in the last N hours.
- [ ] `session_id` is confirmed sealed VARCHAR end to end (no DuckDB per-file UUID inference
      breaking the join, per ATOM-KR07-9K0D).
- [ ] Response rows resolve a non-NULL `session_id` via the N6A8VX3G link table (not from their
      own row, which carries none natively).

## Approval log

## Notes and lessons learned
