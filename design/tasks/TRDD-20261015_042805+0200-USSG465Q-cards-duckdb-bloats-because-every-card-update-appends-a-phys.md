---
trdd-id: USSG465Q
title: Card updates are a delete plus an insert in DuckDB and the cards.duckdb tail is inferred to make the boot read expensive
column: todo
status: tasked
created: 2026-10-15T04:28:05+0200
updated: 2026-10-15T11:02:34+0200
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
- 2026-10-15 (reports_dev/6b7vv2z7-reupsert-growth.md). MEASURED: each full upsert pass over 41,700 timeline-free cards (72.4 MB of text) grows the checkpointed file by about 220 MB (230 → 452 → 669 MB; freed blocks are never returned) and the used storage by about 110 MB (461 → 893 → 1,327 blocks of 256 KiB); CHECKPOINT reclaims none of it. Those small old versions did not raise the boot-read floor (80 MiB at 1x, 2x and 3x). INFERRED mechanism: `INSERT … ON CONFLICT DO UPDATE` writes a new row version and the old one stays.
- 2026-10-15 (reports_dev/0bdov3wc-compaction-test.md, reports_dev/0bdov3wc-regrow-test.md). MEASURED: rewriting an earlier live copy's rows into a fresh file shrinks it 575 → 129 MB, drops the boot-read floor 256 → 88 MiB, and lowers a passing probe's peak RSS from about 470–535 to about 350 MB. On that fresh file (DuckDB 1.5.6), 10 and 30 whole rewrites of the 31 timeline cards add about 8.4 MB of used storage per round (≈ the rewritten text) and raise the floor to 136 and 352 MiB; the same rewrites of the 31 smallest cards leave it at 88 MiB. INFERRED: retained old versions of large cards drive both the bloat and the boot out-of-memory error. The live file reached the 256 MiB limit about 3 hours after a rebuild (2026-10-14 11:06 → 14:13), so a one-time compaction buys only hours. This card must stop rewriting whole large cards on every update (for example, keep the growing timeline out of the per-update row rewrite) and/or compact repeatedly without reading the bloated table under the 256 MiB limit. Recommended to land with TRDD-0BDOV3WC (owner decision (c), pending); TRDD-6B7VV2Z7 commit 2 waits for it.

## Fix direction
Periodically compact the cards table (rewrite it in seq order and swap, or a CHECKPOINT/VACUUM path if DuckDB reclaims it), off the state lock; or stop indexing last_active_ms so updates stay in place. Measure first.

## Acceptance
- [ ] Measured on a copy of a real corpus: physical versus live rows, and the boot read's memory threshold, before and after the fix; the threshold drops.

## Approval log

- 2026-10-15T04:28:05+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Notes and lessons learned

2026-10-15 (INFERRED, not measured): each demote_cold UPDATE (f9e0742e) rewrites a large timeline card as its stripped form, which under the DuckDB update model may leave a dead version of the large row, a further source of the growth this card tracks.
