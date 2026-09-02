---
trdd-id: UTFVMVT8
title: The composition routes rebuild the whole session summary under the state lock, holding it for 4-7 s
column: backburner
created: 2026-09-02T12:55:49+0200
updated: 2026-09-02T12:55:49+0200
current-owner: main-session
task-type: bugfix
priority: high
min-approval-requirement: none
parent-trdd: 2R36W8Q1
related: [2R36W8Q1, 768NEX6E, L6V1UUW0]
---

# The composition routes rebuild the whole session summary under the state lock, holding it for 4-7 s

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-02

- **Measured by the lock attribution TRDD-2R36W8Q1 landed (15 min after the 12:52 deploy, pid 26060,
  under the sessions already running — no soak):** 33 `state lock held` lines; the top twelve are ALL
  `ui.rs:560` — **74,709 ms, 34,793, 27,155, 17,944, 15,620, 14,919, 13,719, 13,362, 6,853, 5,512,
  5,336, 5,253 ms** — then `ui.rs:534` at 3,936 ms. 84 waiters queued behind them: the log sweeper
  for 72,944 ms (`log_reader.rs:1052`), the OTLP ingest handler 8,842 ms (`lib.rs:918`), the span
  flush tick 8,842 ms (`chores.rs:561`), the summary rebuild task 8,768 ms (`ui.rs:212`), the
  data-version poller 8,871 ms (`ui.rs:3787`). Three bodies passes in the same window ran 55–141 s
  instead of 14–23 s (TRDD-768NEX6E) — CPU contention from the same rebuilds. A read path and a
  write path stalling together on ONE holder is exactly the shape 2R36W8Q1's STATE predicted.
- **The holder:** `ui.rs:560` is `compositions_in_scope`'s lock and `ui.rs:534` is
  `composition_for`'s; both call `st.composition_project_map(now)` while holding the guard, and
  `composition_project_map` (`lib.rs:470`) begins with `self.build_session_summary(now_ms)` — the
  full O(window) summary build — to derive a `sessionId → projectPath ?? workspace ?? "unknown"`
  map. The summary is built, discarded, and rebuilt on the next request.
- **NEXT ACTION:** derive the project map WITHOUT the full summary build — the two fields it reads
  (`projectPath`, `workspace`) exist on the session cards / the summary cache already
  (`summary_cache.current(version)` in `rebuild_once`, `ui.rs:190`); read the cached summary when
  its version matches, else build it OFF the lock (`summary_snapshot` + `CoreState::summary_from`,
  the same split `rebuild_once` uses) and take the lock only to read the map. Then re-read
  `server.log` for `state lock held … ui.rs:5xx` lines: the acceptance is their disappearance.

## Acceptance

- [ ] `composition_project_map` (or its callers) no longer calls `build_session_summary` under the
      state lock; the map comes from the summary cache or an off-lock build.
- [ ] After deploy, 15 min of `server.log` under normal load shows no `state lock held ≥ 1000 ms
      by ui.rs:<composition_for | compositions_in_scope>` line.
- [ ] `/api/context-compositions` (scoped and single-session) still fills `project` — the P4x.2c
      parity note on `composition_project_map` explains why a wrong map answers 200 with nothing.

## Notes and lessons learned

- Empty section on creation.
