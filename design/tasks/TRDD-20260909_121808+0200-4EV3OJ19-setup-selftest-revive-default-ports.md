---
trdd-id: 4EV3OJ19
title: The setup self-test revives alcore on the default ports because execRegisteredCommand pins the data dir but not the ports
column: todo
created: 2026-09-09T12:18:08+0200
updated: 2026-09-09T12:18:08+0200
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

## Evidence (VERIFIED first-hand by the coordinator this session)

- `src/cli/setup.ts:285-311` — `execRegisteredCommand` spreads `process.env`
  (line 287) and explicitly pins only `HOME`, `AGENTLENS_DATA_DIR`, and
  `AGENTLENS_UI_URL`. It does **not** pin `UI_PORT` / `MCP_PORT` / `OTLP_PORT`.
- `src/cli/hookHandlers.ts:138-232` — on a failed hook POST, the handler calls
  `reviveDaemonDetached()` (brake: `AGENTLENS_NO_REVIVE=1` at line 166), which
  spawns `alcore serve` via `alcoreServeArgs()`. That function reads the ports
  from env, so with no port env vars set it falls back to the defaults
  (3000/4316/4318), while still receiving the setup's own `--data-dir`.
- Measured consequence: during a test run on 2026-09-08 22:43 a fixture setup
  revived pid 68584 (`al-setup-OYnBpx`) on port 3000, which then captured
  ~100 MB of REAL hook traffic meant for `~/.agentlens` for 13+ hours
  (TRDD-YGEV6QDD, TRDD-81BW1CS9). The test suite now brakes the revive
  (commit e56795ae), but a REAL `agentlenspro setup` run with custom
  (non-default) ports has the identical hole: its self-test's revive path
  would land on the default ports, not the ports the run just converged to.
- Rejected alternative (adversarial review, 2026-09-09): setting
  `AGENTLENS_NO_REVIVE` unconditionally inside `execRegisteredCommand` — on a
  real user's `HOME`, a revive triggered by the self-test's own hook call is
  actually the correct/working collector; the defect is specifically the
  MISSING port pins, not the revive mechanism itself.

## Proposed change

One place: in `execRegisteredCommand` (`src/cli/setup.ts`), pin `UI_PORT`,
`MCP_PORT`, `OTLP_PORT` from `ctx` (the same ports setup already converged to)
alongside the existing `HOME` / `AGENTLENS_DATA_DIR` pins, so any revive
triggered from inside the self-test targets the same ports as the rest of the
run.

## Acceptance

A test that:
1. Runs `setup` with non-default fixture ports.
2. Forces the self-test's hook POST to fail (triggering the revive path).
3. Asserts the revived child process's argv carries the fixture ports — or,
   with the revive brake left off, that no child process appears bound to
   port 3000.

## Notes and lessons learned
