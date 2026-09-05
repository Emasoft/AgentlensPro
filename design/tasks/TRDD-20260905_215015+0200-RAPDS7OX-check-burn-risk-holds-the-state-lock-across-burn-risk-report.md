---
trdd-id: RAPDS7OX
title: check_burn_risk holds the state lock for over a second across burn_risk_report
column: todo
created: 2026-09-05T21:50:15+0200
updated: 2026-09-05T21:50:15+0200
current-owner: main-session
task-type: bugfix
priority: medium
min-approval-requirement: none
scope: project
project-id: agentlenspro
created-by: MVR6PXC0
related: [MVR6PXC0, QE114936, UTFVMVT8]
relevant-files: [rust-core/crates/agentlens-core/src/ui.rs]
labels: [rust-core, lock-scope, ingest-stall]
---

# check_burn_risk holds the state lock for over a second across burn_risk_report

Found by TRDD-MVR6PXC0's acceptance run
(`reports/mvr6pxc0/20260905_214926+0200-acceptance-24-invocations.md`, pid 574, build `3b9018e0`):
over 24 read-only tool invocations the ONLY `state lock held ≥ 1000 ms` line in the window was

```
alcore: state lock held 1440 ms by crates/agentlens-core/src/ui.rs:3507
```

`ui.rs:3507` at that commit is the `state.lock_timed()` inside the `"check_burn_risk"` MCP arm:
`burn_status_seed(&state, now)?` runs off the lock (QE114936 site 20), then the guard is taken and
`st.burn_risk_report(now, seed, fanoutThreshold, spikeTokensPerMin)` runs under it, then `drop(st)`.
So 1.4 s of that call is inside `burn_risk_report` itself. The state mutex is the ingest path's
mutex: every session posting to this server stalled for those 1.4 s (the same class of defect as
QE114936 / UTFVMVT8 / MVR6PXC0, one site further along).

Not established yet: which statement inside `burn_risk_report` is slow (a summary walk? the seismic
model? a per-session timeline scan?), whether it needs `&mut CoreState` at all or only a snapshot,
and whether the 1440 ms reproduces or was a one-off under the acceptance run's load (load-avg ~15,
two other test runs live).

## NEXT ACTION

Read `burn_risk_report` (`lib.rs` or wherever it lives — `grep -n 'fn burn_risk_report'`), list what
it touches under the guard, and time its statements the way UTFVMVT8 did for `ui.rs:560`. If the
heavy part needs only a snapshot, apply the snapshot-then-work split; the acceptance is the same
24-invocation recipe showing no `≥ 1000 ms by ui.rs:<check_burn_risk arm>` line.

## Acceptance

- [ ] The dominant statement under the guard in `burn_risk_report` is named with a measured time.
- [ ] `check_burn_risk` takes the state lock only for map reads / a snapshot; the heavy work runs
      off the lock, or the card records why it cannot.
- [ ] Same 24-invocation recipe: zero `state lock held ≥ 1000 ms by ui.rs:<check_burn_risk arm>`
      lines.

## Notes and lessons learned

## Approval log

- 2026-09-05T21:50:15+0200 — Authored into `todo` (Tier 0 bugfix, own scope) from a measured line in
  a sibling card's acceptance run rather than left as a footnote there.
