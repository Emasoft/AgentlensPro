---
trdd-id: QDTEZD6A
title: Gate queries drop undecodable rows with flatten and misreport the failure
column: todo
status: tasked
created: 2026-10-23T00:56:02+0200
updated: 2026-10-23T00:59:55+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-23T00:56:02+0200
---

# Gate queries drop undecodable rows with flatten and misreport the failure

lib.rs:1120, 1137, 1230 and 1254 call flatten on query_map results, silently dropping rows that fail to decode. It fails safe, because a dropped row cannot produce ok=true: the sha gate at lib.rs:1277/1152 still rejects the body (docs_dev/20261023-verify-gate-and-flush-naming.md §1.5), but the reported error misleads and the code conflicts with the fail-fast rule. Fix: propagate the row error. Found during TRDD-2HRA270Y.

## Approval log

- 2026-10-23T00:56:02+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
