---
trdd-id: YI3QZBKE
title: Content check and unlink race in the verified arm
column: backburner
status: tasked
created: 2026-10-23T00:56:13+0200
updated: 2026-10-23T00:59:58+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-23T00:56:13+0200
---

# Content check and unlink race in the verified arm

content_unchanged_since_read (pass.rs:278-313) returns Unchanged after reading the whole file and the unlink follows by path at pass.rs:580, with no lock and no inode check between them, so a re-emission inside that small window loses the new bytes (docs_dev/20261023-verify-gate-and-flush-naming.md §1.7, INFERRED). Found during TRDD-2HRA270Y.

## Approval log

- 2026-10-23T00:56:13+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
