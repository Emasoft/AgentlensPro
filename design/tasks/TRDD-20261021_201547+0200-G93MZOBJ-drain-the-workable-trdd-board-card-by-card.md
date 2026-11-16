---
trdd-id: G93MZOBJ
title: Drain the workable TRDD board card by card
column: dev
status: tasked
created: 2026-10-21T20:15:47+0200
updated: 2026-10-22T03:09:13+0200
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
