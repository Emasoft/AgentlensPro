---
trdd-id: UGOAEGEC
title: Reuse the burn summary memo when it is younger than about 4 s whatever the data version
column: todo
status: tasked
created: 2026-10-27T16:58:34+0100
updated: 2026-10-27T16:58:34+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-27T16:58:34+0100
---

# Reuse the burn summary memo when it is younger than about 4 s whatever the data version

Follow-up from the item-2 review of TRDD-735Q3JF4 (burn summary subset, commit 53281f19). data_version moves on nearly every ingest, so on a busy server the burn summary memo misses most ticks, and each miss re-summarizes the whole OTEL window (up to 1,000,000 spans) with no rationing. Fix: reuse the memo when it is younger than about 4 s, whatever the data version. This also fixes the never-stored race and the duplicate work when a tick and a route miss together. While readers are present, window sessions are held twice (memo plus summary_cache).

Added motivation (2026-10-27): since d0fb2704 resident_blob_scan calls burn_summary_now every 30 s, and the MCP composition route calls it on each call, so the miss cost recurs on every composition read as well as on the burn tick.

Parent card: TRDD-735Q3JF4 (item 2 review follow-up).

## Approval log

- 2026-10-27T16:58:34+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
