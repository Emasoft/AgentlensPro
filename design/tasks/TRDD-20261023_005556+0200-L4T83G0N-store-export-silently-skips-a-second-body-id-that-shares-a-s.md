---
trdd-id: L4T83G0N
title: Store export silently skips a second body_id that shares a src_name
column: todo
status: tasked
created: 2026-10-23T00:55:56+0200
updated: 2026-10-23T00:59:54+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-23T00:55:56+0200
---

# Store export silently skips a second body_id that shares a src_name

body_archive.rs:171 skips a body when out.exists(), so when pass.rs:726 re-ingests a changed file under the same name, (body A, src S) and (body B, src S) both exist and only the first is exported with no failed entry or count; the comment claiming identical bytes either way is false for this case (docs_dev/20261023-verify-gate-and-flush-naming.md §3.3). Reconstruct itself stays safe because of the sha gate at lib.rs:1152. Found during TRDD-2HRA270Y.

## Approval log

- 2026-10-23T00:55:56+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
