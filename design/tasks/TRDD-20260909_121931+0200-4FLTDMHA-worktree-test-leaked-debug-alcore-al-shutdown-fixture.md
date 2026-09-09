---
trdd-id: 4FLTDMHA
title: A worktree test run leaked a debug alcore on an al-shutdown fixture that survived three days
column: todo
task-type: bugfix
min-approval-requirement: none
current-owner: main
project-id: agentlenspro
scope: project
labels: [test, leak, worktree]
related: [YGEV6QDD]
blocked-by: []
npt: []
eht: []
implementation-commits: []
relevant-rules: []
created: 2026-09-09T12:19:31+0200
updated: 2026-09-09T12:23:20+0200
---

# A worktree test run leaked a debug alcore on an al-shutdown fixture that survived three days

## Why

Measured in the 2026-09-09 12:07 post-run process snapshot (`reports_dev/unit8-ps-after.txt`):
pid 2218, elapsed `03-08:17:51`, argv `<repo>/.claude/worktrees/agent-a7d79196282fd6298/rust-core/target/debug/alcore serve --data-dir /var/folders/…/T/al-shutdown-2141-…`; a DEBUG build from a
worktree agent's run, alive for three days; origin test NOT identified; MECHANISM NOT
ESTABLISHED (a test that spawns the server itself and skips teardown is at least as likely as
the hook-revive path TRDD-YGEV6QDD diagnoses).

Next: grep `al-shutdown` under `rust-core/crates/*/tests/` FIRST (a DEBUG build from
`rust-core/target/debug` points at a Rust integration test run by `cargo test`), then
`src/test/`, to find the suite; add teardown or the `assertNoSurvivingServer` tripwire
(`src/test/helpers/noSurvivingServer.ts`).

## Acceptance

- [ ] The suite is identified by file:line.
- [ ] A run of it leaves no `alcore serve` process younger than the run.
- [ ] pid 2218 is stopped (inside the TRDD-5JZQFVO8 deploy, on the owner's word).

## Notes and lessons learned

## Approval log
