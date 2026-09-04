---
trdd-id: QE114936
title: Twenty MCP tool handlers still rebuild the session summary under the state lock
column: dev
created: 2026-09-02T16:08:27+0200
updated: 2026-09-03T10:05:23+0200
current-owner: main-session
task-type: bugfix
priority: high
min-approval-requirement: none
created-by: UTFVMVT8
related: [UTFVMVT8, 2R36W8Q1, HFV4AIT7]
---

# Twenty MCP tool handlers still rebuild the session summary under the state lock

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-03T10:05:23+0200

**ALL 20 SITES ARE DONE IN CODE (the card was written for 18; two more were found).
Nothing since site 1 is committed or deployed.**

- **Site 1** (`resolve_session_card` takes `summary: &Value` in) — committed **2b38a39b**, deployed
  as pid 2074 (acaf82e8), **15-min hold read PASS** (max `ui.rs` hold 506 ms, 0 holds ≥1000 ms;
  `reports/deploy/20260903_053800+0200-deploy-420e6bb9-step0.md`).
- **Sites 2–18** (the 17 direct `st.build_session_summary(` sites) — DONE, uncommitted. Report:
  `reports/trdd-qe114936/20260903_090717+0200-sites-2-18.md` (per-site table, advisor verdict,
  gate outputs).
- **Site 19, NEW — found by the advisor, verified first-hand**: `get_session_status` (ui.rs:1880)
  called `st.live_session_status(...)`, which rebuilt the summary at `lib.rs:465` **one call deep**,
  under the caller's guard — invisible to this card's own grep. Renamed
  `CoreState::session_status_over(&mut self, summary: &Value, …)` (the `burn_status_over`
  convention: the name says it does not build); its ONE caller reads `summary_now` off the lock.
- **Site 20, NEW — found in the second review round, verified first-hand**: `/api/burn-risk`
  (ui.rs:1494) and `check_burn_risk` (ui.rs:3363) call `st.burn_risk_report(...)` under a guard;
  that reached `live_burn_status` → `build_session_summary` (`lib.rs:498`) whenever
  `burn.last_status` was unset — i.e. every such request in the first ≤4 s after a restart.
  `burn_risk_report` now takes `status_when_unset: Option<Value>`; both callers get it from the new
  `ui::burn_status_seed`, which peeks `last_status` under a one-`is_none()` hold and computes
  `burn_status_now` OFF the lock only when it is genuinely missing.

`grep -c 'build_session_summary(' rust-core/crates/agentlens-core/src/ui.rs` → **0**, and that
acceptance criterion is now EXECUTABLE — but read the next paragraph before trusting it.

**THE MAIN LESSON OF THIS PASS.** The first version of the guard test carried ONE needle
(`build_session_summary`) and PASSED while two live routes still held the state lock through a
whole-window rebuild two method hops down. A guard that only sees the spelling it was written for
is worse than no guard, because it certifies the file clean. There are now THREE tests dividing
the crate with no gap:

1. `mcp_handlers_never_rebuild_the_summary_under_the_lock` — `ui.rs`, all FOUR rebuilding
   `CoreState` methods in call form, comment lines skipped. *Mutation-verified.*
2. `no_new_core_state_method_wraps_a_summary_rebuild` — `lib.rs`, PINS the number of methods that
   wrap a rebuild at 2, so a new wrapper fails there and forces list 1 to be extended.
   *Mutation-verified.*
3. `no_other_file_rebuilds_the_summary_from_a_caller_holding_the_lock` — every other `.rs` under
   `src/`, zero hits, with site 21's ONE occurrence pinned to its exact line and asserted to appear
   exactly once. This one exists because the first two shared a blind spot: a rebuild in a THIRD
   file, reached with the lock held by a `ui.rs` caller. It scans `hook_events.rs` rather than
   skipping it by name (a filename skip would hide a SECOND rebuild there), and it knows the UFCS
   spelling `CoreState::build_session_summary(` as well as the method-call one.
   *Mutation-verified: pin → bogus filename ⇒ FAILS naming `hook_events.rs:227`.*

Advisor (Fable 5.1) approved the hoist as semantically safe at all 17 and changed three things,
all adopted: **split** the long guard at `get_window_eta`/`get_account_burners` rather than
hoisting above it (this also lifted `read_account_segments`'s file read off the lock, and the two
error arms now fetch no summary at all); keep the `get_context_history` fetch **conditional**; and
delete the six now-misleading `drop(summary)` lines. Three handlers that were making TWO
`summary_now` calls were collapsed to one shared `Arc`.

Gates: `cargo clippy -p agentlens-core --all-targets -- -D warnings` exit 0, zero warnings;
`cargo test -p agentlens-core --lib` **42/42** (39 baseline + the three guard tests);
`cargo build --release -p agentlens-core` exit 0.

**THE GATE THAT MATTERS, AND WHY THE OTHERS ARE NOT IT.** Not one of the 42 lib tests invokes
`handle()` — they cover the summary-cache admission logic and the new source guards. So clippy and
`--lib` together prove the crate COMPILES with this change and that the guards behave; they prove
NOTHING about the twenty request paths actually rewritten. `cargo test -p agentlens-core --test '*'`
(the `tests/*_parity.rs` fixtures that drive the handlers) is the settling run, and acceptance
box 2 stays unticked until it is green. **Do not deploy on `--lib` alone.** A hang in a burn-route
binary would be the self-deadlock hazard at the split guards in `get_window_eta` /
`get_account_burners` — kill it and check the brace nesting before anything else.

