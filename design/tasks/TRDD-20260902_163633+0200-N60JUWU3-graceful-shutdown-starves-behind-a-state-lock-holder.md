---
trdd-id: N60JUWU3
title: The graceful shutdown needs the state lock and has no timeout, so a long holder starves the stop into a SIGKILL
column: dev
created: 2026-09-02T16:36:33+0200
updated: 2026-09-03T04:20:46+0200
current-owner: main-session
task-type: bugfix
priority: high
min-approval-requirement: none
created-by: UTFVMVT8
related: [UTFVMVT8, 2R36W8Q1, HFV4AIT7]
---

# The graceful shutdown needs the state lock and has no timeout, so a long holder starves the stop into a SIGKILL

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-02

- **Implemented** (not yet committed/deployed): `bin/alcore.rs:358-421` now polls
  `state.try_lock()` in a loop up to `AGENTLENS_STOP_LOCK_TIMEOUT_MS` (default 10_000, parse
  failure fail-fasts via `usage()`), eprintln-ing "alcore: stop waiting on <holder> for N ms"
  every 5 s and, on final timeout, "alcore: stop timed out … skipping the flush, releasing the
  pid lock anyway" — then `pid_lock::release` always runs (outside the loop, unconditionally),
  matching the acceptance box "stop returns ≤10s and the pid lock is released". On success the
  flush sequence (`flush_spans`, `statusline.flush`, `account_timeline.flush`,
  `collector_lifecycle::record_stop`) is unchanged.
- New `pub fn current_lock_holder() -> Option<(String, u64)>` in `lib.rs` (after `now_ns()`)
  reads the same `HOLDER_SITE`/`HOLDER_SINCE_NS` globals `lock_timed` already maintains, so a
  `try_lock` failure can name the holder without itself blocking.
