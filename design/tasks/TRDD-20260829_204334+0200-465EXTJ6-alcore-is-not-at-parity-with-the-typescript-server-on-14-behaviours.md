---
trdd-id: 465EXTJ6
title: alcore is not at parity with the TypeScript server on 14 measured behaviours and it is the only backend that ships
column: todo
created: 2026-08-29T20:43:34+0200
updated: 2026-08-29T20:43:34+0200
current-owner: main-session
task-type: bugfix
scope: project
project-id: agentlenspro
parent-trdd: 1B98LCVR
severity: HIGH
relevant-rules: []
implementation-commits: []
---

# alcore is not at parity with the TypeScript server on 14 behaviours

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-08-29

**Measured, not inferred.** `AGENTLENS_TEST_ENGINE=alcore` (added in `f2f81c5`) boots the whole
test suite against the Rust server instead of `standalone/server.js`. Result: **2515 passing, 15
failing** — 14 real parity gaps plus one already-carded flake (TRDD-B7DSTJLS's
`cacheBreakTimeline`).

**These are not new regressions.** `rustBinResolve` has preferred alcore on every supported
platform since 2.30.1, so all 14 are already live in published installs. What changed today is
that they are **enumerated instead of assumed absent** — and that `standalone/server.js` no longer
ships (`d58d6e1`), so there is no longer a fallback that could mask any of them on a supported
platform.

### The 14, by area

| n | area | what fails |
|---|---|---|
| 3 | **MCP CORS** | no scoped `Access-Control-Allow-Origin`; an allowed loopback origin is not echoed; a body over the 4 MB cap does not destroy the socket — that cap exists because uncapped buffering was an OOM vector |
| 2 | **liveness + degradations** | `POST /api/statusline-samples` does not bump the capture-liveness clock (TRDD-8ADTIGKT); a swallowed OTLP ingest failure is not counted by name in `degradations` |
| 3 | **admission control** | no shed at the hard RSS wall; `shedTotal` stays 0; a concurrent burst is not shed |
| 1 | **hook spool** | the spool is not drained and reingested on boot — spooled events stay unread |
| 5 | **P5 window auto-calibration** | a rate-limit StopFailure through the ingest path never writes `burn-config.json`, so none of the calibration rules (don't lower on a smaller replay, don't calibrate on a rollover, don't calibrate on a non-rate-limit stall, never overwrite a user-set capacity) are exercised at all |

**Every one is BEHAVIOUR, not a missing route.** TRDD-1B98LCVR's scope report warned its endpoint
list was "a FLOOR, not a complete inventory" and that both gaps found before this were log lines
and env reads invisible to an endpoint diff. This confirms that warning at scale: an endpoint diff
would have found none of these 14.

### Severity, stated honestly

`admission control` and the `4 MB body cap` are the two that carry real risk — both exist to bound
memory under load, and the ingest measurements from the same day put 1,000,080 spans and ~20 GB RSS
in the window at peak. The spool drain is data-loss-shaped (events accepted, then never reingested).
The MCP CORS gaps are a read-scope hardening (TRDD-F6BM1BDI) that alcore does not enforce. P5
calibration is a feature that silently does nothing.

## NEXT ACTION

Work them in risk order, not list order: **admission/RSS shedding + the body cap first** (bounded
memory under load), **then the spool drain** (data loss), **then MCP CORS**, **then P5
calibration**. Each one:

1. Read the TS implementation, port it to alcore, and make the corresponding test pass under
   `AGENTLENS_TEST_ENGINE=alcore` **without** regressing it under the default engine.
2. Mutation-verify: revert the port and the test must fail.

**Do NOT flip `AGENTLENS_TEST_ENGINE=alcore` to the default until all 14 pass** — the whole point of
the opt-in is that a red suite with 14 unrelated causes tells you nothing. Flipping it is the
closing act of this card, and it is what makes TRDD-1B98LCVR box 4 (deleting `standalone/server.ts`)
safe.

## Acceptance

- [ ] All 14 pass under `AGENTLENS_TEST_ENGINE=alcore`, each mutation-verified.
- [ ] The suite is green under BOTH engines simultaneously (no gap closed by weakening a test).
- [ ] `AGENTLENS_TEST_ENGINE=alcore` becomes the default and the opt-in is removed.
- [ ] TRDD-1B98LCVR box 3 ticked with this card as evidence.

## Notes and lessons learned
