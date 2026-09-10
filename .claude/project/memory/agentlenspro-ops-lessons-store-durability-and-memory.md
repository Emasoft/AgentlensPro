---
name: agentlenspro-ops-lessons-store-durability-and-memory
description: "a span segment over 512MB breaks setup or silently drops a day of results / the server hit an out-of-memory heap error / is the parquet part actually durable before we delete the source / does fsync guarantee data is on disk on macOS / the RAM-disk spool never drains and fills to 100% / raw body capture stops silently / a drain looks stalled but is actually working / DuckDB ignore_errors silently degrades bad NDJSON lines into all-NULL rows / a diagnostics answer changes between runs or a session's turn count shrinks / sync streaming gunzip needed for a huge gz segment / MaxListenersExceededWarning on Gunzip or an uncaught unexpected end of file / heap looks healthy but the server was still killed / how much of the footprint is off-heap"
ocd: 2026-07-11
lmd: 2026-09-10
metadata:
  node_type: memory
  type: project
  tier: component
publish-globally: false
split-lineage: 266022327e5e4d3796245d2d1a921c06
---

^ATOM-DMTT-DOCU [desc:"A segment past ~512 MB throws in readFileSync — it killed setup and silently deleted two days from every query", keywords: Cannot_create_a_string_longer_than_0x1fffffe8 setup_exits_1_on_a_big_store readFileSync_throws_on_a_huge_file span_segment_over_512MB a_whole_day_missing_from_query_results max_string_length, type: reference, ocd: 2026-08-02, lmd: 2026-08-02]

A span segment can grow past V8's max string length (~512 MB), and `fs.readFileSync(f,"utf8")` THROWS there — "Cannot create a string longer than 0x1fffffe8 characters". The store caps nothing by design (no eviction; retention deletes whole expired days), so a busy day reaches that size on its own. Measured 2026-08-02: two live segments at 568 MB and 531 MB broke BOTH readers — `agentlenspro setup` exited 1 outright, and `segmentedSpanStore.loadRange` dropped those two whole days from every query inside a `catch { continue }`, with no log line. Every NDJSON walk now goes through `src/ndjsonLines.ts` (chunked reads + a StringDecoder so a UTF-8 sequence split across a chunk boundary is not corrupted), and the store logs a read failure by segment name instead of continuing silently. [^18]




^ATOM-GZJG-RS6I [desc:"Streaming the FILE fixed half of it — loadRange still held every span, so an unbounded query OOM'd the server at 4GB", keywords: server_died_on_a_tool_call socket_hang_up_pid_changed JavaScript_heap_out_of_memory Ineffective_mark-compacts get_cache_event_log_kills_the_server unbounded_query no_--window loadRange_materializes streaming_the_file_is_not_streaming_the_query, type: reference, ocd: 2026-08-07, lmd: 2026-09-10]

**Reading incrementally while accumulating everything is still O(all).** ATOM-DMTT-DOCU made
`segmentedSpanStore.loadRange` stream each segment through `ndjsonLines.ts` instead of one
`readFileSync` — which fixed the >512 MB *string* limit and looked like "the store streams now". It
did not: every in-window span was still pushed into ONE returned array. So on 2026-08-07
`agentlenspro get_cache_event_log` with no `--window` (the default — `windowHours` is optional and
`undefined` means all of history) materialized ~1M span objects to keep the `api_request` ones, and
died with `FATAL ERROR: Ineffective mark-compacts near heap limit — JavaScript heap out of memory`
at ~4 GB after 62 s. Memory tracked the WINDOW, not the answer: 1 h→19 MB, 24 h→478 MB, 168 h→dead,
for a result that was 7 rows at every size. It degrades with store age rather than failing on day
one, which is how it shipped.


^ATOM-HH4J-3A09 [desc: "The fix is forEachInRange — a selective reader's peak memory follows what it KEEPS, not the window; unbounded query now 36s/184k calls, and one server owning the data dir means a per-tool OOM is a mac", keywords: forEachInRange_selective_reader loadRange_thin_wrapper peak_memory_follows_what_it_keeps window_cap_hides_accumulation one_server_owns_the_data_dir per-tool_memory_bug_is_machine-wide_outage tool_start_done_log_line wedged_handler_never_logs_completion OOM_uncatchable_v8_abort measured_after_168x_window_range, type: reference, ocd: 2026-09-10, lmd: 2026-09-10]

