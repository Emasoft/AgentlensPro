---
trdd-id: CQ4652DQ
title: alstore pass runs DuckDB at an 8GB limit and 4.8GB RSS
column: testing
status: tasked
created: 2026-10-21T00:08:24+0200
updated: 2026-10-21T01:15:04+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: manager
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-21T00:08:24+0200
---

# alstore pass runs DuckDB at an 8GB limit and 4.8GB RSS

## Approval log

- 2026-10-21T00:08:24+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-21T01:15:04+0200 — column → testing by main-agent@agentlenspro. the fix is implemented and all three checks pass

## Measurement

The alstore CLI opened its store with DEFAULT_MEMORY_LIMIT (8GB) and available_parallelism() threads (alstore.rs:105-106), while the in-process server path had already moved to SERVER_MEMORY_LIMIT (512MiB) + threads=2 for the same reason (chores.rs:351, TRDD-768NEX6E).
A live drain pass held 4,880,368 KB RSS (4.65 GiB) and the janitor memory-guard logged it as the largest process on a 64 GB box with 99 MB free memory (daemon.log:5227, 2026-10-20T23:53:51).

## What and why

The CLI now runs at CLI_MEMORY_LIMIT = 1GiB with CLI_THREADS = 2, overridable by AGENTLENS_DUCKDB_MEMORY_LIMIT and AGENTLENS_DUCKDB_THREADS; an unusable override falls back to the bounded default WITH a message, never to 8GB and never to a panic.
1GiB and 2 threads because the CLI is standalone (no 2048 MB server cap to fit under) yet must be bounded, and 2 threads is the measured in-process precedent; the value is an operator-overridable escape hatch for a deliberate bulk backfill, so a fixed low ceiling cannot wedge a backfill.

## Why the process restarts

NOT a crash-loop: the drain script runs ONE alstore pass per invocation, so a new pid is the next pass of the same loop, and the pid change 78007 -> 79875 -> 62722 -> 30238 is that normal turnover (reports_dev/drain-loop.log grew to pass=138 with no gap).
TWO REAL KILLS DID OCCUR, both status=137 (SIGKILL) with no stderr, at passes 120 and 121 (dur=131s and 176s): an EXTERNAL kill, since no in-process memory ceiling exists on the alstore path (rss_guard lives in agentlens-core and is armed by alcore, not by the CLI).
The SIGKILL SENDER IS NOT ESTABLISHED. Ruled out with evidence: the janitor memory-guard (it logged the alstore as a Tier-1 REFUSAL, never killing it), the alcore RSS guard (armed on the server, not the CLI; the log shows alcore exiting 1, not the CLI), Activity Monitor (it was killing SubEthaEdit and its helpers in that window, no alstore kill in the unified log), and macOS jetsam (no JetsamEvent report in the window; the one from 12:08 names WindowServer and contains no alstore).
WHAT IS MEASURED: the machine was under extreme pressure (the janitor logged free memory at 99-348 MB with the alstore as the largest process), so an OS-level resource kill under that pressure is the remaining candidate, and this fix removes the 4.8 GB contributor.

## Tests

New rust-core/crates/agentlens-store/tests/cli_sizing.rs, 8 tests: the_default_cli_limit_is_bounded, no_env_override_uses_the_bounded_default, a_valid_env_override_is_honoured, an_unparseable_memory_limit_falls_back_to_the_bounded_default_with_a_message, an_unparseable_thread_count_falls_back_to_the_bounded_default_with_a_message, an_empty_value_is_an_absence_not_an_error, a_value_carrying_a_quote_is_rejected, the_resolved_limit_is_the_limit_duckdb_reports.
The env-var parse takes a &HashMap<String,String>, never std::env, so it does not race the parallel cargo test threads (the repo precedent is chores.rs hook_events_retention_days).

## Collateral

tests/pass.rs had a PRE-EXISTING defect that broke the required clippy gate: commit df7daf65 accidentally dropped the #[test] attribute from legacy_stranded_name_drains_through_the_gate_and_the_parked_set_reaches_zero, leaving it as dead code. The attribute is restored; the test passes (10 passed, 0 failed).
