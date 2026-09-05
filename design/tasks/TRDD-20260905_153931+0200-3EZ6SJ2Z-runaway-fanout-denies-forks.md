---
trdd-id: 3EZ6SJ2Z
title: The burn-gate's RUNAWAY_FANOUT rule denies fork launches although a fork writes no new prefix
column: testing
created: 2026-09-05T15:39:31+0200
updated: 2026-09-05T16:38:00+0200
current-owner: main-session
task-type: bugfix
priority: high
min-approval-requirement: none
scope: project
project-id: agentlenspro
related: [DIZ289UQ, THRGX41P, VY1IUVUM]
relevant-rules: []
implementation-commits: [52155adf, 10715a00]
---

# The burn-gate's RUNAWAY_FANOUT rule denies fork launches although a fork writes no new prefix

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-09-05T16:38:00+0200

**`testing` — code committed in both twins and LIVE since 16:37; the behavioural acceptance is
still unobserved.** The unit and route tests prove the rule; what remains is one real event: a fork
launch while the machine is inside a ≥8-launches/60 s wave must produce the `[agentlens] … This fork
is allowed` warn in the transcript instead of the deny. **NEXT ACTION:** the next time a fork spawn
is attempted during a wave (they were happening several times an hour today), record the transcript
line here with its time; then `testing → ai_review`. If the deny still appears, the live binary is
not the one built here — check `ps` for the `bin-native/darwin-arm64/alcore` path and its mtime.

USER report 2026-09-05 15:36: "why the agentlenspro hook is blocking my fork-agents from doing their
reviews?? they are fork agents, they reuse the same context of the parent, no cache build is triggered
except for the small prompt". Observed twice in this session (14:20, 15:33) and once in a peer session
(the 15:32 example the user pasted): the stop-hook review fork — the gate's OWN mandated review — was
refused with `8 subagent launches in the last 60s — runaway fan-out`.

## Cause (✓ VERIFIED from source, both twins)

- `src/agentGate.ts:330-338` and `rust-core/crates/agentlens-core/src/burn/agent_gate.rs:390-403`: the
  rule fires on `startsLast60s >= runaway60s` (default 8). The count is MACHINE-WIDE by design (the
  comment: "this deny protects the machine's cache") and type-agnostic — `fork` is computed at
  `agentGate.ts:272` but the runaway branch never consults it.
- The fork exemption from TRDD-DIZ289UQ (`agentGate.ts:316-328`, `agent_gate.rs:384-389`) applies ONLY
  to `THRASH_ACTIVE`; its measured basis is the same one that applies here: a fork's first request
  reads the caller's last-written entry warm (cache_read 380k–785k, cache_creation 1–3k), so a fork
  multiplies nothing. The fork-specific storm case (fat parent + cold cache + ≥2 launches in 2 min) is
  already covered by `FORK_STORM_FORMING` (`agentGate.ts:356`) and the single-fork advisory (`:374`).
- So the user's premise holds: the only fork launch that burns is the cold-fat one, and it has its own
  rule. Counting a fork toward the machine-wide fan-out is fine (it IS a launch); DENYING the fork on
  that count guards nothing and blocks the review gate on any busy machine — the other sessions'
  fresh spawns (`workflow-subagent`, `lean-worker`) fill the 60 s window and the fork pays for it.

## Fix

Exempt `subagent_type === 'fork'` from the RUNAWAY_FANOUT deny in BOTH twins: the fork gets a `warn`
carrying the count (so the transcript shows the gate saw the wave) and passes; fresh agents keep the
deny. The keep-warm pinger path is untouched (it already downgrades). The count itself stays
machine-wide and still includes forks.

## Acceptance

- [x] `agentGate.ts`: a fork with `startsLast60s >= 8` gets `decision: 'warn'`, `code: 'RUNAWAY_FANOUT'`;
      a non-fork with the same state still gets `deny`. Unit test for both in `agentGate.test.ts`
      (`52155adf`; scoped mocha 73/0 — one pre-existing test used a fork as "a launch that denies" and
      was repointed at a fresh agent).
- [x] `agent_gate.rs`: same behaviour, same reason text (parity twin), covered by the ring-fed
      RUNAWAY_FANOUT test in `tests/ui.rs` plus a fork case (`10715a00`; 1 passed; tallies 10/1/2/1 →
      11/1/3/1 because the fork case is one counted check and one warn). `cargo test --lib agent_gate`
      matched 0 tests — the Rust gate has no lib-level unit tests, so the route test is the whole Rust
      coverage.
- [x] `pnpm run check-types` 0; `cargo clippy -p agentlens-core -- -D warnings` 0 — clippy covers lib +
      bins only; `tests/ui.rs` was compiled and run by `cargo test`, not linted.
- [x] Deployed 16:37: release build (9m42s) → `bin-native/darwin-arm64/alcore` → `codesign -s - --force`
      (`--version` exit 64 = usage, not 137) → `agentlenspro server restart` (pid 39382 → 37474, the
      new path in `ps`); the binary carries the new reason string. NOT yet observed on a real ≥8/60 s
      wave — the first fork launch inside one is the acceptance read; until then this box is the
      deployment, not the behaviour.

## Notes and lessons learned
