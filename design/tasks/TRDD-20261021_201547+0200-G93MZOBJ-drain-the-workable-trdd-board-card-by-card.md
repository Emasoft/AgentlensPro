---
trdd-id: G93MZOBJ
title: Drain the workable TRDD board card by card
column: dev
status: tasked
created: 2026-10-21T20:15:47+0200
updated: 2026-10-21T20:15:50+0200
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
Queue = `trddgrep next` filtered to columns todo, dev, testing, design (93 cards on 2026-10-21). Backburner (35) after that queue. human_review, approval, deploy, publish (28) stay for the user.
Done so far: none.
NEXT ACTION: take the top card of the filtered queue that no worker holds.

## Procedure per card

1. A worker reads the WHOLE card and first verifies the problem still exists in the current tree. Stale or already fixed → record the evidence on the card and close it (complete or superseded), no code change.
2. Otherwise it implements the smallest correct fix, using tldr to read, jgrep to locate, fastedit to write, and quicksilver for bulk triage when installed, and runs the checks the card names plus the project gates (`pnpm run check-types`, `pnpm run lint`, the relevant mocha file or `cargo test -p <crate>`).
3. The main agent verifies the report, runs one REVIEW fork, commits by file name with the TRDD id in the subject, and moves the card.
4. At most two workers at once, on disjoint file sets. Never two full test suites or two cargo test runs at the same time. Workers never touch git.

## Log

(one line per card: id, outcome, commit sha)

## Approval log

- 2026-10-21T20:15:47+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
