---
trdd-id: U5LN57A5
title: review-gate the REVIEW fork cannot see its spawning response and reports that turn's actions as missing (GitHub 21)
column: todo
status: tasked
created: 2026-11-19T23:12:47+0100
updated: 2026-11-19T23:45:08+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-19T23:12:47+0100
---

# review-gate the REVIEW fork cannot see its spawning response and reports that turn's actions as missing (GitHub 21)

Source: GitHub issue Emasoft/AgentlensPro 21, https://github.com/Emasoft/AgentlensPro/issues/21, opened 2026-10-02. Imported 2026-11-19 by owner order (every open GitHub issue becomes a TRDD).

## Approval log

- 2026-11-19T23:12:47+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Problem

Symptom: the REVIEW fork that review-gate demands cannot see the response that spawned it, so same-turn writes look missing to it.
Observed twice on agentlenspro 2.34.0 (2026-10-02): a SendMessage, a git commit and an Agent dispatch from the same response were reported as never sent or never existing, marked VERIFIED.
Cause: a fork inherits the transcript only up to, not including, the spawning response, and the directive requires the spawn to be the last call; the fork reads absence as evidence.
Component: review-gate --directive (agentlenspro). The spawning prompts also pointed the fork at same-response calls it could not see, so the prompt author shares the blame.
Proposed fixes: state in the directive that the spawning response is invisible to the fork; require pasted same-turn results in the prompt; annotate VERIFIED absence claims.

## Next action

Mod work, route to mods-expert-developer-agent. First check whether it still reproduces on agentlenspro-review-mod 0.4.x (TRDD-KZCSO0R2 moved the gate into a mod); if it does not, close this card citing the check.

## Notes

2026-11-19T23:16+0100: the issue body itself says 'agentlenspro 2.34.0 (2026-10-02)' (gh-issue-21.md lines 7 and 46): 2.34.0 was the unreleased version in package.json then, not the release cut on 2026-11-19.

## Related

Overlaps 4J1QA18G (superseded, a fork that could not see the write) and QQ2XIIZ6 (todo, the gate scans only the turn that just ended); check both before fixing.
The links above come from board titles only; read each linked card before using it in a fix.

## Triage

2026-11-19T23:45+0100 mods-expert-developer triage (reports_dev/review-gate-issues/20261119-triage.md, code reading only, no probes): verdict in that report under this id. Repo mod source is 0.7.13, the installed mod 0.7.10; the cited behaviours were re-checked by grep in 0.7.10 (report header), the 320-line register.js diff was not read in full.
