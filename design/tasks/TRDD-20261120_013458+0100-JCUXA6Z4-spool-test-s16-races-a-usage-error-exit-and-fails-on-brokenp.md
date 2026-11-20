---
trdd-id: JCUXA6Z4
title: spool test s16 races a usage-error exit and fails on BrokenPipe
column: testing
status: tasked
created: 2026-11-20T01:34:58+0100
updated: 2026-11-20T02:21:11+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
scope: project
project-id: agentlenspro
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-20T01:34:58+0100
---

# spool test s16 races a usage-error exit and fails on BrokenPipe

CI run 44643561993 (commit a55074a8, docs-only) failed the rust job: s16_a_failed_seal_after_the_write_exits_2_and_keeps_the_line panicked at crates/agentlens-spool/tests/spool.rs:63:50 with BrokenPipe. Cause, read in code: the test helper spawn_append_with writes stdin with write_all(...).unwrap() after spawn; the s16 call with --seal-bytes lots makes alspool exit 64 at alspool.rs:50, before it reads stdin at alspool.rs:54. When the child exits first, the write gets EPIPE and the unwrap panics. The same job passed on 4aee03be. Fix: the helper must tolerate BrokenPipe on the stdin write (a child may exit before reading stdin on a usage error) and let the exit-code assertion decide; add a WHY comment. Acceptance: s16 passes; the helper still panics on any other write error.

## Approval log

- 2026-11-20T01:34:58+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Process log

2026-11-20: which s16 call panicked is INFERRED from code order (alspool.rs:50 exits 64 on --seal-bytes lots before the stdin read at :54); the CI log only shows the panic at spool.rs:63:50, a helper all three s16 calls share. Frequency: 1 of the 2 failed rust jobs checked. The other one (run 44604988809 on f9d5dc47) failed burnguard_parity.rs:41, a different test. The release merges on the green rerun (attempt 2 of run 44643561993), not on a first-attempt green; the release report says so.
2026-11-20: fix applied in rust-core/crates/agentlens-spool/tests/spool.rs spawn_append_with (single hunk: tolerate BrokenPipe on the stdin write, assert any other error kind). Worker run: spool tests 19/19 and clippy -D warnings exit 0 (no-regression only). Premise proven deterministically by the main agent: target/debug/alspool append --seal-bytes lots fed 4 MiB on stdin exits 64 with the usage message and the writer gets BrokenPipe, so the child exits without reading stdin, the exact error kind the helper now tolerates. A 200-run loop of s16 is running as a further no-regression check.
2026-11-20: s16 passed 200 of 200 local runs (no-regression only: the 9-byte write almost never loses the race locally). The helper's BrokenPipe branch has not yet executed in Rust; the premise is proven (alspool exits 64 before reading stdin, a 4 MiB Python writer gets BrokenPipe). NEXT: add one deterministic case that sends more than 64 KiB through spawn_append_with with --seal-bytes lots and expects exit 64, so the branch runs on every test run.
