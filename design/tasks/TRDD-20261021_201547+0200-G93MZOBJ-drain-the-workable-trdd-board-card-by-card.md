---
trdd-id: G93MZOBJ
title: Drain the workable TRDD board card by card
column: dev
status: tasked
created: 2026-10-21T20:15:47+0200
updated: 2026-11-17T23:24:50+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: infra
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-21T20:15:47+0200
project-id: agentlenspro
---

# Drain the workable TRDD board card by card

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-10-21

USER instruction 2026-10-21, verbatim: "complete all TRDDs"; scope answer, verbatim: "Every workable card".
Queue = `trddgrep next` filtered to columns todo, dev, testing, design (93 cards on 2026-10-21). USER priority 2026-10-21: memory-exhaustion and CPU-core cards first (triage: docs_dev/20261021-mem-cpu-triage.md). Backburner (35) is NOT queued: re-triage each one individually after the queue. human_review, approval, deploy, publish (28) stay for the user.
Done so far: none.
NEXT ACTION: take the top card of the filtered queue that no worker holds.

## Procedure per card

1. A worker reads the WHOLE card and first verifies the problem still exists in the current tree. Stale or already fixed → it records the evidence and REPORTS; it never moves the card. The main agent closes it as superseded or cancelled (never complete — no code landed, so there are no implementation-commits).
2. Otherwise it implements the smallest correct fix, using tldr to read, jgrep to locate, fastedit to write, and quicksilver for bulk triage when installed, and runs the checks the card names plus the project gates (`pnpm run check-types`, `pnpm run lint`, the relevant mocha file or `cargo test -p <crate>`).
3. The main agent verifies the report, runs one REVIEW fork, commits by file name with the TRDD id in the subject, and moves the card.
4. At most two workers at once, on disjoint file sets. Never two full test suites or two cargo test runs at the same time. Workers never touch git.

## Log

(one line per card: id, outcome, commit sha)
2026-10-22 — the first queued work is the core-cap card TRDD-YH822LDI (in dev); DKBGT7MQ and WKLD508O carry the owner decisions.

## Approval log

- 2026-10-21T20:15:47+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Batch limits

- Measured cost 2026-10-21: one worker 120k-195k subagent tokens, one REVIEW fork ~300-400k; plan on ~0.5M tokens per card.
- Pacing: at most 10 cards per session, then PAUSE; the next session resumes from the Log without waiting for the user (the scope stays every workable card). Stop entirely only on a stop condition below.
- Stop conditions, checked before each card: two consecutive FAILED cards; a review blocker the main agent cannot refute; the account window above 80% (`agentlenspro statusline-history project`).
- Worker choice: cheap-worker (owner directive) for the staleness check and mechanical fixes. Escalate to lean-worker or smart-worker only when the fix needs judgement (concurrency, locks, durability, cross-file design); record the reason on the card.
- Ownership check before taking a card: `git log --oneline -5 --all --grep <id>` for commits in the last 48h, the card's `updated:` within 48h, and ListAgents peer sessions whose title names the card or its subject. current-owner alone cannot tell sessions apart (every card says main-agent@agentlenspro). If another session is active on it, skip it.
- Wall-clock deadline: pause after 4 hours of drain work in one session, or at the 5h-window reset, whichever comes first.
- Window check: `agentlenspro statusline-history project` shows 5h%/7d% only while alcore is live and receiving status-line posts; on 2026-10-22 its newest sample was 12.8 h old because alcore was down, so its 0% was stale. Read the window from it only when the newest sample is under 10 minutes old; otherwise treat the window as unknown and run at most 2 cards before re-checking.

## Notes

- 2026-11-17T23:24:50+0100 TRIAGE AND PLAN AFTER THE REBOOT OF 2026-11-17 (main agent, advisor consulted; this entry is the handoff, the session may compact). BOARD: 247 open cards (todo 122, backburner 72, blocked 12, dev 10, human_review 8, design 5, testing 5, deploy 3, approval 3, planned 2, publish 2, plan 1, complete 1, ai_review 1); the release gate TRDD-HSPUF5XH waits on 18 ids. HEAD fda74841, not pushed. THE GOAL HOOK ('complete the TRDDs') cannot be met in this session while owner-only cards are open; say so once, do not tick boxes on proxies. ORDER OF WORK: (0) before ANY cargo run: add swap-used to the gate of scripts_dev/pgm-gated.sh (memory_pressure read 87 percent free while swap was 31.7 of 32.8 GB used, so the free test did not see the hang coming), run cargo under nice, one cargo at a time. (1) NO-BUILD LANE first: cards in human_review, ai_review and testing whose boxes may already be met (owner order: review in my stead; close only on outputs read whole); TRDD-M62ZBT7E and TRDD-ASXUW08U touch the same file (agentlenspro-review-mod/hooks/register.js): ONE worker, ONE version bump (0.7.11 to 0.7.12, the only version string is .claude-plugin/plugin.json), minimal edits because TRDD-ML7V29LR may replace the Stop path; worker edits in builds_dev/wt-pgm2 (its register.js equals main, cmp exit 0), main applies with git apply; for M62ZBT7E pass an outcome word to logUsage (call sites: reviewInterrupted finally, reviewAtStop, the subagent gate) so the row says the review FINISHED with PASS or BLOCK, or did NOT finish. (2) RUST LANE, strictly serial: take the order from 'trddgrep why HSPUF5XH' and 'roots'; put the log_reader.rs cards back to back (TRDD-MUZ04JYU, TRDD-AXJH3WTU, TRDD-PGMMB2QG); PGMMB2QG box 6 may need no build (an alcore binary from the card_reuse run should be in builds_dev/wt-jdq-target-commit/release: compare its time with b077c787; isolated DATA_DIR and HOME, free ports, never OTLP 4318); PGMMB2QG box 1 is a judgement call: read the card section Not decided and the tombstone loop, then ask the advisor. (3) OWNER LANE, listed once: TRDD-ML7V29LR (async review, the owner's choice), install of the review mod, push, deploy, the DISABLED flag, credential cards, TRDD-7NHUU6GK, the pre-commit hook scope, the heartbeat stub permission, version bump and publish. OWED: a local pass over the transcripts written since the boot for the rows 'interrupted review', 'REVIEW FAILED' and 'REVIEW DEFERRED' with the queue-operation entries next to each (the answer given to the owner rests on ONE other session); a memory lesson (give a worker a grep string as locator, not a line number: a wrong line number cost one worker run on 2026-11-17); TRDD-V50CQS22 three boxes; the open items in the Notes of TRDD-PGMMB2QG. VERIFIED AFTER THE REBOOT: on TRDD-PGMMB2QG the boxes of lines 46 and 52 are ticked, the ceiling box and the count-line box are open, the Notes section holds three entries, each complete and once. OBSERVATION, not this session: two disk-write reports name git after the boot (a clone, 2.1 GB written 21:47 to 21:59, and an index-pack, 8.6 GB written 21:59 to 23:14); the reports name no repository. This repository has 833 worktrees; nothing was pruned (the owner's call). No report explains the hang; no kernel panic file exists.
