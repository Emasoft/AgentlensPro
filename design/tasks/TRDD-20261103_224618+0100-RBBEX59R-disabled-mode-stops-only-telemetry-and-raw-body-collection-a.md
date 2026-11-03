---
trdd-id: RBBEX59R
title: Disabled mode stops only telemetry and raw-body collection and nothing else
column: design
status: tasked
created: 2026-11-03T22:46:18+0100
updated: 2026-11-03T22:56:48+0100
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
- «to be precise, it should also stop the event logging of the hooks monitoring the claude code events, except for the statusline hook that collect the realtime data. it should not stop the hook for the adversarial review or other hooks or the rate-limiting guard hooks, for example the hooks alerting or blocking the spawn of more than 5 agents simultaneously. or the others set via the dashboard right panel. these should stay, and only activated or deactivated via the dashboard right panel.»

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

## Decisions and findings 2026-11-03

Decided by the owner. STOP under the switch: raw request bodies, OTEL telemetry, and hook event logging (the `agentlenspro hook` lifecycle capture). KEEP: status-line capture (realtime data), the review gate and supervisor, the rate-limiting guards (burn-gate, the >5 simultaneous agents guard, image cache-guard), the delegate gate, and every hook set from the dashboard right panel. Those are switched on or off only from that panel, never by the off switch.
Still open for the owner: (a) local session-log ingestion from ~/.claude into the store: stop or keep? (b) the server: run in a new no-collection mode (OTLP 4318 bound but dropping, no log sweep), serving stored data to the dashboard and CLI? (c) should `agentlenspro disable` switch a running server to that mode instead of stopping it?
✓ VERIFIED leak in today's code: under the switch, `agentlenspro setup --dry-run` reports "otel-env 1 missing ... would: wire telemetry env", and settings.json lacks only OTEL_LOG_RAW_API_BODIES among the telemetry keys, so a real setup would turn raw-body collection back on. The switch gates only setup's server-start step (setup.ts:1375). Fix this first, as its own change with a test.
Inventory of what the switch stops today (14 rows, file:line): local report reports_dev/rbbex59r/20261103_224852+0100-killswitch-inventory.md. Order of work: the setup leak fix; the Rust no-collection mode (alcore must read BOTH switch halves; today it reads only the file); server start paths (hook revive, revive, supervisor, ensureServer); CLI verbs; repair and skills (repair must never re-add collection keys); guard hooks; status line kept by default. Raw-body removal reaches only sessions launched afterwards.
