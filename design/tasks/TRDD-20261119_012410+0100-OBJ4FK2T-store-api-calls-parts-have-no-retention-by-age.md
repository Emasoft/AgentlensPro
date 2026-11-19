---
trdd-id: OBJ4FK2T
title: store api_calls parts have no retention by age
column: todo
status: tasked
created: 2026-11-19T01:24:10+0100
updated: 2026-11-19T02:03:44+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-19T01:24:10+0100
---

# store api_calls parts have no retention by age

Split out of TRDD-IRNHEN4Z on 2026-11-19 as a release blocker of TRDD-HSPUF5XH: only the retention by age gates the tag; IRNHEN4Z keeps the part compaction by count and the 24h-survives-restart verification (not gating). Facts: this release is the first to ship the api_call writer (the 16 implementation commits of 9SYRK6SW, N6A8VX3G, GVA8TTJF and QSFYIHUO are absent from v2.33.1, HSPUF5XH RELEASE-LIST FACTS round 2 item 1). On this machine ~/.agentlens/store/api_calls held 10,080 part files, 166,656 KiB (du -sk, 2026-11-18). A grep on 2026-11-19 of rust-core/crates/*/src, src/store and src/forensics*.ts for lines naming api_calls with a compact, retain, retention, prune, purge, vacuum, delete or remove word found only SQL ON DELETE CASCADE foreign keys (forensics_db.rs:98,107; src/forensicsDb.ts:122,131) and the comment at src/store/db.ts:96 saying the TypeScript side must never delete api_calls; a purge written without the name on the same line is not covered; purge_tick (chores.rs:128-162) purges only hook-events, log-events and statusline (read 2026-11-18).

## Acceptance
- [ ] Parts of store/api_calls older than a stated age are removed by a chore, with the age and its reason written where the chore is defined.
- [ ] A test seeds parts older and newer than the age and shows only the older ones removed, and fails on the code of today.
- [ ] Readers of api_calls (forensics, cache turns, burn investigator) are checked to need no row older than the age, or the age is chosen above what they read.

## Approval log

- 2026-11-19T01:24:10+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Notes and lessons learned

2026-11-19 facts from W79 (report reports_dev/sonnet-worker/20261119_w79-objfk2t-research/report.md, read by the main agent): parts are flat files store/api_calls/part-<epoch_ms>-<pid>-<n>.parquet named at flush (agentlens-store lib.rs:653), about one per minute with traffic; no compaction exists; readers list the directory at query time and fail open on a vanished part (one degraded answer at worst); the part_file catalog row of a removed file is dropped by the next sync_new_parts; forensics.db api_calls is a different SQLite table. Windowed readers reach back at most 48 h per call, rate_limit_report up to 336 h (14 days); cache_turns_sql, get_cache_event_log with window 0, a timeline with no window, untilIso and raw SQL are unbounded.
2026-11-19 DESIGN decided by the main agent: age 31 days by default, a retention knob like logEventsRetentionDays (key apiCallsRetentionDays, env AGENTLENS_API_CALLS_RETENTION_DAYS, minimum 1). WHY 31: the same default as hook-events and log-events, above the 14-day reach of every windowed reader, and it bounds the folder at about 31 days of parts (about 0.7 GB at the 166 MB per 7 days seen on 2026-11-18, INFERRED rate). Unbounded readers see at most 31 days of api_calls after the purge; that is accepted and written at the chore. Mechanism: a part older than the cutoff by the epoch in its NAME is removed; a name that does not parse is never removed; the name parser lives next to the writer in agentlens-store so the two cannot drift; purge_tick calls it hourly after the other purges. A part removed during the bodies pass fsync barrier fails that batch once and it is retried (pass.rs:520-545); accepted. A backlog flush can put old rows in a new part, which then lives longer than the age; accepted (row-level purge would need a part rewrite).
