---
trdd-id: O3ICDRLO
title: The 4-second burn tick holds the state lock for up to 2.3 s and is now the top holder
column: todo
created: 2026-09-02T16:52:57+0200
updated: 2026-09-02T16:52:57+0200
current-owner: main-session
task-type: bugfix
priority: high
min-approval-requirement: none
created-by: UTFVMVT8
related: [UTFVMVT8, 2R36W8Q1, HFV4AIT7, N60JUWU3]
---

# The 4-second burn tick holds the state lock for up to 2.3 s and is now the top holder

## Measured (2026-09-02 16:36–16:51, pid 18695, the binary with TRDD-UTFVMVT8 deployed)

With the composition routes off the lock, the 15-min read shows 120 `state lock held` lines
≥ 250 ms; the top site is the burn tick's guard, `ui.rs:3698` on that binary (`run_burn_tick`,
the 4 s interval): **44 holds, max 2,263 ms**, then the sweeper's `save_cards`
(`log_reader.rs:1052`, 52 holds, max 1,648 ms). The OTLP ingest handler waited 2,361 / 1,612 /
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

## Fix shape

1. Per-statement `Instant` splits inside the guard, printed at the `lock_timed` threshold beside
   the `held` line (the UTFVMVT8 box-1 pattern), deployed, 15 min read.
2. Move the statement the numbers name off the lock: a WAL flush needs the statusline store, not
   `CoreState` — take a handle out and flush after release; a gather over cards can run on the
   `Arc<Value>` summary the tick already holds off-lock, with only `last_status` stored under it.

## Acceptance

- [ ] The split names the dominant statement from 15 min of `server.log`, not from reading.
- [ ] After the fix, 15 min of `server.log` shows no `state lock held ≥ 1000 ms` by the burn tick's
      guard, and the OTLP handler's worst wait is under 1 s.
- [ ] `/api/burn-status`, the burn risk gate and the account-rotation capture still behave
      (the rotation edge is still detected once per switch; `agentlenspro get_burn_status` answers).

## Notes and lessons learned

- Empty section on creation.
