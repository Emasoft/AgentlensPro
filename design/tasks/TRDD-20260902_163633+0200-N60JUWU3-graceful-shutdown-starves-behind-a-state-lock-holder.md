---
trdd-id: N60JUWU3
title: The graceful shutdown needs the state lock and has no timeout, so a long holder starves the stop into a SIGKILL
column: todo
created: 2026-09-02T16:36:33+0200
updated: 2026-09-02T16:46:41+0200
current-owner: main-session
task-type: bugfix
priority: high
min-approval-requirement: none
created-by: UTFVMVT8
related: [UTFVMVT8, 2R36W8Q1, HFV4AIT7]
---

# The graceful shutdown needs the state lock and has no timeout, so a long holder starves the stop into a SIGKILL

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
16:43. Thirty minutes of OTEL-only detail across the active sessions is gone at the SOURCE: the
holds at the composition guard reached 82 / 85 / 67 s from about 16:10 (TRDD-UTFVMVT8), the OTLP
handler waited 145 s behind them, the exporters timed out and dropped their batches
(`droppedOnFailure` on the server is 0 — nothing was refused, it never arrived), and they resumed
only at 16:43, nine minutes after the new binary was serving OTLP again in 0.5 ms — an exporter
back-off, inferred from the timing, not read from the exporters. Claude-session spans backfill from
the JSONL transcript (log wins on collision); the `cost_usd`-class OTEL-only fields in that
interval do not. This is the actual size of the incident this card and UTFVMVT8 describe.

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
