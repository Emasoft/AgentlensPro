---
trdd-id: JVRPBSX9
title: get_cache_risk_costs ran past a 60 s read timeout over a 64 GiB transcript store in a debug test build
column: backburner
status: tasked
created: 2026-11-19T12:01:58+0100
updated: 2026-11-19T12:21:37+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-19T12:01:58+0100
---

# get_cache_risk_costs ran past a 60 s read timeout over a 64 GiB transcript store in a debug test build

Found 2026-11-19 while verifying TRDD-ER88PXNB C2. A test server whose log env was this machine's real home (71,040 transcript files, about 64 GiB under the Claude projects dir) left the MCP call get_cache_risk_costs unanswered for 60 s, 3 of 3 runs, in a debug (unoptimized) test build. With an empty home the same call answered in 0.20-0.42 s, 7 of 7 runs. The scan time was not measured, so the real-store scan is the most likely cause, not a proven one. The handler runs two transcript scans over the whole history plus up to 40 pooled sessions on spawn_blocking (ui.rs get_cache_risk_costs arm); its 20 s time_budget_ms bounds the pool, and it is not established whether it bounds the two scans. NEXT: time get_cache_risk_costs against the live release server (agentlenspro get_cache_risk_costs --out FILE, wall time) and in a debug build against a store sample of at most 4 GB; if the scans are unbounded, bound them by the same budget and say in the answer what was left out. Evidence: reports_dev/ER88PXNB/20261119_112650+0100-c2.md (section Intermittent hang).

## Approval log

- 2026-11-19T12:01:58+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Progress log

- 2026-11-19 12:21: measured once each, debug test build, real store of 71,040 transcript files (about 64 GiB): get_cache_risk_costs answered after 595.687 s (14-day server, first call) and 423.393 s (window-off server, second call); the remaining calls of that run took 3.67 s together. The 172 s gap between the two calls is unexplained. Release-build timing on the live server is still to do. Evidence: reports_dev/ER88PXNB/20261119_112650+0100-c2.md section 3.
