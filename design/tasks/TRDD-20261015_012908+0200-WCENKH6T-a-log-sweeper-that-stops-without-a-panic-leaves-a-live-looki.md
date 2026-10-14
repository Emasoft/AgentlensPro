---
trdd-id: WCENKH6T
title: A log-sweeper that stops without a panic leaves a live-looking collector that nothing restarts
column: todo
status: tasked
created: 2026-10-15T01:29:08+0200
updated: 2026-10-15T01:29:08+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-15T01:29:08+0200
---

# A log-sweeper that stops without a panic leaves a live-looking collector that nothing restarts

## Problem
The hook revive is pidfile-only (src/cli/hookHandlers.ts:108-133, `pidfileOwnerAlive()`): it replaces a server only when its process is dead. If the log-sweeper thread stops in steady state WITHOUT the process dying (a panic today, or after TRDD-DA0GN1CS commit 2 a loop `break`, an `Err` return, a thread hung on I/O or starved behind a lock), ingestion stops while the process looks alive, and nothing restarts it. TRDD-DA0GN1CS covers only the panic path. Raised by the adversarial review of the DA0GN1CS proposal (2026-10-15).

## Fix direction
A sweeper heartbeat timestamp (or `JoinHandle::is_finished()`) checked by the main thread or a chore; a stale heartbeat logs and exits the process so the revive restarts it. Mind the first-pass lock holds measured in TRDD-H3D5ZBO1 (130-576 s) when choosing the staleness limit.

## Acceptance
- [ ] A sweeper that stops without a panic is detected within a stated bound, and the process exits with a log line naming the cause.
- [ ] A test stops the sweeper thread without a panic and asserts the exit.

## Approval log

- 2026-10-15T01:29:08+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
