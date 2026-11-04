---
trdd-id: XZ06N18N
title: help --install-skill and --install-hooks skip the foreign telemetry check
column: todo
status: tasked
created: 2026-11-04T15:36:47+0100
updated: 2026-11-04T15:36:47+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-04T15:36:47+0100
---

# help --install-skill and --install-hooks skip the foreign telemetry check

Symptom: `agentlenspro help --install-skill` and `help --install-hooks` parse the install flags in diagnosticsCli at any argv position, but `help` is excluded from auto-setup, so these two flag paths run without the foreign-telemetry check that D15 of the step (d) spec puts on every other install path; under a foreign telemetry setup (company gateway, managed settings, shell export) they can install skills or hooks that the foreign path would have parked or refused. `help --install-otel` is still refused by ensureTelemetryConfig (src/telemetryConfig.ts, foreign refusal), so only the skill and hook flags are affected. Parent context: TRDD-RBBEX59R (cited as text, parent-trdd not set), bug B15 there; found in the review of the step (d) spec and read in code, not run. Fix: decide whether the two flags get the same foreign check as the other install paths, or help stops accepting install flags.

## Approval log

- 2026-11-04T15:36:47+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
