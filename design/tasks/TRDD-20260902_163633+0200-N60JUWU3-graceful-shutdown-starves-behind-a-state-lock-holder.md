---
trdd-id: N60JUWU3
title: The graceful shutdown needs the state lock and has no timeout, so a long holder starves the stop into a SIGKILL
column: todo
created: 2026-09-02T16:36:33+0200
updated: 2026-09-02T16:36:33+0200
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
call and being called continuously, the stop never got its turn. It was SIGKILLed at 16:34:22,
losing at most the last 5 s of spans (the chores tick is the durability boundary per the comment
at that site), the statusline buffer, the account-timeline window, and the "clean stop" lifecycle
marker (the next boot classifies the gap as a crash).

The holder thread's frames were NOT captured — the `sample` grep for `agentlens_core::` symbols
matched nothing, so "starved behind ui.rs:560" is inferred from the shutdown code path, the
all-workers-waiting sample, and the 145 s wait line naming 560, not from a stack of the holder.

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
