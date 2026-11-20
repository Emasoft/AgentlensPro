---
trdd-id: 2LXKMRE3
title: CI rust job exceeds its 40 minute limit on main
column: dev
status: tasked
created: 2026-11-20T03:40:48+0100
updated: 2026-11-20T04:35:39+0100
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
approval-datetime: 2026-11-20T03:40:48+0100
---

# CI rust job exceeds its 40 minute limit on main

CI run 44657487085 on main c2392a4c: the rust job hit timeout-minutes 40 (ci.yml:263). Clippy took 8.7 min (cargo cache step restored nothing, 0 s), then Tests ran 31.3 min until cancelled. Branch runs that passed: 44643561993 Tests 31.0 min, 44613423007 Tests 21.0 min. So the job sits near its limit and a cold cache pushes it over. Unknown: whether a test hung (s08 flake TRDD-U44W4VC2 blocks by design) or the suite is only slow. Next: read the full job log, find the last finished and the running test, then fix the cause (cache key for main, a hung test, or split the job); raising the limit alone is not the fix.

## Approval log

- 2026-11-20T03:40:48+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-20T04:35:39+0100 — column → dev by main-agent@agentlenspro. cause measured; aldigest override being applied by a worker

## Process log

2026-11-20: by a worker's PATTERN SCAN of the job log (not a full read; reports_dev/2LXKMRE3/20261120_040952+0100-rust-log-read.md): Tests ran 31m16s and were cancelled at 02:39:23 with spool_tap t2 and t24 still open; card_store.rs (686 s) and card_reuse.rs (215 s) dominate; no failing test was matched. Only ONE main run reached the 40 min limit (44657487085); runs 44653093604 and 44651344770 were cancelled by a newer push, not by the limit. gh cache list shows no rust-Linux-x64 cache for refs/heads/main (only build-alcore), so INFERRED: every main rust job starts cold until one completes and saves the cache.
2026-11-20: MEASURED per test binary in three runs (scripts_dev/rust-log-table.sh; reports_dev/2LXKMRE3/joined.txt). Step timings from the API: run 44613423007 clippy 341 s, Tests 1262 s; run 44643561993 clippy 13 s (warm cache), Tests 1857 s; run 44657487085 clippy 522 s, Tests cancelled at 1876 s, Post Cache skipped. So a warm cache does not save the job: spool_tap.rs (433 s, 649 s; still running after 705 s) and card_store.rs (361 s, 564 s, 686 s) plus card_reuse.rs (122 s, 180 s, 215 s) are most of Tests. spool_tap's four early tests all waited about 9 min for its nested bundled-DuckDB aldigest build into a fresh temp target dir, which no cache can serve; cargo test --workspace already builds the same binary at rust-core/target/debug/aldigest (digest.rs uses env!("CARGO_BIN_EXE_aldigest")). Fix in progress: AGENTLENS_TEST_ALDIGEST set by ci.yml, panic when the file is missing, nested build kept when unset. card_store/card_reuse split out to TRDD-F3ZUOQBK. digest.rs's nested alspool build costs 31-64 s and is left as is.
