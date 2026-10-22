---
trdd-id: 1FWN9XBS
title: reconstruct_chunk makes a bodies pass and a store export take tens of minutes
column: todo
status: tasked
created: 2026-10-22T23:45:36+0200
updated: 2026-10-22T23:45:36+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-22T23:45:36+0200
---

# reconstruct_chunk makes a bodies pass and a store export take tens of minutes

Clone run 1 of TRDD-2HRA270Y (docs_dev/20261022-clone-run-report.md): the first bodies pass over 42,997 otel-bodies files spent 630-900 s of stack samples in agentlens_store reconstruct_chunk (the per-body verify) and never finished; a store export over the whole window hung 900 s having written 56 files. While a pass runs it holds .pass.lock, the HEAVY slot and the writer, so export, purge and the idle sync starve. The plan predicted this as the next hot spot after open_store. First measure the per-body reconstruct cost on an idle clone (narrowed export of about 50 bodies), then find where the time goes (all_of(part) per chunk, blob_fetch_sql per body, or the 2-thread pool) before changing code. Owner rule: the work belongs in DuckDB queries (one batched query per settle group), not per-body round trips.

## Approval log

- 2026-10-22T23:45:36+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
