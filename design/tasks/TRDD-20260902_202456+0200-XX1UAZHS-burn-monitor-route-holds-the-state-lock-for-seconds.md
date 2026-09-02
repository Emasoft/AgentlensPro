---
trdd-id: XX1UAZHS
title: The burn-monitor route computes live_burn_status under the state lock and held it 4.9 s
column: dev
created: 2026-09-02T20:24:56+0200
updated: 2026-09-02T21:35:16+0200
current-owner: main-session
task-type: bugfix
priority: medium
min-approval-requirement: none
created-by: O3ICDRLO
related: [O3ICDRLO, HFV4AIT7, UTFVMVT8]
---

# The burn-monitor route computes live_burn_status under the state lock and held it 4.9 s

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-02T21:35:16+0200

- **Code: DONE, uncommitted** in `rust-core/crates/agentlens-core/src/ui.rs` (+33/−5). New
  `burn_status_now(state, now)` beside `stripped_now`: `summary_now` off-lock → short hold for
  `ttl_context` + `config.clone()` → `crate::burn_status_for` released. All four route callers of
  `live_burn_status` (`GET /api/burn-status`, MCP `get_burn_status` — the 4,894 ms site —,
  `get_window_budget`, `get_account_status`) now compute first and hold only for
  `current_account` / `latest_resident_blobs` / `ttl_context`. Comments at every site cite this card.
- **Verified:** `cargo build --release -p agentlens-core` exit 0; `cargo clippy -p agentlens-core
  --all-targets -- -D warnings` exit 0; `cargo test -p agentlens-core --lib` 37 passed / 0 failed.
- **Acceptance box 1** satisfied (guard body is reads only, unambiguous). **Box 2 not yet** — needs
  a deploy and a 15-min read.
- **NEXT ACTION:** review the diff, commit (`perf(core): compute burn-status routes off the state
  lock (TRDD-XX1UAZHS)`), then deploy — `node esbuild.js` is NOT needed (Rust): rebuild the alcore
  binary + `agentlenspro server restart`, then a 15-min `server.log` read for
  `state lock held ≥ 1000 ms` at the route guards under normal dashboard use, and confirm
  `/api/burn-status` still answers with the same shape.
- **Gotchas:** `summary_now` can serve a one-rebuild-stale summary under sustained ingest (same
  trade as the tick). `live_session_status` and the `get_recent_sessions` family still rebuild
  under the lock — out of scope, candidate follow-up card. `burn_risk_report`'s boot-only
  `last_status` fill-in still uses `live_burn_status` (first ≤4 s after boot).
- **Report:** `reports/trdd-xx1uazhs/20260902_213516+0200-burn-monitor-off-lock.md`.
- **SUPERSEDED — do NOT carry forward:** nothing yet.

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

- [x] The route's guard names the statement (one split read, or the source is unambiguous
      because the whole body is the known-pure compute). — 2026-09-02: the compute moved to
      `burn_status_now` (off-lock); each guard body is now only the account/blobs/ttl reads.
- [ ] After the fix, 15 min of `server.log` shows no `state lock held ≥ 1000 ms` at the route's
      guard under normal dashboard use, and `/api/burn-status` still answers with the same shape.

## Notes and lessons learned

- Empty section on creation.
