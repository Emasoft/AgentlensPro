---
trdd-id: RBBEX59R
title: Disabled mode stops only telemetry and raw-body collection and nothing else
column: design
status: tasked
created: 2026-11-03T22:46:18+0100
updated: 2026-11-03T23:08:50+0100
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

Decided by the owner. STOP under the switch: raw request bodies, OTEL telemetry, and hook event logging (the `agentlenspro hook` lifecycle capture). KEEP: status-line capture (realtime data), the review gate and its supervisor, the guard hooks (burn-gate, image cache-guard, delegate gate, and the guard against more than 5 simultaneous agents), and every hook set from the dashboard right panel; the off switch never turns these off. Two conflicts are recorded as open questions (g) and (h) below, not resolved here: the third directive says these hooks are switched only from the panel, which read literally includes the review gate, against the owner order of 2026-09-03 that the review gate is never bypassed; and the panel Lifecycle capture toggle switches exactly the hook event logging that the off switch must stop.
Still open for the owner, in dependency order: (b) the server under the switch: keep it running in a new no-collection mode (OTLP 4318 bound but dropping, no log sweep) that serves stored data, or keep it stopped as today? Either way, the burn gate allows everything when no server answers (src/cli/hookHandlers.ts:487). (c) if (b) is yes, should `agentlenspro disable` switch a running server to that mode instead of stopping it? (d) hook events under the switch. Proposed reading: the server keeps them in memory only and writes nothing to disk, so the spawn guards keep counting; confirm, or say that keeping them in memory still counts as logging. (e) follows from (d): last-compact reads the on-disk hook-event log, so under the switch it answers "cannot answer". (a) local session-log ingestion from ~/.claude into the store: stop or keep? (f) switches outside the panel already exist (AGENTLENS_GATE=off, AGENTLENS_CACHE_GUARD=off, AGENTLENS_DELEGATE_GATE=off, `agentlenspro --hooks ...`): keep them, or make the panel the only switch? (g) does the review gate get a panel toggle, as the third directive reads literally, or stay always on per the 2026-09-03 order? (h) does the off switch override the panel Lifecycle capture toggle? (i) which hook is the guard against more than 5 simultaneous agents? No such limit exists in this repo; the nearest is the burn gate RUNAWAY_FANOUT rule, which fires at 8 subagent launches within 60 s (rust-core/crates/agentlens-core/src/burn/agent_gate.rs:42,391), a different measure.
✓ VERIFIED leak in today's code: run in this session, `agentlenspro setup --dry-run --json` under the switch lists OTEL_LOG_RAW_API_BODIES as ABSENT, "will be written: file:<home>/.agentlens/otel-bodies", the only one of its 20 telemetry keys not already equal; the setup verb is not refused under the switch (src/cli/main.ts:270: enable, disable and setup pass through). So a real setup turns raw-body collection back on. ? INFERRED from the worker report plus a grep miss for agentlensDisabled and killSwitch in src/telemetryConfig.ts and src/captureConfig.ts: no switch check on the write path stepOtel (src/cli/setup.ts:1198) to ensureTelemetryConfig (src/telemetryConfig.ts:486) to safeConfigEdit (:555). Commit 4dbdb2c9 called this verified before the missing key had been seen. Fix this first, as its own change with a test.
Inventory of what the switch stops today (14 rows, file:line): local report reports_dev/rbbex59r/20261103_224852+0100-killswitch-inventory.md. Order of work: the setup leak fix; the Rust no-collection mode (alcore must read BOTH switch halves; today it reads only the file); server start paths (hook revive, revive, supervisor, ensureServer); CLI verbs; repair and skills (repair must never re-add collection keys); guard hooks; status line kept by default. Raw-body removal reaches only sessions launched afterwards.

## Findings 2026-11-03 — what the guards read and the panel holds

The spawn guards (RUNAWAY_FANOUT at 8 launches in 60 s, FORK_STORM, cold-resume fan-out) and the SendMessage liveness check count SubagentStart and SubagentStop events in the server's in-memory hook-event ring (rust-core/crates/agentlens-core/src/burn/agent_gate.rs:42,391,503-526,743-749). Both feeders of the ring are hook capture: each accepted event (rust-core/crates/agentlens-core/src/hook_events.rs:287), and at server boot the last hour of the on-disk hook-event log (rust-core/crates/agentlens-core/src/lib.rs:831-838). So stopping hook capture as a whole blinds those guards, against the owner's KEEP. ✓ VERIFIED for those lines; ? INFERRED that no other feeder exists (one grep of rust-core for push_recent_hook_event and recent_hook_events.push, test code excepted).
Current panel defect, outside this card's scope: the Lifecycle capture toggle (captureEnabled) drops events before they reach the ring (hook_events.rs:270), so switching it off already blinds the spawn guards today. ✓ VERIFIED that the drop precedes the ring push. Needs its own card if it is to be fixed.
Not affected by stopping hook capture, because none of them reads hook events: the review gate and supervisor (transcript, settings, agent directories), the delegate gate (transcript, env) and the image cache-guard (transcript tail). Affected: last-compact reads <data>/hook-events and goes stale; `cache-expired --json` loses its resumeStaleness field, which comes from SessionStart hook events. cache-state, plain cache-expired and statusline-history read the status-line capture, which is kept. ? INFERRED from the worker report (local report reports_dev/rbbex59r/20261103_230057+0100-three-questions.md), not re-read in this session.
? INFERRED (worker report, not re-identified in this session) that the dashboard right panel is the "Hook switches" card, HooksSection, media/src/tabs/Alerts.tsx:572. ✓ VERIFIED by grep that it holds Burn gate (gateEnabled), gate mode, Lifecycle capture (captureEnabled) and In-band advisor (advisorEnabled), and no cacheGuardEnabled. The image cache-guard is switched by `agentlenspro --hooks cacheguard=` or by a hand edit of <data>/hook-config.json plus a restart. Current defect, outside this card's scope: Burn gate off also silences the image cache-guard, because rust-core/crates/agentlens-core/src/ui.rs:2129 returns before the Read branch (✓ VERIFIED).
Requirement for the implementation (from the review of 4dbdb2c9): status-line capture POSTs samples to the server (src/cli/statuslineCapture.ts:147). Under the switch it keeps working only if the no-collection server still accepts status-line samples, or if capture writes to disk directly as the existing DISABLED-KEEP-STATUSLINE branch does (statuslineCapture.ts:152). ? INFERRED from the inventory, not re-read in this session.
