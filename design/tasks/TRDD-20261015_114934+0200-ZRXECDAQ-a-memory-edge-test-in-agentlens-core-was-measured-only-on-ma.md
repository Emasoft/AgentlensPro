---
trdd-id: ZRXECDAQ
title: A memory-edge test in agentlens-core was measured only on macOS and runs in CI on Linux
column: todo
status: tasked
created: 2026-10-15T11:49:34+0200
updated: 2026-10-15T11:53:14+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-15T11:49:34+0200
---

# A memory-edge test in agentlens-core was measured only on macOS and runs in CI on Linux

## Problem
demote_cold_succeeds_where_the_old_one_shot_query_runs_out_of_memory (card_store.rs mod tests, from f9e0742e, TRDD-KMF02UEX) asserts behaviour at 8 MiB with about 1 to 2 MiB of margin on each side on a 1 MiB grid (old query fails through 8 MiB and passes at 9; demote_cold succeeds from 7 and fails at 6; 1 KB timeline entries, spilling off), measured only on macOS with DuckDB 1.10506.0. CI runs cargo test --workspace on ubuntu-latest (.github/workflows/ci.yml:299), where the window was never measured; if it moves, CI goes red and the release gate with it.

## Fix direction
Run the test repeatedly in a Linux container. If the window holds there, record the runs; if not, restructure the test so it does not depend on an allocator edge (the deterministic unique-index failure used by commit 3f152419 is one model).

## Acceptance
- [ ] The test is run at least 5 times on Linux with the CI toolchain and either passes every time (runs recorded) or is restructured to a platform-independent failure.

## Approval log

- 2026-10-15T11:49:34+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
