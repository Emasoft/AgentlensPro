---
trdd-id: 01V3FOT7
title: review-gate a subagent with no Agent tool loses its whole report to the NO REVIEW POSSIBLE exit line (GitHub 24)
column: todo
status: tasked
created: 2026-11-19T23:14:05+0100
updated: 2026-11-19T23:45:19+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-19T23:14:05+0100
---

# review-gate a subagent with no Agent tool loses its whole report to the NO REVIEW POSSIBLE exit line (GitHub 24)

Source: GitHub issue Emasoft/AgentlensPro 24, https://github.com/Emasoft/AgentlensPro/issues/24, opened 2026-10-18. Imported 2026-11-19 by owner order (every open GitHub issue becomes a TRDD).

## Approval log

- 2026-11-19T23:14:05+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Problem

Symptom: a subagent with no Agent tool (for example one with Bash, Read, Edit, Write and advisor) that writes files gets a SubagentStop REVIEW demand it cannot meet.
Its only exit, a final block reading REVIEW-GATE: NO REVIEW POSSIBLE, must be the last block, so the subagent's real report is replaced; the parent receives only that line and must resume the agent.
Frequency: on 2026-10-18, more than 20 completions across at least 10 subagents each needed a second round-trip; two returned the gate line even after being told to put their result first.
Repro: define a subagent with tools Bash, Read, Edit, Write only; spawn it to write one file outside /tmp, reports/ and *_dev/; its task notification then carries only the gate line.
Proposed fixes: exit cleanly when the subagent has no Agent tool, since the parent gate already demands a fork for its writes; or accept the exit line as the last line of the message; or append the exit line to the final message instead of requiring the whole block.

## Next action

Mod work, route to mods-expert-developer-agent. First check whether it still reproduces on agentlenspro-review-mod 0.4.x (TRDD-KZCSO0R2 moved the gate into a mod); if it does not, close this card citing the check.

## Related

Overlaps QQ2XIIZ6 (todo) and GI1LC8FX (todo, three gate rules with no failing test).
The links above come from board titles only; read each linked card before using it in a fix.

## Triage

2026-11-19T23:45+0100 mods-expert-developer triage (reports_dev/review-gate-issues/20261119-triage.md, code reading only, no probes): verdict in that report under this id. Repo mod source is 0.7.13, the installed mod 0.7.10; the cited behaviours were re-checked by grep in 0.7.10 (report header), the 320-line register.js diff was not read in full.
