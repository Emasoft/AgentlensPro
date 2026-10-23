---
trdd-id: 735Q3JF4
title: alcore mimalloc commit reaches about 2.05 GB within 15 s on the clone and the pressure ladder frees nothing
column: dev
status: tasked
created: 2026-10-23T04:39:08+0200
updated: 2026-10-23T06:22:21+0200
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

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-10-23
- Established: boot alone (no export) takes mimalloc commit 655 -> 1964 MB and the ladder to stage 3 at boot+16 s (live +473 MB, free-in-page +836 MB, abandoned +7330 pages); export adds ~20 MB commit; deploy BLOCKED (12FGMAEP).
- Refill mechanics, read from code: the stage-2 summary_cache.clear() (lib.rs:820) empties the cache. run_summary_rebuild (ui.rs:242) refills it, but rebuild_once rebuilds only when should_rebuild holds (ui.rs:198-199: now minus finished_at at least 4 x the last build duration) or a reader waits (ui.rs:294-298). The earlier claim that the refill lands within one 25 ms tick is NOT established.
- Whether the clear frees anything is inferred, not measured: in run A the metric rose 2018 to 2047 MB between stage 2 and stage 3, consistent with a second full build (inferred).
- Timing (units): the ladder metric is in bytes, so 2021720064 B is 1928 MiB and 2026307584 B is 1932 MiB. Composition MB is MiB (MB = 1024 x 1024, chores.rs:981). The RSS sampler (rss-7C.tsv) is ps kB, so 2109264 kB is 2059.8 MiB; over Run C the sampler ranges from 2014.2 to 2070.1 MiB. Composition process rss is 2014 MiB at up 60 s and 2049 MiB at up 120 s, inside that range. The earlier 60-100 MB gap compared kB with MiB and is withdrawn; in one unit the gap is 11 to 46 MiB and reflects when each figure was taken. The commit fill completes within about 5 s of boot: the first commit measurement is the ladder at +5 s, between the up-0 line (commit 655 MiB, RSS 1101 MiB) and +5 s; the RSS sampler is already full at its first sample (+2 s).
- Card store: the composition line reports the card rows under "DuckDB own allocator" (59444 rows, about 113 MB text), so they are not in the mimalloc commit. The card store also restores before the up-0 line, which is secondary evidence. It is NOT a candidate for the +1.3 GB mimalloc growth.
- The span store (bin/alcore.rs:346) opens before the up-0 line; whether it allocates after up-0 is not measured; the span-segment index remains a suspect.
- Lead, supporting not proof: tokio interval fires its first tick immediately, so run_burn_tick (ui.rs:4290 interval, ui.rs:4298 summary_now) calls summary_now at about boot+0 s, which builds synchronously while REBUILDER_ACTIVE is false. The fill timing fits this; no run has isolated it.
- NEXT ACTION: run C2 with ONE gate that covers every summary build path (the rebuilder and the synchronous summary_now build used by run_burn_tick and other callers), so no summary is ever built. Validity oracle: summary-cache none on the up-60 and up-120 composition lines. Convergence point: CoreState::summary_from (lib.rs:432) has two production callers, ui.rs:317 (rebuild_once) and ui.rs:468 (summary_now synchronous path). The C2 gate should skip the store (store_summary, ui.rs:321 and ui.rs:470), not return an empty build: an empty build stored would print 0 sessions instead of none and fail the oracle for the wrong reason. Open design point: summary_now returns (u64, Arc<Value>) to its callers (ui.rs:328), so the no-build path needs a defined return value; not designed yet. Run C result: section Rebuilder-off run 2026-10-23.
- SUPERSEDED 2026-10-23: (a) "refills the cache within one 25 ms tick, so the clear frees nothing" (A2 bullet, Differential section) is not established: the refill is gated by should_rebuild (ui.rs:198-199 and ui.rs:294-298). (b) "the 25 ms background rebuilder (ui.rs:242 run_summary_rebuild, rebuild_once) builds it without any request" (A2 bullet) is superseded: run C shows the summary cache is also built with the flag off, by run_burn_tick (ui.rs:4298). (c) "i.e. during the cold export store open" (Facts, run6) is superseded: runs A and C fill with no export. (d) "Next step is an owner or orchestrator decision on gating the run_burn_tick summary_now call too (test-only), then a re-run." (Rebuilder-off Open bullet) is superseded: the NEXT ACTION above decided run C2 with one gate covering every summary build path. The superseded text stays in the body; it is quoted here, not deleted.
- DERIVED TASK: remove or consolidate the AGENTLENS_SUMMARY_REBUILD instrument gate(s) (ui.rs:243-249 and any C2 gate) once the card has a verdict, and before any deploy.

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

## Rebuilder-off run 2026-10-23

