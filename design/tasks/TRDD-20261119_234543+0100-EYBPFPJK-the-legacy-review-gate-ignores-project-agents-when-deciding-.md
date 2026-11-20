---
trdd-id: EYBPFPJK
title: The legacy review gate ignores project agents when deciding a subagent cannot spawn
column: todo
status: tasked
created: 2026-11-19T23:45:43+0100
updated: 2026-11-19T23:45:43+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
scope: project
project-id: agentlenspro
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-19T23:45:43+0100
---

# The legacy review gate ignores project agents when deciding a subagent cannot spawn

Legacy path only (when the review mod is NOT installed), from the 01V3FOT7 triage (reports_dev/review-gate-issues/20261119-triage.md): agentCannotSpawn reads only the user agents dir and the plugin cache (src/cli/reviewGate.ts:366-401), never <cwd>/.claude/agents/, so a project agent with no Agent tool is still demanded a fork and must end on the whole-block sentinel. Fix: read <cwd>/.claude/agents/<bare>.md first (input.cwd is in subagentBlock).

## Approval log

- 2026-11-19T23:45:43+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
