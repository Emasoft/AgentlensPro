---
trdd-id: 9CNHP8CN
title: Gate warnings name the culprit — attribution in every message + REST fast path
column: completed
created: 2026-07-10T11:50:33+0200
updated: 2026-08-18T12:45:00+0200
last-test-result: pass
last-test-at: 2026-07-10T12:05:00+0200
implementation-commits: [c92e11a, 1b0eb2b, 211aa41]
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

**COMPLETE — shipped + live-verified 2026-07-10.** All 4 phases done; suite 565 passing.
Live proof: the first real `--risk` call named THIS session as the huge-request sender
("Senders: session 777b8f52… (claude-fable-5, 7 fat requests ~8.2MB)") — attribution worked
on real traffic first try. User directive was: "don't just say THRASH IS HAPPENING — explain
what is causing it, the entity of it, the agents affected. Concise but essential. And the CLI
must diagnose the culprits in realtime, as fast as possible."

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

## Measured results (2026-07-10, live, canonical server)

- `agentlens-cli --risk` end-to-end: **41ms** steady-state (was ~700ms via the MCP handshake;
  308ms after the first fast-path draft). `GET /api/burn-risk` p50 **2.1ms**.
- The two request-path costs removed: gatherBurn recompute per request (~270ms — now reuses
  the 4s tick's cached status, ≤4s stale vs a 5-min window) and inline tracker polls (100-400ms
  of JSON.parse when new multi-MB responses land — now a 5s background timer; requests only
  read the rings, ≤5s staleness vs 90s/5min windows).
- Known tail: gate/risk worst-case ~0.7s when a request lands while the server's own periodic
  aggregation (tickBurn ~270ms every 4s) blocks the event loop — inherent single-thread
  contention, ≪ the hook's 2s curl cap, fail-open beyond it. Follow-up if it ever matters:
  move tickBurn to a worker thread.
- Attribution cost: 6KB bounded read per fat (≥400KB) request only.

## Notes and lessons learned

## Approval log
- 2026-08-18T12:45:00+0200 — ARCHIVED by USER batch directive ("complete all TRDD"); validity re-verified: buildGateState() at standalone/server.ts:1190, GET /api/burn-risk at standalone/server.ts:3638, CLI --risk at src/cli/diagnosticsCli.ts:587.
