---
trdd-id: C9BGEMSS
title: Drain the board, complete every pending task and TRDD (program 2026-09-24)
column: dev
created: 2026-09-24T08:53:04+0200
updated: 2026-09-24T08:53:46+0200
current-owner: Emasoft
created-by: Emasoft
task-type: infra
min-approval-requirement: none
assignee: Emasoft
mandate: true
mandated-by: none
approved: true
approval-judge: Emasoft
approval-datetime: 2026-09-24T08:53:04+0200
priority: high
---

# Drain the board, complete every pending task and TRDD (program 2026-09-24)

## Approval log

- 2026-09-24T08:53:04+0200 — MANDATE issued by Emasoft (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-24T08:53:07+0200

Owner order 2026-09-24, verbatim: "complete all pending tasks and TRDDs".
Phase 1 triage: every open card classified (CLOSE/VERIFY/WORK/USER/SUPERSEDED/BLOCKED) by cluster; reports under reports/board-triage/ (gitignored, local evidence).
Phase 2 board update: move AI-verified cards ai_review -> human_review; close superseded review-gate cards (9FG0LSPG, M9344XC8, 4J1QA18G, 9J0515I4, JELDR3KC, WAW0M092 - their mechanism was deleted in 268f3080, TRDD-A37YM37G); record commit-message corrections forward on the owning cards.
Phase 3 implementation, smallest first: BA0DCW98, J2K6IM4R, Z0A777XW, CEAZZHHO, PQ40PZ9D, PNB9FNJ0, HCK5162J, then WORK-M, then the multi-day programs (40M4UPK3 stage 2, DuckDB program 7YPQWKPG/DKBGT7MQ/KBM09XHB, Q9WD3K5R, 3UJB4MN3, N6A8VX3G chain, 5D0VU5NJ, D8L28FFD).
Deploys are separate, deliberate steps; no tag push or npm publish (HSPUF5XH) without the owner's explicit word; no git push without the owner's explicit word.
Landed so far this program: 10 backlog commits cf46888e..8f9fb461, 92a75e20, 6c246701, and 78e84e7f (TRDD-HNPT6JRG, deployed).
Owner decisions pending: whether AI-approved cards may skip human_review; BLAV6W15 (one-path vs single-node expansion); 0E3W5C45 (keep option A); X8MW8K92 (gate opus too?); cancel 81BW1CS9 (its diverted data no longer exists); push main (611+ unpushed commits) so CI can close EJDNNDY3/QJPUG1WP/NDKKOABG.
NEXT ACTION: finish phase 1 (test-hygiene, misc, LOCAL/proposals batches), then phase 2 in one board-update pass.

## Why

The board held 142 open cards, many stale against a rewritten review gate; a program card keeps the order, the plan and the owner's decisions durable across /clear and compaction.
