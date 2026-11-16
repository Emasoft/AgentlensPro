---
trdd-id: QSRRAWJU
title: Should a malformed command line trigger the launch self-heal
column: backburner
status: tasked
created: 2026-10-29T18:05:23+0100
updated: 2026-10-29T18:05:23+0100
current-owner: main-agent@AgentlensPro
created-by: main-agent@AgentlensPro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@AgentlensPro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@AgentlensPro
approval-datetime: 2026-10-29T18:05:23+0100
---

# Should a malformed command line trigger the launch self-heal

On a first run, `agentlenspro call get_burn_status '{bad'` ran setup (skills, agents, hooks, telemetry env) and started alcore on the default ports before printing the usage error and exiting 64 (observed 2026-10-29 in an isolated HOME). Question for the owner: should argument validation run before maybeAutoSetup for verbs whose arguments are checkable offline? Relevant code: src/cli/main.ts (maybeAutoSetup), src/cli/diagnosticsCli.ts (pre-validation before init). Origin: TRDD-HO94JMKD review.

## Approval log

- 2026-10-29T18:05:23+0100 — MANDATE issued by main-agent@AgentlensPro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
