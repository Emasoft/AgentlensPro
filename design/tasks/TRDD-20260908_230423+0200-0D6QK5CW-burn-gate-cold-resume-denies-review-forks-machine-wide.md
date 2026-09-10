---
trdd-id: 0D6QK5CW
title: The burn-gate cold-resume rule denies review forks machine-wide and deadlocks the review gate
column: dev
created: 2026-09-08T23:04:23+0200
updated: 2026-09-10T04:51:30+0200
current-owner: main
task-type: bugfix
min-approval-requirement: none
priority: critical
severity: high
blocked-by: []
npt: []
eht: []
implementation-commits: [c3809f16]
project-id: agentlenspro
scope: project
labels: [burn-gate, review-gate, agent-gate, cold-resume, fork, deadlock]
relevant-rules: []
---

# The burn-gate cold-resume rule denies review forks machine-wide and deadlocks the review gate

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-10 04:51

Pulled `todo` → `dev` at 04:29 by the janitor keep-going resume (this session owns the card; the
ownership note below is superseded). Candidate 1 delegated to a lean-worker with four brief
amendments from the adversarial review (record the FORK_STORM assumption's truth; match the RUNAWAY
exemption's shape in each core; answer candidate 3 by reading the `startsLast2min` feed; red-first
tests with a cold-resume fixture).
LANDED as `c3809f16` (worker report `reports/review-gate/20260910_044030+0200-0D6QK5CW-worker.md`):
both cores exempt a fork from COLD_RESUME_FANOUT with `warn` (same code, `fork && !keepWarm`, the
RUNAWAY exemption's wording), the deny text unchanged, the parity fixture gained the case and
`agentgate-expected.json` was regenerated. Verified first-hand before the commit: branch order
THRASH → RUNAWAY → COLD_RESUME → FORK_STORM in both cores and the warn precedes the deny;
`startsLast2min` is fed only by `SubagentStart` events (`agent_gate.rs:723-728`, the sole write
site; the TS core has no feeder, it is a state field) — candidate 3 answered: a DENIED launch does
not increment it, a warned one does; my own regeneration of the golden is byte-identical to the
committed one (`cmp` 0, 61 cases); check-types / eslint 0; the new TS test ✔ inside the full suite
(2753 passing — the 5 failures are TRDD-CS2W7E77's calibration tests); cargo lib 8/8, parity 1/1;
clippy `-D warnings` failed only on the pre-existing `rss_guard.rs:181` lint, fixed as
TRDD-QJPUG1WP. The "FORK_STORM_FORMING already covers a cold fork" line (§Where, last bullet) is
REFUTED by reading: that rule needs `fat` AND `≥2`, the cold-resume case fires at `≥1`.
Post-write adversarial review of `c3809f16`: 8 findings. ACCEPTED — (2) the new warn returns before
FORK_STORM_FORMING, so for the whole window a fat+cold parent's 2nd+ fork is warned instead of
denied; fix = move the FORK_STORM block before the COLD_RESUME block in both cores (reviewer-
prescribed, no second round); (5) the `!keepWarm` carve-out has no test; (6) the storm case has no
test. Delegated as ONE follow-up to a lean-worker at 04:51 (reorder + two TS tests + two fixture
cases, red-first on both sides, regenerate, full chain incl. `--workspace` clippy). REJECTED — the
`&& !cold` variant: a parent that idled past its TTL through the stall is exactly the case whose
FIRST fork must pass, or the deadlock returns; (3) the base-string refactor is byte-neutral and
removes a duplicated message, kept; (8) "USER-ordered advisory wording" is the file's own phrasing
(`agentGate.ts:256`, `:320`, `:343`), kept. RUNAWAY's identical shadowing of FORK_STORM is
pre-existing and out of scope: TRDD-VRW14OB0 (backburner).
Rows 1 and 2 are met by `c3809f16` (the follow-up re-runs both); row 3 is BLOCKED on the owner's
`go`/`no` for the alcore binary (TRDD-81BW1CS9) — the LIVE gate keeps the old decision until then;
row 4 after the follow-up lands (one message with both SHAs).
NEXT ACTION: worker3 report → verify the reorder diff first-hand (both cores, reason strings
unchanged) → my chain → commit by name → `testing` with row 3 marked blocked → notify tldr-code-7a.

Filed from the main session at 23:04 while the USER's forked session works the review-hook
directive ("fix the damn adversarial review hook"); that session OWNS this card — the main
session will not edit `agentGate.ts` or `burn/agent_gate.rs`. Two peer sessions measured the
same deadlock within the same ten minutes (this one: 4 fork refusals 22:59–23:03; tldr-code-7a:
4 refusals, lean-worker ×2 + fork ×2, over ~4 min).
(SUPERSEDED — see STATE) NEXT ACTION: implement the fork exemption in BOTH decision cores (the
Rust one is the live decision), add the test that fails on the current code, deploy alcore, then
answer the scoping question below on measured evidence.

## What was measured (VERIFIED)

- Every `Agent` launch — `fork` included — is refused with:
  `AgentLens burn-gate: a rate-limit stall ended Nmin ago … 1 agent(s) already launched since —
  that first launch IS the cache warm-up … Retry this launch in ~60s.` N advanced 2 → 3 while
  "1 agent(s)" never changed (both sessions).
- The Stop-time review gate (`agentlenspro review-gate`) demands exactly such a fork after every
  write-shaped turn. With the launch refused, the only exit is the `REVIEW-GATE: NO REVIEW
  POSSIBLE` hatch — so a busy machine gets NO adversarial review at all, on every turn, for the
  whole cold-resume window. The two gates deadlock each other.

## Where the rule lives (VERIFIED, file:line)

- TS decision core: `src/agentGate.ts:355-366` — `if (coldResume && state.startsLast2min >= 1)`
  → `deny('COLD_RESUME_FANOUT', …)`. `coldResume` (`:285-289`) = a StopFailure hook event seen
  within `coldResumeWindowMs` (default `600_000`, `:56`) and no `stallRecovered` evidence.
- The LIVE decision is the Rust port: `rust-core/crates/agentlens-core/src/burn/agent_gate.rs:414`
  (`starts120 = f(state, "startsLast2min")`) and `:421` (`"COLD_RESUME_FANOUT"`); the route is
  `ui.rs:1732` (`POST /api/agent-gate`). Any fix must land in BOTH cores or the TS tests will
  describe a behaviour the deployed server does not have.
- `startsLast2min` is machine-wide by design (`agentGate.ts:90-92`, and the comment at `:331`
  keeps RUNAWAY's count machine-wide "to protect the machine's cache"). For COLD_RESUME that is
  the wrong scope in both directions: session A's launch does not warm session B's fan-out
  prefix, and B's launch does not warm A's. Session A is held for B's agent and vice versa.
- Forks are NOT exempt here, although the two sibling denies exempt them on measured grounds:
  `agentGate.ts:316-328` (THRASH_ACTIVE) and `:337-350` (RUNAWAY_FANOUT) — "a fork's first
  request reads the caller's LAST-WRITTEN entry warm (cache_read 380k–785k, cache_creation
  1–3k), so it multiplies nothing" (TRDD-DIZ289UQ, TRDD-3EZ6SJ2Z). The same measurement applies
  after a stall: a fork whose parent's entry is cold is already covered by FORK_STORM_FORMING
  (`:372`, `fork && fat && cold && ≥2`) — REFUTED by reading (STATE 04:51): that rule needs `fat`
  AND `≥2`, the cold-resume case fires at `≥1`.
- The gate's memory is the SERVER answering `localhost:3000`. On this machine at 23:00 that was
  pid 68584 — a `alcore serve` leaked by `setupVerb.test.ts` at 22:43 with a tmp data dir
  (TRDD-YGEV6QDD) — so the whole machine's StopFailure/SubagentStart history since 22:43 lives
  in a test fixture daemon. Not the cause of the rule's shape, but the reason the window and the
  count looked arbitrary to both sessions.

## Fix candidates (smallest first)

1. Exempt forks from COLD_RESUME_FANOUT exactly as `:344-350` does for RUNAWAY: `warn`, not
   `deny`, with the same "this fork reads the caller's entry" wording. Un-deadlocks the review
   gate on its own. Fresh agents stay denied for the window.
2. Scope `startsLast2min` for THIS rule to the caller's own session (`state.caller.session` vs
   `state.spawners[].session`, both already in the state) — the prefix the rule protects is
   per-fan-out, never machine-wide.
3. UNANSWERED: whether a DENIED launch still emits a SubagentStart that refreshes the 2-min
   count (the frozen "1 agent(s)" suggests something keeps it at exactly one). Measure before
   assuming; if true the rule is self-sustaining and (1) alone does not clear it for fresh agents.

## Acceptance

- [x] (`c3809f16`) A test in `src/test/` that fails on the current `agentGate.ts` (a fork under
      coldResume with startsLast2min ≥ 1 must not be denied) and the Rust twin — as a parity
      fixture case (`tests/agentgate_parity.rs` replays the TS oracle; `burn/agent_gate.rs` has no
      `#[cfg(test)]` block), red on both sides per the worker report.
- [x] (`c3809f16`) Both cores changed; `pnpm run check-types` + the scoped mocha + `cargo test -p
      agentlens-core --lib burn` green (8/8 unrelated burn tests; the coverage is the parity test, 1/1).
- [ ] BLOCKED on the owner's `go`/`no` (TRDD-81BW1CS9): alcore rebuilt, `codesign -s - --force`,
      deployed, and a fork launch measured allowed while a fresh-agent launch in the same window is
      still denied.
- [ ] The peer session tldr-code-7a notified with the commit SHA.

## Approval log

