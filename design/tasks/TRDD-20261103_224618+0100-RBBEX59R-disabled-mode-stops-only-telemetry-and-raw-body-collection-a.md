---
trdd-id: RBBEX59R
title: Disabled mode stops only telemetry and raw-body collection and nothing else
column: design
status: tasked
created: 2026-11-03T22:46:18+0100
updated: 2026-11-03T22:46:18+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: refactor
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-03T22:46:18+0100
---

# Disabled mode stops only telemetry and raw-body collection and nothing else

## Owner directives (verbatim, 2026-11-03)
- «the disabled state should never disable the adversarial review hook!»
- «to be clear: the disabled mode should ONLY stop the collection of the telemetry logs and raw bodies! it should not do anything else!»

## Current state
The off switch (~/.agentlens/DISABLED, or AGENTLENS_DISABLED=1) is documented as "global: every side-effect off" (src/cli/killSwitch.ts:28). About 10 modules check it, including main.ts (most CLI verbs refuse to run), autoSetup.ts (no repair), setup.ts (no server start), disableCli.ts, statuslineCapture.ts and hookHandlers.ts. The review gate and supervisor already ignore it (e09151d0).

## Plan
1. Inventory every behaviour the switch stops today, with file:line, each tagged as telemetry or raw-body collection versus anything else.
2. The owner confirms the keep/stop table, including the ambiguous rows (server and dashboard, local session-log ingestion, hook-event capture, status-line capture).
3. Implement, so that only the confirmed collection paths stop. Tests pin every row.

## Context
Follows TRDD-8D26QVBC (the review gate ignored the switch).

## Approval log

- 2026-11-03T22:46:18+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
