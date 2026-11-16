---
trdd-id: 3TDHC71K
title: Flush COPY writes to the final part name so a mid-COPY crash breaks every later open
column: backburner
status: tasked
created: 2026-10-23T00:56:11+0200
updated: 2026-10-23T00:59:57+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-23T00:56:11+0200
---

# Flush COPY writes to the final part name so a mid-COPY crash breaks every later open

flush_detailed COPYs straight to the final path (lib.rs:598); only the in-process failure path removes the partial file (lib.rs:604), so a kill or power loss mid-COPY leaves a final-named partial parquet that, per the comment at lib.rs:599-601, fails read_parquet and every later open (docs_dev/20261023-verify-gate-and-flush-naming.md §2.5, INFERRED, not tested). Fix would be COPY to a temp name then rename. Found during TRDD-2HRA270Y.

## Approval log

- 2026-10-23T00:56:11+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
