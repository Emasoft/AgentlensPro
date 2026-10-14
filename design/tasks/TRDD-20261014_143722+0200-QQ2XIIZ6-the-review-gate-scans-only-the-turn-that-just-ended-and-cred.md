---
trdd-id: QQ2XIIZ6
title: The review gate scans only the turn that just ended and credits only non-isolated forks for REVIEW and MEASURE
column: dev
status: tasked
created: 2026-10-14T14:37:22+0200
updated: 2026-10-14T14:37:55+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-14T14:37:22+0200
---

# The review gate scans only the turn that just ended and credits only non-isolated forks for REVIEW and MEASURE

## Approval log

- 2026-10-14T14:37:22+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## User directives (verbatim, 2026-10-14)

Q1: "the enforce is by checking and only allows to pass the turn if a fork-agent without worktree is been spawned, while dot allowing to pass the turn if a fork-agent with a worktree is spawned instead."
Q2: "- everything written or changed in the previous turn must be used to determine if the turn was worthy of being reviewed. the fork agent is identical to the very agent that did the previous turn, since it is a fork of it, so it remembers everything and possess the full context with all the details. he knows exactly what he did. the measurer is also a waste as it is now. a new agent is spawned, instead of another fork. this waste tokens. instead use a second fork agent for the measurer, like for the reviewer, will costs almost nothing since everything is in cache. only the prompt, plus few short file reads (via tldr-skill), are added to the context"

## Scope and known separate items

Files: src/cli/reviewGate.ts, src/cli/reviewSupervisor.ts, src/test/reviewGate.test.ts, src/test/reviewSupervisor.test.ts; user rule turn-protocol-and-review.md MEASURE row.
Turn start = user entry with origin.kind human (Stop-hook feedback is isMeta and must not start a turn).
Out of scope, separate item: runMainGate ignores stop_hook_active; the 9-consecutive-block cap fired on 2026-10-14.
