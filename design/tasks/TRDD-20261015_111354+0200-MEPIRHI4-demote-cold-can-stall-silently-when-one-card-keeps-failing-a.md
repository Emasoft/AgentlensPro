---
trdd-id: MEPIRHI4
title: demote_cold returns on its first failing card and skips a missing resident entry silently
column: todo
status: tasked
created: 2026-10-15T11:13:54+0200
updated: 2026-10-15T11:45:54+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-15T11:13:54+0200
---

# demote_cold can stall silently when one card keeps failing and its UPDATE memory at 256 MiB is unmeasured

## Problem
Derived from the f9e0742e review (TRDD-KMF02UEX, archived). (1) demote_cold returns Err at its first failing card; the cards before it in that call stay demoted (each UPDATE commits on its own) and the rest wait for the next batch. The candidate query has no ORDER BY, so a failing card can sit at a different position in each batch. Whether any per-card failure repeats on every batch is not shown: a fetch of a missing row is near-impossible (same table, same call, under the lock), a parse failure needs a stored card that its own serializer wrote and that no longer parses, and an UPDATE out-of-memory depends on memory pressure. If one did repeat, the cards behind it would not be demoted and resident memory would grow, with one log line and the alcore.demoteColdError counter as the only signals. (2) A resident entry missing from parsed is skipped silently after its UPDATE (unchanged behaviour). The f9e0742e doc comment on demote_cold says one bad row blocks every later candidate until it is fixed: correct it when the loop changes. The UPDATE-memory measurement at 256 MiB moved to TRDD-BSLCSCYK.

## Fix direction
Decide skip-and-continue versus abort under the owner fail-fast rule (CLAUDE.md: no error handling that hides failures, no fallbacks): a skipped card must stay loud (counted and logged per card), never a silent fallback, and the proposal must say why its choice complies. Pin the choice with a test that makes one card fail. Report a missing resident entry instead of skipping it.

## Acceptance
- [ ] A resident entry missing from parsed during demotion is reported (an Err or a counted and logged event), not skipped silently.
- [ ] The behaviour on one failing card (skip-and-continue or abort) is decided against the fail-fast rule, recorded here with its reason, and pinned by a test that makes one card fail.
- [x] Candidate order stability is measured (DEMOTE_CANDIDATES_SQL with hot_cards 1, ten runs on one clone, id sequences compared) and the result recorded before the skip-or-abort decision.

## Approval log

- 2026-10-15T11:13:54+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Notes and lessons learned

2026-10-15: correction to the 42998aa1 commit message: one card that keeps failing does not block every later candidate (the candidate order is not fixed and the cards before it are demoted), and MEPIRHI4 did not own the missing-resident-entry residual until this edit added its box. The measurement half moved to TRDD-BSLCSCYK.
2026-10-15: correction to the note above and to the 2f91427d commit message: a failing card need not block every later candidate, because the candidate query has no ORDER BY so its order is not guaranteed; whether the order actually varies between batches is unmeasured, and with a stable order a card that fails every time would block the cards after it from the second batch on. Part of this card: measure order stability by running DEMOTE_CANDIDATES_SQL with hot_cards 1 ten times on one clone and comparing the id sequences. The filename slug of this card predates its retitle.
2026-10-15: corrections to the b0fd9bc5 commit message: the order-stability measurement is assigned here, not done; the archived BSLCSCYK line that production usually demotes a few cards per batch is INFERRED, unmeasured.

## Results

2026-10-15 — Candidate order measured (reports_dev/demote-trio-facts.md Q1): on clones of the live copy and of large-r30 at 256 MiB, threads 2, hot_cards 1, the 30-id candidate sequence was identical across 10 runs on one connection and 10 on fresh connections. Stable here, not guaranteed: the final SELECT has no ORDER BY.
2026-10-15 — The unordered candidate output equals ORDER BY rn ascending (cards just past the hot set first, coldest last) on a clone of the live copy, 5 repeats, Python DuckDB 1.5.6 (same engine version as the Rust build, a different binding); large-r30 untested. The visiting order is stable for a given candidate set; the set itself changes between batches. Commit 2a pins the order, and its order test confirms it on the Rust build.
