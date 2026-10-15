---
trdd-id: ZRXECDAQ
title: A memory-edge test in agentlens-core was measured only on macOS and runs in CI on Linux
column: complete
status: archived
created: 2026-10-15T11:49:34+0200
updated: 2026-10-15T14:24:11+0200
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
implementation-commits: [f7a4945a]
---

# A memory-edge test in agentlens-core was measured only on macOS and runs in CI on Linux

## Problem
demote_cold_succeeds_where_the_old_one_shot_query_runs_out_of_memory (card_store.rs mod tests, from f9e0742e, TRDD-KMF02UEX) asserts behaviour at 8 MiB with about 1 to 2 MiB of margin on each side on a 1 MiB grid (old query fails through 8 MiB and passes at 9; demote_cold succeeds from 7 and fails at 6; 1 KB timeline entries, spilling off), measured only on macOS with DuckDB 1.10506.0. CI runs cargo test --workspace on ubuntu-latest (.github/workflows/ci.yml:299), where the window was never measured; if it moves, CI goes red and the release gate with it.

## Fix direction
Run the test repeatedly in a Linux container. If the window holds there, record the runs; if not, restructure the test so it does not depend on an allocator edge (the deterministic unique-index failure used by commit 3f152419 is one model).

## Acceptance
- [x] The test is run at least 5 times on Linux with the CI toolchain and either passes every time (runs recorded) or is restructured to a platform-independent failure.

## Approval log

- 2026-10-15T11:49:34+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
2026-10-15 — Worked while in todo; the board never showed it in an active column, and the move goes from todo to complete directly (the same as KMF02UEX).
- 2026-10-15T14:24:11+0200 — COMPLETE by main-agent@agentlenspro. acceptance met and verified by the orchestrator.

## Results

2026-10-15 — b4cdf24c on linux/amd64 (image rust:1, rustc 1.99.0, Debian trixie, emulated on an aarch64 host, source from git archive): the memory-edge test passed 5 of 5 isolated and 5 of 5 module runs (reports_dev/linux-memory-edge.md).
2026-10-15 — 6afa002b, same setup, rebuild proven (Compiling agentlens-core after cargo clean -p agentlens-core): 5 of 5 isolated and 5 of 5 module runs (11 tests) (reports_dev/linux-memory-edge-6afa002b.md).
2026-10-15 — Fresh-store probe on 6afa002b, 3 runs per limit: the old query ran out of memory at 5120-8192 KiB, did so in only 1 of 3 runs at 8448 KiB (passed 2 of 3), and passed from 8704 KiB; demote_cold(1) failed at 5120 and 6144 KiB and returned Ok(49) from 7168 KiB. On Linux the test setting of 8 MiB therefore has at most 256 KiB of headroom on the old-query side, and the transition there is not deterministic.
2026-10-15 — Box met at f7a4945a (limit 7680 KiB). Linux, rebuild proven: the memory-edge test passed 16 of 16 runs on linux/amd64 (10 isolated, 3 in the card_store module of 11 tests, 3 inside full lib runs; reports_dev/linux-memory-edge-f7a4945a.md), image rust:1, rustc 1.99.0 (floating stable today; that CI installs the same is inferred, no CI log checked), Debian trixie, emulated on an aarch64 host. macOS at f7a4945a: 10 of 10 isolated and 3 of 3 module runs.
2026-10-15 — In-sequence probe (the one-store sequence the test itself runs), 5 runs per limit at 6afa002b, identical counts on macOS arm64 (rustc 1.97.0) and linux/amd64 (rustc 1.99.0): demote_cold failed at 6656 KiB and returned Ok(49) from 7168; the old query ran out of memory through 8192 KiB and passed at 8448 (reports_dev/zrx-seq-probe.md). Caveats: the probe ran its limits in ascending order inside one process, and the compiler that built DuckDB was not recorded.
2026-10-15 — 7680 KiB is at least 512 KiB from both edges at 5 runs per limit. Zero failures in 16 Linux runs bounds the failure rate only below about 17 percent at 95 percent confidence. The earlier 10 of 10 at 8 MiB no longer covers the committed test. Emulated Debian is not the native ubuntu-latest runner, so the first CI run is the only real check.
2026-10-15 — Corrections to the Notes line of 2026-10-15: test s own means the sequence the test itself runs (an apostrophe was lost in shell quoting); the in-sequence probe was required by one review and flagged by one measurement check, not by two reviews.

## Notes

2026-10-15 — Decision pending measurement: move the test limit off the old-query edge. The value comes from a probe of the test s own one-store sequence at 6656-8448 KiB on Linux and macOS, choosing the limit with the largest smaller margin; two reviews required the in-sequence probe because the fresh-store demote edge does not carry over. The box stays unticked until the new limit passes on both platforms at the final commit, including full lib runs in the container. Emulated Debian is not the native ubuntu-latest runner; the first CI run is the only real check.
