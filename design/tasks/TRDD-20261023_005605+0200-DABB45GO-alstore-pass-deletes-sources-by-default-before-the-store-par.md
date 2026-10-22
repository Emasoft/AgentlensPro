---
trdd-id: DABB45GO
title: alstore pass deletes sources by default before the store parquet is fsynced
column: todo
status: tasked
created: 2026-10-23T00:56:05+0200
updated: 2026-10-23T00:56:05+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-23T00:56:05+0200
---

# alstore pass deletes sources by default before the store parquet is fsynced

alstore defaults durable_source to false (alstore.rs:30, pass.rs:136) and delete_after to true (alstore.rs:215), and the fsync barrier runs only when durable_source is set (pass.rs:469), so a default CLI pass unlinks the source after the COPY but before any fsync of the store parquet; a power loss in that window can lose both (R2 §1.6, INFERRED, not measured). The server sets durable_source true (chores.rs:706). Found during TRDD-2HRA270Y.

## Approval log

- 2026-10-23T00:56:05+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
