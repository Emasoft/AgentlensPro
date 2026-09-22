---
name: agentlenspro-ops-lessons-concurrency-and-event-loop
description: "server hangs at 100% cpu and every request times out or SIGTERM is ignored / a settings.json env key keeps reverting or getting overwritten after every server restart / the CLI hangs for 75 seconds when the server is unreachable / cache-expired takes forever / a setup detector reports drift every run but the repair never lands / a green setup proves nothing about the repairer / the mocha suite dies at exit 139 SIGSEGV in duckdb.node / all MCP calls fail with rpc error undefined while server logs show 200s / already connected to a transport / a test times out under load but is actually scanning the real live store / an rss sampler goes dark during a scan / a server pidfile is corrupted or two servers own one data dir / a restart looks like it failed but another server already owns the data directory / server.log shows another process's history"
ocd: 2026-07-11
lmd: 2026-09-22
metadata:
  node_type: memory
  type: project
  tier: component
publish-globally: false
split-lineage: 266022327e5e4d3796245d2d1a921c06
---

^ATOM-KRXC-PSWU [desc:"The MCP transport had NO connect bound (75s stalls); the fix is a CONNECT deadline, never a request timeout — server-side slowness is legitimate", keywords: CLI_hangs_75_seconds cache-expired_takes_forever command_stalls_when_server_unreachable http.request_has_no_timeout connect_timeout_vs_request_timeout address_drops_instead_of_refusing, ocd: 2026-08-04, lmd: 2026-08-04]

**A hot-path CLI verb must bound the CONNECT — and only the connect.** `rpc()` / `apiRequest()` called
`http.request` with no bound at all, so an address that DROPS (a firewall blackhole, a suspended
container, a VPN flap) held the process until the OS connect timeout. MEASURED 2026-08-05:
`agentlenspro cache-expired` took **75,103 ms** — a verb whose documented purpose is answering when the
server is DOWN. Fixed by an 800 ms connect deadline (`AGENTLENS_CONNECT_TIMEOUT_MS`), cleared on
`connect` for a fresh socket and on `response` for a pooled one; 873 ms after, exit 2, with a reason
that names the cause. Commit cc5326c, TRDD-E8XIC2PM.

**Bound the CONNECT, never the request.** A legitimate call can be slow SERVER-side — `ctxvis` spawns
an agent and measures two of its turns — so an idle-socket timeout kills correct work, while an
unanswered connect is never anything but a dead endpoint.

**Two traps this class hides behind.** (1) A closed port REFUSES instantly; only an address that DROPS
(`10.255.255.1`) reproduces the stall, which is why a thorough "server down" suite stayed green for
weeks while three commands took 10.6 s each. (2) `AbortSignal.timeout` bounds the REQUEST, not the
PROCESS: the aborted socket keeps the event loop alive, so a CLI that ends by setting `process.exitCode`
still waits it out — see `exitNow` in `src/cli/main.ts`, which must ALSO flush stdout first, because
`process.exit()` discards a queued pipe write past ~64 KiB (measured: 262,144 written, 65,536 received). [^22]




