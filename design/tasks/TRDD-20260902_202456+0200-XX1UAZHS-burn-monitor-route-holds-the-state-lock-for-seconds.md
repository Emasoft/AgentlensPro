---
trdd-id: XX1UAZHS
title: The burn-monitor route computes live_burn_status under the state lock and held it 4.9 s
column: todo
created: 2026-09-02T20:24:56+0200
updated: 2026-09-02T20:24:56+0200
current-owner: main-session
task-type: bugfix
priority: medium
min-approval-requirement: none
created-by: O3ICDRLO
related: [O3ICDRLO, HFV4AIT7, UTFVMVT8]
---

# The burn-monitor route computes live_burn_status under the state lock and held it 4.9 s

## Measured (2026-09-02 20:12–20:25, pid 54270, the binary with TRDD-O3ICDRLO deployed)

With the 4 s burn tick off the lock, the worst hold in the first 12.6 min was a single
**4,894 ms** at `ui.rs:1833` — the `state.lock_timed()` inside `handle` just below the
"Burn monitor unavailable in this runtime" comment, i.e. the burn-monitor request route. The
sweeper's `save_cards` waited 4,697 ms and the rebuilder 2,860 ms behind it. One hit in the
window, so this is a request-shaped spike, not a floor — but it is the tick's twin: the route
calls `live_burn_status`, which is `build_session_summary` (a whole-window rebuild) PLUS the
gather + `compute_burn_status`, all under the lock (`lib.rs`, `live_burn_status`).

## Fix shape

Do what TRDD-O3ICDRLO did for the tick: take the summary from `summary_now` (off-lock,
cache-served), snapshot `ttl_context` + `config` under a short hold, compute with
`crate::burn_status_for` released, and hold again only for whatever the route stores. Check
`live_session_status` (same shape, one session) and `burn_risk_report`'s `last_status` fill-in
for the same pattern while there.

## Acceptance

- [ ] The route's guard names the statement (one split read, or the source is unambiguous
      because the whole body is the known-pure compute).
- [ ] After the fix, 15 min of `server.log` shows no `state lock held ≥ 1000 ms` at the route's
      guard under normal dashboard use, and `/api/burn-status` still answers with the same shape.

## Notes and lessons learned

- Empty section on creation.