Fix: the store exposes `forEachInRange(since, until, visit)` and `loadRange` is a thin wrapper over
it, so a selective reader's peak memory follows what it KEEPS. Measured after, across a 168× window
range: 69/121/147/170 MB; the unbounded query now completes in 36 s over 184,212 calls.

Three things worth carrying:
- **The default was NOT capped.** A window cap hides an accumulation instead of removing it, and
  turns a legitimate full-history question into a silently partial answer.
- **One server owns the machine's data dir**, so a tool that OOMs stops ingestion for EVERY project
  — a per-tool memory bug is a machine-wide outage.
- **The silence was already solved.** `mcpServer.ts` logs `tool <name> start` precisely because a
  wedged or aborted handler never logs a completion: the last start with no matching `done` IS the
  culprit. An OOM is a fatal V8 abort, uncatchable, so nothing in-process could say more.




^ATOM-PJAW-P8XT [desc:"The delete gate's read-back is served from the page cache, so it proved readability not durability; the fsync barrier is gated on whether the SOURCE was durable, and F_FULLFSYNC is unavailable in Node", keywords: is_the_parquet_part_actually_durable_before_we_delete_the_source verify_before_delete_page_cache does_fsync_guarantee_data_on_disk_macos F_FULLFSYNC_not_available_in_node reclaim_only_1_file_per_second duckdb_round_trips_per_file_in_the_delete_gate, type: project, ocd: 2026-08-12, lmd: 2026-09-10]

**A read-back proves READABILITY, not DURABILITY — the page cache answers it.** The universal
delete gate (`src/store/ingestPass.ts`) flushes Parquet, reconstructs each body FROM the store,
compares sha256 against the source file's own bytes, and only then unlinks. That ordering is
sound, but `flush()` never fsynced, and the comment above it called the part "durable". A read
issued microseconds after a write is served from the OS page cache, so the gate could pass on
bytes that had not reached the platter.

**Severity depends ENTIRELY on whether the SOURCE was durable, which is why the barrier is gated
rather than global.** Draining the RAM-disk spool: the source is volatile anyway, so a power loss
takes it either way and the barrier buys ~nothing. Draining the LEGACY SSD bodies dir: the source
was safely on disk, and deleting it after a non-durable flush can lose data that was already
safe. The spool back-pressure valve redirects INTO that SSD dir under pressure, which is what
turned this from latent to live.


^ATOM-K99N-LEXN [desc: "F_FULLFSYNC is false in Node on macOS (no guarantee past OS buffers); the delete gate's real bottleneck was ~2 DuckDB round trips per file — batched to ~15 round trips, and a missing body in the bulk ", keywords: F_FULLFSYNC_false_in_node fsync_not_a_power-loss_guarantee macos_drive_write_cache duckdb_round_trips_per_file throughput_bottleneck_not_flush_cadence batched_bulk_row_ts_query chunked_reconstruction_32_per_query missing_body_defaults_to_not-ok silently_dropped_row_cannot_authorize_delete 1_file_per_second_vs_80MB_min_inflow, type: project, ocd: 2026-09-10, lmd: 2026-09-10]

**`fs.constants.F_FULLFSYNC` is `false` in Node (verified empirically).** So on macOS pure Node
cannot force the drive's own write cache to media — `fsync(2)` asks the OS to flush its buffers to
the device, which is a real improvement over never asking, but not a guarantee against power loss
on a drive with a volatile cache. Say that, do not claim more.

**Throughput: the gate was ~2 DuckDB round trips PER FILE** (reconstruct, then the row/ts query),
so a 200-file batch was ~400 round trips ⇒ ~1 file/s (~53 MB/min) against ~80 MB/min burst inflow.
That inequality — not flush cadence, not spool size — is what dropped bodies. Batched to one bulk
row/ts query plus chunked reconstruction (32/query, NOT unbounded: 200 × ~881 KB is ~176 MB of
strings in one result set) ⇒ ~15 round trips. **What is proven did not change, only how it is
executed** — and a body missing from the bulk result map must default to NOT-ok, so a silently
dropped row can never authorize a delete.




