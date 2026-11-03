---
trdd-id: RBBEX59R
title: Disabled mode stops only telemetry and raw-body collection and nothing else
column: design
status: tasked
created: 2026-11-03T22:46:18+0100
updated: 2026-11-03T23:04:18+0100
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

Decided by the owner. STOP under the switch: raw request bodies, OTEL telemetry, and hook event logging (the `agentlenspro hook` lifecycle capture). KEEP: status-line capture (realtime data). KEEP, always on and switchable nowhere: the review gate and its supervisor (owner rule on TRDD-8D26QVBC; the dashboard panel has no toggle for them and must not get one). KEEP, never turned off by the off switch: the guard hooks (the burn-gate with its spawn guard against more than 5 simultaneous agents, the image cache-guard, the delegate gate) and every hook set from the dashboard right panel; the panel hooks are switched only from the panel.
Still open for the owner: (a) local session-log ingestion from ~/.claude into the store: stop or keep? (b) the server: run in a new no-collection mode (OTLP 4318 bound but dropping, no log sweep), serving stored data to the dashboard and CLI? The guards need it, because the burn gate allows everything when no server answers (src/cli/hookHandlers.ts:487). (c) should `agentlenspro disable` switch a running server to that mode instead of stopping it? (d) the spawn guards read hook events from memory (see the findings below): under the switch, keep feeding the in-memory hook-event ring while writing nothing to disk, or stop capture entirely and lose those guards? (e) last-compact reads the on-disk hook-event log, so under the switch it can only answer "cannot answer": acceptable? (f) switches outside the panel already exist (AGENTLENS_GATE=off, AGENTLENS_CACHE_GUARD=off, AGENTLENS_DELEGATE_GATE=off, `agentlenspro --hooks ...`): keep them, or make the panel the only switch?
✓ VERIFIED leak in today's code (second check, local report reports_dev/rbbex59r/20261103_230057+0100-three-questions.md): under the switch, `agentlenspro setup --dry-run --json` lists OTEL_LOG_RAW_API_BODIES as the only ABSENT key of the 20 telemetry keys setup owns (src/telemetryConfig.ts:145-166), and the write path stepOtel (src/cli/setup.ts:1198) to ensureTelemetryConfig (src/telemetryConfig.ts:486) to safeConfigEdit (:555) never checks the switch, so a real setup turns raw-body collection back on. The switch gates only setup's server-start step (setup.ts:1375); auto-repair is blocked separately (src/cli/autoSetup.ts:245). Commit 4dbdb2c9 called this verified before the missing key had been seen by name. Fix this first, as its own change with a test.
Inventory of what the switch stops today (14 rows, file:line): local report reports_dev/rbbex59r/20261103_224852+0100-killswitch-inventory.md. Order of work: the setup leak fix; the Rust no-collection mode (alcore must read BOTH switch halves; today it reads only the file); server start paths (hook revive, revive, supervisor, ensureServer); CLI verbs; repair and skills (repair must never re-add collection keys); guard hooks; status line kept by default. Raw-body removal reaches only sessions launched afterwards.

## Findings 2026-11-03 — what the guards read and the panel holds

The spawn guards (more than N agents started in 60 s, FORK_STORM, cold-resume fan-out) and the SendMessage liveness check count SubagentStart, SubagentStop and StopFailure events in the server's in-memory hook-event ring (rust-core/crates/agentlens-core/src/burn/agent_gate.rs:503-779). Only hook capture feeds that ring (rust-core/crates/agentlens-core/src/hook_events.rs:287), so stopping hook capture as a whole blinds those guards, against the owner's KEEP. ✓ VERIFIED
The panel's existing "Lifecycle capture" toggle (captureEnabled) drops events before they reach the ring (hook_events.rs:270), so switching it off already blinds the spawn guards today. ✓ VERIFIED
Not affected by stopping hook capture: the review gate, supervisor, delegate gate and image cache-guard read transcripts only. last-compact reads <data>/hook-events and goes stale. cache-state, cache-expired and statusline-history read the status-line capture, which is kept. (local report reports_dev/rbbex59r/20261103_230057+0100-three-questions.md)
Dashboard right panel = "Hook switches", HooksSection, media/src/tabs/Alerts.tsx:572: Burn gate (gateEnabled), gate mode (enforce or warn), Lifecycle capture (captureEnabled), In-band advisor (advisorEnabled). It has no toggle for the image cache-guard (cacheGuardEnabled, set only by `agentlenspro --hooks cacheguard=`), the delegate gate, or the review gate. Turning Burn gate off also silences the image cache-guard, because rust-core/crates/agentlens-core/src/ui.rs:2129 returns before the Read branch. ✓ VERIFIED
