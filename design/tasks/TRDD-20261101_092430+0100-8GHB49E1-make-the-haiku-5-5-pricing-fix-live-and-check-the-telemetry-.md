---
trdd-id: 8GHB49E1
title: Make the Haiku 5.5 pricing fix live and check the telemetry path
column: backburner
status: tasked
created: 2026-11-01T09:24:30+0100
updated: 2026-11-01T09:24:30+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: infra
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-01T09:24:30+0100
---

# Make the Haiku 5.5 pricing fix live and check the telemetry path

The rate row landed in f1b252d4 and ced881fb (TRDD-KQ549VCQ, complete), but the running alcore prices Haiku 5.5 at zero until it is rebuilt, re-signed and restarted; the collector is currently disabled by the owner, so this waits on the owner re-enabling it. Remaining checks moved here from KQ549VCQ's open question: (a) which model id the telemetry stream (api_request events) carries for a cheap-worker call; (b) whether an earlier probe's proxy id in message.model still occurs in any session log (only one transcript was checked, 36 of 36 entries claude-haiku-5-5); (c) whether Claude Code's own cost_usd already priced Haiku 5.5 telemetry calls correctly, which project doctrine prefers over recomputing; (d) contextWindowTokens 1M now feeds context-fill and window-percentage figures for Haiku 5.5 sessions that previously had no row — confirm those figures look right. Acceptance: after a deploy, one live cheap-worker call shows a non-zero cost in both the log-derived card and the telemetry row, and (a) to (d) are answered.

## Approval log

- 2026-11-01T09:24:30+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
