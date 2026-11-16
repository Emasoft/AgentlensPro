---
trdd-id: 4B2O9GJN
title: rss_hard_cap test fails intermittently under the full agentlens-core suite
column: todo
status: tasked
created: 2026-10-23T03:13:56+0200
updated: 2026-10-23T03:31:46+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-23T03:13:56+0200
---

# rss_hard_cap test fails intermittently under the full agentlens-core suite

First full run of cargo test -p agentlens-core during TRDD-1FWN9XBS Change 1 (2026-10-23) had one failing test. The rss_hard_cap test binary printed "RSS HARD CAP - mimalloc commit 17592186043396 MB > cap 2048 MB, exiting" and exited non-zero. That figure is about 2^44 MB, which looks like an allocator counter underflow; the cause is NOT established. Isolated reruns of cargo test -p agentlens-core --test rss_hard_cap, all after the Change 1 store work: run 1 9 passed 0 failed, run 2 9 passed 0 failed, run 3 9 passed 0 failed. A later full-suite rerun passed (930 passed, 0 failed, per docs_dev/20261023-change1-finish-report.md). Open: reproduce under the full suite load; find where the commit counter is read and whether parallel tests can make it underflow (not investigated).

## Approval log

- 2026-10-23T03:13:56+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Deploy-gating (2026-10-23)

Deploy-gating with TRDD-12FGMAEP: step 4 keys the 2 GB guard on mimalloc commit, so a wrapped reading (17592186043396 MB is 2^64 B / 2^20 minus about 1,020 MiB: a value about -1 GiB that wrapped when read as unsigned; whether a single counter or a computed difference is not established, INFERRED) would make the guard exit a healthy server if the guard reads the same figure the failing test printed (not checked). Proposed fix independent of root cause: treat a commit figure above physical RAM as unreadable (log it, do not exit). Not established that production can hit it (seen only in the test binary, not reproduced in 3 isolated reruns).
