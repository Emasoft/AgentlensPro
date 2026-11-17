---
trdd-id: O4LU9SYJ
title: The first card save comes about 60 s after start whatever the boot sweep took
column: todo
status: tasked
created: 2026-11-17T13:18:58+0100
updated: 2026-11-17T13:18:58+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-17T13:18:58+0100
---

# The first card save comes about 60 s after start whatever the boot sweep took

## Problem
The periodic save is durable.tick(&tailer, &state, false) at the end of each sweeper-loop pass (log_reader.rs:1873 in the worktree builds_dev/wt-jdq-commit), and the pass after the boot sweep is the 60 s backstop sweep. In every real-server run of TRDD-WCG7I5D8's gates the first card save came 61.7 to 68.7 s after start although the boot sweep ended within seconds (reports_dev/WCG7I5D8/gate4b/gate4b-results.json, field card_log_first_changed_at_s). TRDD-WCG7I5D8 counts 492 of 2,114 hard-cap exits under 60 s: those runs save no cards. This is the unmet acceptance box of TRDD-WCG7I5D8.

## Fix direction
Run the first card save right after the boot sweep (one tick there), not at the next backstop pass.

## Acceptance
- [ ] On a real server the card log changes within 5 s of the end of the boot sweep when the sweep ingested cards.
- [ ] A run killed 30 s after start, after its sweep, leaves the ingested cards in the card log.

## Approval log

- 2026-11-17T13:18:58+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
