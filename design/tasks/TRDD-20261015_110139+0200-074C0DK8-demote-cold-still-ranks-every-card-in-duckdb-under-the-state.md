---
trdd-id: 074C0DK8
title: demote_cold still ranks every card in DuckDB under the state lock on every non-empty ingest batch
column: todo
status: tasked
created: 2026-10-15T11:01:39+0200
updated: 2026-10-15T11:14:02+0200
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

## Notes and lessons learned

2026-10-15: corrections that could not reach the archived TRDD-KMF02UEX. Its Results line "Box 1 NOT met" gives 16 MiB as measured: that was measured on the component queries (the window alone, the candidate keys alone), not on the exact candidate query, as this card Problem says. The f515aeff commit message also overstates three things: trddgrep itself named no route in its refusal (the worker named a user ruling or a successor card, citing trddgrep help); the CS2W7E77 run is run 1 of a pair only if no further code commit lands before run 2; the MOVED line on KMF02UEX lost its final period, so it is not byte-verbatim with this card acceptance.
