---
trdd-id: 465EXTJ6
title: alcore is not at parity with the TypeScript server on 14 measured behaviours and it is the only backend that ships
column: dev
created: 2026-08-29T20:43:34+0200
updated: 2026-08-29T21:35:00+0200
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

## 2026-09-01 — 7 of 14 CLOSED (`0c1edbe`, `ba3e180b`); MCP CORS narrowed with file:line

Closed: admission control ×3, hook-spool drain, statusline liveness clock, `degradations` counter,
P5 calibration ×5 → **14 gaps became 7**.

**MCP CORS — NARROWED, not started. The assigned worker landed NOTHING; `serve_mcp` is untouched.**
Read before writing code — this is the analysis that would otherwise be redone:

`serve_mcp` (`ui.rs:3540`) routes `/mcp` GET and POST to the SHARED `handle`, which already applies
`is_disallowed_cross_origin` and the ACAO policy. So the gap is **not** a missing origin policy —
it is what happens on the two paths that never reach that preamble:

1. **The OPTIONS preflight returns early at `ui.rs:3557-3562`** with `204` and NO CORS headers at
   all. The code's own comment concedes it: *"The CORS headers themselves are added by `handle`'s
   preamble for real requests."* A preflight that carries no ACAO is exactly the "no scoped ACAO"
   the test reports.
2. **The 4 MB cap is absent on this listener.** `handle` uses `MAX_BODY_BYTES` = 64 MB (the OTLP
   contract). POST /mcp EXECUTES a tool, and its cap is 4 MB precisely because uncapped buffering
   there was an OOM vector — so the cap has to be applied per-listener, not inherited from OTLP.

**Do NOT write a second origin policy.** `is_disallowed_cross_origin` and `read_body_capped` are
already in `ui.rs`; the fix is to apply them on these two paths.

**One caution about reading the test output:** the first ACAO failure asserts *"health check still
responds"*, which reads like a CORS assertion but is a LIVENESS one — it means the server died
earlier in the file. Fix the cap first and re-read the list; the three may not be three independent
bugs.

## 2026-09-01 (later) — MCP CORS CLOSED; the 5 P5 failures are ONE upstream cause

**9 of 14 closed.** `06febeae` fixed the MCP preflight and ALL THREE ACAO failures went with it —
the card's prediction held: the first one asserts *"health check still responds"*, a LIVENESS
assertion, so the file was dying early and taking the other two with it. Three symptoms, one bug.

**COUNT CORRECTION: 5 remain, not 4** (an earlier summary said 4). 14 − 9 = 5, all P5.

**THE 5 P5 FAILURES ARE NOT A CALIBRATION BUG. Do not debug `burn_calibration.rs` — it is fine.**
Only the FIRST one is real; the other four are `ENOENT ... burn-config.json`, i.e. downstream of it
never being written. And the first fails on a PRECONDITION, before calibration is ever reached:

```
AssertionError: account window must exist before the stall. accounts: <server boot log>
```

The test establishes an account window by ingesting, THEN sends the rate-limit StopFailure. Under
alcore the account window is not there when it checks — so the stall has nothing to measure and
`calibrate_from_stop_failure` correctly declines. The gap is in the **account registry / window
establishment** path, a different subsystem entirely.

Two things worth noting in that assertion: the `accounts:` value printed the SERVER BOOT LOG rather
than an account list, which suggests the test is reading a stream it did not expect — worth
checking whether the precondition is even querying what it thinks it is before assuming alcore is
at fault.

**NEXT: verify the account window independently** — boot alcore on a scratch dir, ingest the same
fixture the test uses, and query the account registry directly. That answers "is alcore not
populating it" vs "is the test reading it wrong" without touching either the calibration port or
the test.

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

- [x] **3 of 14 done — admission control** (`admission.rs`, mutation-verified; failure count 15 → 11).
- [ ] All 14 pass under `AGENTLENS_TEST_ENGINE=alcore`, each mutation-verified.
- [ ] The suite is green under BOTH engines simultaneously (no gap closed by weakening a test).
- [ ] `AGENTLENS_TEST_ENGINE=alcore` becomes the default and the opt-in is removed.
- [ ] TRDD-1B98LCVR box 3 ticked with this card as evidence.

## Notes and lessons learned
