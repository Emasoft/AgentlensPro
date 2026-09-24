---
trdd-id: 5IDBAJ6O
title: hookScripts.test.ts server-down tests could revive a real alcore on the real data dir
column: dev
created: 2026-09-22T23:51:29+0200
updated: 2026-09-24T08:58:55+0200
current-owner: agentlenspro-main-session
created-by: agentlenspro-main-session
task-type: bugfix
min-approval-requirement: none
assignee: agentlenspro-main-session
mandate: true
mandated-by: none
approved: true
approval-judge: agentlenspro-main-session
approval-datetime: 2026-09-22T23:51:29+0200
implementation-commits: [7734c1ff, 091799ee, 668b7889, dd63e56d]
---

# hookScripts.test.ts server-down tests could revive a real alcore on the real data dir

## Approval log

- 2026-09-22T23:51:29+0200 — MANDATE issued by agentlenspro-main-session (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Why

Owner order 2026-09-22: fix the tests to avoid interfering with the actual alcore server. Investigated an observation that a process bin-native/darwin-arm64/alcore serve --data-dir <real home>/.agentlens ... --otlp-port 4318 --ui-port 3000 --mcp-port 4316 appeared during a full npx mocha run and is now the live production server.

## Evidence (VERIFIED)

1) The real production alcore server on this machine is in a STANDING crash-loop unrelated to any test: ~/.agentlens/server.log carries 40160+ 'thread log-sweeper panicked ... DuckDBFailure ... Out of Memory Error: failed to pin block of size 256.0 KiB (255.8 MiB/256.0 MiB used)' entries and 40490+ '[AgentlensPro] boot provenance: started-by=hook-revive' lines — every boot on this machine right now is a hook-triggered revive of a server that keeps dying. Every one of the PIDs seen churning in ps snapshots during this investigation (e.g. 67981, 85892, 41266, 45217, all PPID=1, all logged started-by=hook-revive) is this same ongoing crash+revive cycle, driven by src/cli/hookHandlers.ts forwardHookEvent() -> reviveDaemonDetached(), fired by THIS Claude Code session's own PreToolUse/PostToolUse hooks on every tool call (ps included) -- entirely independent of whether mocha runs. This is H2, confirmed, and it is the dominant explanation for the PID churn described in the assignment. 2) Separately, a genuine H1-class defect was found and fixed: src/test/hookScripts.test.ts's baseEnv() (used by 'hook: a server that HANGS' and 'hook-fail-open-server-down') only overrides AGENTLENS_UI_URL/AGENTLENS_GATE*, leaving HOME/DATA_DIR/UI_PORT/MCP_PORT/OTLP_PORT at their real ambient values. Those two tests deliberately fail the hook's POST, so on failure forwardHookEvent() falls through to reviveDaemonDetached(), which reads dataDir()/alcoreBin() from the UNISOLATED env -- a real detached alcore serve against the developer's REAL ~/.agentlens on the default ports 3000/4316/4318, exactly like TRDD-YGEV6QDD's already-fixed hot-path-latency leak and TRDD-4EV3OJ19's port-pin gap. It only fires when the real server happens to be down at that moment (pidfileOwnerAlive() short-circuits otherwise) -- which the standing crash-loop above makes a real, frequent window. 3) Every OTHER test file that spawns standalone/cli.js or a real alcore binary was audited (serverSingleInstance, serverStopBoundedWait, setupVerb, cliHotPathLatency, ramdiskSpool, killSwitch, ctxvisCliHonesty, cliDispatch, alcoreCutover) and already isolates via a per-test HOME + DATA_DIR + free ports, or (cliUsageContract.test.ts) never reaches dataDir()/alcoreBin() at all because the spawned arg set throws a UsageError first.

## Fix

