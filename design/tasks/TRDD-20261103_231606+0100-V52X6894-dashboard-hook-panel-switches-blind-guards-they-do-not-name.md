---
trdd-id: V52X6894
title: Dashboard hook panel switches blind guards they do not name
column: backburner
status: tasked
created: 2026-11-03T23:16:06+0100
updated: 2026-11-03T23:16:06+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-03T23:16:06+0100
---

# Dashboard hook panel switches blind guards they do not name

Two current defects in the dashboard "Hook switches" panel, found while working TRDD-RBBEX59R (2026-11-03), out of that card's scope.

1. Turning "Lifecycle capture" (captureEnabled) off drops hook events before they reach the server's in-memory hook-event ring (rust-core/crates/agentlens-core/src/hook_events.rs:270, before the ring push at :287). The burn gate's spawn guards (RUNAWAY_FANOUT, rust-core/crates/agentlens-core/src/burn/agent_gate.rs:391) and the SendMessage liveness check count events in that ring, so the toggle labelled as a storage switch silently disables those guards. ✓ VERIFIED that the drop precedes the ring push.
2. Turning "Burn gate" (gateEnabled) off also silences the image cache-guard, because rust-core/crates/agentlens-core/src/ui.rs:2129 returns before the Read branch that has its own cacheGuardEnabled switch. ✓ VERIFIED.

Not decided: whether to fix either, and how. TRDD-RBBEX59R question 3 (hook events kept in memory under the off switch) may settle the first.

## Approval log

- 2026-11-03T23:16:06+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