^ATOM-CVM9-3JPN [desc:"heap was the wrong number: 67% of the footprint is off-heap, and a silent kill means SIGKILL on RSS, not a V8 heap OOM", keywords: server_killed_silently server_OOM_not_heap rss_vs_heap_node max-old-space-size_does_not_bound_rss requests.log_heap_only ineffective_mark-compacts server_restarted_fresh_pid off-heap_duckdb_memory how_to_diagnose_a_process_kill, ocd: 2026-08-12, lmd: 2026-08-12]

**Heap alone cannot diagnose this server's death — ~67% of its footprint is off-heap, and
`--max-old-space-size` bounds neither that nor RSS.** Measured 2026-08-12 on a HEALTHY server: heap
860 MB against RSS 2624 MB (DuckDB's native arena, buffers, the segment index). So the OOM
post-mortem in TRDD-34B9JAZK stalled three separate times on a number that could not answer it —
`requests.log` recorded heap ONLY, and heap sat at 1768 MB against a 6144 MB cap right up to the
kill, which reads as perfectly healthy.

**The discriminator is whether the death ANNOUNCES itself.** A V8 heap OOM prints `FATAL ERROR:
Ineffective mark-compacts near heap limit` — the out-of-process run did exactly that at ~4 GB. The
server instead went SILENT for 68 seconds and returned as a fresh pid, which is the signature of an
external SIGKILL, and an external kill acts on RSS. So "the server hit its heap limit" was never
supported by the evidence that was collected for it.

Every logged line now carries `heap=…MB rss=…MB` from a SINGLE `process.memoryUsage()` call — two
calls would sample different instants and could report `rss < heap`, which is impossible and would
discredit the trace it exists to make trustworthy. The crash itself is NOT fixed; this is the
instrumentation that makes the mechanism establishable. See ATOM-GZJG-RS6I for the earlier,
genuinely-fixed half (loadRange materializing every span).




^ATOM-WOXQ-R1EO [desc:"A skip-optimization scoped to the wrong unit of work: skipping the re-ingest of an already-durable body also skipped its DELETE, so a fixed-size spool filled until capture died", keywords: spool_never_drains spool_100%_full raw_body_capture_stops_silently skipNames_strands_files file_ingested_but_never_deleted skip_optimization_skipped_the_delete_too ram_disk_fills_with_already_durable_files, type: project, ocd: 2026-08-07, lmd: 2026-08-07]

`ingestPass` filtered `skipNames` out of the candidate list at the top of the pass. The set is
seeded each boot from every `src_name` already in the Parquet store, and the intent was sound —
do not re-read and re-hash a body the store already holds. But the candidate list is also what
feeds the verify-then-DELETE gate, so the filter silently bought the read saving by giving up the
reclaim: a durable body could never be deleted.

On an unbounded disk that is invisible waste. On a fixed-size RAM spool it is terminal — the spool
accumulates exactly the files the store already has, reaches 100%, and raw-body capture stops with
no error anywhere. Measured 2026-08-06: 3,615 bodies stranded in a 2 GB spool, ~300 KB of headroom
left, bodies being dropped. Fixed in `65207f4`: the skip applies to the INGEST only; an
already-durable file still goes through the same gate (re-read, re-proven byte-identical plus its
`(src_name, capture-ts)` row) before the unlink.

**DO NOT** scope a skip-optimization to a whole pass when the pass does more than the work you meant
to skip, BECAUSE the cheapest place to write the filter (one `.filter()` at the top) is also the
place that silently drops every OTHER stage the candidate would have reached. **DO** apply the skip
at the stage it names — here, guard the `ingestBody` call, not the candidate list — and assert the
other stages still run on skipped items.




^ATOM-2SUG-QGT8 [desc:"The bodies pass logged only when ingested > 0, so a pass that reclaimed thousands of files and ingested none printed nothing at all", keywords: pass_did_work_but_logged_nothing silent_success log_gate_on_the_wrong_counter ingested_0_so_nothing_printed reclaim_invisible_in_logs, type: project, ocd: 2026-08-07, lmd: 2026-08-07]

`archiveOtelBodies` gated its whole report on `if (ingested > 0 || purged.length > 0)`. Once the
reclaim path could run without ingesting anything, a pass that deleted thousands of files printed
NOTHING — so the operator's only window onto the drain showed silence, which reads identically to
"nothing to do". That is a large part of why the stranded-spool bug survived as long as it did.

**DO NOT** gate a whole report on ONE of several counters, BECAUSE the counter you picked can be
legitimately zero on a healthy path and then the report disappears exactly when the other work is
happening. **DO** gate on the disjunction of every counter the report mentions (`ingested > 0 ||
deleted > 0 || purged > 0`), and print each one so a zero is a stated fact rather than an absence.




^ATOM-N4OI-OY30 [desc:"Reclaim runs ~1 file/s against ~0.8 files/s of arrivals, so a backlog clears over hours — judge a drain by deletions-from-a-snapshot, never by net file count", keywords: spool_still_full_after_the_fix did_the_deploy_work drain_rate net_file_count_hides_arrivals measure_deletions_not_totals backlog_takes_hours, type: project, ocd: 2026-08-07, lmd: 2026-08-07]

Measured 2026-08-07 on the spool drain: 120 files deleted per 2 min against 94 arriving. The net
count moved by only −26, and at one sample it moved UP — so "the file count is not falling" and
"still 99% full" are both compatible with a drain that is working. Each reclaim reconstructs the
body from DuckDB to prove it before unlinking, which is what caps throughput near 1 file/s; a
multi-GB backlog therefore takes hours, and a pass in flight logs nothing until it finishes.

**DO NOT** judge a drain (or any producer/consumer reclaim) by the total item count or free space
minutes after a deploy, BECAUSE arrivals and deletions are superimposed in that one number and a
healthy drain can look flat or negative. **DO** snapshot the item NAMES, re-snapshot later, and
count the two directions separately (`comm -23` deleted vs `comm -13` arrived) — that is the only
form that distinguishes "not draining" from "draining slower than it fills".




^ATOM-QIF6-MVG7 [desc:"diagnostics answers change between runs / session turn count shrinks / fact DB misses an event the classifier saw — any reader on the raw spool alone is wrong; use bodiesEvidence, memory-flat", keywords: turn_count_shrinks_between_runs fact_db_missing_event diagnostics_answer_changed spool_file_deleted_by_drain evidence_base_volatile indexer_reads_only_spool unclassified_events_preset forensics_db_coverage_gap, ocd: 2026-08-13, lmd: 2026-08-13]

The forensics fact DB (FAL, api_calls) and every raw-body diagnostic MUST source from the store∪spool evidence base (src/store/bodiesEvidence.ts: listBodyEvidence + loadBodyTexts), never the raw spool alone — the ingest drain deletes spool files once Parquet provably holds them, so a spool-only reader's answers change with WHEN you ask (measured: classifier saw 01:08Z, fact DB covered 01:28-01:50; a session's turn count shrank 172→145 between identical queries). Landed c783091 (indexer) + 08e1c35 (cacheBreakTimeline). Two invariants ride along: (1) the union is complete BY CONSTRUCTION via the delete gate; (2) request processing must stay MEMORY-FLAT — derive content tags inside the load chunk and retain only scalars, never raw text (retaining rawText measured ~1.8GB/5h window, the TRDD-34B9JAZK RSS-kill shape). Presets unclassified_events + schema (56eddb0) are the drill-down entry points.