- Spec 1a: the line known_part seeded is ABSENT in server-7A.log (grep exit 1). It is printed unconditionally at agentlens-store/src/lib.rs:411, inside open_store, after the parts index, and server-7A.log has no open_store or bodies-pass line. So the parts store never completed its seed in run A, and the spec inference HOLDS. run7c.sh parks otel-bodies, so no bodies are staged: bodies_pass takes its all-empty branch (chores.rs:543-552), which only refreshes a store that is already open (bodies_store_writer, chores.rs:289, never opens) and returns before the open at chores.rs:589. The only openers reached are the export and purge requests (body_archive.rs:292 and body_archive.rs:343). Store allocations belong to DuckDB, not the Rust global allocator (see the Facts bullet on mimalloc), so they are not in the mimalloc commit either way. The parts store is exonerated as a boot filler. The card store line at 04:30:38 (card store reusing cards.duckdb, 59444 rows) is the CARD store, a separate store, and it precedes the up-0 line.
- Spec 1b (ui.rs lines after the 7-line gate insertion): run_summary_rebuild is ui.rs:242, started from bin/alcore.rs:486. Its loop ticks every 25 ms (ui.rs:251) and runs each pass with spawn_blocking (ui.rs:259) on the tokio blocking pool, not on the tick task. Each pass builds a fresh value: summary_snapshot (lib.rs:416) under the lock, summary_from (lib.rs:432, called at ui.rs:317), store_summary (lib.rs:442, called at ui.rs:321) replaces the cached Arc, and the old one frees when its last reader clone drops.
- Addition C: rebuild_once does NOT rebuild on every 25 ms tick. It returns at once while the cache is current for data_version (ui.rs:271 and again at ui.rs:312; derived_cache.rs:42 compares the version). It skips when the rebuild gate is held (ui.rs:275, try_lock). It rebuilds only when should_rebuild holds (ui.rs:198-199: now minus finished_at at least REBUILD_COST_FACTOR 4 times the last build duration, ui.rs:168) or a reader is waiting and the last build took at most 500 ms (ui.rs:294-298).
- Gate: no env gate existed. Added at the top of run_summary_rebuild (ui.rs:243-249), before REBUILDER_ACTIVE is set: AGENTLENS_SUMMARY_REBUILD=off (trim, case-insensitive) returns early with one log line; default on. Uncommitted, per the no-git instruction.
- Build: cargo build --release -p agentlens-core --bin alcore exit 0; cargo clippy -p agentlens-core --all-targets -- -D warnings exit 0. Gate string count: 1 in alcore-norebuild, 0 in alcore-r36.
- Run C: run7c.sh C (copy of the run7.sh A leg; binary alcore-norebuild; AGENTLENS_SUMMARY_REBUILD=off exported; cap unset; idle to up 135 s). Gate line present at 06:04:57; the events file records the env as AGENTLENS_SUMMARY_REBUILD=off. Ladder, seconds after boot (06:04:57): stage 1 at +5 s, stage 2 at +10 s (window to 43200000 ms), stage 3 at +15 s (window to 21600000 ms). Run A: +6, +11, +16. Stop: exit 0, SIGTERM, gone. data/otel-bodies restored with 38901 entries, the same count as before the run.

| run (MB, commit / live / free-in-page) | up 60 s | up 120 s |
|---|---|---|
| A, rebuilder on | 1964 / 1065 / 898 | 1966 / 1065 / 901 |
| C, flag off | 1944 / 1077 / 867 | 1964 / 1074 / 889 |
| C minus A | -20 / +12 / -31 | -2 / +9 / -12 |
- Validity: FAILED. Summary cache: none at up 0 s, 43811 sessions at up 60 s and up 120 s. The flag did not prevent the summary build. Most likely cause, not isolated by a run: run_burn_tick (ui.rs:4290 interval, ui.rs:4298 summary_now) calls summary_now every 4 s with no client connected; with REBUILDER_ACTIVE false, summary_now takes the synchronous path (the flag check at ui.rs:369 is skipped; store at ui.rs:468-470).
- Verdict: Run C does not isolate the rebuilder, so there is no verdict on the boot heap. On the numbers alone, free-in-page fell 12 to 31 MB and live rose 9 to 12 MB, but both sit inside the range of runs A, B, A2 and C together (commit 1944 to 1992 MB, live 1065 to 1077 MB, free-in-page 867 to 926 MB), so neither live data nor free-in-page churn moved beyond run-to-run noise.
- RSS peak in Run C: 2119632 kB over 133 one-second samples. Process RSS at up 120 s: 2049 MB.
- Open: the rebuilder question is unresolved. Next step is an owner or orchestrator decision on gating the run_burn_tick summary_now call too (test-only), then a re-run. Nothing committed or pushed (no git in this task).
