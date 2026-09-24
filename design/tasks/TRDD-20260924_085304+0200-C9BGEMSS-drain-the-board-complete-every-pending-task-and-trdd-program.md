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

## STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-24T09:41:35+0200

Handoff snapshot. HEAD is fbd4ae8d. Today's commits, in order: cf46888e through 8f9fb461, 92a75e20, 6c246701, 78e84e7f, 02ea2cba, fd4b679a, 9c363bb8, 25113e6d, 954fe1a0, 3faa709c, 7ecc6ad7, fbd4ae8d.

Deployed vs not: alcore is deployed at 78e84e7f (TRDD-HNPT6JRG), with the rollback binary saved as alcore.prev-20260924 in bin-native/darwin-arm64. The TS bundle (standalone/cli.js) is NOT deployed — BA0DCW98's fix, J2K6IM4R's fix, and the delegate-gate verb all sit uncompiled/unrestarted on disk.

Deploy prerequisites before restarting the TS bundle: (1) the cross-project marker scan requested by this program — DONE, result: 19 violations of a buried (not first-line) ROLE: REVIEW/ROLE: MEASURE marker in Agent/Task prompts over the last 7 days, all in OTHER projects (llm-externalizer: 10, ai-maestro-janitor: 9), none in this project; no skill/agent/command template puts prose before the marker (the only file hits were mid-sentence prose in a TRDD card body, not a template). (2) bundle delta since 2026-09-15 — not yet measured. (3) a rollback copy of standalone/cli.js — not yet taken. (4) a live probe after restart — not yet run. (5) the YGETIBJS hold decision — still pending, unresolved.

Owed: TRDD-2CYTNLY1 carries a stale AI approval (its human_review verdict predates today's reviewGate.ts rework) — a note was appended to it this pass (## Stale approval, 2026-09-24) saying a re-review at HEAD is owed before owner acceptance. A full `trddgrep validate` pass is also owed before the next board commit (see below).

Phase-3 queue, in order: 4BZPAQWM (compile is red on main — do this first), then CEAZZHHO, PQ40PZ9D, PNB9FNJ0, VDQ2N8PX, K4XQ7M2B, 82ADFE5D, L2HVOB5K, HCK5162J, P08Q5TK1, then 8ADTIGKT (the Rust pinning test), GXKRBK1Q, FGN5TY7E (a mutation run), then DRH4ZRGB's two open rows plus closing 7FA3NIXU and GG0WOHEV as obsolete, then 4EV3OJ19, N6A8VX3G, 091Z1FU0, RAPDS7OX, then the multi-day programs (40M4UPK3 stage 2, the DuckDB program 7YPQWKPG/DKBGT7MQ/KBM09XHB, Q9WD3K5R, 3UJB4MN3, the N6A8VX3G chain, 5D0VU5NJ, D8L28FFD).

Owner decisions pending: whether AI-approved cards may skip human_review; BLAV6W15 (one-path vs single-node expansion); 0E3W5C45 (keep option A); X8MW8K92 (gate opus too?); cancel 81BW1CS9 (its diverted data no longer exists). The earlier claim that NDKKOABG "needs a push" is withdrawn — not re-verified, removed rather than repeated unchecked.
Owner decisions ALREADY MADE: I5O38KKP (CI workflow edit); M2VK8T4P (publish.yml codesign step); TN7FDRGW (issue on the janitor repo); EGGERLEO (box 1); FK4AXP7M; HSPUF5XH (publish); DIZ289UQ's substitutions; issue #19 closure; confirmation of the seven early terminal moves; VNKPUAY4's refusal to accept a false-completion guard (owner declined it, keep the manual check instead — do not re-propose it). Raised, not yet decided: FK4AXP7M's approval looks like an approval-provenance defect (an approval recorded without the evidence chain a later reviewer could re-verify) — flagging for the owner, not resolving unilaterally.

Operating facts for whoever resumes this card: never run the full mocha suite (`.mocharc.cjs`'s `spec: ['out/test/test/**/*.test.js']` glob is additive — CLI `--spec`/positional args do NOT replace it, only `--no-config` does; scope every mocha invocation with `--no-config --require src/test/setup.js --ui tdd <file>`). The hourly RSS-cap restart of the server is expected, not a defect. Forks bypass the burn gate by design. `trddgrep move` performs a real `git mv` and stamps the OS account's username into the commit — so board-column commits happen only when no other worker is mid-move on the same corpus, and the staged diff is grepped for identities before committing. Run `trddgrep validate` before every board commit. Every worker's claim in a report is second-hand until this orchestrating session reads the evidence itself.









## Why

The board held 142 open cards, many stale against a rewritten review gate; a program card keeps the order, the plan and the owner's decisions durable across /clear and compaction.


## Correction 2026-09-24T09:11:28+0200

Commit fd4b679a overstated "every open card" and "verdicts re-checked": backburner (15 cards) was NOT covered by the first triage pass -- a backburner triage is running separately now. And "verdicts re-checked" overclaims what actually happened: AI-review verdicts were RE-READ and their cited implementation SHAs were checked by workers; the orchestrator (this session) independently verified only ONE fact itself -- that commit 268f3080 deleted src/cli/reviewGateEffects.ts and its test, the basis for superseding the review-gate cluster. Everything else rests on worker-reported checks, not orchestrator-verified ones. See the STATE block above (rewritten this pass) for the corrected commit range (cf46888e through 8f9fb461, not ".."), the withdrawn NDKKOABG push claim, the owner decisions already made, 3U8AIHXK's Gen-2 supersession, the stale-approval check now running on the ai_review->human_review moves, 4BZPAQWM moved to the front of phase 3, current disk state (97% used, 61 GB free, rust-core/target 21 GB), and this session's remaining spend cap (12 more worker launches, or stop at 80% of the 5h window).
