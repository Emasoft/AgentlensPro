---
trdd-id: WCENKH6T
title: A log-sweeper that stops without a panic leaves a live-looking collector that nothing restarts
column: plan
status: tasked
created: 2026-10-15T01:29:08+0200
updated: 2026-10-28T04:14:33+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-15T01:29:08+0200
project-id: agentlenspro
---

# A log-sweeper that stops without a panic leaves a live-looking collector that nothing restarts

## Problem
The hook revive is pidfile-only (src/cli/hookHandlers.ts:108-133, `pidfileOwnerAlive()`): it replaces a server only when its process is dead. If the log-sweeper thread stops in steady state WITHOUT the process dying (a panic today, or after TRDD-DA0GN1CS commit 2 a loop `break`, an `Err` return, a thread hung on I/O or starved behind a lock), ingestion stops while the process looks alive, and nothing restarts it. TRDD-DA0GN1CS covers only the panic path. Raised by the adversarial review of the DA0GN1CS proposal (2026-10-15).

## Fix direction
A sweeper heartbeat timestamp (or `JoinHandle::is_finished()`) checked by the main thread or a chore; a stale heartbeat logs and exits the process so the revive restarts it. Mind the first-pass lock holds measured in TRDD-H3D5ZBO1 (130-576 s) when choosing the staleness limit.

## Acceptance
- [ ] A sweeper that stops without a panic is detected within a stated bound, and the process exits with a log line naming the cause.
- [ ] A test stops the sweeper thread without a panic and asserts the exit.

## Approval log

- 2026-10-15T01:29:08+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Proposal 2026-10-28

- Analysis (read-only, docs_dev/20261028_041400+0100-WCENKH6T-proposal.md): still open. install_exit_on_panic (542ceca2) covers panics only. The sweeper thread is unmonitored in steady state (log_reader.rs:1530, alcore.rs:391,436). The live non-panic failure is a HANG (blocking I/O, state.lock_timed with no bound, stuck DuckDB/watcher call); a thread that returns is latent (only Stop/Disconnected return today).
- Proposed fix: a heartbeat (Arc<AtomicU64>) beaten at the top of the sweeper loop, per ingest chunk and after each sweep_paths, plus a finished flag set by a drop guard; a std::thread "sweeper-watchdog" in alcore.rs (no tokio, never takes the state lock) checks every 10 s and calls libc::_exit(1) after a FATAL stderr line when the thread finished without a stop request or the heartbeat is older than SWEEPER_STALL_LIMIT (default 900 s); skipped under --no-log-scan.
- Test: unit test of a pure check_liveness(liveness, limit) -> Option<Cause> (Exited, Stalled, None while beating, None when stopping); acceptance 2's process-level variant would need a test-only stop hook, owner to decide.
- Strongest reason not to: a false positive kills a healthy collector and a long first pass could cause a restart loop; also unverified that the hook revive restarts a dead pid promptly (src/cli/hookHandlers.ts:108-133 not re-read).
- Status: proposal only; needs the propose-then-review round (MEASURE + REVIEW) before any code. Deploy remains blocked by TRDD-12FGMAEP.
