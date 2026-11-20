---
trdd-id: IQGYNEAP
title: server crash-loops with 33 quick crashes and the fan-out advisory names a missing agentlenspro-cli command (GitHub 25)
column: todo
status: tasked
created: 2026-11-19T23:14:18+0100
updated: 2026-11-19T23:25:48+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-19T23:14:18+0100
---

# server crash-loops with 33 quick crashes and the fan-out advisory names a missing agentlenspro-cli command (GitHub 25)

Source: GitHub issue Emasoft/AgentlensPro 25, https://github.com/Emasoft/AgentlensPro/issues/25, opened 2026-10-18. Imported 2026-11-19 by owner order (every open GitHub issue becomes a TRDD).

## Approval log

- 2026-11-19T23:14:18+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Problem

Symptom: on 2026-10-18 around 14:45 (+0200), agentlenspro server status reported revive backoff: 33 quick crash(es) in a row, holding off spawning a new server; server NOT RUNNING at localhost:3000.
agentlenspro budget --minutes 60 --with-risks failed with: cannot reach http://localhost:4316/mcp: socket hang up.
Impact: the budget and risk checks a session runs before a large fan-out were unavailable; the review gate still fired.
The PostToolUse:Agent advisory names agentlenspro-cli --risk, which is not on PATH (zsh: command not found: agentlenspro-cli).
Asks: find out why the server crash-loops (its crash log was not read in the session); make the advisory name an existing command (the issue guesses agentlenspro budget with --with-risks).

## Next action

Reproduce on the current build first, then fix; record the reproduction command on this card.

## Related

Overlaps 2JOIAH2G, 563B8WYH and JJLI6GEH (all todo, alcore crash-loops under the RSS cap or a DuckDB OOM at boot); the crash half is likely one of those, the missing agentlenspro-cli command half is separate.
The links above come from board titles only; read each linked card before using it in a fix.
