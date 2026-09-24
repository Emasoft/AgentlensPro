---
trdd-id: C9BGEMSS
title: Drain the board, complete every pending task and TRDD (program 2026-09-24)
column: dev
created: 2026-09-24T08:53:04+0200
updated: 2026-09-24T09:11:28+0200
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
Phase 1 triage: every open NON-BACKBURNER card classified (CLOSE/VERIFY/WORK/USER/SUPERSEDED/BLOCKED) by cluster; reports under reports/board-triage/ (gitignored, local evidence). Backburner (15 cards) was NOT part of that first triage; a separate backburner triage is running now.
Phase 2 board update: move AI-verified cards ai_review -> human_review (a stale-approval check -- files changed since each AI verdict -- is running now for these moves); close superseded review-gate cards (9FG0LSPG, M9344XC8, 4J1QA18G, 9J0515I4, JELDR3KC, WAW0M092 - their mechanism was deleted in 268f3080, TRDD-A37YM37G) plus 3U8AIHXK (superseded as Gen-2, same mechanism); record commit-message corrections forward on the owning cards.
Phase 3 implementation, smallest first: 4BZPAQWM (compile is red on main -- FIRST), BA0DCW98, J2K6IM4R, Z0A777XW, CEAZZHHO, PQ40PZ9D, PNB9FNJ0, HCK5162J, then WORK-M, then the multi-day programs (40M4UPK3 stage 2, DuckDB program 7YPQWKPG/DKBGT7MQ/KBM09XHB, Q9WD3K5R, 3UJB4MN3, N6A8VX3G chain, 5D0VU5NJ, D8L28FFD).
Deploys are separate, deliberate steps; no tag push or npm publish (HSPUF5XH) without the owner's explicit word; no git push without the owner's explicit word.
Landed so far this program: 10 backlog commits cf46888e through 8f9fb461, plus 92a75e20, 6c246701, and 78e84e7f (TRDD-HNPT6JRG, deployed).
Owner decisions pending: whether AI-approved cards may skip human_review; BLAV6W15 (one-path vs single-node expansion); 0E3W5C45 (keep option A); X8MW8K92 (gate opus too?); cancel 81BW1CS9 (its diverted data no longer exists). The earlier claim that NDKKOABG "needs a push" is withdrawn -- not re-verified, removed rather than repeated unchecked. Owner decisions ALREADY MADE: I5O38KKP (CI workflow edit); M2VK8T4P (publish.yml codesign step); TN7FDRGW (issue on the janitor repo); EGGERLEO (box 1); FK4AXP7M; HSPUF5XH (publish); DIZ289UQ's substitutions; issue #19 closure; confirmation of the seven early terminal moves.
Machine state 2026-09-24T09:15+0200: disk 97% used, 61 GB free; rust-core/target is 21 GB of that. Spend cap for the rest of THIS session: at most 12 more worker launches before reporting back to the owner; stop and report early if the 5h rate-limit window passes 80%. NEXT ACTION: finish phase 1 backburner triage, the stale-approval check on the phase-2 human_review moves, then phase 3 starting with 4BZPAQWM.

## Why

The board held 142 open cards, many stale against a rewritten review gate; a program card keeps the order, the plan and the owner's decisions durable across /clear and compaction.


## Correction 2026-09-24T09:11:28+0200

Commit fd4b679a overstated "every open card" and "verdicts re-checked": backburner (15 cards) was NOT covered by the first triage pass -- a backburner triage is running separately now. And "verdicts re-checked" overclaims what actually happened: AI-review verdicts were RE-READ and their cited implementation SHAs were checked by workers; the orchestrator (this session) independently verified only ONE fact itself -- that commit 268f3080 deleted src/cli/reviewGateEffects.ts and its test, the basis for superseding the review-gate cluster. Everything else rests on worker-reported checks, not orchestrator-verified ones. See the STATE block above (rewritten this pass) for the corrected commit range (cf46888e through 8f9fb461, not ".."), the withdrawn NDKKOABG push claim, the owner decisions already made, 3U8AIHXK's Gen-2 supersession, the stale-approval check now running on the ai_review->human_review moves, 4BZPAQWM moved to the front of phase 3, current disk state (97% used, 61 GB free, rust-core/target 21 GB), and this session's remaining spend cap (12 more worker launches, or stop at 80% of the 5h window).
