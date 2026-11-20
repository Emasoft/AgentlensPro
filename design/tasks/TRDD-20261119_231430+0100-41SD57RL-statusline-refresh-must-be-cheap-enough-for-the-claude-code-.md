---
trdd-id: 41SD57RL
title: statusline refresh must be cheap enough for the Claude Code refresh rate and reap its process tree when cancelled (GitHub 26)
column: todo
status: tasked
created: 2026-11-19T23:14:30+0100
updated: 2026-11-19T23:25:50+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-19T23:14:30+0100
---

# statusline refresh must be cheap enough for the Claude Code refresh rate and reap its process tree when cancelled (GitHub 26)

Source: GitHub issue Emasoft/AgentlensPro 26, https://github.com/Emasoft/AgentlensPro/issues/26, opened 2026-10-20. Imported 2026-11-19 by owner order (every open GitHub issue becomes a TRDD).

## Approval log

- 2026-11-19T23:14:30+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Problem

Symptom: agentlenspro statusline runs at the Claude Code refresh rate; with 8 sessions and statusLine.refreshInterval 3 that is about 160 invocations per minute, and the process family oscillates between about 10 and 39.
Each refresh spawns a shell wrapper, a node process and a sh -c python3 statusline.py child: three processes and two interpreter starts for one status-line render.
Not a leak: the issue measured zero orphaned processes (each had a live claude parent) and no agentlenspro process in a memory-pressure snapshot; the complaint is cost and churn.
Requested: fewer processes per refresh (run the inner command without sh -c); reap the cancelled-invocation tree when Claude Code cancels an in-flight script; consider a long-lived worker.
Repro: sample the agentlenspro statusline process count with ps -eo command every 5 s on a host with several sessions and refreshInterval 3; the issue gives the ps loop.

## Next action

Reproduce on the current build first, then fix; record the reproduction command on this card.

## Related

Overlaps L6V1UUW0 (todo, hook-spool never drains and each spooled hook spawns a revive); owner order 2026-11-19: the status-line hook must be digested at all times by a fast binary, without the full server.
The links above come from board titles only; read each linked card before using it in a fix.
