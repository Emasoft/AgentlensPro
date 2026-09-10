---
trdd-id: VRW14OB0
title: The RUNAWAY_FANOUT fork exemption returns before FORK_STORM_FORMING is evaluated
column: backburner
created: 2026-09-10T04:51:30+0200
updated: 2026-09-10T05:19:23+0200
current-owner: main
task-type: spike
min-approval-requirement: none
priority: low
severity: low
blocked-by: []
npt: []
eht: []
implementation-commits: []
project-id: agentlenspro
scope: project
labels: [burn-gate, agent-gate, fork, fork-storm]
related: [0D6QK5CW, 3EZ6SJ2Z, DIZ289UQ]
---

# The RUNAWAY_FANOUT fork exemption returns before FORK_STORM_FORMING is evaluated

## Observation (VERIFIED by reading, 2026-09-10 04:45)

In both decision cores the order is THRASH → RUNAWAY → COLD_RESUME → FORK_STORM_FORMING
(`src/agentGate.ts:322/346/372/390`, `rust-core/…/burn/agent_gate.rs:385/406/432/451` at
`c3809f16`). The RUNAWAY block's fork exemption (`fork && !keepWarm` → `warn`) RETURNS, so while
RUNAWAY's start-count condition holds, FORK_STORM_FORMING (`fork && fat && cold && ≥2`) is never
reached: a fat+cold parent's fork storm during a runaway wave gets one `warn` per fork instead of
the deny that rule was written for. TRDD-0D6QK5CW's review found the same shadowing for the new
COLD_RESUME exemption and that one is being reordered; RUNAWAY's is pre-existing and was NOT
changed there (out of scope, and it rests on TRDD-3EZ6SJ2Z's measurement that a fork reads the
caller's entry warm).

## What would settle it

Whether a fork off a COLD parent during a runaway wave actually writes a full prefix (the
FORK_STORM premise) or reads warm (the RUNAWAY-exemption premise) — one measured pair from the
captured request bodies (`cache_read` vs `cache_creation` on the fork's first request with the
parent's entry past its TTL). The pair must be the FIRST fork after the parent went cold — a
sibling within 5 min reads the first fork's write and shows the warm shape under BOTH premises, so
it discriminates nothing. If it writes, move the FORK_STORM check before the RUNAWAY block as was
done for COLD_RESUME (`e53fef7a`, pinned by `e51ac1c8`); if it reads warm, FORK_STORM_FORMING's
`cold` predicate is the thing to revisit. No code change without that measurement.

## Approval log