^ATOM-R4X7-VMJ1 [desc:"DuckDB ignore_errors emits all-NULL rows for bad NDJSON lines - count verifies pass, degradation invisible without count(col)", keywords: duckdb_ignore_errors unparseable_ndjson_line all-NULL_row seal_verify_passes torn_line_silently_lost count_matches_but_data_degraded, type: project, ocd: 2026-08-02, lmd: 2026-08-02]

DuckDB read_json_auto with ignore_errors=true does NOT drop an unparseable NDJSON line — MEASURED (2026-08-02): it lands as an all-NULL row, so a row-count verify passes and cannot detect the degradation. A truncated-after-a-value object is even silently REPAIRED (closed at EOF) and parses fully. Consequence for any seal/convert-verify design: count a required-always column (count(ts) < count(*)) to see NULL-ified torn lines; a count(*) match proves nothing about line integrity. Regression: src/test/statuslineSealAndFilter.test.ts.




^ATOM-8309-X2EP [desc:"Sync streaming gunzip exists only via zlib's internal Gunzip._processChunk, and needs BOTH minizlib interceptions: noop handle.close AND restore engine._handle after each call", keywords: sync_streaming_gunzip gunzipSync_memory_spike _processChunk zlib_whole_file_buffer gz_segment_read minizlib, type: project, ocd: 2026-08-13, lmd: 2026-08-13]