^ATOM-WPOI-PJMS [desc:"The verified transaction protects the FILE, not your INTENT: an op carrying a computed RESULT (set/delete) reintroduces the very race the lock closes", keywords: safe_config_edit_clobbers_another_tool's_hook transaction_lock_did_not_prevent_the_overwrite whole-array_set_is_stale settings.json_entry_disappeared ops_must_carry_predicates, ocd: 2026-08-04, lmd: 2026-08-04]

**`safeConfigEdit` protects the FILE, not your INTENT.** The lock, the verify-diff and the atomic
rename are all real — and an op that carries a computed **RESULT** still clobbers a concurrent writer,
because the value was computed from a read taken BEFORE the lock and the transaction faithfully writes
exactly what it was asked for. The verify-diff cannot catch it either: the change IS inside the declared
op path, which is the one thing it checks.

Found in our own hook installer (TRDD-T0CT9U4X, commit 4da41dc): the strip path committed
`{op:'set', path:['hooks',ev], value:<array computed pre-lock>}`, so a hook ANOTHER tool appended to
that event in between was silently deleted — from the user's `~/.claude/settings.json`, by the tool
whose transaction exists because this project once destroyed one. `{op:'delete'}` is the same defect in
a different op: "this array is now empty" is also a pre-lock conclusion.

**RULE: ops carry PREDICATES, never results** — `append_unique` to add, `remove_by_substring`
(+`prune_empty`) to strip. Two constraints that follow: the predicate crosses a process boundary into
Python, so it must be DATA (a substring, never a regex or a callback); and a needle is matched against
`json.dumps(element)`, so it must be a literal JSON does not escape — a command containing a tab or a
quote will never match its own raw text, and a caller that cannot express a removal must say so and
fall back loudly rather than emit a filter that strips nothing while reporting success.




^ATOM-LSGO-AIXS [desc:"Two 2026-08-06 bugs, one shape: the DETECTOR and the REPAIRER disagreed about the same condition, so setup reported drift forever and the repair could never land", keywords: setup_reports_drift_every_run_but_never_fixes_it repairer_detects_but_cannot_repair remove_by_substring_still_present_after_apply hook_re-registration_fails detector_and_writer_disagree a_converge_path_that_is_never_exercised setup_aborted_fail-fast_on_hooks, type: project, ocd: 2026-08-06, lmd: 2026-08-06]

**A detector and its repairer must agree on the condition, or `setup` reports drift forever and never fixes it.** Hit TWICE on 2026-08-06, in unrelated code, with the identical signature — `setup` names a problem, claims to act, verifies, and FAILS, on every run.

1. **Raw-body key (`telemetryConfig.ts`).** `cli/setup.ts` tested key PRESENCE; the writer's delete guard tested a VALUE match against `file:${bodiesDir}` resolved with capture OFF — which is the LEGACY dir by construction and can never equal a key holding the SPOOL path. Fixed by `ownedBodyValues` (every `file:` value the installer could have written).
2. **Hook re-registration (`scripts/safe_config_edit.py`).** Re-registration IS `remove_by_substring(<cmd>)` then `append_unique(<cmd>)`. `verify_diff` asserted the removal's postcondition against the FINAL tree — after the append had legitimately re-added the needle — so it could never hold (`'agentlenspro gate' still present after apply`), and fail-fast then skipped skill/otel-env/server/final-test. Fixed by exempting exactly the values LATER ops on the same path re-add.




^ATOM-TMP3-BABT [desc:"A converge path only runs when something has actually drifted, so a green setup exercises the DETECTOR and none of the REPAIRER", keywords: why_did_the_broken_repair_path_go_unnoticed a_green_setup_proves_nothing_about_the_repairer how_do_I_test_a_self-repairing_installer converge_path_never_exercised detection_and_repair_in_different_languages, type: project, ocd: 2026-08-06, lmd: 2026-08-06]

**A green `setup` on a healthy machine proves the DETECTOR works and proves NOTHING about the REPAIRER.** This is why both 2026-08-06 convergence bugs stayed invisible for so long: a converge is only attempted when something has genuinely drifted, so every healthy run ("registrations current", "telemetry env current") emitted no ops and exercised no repair code at all. The repair path was dark until the day it was needed — which is precisely the day it has to work.

**How to test one: break something first.** Run the repair against a genuinely drifted fixture, not a converged one. When detection and repair live in different files — or different languages, as here (a TypeScript detector and a Python writer) — pin their SHARED predicate with such a test, plus a counter-case, so a widened predicate cannot quietly degrade into "never assert". Both fixes ship exactly that pair.




^ATOM-N8GX-ZQI3 [desc:"suite dies at exit 139 / SIGSEGV in duckdb.node / red tests move between runs — closing a shared DuckDB connection under an in-flight query", keywords: suite_dies_exit_139 mocha_runner_killed_SIGSEGV node_crash_report_duckdb.node test_suite_exit_code_139_no_assertion closeSync_segfault red_tests_move_between_runs duckdb_use_after_free connection_closed_while_query_running, ocd: 2026-08-13, lmd: 2026-08-13]

A SHARED DuckDB connection must never be closeSync()'d while a query can still be in flight on the napi worker thread — the failure is a NATIVE SIGSEGV (ClientContext::Query -> pthread_mutex_lock on freed memory) or an indefinite process wedge, not a JS error. The reachable trigger: mocha's timeout abandons a test mid-await (the promise keeps running), teardown then calls store.close(). Fixed at a43251f: openStore wraps the connection in a Proxy that tracks in-flight calls and refuses post-close ones; close() = interrupt() + drain (Promise.allSettled) + closeSync, single-flight. Per-call instances (withDuck/openDuck) are safe by construction: their finally runs only after their own awaits settle. Pinned by src/test/storeCloseSafety.test.ts (red-first: 2 failing + an 11-minute wedge on unfixed code).




^ATOM-LE8M-IRMJ [desc:"every CLI diagnostic returns rpc error (undefined) / MCP calls all fail but server logs 200s / Already connected to a transport — the shared Protocol instance wedge", keywords: rpc_error_undefined all_mcp_tools_fail already_connected_to_a_transport tools_list_fails cli_cannot_reach_mcp_but_server_up mcp_endpoint_wedged_until_restart one_server_instance_per_connection, ocd: 2026-08-13, lmd: 2026-08-13]

The MCP HTTP endpoint must build ONE SDK Server (Protocol) instance PER CONNECTION — never share one across requests. The SDK's Protocol tracks exactly one transport; a shared instance wedges on overlapping clients with 'Already connected to a transport' and then fails EVERY rpc (tools/list included) as 'rpc error (undefined)' (the CLI's rendering of the 500 body) while the HTTP layer keeps logging 200s — a permanent outage that only a restart clears. Fixed 396d3bb: handleMcpRequest takes a Server factory; each request closes transport + server on response close. createMcpServer is closure-only (no I/O), so per-request instances cost microseconds. Falsification note: the wedge interleave lives in the SDK's async machinery and could not be forced in-process (a sync block serializes the event loop); the recorded red is the live raw-JSON-RPC probe.




