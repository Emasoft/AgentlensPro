---
trdd-id: SBB1GEJO
title: An interrupted turn BLOCK report never reaches the model when it lands after the round cap
column: backburner
status: tasked
created: 2026-11-19T01:08:42+0100
updated: 2026-11-19T01:08:42+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-19T01:08:42+0100
---

# An interrupted turn BLOCK report never reaches the model when it lands after the round cap

Found by the mods agent while building review mod 0.7.13 (reports/mods-expert-developer-agent/20261119_four-cards.md, For a human). When an interrupted turn BLOCK review is stored while the current turn is already at the round cap, and a later Stop of that turn has no work and no final message, clearPending drops the BLOCK record and the cap defers: the model gets only the REVIEW DEFERRED line, never the BLOCK findings. Observed in the mod test rig only (the test an interrupted BLOCK that lands after the cap got exactly one context entry), not in a live session. Present before 0.7.13. Mod work goes to the mods-expert-developer agent.

## Approval log

- 2026-11-19T01:08:42+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
