---
trdd-id: IRNHEN4Z
title: api_calls retention chore and 24h-survives-restart size verification
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

- Design source: `reports/trdd-caj5rcp9/20260903_044515+0200-api-calls-table-design.md` §3.
- Blocked on 9SYRK6SW (the writer) — needs real `store/api_calls/*.parquet` parts to prune/verify
  against.
- NEXT ACTION: once 9SYRK6SW lands, add the prune sweep + wire the acceptance-box-1 smoke check.

## WHY

`store/api_calls/` is a flat, un-day-partitioned part layout (design doc §3) — neither
`forensics.db` nor `store/bodies|parts|blobs` prune today, and `store/parts` growing to 450M rows
unpruned is the investigation report's own cautionary example. Estimated growth is negligible
(≈20 MB/month, §2) but the doctrine ("how big can this store get") still requires an explicit
sweep rather than relying on smallness holding forever.

## WHAT

- A `delete_stale_parts(dir, cutoff_ms)`-style sweep over `store/api_calls/*.parquet`, filename-
  epoch based (parts are named `part-<epoch_ms>-...`, `lib.rs:213` — pure filename comparison, no
  query needed).
- 90-day retention (matches `.trashcan` purge default elsewhere on this machine).
- Wire the sweep into the existing chores tick (same cadence family as `bodies_pass`).
- Card CAJ5RCP9 acceptance box 1: a 24h cache-event history survives a server restart. Add a smoke
  check that confirms parquet parts under `store/api_calls/` are present and queryable after a
  restart with no server-side cache warm-up required.

## ACCEPTANCE

- [ ] Parts older than 90 days (by filename epoch) are deleted by the sweep; parts within the
      window are untouched.
- [ ] The sweep runs on the existing chores cadence — no new timer/thread.
- [ ] 24h-survives-restart smoke check passes: kill and restart the server, `SELECT count(*) FROM
      read_parquet('store/api_calls/*.parquet')` returns the same row count as before restart.
- [ ] Retention window and size estimate are documented in this card (done above) matching
      `.claude/project/memory/ssd-write-economics.md` doctrine.

## VERIFICATION

1. Unit test for the epoch-cutoff filename filter (pure function, no I/O needed beyond a tmpdir
   of empty files named with synthetic epochs).
2. Manual restart test against a running dev instance with at least one flushed part present.

## Approval log

## Notes and lessons learned
