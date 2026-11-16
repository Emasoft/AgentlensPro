---
trdd-id: HWP0PBCE
title: the bodies export reports a store open failure only in the HTTP body and logs nothing
column: todo
status: tasked
created: 2026-10-23T03:45:49+0200
updated: 2026-10-23T03:46:03+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-23T03:45:49+0200
---

# the bodies export reports a store open failure only in the HTTP body and logs nothing

Found 2026-10-23 (TRDD-R36S0PS9 run): both narrowed exports returned HTTP 500 with a DuckDB spill-cap error from the store open, while server.log had no error, open, or [info] line at all. body_archive.rs bodies_export returns the store half's failure only in the response (failed list / 500). An operator reading the log sees nothing. Fix: log the store open failure once (rate-limited, with the error text) on the export and purge paths, as the bodies pass does. Related: TRDD-XRTH2MEI.

## Approval log

- 2026-10-23T03:45:49+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
