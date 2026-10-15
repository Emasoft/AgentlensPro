---
trdd-id: BSLCSCYK
title: demote_cold per-card UPDATE memory at the 256 MiB limit with large timeline cards is unmeasured
column: complete
status: archived
created: 2026-10-15T11:18:34+0200
updated: 2026-10-15T11:24:50+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: spike
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-15T11:18:34+0200
---

# demote_cold per-card UPDATE memory at the 256 MiB limit with large timeline cards is unmeasured

## Problem
Split from TRDD-MEPIRHI4 (review of 42998aa1). After f9e0742e, demote_cold fetches each candidate by primary key and UPDATEs it to its stripped form. With 4 KB timeline entries in a test store, no tested memory limit let the old read fail while demote_cold succeeded, because the per-card UPDATEs needed more (reports_dev/kmf02uex-impl-report.md). At the production limit of 256 MiB with 80 KB to 2.3 MB cards it is unmeasured. If demotion fails there, timelines are never stripped and resident memory grows.

## Fix direction
On copies of the m0b states (live, large-r30, compact), at memory_limit 256 MiB and threads 2 as production sets them, run the post-f9e0742e demotion path with hot_cards BELOW the 31 timeline cards (for example 1), so the large cards are actually fetched and UPDATEd; at the production hot set of 50 nothing is demoted on these copies. Record each outcome (count demoted or the error text) and the floor.

## Acceptance
- [x] The demotion path is run at 256 MiB on the live, large-r30 and compact copies with hot_cards below 31, and each outcome and its memory floor are recorded.

## Approval log

- 2026-10-15T11:18:34+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-15T11:24:50+0200 — COMPLETE by main-agent@agentlenspro. measured at 256 MiB on the three copies with hot_cards 1; results and caveats recorded.

## Results

2026-10-15 — Measured (reports_dev/demote-update-256-measure.md; probe on scratch copies, same DuckDB 1.10506.0 as rust-core, memory_limit with threads 2 and spilling allowed as in production, candidate query verbatim, hot_cards 1, 30 candidates per copy, 3 runs at 256 MiB and 3 at each boundary limit): at 256 MiB all 30 candidates were demoted on all three copies. Floors as brackets: live copy 64 < floor <= 96 MiB (80 not tried); compact copy 16 < floor <= 32 MiB; large-r30 (synthetic regrowth) 224 < floor <= 256 MiB. Every failure was an Out of Memory error inside a per-card UPDATE; the candidate query and the fetches did not fail.
Finding: on large-r30 the post-f9e0742e UPDATE path has the same memory bracket as the old one-shot read (224 < floor <= 256 for both). So f9e0742e lowers the memory of demotion only when nothing is demoted; when it demotes large cards on a bloated file it needs as much as the code it replaced, and it fails as an Err instead of a panic. The floor tracks the file bloat (TRDD-USSG465Q).
Caveats: each run used a fresh clone and a cold connection with no WAL, no prior boot read and no preceding upserts; production demotes on a warm connection right after the batch upserts, where an automatic checkpoint on a bloated file could need more memory (INFERRED, unmeasured). The strip is approximated (timeline emptied and the persist-strip fields dropped; the truncation counter bump is not mirrored). The count demoted before a failure was not recorded. hot_cards 1 demotes 30 cards in one call, while production usually demotes a few per batch.
Relevance: large-r30 cannot be opened at 256 MiB at boot (the boot read needs about 352 MiB), but a running collector may reach comparable bloat while the store is open: TRDD-0BDOV3WC records the live file regrowing to the edge within hours of a rebuild, observed across restarts (INFERRED that it also happens inside one process). If demotion then fails, timelines stay resident, resident memory grows toward the RSS cap, a restart follows, the boot read fails at 256 MiB, and the 0BDOV3WC refusal path rebuilds from a lagging snapshot. The root is the bloat (USSG465Q) and the boot out-of-memory handling (0BDOV3WC). Once deployed, the degradations counter alcore.demoteColdError is the production signal to watch.
Correction to this card Problem: "If demotion fails there, timelines are never stripped" should read "may stay unstripped" (cards before a failing one are still stripped). The cited test finding (no tested limit let the old read fail while demote_cold succeeded) holds only with spilling forbidden (temp_directory empty) on a warm test-sized store.