- `src/cli/serverControl.ts:486` timeout message now points at "server.log for `alcore: stop
  waiting on <holder>`" (acceptance box 3 — text only, no logic change; the CLI still can't read
  the Rust stderr string itself, it just tells the operator where to look).
- New test `src/test/serverStopBoundedWait.test.ts` — real alcore spawn, `AGENTLENS_STOP_LOCK_
  TIMEOUT_MS=1`, asserts SIGTERM→exit(0) ≤10s and `server.pid` is gone. **This does NOT
  reproduce the 120s-holder starvation scenario** — no production hook exists to hold
  `CoreState`'s mutex from outside the process, and the investigation report explicitly said not
  to invent one. It exercises the added mechanism (env knob honored, release always runs) on the
  uncontended path only.
- Verified GREEN: `cargo build --release -p agentlens-core`, `cargo clippy --all-targets -D
  warnings`, `cargo test --lib` (37 passed, incl. `lock_timed_tests`), `pnpm run check-types`,
  the new mocha test (passed in 1818ms) plus the full `pnpm run test:unit` suite (2543 passing /
  7 failing, all 7 pre-existing in `serverCalibration.test.js` — unrelated `burn-config.json`
  ENOENT, not touched by this change).
- Acceptance box 2 ("next boot classifies the gap as shutdown, not crash") is **unaffected** —
  `record_stop` still runs on the success path exactly as before; on a timeout it does NOT run
  (the flush is skipped), so a timed-out stop still classifies as a gap on next boot, same as
  today's SIGKILL case. Not a regression, but also not newly fixed — out of this change's scope.
- **SUPERSEDED — do NOT carry forward:** the investigation's proposed STATE block's plan to
  "move `:374` outside the `if let Ok` block it is already outside of" — that observation was
  already true pre-fix (`pid_lock::release` was always outside); this fix keeps that property
  under the new loop shape.
- **NEXT ACTION:** review this diff → commit → deploy (`node esbuild.js` is irrelevant here,
  this is the Rust binary — `cargo build --release` + restart the server) alongside XX1UAZHS →
  then design a real 120s-holder acceptance test (needs a test-only hook to hold `CoreState`'s
  mutex, e.g. a debug-build-only env-gated endpoint) to close acceptance box 1 for real.
- **ADVISOR VERDICT (Fable 5.1):** do not land as-is; rework in flight per 7 findings (extract
  `flush_with_deadline` into `agentlens_core` + 2 real Rust tests; boot-time knob parse; bounded
  sweeper join; `rt.shutdown_timeout` before `pid_lock::release`; server 8 s / CLI 15 s; CLI
  names the holder from logTail; poison arm `into_inner`). The runtime-drop path is a second root
  cause under the same acceptance.

## What happened (2026-09-02 16:28–16:34, pid 6978, the pre-fix binary)

`agentlenspro server restart` sent SIGTERM and reported "still running 10s after SIGTERM". The
process was still alive 6 minutes later, state `Rs`, HTTP unreachable within 800 ms, and its last
log lines were an OTLP ingest handler that had waited 145,456 ms behind `ui.rs:560` and a bodies
pass that took 190 s. A 2 s `/usr/bin/sample` showed every tokio worker parked in
`__psynch_mutexwait`. The shutdown path (`bin/alcore.rs`, after the SIGTERM `select!` arm) does
`sweeper.stop()` and then `state.lock_timed()` to `flush_spans`, flush the statusline WAL and the
account timeline, and record a clean stop — so it queues behind whichever request path currently
holds the state lock, with no timeout, and `std::sync::Mutex` gives it no priority over the next
request that wants the same lock. With the pre-fix composition routes holding it for 60–110 s per
call and being called continuously, the stop never got its turn. It was SIGKILLed at 16:34:22.

**The holder is proven by stack.** The same 2 s `sample` (Rust symbols are mangled — grep
`14agentlens_core`, not `agentlens_core::`) shows one tokio worker (Thread_264829945) in
`CoreState::composition_project_map → build_session_summary → summary_over` for all 1,413 samples:
the pre-fix inline rebuild TRDD-UTFVMVT8 removed. The `pid_lock::release` at the end of the stop
path never ran either; the next start's stale-lock takeover handled it (`canonical=true`).

**What the kill cost: UNMEASURED, and unknowable from the code alone.** The 5 s flush tick
(`chores.rs:561`) needs the SAME lock — it waited 8,842 ms behind this holder on pid 26060 and was
queued again in pid 6978's final tail — so "durability boundary = the last tick" really means "the
last tick that WON the lock"; how many spans sat unflushed at 16:34:22 was never read
(`pendingAppends` was not sampled before the kill). CORRECTION of the first version of this
paragraph (commit d723650b): it reported a "16:30–16:37 hole" that was a hand-computed epoch range
one hour EARLY — the dip it described is 15:30–15:37, coincident with the account-cap episode the
user reported at 15:48, a separate unexplained dip (card it only if it recurs).

**What the WEDGE cost, measured on the store (spans per minute by span `startTime`, epochs derived
from local-time strings, buckets re-read 20 min apart and unchanged):** normal 0.8–2.6k/min through
16:11, then **5 / 12 / 3 / 4 / 6 / 10 / 20 / 29 / 38 / 8 / 39 / 32 / 28 / 115 / 145 / 63 / 47 / 1**
for 16:12–16:29, nothing 16:30–16:33, 2 at 16:34, 28–53/min for 16:36–16:42, and back to 1,886 at
16:43. Thirty minutes of OTEL-only detail across the active sessions is gone, and the split between
SINK loss (accepted by pid 6978, never flushed, discarded by the kill) and SOURCE loss (never
arrived) is MEASURED from the store's byte layout, not from start times — a start-time boundary
cannot separate the two pids, since both flush spans that started earlier (a first draft here used
one and got 16:34:22, a number capped by its own construction). The old pid's last append ends at
byte `size − spanAppendBytes(new pid)` = 340,795,194; the newest span start in the 3 MB before that
offset is **16:28:57**. How exact the boundary is: `spanAppendBytes` sums exactly `chunk.len()`
of each `write_all` to `<day>.ndjson` (`agentlens-spanstore/src/writer.rs`), only today's segment
is uncompressed so no other file received appends, and the two reads bracket it — the first
(`stat` before `curl`, biased EARLY, offset 340,795,194, landed mid-line, cause not established)
and the second (counter first, biased LATE, offset 340,825,965, landed on a line boundary) differ
by 30 KB ≈ one tick's append, so the true boundary lies between them. The oldest span start AFTER
the late-biased boundary is **16:34:22** (an in-flight batch from the kill second, flushed by the
new pid); an earlier draft read 16:27:58 after the early-biased one, which was the old pid's last
chunk on the wrong side — no late client backlog arrived after the restart. So:
  - **16:12–16:28 — SOURCE loss, measured.** The tick was still flushing (spans up to 16:28:57
    reached disk) and the buckets are empty anyway: nothing arrived. The holds at the composition
    guard reached 82 / 85 / 67 s from about 16:10 (TRDD-UTFVMVT8, coincident within the 15-min
    window — the split lines carry no timestamps), the OTLP handler waited 145 s behind them, and
    the exporters' batches timed out — the drop itself is inferred from OTel batch-exporter
    semantics, not observed at the exporters.
  - **16:29–16:34:22 — inseparable.** SIGTERM landed at 16:28:37; from the last flushed start
    (16:28:57) to the kill, anything pid 6978 accepted sat unflushed and died with it, and anything
    the exporters dropped never came. About 5.4 minutes, owner unknown; `flush_spans` has no per-call
    batch cap (the whole body flushes every pending bucket; `prune_window` prunes the in-memory
    READ window, the writer's `pending` buckets are separate), so the sink share is bounded by
    that interval, not by one tick.
  - **16:34:30–16:42 — SOURCE loss, measured.** The new pid flushed from its first ticks (its
    oldest flushed start is 16:34:22) and answered OTLP in 0.5 ms; the 16:12–16:28 buckets did not
    fill on a later read, so no backlog was delivered; the exporters resumed at 16:43 — a
    back-off, inferred.
The new pid's `droppedOnFailure = 0` says nothing about the old pid and is not evidence here.
Claude-session spans backfill from the JSONL transcript (log wins on collision); the
`cost_usd`-class OTEL-only fields in those intervals do not. This is the actual size of the
incident this card and UTFVMVT8 describe.

**Scope of this card therefore includes the flush tick and the sweeper**, not only the SIGTERM
path: all three lose durability to the same lock, and a stop that cannot flush is only the most
visible of the three.

## Why it matters

TRDD-UTFVMVT8 removed the specific holder, but the shutdown still has the shape: any future
request path that holds the lock for a long time (TRDD-QE114936 lists eighteen candidates)
turns `server stop` into a hang, and the operator's only exit is a SIGKILL that discards exactly
the state the graceful path exists to save. A stop must be able to make progress without a
cooperative request path.

## Fix shape (pick from measurement, not from this list)

- Bound the wait: try the lock with a deadline (poll `try_lock` for up to N s), then fall back to
  flushing what does not need the full `CoreState` — the span writer and the statusline WAL each
  have their own buffers; if they can be flushed through a narrower lock or an `Arc` handle taken
  at boot, the stop never needs the state mutex at all.
- Stop admitting requests first: close the listeners before flushing, so no new holder can queue
  ahead of the stop.
- Log the stop's own wait through `lock_timed` (it already does — that is how a future incident
  names its holder) and print a one-line "stop waiting on <holder> for N ms" every 5 s so the
  operator can see it is starved rather than hung.

## Acceptance

- [ ] With a request path artificially holding the state lock for 120 s (a test-only env knob, or
      a test in `src/test/serverSingleInstance.test.ts`'s style against an isolated `DATA_DIR`),
      `agentlenspro server stop` completes within 10 s and the span/statusline flushes are on disk.
- [ ] The next boot after such a stop classifies the gap as "shutdown", not "crash".
- [ ] `agentlenspro server stop`'s own "still running after 10s" message names the lock holder it
      is waiting behind when that is the cause.

## Notes and lessons learned

- Empty section on creation.
