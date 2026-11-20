---
trdd-id: BQC0IA74
title: review-gate read-only gh calls and quoted rule text classed as mutating and a running subagent re-flagged every turn (GitHub 23)
column: todo
status: tasked
created: 2026-11-19T23:13:47+0100
updated: 2026-11-19T23:50:53+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-19T23:13:47+0100
---

# review-gate read-only gh calls and quoted rule text classed as mutating and a running subagent re-flagged every turn (GitHub 23)

Source: GitHub issue Emasoft/AgentlensPro 23, https://github.com/Emasoft/AgentlensPro/issues/23, opened 2026-10-16. Imported 2026-11-19 by owner order (every open GitHub issue becomes a TRDD).

## Approval log

- 2026-11-19T23:13:47+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Problem

Symptom 1: gh api -X GET search/issues -f q=... is classed as gh api (mutating), though with -X GET the -f fields are query parameters and the call is a read.
Symptom 2: the classifier matches gh issue create, gh repo fork and gh pr create inside quoted rule text in a subagent transcript, not in tool_use command fields; a scan of 315 tool_use commands found no mutating call.
Symptom 3: a still-running, already-reviewed background subagent is re-flagged on every Stop for unchanged items; four or more REVIEW forks in one session for the same items.
Repro: spawn a long-running background subagent doing read-only gh api, gh api -X GET and curl GETs that writes only to the session scratchpad; end several turns while it runs.
Proposed fixes: treat -X GET (or no method with only -f or -F) as a read; match only tool_use command fields; credit a review against a subagent transcript offset so only later tool calls re-arm the gate.

## Next action

Mod work, route to mods-expert-developer-agent. First check whether it still reproduces on agentlenspro-review-mod 0.4.x (TRDD-KZCSO0R2 moved the gate into a mod); if it does not, close this card citing the check.

## Related

Overlaps YR1598P5 (backburner, classifier cannot see nested-shell writes), 5UFK1H6E (todo) and BA0DCW98 (todo, quoted role marker in untrusted text).
The links above come from board titles only; read each linked card before using it in a fix.

## Triage

2026-11-19T23:45+0100 mods-expert-developer triage (reports_dev/review-gate-issues/20261119-triage.md, code reading only, no probes): verdict in that report under this id. Repo mod source is 0.7.13, the installed mod 0.7.10; the cited behaviours were re-checked by grep in 0.7.10 (report header), the 320-line register.js diff was not read in full.

## Status

2026-11-19T23:50+0100: symptoms 1-3 gone on the mod path by code reading (triage report). Remaining work moved: 1ZVRZGF1 (gh api body flag without a method is a POST, fix in progress) and 8S104SPF (resumed worker re-listed, probe first). Close condition: 1ZVRZGF1 merged with its tests passing, and 8S104SPF probed.