^ATOM-R9AC-467C [desc:"A 'timeout under load' in cacheBreakTimeline/forensics tests can be a REAL-STORE scan: since the evidence rewire, storeDir defaults to the live ~/.agentlens store", keywords: test_timeout_under_load cacheBreakTimeline_timeout suite_hangs mocha_timeout scans_real_store storeDir_default non-hermetic_test, type: project, ocd: 2026-08-13, lmd: 2026-08-13]

Since the evidence rewire, `buildCacheBreakTimeline` / `buildCauseCostPeakReport` /
`scanApiCallEvents` default `storeDir` to `dataPath('store')` — the developer's REAL multi-GB
Parquet store. Any test that does not pass a scratch (never-created) `storeDir` silently scans the
live corpus: at machine load ~150 that read as 11 "environmental" timeouts (2026-08-13), and the
tell that broke the environmental theory was an EMPTY-INPUT test ("absent bodies directory") also
"timing out" — no load explains 60s on no data. Isolation pattern: a `noStore` never-created dir
per suite (forensicsIndex.test.ts and cacheBreakTimeline.test.ts both carry it now; fix 4e442c4).
Before blaming load for a red suite, ask: does every store-touching call pass a scratch storeDir?




^ATOM-JK8S-5TXQ [desc:"Fix a loop-starving sync walk with an async driver over the same chunk generators + setImmediate per chunk; never a worker thread (rss is per-process)", keywords: server_status_not_running_during_scan event_loop_starved_by_sync_walk status_probe_drop yield_to_event_loop setImmediate_vs_microtask worker_thread_does_not_reduce_rss, type: project, ocd: 2026-08-14, lmd: 2026-08-14]

