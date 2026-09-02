---
trdd-id: QE114936
title: Eighteen MCP tool handlers still rebuild the session summary under the state lock
column: todo
created: 2026-09-02T16:08:27+0200
updated: 2026-09-02T16:08:27+0200
current-owner: main-session
task-type: bugfix
priority: high
min-approval-requirement: none
created-by: UTFVMVT8
related: [UTFVMVT8, 2R36W8Q1, HFV4AIT7]
---

# Eighteen MCP tool handlers still rebuild the session summary under the state lock

## Why this card exists

TRDD-UTFVMVT8 measured the shape: a request path that calls `st.build_session_summary(now)` while
holding the core state lock pays the whole O(window) rebuild UNDER the lock on a cache miss —
12.6 s and 30.1 s per call on the live server (27.7k log sessions), during which every ingest
and read path queues (the log sweeper waited 273 s behind one such hold). UTFVMVT8 moved the three
MEASURED holders off the lock (`composition_for`, `compositions_in_scope`, the `check_cache_expiry`
tool) by reading the summary through `ui::summary_now` before taking the guard.

The same shape survives at eighteen more sites in `ui.rs`, all inside the MCP tool dispatch
(`grep -n 'st.build_session_summary(' rust-core/crates/agentlens-core/src/ui.rs`; at the
UTFVMVT8 fix commit: 599, 1630, 1854, 1978, 2006, 2052, 2086, 2121, 2144, 2197, 2216, 2277,
2859, 2998, 3049, 3103, 3158, 3334). None of them appeared as a `state lock held` holder in the
measured windows — they run only when an agent invokes that tool — but each one WILL hold the lock
for the full rebuild the first time it runs after a `data_version` bump, and `data_version` bumps
~6.7 times a second on this machine. `build_session_summary`'s own doc comment says every server
path that can run while ingest is hot must go through `summary_now`; these paths were written as
if the MCP surface "owned the state outright", which is true for the CLI but not for the tool
handlers inside the serving process.

`ui.rs:599` is `resolve_session_card`, called per candidate under a fresh guard from at least two
of those handlers (`check_cache_expiry`'s and the cache-break scan's `timeline_of` closures, each
under `st2.lock_timed()` inside `spawn_blocking`); it is included because the pattern is the same,
and by construction it can be the WORST of the eighteen: one rebuild under the lock PER CANDIDATE
whenever `data_version` moved since the previous candidate, which at ~6.7 bumps/s on this machine
would be nearly every candidate. That is a HYPOTHESIS from the bump rate: no `held` line at the
closure's site has appeared in any measured window (only the handler's own guard held), so
measure it first — invoke the tool while ingest is hot and read `server.log` for the closure's
site. UTFVMVT8 moved that handler's own guard off the lock and deliberately left this one here. Its caller structure (the card is re-stored via `put_log_session` when the
timeline is empty) needs the `&mut CoreState` and so needs a summary passed IN rather than
`summary_now` inline.

## Fix shape

Mechanical per site: `let (_, summary) = summary_now(&state, now)?;` (or `state` when it is
already a reference) BEFORE the `lock_timed()` guard; keep the guard only for what needs
`&mut CoreState`. Where a handler needs both the summary and mutable state, take the summary
first, then the guard. For `resolve_session_card`, add a `summary: &Value` parameter and thread
the off-lock summary through its callers.

## Acceptance

- [ ] `grep -c 'st.build_session_summary(' rust-core/crates/agentlens-core/src/ui.rs` is 0 outside
      tests; every former site reads the summary via `summary_now` before the guard.
- [ ] `cargo clippy -p agentlens-core --all-targets -- -D warnings` and `cargo test -p agentlens-core`
      green; the `tests/mcp_*` parity fixtures unchanged in output.
- [ ] After deploy, invoking each affected tool once (via `agentlenspro <tool>`) while ingest is
      hot produces no `state lock held ≥ 1000 ms by ui.rs:<that handler>` line.

## Notes and lessons learned

- Empty section on creation.
