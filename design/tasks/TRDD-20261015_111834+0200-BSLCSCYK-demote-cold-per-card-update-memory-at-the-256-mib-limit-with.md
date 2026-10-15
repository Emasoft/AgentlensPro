---
trdd-id: BSLCSCYK
title: demote_cold per-card UPDATE memory at the 256 MiB limit with large timeline cards is unmeasured
column: todo
status: tasked
created: 2026-10-15T11:18:34+0200
updated: 2026-10-15T11:18:34+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: spike
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-15T11:18:34+0200
---

# demote_cold per-card UPDATE memory at the 256 MiB limit with large timeline cards is unmeasured

## Problem
Split from TRDD-MEPIRHI4 (review of 42998aa1). After f9e0742e, demote_cold fetches each candidate by primary key and UPDATEs it to its stripped form. With 4 KB timeline entries in a test store, no tested memory limit let the old read fail while demote_cold succeeded, because the per-card UPDATEs needed more (reports_dev/kmf02uex-impl-report.md). At the production limit of 256 MiB with 80 KB to 2.3 MB cards it is unmeasured. If demotion fails there, timelines are never stripped and resident memory grows.

## Fix direction
On copies of the m0b states (live, large-r30, compact), at memory_limit 256 MiB and threads 2 as production sets them, run the post-f9e0742e demotion path with hot_cards BELOW the 31 timeline cards (for example 1), so the large cards are actually fetched and UPDATEd; at the production hot set of 50 nothing is demoted on these copies. Record each outcome (count demoted or the error text) and the floor.

## Acceptance
- [ ] The demotion path is run at 256 MiB on the live, large-r30 and compact copies with hot_cards below 31, and each outcome and its memory floor are recorded.

## Approval log

- 2026-10-15T11:18:34+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
