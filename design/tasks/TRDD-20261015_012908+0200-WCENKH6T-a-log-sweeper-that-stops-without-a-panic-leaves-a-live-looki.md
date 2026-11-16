---
trdd-id: WCENKH6T
title: A log-sweeper that stops without a panic leaves a live-looking collector that nothing restarts
column: plan
status: tasked
created: 2026-10-15T01:29:08+0200
updated: 2026-10-28T20:47:52+0100
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
npt: [H3D5ZBO1]
---

# A log-sweeper that stops without a panic leaves a live-looking collector that nothing restarts

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-10-28

- Column plan. npt H3D5ZBO1 (burn-tick bodies.poll lock hold) must land first; its own review round 1 is done and the revised design is pending round 2.
- NEXT ACTION: after H3D5ZBO1 lands, re-propose this card for review round 2 with: process-level FIFO test (real binary), FATAL line with phase label + non-blocking try_lock probe, limit passed through the watchdog constructor (no env var), `stopping` set on every stop path, and ONE chosen restart-loop protection (candidates in Review round 1).
- SUPERSEDED: the "Proposal 2026-10-28" section's pure-function-only test, the AGENTLENS_SWEEPER_STALL_MS env var, and the "beat before/after restore" item (boot finishes before start_sweeper returns, log_reader.rs:1751).
- Boot-phase hang is out of scope: TRDD-LK8JE8MK.

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

## Review round 1 2026-10-28

MEASURE: docs_dev/20261028_204123+0100-WCENKH6T-measure.md. Revive is pidfile-only and fires only on a failed hook delivery (hookHandlers.ts:118-133, 334, 463); the hook revive is the only restarter unless the opt-in `daemon install` LaunchAgent (com.agentlens.collector, KeepAlive) is present, so with zero Claude sessions a watchdog exit stays down until the next session's hook.
MEASURE: restart throttle REFUTED for watchdog exits: lifetime > REVIVE_CRASH_WINDOW_MS (5 min, hookHandlers.ts:156) is never a quick death and resets backoff (:266), so a deterministic stall would restart at most once per (stall limit + boot time) while Claude sessions emit hooks, unthrottled; with no session the restart is delayed indefinitely.
MEASURE: boot (restore + boot sweep) completes before start_sweeper returns (log_reader.rs:1751), so the watchdog cannot false-positive at boot, and a boot-phase hang is not covered (split to its own TRDD).
MEASURE: the largest measured false-positive source (other unbounded state-lock holders: durable.tick, ingest_chunk/demote_cold, run_1h_backfill_step — not measured) is the burn tick holding the state lock 130-576 s on first pass (TRDD-H3D5ZBO1, ui.rs:4425-4433) while sweeper lock_timed waits queue behind it with no beat; 576 s vs 900 s is a 36% margin, measured on a 2026-10-18 sample (588k body files, that day's load) that scales with store size and load. Hence npt H3D5ZBO1.
REVIEW blocking, accepted: (1) restart premise unverified -> now measured as above; (2) no restart-loop protection -> CANDIDATES for round 2, not yet decided: (a) an in-alcore stall-exit counter (<dataDir>/sweeper-stall-count) that after N consecutive stall exits stops exiting — open question: staying alive recreates the non-ingesting zombie this card exists to prevent; (b) teach the hook revive backoff (src/cli/hookHandlers.ts) to count a watchdog stall exit as a quick death; (3) pure check_liveness test cannot detect wiring bugs and acceptance 2 is unmet -> add a process-level test (real binary, log root = FIFO with no writer, short limit via constructor, assert exit 1 + FATAL line), amend acceptance text only if the FIFO test genuinely fails to work; (4) exit erases the culprit -> FATAL line must carry a phase-label atomic and a non-blocking try_lock probe of the state mutex.
REVIEW non-blocking, accepted: drop the AGENTLENS_SWEEPER_STALL_MS env var (same pattern 2294f718 removed), pass the limit through the watchdog constructor; set `stopping` before every stop path (alcore.rs:590) and test graceful stop exits 0.
REVIEW non-blocking, deferred with reason: progress (offsets advanced) vs liveness beat - a liveness beat matches the live failure (hang); revisit if a stuck-but-beating case is observed. Exit also takes down OTLP/UI/API (larger blast radius than the sweeper) - AGENT decision (main-agent, 2026-10-28), not a user decision — open to user veto; status quo for any alcore crash.
NEXT: implement H3D5ZBO1 first, then re-propose this card with the four revisions above for review round 2.
REVIEW non-blocking, deferred with reason: the file-watcher thread dying or hanging is not covered; the 60 s full-rescan backstop (FULL_RESCAN) still sweeps every path, so loss is latency only, not ingestion.
