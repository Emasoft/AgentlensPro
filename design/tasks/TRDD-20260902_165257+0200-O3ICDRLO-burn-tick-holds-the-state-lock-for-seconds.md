---
trdd-id: O3ICDRLO
title: The 4-second burn tick holds the state lock for up to 2.3 s and is now the top holder
column: testing
created: 2026-09-02T16:52:57+0200
updated: 2026-09-02T20:24:56+0200
current-owner: main-session
task-type: bugfix
priority: high
min-approval-requirement: none
created-by: UTFVMVT8
related: [UTFVMVT8, 2R36W8Q1, HFV4AIT7, N60JUWU3]
implementation-commits: [ec96d8af, 4b878fd7]
---

# The 4-second burn tick holds the state lock for up to 2.3 s and is now the top holder

## Measured (2026-09-02 16:36–16:51, pid 18695, the binary with TRDD-UTFVMVT8 deployed)

With the composition routes off the lock, the 15-min read shows 120 `state lock held` lines
≥ 250 ms; the burn tick's guard, `ui.rs:3698` on that binary (`run_burn_tick`, the 4 s interval),
is the worst holder by MAX (**2,263 ms**) and by TOTAL lock time (**34,555 ms** over 44 holds);
by COUNT the sweeper's `save_cards` (`log_reader.rs:1052`, 52 holds, max 1,648 ms, total
26,143 ms) edges it. The OTLP ingest handler waited 2,361 / 1,612 /
1,582 ms behind the burn tick and 1,663 ms behind the span flush tick. Before UTFVMVT8 the same
handler waited 145 s, so this is the residual, not the incident — but a 4 s tick that holds the
lock for 2.3 s means the lock is unavailable more than half the time at the worst, and every
ingest and read path pays it.

## What runs under that guard (read from the deployed source, not measured per statement)

`st.burn.bodies.poll(now)` (the bodies watcher poll — a stat of the parked-bodies dir),
`st.statusline.flush(None)` (the statusline WAL flush — a disk write under the state lock),
`st.burn_status_over(&tick_summary, now)` (gather consumption events over every session card plus
`compute_burn_status`), `st.burn.current_account(now)`, `st.burn.ttl_context(now)`,
`st.account_timeline.record(sample)`, and the rotation-edge string compare. The summary itself is
already read OFF the lock (`tick_summary` from `summary_now`, TRDD-HFV4AIT7). Which of these carries
the 2.3 s is NOT known; the two natural suspects are the WAL flush (an fsync under the lock) and
`gather_consumption_events` over 27.7k cards, and the UTFVMVT8 lesson applies: a source read is a
hypothesis, a per-statement split is the answer.

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-02

- **Box 1 MEASURED (pid 71093, commit ec96d8af, 17:08–19:56 = 2h49m, 41 split lines, each read
  by its OWN sum, never the adjacent `held` line):** `burn_status` = 25,812 of the guard's
  26,907 ms (96%), max 1,520 ms, 39 of 41 lines ≥ 250 ms; `statusline_flush` max 317 ms (one line
  ≥ 250, total 375); `bodies_poll` max 47 ms (total 358); `account_timeline` max 7 ms;
  `alerts_notify` max 37 ms. The 41 row sums reconcile with the guard's 41 `held` lines to within
  1–51 ms. The WAL-flush suspect is cleared: the gather + `compute_burn_status` behind
  `burn_status_over` was the whole hold.
- Same window, whole-server ranking by TOTAL lock time: the sweeper's `save_cards`
  (`log_reader.rs:1052`) 61,659 ms over 115 holds (max 5,442 ms) — now the top holder by every
  measure; this guard 26,907 ms (41); the rebuilder's `ui.rs:212` 15,067 ms (13, max 8,690 ms).
  `save_cards` is outside this card's scope and needs its own.
- **Box 2 FIX DEPLOYED 20:12:17 as pid 54270 (commit 4b878fd7; build 0 / clippy 0 / lib tests
  37/37; fresh inode, `codesign -v`; the new split line `lock_a … off_lock burn_status … lock_b`
  is in the shipped binary). Graceful stop of 71093 in 15 s.** Boot marker: `server.log` line
  500237. Shape: hold A = bodies poll + WAL flush + `ttl_context`/`config` snapshot; the status is
  computed OFF the lock by the new pure `burn_status_for` (lib.rs, split out of
  `burn_status_over`); hold B = store `last_status`, account/timeline sample, rotation edge,
  frames. `ttl_context` is re-read in hold B after the store, matching the TS order. One
  deliberate drift (review fork, 20:16): `now` is taken BEFORE hold A's lock wait, so under
  contention the stored status is older by that wait — harmless for a ≤4 s-stale status, and
  the wait is what the fix shrinks. Running binary confirmed by `ps -o command= -p 54270`
  (`bin-native/darwin-arm64/alcore serve`), not by the pidfile.
- Box 3 partial: `agentlenspro get_burn_status` answers on pid 54270 (20:12:51). The rotation
  edge has not been exercised since the deploy; it is verified only when the next account switch
  logs `usage refresh (account changed)` exactly once.
- **Box 2 MEASURED on pid 54270, 20:12:17–20:24:56 (12.6 min, no `cargo`/`pnpm` in flight):**
  the burn tick's two guards (`ui.rs:3707` hold A, `ui.rs:3728` hold B on the deployed source)
  produced ZERO `held` lines ≥ 250 ms and ZERO split lines; the previous binary logged 41 holds
  ≥ 250 ms (max 1,520 ms) and the one before it 44 in 15 min. No ingest-path `waited` line was
  logged at all. The three waits in the window (4,697 ms at `save_cards`, 2,860 ms at the
  rebuilder, 261 ms at `handle`) sat behind ONE 4,894 ms hold at `ui.rs:1833` — the
  burn-monitor ROUTE computing `live_burn_status` under the lock, the tick's twin — carded as
  TRDD-XX1UAZHS, outside this card. `→ testing`.
- **NEXT ACTION:** box 3's rotation edge — on the next account switch, `server.log` must show
  `usage refresh (account changed)` exactly once and `agentlenspro get_burn_status` must still
  answer; then `→ ai_review`. If a `lock_b` split is ever large, the suspect is
  `enrich_burn_status` + the frame `to_string`, not `mac_notify` (`spawn()` + detached waiter).

## Fix shape

1. Per-statement `Instant` splits inside the guard, printed at the `lock_timed` threshold beside
   the `held` line (the UTFVMVT8 box-1 pattern), deployed, 15 min read.
2. Move the statement the numbers name off the lock: a WAL flush needs the statusline store, not
   `CoreState` — take a handle out and flush after release; a gather over cards can run on the
   `Arc<Value>` summary the tick already holds off-lock, with only `last_status` stored under it.

## Acceptance

- [x] The split names the dominant statement from 15 min of `server.log`, not from reading —
      `burn_status`, 96% of the guard's lock time over 2h49m (STATE, box 1).
- [x] After the fix, 15 min of `server.log` shows no `state lock held ≥ 1000 ms` by the burn tick's
      guard, and the OTLP handler's worst wait is under 1 s — 12.6 min read, zero holds ≥ 250 ms
      from either guard, no ingest wait logged (STATE, box 2).
- [ ] `/api/burn-status`, the burn risk gate and the account-rotation capture still behave
      (the rotation edge is still detected once per switch; `agentlenspro get_burn_status` answers).

## Notes and lessons learned

- Empty section on creation.