Node has NO public sync streaming gunzip — `gunzipSync` returns the whole output (a 568MB sealed
day = the RSS-ratchet allocation). The only sync streaming path is `Gunzip.prototype._processChunk`
(what gunzipSync itself is built on; the minizlib/node-tar mechanism), and it needs BOTH
interceptions per call or it fails subtly: (1) noop `handle.close` for the call's duration (the
sync path closes the native handle when it thinks the one-shot is done), AND (2) restore
`engine._handle = handle` afterwards — the internal `_close()` NULLS it, and un-restored the read
loop stops after ONE chunk, silently truncating output (caught red by the byte-equality test).
Implementation + pinning tests: `src/ndjsonLines.ts::forEachGunzipChunkSync` +
`ndjsonLines.test.ts` (byte-equality vs gunzipSync at many chunk sizes, truncation-throws,
corrupt-throws). Landed ed501db.




^ATOM-5PSZ-R2GD [desc:"zlib delivers an error TWICE (sync throw + async re-emit); _processChunk piles up error listeners per call, and dropping them ALL turns the re-emit into an uncaught crash — keep exactly ONE persistent", keywords: MaxListenersExceededWarning_Gunzip uncaught_unexpected_end_of_file zlib_error_twice removeAllListeners_uncaught _processChunk_error_listener, type: project, ocd: 2026-08-13, lmd: 2026-08-13]

The sync streaming gunzip driver needs a THIRD interception beyond the two in ATOM-8309-X2EP:
`_processChunk` registers a fresh 'error' listener per call (CI's MaxListenersExceededWarning at
11 chunks), but zlib delivers an error TWICE — the sync throw our callers see, plus an async
re-emit on a later tick that those accumulated stale listeners were silently absorbing. Removing
them all (the naive fix) made the truncation test an UNCAUGHT crash. Correct shape: attach ONE
persistent no-op 'error' absorber at engine creation and re-attach it after each per-call
removeAllListeners — flat count, harmless re-emit. Pinned by a warning-capture test
(ndjsonLines.test.ts); landed ed084ff.



## Governed by

- [[agentlenspro-ops-lessons]] — the operational-doctrine overview this sub-page details.

## See also

- [[ssd-write-economics]] — what the drain is ultimately protecting: the SSD write budget, why the
  RAM spool is the whole margin, and why batching is only the enabler of compression.
- [[log-scan-performance]]

## Notes and lessons learned

[^18]: [id:ATOM-6UEY-8Q1C, status:valid, desc:"The failure mode is not the throw — it is the catch that turns the throw into missing data", keywords:"catch_continue_hides_a_read_failure silent_data_loss_at_scale whole_file_read_of_an_uncapped_file why_is_a_day_missing_from_results readFileSync_on_an_append-only_store", ocd:2026-08-02, lmd:2026-08-02] DO NOT read a whole append-only data file with `readFileSync(f,"utf8")`, and NEVER wrap such a read in `catch { continue }`, BECAUSE past ~512 MB the read THROWS V8's max-string-length error and the silent catch then erases that entire file from the answer — the caller sees a smaller result, not an error. DO stream the file (chunked reads + StringDecoder for chunk-split UTF-8) and log any read failure by name: a query that quietly answers with one day less is worse than one that fails.
