---
trdd-id: EY61MXJ7
title: Nothing deletes store Parquet parts so the open-time load and all_of part queries grow without bound
column: backburner
status: tasked
created: 2026-10-22T18:17:07+0200
updated: 2026-10-22T18:17:18+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-22T18:17:07+0200
---

# Nothing deletes store Parquet parts so the open-time load and all_of part queries grow without bound

## Approval log

- 2026-10-22T18:17:07+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Problem

Each settle writes one part per table (part-<ms>-<pid>-<n>.parquet in blobs, bodies, parts, api_calls); no code deletes or compacts them (retention_config BODIES_RETENTION_DAYS has no consumer; purge_tick does not touch the store).
Live store 2026-10-22: about 10k files per directory (blobs 9,989 / 2.4 GB, parts 10,026 / 2.0 GB, bodies 10,080 / 188 MB, api_calls 10,080 / 163 MB).
Effect: every full read (open-time load, reconstruct_chunk's all_of(part), evidence readers) scans a file list that grows with every pass.
