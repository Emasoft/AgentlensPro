---
trdd-id: 3EZ6SJ2Z
title: The burn-gate's RUNAWAY_FANOUT rule denies fork launches although a fork writes no new prefix
column: complete
created: 2026-09-05T15:39:31+0200
updated: 2026-10-17T07:53:06+0200
current-owner: main-session
task-type: bugfix
priority: high
min-approval-requirement: none
scope: project
project-id: agentlenspro
related: [DIZ289UQ, THRGX41P, VY1IUVUM]
relevant-rules: []
implementation-commits: [52155adf, 10715a00]
status: archived
---

# The burn-gate's RUNAWAY_FANOUT rule denies fork launches although a fork writes no new prefix

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-10-17

**2026-10-17: behavioural acceptance OBSERVED (80 transcripts, the first one 20:36 on 2026-09-05; see Live acceptance observed). Next: ai_review of 52155adf and 10715a00.**
Closed 2026-10-17:
ai_review passed,
parity holds
(1bd0e3cd), the warn
path is observed
live, and no fork
has been denied since
the deploy (0 of
2650 fork launches;
the control found 21
fork denies before
it).

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
      deployment, not the behaviour. OBSERVED: see Live acceptance observed (2026-10-17).

## Notes and lessons learned

## Live acceptance observed (2026-10-17)

- Behavioural acceptance OBSERVED on 2026-10-17. A recursive search of ~/.claude/projects/**/*.jsonl for the gate's fork-pass text "This fork is allowed" found 80 transcript files. The earliest hit is 2026-09-05T18:36:53Z, which is 20:36 +0200, after the 16:37 deploy. The latest is 2026-10-16T16:06:18Z. A sample hit, 2026-09-24 in another project, is a PreToolUse hook systemMessage: "[agentlens] AgentLens burn-gate: 10 subagent launches in the last 60s — runaway fan-out. From this project: lean-worker, fork. This fork is allowed: it reads the caller's cache entry and writes no new prefix…". Counter-check done the same day: see the next bullet.
- Counter-check, same day (2026-10-17): docs_dev/20261017_074841+0200-runaway-fanout-fork-deny-check.md. Its control found 44 real RUNAWAY_FANOUT denies before the 2026-09-05T14:37Z deploy, 21 of them of `fork`. After the deploy there were 0 fork denies across 2650 fork launches, and 53 denies of fresh agent types (lean-worker 35, janitor memory agent 6, general-purpose 5, and others). The one post-deploy deny with no subagent_type (2026-09-23) has only description and prompt keys, so it is a fresh general-purpose launch, which is correctly denied.

## Approval log

- 2026-10-17T07:43:27+0200 — column → ai_review by main-agent@agentlenspro. behavioural acceptance observed in 80 transcripts since 2026-09-05 20:36; code review of 52155adf and 10715a00 next
- 2026-10-17T07:53:06+0200 — COMPLETE by main-agent@agentlenspro. ai_review passed; acceptance observed live; 0 post-deploy fork denies of 2650 launches; review done under the owner's 2026-10-05 delegation recorded on TRDD-AVUGZV1K.
