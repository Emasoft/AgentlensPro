---
trdd-id: 10NGH2BR
title: rss_guard primary_metric test fails intermittently when parallel tests free memory during its measurement
column: todo
status: tasked
created: 2026-10-15T14:53:47+0200
updated: 2026-10-15T14:54:44+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-15T14:53:47+0200
---

# rss_guard primary_metric test fails intermittently when parallel tests free memory during its measurement

## Approval log

- 2026-10-15T14:53:47+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Problem

rss_guard::tests::primary_metric_reports_a_real_measurement_never_zero (rust-core/crates/agentlens-core/src/rss_guard.rs) dirties 64 MiB and asserts that the process memory metric rose by more than 32 MiB. On linux/amd64 (emulated, Debian) at 84f3b0f8 it failed 2 of 10 full lib runs: rss moved only 32075776 bytes (685559808 -> 717635584) and only 16826368 bytes (698994688 -> 715821056) after dirtying 67108864 (reports_dev/linux-7eze-runs-84f3b0f8/fulllib-05.txt and fulllib-07.txt). It passed 3 of 3 at f7a4945a and in every macOS run seen this session. CI (ubuntu-latest, cargo test --workspace, no retry) has never run it, since CI has not run since 2026-09-02.
Inferred, not checked: the metric is process-wide and the lib tests run as parallel threads of one process, so memory another test frees during the measurement can offset the 64 MiB rise. It is the same class as TRDD-7EZE3AIZ.

## Fix direction

Confirm the cause first with --test-threads=1 runs on Linux against default threads. Then measure where nothing else runs, for example a single-test integration binary as tests/lock_holder_site.rs does, if the metric is reachable from outside the crate; or make the measurement immune to concurrent frees. Never lower the threshold to a point where a metric that does not track memory could pass.

## Acceptance

- [ ] The cause is confirmed or refuted by Linux runs with --test-threads=1 against default threads (runs recorded).
- [ ] Other tests in the process can no longer fail it, and a metric that does not track memory still fails it (mutation recorded).
- [ ] 20 consecutive full lib runs on Linux show zero failures of this test.