INTEGRATION RESULT: see the report.

**CARRIED FORWARD — three items, each needs its own card:**
1. **SITE 21 — `hook_events.rs:227`, VERIFIED FIRST-HAND.** `ui.rs:1234` takes the state lock and
   hands `&mut st` into `ingest_hook_event`, whose `StopFailure` branch rebuilds the whole summary
   under that guard — on the ingest endpoint, during a rate limit. NOT fixed here (ingest path,
   not the MCP read path; it moves where capacity calibration reads its sessions, which needs its
   own measurement). Fix shape: peek `hook_event_name == "StopFailure"` on the parsed payload
   BEFORE locking, read `summary_now` off-lock only then, pass `Option<&Value>` in; every other
   hook event pays one string compare. It is NAMED in guard test 3, so it cannot go silent.
2. **Dead `CoreState` methods.** `live_burn_status` is dead — verified first-hand, zero callers
   workspace-wide after site 20 removed the last one; `clippy -D warnings` does NOT catch it
   (`dead_code` does not fire on public items). The advisor additionally reports `burn_status_over`
   (only caller is `live_burn_status`) and `build_stripped_summary` at zero, and
   `build_session_summary` reaching zero once site 21 lands — those three unverified by me, and
   `lib.rs:457`'s "the tests still take this path" already false. Deleting four public methods on
   the core crate needs the FULL suite, so pair it with site 21. It also moves the count pinned by
   guard test 2.
3. `summary_now`'s 2 ms poll (≤500 ms) blocks a tokio worker thread. Pre-existing on the REST
   routes; this pass puts it on ~18 more handlers.

**KNOWN TRADE, watch for it:** off-lock reads may serve a summary one rebuild behind (≤500 ms,
`STALE_BUDGET_MS`). The signal that this bites is the put-then-POST cases in `tests/ui.rs` turning
flaky; if they do, the budget is the knob, not the hoist.

NEXT ACTION: commit sites 2–20, deploy, and re-run the **15-min hold read** (`server.log`, no
`state lock held ≥ 1000 ms by ui.rs:<handler>`), then invoke each affected tool once while ingest
is hot — acceptance box 3. Site 20's own early signal is a `state lock held` line naming
`ui.rs:1494` or `ui.rs:3363` within the first seconds after the restart; if the fix works there
will be none.

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

- [x] `grep -c 'st.build_session_summary(' rust-core/crates/agentlens-core/src/ui.rs` is 0 outside
      tests; every former site reads the summary via `summary_now` before the guard. **Now enforced
      by a test rather than a grep** — `mcp_handlers_never_rebuild_the_summary_under_the_lock`.
- [ ] `cargo clippy -p agentlens-core --all-targets -- -D warnings` and `cargo test -p agentlens-core`
      green; the `tests/mcp_*` parity fixtures unchanged in output. **clippy exit 0 and `--lib`
      42/42, but this box stays UNTICKED until the INTEGRATION suite is green.** It was briefly
      ticked on `--lib` alone — a proxy: not one lib test invokes `handle()`, so nothing that had
      run exercised any of the twenty rewritten request paths. `cargo test -p agentlens-core
      --test '*'` is the only run that does. Result recorded in the STATE block above.
- [ ] After deploy, invoking each affected tool once (via `agentlenspro <tool>`) while ingest is
      hot produces no `state lock held ≥ 1000 ms by ui.rs:<that handler>` line.

## Notes and lessons learned

- **A grep for the defect could not see all of it.** The card was scoped by
  `grep -n 'st.build_session_summary(' ui.rs` — 18 hits. A nineteenth site, `get_session_status`,
  called `st.live_session_status(...)`, which did the rebuild ONE CALL DEEP inside `lib.rs`. The
  grep was over the *spelling* of the defect, not its *shape*, so an identical hold hid behind a
  method name. The fix that generalizes: a method that computes over the summary is named `_over`
  and takes `summary: &Value` (`burn_status_over`, now `session_status_over`) — the name then says
  it does not build, and a caller can see the obligation at the call site.
- **The doc comment saying "don't do this" did not stop it happening eighteen times.**
  `build_session_summary`'s own doc already said every hot-path caller must go through
  `ui::summary_now`. Prose cannot fail a build. The replacement is a test that scans this file's
  own source and names the offending line — mutation-verified, because a guard nobody has seen
  fail is only a guard by assertion.
- **A one-needle guard is worse than no guard.** The first version of that test passed on a file
  where two live routes still held the lock through a rebuild, because it was two method hops
  away. It did not merely fail to help — it CERTIFIED the file clean, and the acceptance box was
  ticked on its say-so. The fix that generalizes: a source-scanning guard must be paired with one
  that pins the set of things worth scanning FOR, on the other side of the call boundary — here,
  `no_new_core_state_method_wraps_a_summary_rebuild` over `lib.rs`. Otherwise the guard is only
  ever as complete as the author's memory on the day.
- **A rename is a cheaper guardrail than either.** `session_status_over` / `burn_status_over` take
  the summary as a parameter, so the obligation is visible AT THE CALL SITE and the type system
  carries it. `live_session_status` hid the same work behind a name that promised nothing.