DO NOT fix an event-loop-starving synchronous walk by forking a worker thread or duplicating the read path, BECAUSE rss is per-process (a worker buys no memory relief) and a second read path drifts. DO add an async driver over the SAME chunk generators the sync exports consume (one read logic, two pump schedules) with await setImmediate between chunks — setImmediate specifically, since a resolved-promise await drains only microtasks and never reaches the poll phase where pending sockets are served. Proven live (TRDD-9NAUEUUR, commit 3c3ae12): 8/8 server-status probes answered RUNNING during a 60s+ no-window span walk whose baseline DROPped every probe.




^ATOM-F0NR-2125 [desc:"Key in-scan samplers on RAW units, never filtered ones — a better filter silently kills a filtered-unit trail", keywords: rss_sampler_went_dark no_samples_during_scan sampler_interval_never_fires prefilter_broke_telemetry key_metrics_on_raw_units, type: project, ocd: 2026-08-14, lmd: 2026-08-14]

DO NOT key an in-scan telemetry sampler on a FILTERED unit (parsed spans), BECAUSE the moment a prefilter improves, the counter stops reaching the sampling interval and the trail goes dark exactly where it was built to watch — a 5.4M-span walk produced ZERO rss samples after the TRDD-9NAUEUUR prefilter. DO key trails on the RAW unit (lines seen), which no optimization can shrink; re-keyed sampler fired 20 samples on the same walk.




^ATOM-K1LU-FWB8 [desc:"Single-instance lock: link(2)-publish + start-time-verified takeover (TRDD-PIDFILEAT) — never bare wx + kill-0; refusal phrase is parsed, never reword", keywords: pidfile_corrupted_two_pids server.pid_garbage double_owner_two_servers_one_store stale_lock_takeover recycled_pid_kill-0 single_instance_race refusing_to_start_already_owns, type: project, ocd: 2026-08-14, lmd: 2026-08-14]

DO NOT 'simplify' the server single-instance lock back to a bare wx write + kill-0 takeover, BECAUSE wx makes only the CREATE exclusive (the content write is a separate syscall — two racing starters produced the interleaved pidfile '4676845598'), and kill-0 lies for a RECYCLED pid under churn (a >=67s double-owner window was observed, two servers appending to one store). DO keep the TRDD-PIDFILEAT shape: stage+fsync a temp file then fs.linkSync-publish (link(2) is atomic AND fails EEXIST), lock content {pid, start: ps -o lstart=}, takeover only on dead or start-ref-mismatch (recycled); an alive pid with matching start ref is a LIVE owner. The refusal log phrase 'Refusing to start: another AgentlensPro server (pid N) already owns' is parsed by serverControl.raceWinnerPid — never reword it.




^ATOM-C0VK-5JHE [desc:"an unscoped tail of the shared untimestamped server.log quotes foreign history, and a refusal names the pid that WON — so a healthy restart reads as a failure", keywords: refusing_to_start_but_server_is_running restart_looks_like_it_failed server.log_shows_another_pid log_tail_shows_old_errors shared_append-only_log_no_timestamps another_server_already_owns_this_data_directory diagnosis_quotes_foreign_process, ocd: 2026-08-12, lmd: 2026-08-12]

**`server.log` is ONE append-only file shared by every process that ever started a server for a
data dir, and it has NO timestamps — so an unscoped tail quotes other processes' history as if it
diagnosed the command you just ran.** Measured 2026-08-12: 29 accumulated refusal blocks in a 15 MB
log, naming FOUR different owner pids, three lines per block — so a default 8-line tail straddled
~2.7 unrelated eras.

