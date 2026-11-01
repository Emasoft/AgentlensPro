---
trdd-id: NCHQ2LWS
title: A chore holds the CoreState lock for minutes and stalls every request
column: backburner
status: tasked
created: 2026-11-01T02:50:42+0100
updated: 2026-11-01T02:51:48+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-01T02:50:42+0100
---

# A chore holds the CoreState lock for minutes and stalls every request

## Approval log

- 2026-11-01T02:50:42+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Evidence

Step A arm C (no body store, frozen copy, 46.8 h): worst state-lock wait 7.6 min, in the resident-blob chore. While the lock is held every HTTP and MCP request that needs CoreState waits. Report: reports_dev/7ypqwkpg/20261101_024233+0100-stepA-boot-arms.md (private).

## Why

Owner directive 2026-10-30: "the system must never become unresponsive." A lock held for minutes breaks it.
