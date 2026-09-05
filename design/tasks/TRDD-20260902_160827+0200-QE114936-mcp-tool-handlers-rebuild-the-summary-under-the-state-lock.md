---
trdd-id: QE114936
title: Twenty MCP tool handlers still rebuild the session summary under the state lock
column: ai_review
created: 2026-09-02T16:08:27+0200
updated: 2026-09-05T18:05:29+0200
current-owner: main-session
task-type: bugfix
priority: high
min-approval-requirement: none
created-by: UTFVMVT8
related: [UTFVMVT8, 2R36W8Q1, HFV4AIT7, MVR6PXC0]
implementation-commits: [2b38a39b, 1a00cec6]
---

# Twenty MCP tool handlers still rebuild the session summary under the state lock

## ⏵ AI-REVIEW VERDICT 2026-09-05 — APPROVE. Ready for `human_review`; the USER makes that move.

Review report: `reports/ai-review/20260905_180358+0200-QE114936-ai-review.md` (lean-worker, read-only —
no cargo, because the MVR6PXC0 suite owned the target dir). Re-checked first-hand by the orchestrator
at 18:05 before accepting: `grep -c 'st\.build_session_summary(' ui.rs` → 0; the three guard tests
exist at `ui.rs:4262/4285/4308`; `2b38a39b` (ui.rs +57) and `1a00cec6` (ui.rs +456, lib.rs +40) are
the two commits whose hunks implement this card — `7caad610` and `acaf82e8` are deploy-time HEAD
markers, not implementation (verified 18:08 by `git show --stat` on both: one board file and six
design files, no `rust-core/` path), and are excluded from `implementation-commits:`. Box 3 stays OPEN
on purpose: 3 of 20 handlers still hold ≥ 1 s, at a different code path (the per-candidate reparse in
`resolve_session_card`, not the summary rebuild this card removed), and that residue is
TRDD-MVR6PXC0 — see the note under box 3 itself. The reviewer's one unre-executed claim is box 2's
543-test integration run (cited from the card, not re-run); the three guard tests are verified as
SOURCE (`fn` names at fixed lines), not as an executed run — the MVR6PXC0 suite's `ui.rs` unit binary
is what settles that.

## Approval log

- 2026-09-05T18:05:29+0200 — ORCHESTRATOR decision: accepted the 18:03 AI-review APPROVE with box 3
  left unchecked and delegated to TRDD-MVR6PXC0. Added the missing `implementation-commits:` from
  first-hand `git show --stat`. Vetoable at `human_review`: the USER may instead hold this card in
  `ai_review` until MVR6PXC0 lands and box 3 can be ticked on a re-measured recipe.
- 2026-09-05T18:08:52+0200 — the review fork on `cca017ef` found the box-3 pointer lived only in the
  STATE block, not under box 3, while MVR6PXC0's box "QE114936's box 3 note updated to point here"
  had been declared met from here. Fixed in one commit: the note now sits under box 3, and MVR6PXC0's
  box is ticked in its own file.

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-05T12:33:51+0200

**DEPLOYED, box 3 measured — `ai_review`.** The binary built from `7caad610` (all twenty sites)
went live at 11:51 on 2026-09-05 (pid 39382; `reports_dev/alcore-restart.txt`). Hold read over the
first 33 min of `server.log` after the restart: zero `state lock held ≥ 1000 ms` lines, max
`ui.rs` hold 464 ms (`reports_dev/server-log-since-restart.txt`). Then every rewritten tool was
invoked once while ingest was hot (`reports/qe114936/20260905_123046+0200-box3-tool-invocations.md`,
24 tools, 0 unmapped): no `≥ 1000 ms` line at any `summary_now` site — the defect this card is
about is gone on the live server. Read literally, box 3 is NOT met for three handlers
(`get_cost_by_cause`, `get_cache_risk_costs`, `get_cache_break_report`): eight holds of
1,037–3,948 ms at `ui.rs:2074/3220/3283`, inside their per-candidate `resolve_session_card`
closure — the "reparse can still block a worker" cost already carried forward below, now its own
card **TRDD-MVR6PXC0**. `human_review` is the USER's move. Earlier state, kept:

## ⏵ STATE (earlier) — 2026-09-05T06:39:31+0200

**ALL 20 SITES ARE DONE IN CODE (the card was written for 18; two more were found), COMMITTED,
and the INTEGRATION SUITE IS GREEN. Still NOT deployed — box 3 is the only one left.**

**Column moved `dev` → `testing` on 2026-09-05**: no code work remains, and the one open box is a
runtime verification against a deployed binary. Leaving it in `dev` would assert someone is
writing code on it, which nobody is.

- **Committed**: site 1 as `2b38a39b`, sites 2–20 as `1a00cec6` — **verified by counting, not by
  reading the subject line.** `1a00cec6`'s subject says "the last two", which reads as sites 19–20
  only; it is not. `git show <rev>:…/ui.rs | grep -c 'build_session_summary('` gives **17 at
  `2b38a39b` → 2 at `1a00cec6`**, and those last 2 are inside comments in the guard test
  (`ui.rs:4204`, `:4216`). `1a00cec6` is +309/−147 on `ui.rs` and is the ONLY commit touching that
  file since `2b38a39b`. Sites 19–20 are half in `lib.rs`, which that count cannot see, so read
  **`git show 1a00cec6`'s commit BODY**: it names both edits — `session_status_over` (site 19) and
  `burn_risk_report`'s `status_when_unset` fill-in (site 20) — with mechanism. `--stat`'s
  `lib.rs +40` shows only that the file was touched, which is consistent with one of the two as
  much as both; the body is what settles it. All 19 remaining sites are in that commit. Working tree clean. **The subject line alone would
  have sent you to the wrong commit for sites 2–18** — that is why this bullet carries the count.
  **The count proves LOCATION, not correctness**: a needle reaching 0 is exactly what the card's
  own MAIN LESSON warns about. Correctness rests on the three mutation-verified guard tests plus
  the integration run, which is separate evidence.
