---
trdd-id: XX1UAZHS
title: The burn-monitor route computes live_burn_status under the state lock and held it 4.9 s
column: complete
created: 2026-09-02T20:24:56+0200
updated: 2026-09-03T04:58:45+0200
current-owner: main-session
task-type: bugfix
priority: medium
min-approval-requirement: none
created-by: O3ICDRLO
related: [O3ICDRLO, HFV4AIT7, UTFVMVT8]
---

# The burn-monitor route computes live_burn_status under the state lock and held it 4.9 s

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-02T22:06:11+0200

- **Code: DONE, committed** in `rust-core/crates/agentlens-core/src/ui.rs` (+33/−5). New
  `burn_status_now(state, now)` beside `stripped_now`: `summary_now` off-lock → short hold for
  `ttl_context` + `config.clone()` → `crate::burn_status_for` released. All four route callers of
  `live_burn_status` (`GET /api/burn-status`, MCP `get_burn_status` — the 4,894 ms site —,
  `get_window_budget`, `get_account_status`) now compute first and hold only for
  `current_account` / `latest_resident_blobs` / `ttl_context`. Comments at every site cite this card.
- **Verified:** `cargo build --release -p agentlens-core` exit 0; `cargo clippy -p agentlens-core
  --all-targets -- -D warnings` exit 0; `cargo test -p agentlens-core --lib` 37 passed / 0 failed.
- **Acceptance box 1 PASS** (guard body is reads only, unambiguous).
- **Acceptance box 2 PASS** — 15-min post-deploy read, pid 67312, `server.log` lines 500995-501009:
  no `state lock held >= 1000 ms` anywhere, none at the guarded route sites, largest hold 319 ms at
  `log_reader.rs:1052` (unrelated card). `/api/burn-status` answered `200` in 1.03s and MCP
  `get_burn_status` succeeded mid-window. Caveat: window traffic was idle (`activeSessions:0`), so
  this is a low-traffic confirmation, not a load test — box 1's structural fix (compute moved off
  the lock) is what actually removes the bug class.
- **NEXT ACTION:** commit the diff (`perf(core): compute burn-status routes off the state lock
  (TRDD-XX1UAZHS)`), move to ai_review; optional follow-up (new card, not this one) — repeat the
  read under real dashboard load / an account-switch rotation edge to corroborate the idle-window
  result.
- **Gotchas:** `summary_now` can serve a one-rebuild-stale summary under sustained ingest (same
  trade as the tick). `live_session_status` and the `get_recent_sessions` family still rebuild
  under the lock — out of scope, candidate follow-up card. `burn_risk_report`'s boot-only
  `last_status` fill-in still uses `live_burn_status` (first ≤4 s after boot).
- **Report:** `reports/trdd-xx1uazhs/20260902_213516+0200-burn-monitor-off-lock.md`,
  `reports/trdd-xx1uazhs/20260902_220611+0200-15min-hold-read.md`.
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
- [x] After the fix, 15 min of `server.log` shows no `state lock held ≥ 1000 ms` at the route's
      guard under normal dashboard use, and `/api/burn-status` still answers with the same shape.
      — 2026-09-02T22:06:11+0200: pid 67312, lines 500995-501009, max hold 319 ms
      (log_reader.rs:1052, unrelated site), `/api/burn-status` 200 in 1.03s.

## Approval log

- 2026-09-03T04:58:45+0200 — COMPLETED by main-session. Both acceptance boxes pass; fix committed
  5abb5349 (verified via `git log --oneline -1 -- rust-core/crates/agentlens-core/src/ui.rs`, not
  the card's stale "uncommitted" claim — 2b38a39b is a later, unrelated commit on the same file).

## Notes and lessons learned

- Empty section on creation.
