---
trdd-id: 75TTFD5U
title: relocate_stranded_file unlinks a source after a copy check only with no re-check
column: todo
status: tasked
created: 2026-10-23T00:56:00+0200
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
approval-datetime: 2026-10-23T00:56:00+0200
---

# relocate_stranded_file unlinks a source after a copy check only with no re-check

relocate_stranded_file (pass.rs:332-353) reads the source at pass.rs:334, copy-verifies the destination and unlinks the source at pass.rs:353 with no store rebuild and no re-check of the source bytes; when the destination already holds identical bytes (pass.rs:335-338) it unlinks with no re-check at all, so a re-emission in between loses the new bytes (docs_dev/20261023-verify-gate-and-flush-naming.md §1.3). Reachable only from the alstore CLI (alstore.rs:219), not from the server. Found during TRDD-2HRA270Y.

## Approval log

- 2026-10-23T00:56:00+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
