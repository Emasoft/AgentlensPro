---
trdd-id: V52X6894
title: Dashboard hook panel switches blind guards they do not name
column: todo
status: tasked
created: 2026-11-03T23:16:06+0100
updated: 2026-11-03T23:42:57+0100
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
- 2026-11-03T23:40:00+0100 — APPROVED by the owner: «write down all those bugs. then fix them.» (the earlier MANDATE line predates this decision).

## Owner decision

Owner decision needed before this card leaves backburner: whether either item is a defect to fix. Item 2 is a POSSIBLE defect: the comment at rust-core/crates/agentlens-core/src/ui.rs:2133-2136 only protects the burn gate from the cache-guard switch, and whether Burn gate is meant as a master switch is unknown.
Owner, 2026-11-03: «write down all those bugs. then fix them.» Both items are to be fixed (bugs B7 and B8 on TRDD-RBBEX59R). Item 1 fix: the ring push no longer depends on captureEnabled; only the disk append does. Item 2 fix: the image cache-guard is governed by its own cacheGuardEnabled switch, not by Burn gate.
Resolved 2026-11-03 by the owner line above: the "Not decided" and "Owner decision needed" lines are superseded, and item 2 is to be fixed. That «those bugs» covers both items is the agent's reading of the directive. DEPLOY GATE: both fixes change alcore; any alcore built from branch fix/setup-agent-preflight carries TRDD-2HRA270Y step 4 and must not be deployed until the TRDD-12FGMAEP whole-process memory backstop lands or the owner records a waiver on TRDD-12FGMAEP. Item 1 is done inside TRDD-RBBEX59R increment (c), which rewrites the same code (hook_events.rs:270-292); item 2 adds a panel toggle for the image cache-guard, so the guard keeps a panel switch.
