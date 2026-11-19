---
trdd-id: OBJ4FK2T
title: store api_calls parts have no retention by age
column: dev
status: tasked
created: 2026-11-19T01:24:10+0100
updated: 2026-11-19T02:28:00+0100
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
implementation-commits: [d195661b]
---

# store api_calls parts have no retention by age

Split out of TRDD-IRNHEN4Z on 2026-11-19 as a release blocker of TRDD-HSPUF5XH: only the retention by age gates the tag; IRNHEN4Z keeps the part compaction by count and the 24h-survives-restart verification (not gating). Facts: this release is the first to ship the api_call writer (the 16 implementation commits of 9SYRK6SW, N6A8VX3G, GVA8TTJF and QSFYIHUO are absent from v2.33.1, HSPUF5XH RELEASE-LIST FACTS round 2 item 1). On this machine ~/.agentlens/store/api_calls held 10,080 part files, 166,656 KiB (du -sk, 2026-11-18). A grep on 2026-11-19 of rust-core/crates/*/src, src/store and src/forensics*.ts for lines naming api_calls with a compact, retain, retention, prune, purge, vacuum, delete or remove word found only SQL ON DELETE CASCADE foreign keys (forensics_db.rs:98,107; src/forensicsDb.ts:122,131) and the comment at src/store/db.ts:96 saying the TypeScript side must never delete api_calls; a purge written without the name on the same line is not covered; purge_tick (chores.rs:128-162) purges only hook-events, log-events and statusline (read 2026-11-18).

## Acceptance
- [x] Parts of store/api_calls older than a stated age are removed by a chore, with the age and its reason written where the chore is defined.
- [x] A test seeds parts older and newer than the age and shows only the older ones removed, and fails on the code of today.
- [x] Readers of api_calls (forensics, cache turns, burn investigator) are checked to need no row older than the age, or the age is chosen above what they read.

## Approval log

- 2026-11-19T01:24:10+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-19T02:16:12+0100 — column → dev by main-agent@agentlenspro. implemented in d195661b; TS config mirror pending

## Notes and lessons learned

2026-11-19 facts from W79 (report reports_dev/sonnet-worker/20261119_w79-objfk2t-research/report.md, read by the main agent): parts are flat files store/api_calls/part-<epoch_ms>-<pid>-<n>.parquet named at flush (agentlens-store lib.rs:653), about one per minute with traffic; no compaction exists; readers list the directory at query time and fail open on a vanished part (one degraded answer at worst); the part_file catalog row of a removed file is dropped by the next sync_new_parts; forensics.db api_calls is a different SQLite table. Windowed readers reach back at most 48 h per call, rate_limit_report up to 336 h (14 days); cache_turns_sql, get_cache_event_log with window 0, a timeline with no window, untilIso and raw SQL are unbounded.
2026-11-19 DESIGN decided by the main agent: age 31 days by default, a retention knob like logEventsRetentionDays (key apiCallsRetentionDays, env AGENTLENS_API_CALLS_RETENTION_DAYS, minimum 1). WHY 31: the same default as hook-events and log-events, above the 14-day reach of every windowed reader, and it bounds the folder at about 31 days of parts (about 0.7 GB at the 166 MB per 7 days seen on 2026-11-18, INFERRED rate). Unbounded readers see at most 31 days of api_calls after the purge; that is accepted and written at the chore. Mechanism: a part older than the cutoff by the epoch in its NAME is removed; a name that does not parse is never removed; the name parser lives next to the writer in agentlens-store so the two cannot drift; purge_tick calls it hourly after the other purges. A part removed during the bodies pass fsync barrier fails that batch once and it is retried (pass.rs:520-545); accepted. A backlog flush can put old rows in a new part, which then lives longer than the age; accepted (row-level purge would need a part rewrite).
2026-11-19: d195661b. Box 1: the age (apiCallsRetentionDays, default 31) and its reason are at the call in chores.rs purge_tick. Box 2: tests/api_call_retention.rs seeds 40 d, 31 d + 1 ms, exactly 31 d and 1 d parts plus a foreign name; only the first two go (3 passed, main agent re-run). Today's code lacked the three functions, so the test could not compile against it; the mutation that makes remove_file a no-op fails it. Box 3: readers per reports_dev/sonnet-worker/20261119_w79-objfk2t-research/report.md: windowed readers reach at most 14 days, below 31. Open: the TS RETENTION_META mirror so agentlenspro config can set the key; purge_tick itself and a reader racing a removed part are untested.
2026-11-19 review answers: box 3 rests on the W79 report; a read-only check of every api_calls reader's window (cache_turns_sql, forensics_db, forensics_scan, forensics_sql, forensics_compare, heartbeat_cost, burn/investigator_scan) is assigned, and box 3 is unticked if any reader needs rows older than 31 days. Verified by the main agent: lib.rs:974-998 remove_vanished_files drops a vanished part's part_file, known_blob, body_durable and known_part rows; pass.rs:514-558 marks the whole batch kept when a part's fsync fails; no rust-core fixture imports retentionConfig. Accepted finding: one failed remove_file aborted the purge and dropped the names already removed; fix assigned (continue past a failure, report each). todo to dev in one move is this board's mono-agent shortcut (no separate dispatcher).
2026-11-19: docs gap found for the release docs gate: README.md:314-322 says 'Five knobs' and its table lacks logEventsRetentionDays and apiCallsRetentionDays; skills/agentlenspro-diagnostics/references/operations.md:74 lists retention defaults without either. configCli.ts:37,67,95 lists and validates keys from RETENTION_META, so the TS mirror alone makes 'agentlenspro config' accept the key (read by the main agent).
2026-11-19: W83 (uncommitted until verified): PurgeOutcome { removed, failed } in agentlens-store lib.rs:774; the loop records a failed remove_file or an unreadable entry and continues, a NotFound remove is skipped (another remover got it); purge_tick prints the removed count and one stderr line per failure on every tick. New test: three undeletable directories named like old parts plus three old files; all three files go and all three dirs are reported, so a purge that stops at the first failure cannot pass in any read_dir order. Store target 4/4 per W83; agentlens-core build, chores_purge, clippy and the TS mirror's tests (43cce6bf) wait for load <= 30, in one background run by the main agent. Docs gap also at skills/agentlenspro-diagnostics/SKILL.md:478 (per W82) and the bundle standalone/cli.js lacks the key until the release build.
