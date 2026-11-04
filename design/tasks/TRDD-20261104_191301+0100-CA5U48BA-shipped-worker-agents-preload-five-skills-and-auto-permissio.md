---
trdd-id: CA5U48BA
title: Shipped worker agents preload five skills and auto permission mode for every user
column: approval
status: tasked
created: 2026-11-04T19:13:01+0100
updated: 2026-11-04T19:13:01+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: docs
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-04T19:13:01+0100
---

# Shipped worker agents preload five skills and auto permission mode for every user

Relocated from TRDD-RBBEX59R (line "Outside this card", handoff 2026-11-04T18:13), verbatim, so it is not lost. Owned elsewhere; every item awaits the owner.

Owner questions on the shipped agents committed in fc2df568 and 88487010 (permissionMode auto and 5 preloaded skills for all users; a missing skill does not break the launch, measured on CC 2.1.318 -p; the lean-worker description says medium while its effort is high; the preload costs ~35-50k tokens per spawn, an estimate; micro-worker minimal footprint against the skills; the user rule delegation-and-orchestration.md names lean-worker as Sonnet).

Notes for the reader, not owner decisions:
- The ~35-50k tokens per spawn figure is an estimate from byte counts, not a measurement.
- A missing preloaded skill not breaking the launch was measured on CC 2.1.318 with -p only.
- The user rule delegation-and-orchestration.md is outside this repository.

## Approval log

- 2026-11-04T19:13:01+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
