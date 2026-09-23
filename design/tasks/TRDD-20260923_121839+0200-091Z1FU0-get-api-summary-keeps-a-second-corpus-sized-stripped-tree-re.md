---
trdd-id: 091Z1FU0
title: GET /api/summary keeps a second corpus-sized stripped tree resident and costs about 340 MB per read
column: todo
created: 2026-09-23T12:18:39+0200
updated: 2026-09-23T12:18:39+0200
current-owner: main-session
created-by: main-session
task-type: bugfix
min-approval-requirement: none
assignee: main-session
mandate: true
mandated-by: none
approved: true
approval-judge: main-session
approval-datetime: 2026-09-23T12:18:39+0200
---

# GET /api/summary keeps a second corpus-sized stripped tree resident and costs about 340 MB per read

Symptom: one GET /api/summary at ~11:59 on 2026-09-23 raised phys_footprint 1.70 -> 2.04 GB (peak 2,144 MB) and a guard exit followed at 12:03:14 (uptime 640 s); causation not proven.

Suspected path (? INFERRED, to verify): ui.rs `stripped_now` (~465-478) stores the stripped tree in `stripped_cache` (resident until the next version), `strip_session_detail` copies every card, then `.to_string()` serializes ~47 MB.

Scope: measure first on an isolated instance (reads are +340 MB each, so never probe the live collector); fix follows from the measurement (pagination belongs to TRDD-KBM09XHB).

Evidence: docs_dev/alcore-rebuild-fix/20260923_120809+0200-advisor.md §3.3 and §7.

related: [MBQ9LXAN, 7RM5YW2T, KBM09XHB, WKLD508O]

## Approval log

- 2026-09-23T12:18:39+0200 — MANDATE issued by main-session (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
