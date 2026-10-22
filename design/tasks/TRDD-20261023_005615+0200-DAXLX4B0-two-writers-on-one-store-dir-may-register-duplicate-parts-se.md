---
trdd-id: DAXLX4B0
title: Two writers on one store dir may register duplicate parts sets through sync_new_parts
column: backburner
status: tasked
created: 2026-10-23T00:56:15+0200
updated: 2026-10-23T00:56:15+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: spike
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-23T00:56:15+0200
---

# Two writers on one store dir may register duplicate parts sets through sync_new_parts

sync_new_parts (lib.rs:718-770) registers any file in the four dirs by path and inserts body rows into body_durable with no dedup against existing rows (lib.rs:743); if two writers ingest the same body_id before syncing each other's files, the store holds two parts sets for one body_id, reconstruct doubles the text and verify fails forever (R2 §2.4, INFERRED). Whether a lock keeps two writers off one store dir was not traced. Found during TRDD-2HRA270Y.

## Approval log

- 2026-10-23T00:56:15+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
