---
trdd-id: 0D6QK5CW
title: The burn-gate cold-resume rule denies review forks machine-wide and deadlocks the review gate
column: blocked
pre-block-column: testing
created: 2026-09-08T23:04:23+0200
updated: 2026-09-10T09:17:37+0200
current-owner: main
task-type: bugfix
min-approval-requirement: none
priority: critical
severity: high
blocked-by: [81BW1CS9]
unblock-when: [trdd:81BW1CS9 terminal]
npt: []
eht: []
implementation-commits: [c3809f16, e53fef7a, e51ac1c8]
project-id: agentlenspro
scope: project
labels: [burn-gate, review-gate, agent-gate, cold-resume, fork, deadlock]
relevant-rules: []
---

# The burn-gate cold-resume rule denies review forks machine-wide and deadlocks the review gate

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-10 09:17

Pulled `todo` → `dev` at 04:29 by the janitor keep-going resume (this session owns the card; the
ownership note below is superseded). LANDED in three commits, each reviewed by an adversarial
fork after the write; the first two each preceded by a lean-worker with a reviewed brief, the third
(`e51ac1c8`) authored by this session itself:
- `c3809f16` — candidate 1: both cores exempt a fork from COLD_RESUME_FANOUT with `warn` (same
  code, `fork && !keepWarm`, the RUNAWAY exemption's wording); the deny text unchanged (the golden's
  deny entry is an unchanged context line); the parity fixture gained the case and the golden was
  regenerated (worker report `reports/review-gate/20260910_044030+0200-0D6QK5CW-worker.md`).
- `e53fef7a` — from that commit's review: the exemption returned before FORK_STORM_FORMING, so for
  the whole window a fat+cold parent's 2nd+ fork was warned instead of denied; the FORK_STORM block
  now sits after RUNAWAY and before COLD_RESUME in both cores, bodies byte-identical. Storm test red
  on the old order (`'warn' !== 'deny'`); the keep-warm carve-out pinned (red only with
  `&& !keepWarm` removed — a carve-out pin, NOT evidence for the reorder); parity red on exactly the
  storm case before the Rust move (worker report `…/20260910_051328+0200-0D6QK5CW-worker3.md`).
- `e51ac1c8` — from THAT commit's review: two regression pins — the first fork after a stall on a
  fat cold parent (count 1) still passes, and FORK_STORM stays after RUNAWAY (a fat cold fork at
  runaway counts keeps the RUNAWAY warn). Both pass on either block order by design; they guard
  against `&& !cold`, a `>= 1` threshold, and a further move up.
Verified first-hand at each step: branch order in both cores; `startsLast2min` fed only by
`SubagentStart` events (`agent_gate.rs:723-728`, the sole write site; the TS core has no feeder) —
candidate 3 answered: a DENIED launch does not increment it, a warned one does; my own regeneration
of the golden byte-identical to the worker's for the two worker commits (`cmp` 0; 61, 63, 65 cases
after each of the three commits); check-types /
eslint 0; scoped mocha 54 → 56 → 58 passing (`--no-config` — `.mocharc.cjs` otherwise runs the
whole suite: 2753 passing, the 5 failures being TRDD-CS2W7E77's calibration tests); parity 1/1;
cargo lib 8/8 (unrelated burn tests; the coverage is the parity test); `--workspace` clippy 0 once
TRDD-QJPUG1WP's fix landed (it was the only failure).
The review of `e53fef7a` asked whether the reorder re-deadlocks the review gate on a fat parent
(2nd fork within 2 min → FORK_STORM). REJECTED by reading: `parent.idleMs` is now − mtime of the
caller's TRANSCRIPT (`agentGate.ts:217`, `agent_gate.rs:241`); a Stop-time review fork is spawned by
an active turn that has just appended to that transcript, so the parent is never `cold` at review
time and FORK_STORM_FORMING cannot fire on it. Also rejected: the `&& !cold` variant (it denies the
first fork of a parent that idled past its TTL through the stall); the base-string refactor stays
(byte-neutral, removes a duplicated message); "USER-ordered advisory wording" is the file's own
phrasing (`agentGate.ts:256`, `:320`, `:343`). The "FORK_STORM_FORMING already covers a cold fork"
line (§Where, last bullet) is REFUTED by reading: that rule needs `fat` AND `≥2`, the cold-resume
case fires at `≥1`. RUNAWAY's identical shadowing of FORK_STORM is pre-existing: TRDD-VRW14OB0.
Row 3 is BLOCKED on the owner's `go`/`no` for the alcore binary (TRDD-81BW1CS9) — the LIVE gate
keeps the old decision until then, so the column is `blocked` (pre-block `testing`;
`unblock-when: [trdd:81BW1CS9 terminal]` lets trdd-drift restore it when the decision card
closes). Row 3 cannot be measured on demand: the cold-resume window opens only on a REAL
StopFailure, and injecting one would deny fresh agents machine-wide for the 10-min window — the
proof is opportunistic, at the next natural stall, read from the launching session's hook output;
"deploy" means the process answering :3000 replaced per the a/b of 81BW1CS9 (at filing that was a
leaked test daemon, so a copy + restart can leave the old decision live). Row 4 CLOSED BY
SUBSTITUTE: the peer tldr-code-7a was not among the six listed peer sessions at 05:14, and peer
names rotate (the 09:1x listing carries tldr-code-73, not 7a — no prefix-match send); this card
carries the SHAs.
NEXT ACTION: on the owner's answer to TRDD-81BW1CS9 — `go`: rebuild alcore, `codesign -s - --force`
(the `-` is the ad-hoc identity; without it macOS SIGKILLs the binary, exit 137), deploy per the
a/b, restore `testing`, then → `ai_review` with row 3 open until its opportunistic observation;
`no`: row 3 stays open and the card goes to `ai_review` on the TS/Rust evidence alone. Nothing
else is open on this card.

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
      coldResume with startsLast2min ≥ 1 must not be denied BY COLD_RESUME_FANOUT — the
      FORK_STORM_FORMING deny still applies at ≥ 2 on a fat cold parent, `e53fef7a`) and the Rust
      twin — as a parity fixture case (`tests/agentgate_parity.rs` replays the TS oracle;
      `burn/agent_gate.rs` has no `#[cfg(test)]` block), red on both sides per the worker report.
- [x] (`c3809f16`, `e53fef7a`, `e51ac1c8`) Both cores changed; `pnpm run check-types` + the scoped
      mocha + `cargo test -p agentlens-core --lib burn` green (8/8 unrelated burn tests; the
      coverage is the parity test, 1/1 over 65 cases).
- [ ] BLOCKED on the owner's `go`/`no` (TRDD-81BW1CS9): alcore rebuilt, `codesign -s - --force`,
      deployed as the process answering :3000 (the a/b of 81BW1CS9), and — opportunistically, at
      the next REAL StopFailure, since the cold-resume window cannot be opened on demand without
      denying fresh agents machine-wide — a fork launch observed allowed while a fresh-agent
      launch in the same window is still denied.
- [x] CLOSED BY SUBSTITUTE (05:14, reviewed 09:17): the peer session tldr-code-7a was not among
      the listed peer sessions and peer names rotate (no prefix-match send); the SHAs live in this
      card's frontmatter, which is the durable delivery.

## Approval log

