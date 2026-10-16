---
trdd-id: OYE4GWYD
title: A DuckDB FATAL on a card put from a damaged secondary index crash-loops the collector until the card store is rebuilt
column: backburner
status: tasked
created: 2026-10-16T06:35:15+0200
updated: 2026-10-16T06:35:15+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-16T06:35:15+0200
---

# A DuckDB FATAL on a card put from a damaged secondary index crash-loops the collector until the card store is rebuilt

Symptom: a put of one card fails with DuckDB FATAL "Failed to delete all rows from index. Only deleted 0 out of 1 rows". With TRDD-3RVTC1HY every restart reuses the file, so the next put of that card dies again. Seen only on the scratch copy m0b/live (575 MB, written after it was copied from the 547 MB live file; the live file and its WAL do not reproduce it, 41,820 puts ok). Hypothesis to test: that copy was opened by a tool on a different DuckDB version. Direction: classify that FATAL, and force the TRDD-0BDOV3WC rewrite (which rebuilds the indexes) on the next boot.

## Approval log

- 2026-10-16T06:35:15+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
