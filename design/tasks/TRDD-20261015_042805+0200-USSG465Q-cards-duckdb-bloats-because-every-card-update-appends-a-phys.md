---
trdd-id: USSG465Q
title: Card updates are a delete plus an insert in DuckDB and the cards.duckdb tail is inferred to make the boot read expensive
column: todo
status: tasked
created: 2026-10-15T04:28:05+0200
updated: 2026-10-15T05:39:16+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-15T04:28:05+0200
project-id: agentlenspro
---

# Card updates are a delete plus an insert in DuckDB and the cards.duckdb tail is inferred to make the boot read expensive

## Problem
The live cards.duckdb is 547 MB for 80.8 MB of card text (41,819 live rows, 44,241 physical, only 2,422 deleted). Since hot cards are updated on every sweep, the low deleted count means DuckDB likely reclaims deleted rows at checkpoint or the live update pattern differs (unmeasured), and much of the 547 MB may be free blocks, which cost nothing to scan. An upsert that changes the indexed last_active_ms is executed as a delete plus an insert, so every update appends a physical row (VERIFIED on a churned probe: 5,000 live rows, 100,000 physical, file 19.5x the fresh one). Scanning the physical tail loads deleted versions of large hot cards: on the live copy the last 2,048 physical rows fail even a 512-row page read at 64 MiB (INFERRED cause; reports_dev/0bdov3wc-measure2.md section A). That this bloat is what pushes the boot read toward the 256 MiB limit is INFERRED (TRDD-0BDOV3WC): the live file has only 2,422 deleted rows (5.5% of its physical rows, so much of its size may be free blocks); the evidence is the tail range whose 0.88 MB of live text fails at 64 MiB.
- MEASURED 2026-10-15 (reports_dev/6b7vv2z7-reupsert-growth.md): `INSERT … ON CONFLICT DO UPDATE` appends a new row version and the old one stays; CHECKPOINT does not reclaim it (used blocks 461 → 893 → 1,327 over three full passes; the file never shrinks). The live copy has only ~2,400 dead slots for 41,819 rows but about 2.5x the blocks per slot of a fresh store; INFERRED cause: dead versions of large hot cards (each update of a multi-MB card appends the whole card). Untested.

## Fix direction
Periodically compact the cards table (rewrite it in seq order and swap, or a CHECKPOINT/VACUUM path if DuckDB reclaims it), off the state lock; or stop indexing last_active_ms so updates stay in place. Measure first.

## Acceptance
- [ ] Measured on a copy of a real corpus: physical versus live rows, and the boot read's memory threshold, before and after the fix; the threshold drops.

## Approval log

- 2026-10-15T04:28:05+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
