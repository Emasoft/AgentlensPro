---
trdd-id: RXI2SCG1
title: Ingest error between body row and parts leaves a durable body with no parts
column: backburner
status: tasked
created: 2026-10-23T00:56:08+0200
updated: 2026-10-23T00:56:08+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-23T00:56:08+0200
---

# Ingest error between body row and parts leaves a durable body with no parts

In ingest_body_with (lib.rs:1013-1050) the body row is staged at lib.rs:1026 and the parts follow at lib.rs:1029, each step ending with ? and no rollback; an error between them leaves a body row with no parts, the next ingest takes the existed branch (lib.rs:990-994) and never stages the parts, so verify fails on every pass and the source is kept (no data loss; R2 §2.3, INFERRED, not reproduced). Found during TRDD-2HRA270Y.

## Approval log

- 2026-10-23T00:56:08+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
