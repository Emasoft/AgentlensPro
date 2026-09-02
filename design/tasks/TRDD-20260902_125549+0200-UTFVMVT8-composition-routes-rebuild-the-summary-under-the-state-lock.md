---
trdd-id: UTFVMVT8
title: The composition routes hold the state lock for seconds at ui.rs:560 and the dominant statement is not yet isolated
column: dev
created: 2026-09-02T12:55:49+0200
updated: 2026-09-02T15:58:24+0200
current-owner: main-session
task-type: bugfix
priority: high
min-approval-requirement: none
parent-trdd: 2R36W8Q1
related: [2R36W8Q1, 768NEX6E, L6V1UUW0]
---

# The composition routes hold the state lock for seconds at ui.rs:560 and the dominant statement is not yet isolated

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-02

- **Measured by the lock attribution TRDD-2R36W8Q1 landed (15 min after the 12:52 deploy, pid 26060,
  under the sessions already running — no soak):** 33 `state lock held` lines; the top twelve are ALL
  `ui.rs:560` — **74,709 ms, 34,793, 27,155, 17,944, 15,620, 14,919, 13,719, 13,362, 6,853, 5,512,
  5,336, 5,253 ms** — then `ui.rs:534` at 3,936 ms. 84 waiters queued behind them: the log sweeper
  for 72,944 ms (`log_reader.rs:1052`), the OTLP ingest handler 8,842 ms (`lib.rs:918`), the span
  flush tick 8,842 ms (`chores.rs:561`), the summary rebuild task 8,768 ms (`ui.rs:212`), the
  data-version poller 8,871 ms (`ui.rs:3787`). Three bodies passes in the same window ran 55–141 s
  instead of 14–23 s (TRDD-768NEX6E) — CPU contention from the same holds is INFERRED from
  co-occurrence, not measured. A read path and a write path stalling together on ONE holder is
  exactly the shape 2R36W8Q1's STATE predicted.
- **Still holding on the redeployed pid 53886 alone (log from its boot marker, `server.log` line
  497616, 1h14m to 14:28):** 104 `held` lines, **82 at `ui.rs:560`** — 16 of them ≥ 10 s (10.9, 11.0,
  13.6, 15.2, 18.5, 19.9, 20.9, 23.0, 26.1, 31.3, 31.6, 33.5, 54.1, 55.9, 62.2 and **273.9 s**) and a
  floor of 2.2–3.0 s on most of the rest. Behind the 274 s hold a reader at `ui.rs:265` waited
  273,887 ms and the log sweeper 29,555 ms. The log carries no timestamps, so the partition is by
  boot marker, not by time.
- **A SECOND multi-second holder, `ui.rs:3200` (read 15:50, all 29 non-560 holds on the pid listed,
  not a `head` preview — review-fork finding):** 2,261 / 3,756 / 6,219 / **10,175 ms**. It is the
  last-request resolver's guard, which runs `st.build_session_summary(now)` under the lock and then
  deep-clones EVERY session card (`summary.get("sessions")…cloned()`) before releasing — the same
  shape as 560 minus the scope resolution, so it is a second acceptance target here, not a new
  card. Every other site on the pid is ≤ 1,250 ms (`log_reader.rs:1052` once; the rest < 1 s).
  `chores.rs:653` (the hook-spool drain tick) has NO `held` line at all: the 26,280 ms wait at
  `ui.rs:265` that named it as holder "for 0 ms when we queued" was queued the instant 653 acquired,
  653 released under the 250 ms threshold, and the wait was served behind whoever acquired next —
  the holder slot names the holder AT QUEUE TIME, not the site the waiter actually waited behind.
- **Box 1 instrumentation DEPLOYED 16:03:43 as pid 6978 (built, clippy-clean, lib tests 37/37,
  symbol verified in the shipped binary):** `compositions_in_scope` times its three statements and
  prints `alcore: compositions_in_scope guard split: project_map N ms, session_ids N ms (K ids),
  resolve_scope N ms` whenever the guard's total reaches `AGENTLENS_LOCK_TRACE_MS` (250) — the same
  threshold as the `held` line it sits next to. Read 15 min of `server.log` from that pid's boot
  marker (line 498622).
- **The holder SITE is proven; the dominant CALL is NOT (review-fork finding, settled by reading
  2026-09-02 14:25).** `ui.rs:560` is `compositions_in_scope`'s lock and `ui.rs:534` is
  `composition_for`'s. A `held` line names the guard, not what ran under it, and the 560 guard runs
  THREE statements: (1) `st.composition_project_map(now)` (`lib.rs:470`), whose first line is
  `self.build_session_summary(now_ms)` — which SHORT-CIRCUITS through `summary_cache.get(data_version,
  …)` (`derived_cache.rs:26`) whenever the version matches. How often THIS caller matches is NOT
  resolved by the live counters: `/api/debug/log-scan-stats` at 14:24 read summary hits 76,902 /
  misses 608 on pid 53886, but `current()` and `cached_any()` — the off-lock `rebuild_once` path —
  count hits and `store_if_newer()` counts misses too (`derived_cache.rs`), so the only bound is
  that inline `get()` rebuilds under this guard numbered ≤ 608 in 74 min, which still allows EVERY
  composition call to have missed (`data_version` bumped 29,632 times on this pid); (2) `st.bodies.session_ids()`
  collected into a `Vec<String>`; (3) `resolve_scope` over EVERY id with a per-id project closure.
  Those ids are the BODIES index (`st.bodies`), whose size has not been read — not the 27,689 log
  sessions `server status` reports, a different set. Which of the three carries the steady 2.3 s holds and the
  274 s outlier is unmeasured: a cache miss inside (1) is the natural suspect for the outliers and
  (2)+(3) for the steady holds, but that is inference — the earlier "built, discarded, and rebuilt
  on the next request" sentence overstated (1) and is retracted.
- **NEXT ACTION:** deploy the split build (fresh-inode rm+cp, `codesign -v`, `agentlenspro server
  restart`) and read 15 min of `server.log` for `guard split:` lines. Then fix the statement the numbers name: if (1) on a
  miss → derive the project map WITHOUT the full summary build (the two fields it reads, `projectPath`
  and `workspace`, are on the cached summary already — `summary_cache.current(version)` as in
  `rebuild_once`, `ui.rs:190`; build OFF the lock via `summary_snapshot` + `CoreState::summary_from`
  when stale); if (2)/(3) → collect the ids and resolve the scope off the lock, or index them.
  Acceptance either way is the disappearance of `state lock held … ui.rs:5xx` lines.

## Acceptance

- [ ] Per-statement timing inside `compositions_in_scope`'s guard (`ui.rs:560`) — map / ids /
      resolve_scope — is logged on every traced hold, deployed, and 15 min of `server.log` names the
      dominant statement from numbers, not from source reading.
- [ ] `composition_project_map` (or its callers) no longer calls `build_session_summary` under the
      state lock; the map comes from the summary cache or an off-lock build — IF box 1 names (1);
      otherwise the named statement is what moves off the lock.
- [ ] After deploy, 15 min of `server.log` under normal load shows no `state lock held ≥ 1000 ms
      by ui.rs:<composition_for | compositions_in_scope>` line — and none by the last-request
      resolver's guard (`ui.rs:3200` today), the second holder of the same shape.
- [ ] `/api/context-compositions` (scoped and single-session) still fills `project` — the P4x.2c
      parity note on `composition_project_map` explains why a wrong map answers 200 with nothing.

## Notes and lessons learned

- Empty section on creation.
