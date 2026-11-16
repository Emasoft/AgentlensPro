---
trdd-id: CA5U48BA
title: Shipped worker agents preload five skills and auto permission mode for every user
column: superseded
status: archived
created: 2026-11-04T19:13:01+0100
updated: 2026-11-04T19:26:42+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: feature
min-approval-requirement: user
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: false
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-04T19:13:01+0100
superseded-by: [U4HP8TVD]
---

# Shipped worker agents preload five skills and auto permission mode for every user

Relocated from TRDD-RBBEX59R (line "Outside this card", handoff 2026-11-04T18:13), verbatim, so it is not lost. Owned elsewhere; every item awaits the owner.

Owner questions on the shipped agents committed in fc2df568 and 88487010 (permissionMode auto and 5 preloaded skills for all users; a missing skill does not break the launch, measured on CC 2.1.318 -p; the lean-worker description says medium while its effort is high; the preload costs ~35-50k tokens per spawn, an estimate; micro-worker minimal footprint against the skills; the user rule delegation-and-orchestration.md names lean-worker as Sonnet).

Notes for the reader, not owner decisions:
- The ~35-50k tokens per spawn figure is an estimate from byte counts, not a measurement.
- A missing preloaded skill not breaking the launch was measured on CC 2.1.318 with -p only.
- The user rule delegation-and-orchestration.md is outside this repository.
- Sources added 2026-11-04 (from the session that wrote the agents, stated as reported, not re-measured when this card was edited): the five preloaded skill files total 126,557 bytes (graphify alone 47,544); micro-worker's last measured first request was 11,167 tokens, so preloading makes it roughly 4-5x larger (an estimate, not a measurement); the lean-worker description still steers "anything Haiku would get wrong" to an agent that now runs on Haiku; the edits live on branch fix/setup-agent-preflight and become permanent for users only after a merge to main and a release.

## Approval log

- 2026-11-04T19:13:01+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-04T19:22:59+0100 — corrected: not pre-approved; every item awaits the owner (USER). The earlier MANDATE line was written by trddgrep new's default.
- 2026-11-04T19:26:42+0100 — SUPERSEDED by main-agent@agentlenspro. created with a default mandate; replaced by a proposal awaiting the owner.
