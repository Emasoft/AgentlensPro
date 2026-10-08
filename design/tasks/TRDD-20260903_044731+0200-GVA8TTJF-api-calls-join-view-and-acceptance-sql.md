---
trdd-id: GVA8TTJF
title: api_calls coalesced view, cache_turns statusline join, and the acceptance SQL
column: planned
created: 2026-09-03T04:47:31+0200
updated: 2026-10-08T20:03:16+0200
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

- 2026-09-03T08:34:55+0200 — column names in the landed api_call table are `system_fps` and
  `billing_header` (there is no `system_fp`, `cc_version` or `cc_is_subagent` column); the join
  view must read those — see
  `reports/trdd-9syrk6sw/20260903_061039+0200-writer-implementation.md`.
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

## N6A8VX3G landed — join requirements for THIS card (2026-10-08)

The link table is real: NDJSON DeltaLog at <dataDir>/body-links.delta.ndjson (+ .snapshot.ndjson after each boot's compact_now), row = {"k":"<span>:<kind>:<ts>","v":{session_id, span_id, kind, stem, request_id, request_body_id, message_id, ts_ms}} — read with read_ndjson_auto. TWO HARD REQUIREMENTS before this card's acceptance SQL is written: (1) GUARD THE EMPTY-STRING KEYS: N6A8VX3G rows default absent Options to '' (fixed-width schema stability) — on pre-2.1.274 traffic request_body_id is '' on BOTH a request row and a response row of DIFFERENT calls, which cross-match in an equality join (NULL would have been join-safe; '' is not). Every join on request_body_id/message_id/stem MUST add <> '' guards, or the cache_turns join silently produces false pairs. (2) THE LINK RESOLVES session_id BY STEM/PTR-KEYS, NOT RESOLUTION: response api_call rows written by 9SYRK6SW carry session_id only when extract_meta found it in the body; the link table's job is the durable stem↔session binding plus the exact pairing keys — join api_call.stem to link.stem (with kind awareness), not to a nonexistent in-memory resolution step. Also: the link table's rows are NDJSON (the card's parquet parenthetical was superseded — read_ndjson_auto does NOT tolerate a torn trailing line; the boot-compact heals it, but a snapshot older than the last crash delta is the readable form).

## Correction (2026-10-08, review round 2)

The 'TWO HARD REQUIREMENTS' entry above is marked: CONTINGENT on N6A8VX3G reaching a terminal column (it is in testing; if its wire-path gap or torn-tail question changes the row shape, this entry goes stale). The <> '' guard is recorded as a NAMED DEFECT OF THE ROW FORMAT — NULL at the source was the better contract (own the burden once); consumer-side guards own it forever and punish omission silently. This card's SQL design work does NOT need the deployed binary: its blockers' CODE is landed (9SYRK6SW in deploy pending the owner's restart, N6A8VX3G in testing); per the mono-agent hygiene rule the parent may move this card to todo and begin design against the landed code while the column formally stays blocked-by-terminal.
