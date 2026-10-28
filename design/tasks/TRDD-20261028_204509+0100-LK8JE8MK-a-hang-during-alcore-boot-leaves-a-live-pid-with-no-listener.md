---
trdd-id: LK8JE8MK
title: A hang during alcore boot leaves a live pid with no listeners that the revive never replaces
column: backburner
status: tasked
created: 2026-10-28T20:45:09+0100
updated: 2026-10-28T20:45:09+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-28T20:45:09+0100
---

# A hang during alcore boot leaves a live pid with no listeners that the revive never replaces

## Problem

start_sweeper blocks on boot_rx.recv() (log_reader.rs:1751) while the sweeper thread runs DurableState::open, durable.restore under one state.lock_timed() (:1536-1539) and the boot sweep. If any of those hangs, alcore never binds its listeners, server.pid names a live pid, hook deliveries fail, and pidfileOwnerAlive (src/cli/hookHandlers.ts:118-133) blocks the revive, so the collector is down indefinitely. Found by the MEASURE pass of TRDD-WCENKH6T (docs_dev/20261028_204123+0100-WCENKH6T-measure.md section 2).

## Acceptance

- [ ] A boot-phase hang is detected within a stated bound and the process exits with a log line naming the phase.

## Approval log

- 2026-10-28T20:45:09+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