- **INTEGRATION SUITE GREEN, 2026-09-05** — `cargo test -p agentlens-core --test '*'` → **exit 0,
  98 test binaries, 0 failures**, `tests/ui.rs` 41/41. Total passed **543, summed from the
  per-binary `test result: ok.` lines** (derived, not printed by cargo — and trustworthy only
  because `grep -c '^test result: FAILED'` was 0 and the run exited 0; the sum alone would read
  the same if a binary had failed). "98 binaries" is likewise the count of OK lines. This is the run box 2 was
  waiting for: the one that actually invokes `handle()`. `--lib` alone never did.
  Raw output: `reports_dev/qe114936-integration.txt`.
- **The box's second clause is also verified, and it is NOT vacuous** — the files exist:
  `tests/mcptools_parity.rs` and `tests/fixtures/mcptools-expected.json`. **The clause is carried
  by the DIFF** — neither file changed in `2b38a39b^..HEAD`. `mcptools_parity` also ran **13 tests
  green**, which says the assertions hold against the current goldens; that is a separate fact and
  contributes nothing to "unchanged". Scoped to the whole
  test tree, the ONLY churn in that range is `pricing-expected.json` and `log_reader_parity.rs`,
  from `f7610871` and `420e6bb9` — other cards. A green suite alone would NOT have proven this:
  a golden updated in the same commit as the code it checks passes either way. (Checking this by
  grepping paths for "mcp" was the weak form — it cannot tell "unchanged" from "does not exist",
  and here the goldens are named `mcptools-*`, not `mcp_*`.)
- One test crossed 60 s and then passed —
  `log_reader_parity::watcher_advances_a_card_on_growth_without_waiting_for_the_backstop` (it
  waits on a real filesystem backstop). **One observation, so nothing is established about
  flakiness** — a single green run cannot separate slow-and-deterministic from flaky-and-lucky.
- **NEXT: box 3 only.** Deploy and re-run the 15-min hold read. Run
  `codesign -s - --force bin-native/darwin-arm64/alcore` after copying the binary: without it the
  binary exits **137** before `main` and `server.log` is empty. **Remedy verified; mechanism NOT
  established** — the competing explanation is a stale cached verdict after `cp` over a running
  mapped binary, which `--force` also fixes. See TRDD-M2VK8T4P; do not build on the cause.
  **`bin-native/` is gitignored**, so once deployed nothing on disk links the running binary to
  `1a00cec6`. On a card whose whole subject is which commit contains what, the deploy report is
  the only place that link can be pinned — record the SHA in it.

**The three bullets below are the historical site record. Their "uncommitted" wording is
SUPERSEDED by the first bullet above** — every site listed is committed.

- **Site 1** (`resolve_session_card` takes `summary: &Value` in) — committed **2b38a39b**, deployed
  as pid 2074 (acaf82e8), **15-min hold read PASS** (max `ui.rs` hold 506 ms, 0 holds ≥1000 ms;
  `reports/deploy/20260903_053800+0200-deploy-420e6bb9-step0.md`).
- **Sites 2–18** (the 17 direct `st.build_session_summary(` sites) — DONE; committed in
  `1a00cec6` (see the count above — this bullet once read "uncommitted"). Report:
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
- [x] `cargo clippy -p agentlens-core --all-targets -- -D warnings` and `cargo test -p agentlens-core`
      green; the `tests/mcp_*` parity fixtures unchanged in output. **clippy exit 0, `--lib` 42/42,
      and — 2026-09-05 — the INTEGRATION suite `cargo test -p agentlens-core --test '*'` exit 0,
      98 binaries / 543 tests / 0 failures, `tests/ui.rs` 41/41; the fixture clause verified
      separately (no `mcp_*` test or fixture changed in `2b38a39b^..HEAD`).** It had been briefly ticked on
      `--lib` alone — a proxy: not one lib test invokes `handle()`, so nothing that had run
      exercised any of the twenty rewritten request paths. It is the `--test '*'` run, and only
      that run, that ticks this box.
- [ ] After deploy, invoking each affected tool once (via `agentlenspro <tool>`) while ingest is
      hot produces no `state lock held ≥ 1000 ms by ui.rs:<that handler>` line.
      **Box-3 note (2026-09-05):** measured, NOT met by three handlers — `ui.rs:2074`, `:3220`,
      `:3283` hold 1,037–3,948 ms inside their per-candidate `resolve_session_card` closures, a
      different code path from the summary rebuild this card removed (17/20 sites clean:
      `reports/qe114936/20260905_123046+0200-box3-tool-invocations.md`). That residue is
      **TRDD-MVR6PXC0**; this box is ticked only when MVR6PXC0's re-measured recipe is clean.

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