**The inversion is the damage, not the noise.** A refusal names the pid that WON — "another server
(pid N) already owns this data directory" — so a tail printed under a failed command reads as "N
failed to start" when N is the healthy server protecting you. That misreading costs a restart that
was never needed, and on a machine running many sessions a restart interrupts all of them. The
original bug report drew exactly this wrong conclusion, and blamed a retry loop that does not exist
(`ensureServer` spawns ONCE and already reports the SERVING pid, not the child).

Fix: `logTail(lines, fromOffset)` reads only bytes appended since our own spawn (`logSizeNow()`
captured immediately before `spawn`). An attempt that wrote nothing says so; a log rotated underneath
is reported as rotated rather than quoted from a stale offset; the header states the scope, because
"the last 8 lines" and "the last 8 lines WE wrote" are different claims. The guard's message is not
silenced — trading a false alarm for a silent one would be worse.





^ATOM-L0VH-P39Z [desc: "compositions_in_scope held the state lock up to 274s because build_session_summary ran INSIDE the guard (TRDD-UTFVMVT8)", keywords: state_lock_held_for_seconds every_request_times_out_but_cpu_is_idle ui.rs_560 compositions_in_scope build_session_summary_under_the_lock otlp_ingest_waited_145_seconds log_sweeper_starved dashboard_slow_but_server_alive spans_stopped_being_stored summary_rebuild_takes_6_seconds, trdd: TRDD-UTFVMVT8, ocd: 2026-09-22, lmd: 2026-09-22]

Measured 2026-09-02..04 (TRDD-UTFVMVT8). On alcore, `compositions_in_scope` (`ui.rs`) took the
state lock and then called `composition_project_map`, whose first line is `build_session_summary` —
so a `VersionedCache` MISS rebuilt the whole summary INSIDE the guard. One pid: 82 holds at that
site, worst **273.9 s**; the OTLP handler waited 145 s, the log sweeper 29 s. Spans stored per
minute fell from 0.8-2.6k to single digits for ~30 min — OTEL detail lost at the source.


^ATOM-R8UN-LY08 [desc: "Three lessons from the alcore lock-hold incident: held-line names the guard not the work, holder slot names queue-time not wait-site, line numbers are per-binary", keywords: held_line_names_the_guard holder_slot_at_queue_time line_numbers_per_binary lock_attribution_held_line waiter_queued_behind_holder composition_project_map session_ids_resolve_scope_0ms function_name_stable_across_builds chores.rs_653 cargo_build_inflated_duration, trdd: TRDD-UTFVMVT8, ocd: 2026-09-22, lmd: 2026-09-22]

Three things that generalize:

1. **A `held` line names the GUARD, not what ran under it.** Timing each statement separately
   showed 19/19 traced holds were 100% `project_map`; `session_ids` and `resolve_scope` — the two
   expensive-looking suspects — were 0 ms. (Those holds' DURATIONS were inflated by concurrent
   cargo builds; the ATTRIBUTION is independent of that, which is why it is quoted and they are
   not.)
2. **The holder slot names the holder AT QUEUE TIME**, not the site you actually waited behind. A
   26 s wait blamed `chores.rs:653`, which had no `held` line at all.
3. **Line numbers are PER BINARY** — the instrumentation shifted every later site by +18. Key reads
   on the FUNCTION name.


^ATOM-63H6-5S6Y [desc: "Fix: build off-lock before taking the guard; worst hold dropped 120x but trades a CURRENT snapshot for stale-but-free, up to ~2 rebuild durations old", keywords: build_off_lock ui::summary_now fresh_but_blocking_vs_stale_but_free worst_hold_2263ms rebuild_takes_5.9_to_7.1s project_unknown_omitted_session coverage_says_scanned_all_but_isnt staleness_window_sizing doc_comment_claimed_milliseconds versioned_cache_snapshot_age, trdd: TRDD-UTFVMVT8, ocd: 2026-09-22, lmd: 2026-09-22]

