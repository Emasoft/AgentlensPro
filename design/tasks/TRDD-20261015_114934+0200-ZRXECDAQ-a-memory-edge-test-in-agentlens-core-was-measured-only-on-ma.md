---
trdd-id: ZRXECDAQ
title: A memory-edge test in agentlens-core was measured only on macOS and runs in CI on Linux
column: todo
status: tasked
created: 2026-10-15T11:49:34+0200
updated: 2026-10-15T13:45:29+0200
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

## Results

2026-10-15 — b4cdf24c on linux/amd64 (image rust:1, rustc 1.99.0, Debian trixie, emulated on an aarch64 host, source from git archive): the memory-edge test passed 5 of 5 isolated and 5 of 5 module runs (reports_dev/linux-memory-edge.md).
2026-10-15 — 6afa002b, same setup, rebuild proven (Compiling agentlens-core after cargo clean -p agentlens-core): 5 of 5 isolated and 5 of 5 module runs (11 tests) (reports_dev/linux-memory-edge-6afa002b.md).
2026-10-15 — Fresh-store probe on 6afa002b, 3 runs per limit: the old query ran out of memory at 5120-8192 KiB, did so in only 1 of 3 runs at 8448 KiB (passed 2 of 3), and passed from 8704 KiB; demote_cold(1) failed at 5120 and 6144 KiB and returned Ok(49) from 7168 KiB. On Linux the test setting of 8 MiB therefore has at most 256 KiB of headroom on the old-query side, and the transition there is not deterministic.

## Notes

2026-10-15 — Decision pending measurement: move the test limit off the old-query edge. The value comes from a probe of the test s own one-store sequence at 6656-8448 KiB on Linux and macOS, choosing the limit with the largest smaller margin; two reviews required the in-sequence probe because the fresh-store demote edge does not carry over. The box stays unticked until the new limit passes on both platforms at the final commit, including full lib runs in the container. Emulated Debian is not the native ubuntu-latest runner; the first CI run is the only real check.
