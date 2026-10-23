---
trdd-id: 735Q3JF4
title: alcore mimalloc commit reaches about 2.05 GB within 15 s on the clone and the pressure ladder frees nothing
column: todo
status: tasked
created: 2026-10-23T04:39:08+0200
updated: 2026-10-23T04:39:32+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-23T04:39:08+0200
---

# alcore mimalloc commit reaches about 2.05 GB within 15 s on the clone and the pressure ladder frees nothing

## Facts (2026-10-23, clone run6, HEAD 97f90f5a, cap unset = production default 2048 MB)
- run6: export POST at boot+3 s; ladder stage 1 at boot+5 s (2024800256 B), stage 3 at boot+15 s (2051407872 B), i.e. during the cold export store open. Composition at up 0 s: commit 655 MB, live 592 MB; at up 60 s and 120 s: commit 1964 MB, live ~1070 MB, free-in-page ~895 MB, summary-cache 43811 sessions; the collect-probe dropped 0 MB.
- The stage-2 action clears summary_cache, yet the 60 s line shows 43811 sessions.
- mimalloc is the Rust global allocator only (no override feature in rust-core/crates/agentlens-core/Cargo.toml), so DuckDB C++ allocations are NOT in the mi commit. The growth is the Rust global-allocator commit, including fragmentation: live +475 MB; free-in-page +835 MB; abandoned +7300 pages (about 1.3 GB commit growth in total).

## Production consequence
With log scan on and bodies present, the cap would be crossed and the server would exit (rss_guard exit(1) at 2048 MB). Before that the ladder halves the summarization window and max_spans, a degraded dashboard. Roughly half the commit is free-in-page fragmentation (live ~1070 MB vs commit 1964 MB). Deploy-blocking together with TRDD-12FGMAEP.

## Next step
Differential runs (below).

## Approval log

- 2026-10-23T04:39:08+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Differential 2026-10-23

- Setup: fresh server per run on the clone, alcore-r36, cap unset, --no-log-scan, otel-bodies parked (same as run6). Runs: A no export; B cold export at boot+1 s, second export at boot+125 s; A2 no export, GET /api/summary x5 at boot+5..25 s. Detail: docs_dev/20261023-heap-differential-report.md.
- Ladder edges (s after boot): A 6/11/16 (metric 2018508800/2018508800/2047213568 B); B 6/11/16 (2030370816/2034696192/2055602176 B); A2 5/10/15 (2065104896/2065104896/2084765696 B). The ladder reaches stage 3 at the same time with NO export and NO summary request.
- Composition (commit / live / free-in-page / abandoned pages / purged, MB): up0 A 655/592/62/9399/0; up60 A 1964/1065/898/16733/1733; up120 A 1966/1065/901/16725/1879. B up60 1964/1065/898/16665/1922; up120 1984/1065/918/16659/2065; up180 1984/1065/918/16572/2319. A2 up60 1992/1067/924/16710/3046; up120 1992/1065/926/16703/3154. commit-live = 899-927 MB in every run.
- Reading: the Rust global-allocator commit, including fragmentation, reaches ~1.96-1.99 GB with NO export (A): live +473 MB; free-in-page +836 MB; abandoned +7330 pages (page size: libmimalloc-sys 0.1.49 default build is mimalloc v3, 64 KiB arena slice by source; exact page size at runtime unverified). Boot fills it, not the export or store open. Export adds only RSS (B RSS 4.5 GB vs A 2.0 GB; DuckDB allocator) and +20 MB commit.
- B second export: commit unchanged (1984 MB at up120 and up180), ladder stayed at stage 3, known_part seed logged once (not re-run), export 4.2 s vs 25.6 s cold: warm, store not re-seeded; whether the store handle was re-opened is NOT verified. Conclusion under those conditions: one-time fill, no per-request growth over one 50-file export.
- A2 vs A: summary-cache is 43811 sessions in A too, so the 25 ms background rebuilder (ui.rs:242 run_summary_rebuild, rebuild_once) builds it without any request; GET /api/summary (78 MB, 0.1 s) added only ~28 MB commit. After the stage-2 clear (lib.rs:820, derived_cache.rs:150) the rebuilder refills the cache within one 25 ms tick, so the clear frees nothing. The boot-time summary build (43811 sessions) is the prime suspect for the fill, not proven: disabling the rebuilder would be the next differential.
- Timing resolution: /api/server-stats has no mimalloc commit, so only ladder edges and the 60 s lines are measured; peak commit between lines is unmeasured.