**Fix and its honest cost:** build off-lock (`ui::summary_now`) before taking the guard, clone cards
off-lock too. Worst hold anywhere then 2,263 ms (120x drop), zero at any composition site. But the
old path was always CURRENT, while the new one serves the last COMPLETED rebuild's snapshot — data
age up to ~2 rebuild durations, and a rebuild is **≥5.9 s** at 27.7k sessions (5.9-7.1 s were the
four QUIETEST traced rebuilds, with no build running — a FLOOR, not a typical range; size the
staleness window above it, never at it). Not the "milliseconds" the doc comment claimed. A younger
session resolves to `project: unknown` and is silently omitted from a project-scoped answer while
coverage still reads "Scanned all N sessions".
Say "fresh-but-blocking became stale-but-free", not "pure win".


^ATOM-Q7NW-6I0K [desc: "A graceful SIGTERM stop starved 6 minutes with every tokio worker parked on the mutex; a 2s sample caught the holder by stack when log-reading could not", keywords: graceful_stop_starved SIGTERM_ignored_six_minutes http_dead_after_sigterm every_tokio_worker_parked_on_mutex sample_caught_holder_by_stack log_reading_could_not_find_holder alcore_state_mutex sigterm_shutdown_hang mutex_holder_identification 2s_sample_profiling, trdd: TRDD-UTFVMVT8, ocd: 2026-09-22, lmd: 2026-09-22]

**A graceful stop STARVED:** SIGTERM, then HTTP-dead six minutes later, every tokio worker parked
on the mutex. A 2 s `sample` caught the holder by stack (1,413/1,413 in that call) where log-reading
could not.

## Governed by

- [[agentlenspro-ops-lessons]] — the operational-doctrine overview this sub-page details.


## Superseded


^ATOM-0S2S-TC9O [desc: "compositions_in_scope held the state lock up to 274s because build_session_summary ran INSIDE the guard; the fix builds off-lock and trades fresh-but-blocking for stale-but-free", keywords: state_lock_held_for_seconds every_request_times_out_but_cpu_is_idle ui.rs_560 compositions_in_scope build_session_summary_under_the_lock otlp_ingest_waited_145_seconds log_sweeper_starved dashboard_slow_but_server_alive spans_stopped_being_stored summary_rebuild_takes_6_seconds composition_project_map lock_attribution_held_line waiter_queued_behind_holder SIGTERM_ignored_during_shutdown alcore_state_mutex, trdd: TRDD-UTFVMVT8, ocd: 2026-09-04, lmd: 2026-09-04, status: superseded, superseded-by: ATOM-L0VH-P39Z]
Measured 2026-09-02..04 (TRDD-UTFVMVT8). On alcore, `compositions_in_scope` (`ui.rs`) took the
state lock and then called `composition_project_map`, whose first line is `build_session_summary` —
so a `VersionedCache` MISS rebuilt the whole summary INSIDE the guard. One pid: 82 holds at that
site, worst **273.9 s**; the OTLP handler waited 145 s, the log sweeper 29 s. Spans stored per
minute fell from 0.8-2.6k to single digits for ~30 min — OTEL detail lost at the source.

Three things that generalize:

1. **A `held` line names the GUARD, not what ran under it.** Timing each statement separately
   showed 19/19 traced holds were 100% `project_map`; `session_ids` and `resolve_scope` — the two
   expensive-looking suspects — were 0 ms. (Those holds' DURATIONS were inflated by concurrent
   cargo builds; the ATTRIBUTION is independent of that, which is why it is quoted and they are
   not.)
2. **The holder slot names the holder AT QUEUE TIME**, not the site you actually waited behind. A
   26 s wait blamed `chores.rs:653`, which had no `held` line at all.
3. **Line numbers are PER BINARY** — the instrumentation shifted every later site by +18. Key reads
   on the FUNCTION name.

