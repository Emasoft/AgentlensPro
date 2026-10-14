---
trdd-id: H3D5ZBO1
title: The burn tick holds the state lock across bodies.poll, for 130-576 s on the first pass after boot
column: todo
status: tasked
created: 2026-10-15T00:41:29+0200
updated: 2026-10-15T00:42:18+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-15T00:41:29+0200
---

# The burn tick holds the state lock across bodies.poll, for 130-576 s on the first pass after boot

## Approval log

- 2026-10-15T00:41:29+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Findings (2026-10-15)

- bodies.poll is called at ui.rs:4173, under the state lock.
- The bodies store holds about 588k files (147 GB) in ~/.agentlens/otel-bodies.
- On the first pass after each boot it takes 130-576 s; after that it takes about 7.5 s per tick.
- It is still under the state lock at HEAD.
- It is the dominant long holder of the state lock today; TRDD-N60JUWU3's stop path starves behind it.
