---
trdd-id: N60JUWU3
title: The graceful shutdown needs the state lock and has no timeout, so a long holder starves the stop into a SIGKILL
column: todo
created: 2026-09-02T16:36:33+0200
updated: 2026-11-19T01:25:06+0100
current-owner: main-session
task-type: bugfix
priority: high
min-approval-requirement: none
created-by: UTFVMVT8
related: [UTFVMVT8, 2R36W8Q1, HFV4AIT7]
implementation-commits: [420e6bb9, 17a0667b, d52cebab]
status: tasked
---

# The graceful shutdown needs the state lock and has no timeout, so a long holder starves the stop into a SIGKILL

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-03T06:08:16+0200 (see also the 2026-10-15 note under Notes and lessons learned: the save_cards full-corpus hold is gone since e3c3c388)

**Owed post-deploy check DONE — PASS, but it closes no acceptance box.** `agentlenspro server
stop` on pid 2074 (the new binary, 60+ min uptime) returned in **7s** (exit 0, well under the 15s
bound). `server.log` tail after the stop showed only a `bodies pass` completion + the mimalloc
exit-stats dump — **no `alcore: stop (waiting on|timed out …)` line**, i.e. a clean immediate stop
(the lock-holder-naming message only fires when the stop actually queues, which it did not here
at real traffic). The dataDir's `hook-revive` mechanism auto-restarted the server within ~1s
(`started-by=hook-revive`); `agentlenspro server start`/`status` afterward confirmed a healthy
canonical server. **None of the three `## Acceptance` boxes are satisfied by this** — all three
need a synthetic 120s lock-holder (a test-only hook, not yet built) or a real starvation event.
Report: `reports/board-sweep/20260903_060822+0200-soak-and-restart-checks.md`.

Deployed 420e6bb9 (via HEAD acaf82e8) as pid 2074, inode 1514169484, clean `agentlenspro server
restart` in 17s, exit 0. Report: `reports/deploy/20260903_053800+0200-deploy-420e6bb9-step0.md`.

- **Implemented, reworked per advisor verdict** (committed, deployed per above):
  - `src/shutdown.rs` (new module) — `pub fn flush_with_deadline(&Mutex<CoreState>, Duration) ->
    Outcome<'a>` where `Outcome` is `Flushed(MutexGuard)` / `TimedOut { holder: Option<String> }`
    / `Poisoned` (never constructed — a poisoned mutex is recovered via `into_inner()`, the
    crate's own convention per chores.rs, and returned as `Flushed` instead, per the advisor's
    "prefer into_inner so a poisoned lock still flushes"). Two real tests in `shutdown::tests`:
    a 2s holder + 200ms deadline → `TimedOut`, returns ≤300ms; a 100ms holder + 2s deadline →
    `Flushed`. The holder-name assertion is soft (`if let Some(site) = holder`) — `HOLDER_SITE`/
    `HOLDER_SINCE_NS` (lib.rs) are PRE-EXISTING process-wide statics shared by every
    `Mutex<CoreState>` in the binary, so under the default parallel `cargo test` another
    unrelated test's mutex can race-clear the slot; verified deterministic under
    `--test-threads=1`. Not a bug introduced here — flagging the pre-existing global-state
    design as a future hardening target.
  - `log_reader.rs`'s `SweeperHandle::stop()` split into `signal()` (non-blocking) +
    `join_within(Duration) -> bool` (polls `is_finished()`, never `join()`, because `join()`
    would block unboundedly on `save_cards`'s own `lock_timed()` — the sweeper's own flush can be
    stuck behind the SAME contended lock). The one other caller
    (`tests/log_reader_parity.rs:423`) updated to `signal()` + `join_within(10s)`.
  - `bin/alcore.rs`: `AGENTLENS_STOP_LOCK_TIMEOUT_MS` now parsed at **BOOT** (before
    `pid_lock::claim`, default 8s) instead of at stop time, so a malformed value fails fast
    before anything is claimed. The tail now shares ONE `stop_deadline` across, in order: signal
    the sweeper (immediate, non-blocking) → `flush_with_deadline` (state flush) →
    `sweeper.join_within(remaining)` → `rt.shutdown_timeout(remaining)` (explicit, replacing the
    old IMPLICIT drop-at-end-of-main, which blocked unboundedly on background chores — e.g. the
    DuckDB bodies pass `chores.rs` spawns via `spawn_blocking` — a second, previously-undiagnosed
    starvation point) → `pid_lock::release` (now LAST, after the runtime has actually stopped,
    closing the double-owner window that releasing early would reopen).
  - `src/cli/serverControl.ts`: `stopServer()` wait raised 10s→15s (comfortably above the
    server's 8s default so a real server-side timeout is already logged by the time the CLI gives
    up); on timeout, `logTail()` (scoped to bytes written since this SIGTERM) is matched against
    `/alcore: stop (?:waiting on|timed out .*waiting on) (.+)/` and the holder, if found, is
    interpolated into the thrown error.
- **New test `src/test/serverStopBoundedWait.test.ts` is a SMOKE TEST, not a starvation
  reproduction** — per the advisor, it passes on the PRE-fix binary too (an idle server's
  `try_lock` succeeds on the first attempt regardless of the timeout value), so it only proves
  the env knob is read and a clean stop still works. Kept (not dropped) as a basic regression
  guard; a real starvation test still needs a test-only hook to hold `CoreState`'s mutex from
  outside the process (none exists; not invented here per the original investigation's
  instruction not to add a production debug endpoint).
- **Open observation (not this TRDD's root cause, recorded per advisor):** during earlier
  manual testing "a new server could not start after the stop" was observed. `pid_lock::claim`
  is unconditional once the pidfile is gone, so the pidfile itself was NOT the blocker — the real
  effect was the original incident's stale-inode SIGKILL (a separate, already-understood
  mechanism, see "What happened" below), not a new bug in this rework.
