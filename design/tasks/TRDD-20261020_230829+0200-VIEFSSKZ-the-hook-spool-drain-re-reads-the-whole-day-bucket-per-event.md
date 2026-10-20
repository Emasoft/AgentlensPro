---
trdd-id: VIEFSSKZ
title: the hook-spool drain re-reads the whole day-bucket per event and strands ~1 GB of mimalloc pages
column: todo
status: tasked
created: 2026-10-20T23:08:29+0200
updated: 2026-10-20T23:09:01+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: manager
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-20T23:08:29+0200
project-id: agentlenspro
---

# the hook-spool drain re-reads the whole day-bucket per event and strands ~1 GB of mimalloc pages

## Symptom

`hook_events::drain_hook_spool` (rust-core/crates/agentlens-core/src/hook_events.rs:312) verifies
that each spooled hook event was durably appended by calling `bucket_contains_line`
(hook_events.rs:386), which does:

    let Ok(contents) = std::fs::read_to_string(bucket_path(events_dir, ts_ms)) else { return false };
    contents.lines().any(|l| l == line)

That reads the ENTIRE day-bucket file and scans it line by line — ONCE PER SPOOLED EVENT.

## Measured

The day-buckets are large (measured on this machine, 2026-10-20 23:07):

    ~/.agentlens/hook-events/2026-09-23.ndjsonl   75,526,419 bytes
    ~/.agentlens/hook-events/2026-10-20.ndjsonl   62,144,119 bytes   (growing live)
    ~/.agentlens/hook-events/ total              604 MB across 28 files

The spool held 1,155 files at measurement time, and the live drain log shows single ticks of
296, 181, 14, 12 and 5 events. A 296-event tick against a 62 MB bucket is ~18 GB of read plus
line-by-line scan, in ONE drain call, under the state lock.

The live drain call sites: chores.rs:1063 (boot, unbounded — `usize::MAX`) and chores.rs:1284
(the periodic tick, 200 files per call).

## Why it is the memory defect

`/usr/bin/sample` on the live pid puts the top non-idle leaf inside this path:

    agentlens_core::chores::spawn_all
      -> agentlens_core::hook_events::drain_hook_spool
         -> std::fs::read_to_string -> str::converts::from_utf8
         -> str::pattern::CharSearcher::next_match
            -> mi_arenas_page_free -> mi_arena_schedule_purge -> _mi_os_purge_ex

The `mi purged` counter grows at a median of 287 MB/s (p90 36,817 MB/s, max 336,892 MB/s) across
the 7,898-line composition corpus — the process is madvising away hundreds of megabytes per second
of scratch buffers.

## The fit that names the cap breach

The composition corpus (7,898 lines) fits `commit = mi_live + abandoned_pages * 64 KiB` with a
median residual of +3.6% of commit; 128 KiB and 256 KiB page sizes fit far worse, and `live` alone
leaves a 50% hole. At the breach states the model lands on 2,046-2,058 MB against a measured commit
of 2,270-2,293 MB — and the 2048 MB RSS cap falls out as exactly the crossing point of
live (~1,030 MB) + abandoned x 64 KiB (~1,016 MB).

mimalloc increments `pages_abandoned` when a page's owning thread dies without freeing it
(libmimalloc-sys-0.1.49 c_src/mimalloc/v3/src/arena.c:1141,1156). The hook-spool drain runs on
per-tick worker threads; when those threads die, their pages stay committed.

## What is NOT established

- The link between the drain's CHURN and the ABANDONED pages is NOT established. The report that
  derived the model says so explicitly: `mi purged` and `mi abandoned` are different counters, and
  the correlation of `free-in-page` with `abandoned` is only 0.383. The drain is the hottest
  allocator path (the stack sample proves it); the model says ~1,015 MB sits in pages whose owner
  died. The CAUSE of the dead owners is not yet named.
- ~270 MB of the live heap is unattributed.

## What is NOT the cause (measured, and worth keeping)

- The resident parsed card layer: 466.4 MB, measured over the real corpus (42,986 rows, 95.5 MB of
  card text -> 4.88x amplification), two independent derivations agreeing to 0.0006%. That is 26.8%
  of the live heap, NOT all of it.
- The card corpus is not what breaches the cap: an ISOLATED instance (a copy of the same
  cards.duckdb on a --data-dir copy, --no-log-scan) reuses the same 42,963 cards and STABILISES at
  970 MB - 1.22 GB RSS, while the live server reaches 2.9 GB.
- DuckDB: measured at ~354 MB resident, in the SYSTEM allocator, outside mimalloc's commit.
- The window spans: ~2 MB for 1,210 spans.

## Proposed fix (measure first)

The verification exists to prove the spooled event is already durable in the bucket, so a spool file
is only kept when durability is UNPROVEN. The read-back does not need to scan the whole bucket:

- Read the bucket ONCE per drain call, not once per event: the events in one drain share
  `now_ms` and therefore share a bucket, so one read serves all of them. (Check this: `now_ms` is
  the drain's timestamp, so the bucket is the same for every event in a call.)
- Or, better, avoid the O(bucket) scan: seek to the END of the bucket and read only the tail,
  since a just-appended record is at the end. The existing comment says the full scan was chosen
  because a concurrent append would make a last-line check spuriously fail — a tail read of the
  last N KB keeps that property at O(1) instead of O(bucket).
- The size of the day-buckets themselves (604 MB) is a separate retention question: buckets older
  than the retention window should be pruned, or the per-event cost stays proportional to the
  bucket's age.

## Acceptance

- [ ] A drain tick's total bytes read is measured and is O(bucket) per CALL, not per event.
- [ ] The verification still catches a genuinely-absent record (a negative test: an event that was
      NOT appended is still detected as unproven and its spool file is KEPT).
- [ ] The concurrent-append property the current comment describes still holds (a record appended by
      another writer mid-drain is not spuriously reported as absent).
- [ ] `cargo clippy --all-targets -D warnings` is clean.

## Notes

- Measured 2026-10-20 22:24:09 the live log: "hook-spool: drained 296 event(s), quarantined 0 bad,
  kept 0 unverified, kept 0 for retry".
- The 604 MB of day-buckets is itself worth a card if the fix lands as a tail-read: the buckets are
  retained far longer than the events they hold.

## Approval log

- 2026-10-20T23:08:29+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
