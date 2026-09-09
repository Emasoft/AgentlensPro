---
trdd-id: 4EV3OJ19
title: The setup self-test revives alcore on the default ports because execRegisteredCommand pins the data dir but not the ports
column: todo
created: 2026-09-09T12:18:08+0200
updated: 2026-09-09T12:31:42+0200
current-owner: main
task-type: bugfix
min-approval-requirement: none
project-id: agentlenspro
scope: project
labels: [cli, setup, hooks, ports, leak]
blocked-by: []
npt: []
eht: []
implementation-commits: []
relevant-rules: []
related: [YGEV6QDD, 81BW1CS9]
---

## Why

`agentlenspro setup`'s self-test can revive a daemon on the DEFAULT ports
(3000/4316/4318) instead of the ports the setup itself converged to, because
the environment used to run the registered hook command pins the data dir but
not the ports. A revived daemon on default ports then silently captures real
hook traffic meant for the user's real `~/.agentlens` collector.

## Evidence

VERIFIED first-hand 2026-09-09:

- `src/cli/setup.ts:285-311` — `execRegisteredCommand` spreads `process.env`
  (line 287) and explicitly pins only `HOME`, `AGENTLENS_DATA_DIR`, and
  `AGENTLENS_UI_URL`. It does **not** pin `UI_PORT` / `MCP_PORT` / `OTLP_PORT`.
- `src/cli/serverControl.ts:149-157` — `alcoreServeArgs(env = process.env, dir
  = dataDir())` reads `OTLP_PORT` / `UI_PORT` / `MCP_PORT` from `env` with
  defaults 4318/3000/4316.
- `src/cli/hookHandlers.ts:138-212` — on a failed hook POST, the handler calls
  `reviveDaemonDetached()` (brake: `AGENTLENS_NO_REVIVE` at line 166), which
  spawns `alcoreServeArgs()` with NO env argument at line 197, so the child's
  ports come from the hook process's own env.
- `src/cli/setup.ts:923-929` — setup's OWN server spawn DOES pin `UI_PORT` /
  `MCP_PORT` / `OTLP_PORT` from `ctx` into `spawnEnv` and passes
  `alcoreServeArgs(spawnEnv, ctx.dataDir)` — the pin exists one function over.
- Measured consequence: during a test run on 2026-09-08 22:43 a fixture setup
  revived pid 68584 (`al-setup-OYnBpx`) on port 3000, which then captured
  ~100 MB of REAL hook traffic meant for `~/.agentlens` for 13+ hours
  (TRDD-YGEV6QDD, TRDD-81BW1CS9). The test suite now brakes the revive
  (commit e56795ae), but a REAL `agentlenspro setup` run with custom
  (non-default) ports has the identical hole: its self-test's revive path
  would land on the default ports, not the ports the run just converged to.
- `rust-core/crates/agentlens-core/src/pid_lock.rs:43-48` — `format_pid_lock`,
  both arms: a bare pid when the start reference is unknown, else
  `{"pid","start"}`; no port field in either shape. TS side:
  `src/serverRuntime.ts:104-106` `formatPidLock` has the same two shapes and
  no non-test caller; no `.ts` under `src/` or `standalone/` writes
  `server.pid` (swept: the literal, sync and async `writeFile`, and every
  `pidfilePath()` call site — readers only, at `serverControl.ts:444,639`,
  `hookHandlers.ts:120`, `setup.ts:838`); the `standalone/server.ts` CLAUDE.md
  names no longer exists. So a port record in the data dir would have to be
  ADDED — nothing writes one today.
- Rejected alternative (adversarial review, 2026-09-09): setting
  `AGENTLENS_NO_REVIVE` unconditionally inside `execRegisteredCommand` — on a
  real user's `HOME`, a revive triggered by the self-test's own hook call is
  actually the correct/working collector; the defect is specifically the
  MISSING port pins, not the revive mechanism itself.

INFERRED (never observed):

- A real `agentlenspro setup` run with custom ports reviving on the defaults
  (follows from the three verified bullets above; nobody ran it).
- Whether the production hook path (Claude Code's own hook env) carries the
  ports depends on what setup writes into settings.json's env block, not
  checked.

## Proposed change

(1) Caller pin, minimal: in `execRegisteredCommand` add the same three port
pins `setup.ts:923-925` already applies to setup's own spawn. Closes only
this caller.

(2) Shared-function fix, root cause: `reviveDaemonDetached()` derives ports
from env because nothing in the data dir records them (the pidfile carries pid
and start only — see Evidence) — add a data-dir-scoped port record written by the
server at boot and read by the revive, so every caller (setup self-test, the
real Claude Code hook) revives on the ports the data dir's server used.

Choose (2) if a port record is cheap to add; otherwise (1) now and (2) as a
follow-up. Adversarial review 2026-09-09: (1) alone leaves the identical hole
on every other exec of the registered hook.

## Acceptance

A test that:
1. Runs `setup` with non-default fixture ports.
2. Forces the self-test's hook POST to fail (triggering the revive path).
3. Asserts the revived child process's argv carries the fixture ports — or,
   with the revive brake left off, that no child process appears bound to
   port 3000.
4. The chosen shape is named in this card before implementation, with the
   reason.

## Notes and lessons learned
