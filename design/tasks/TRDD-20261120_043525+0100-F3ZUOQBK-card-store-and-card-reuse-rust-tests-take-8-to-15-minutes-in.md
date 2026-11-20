---
trdd-id: F3ZUOQBK
title: card_store and card_reuse rust tests take 8 to 15 minutes in CI
column: backburner
status: tasked
created: 2026-11-20T04:35:25+0100
updated: 2026-11-20T04:35:25+0100
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
approval-datetime: 2026-11-20T04:35:25+0100
---

# card_store and card_reuse rust tests take 8 to 15 minutes in CI

Measured in three CI rust jobs (reports_dev/2LXKMRE3/joined.txt): tests/card_store.rs 361 s, 564 s, 686 s; tests/card_reuse.rs 122 s, 180 s, 215 s. Every other test binary takes under 65 s. Together they are the largest part of the Tests step once spool_tap stops rebuilding aldigest (TRDD-2LXKMRE3). Hypothesis, NOT measured: bundled DuckDB is compiled at -O0, because rust-core/Cargo.toml [profile.dev] sets no opt-level for dependencies, and the slow tests (a_restore_sized_bulk_load_stays_inside_the_memory_limit, a_refused_reuse_ignores_read_positions_that_ran_ahead_of_the_card_snapshot) are DuckDB-heavy. Next: on one machine, time those two test files before and after [profile.dev.package.libduckdb-sys] opt-level = 2 (or 1), and record compile-time and target-size cost too (TRDD-2C23ROPZ bounds dev-build disk writes; an opt-level change also rotates the CI cache key and slows every cold compile). Change the profile only if the measurement shows a clear runtime win that outweighs the compile cost.

## Approval log

- 2026-11-20T04:35:25+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