**Fix and its honest cost:** build off-lock (`ui::summary_now`) before taking the guard, clone cards
off-lock too. Worst hold anywhere then 2,263 ms (120x drop), zero at any composition site. But the
old path was always CURRENT, while the new one serves the last COMPLETED rebuild's snapshot — data
age up to ~2 rebuild durations, and a rebuild is **≥5.9 s** at 27.7k sessions (5.9-7.1 s were the
four QUIETEST traced rebuilds, with no build running — a FLOOR, not a typical range; size the
staleness window above it, never at it). Not the "milliseconds" the doc comment claimed. A younger
session resolves to `project: unknown` and is silently omitted from a project-scoped answer while
coverage still reads "Scanned all N sessions".
Say "fresh-but-blocking became stale-but-free", not "pure win".

**A graceful stop STARVED:** SIGTERM, then HTTP-dead six minutes later, every tokio worker parked
on the mutex. A 2 s `sample` caught the holder by stack (1,413/1,413 in that call) where log-reading
could not.
## Notes and lessons learned

[^8]: [id:ATOM-WEDGE-BOUND, status:valid, keywords:"server_hang 100%_cpu every_request_hangs event_loop_starved SIGTERM_ignored unbounded_scan flatMap_reparse", ocd:2026-07-16, lmd:2026-07-16]
  DO NOT let any request handler run unbounded synchronous O(corpus) work on the event loop
  (the wedge class: `scanPool.flatMap(asTimeline)` = 50 back-to-back multi-MB transcript
  reparses → 100% CPU, EVERY request hangs, SIGTERM ignored, SIGKILL required — recurred twice,
  2026-07-13/16), BECAUSE a bare `await` of a resolved promise drains only MICROTASKS — queued
  HTTP requests are macrotasks and never interleave. DO use `scanWithBudget` (src/mcpServer.ts:
  setImmediate yield per item + deadline + honest stoppedEarly coverage) for every corpus-fanning
  drill; the loopWatchdog (SharedArrayBuffer beat + worker SIGKILL/respawn) is the backstop, and
  the per-tool start/done log lines in server.log name a wedger (last start with no done).

[^9]: [id:ATOM-ONE-RESOLVER, status:valid, keywords:"settings_key_overwritten_on_boot two_writers_converge different_value spool_repointed_ssd OTEL_LOG_RAW_API_BODIES", ocd:2026-07-16, lmd:2026-07-16]
  DO NOT let two code paths independently COMPUTE the value of a force-converged config key
  (the CLI wired OTEL_LOG_RAW_API_BODIES at the RAM-disk spool; the spool-BLIND server-boot
  converge re-pointed it at the legacy SSD dir minutes later — last writer wins, silently),
  BECAUSE converge-on-boot means the boot's answer always eventually wins, so any writer
  disagreement becomes permanent drift toward the boot's value. DO route every writer through
  the ONE resolver (`effectiveBodiesDir` in src/captureConfig.ts, commit 4efe0f5); when adding
  a converged key, ask "who else computes this value?" before shipping.
[^22]: [id:ATOM-QJAG-2CZ8, status:valid, desc:"A test that reads the LIVE capture dir must pass scanCap — uncapped, its runtime is set by the user's traffic", keywords:"test_suddenly_times_out_with_no_code_change test_scans_the_live_capture_directory suite_got_slower_overnight scanCap_in_tests flaky_slow_test_real_corpus", ocd:2026-08-04, lmd:2026-08-04] DO NOT let a test read the live capture directory (`~/.agentlens/otel-bodies` or the RAM-disk spool) without a `scanCap`, BECAUSE that directory grows with the machine's own activity — measured 1,377 → 5,467 files in a single evening — so the test's runtime is a function of how busy the user was, and it will blow its timeout one day with no code change behind it (two did, in the deploy gate, and the first instinct is to hunt a regression that does not exist). DO pass `scanCap` (300 is plenty) and let the report's own coverage block state that it sampled: 120 s+ timeouts became 2.1 s / 2.3 s / 5.5 s and the whole suite went 9 min → 52 s.
