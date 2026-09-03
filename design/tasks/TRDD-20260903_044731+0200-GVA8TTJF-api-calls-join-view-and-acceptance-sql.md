---
trdd-id: GVA8TTJF
title: api_calls coalesced view, cache_turns statusline join, and the acceptance SQL
column: planned
created: 2026-09-03T04:47:31+0200
updated: 2026-09-03T04:47:31+0200
current-owner: main-session
task-type: feature
priority: high
min-approval-requirement: none
parent-trdd: CAJ5RCP9
created-by: main-session
npt: []
eht: []
blocked-by: [9SYRK6SW]
---

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-03

- Design source: `reports/trdd-caj5rcp9/20260903_044515+0200-api-calls-table-design.md` §4-5
  (acceptance SQL block).
- Blocked on 9SYRK6SW (the writer) — needs real rows to test the join match rate against; the
  investigation report had 0 rows to test with.
- NEXT ACTION: once 9SYRK6SW has produced real parts, create the two views and run the acceptance
  query against live data to measure the actual statusline join match rate.

## WHY

`api_call` is one row per ingested FILE (request XOR response); consumers need one row per CALL
and a join to the statusline samples to get write% for the same turn. Card CAJ5RCP9 acceptance
box 3 requires exactly this joined query to exist and be documented.

## WHAT

Create both views exactly as specified in the design doc §4 (verbatim SQL there — do not
re-derive):

- `api_calls` view: `GROUP BY call_id` over `read_parquet('store/api_calls/*.parquet',
  union_by_name := true)`, coalescing request+response rows per call via `any_value`/`max`.
  `union_by_name := true` is load-bearing (schema-generation columns added later must not break
  older parts, per `ssd-write-economics.md`'s sibling trap and
  `statusline-capture-and-store.md` ATOM-7YR1-KLSM).
- `cache_turns` view: joins `api_calls` to `read_parquet('~/.agentlens/statusline/*/*/*.parquet',
  union_by_name := true)` on `session_id` + the 4 raw token-bucket columns + `abs(epoch delta) <=
  60`.
- The acceptance query (design doc §5, "every cold write in the last N hours with its miss reason
  and the statusline write% for the same turn") — document it in this card's body and make it
  runnable via `run_diagnostics_sql`.

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

## Approval log

## Notes and lessons learned
