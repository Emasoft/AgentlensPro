---
trdd-id: PIGHS4Q2
title: git worktree list shows 823 registered worktrees and 807 of their folders still exist
column: backburner
status: tasked
created: 2026-11-16T22:57:26+0100
updated: 2026-11-16T22:58:15+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: infra
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-16T22:57:26+0100
---

# git worktree list shows 823 registered worktrees and 807 of their folders still exist

## Observation (2026-11-16 22:56)
git worktree list printed 823 lines (134 KB), 16 of them marked prunable (folder gone) and 807 whose folder still exists (counted 2026-11-16 22:58 with a directory test on the first column of each line). The listing floods any command that prints it. One entry, /private/tmp/verify-z53ijfe9, is named on TRDD-Z53IJFE9 as waiting for the owner. CORRECTION: this card first said most were prunable; that was read off the first screen of the listing and was wrong.

## Not done
git worktree prune was NOT run. It removes registrations, and nobody checked that none of them still holds work. Not measured: which of the 807 existing folders hold uncommitted files, and how much disk they take.

## Acceptance
- [ ] every entry whose folder still exists is listed with its branch and whether it has uncommitted files
- [ ] the owner approves the prune, and the count after it is recorded

## Approval log

- 2026-11-16T22:57:26+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