src/test/hookScripts.test.ts baseEnv() now sets AGENTLENS_NO_REVIVE='1' unconditionally (the file never tests revive behavior, only fail-open exit code / latency), braking reviveDaemonDetached() the same way TRDD-YGEV6QDD's fix did for cliHotPathLatency.test.ts. Verified: pnpm run check-types 0, pnpm run lint 0 errors, pnpm run check-identities 0, pnpm run compile-tests 0. Full npx mocha before/after: the live production server (pid churning under the standing crash-loop, see Evidence) was left running and untouched throughout -- its server.pid changed only because of the ongoing hook-revive crash-loop (boot provenance still reads started-by=hook-revive on every restart during and after the run), never because a test signalled or reached it. Suite: 2829 passing / 17 pending / 7 failing (same 7-total-failure baseline modulo one pre-existing flaky LogReader timing test swapping in for review-supervisor, which now passes).

## Out of scope -- flag for a separate card

The DuckDB OOM crash-loop itself (card_store.rs:168, 'failed to pin block of size 256.0 KiB (255.8 MiB/256.0 MiB used)') is a severe standing production defect in the real alcore server, unrelated to the test suite, and outside this task's hard limits (no server stop/restart/signal). It deserves its own incident card and a memory-limit/log-sweeper fix in rust-core; not carded here to avoid scope creep on a test-isolation task.

## Adversarial review disclosure

Review fork findings and disposition: (1) AGENTLENS_NO_REVIVE is now set for ALL tests in hookScripts.test.ts, not just the two server-down tests -- ACCEPTED, not changed: the var only gates the revive spawn, so it is a no-op for the four happy-path tests; a per-test override is more legible but is 2 extra lines for zero behavior difference, and the shared comment already states which tests it protects. (2) pidfileOwnerAlive() runs BEFORE the AGENTLENS_NO_REVIVE check in reviveDaemonDetached(), so every test in the file still performs a READ of the real ~/.agentlens/server.pid even with the brake set -- CONFIRMED true, ACCEPTED as out of scope: it is a stat()+read, never a write/spawn/signal, so it does not interfere with the live server in the sense this task is scoped to (no process is stopped, started, or touched). (3) No new mocha assertion guards the fix itself (verified only by manual ps/log inspection, not by a suite-run regression check) -- ACCEPTED gap, not fixed: adding an assertNoSurvivingServer-style check to this file is a reasonable follow-up but was not requested and is not needed to close the observed bug. (4) The reviewSupervisorRunner fixture's prompt is a minimal single-line string, not a realistic multi-paragraph brief -- ACCEPTED nuance: the fix is verified against the marker contract (declaredRole's regex), not against arbitrary real-prompt shapes; no defect found, scope of the verified claim narrowed to match.
The AGENTLENS_NO_REVIVE brake stops only the spawn: reviveDaemonDetached writes <dataDir>/.daemon-revive.lock and the failed hook spools its event BEFORE the brake check (hookHandlers.ts ~151-167), so the server-down tests still write into the real data dir; the fix is default isolation of HOME/DATA_DIR/ports in src/test/setup.js. Attribution of the observed production process is UNDETERMINED (PPID 1 and started-by=hook-revive are produced by both a session hook and these tests).

## Update

Default isolation landed in 091799ee (setup.js: temp HOME/DATA_DIR, scrubbed endpoints, sync ports, global NO_REVIVE, containment guard). VERIFIED by the orchestrator: check-types, check-identities, setup.js parses, no stray fixture. REPORTED by the worker, not re-run by the orchestrator: suite 2832/17/6, lint, real-corpus read-only (confirmed on both sides only for OpenCode). The guard is detective, not preventive (a test that points DATA_DIR at a real dir and restores it within itself is invisible to it). A spawn-env audit and a live-tmp-server clause are in progress (round 4).
In commit 668b7889's message, the 92-call-site spawn audit and the mutation-check result are the workers' reports, not re-run by the orchestrator (who verified check-identities, zero username hits, and that setup.js parses).
