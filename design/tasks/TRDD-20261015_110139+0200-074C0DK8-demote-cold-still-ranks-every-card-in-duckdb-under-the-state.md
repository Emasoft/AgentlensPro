---
trdd-id: 074C0DK8
title: demote_cold still ranks every card in DuckDB under the state lock on every non-empty ingest batch
column: backburner
status: tasked
created: 2026-10-15T11:01:39+0200
updated: 2026-10-15T11:53:09+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-15T11:01:39+0200
reopen-when: candidate-query median above 50 ms or corpus above 200000 cards (judgement, see Notes)
---

# demote_cold still ranks every card in DuckDB under the state lock on every non-empty ingest batch

## Problem
Derived from TRDD-KMF02UEX (its first acceptance box, moved here verbatim at its close). After f9e0742e, demote_cold no longer reads card text in bulk and no longer panics, but its keys-only candidate query still runs a window function (row_number() OVER (ORDER BY last_active_ms DESC, seq ASC)) over EVERY row of cards, under the state lock, at the end of every non-empty ingest batch once the corpus exceeds the hot set. Measured: that window alone and the candidate keys alone need at most 16 MiB on the 41,819-card copies (reports_dev/kmf02uex-facts.md). Not measured: how long the lock is held.

## Fix direction
Rank the candidates from the resident layer (parsed already holds every card, with the same last-active instant and first-insert order), so no DuckDB statement ranks the corpus under the lock; or move demotion off the lock. Measure the lock hold before and after.

## Acceptance
- [ ] demote_cold performs no corpus-scaled DuckDB query under the state lock.

## Approval log

- 2026-10-15T11:01:39+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-15T11:49:48+0200 — column → backburner by main-agent@agentlenspro. measured at about 4 ms on the production-sized corpus; review-after 2026-12-15

## Notes and lessons learned

2026-10-15: corrections that could not reach the archived TRDD-KMF02UEX. Its Results line "Box 1 NOT met" gives 16 MiB as measured: that was measured on the component queries (the window alone, the candidate keys alone), not on the exact candidate query, as this card Problem says. The f515aeff commit message also overstates three things: trddgrep itself named no route in its refusal (the worker named a user ruling or a successor card, citing trddgrep help); the CS2W7E77 run is run 1 of a pair only if no further code commit lands before run 2; the MOVED line on KMF02UEX lost its final period, so it is not byte-verbatim with this card acceptance.
2026-10-15 — Measured (reports_dev/demote-trio-facts.md Q3, reports_dev/demote-update-256-measure.md): the candidate query takes 3.7 to 5.8 ms on the 41,819-card copies at 256 MiB, cold or warm, hot 50 or hot 1, its component queries (the window alone, the candidate keys alone) measured at most 16 MiB; its cost grows as n log n with the corpus (INFERRED from the sort). Measured before ORDER BY rn (commit 2a). The lock hold of a demotion pass is dominated by the per-card fetch and UPDATE: about 20 to 28 ms per card on the live copy, 51 to 55 ms on large-r30, 7 ms on the compact copy, cold, on scratch clones (upper bounds). Decision: no code change now; backburner. Reopen conditions (judgement, not derived): the candidate-query median above 50 ms, or the corpus above 200,000 cards.
2026-10-15: the review-after park was replaced by a reopen-when field: a review-after park needs a runnable blocker-probe (lint BLOCKED-WITHOUT-PROBE) and neither reopen condition has a cheap probe; as a plain backburner card it stays visible to the drift detector.
