---
trdd-id: IRNHEN4Z
status: tasked
title: api_calls part compaction by count, retention chore, and 24h-survives-restart verification
column: planned
created: 2026-09-03T04:47:31+0200
updated: 2026-09-03T04:59:59+0200
current-owner: main-session
task-type: feature
priority: high
min-approval-requirement: none
parent-trdd: CAJ5RCP9
derived: true
derived-kind: eht
created-by: main-session
npt: []
eht: []
blocked-by: [9SYRK6SW]
---

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-03

- **Retitled per Fable advisor verdict on CAJ5RCP9 (2026-09-03):** at ≈0.7 MB/day the AGE-based
  retention hazard is not real; the real hazard is PART COUNT — one part per settle × up to 16
  passes/tick, and parquet reads degrade below ~1k rows (measured: seconds per file-list rebind,
  `lib.rs:54-57`). This card is now primarily a **compaction-by-count** chore, with the 90-day
  age-based sweep and the 24h-survives-restart check as secondary items. This is deliberately the
  LAST of the 4 children — it needs 9SYRK6SW's real part-emission rate to size the compaction
  trigger correctly.
- Design source: `reports/trdd-caj5rcp9/20260903_044515+0200-api-calls-table-design.md` §3.
- Blocked on 9SYRK6SW (the writer) — needs real `store/api_calls/*.parquet` parts to prune/verify
  against.
- NEXT ACTION: once 9SYRK6SW lands and the other 3 children (GVA8TTJF, QSFYIHUO) have had time to
  accumulate real parts, add the count-based compaction sweep, then the age-based prune, then wire
  the acceptance-box-1 smoke check.

## WHY

`store/api_calls/` is a flat, un-day-partitioned part layout (design doc §3) — neither
`forensics.db` nor `store/bodies|parts|blobs` prune today, and `store/parts` growing to 450M rows
unpruned is the investigation report's own cautionary example. Estimated BYTE growth is negligible
(≈20 MB/month, §2) but PART COUNT is the real hazard: one part per settle, up to 16 passes per
tick, and `read_parquet` over a multi-file glob measurably slows (seconds per file-list rebind,
`lib.rs:54-57`) once part count grows past roughly 1k files. The doctrine ("how big can this store
get") still requires an explicit sweep rather than relying on smallness holding forever, but the
sweep must compact by COUNT first, prune by AGE second.

## WHAT

- **Compaction by count (primary):** when `store/api_calls/*.parquet` part count exceeds a
  threshold (start at ~1k, per the measured degradation point in `lib.rs:54-57`), merge the oldest
  parts into a single consolidated part (read + rewrite via DuckDB, then delete the originals) —
  bounds part count independent of byte volume.
- **Retention by age (secondary):** a `delete_stale_parts(dir, cutoff_ms)`-style sweep over
  `store/api_calls/*.parquet`, filename-epoch based (parts are named `part-<epoch_ms>-...`,
  `lib.rs:213` — pure filename comparison, no query needed). 90-day retention (matches
  `.trashcan` purge default elsewhere on this machine).
- Wire both sweeps into the existing chores tick (same cadence family as `bodies_pass`).
- Card CAJ5RCP9 acceptance box 1: a 24h cache-event history survives a server restart. Add a smoke
  check that confirms parquet parts under `store/api_calls/` are present and queryable after a
  restart with no server-side cache warm-up required.

## ACCEPTANCE

- [ ] Part count for `store/api_calls/` stays bounded under the compaction threshold across a
      sustained ingest run (verify with a synthetic burst of settles, not just a single tick).
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
