---
trdd-id: 0D6QK5CW
title: The burn-gate cold-resume rule denies review forks machine-wide and deadlocks the review gate
column: dev
created: 2026-09-08T23:04:23+0200
updated: 2026-09-10T04:29:12+0200
current-owner: main
task-type: bugfix
min-approval-requirement: none
priority: critical
severity: high
blocked-by: []
npt: []
eht: []
implementation-commits: []
project-id: agentlenspro
scope: project
labels: [burn-gate, review-gate, agent-gate, cold-resume, fork, deadlock]
relevant-rules: []
---

# The burn-gate cold-resume rule denies review forks machine-wide and deadlocks the review gate

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-10 04:29

Pulled `todo` → `dev` at 04:29 by the janitor keep-going resume, after TRDD-2CYTNLY1 reached
`testing`; pulled by this session — the ownership note below is superseded by this pull. Delegated to one lean-worker (no git, Edit tool only, NO deploy) with
candidate 1 ONLY and these BRIEF AMENDMENTS from the adversarial review (binding): (i) the card's
"FORK_STORM_FORMING already covers a cold fork" line is an ASSUMPTION, not a measurement — the
worker records whether a first fork after a stall (`startsLast2min` < 2, or not `fat`) is exempt
from both rules after the change; (ii) before editing, read BOTH RUNAWAY fork-exemption branches
(TS `agentGate.ts:346`, Rust `agent_gate.rs:406`) and match their reason-code style and `warn`
shape in each core; (iii) answer candidate 3 by READING the code that feeds `startsLast2min`
(Rust `:697-716`, `:796`; the TS twin) — does a denied or warned launch still increment it — with
no behaviour change; (iv) the "fresh agent still denied" assertion needs a coldResume fixture
(StopFailure inside the window, no stallRecovered) — locate the file's helper or build the state
its existing cold-resume tests use; red-first for both new tests. Anchors (grep at pull): TS
COLD_RESUME deny `:355-363`, FORK_STORM `:372`; Rust COLD_RESUME `:415-426`, FORK_STORM `:433`.
Acceptance row 3 (alcore rebuild + `codesign` + deploy + live measurement) is BLOCKED on the
owner's explicit `go`/`no` for the alcore binary (TRDD-81BW1CS9); rows 1, 2 and 4 are not.
NEXT ACTION: worker report → verify both diffs first-hand → my own chain (tsc scratch + mocha
agentGate; check-types; eslint; `cargo test -p agentlens-core --lib burn`; clippy `-D warnings`)
→ commit by name → `testing` with row 3 marked blocked → notify tldr-code-7a with the SHA.

Filed from the main session at 23:04 while the USER's forked session works the review-hook
directive ("fix the damn adversarial review hook"); that session OWNS this card — the main
session will not edit `agentGate.ts` or `burn/agent_gate.rs`. Two peer sessions measured the
same deadlock within the same ten minutes (this one: 4 fork refusals 22:59–23:03; tldr-code-7a:
4 refusals, lean-worker ×2 + fork ×2, over ~4 min).
NEXT ACTION: implement the fork exemption in BOTH decision cores (the Rust one is the live
decision), add the test that fails on the current code, deploy alcore, then answer the
scoping question below on measured evidence.

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
  (`:372`, `fork && fat && cold && ≥2`).
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

- [ ] A test in `src/test/` that fails on the current `agentGate.ts` (a fork under coldResume with
      startsLast2min ≥ 1 must not be denied) and the Rust twin under `rust-core/.../burn/`.
- [ ] Both cores changed; `pnpm run check-types` + the scoped mocha + `cargo test -p agentlens-core
      --lib burn` green.
- [ ] alcore rebuilt, `codesign -s - --force`, deployed, and a fork launch measured allowed while a
      fresh-agent launch in the same window is still denied.
- [ ] The peer session tldr-code-7a notified with the commit SHA.

## Approval log

