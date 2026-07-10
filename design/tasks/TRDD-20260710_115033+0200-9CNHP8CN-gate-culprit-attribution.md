---
trdd-id: 9CNHP8CN
title: Gate warnings name the culprit — attribution in every message + REST fast path
column: dev
created: 2026-07-10T11:50:33+0200
updated: 2026-07-10T11:50:33+0200
current-owner: agentlens-session
task-type: feature
release-via: none
priority: 0
effort: M
labels: [hooks, guard, gate, attribution, performance]
parent-trdd: TRDD-GOD0108C
test-requirements: [unit, typecheck, lint]
---

# Culprit attribution in gate/guard messages + REST fast path

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-07-10

**IN DEV.** User directive: "don't just say THRASH IS HAPPENING — explain what is causing it,
the entity of it, the agents affected. Concise but essential. And the CLI must diagnose the
culprits in realtime, as fast as possible."

Phases:
A. `src/bodiesActivity.ts`: bounded 6KB attribution read on fat requests (head 2KB → model;
   tail 4KB → session_id out of `metadata.user_id` — verified positions on a real 3.5MB body:
   user_id at 100%, model at 0%; `Primary working directory` sits at ~92% so workspace does
   NOT come from the body — it resolves from the hook-event ring's `cwd` for free).
   Senders/suspects aggregation in the report. Tests.
B. `src/agentGate.ts` + `src/burnGuard.ts`: every deny/warn/advisory/risk detail names WHO —
   spawning session(s) + workspace + agent types (from SubagentStart payloads), the stalled
   session (StopFailure payload), thrash suspects (fat-request senders in the window, labeled
   "likely" — responses carry no session id). Cap at top-2 + "+N more". Tests.
C. Server: enrich buildGateState with launch/stall/suspect summaries; `GET /api/burn-risk`
   REST endpoint (no MCP handshake); CLI `--risk` fast command + `--guard` switched to the
   REST path (MCP fallback on 404). Measure.
D. Docs (skill/CHANGELOG 0.10.0 amend — unreleased) + TRDD complete.

NEXT ACTION: phase A.

## Attribution model (honesty rules)

- SubagentStart/StopFailure hook events carry `session_id`, `cwd`, `agent_type` → launch and
  stall attribution is EXACT.
- Thrash misses are RESPONSES (no session field); suspects are inferred from concurrent fat
  REQUESTS (≥400KB attribution floor; ≥1MB stays the burst threshold) — messages say
  "likely source", and when no fat request was attributable the message says so and points at
  investigate_burn instead of guessing.

## Measured results (phase C)

- (pending)

## Notes and lessons learned