- Verified GREEN (after two concurrent-edit collisions in `ui.rs` from unrelated in-flight work,
  TRDD-XX1UAZHS, resolved by waiting — NOT touched by this TRDD): `cargo build --release -p
  agentlens-core` (lib + `--bin alcore`), `cargo clippy -p agentlens-core --all-targets -- -D
  warnings` (0 warnings, covers `tests/log_reader_parity.rs` too), `cargo test -p agentlens-core
  --lib` (39 passed, 0 failed, incl. both new `shutdown::tests::*`), `pnpm run check-types`, the
  new mocha smoke test (passed, ~1.1–1.8s across runs).
- Acceptance box 2 ("next boot classifies the gap as shutdown, not crash") remains **unaffected**
  by this rework — `record_stop` runs only on the success path, same as before.
- **NEXT ACTION:** review this diff → commit → deploy (Rust binary: `cargo build --release` +
  restart the server) alongside XX1UAZHS → design a real 120s-holder acceptance test (needs a
  test-only hook into `CoreState`'s mutex) to close acceptance box 1 for real → consider
  scoping `HOLDER_SITE`/`HOLDER_SINCE_NS` per-mutex instead of process-wide (separate, smaller
  TRDD; flagged above, not required for this fix to be correct).

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
- [x] `agentlenspro server stop`'s own "still running after 10s" message names the lock holder it
      is waiting behind when that is the cause.

## Notes and lessons learned

- Empty section on creation.
2026-10-15 (TRDD-DA0GN1CS commit e3c3c388): the periodic save_cards no longer runs persist_records' whole-table DuckDB scan under the state lock; it copies the resident layer's Arc handles under a short lock and strips them off it. Long-holder analyses on this card that count the save's full-corpus hold must not count it after e3c3c388. The remaining corpus-scaled DuckDB query under the lock on the sweeper is demote_cold's window query (TRDD-KMF02UEX).
2026-10-16: moved to todo by the board triage (row 32). The fix (420e6bb9) is on main and deployed; the post-deploy check passed on 2026-10-15. What remains is only the acceptance evidence: its three boxes need a 120 s synthetic state-lock holder (a test-only knob, never built) or a real starvation event. Do not redo the fix.
2026-10-16: The approval-log reason for this move ('work stalled mid-way or never started') is inaccurate for this card.

## Approval log

- 2026-10-16T11:13:15+0200 — column → todo by main-agent@agentlenspro. work stalled mid-way or never started; no one works it now; triage row 32

## Triage 2026-11-19

2026-11-19T00:43+0100 main agent — source: reports_dev/sonnet-worker/20261119_w63-triage-mvr6-n60j/report.md (read whole). The fix landed in 420e6bb9; three Acceptance boxes are open. Box 2 has a real gap, INFERRED from two read sites and not run: record_stop runs only in the Flushed arm of alcore.rs, and collector_lifecycle.rs:125 reads a missing stoppedAt as crash, so the boot after a timed-out stop reports a crash. That fix and a unit test are in dev (worker w65). Box 3: the CLI regex is extracted into a pure function, with a unit test against the exact alcore line, in dev (worker w66). OWNER QUESTION on box 1: on TimedOut the flush is skipped by design, so 'span/statusline flushes on disk' cannot hold under a real 120 s lock holder; only the stop bound, the pid release and the log line can be asserted. An end-to-end test also needs an out-of-process lock holder, which means a feature-gated test hook in production code (the card forbids a debug endpoint). Proposal, not done: reword box 1 to 'stop completes within the bound, releases the pid lock, and logs the holder', and decide whether a feature-gated test hook is acceptable.
2026-11-19T00:50+0100 main agent, correction to the entry above: box 3 was not done when that line was written, the worker had only been dispatched. Box 2: 17a0667b landed (record_stop_from_disk after both runtimes stop, unit test timed_out_stop_from_disk_reads_as_shutdown, 5 lib tests and the alcore build passing on the combined tree). Box 2 stays UNTICKED: the flag and the call site are covered only by the build, and a thread abandoned by shutdown_timeout (the stuck holder) can still persist the in-memory store over the marker. A real proof needs the same out-of-process lock-holder hook as box 1, so boxes 1 and 2 both WAIT ON THE OWNER's decision recorded above. Box 3: the holder regex fix and its tests are in dev (worker w66, not committed).
2026-11-19T00:55+0100 main agent: box 3 ticked on d52cebab. stopHolderFromLog extracts the holder from the alcore 'stop timed out after N ms waiting on <holder>' line (capture stops before the ' — ' tail), and stopServer appends ' — stuck behind <holder>'. 9 unit tests, one of them reading the format string out of alcore.rs; serverStopBoundedWait 1 passing. Not shown end to end: a real held lock producing that line needs the box 1 hook (owner decision above). implementation-commits gains d52cebab.
2026-11-19T00:56+0100 main agent, correction to the box 3 entry: serverStopBoundedWait runs an idle server with no lock holder, so it never prints the holder line; box 3 rests on the 9 unit tests of stopHolderFromLog (read whole by the main agent: real format, format read from alcore.rs, unknown, no tail, first of two, holder containing 'waiting on') and on the message composition in stopServer. The box text says 'after 10s'; the CLI waits 15 s.

## Notes

2026-11-19T01:25:02+0100 main agent: removed from TRDD-HSPUF5XH blocked-by as RISK ACCEPTED. The line with its failure mode and whether the mechanism existed at v2.33.1 is in HSPUF5XH, section 'Release list decision 2026-11-19'. This card stays open; only the release gate changed.
