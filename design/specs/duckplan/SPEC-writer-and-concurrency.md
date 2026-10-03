---
title: SPEC - writer thread, queues, transactions, locks and races of alcore's new DuckDB index
status: draft (revision 1, 2026-10-03; items marked OPEN-W17/W18/W19/W15 await DUCKPLAN revision 2 and experiment E7)
scope: project
created: 2026-10-03
unit: WRITER
sources: docs_dev/duckplan-decisions.md (DEC) AND docs_dev/duckplan-decisions-r1.md (R1; on conflict R1 wins; R1-D4(b)(c), R1-D5 identity, R1-D10 and the R1-ENG6 snapshot procedure are OPEN pending revision 2, see section 10); reports/DUCKPLAN/20261003_165118+0200-concurrency-and-flaws.md (CF, hazards H1-H31); reports/DUCKPLAN/20261003_192823+0200-duckdb-capabilities.md (CAP, sections 1, 2f, 2g, 3, 4, 5/8, 6, 7, 9, 13, 14, 15, 16); code at HEAD 94125a8d
siblings: SPEC-read-api.md (reader pool), SPEC-legacy-card-import.md, SPEC-golden-capture-and-clock.md, SPEC-method-bench.md, SPEC-interim-stabilization.md, SPEC-effects-handling.md, SPEC-operation-catalog.md
---

# Writer and concurrency design for `index.duckdb`

Conventions. DECIDED = a decision in DEC or R1 (cited `D-n`, `D-ENG-n`, `D-DAT-n`, `R1-...`). CF `Hn` = audit hazard. CAP `§n` = capabilities report. `file:line` is under `rust-core/crates/agentlens-core/src/` unless stated and was read at HEAD 94125a8d (it drifts; re-grep before editing). PROPOSED = this spec's own choice (nobody decided it yet, but it follows from DECIDED facts). OPEN = not decided; the named test/bench/revision decides. Table and column names are the names used in DEC/CF; the schema spec owns the columns, this spec owns the ORDER of statements and the concurrency semantics. Nothing in this spec deletes a user-visible artifact: every "remove" is a rename aside (RULE 0, D-11).

One-sentence rationale: the index becomes the only copy of the content, so exactly one thread may mutate it, every mutation is one explicit transaction that is all-or-nothing together with its file offset, and every other thread only produces finished batches or reads snapshots.

## 1. Thread model

### 1.1 Diagram

```
 PRODUCERS (parse + read; NEVER hold a DuckDB connection or transaction)
   LIVE producers run at NORMAL QoS (R1-D7); only BACKFILL work runs at background QoS
 ┌────────────────────────────────────────────────────────────────────────────────────────┐
 │ watcher thread(s) (notify, log_reader.rs:1413 attach_watchers) ─┐                     │
 │ 60 s backstop FULL_RESCAN (log_reader.rs:1263) ────────────────┤                     │
 │ boot sweep / backfill pull (newest first) ─────────────────────┼─► SCHEDULER (1 thread,│
 │ NDJSON span tailer (own offset, D-6, R1-D6) ───────────────────┤   owns file work set, │
 │ /api/import handler, /api/clear handler (ui.rs:1487,1595) ─────┤   NORMAL QoS, no DB)  │
 │ retention chore timer (chores.rs:68 span_tick) ────────────────┘        │             │
 │                                                                         ▼             │
 │   PARSER WORKERS (std threads): LIVE worker = 1 at NORMAL QoS; BACKFILL worker = 1 at │
 │   background QoS (set_background_qos bg_qos.rs:12). Each reads a bounded slice of ONE │
 │   file -> parses -> finished row batch                                                │
 └───────────────────────────────┬────────────────────────────────────────────────────────┘
                                 │ byte-bounded queue: LIVE lane (strict first) | BACKFILL lane
                                 ▼
 ┌────────────────────────────────────────────────────────────────────────────────────────┐
 │ WRITER THREAD "idx-writer" (std thread, NORMAL QoS; the only owner of the write        │
 │ Connection and of BEGIN/COMMIT). Sole mutator of: file, file_ctx, node_key, node,      │
 │ node_meta, node_rollup, api_call, event, tool_use, tool_result, spawn_*, raw staging   │
 │ and raw index, ingest_batch, ingest_batch_root, ingest_error, meta, otel_span*.        │
 │ After each COMMIT: publishes {v,since,boot_id,clear_epoch} to the SSE hub, releases    │
 │ byte permits, tells the scheduler `Committed(file_id,new_off)`.                        │
 └───────────────┬────────────────────────────────────────────────────────────────────────┘
                 │ same duckdb Database instance (try_clone connections = snapshot isolation, D-ENG-4)
 ┌───────────────▼────────────────────────┐   ┌──────────────────────────────────────────┐
 │ READER POOL (SPEC-read-api §4)         │   │ SEALER (std thread, bg QoS, own reader   │
 │ 4 interactive + 1 heavy connections,   │   │ connection): only if raw storage is a     │
 │ normal QoS (tokio blocking threads of  │   │ part format (R1-D1: C1/C2); encodes raw   │
 │ `rt`, never `bg_rt`), semaphores,      │   │ staging into parts, then submits a        │
 │ deadlines, short read transactions     │   │ SealCommit job to the writer (§3.3)       │
 └────────────────────────────────────────┘   └──────────────────────────────────────────┘
 CHORES (bg_rt, max 4 blocking threads bin/alcore.rs:329): touch the index ONLY by submitting
 writer jobs, or by a pool slot run on `rt` (§6.2). They never open a connection of their own.
 OTHER DuckDB instances (unchanged, in-memory; budget §9): session_summary_sql.rs:117,
 transcript_sql.rs:409, bodies_evidence.rs:77, statusline_store.rs:230, agentlens-store/src/lib.rs:158.
```

### 1.2 Who does what (and the QoS rule)

| Role | Thread | QoS | Touches DuckDB? | Source of the rule |
|---|---|---|---|---|
| tokio HTTP handlers (OTLP, hooks, statusline, import, clear, reads) | `rt`, 2 workers (bin/alcore.rs:328) | normal | readers only via pool; writes via writer jobs | H2 |
| OTLP handler | `rt` | normal | NO. Appends to the span writer's in-memory buffer through today's span writer and answers 200 BEFORE the <= 5 s flush to the NDJSON file (today's behaviour, lib.rs:940; the 5 s loss window on SIGKILL is unchanged and owned by card S1) | D-6, R1-D6 |
| scheduler | 1 std thread (replaces the file-selection half of `log-sweeper`, log_reader.rs:1413-1640) | normal (it only stats files and marks them; it sits on the LIVE path) | NO | D-8, H3, R1-D7 |
| LIVE parser worker | 1 std thread | NORMAL | NO | R1-D7 |
| BACKFILL parser worker | 1 std thread | background | NO | D-7, R1-D7, H12 |
| NDJSON span tailer | one producer, LIVE lane | NORMAL | NO | D-6, R1-D7 |
| writer | 1 std thread `idx-writer` | NORMAL | YES, the only writer | D-7, H12 |
| sealer (only for a part-based raw store, R1-D1) | 1 std thread | background | read-only connection, snapshot | D-1 |
| reader pool | tokio blocking threads on `rt` | normal | read-only clones | H12, H19 |
| chores | `bg_rt` (chores.rs:928-1200) | background | only by submitting jobs | H12 |

The worker counts (1 LIVE + 1 BACKFILL = 2, the same total as the earlier "N = 2") are PROPOSED; OPEN: SPEC-method-bench may raise the BACKFILL count.

Why LIVE producers are NOT at background QoS (R1-D7 corrects D-7): CAP §4 measured the same ingest at 30,400 lines/s at normal priority and 975 lines/s at background QoS under load (about 30x slower wall time), so a LIVE batch parsed at background QoS would reach the writer far too late for the dashboard. Only BACKFILL, which has no deadline, runs at background QoS. The CPU work itself is comparable (5.0 CPU-s/GB at normal priority vs 7.9 CPU-s/GB at background QoS, measured under different machine load, CAP §4), so only CPU-seconds, never wall time at background QoS, are used to size BACKFILL jobs.

Why the writer is NOT at background QoS: a commit fsyncs; at background I/O priority the OS throttles the fsync and every LIVE job waits behind it (priority inversion; the repo documents the same inversion for the sweeper, log_reader.rs:1440-1447; bg_qos.rs:8-20 sets only the thread QoS class).

### 1.3 What stays OUTSIDE DuckDB (and why it does not funnel)

| State | Where | Rule |
|---|---|---|
| span NDJSON (the durable log for OTLP after the <= 5 s flush) | existing span writer files (plain `.ndjson` and sealed `.gz` day files) | the tailer reads it with its own offset stored in `file` (D-6); gzip files are readable (R1-D6); a day file is sealed (gzipped) only when the tailer offset equals its size; retention and clear never remove a day file the tailer has not finished (R1-D6, §5.2) |
| hook-event bucket files, hook ring, lifecycle | files + `CoreState` | stay as today (hook_events.rs:36 `append_bucket_line`). OPEN-W1: OCAT row H10 names a `hook_event` table (NS-3); if it becomes a table it is a LIVE-lane producer job, never a handler-side write |
| statusline WAL | `statusline_store` | unchanged; flushed on the burn tick (ui.rs:4144) |
| burn runtime, `last_status`, account timeline, alerts | `CoreState` mutex | unchanged. Nothing is ever enqueued while holding the `CoreState` mutex (H2) |
| `pid_lock` | data dir | unchanged order rules, see §7 |
| StopFailure calibration (hook_events.rs:225-240) | reads a pool connection AFTER releasing the state lock | H16 |

OPEN-W2: OTLP `/v1/logs` derived rows (account map, body pointers, the `gen_ai.output.messages` overlay, H15). PROPOSED rule that follows from D-6: an OTLP handler never enqueues a writer job; any row derived from an OTLP payload must be in a file the tailer reads (the span NDJSON, or a sibling log-events NDJSON with the same offset discipline). Which table gets which payload is the schema spec's decision; the constraint here is only "through a file, with an offset".

## 2. The queue

### 2.1 Structure

One `WriterQueue` guarded by a plain `Mutex` + `Condvar` (never the `CoreState` mutex):

```
struct WriterQueue { live: VecDeque<Job>, backfill: VecDeque<Job>,
                     live_bytes: usize, backfill_bytes: usize, closed: bool }
Job = { kind, lane, epoch: u64, job_ord: u64 (arrival order), bytes: usize (accounted), batches: Vec<FileBatch> | Control }
FileBatch = { file_id, gen, identity (dev,inode,fingerprint), expected_off, new_off,
              rows (columnar staging buffers), ctx: Vec<u8>, touched_roots, line_count }
Control = Clear | SwapIndex | SealCommit | RetentionChunk | ImportChunk | CtxPrune | Checkpoint | Snapshot | Shutdown
```

A group never holds two batches of the same file: the scheduler hands a file to one worker at a time and requeues it only after `Committed` (§4.1).

Budgets are in BYTES of the staged buffers, never in message count (H2). Proposed split of one total `Q` (OPEN value, fixed by the budget table in §9; 64 MiB assumed here): LIVE 40 MiB, BACKFILL 24 MiB. Separate budgets so BACKFILL can never fill the queue and block LIVE. A permit is a byte reservation taken BEFORE a producer reads and parses (reserve = bytes about to be read x 4, the parse expansion factor, OPEN: measured), trimmed to actual size after parse, and released by the writer after COMMIT or discard. A job larger than its lane budget is admitted only when that lane is empty (a 4.4 MiB line, D-DAT-7, must be able to pass; the 64 MiB import body is chunked before it gets here).

### 2.2 Writer loop

```
loop {
  job = pop LIVE; else pop BACKFILL; else wait on Condvar          // strict LIVE first
  if job.lane == LIVE and job.kind is a file/span batch {
      group = [job]; window = 20 ms from the first pop (PROPOSED, CF H2); stop at 1000 rows or LIVE_GROUP_BYTES (4 MiB)
      while window not elapsed and not full { take whatever LIVE job is already queued, else wait the rest of the window }
      run_transaction(group)                      // ONE BEGIN..COMMIT, ONE fsync (§3)
  } else if job.lane == BACKFILL {
      run_transaction([job])                      // job was sized by the producer to its time budget
      sleep(duty_pause)                           // §2.4
  } else { run_control(job) }
  // between ANY two transactions the loop re-evaluates: LIVE first.
}
```

- LIVE group commit: every payload queued inside the window shares one transaction and one fsync. Per-payload commits at 100+ req/s would be 100+ fsyncs/s (H2, H31). CAP §15 measured explicit-transaction commit p50 0.16 ms / p95 0.40 ms (plain fsync, D-ENG-6), so a 20 ms window is not latency-critical; its job is to bound commits/s to <= 50.
- BACKFILL job size is TIME-budgeted, not byte-budgeted: the producer sizes a batch to about 50 ms of expected writer work, from an EWMA of the writer's measured rows/s for the last 8 BACKFILL batches (the writer reports it back with each `Committed`). A batch always holds at least one line whatever its size; hard maximum 4 MiB of lines, except that a single larger line is its own batch (H7, D-DAT-7). 50 ms and 4 MiB are PROPOSED; OPEN: SPEC-method-bench sets them.
- Anti-starvation floor: after 20 consecutive LIVE groups while BACKFILL is non-empty, one BACKFILL batch runs (PROPOSED; the live rate is ~8 KB/s on average, D-DAT-8, so this should never bind; the counter `backfill_starved_groups` is exported and a nonzero value in the soak is a finding).
- Group failure isolates per job (§3.4); one bad job never fails its neighbours.

### 2.3 Backpressure per producer (nothing is dropped silently)

| Producer | What happens when its lane budget is exhausted | Why it cannot lose data |
|---|---|---|
| OTLP handler | nothing: it does not use the queue. It appends to the span writer buffer and answers 200 exactly as today, before the <= 5 s flush (lib.rs:1090-1150, :940). No 503 backpressure (D-6) | after the flush the NDJSON file IS the buffer; unbounded disk lag is visible as `tailer_lag_bytes`. Before the flush the up-to-5 s window on SIGKILL is today's behaviour, unchanged, owned by card S1 (R1-D6) |
| NDJSON span tailer | blocks on the LIVE permit; stops reading; its offset stays where the last COMMIT left it | the bytes are still in the file |
| Live file parser (watcher/backstop/tail) | blocks on the LIVE permit before reading; the file stays `Queued`/`Dirty` in the scheduler | the transcript is the source; the CAS offset is unchanged |
| Backfill parser | blocks on the BACKFILL permit, no deadline | same |
| `/api/import` handler | body already parsed; chunks submitted with `try_acquire` with a 5 s deadline, then 503 + `Retry-After` and a visible counter (CF H2/H16) | the client still holds the card; a refused chunk is not partially imported (chunks are independent idempotent jobs, §5.3) |
| `/api/clear`, Checkpoint, Snapshot, Shutdown, SwapIndex | control jobs have zero byte cost and are always admitted | never refused |
| retention timer | submits ONE `RetentionChunk` at a time and does not submit the next until the previous one is acknowledged | no queue growth |
| hook events (only if OPEN-W1 makes them a table) | same as the live parser | the bucket file is the WAL |

Exported gauges (in `/api/server-stats`): `queue_bytes{lane}`, `queue_jobs{lane}`, `producer_blocked_ms{producer}`, `tailer_lag_bytes`, `commits_per_s`, `group_size`, `backfill_starved_groups`, `ingest_error_count`.

### 2.4 CPU politeness (owner: "no long high-CPU bursts; the system must stay responsive")

After every BACKFILL transaction the writer sleeps `duty_pause = batch_wall_ms * (1/duty - 1)` with `duty` = 0.5 (PROPOSED, OPEN: bench; target "<= 0.5 core" from CF H18). LIVE batches get no pause. The BACKFILL parser is at background QoS and is throttled by the OS and by the permit; LIVE parsers are not throttled. rss_guard pressure (rss_guard.rs:400 `pressure_fracs` 0.70/0.80/0.90 of the cap, :420 `pressure_thresholds`): at stage 1 the writer pauses the BACKFILL lane entirely until pressure clears (PROPOSED; OPEN: which stage).

## 3. Batch transaction recipe

### 3.1 Invariants (hold for every transaction, every lane)

1. One explicit `BEGIN` ... `COMMIT` per group. No autocommit statement ever touches the index in a batch path: an autocommit statement would commit alone and let a reader see rows without their rollup (H10; the repo already guards this class at card_store.rs:537). The writer wraps the connection in a type whose `execute` panics unless `in_txn` is set (a test asserts it, §8 W-T10).
2. Every index-resident table touched by the batch commits together with `file.off`; nothing is durable that the offset does not cover, and the offset never covers anything not durable (D-8).
3. Idempotency is per ROW (R1-D4). (a) A same-file re-read is prevented by the offset CAS (D-8), so display rows keyed `(file_id, gen, byte_off, sub_index)` (D-4) need no global key. (b) What a generation bump (replaced or pruned file) does to old rows, to the node rollup and to the display is OPEN-W5 (R1-D4(b), pending revision 2); the writer obligation is only that a new generation never lowers an old generation's offset and that its rows carry `gen`. (c) Cross-file duplicates (sibling subagent files, fork copies, D-DAT-3/4) matter only for totals; the `api_call` guard predicate (who may update an existing row, whose attribution is kept) is OPEN-W17 (R1-D4(c), pending revision 2/E7). (d) Rollup deltas are computed from the rows the batch actually APPLIED (changed-row capture: the delta statement uses the same predicate as the upsert and the upsert's row count must equal the captured count, §3.2 steps 7-8), never from the batch input (R1-D4(d)).
4. The ONE indexed upsert path is `api_call` (logical key `(source, message_id)`, stored as a 128-bit hash, D-4); the physical uniqueness mechanism is OPEN-W21 (R1-D4-ART, experiment E6) and `otel_span`'s uniqueness is OPEN-W14. No other table that grows with the corpus gets an ART index and no bulk DELETE runs against an indexed table (D-ENG-2). `UPDATE`d columns are never indexed (D-ENG-4: UPDATE of non-indexed columns works).
5. The writer holds NO cache of file offsets across a clear epoch (D-8): the guard step (3.2 step 2) reads `file` and `meta` inside the transaction.

### 3.2 Exact statement order

`stg_*` are `TEMP` tables created once at writer start, without any index, same columns as their targets plus `job_ord`. They are filled by the DuckDB Appender (CAP §1: the Appender participates in the open transaction; always check `flush()`; LIST values are unsupported, so lists are staged as JSON/VARCHAR or flattened). Statement names below are logical; the SQL is parameterized and prepared once at writer start. D-ENG-3 rule: every statement that upserts is fed by a staging relation that was first collapsed with `QUALIFY row_number() OVER (PARTITION BY <key> ORDER BY ...) = 1`, because duplicate keys inside one statement are silently FIRST-ROW-WINS even for `DO UPDATE` (CAP §2a).

| # | Step | Statement (logical) | Notes / failure meaning |
|---|---|---|---|
| 1 | open | `BEGIN` | |
| 2 | guard | `SELECT value FROM meta WHERE key='clear_epoch'`; `SELECT file_id, gen, off, state, identity FROM file WHERE file_id IN (batch files)` | Compare in Rust. Epoch differs from the epoch the job was read under: ROLLBACK, discard the whole job (D-8). Offset or gen differs from `expected_off`/`gen` for one batch of a group: that batch is dropped before any write and the scheduler is told `Dropped(file_id, StaleOffset)` (it re-fetches `file` and requeues). All stale checks are done BEFORE the first write so a group never half-applies |
| 3 | node ids | resolve the node identity key -> `nk` from the writer's in-memory `HashMap` (loaded at boot from `node_key`, ~40k rows, CF H8; the identity key itself, path (D-5) or `(dev, inode)` (R1-D5), is OPEN-W18); allocate new nk from `next_nk` (initialised `max(nk)+1` at boot) | allocation only on the writer thread; the map and `next_nk` are updated only AFTER COMMIT (a rolled-back batch leaves a harmless gap, CF H11) |
| 4 | stage | Appender -> `stg_raw_line`, `stg_api_call`, `stg_event`, `stg_tool_use`, `stg_tool_result`, `stg_node`, `stg_node_meta`, `stg_spawn_edge`, `stg_spawn_result`, `stg_span`; `flush()` each, error = abort | rows carry `(file_id, gen, byte_off, sub_index)` and the `job_ord` of their job |
| 5 | raw | part-based store (R1-D1 C1/C2): `INSERT INTO raw_staging SELECT file_id, gen, byte_off, len, line FROM stg_raw_line`. Column store D (zstd column inside DuckDB): the same INSERT targets the final raw table and there is no staging, sealer or part | raw lines (BLOB, byte-exact, CF H7) stay in DuckDB until sealed. Which of D / C1 / C2 is used is OPEN-W20 (R1-D1, Rust bench) |
| 6 | collapse | `CREATE TEMP TABLE c_api AS SELECT * FROM stg_api_call QUALIFY row_number() OVER (PARTITION BY message_hash ORDER BY <order fixed by OPEN-W17>) = 1`; the same for `c_span` (`PARTITION BY trace_id, span_id`) and `c_node` (`PARTITION BY node key`) | D-ENG-3. Interim `ORDER BY job_ord ASC, byte_off DESC` (the LAST row of the earliest job, so D-DAT-2's growing subagent usage row survives and a sibling's identical row cannot displace it); OPEN-W17 may change the order (largest usage first). `DROP` at step 17 (temp tables are transactional) |
| 7 | rollup delta | `INSERT INTO stg_rollup_delta SELECT nk, sum(new.tokens - coalesce(old.tokens,0)), ..., count(new rows that insert), max(least(ts_ms, :now_ms + 300000)) FROM c_api new LEFT JOIN api_call old USING (message_hash) WHERE old.message_hash IS NULL OR GUARD(old, new) GROUP BY nk` plus the non-api_call deltas (counts of event/tool_use rows, bytes) | MUST run BEFORE step 8 and uses the SAME `GUARD` predicate as the upsert (changed-row capture, R1-D4(d)): a growing usage row (D-DAT-2) updates an already counted message, so the rollup needs `new - old`, not `new`, and a re-read or a rejected duplicate contributes nothing. Old values are read by this staging join, single writer, same snapshot. The `+5 min` clamp is H20 (a future-stamped line cannot pin a session). Counts of display rows come from the staging tables: they are safe because the offset CAS makes each row arrive once |
| 8 | api_call | `INSERT INTO api_call SELECT ... FROM c_api ON CONFLICT (message_hash) DO UPDATE SET <usage columns> = excluded.<..>, <ordering columns> = excluded.<..> WHERE GUARD(api_call, excluded)`; then assert `execute()` row count == count of rows captured in step 7 (a mismatch means the two predicates diverged: ROLLBACK, ENGINE-FATAL defect, never retried) | the only upsert and the only ART index (D-4). `GUARD` is OPEN-W17: R1-D4(c) says "same file AND later row" (`excluded.file_id = api_call.file_id AND excluded.byte_off > api_call.byte_off`); the coordinator's revision-2 candidate is "largest usage wins, attribution fixed at first insert, totals never gen-filtered". Every candidate keeps this statement shape. OPEN-W4: (a) that DuckDB 1.5.5 accepts `WHERE` on `DO UPDATE` (INFERRED, to be run before freeze) |
| 9 | display | `INSERT INTO event/tool_use/tool_result/spawn_edge/spawn_result SELECT ... FROM stg_*` | no PK, no ART, no ON CONFLICT (D-4, R1-D4(a)). Nothing can dedupe them but the offset CAS: this is exactly why step 2 and step 13 are mandatory |
| 10 | nodes | `INSERT INTO node_key/node SELECT ... FROM c_node ON CONFLICT DO NOTHING`; `INSERT INTO node_meta SELECT ... FROM stg_node_meta` (append-only, read as arg_min/arg_max at read time, H26); `UPDATE node SET created_ms = :min_ts WHERE nk = :nk AND created_ms IS NULL` for nodes whose first timestamped line is in this batch (check row count) | `created_ms` is a set-once UPDATE of a non-indexed column (R1-D5; CAP §9 verified UPDATEs on non-indexed and even indexed columns); nodes with no timestamped line stay NULL and are not listed. The only other UPDATE of `node` is a path change of a moved file, if OPEN-W18 settles on a path attribute. `node_key` has a PK of ~40k rows (bounded, D-4) |
| 11 | rollup | (a) `INSERT INTO node_rollup SELECT d.* FROM stg_rollup_delta d WHERE NOT EXISTS (SELECT 1 FROM node_rollup r WHERE r.nk = d.nk)` (b) `UPDATE node_rollup SET c1 = c1 + d.c1, ..., last_active_ms = greatest(last_active_ms, d.last_active_ms) FROM stg_rollup_delta d WHERE node_rollup.nk = d.nk` | ONE set-based statement per table (CF H10, D-3); `NOT EXISTS`, not `NOT IN`, so a NULL cannot silently empty the insert. `node_rollup` has no PK/ART (D-3), so the writer asserts `rowcount(a) + rowcount(b) = count(distinct nk in stg_rollup_delta)`. Numeric columns only; text stays in `node_meta` (H10). The rollup repair after a generation bump is OPEN-W5 |
| 12 | root cache | `DELETE FROM root_cache WHERE nk IN (touched roots)`; `INSERT INTO root_cache SELECT ... ` | small table, no index (D-5) |
| 13 | CAS offset | per file in the batch: `UPDATE file SET off=:new, size_seen=:sz, last_batch=:b, state=:st WHERE file_id=:id AND gen=:gen AND off=:expected AND epoch=:epoch`, check `execute()` row count == 1 | CAP §13: `Ok(1)` / `Ok(0)` verified. Count 0 = the guard missed something (a bug): ROLLBACK, `FATAL: CAS miss` logged with the file id and both offsets, treated as a defect (§3.4), not retried silently |
| 14 | resume ctx | `INSERT INTO file_ctx(file_id, batch_id, ctx) VALUES ...` | append-only, latest wins (D-9, H5); old rows pruned by the `CtxPrune` control job, never in this transaction |
| 15 | batch + roots | `INSERT INTO ingest_batch(id, kind, ts_ms, epoch, rows, bytes, lane, files)`; `INSERT INTO ingest_batch_root SELECT :id, root_nk FROM touched_roots` | `ts_ms` is informational only; ordering is by `id` (H20). `ingest_batch` is never deleted by a clear (H17) |
| 16 | version | `UPDATE meta SET value = :id WHERE key = 'version' AND value = :id - 1`, row count must be 1 | `meta.version` is the monotone counter, not `max(id)` of what survives (H28). It is the last write: the commit point of the group |
| 17 | cleanup | `DELETE FROM stg_*` (temp, unindexed), `DROP TABLE c_api, c_span, c_node` | inside the transaction, so a ROLLBACK also empties staging |
| 18 | commit | `COMMIT` | plain fsync (D-ENG-6): durable across process kill, NOT across power loss, and a power loss can also reorder writes and corrupt the file (R1-ENG6, §7.4) |

After COMMIT succeeds and only then: apply the pending nk map/`next_nk`/file-state updates; publish the SSE frame `{v, since, boot_id, clear_epoch}` (H17); release permits; send `Committed(file_id, new_off)` to the scheduler; add `rows/s` to the EWMA. A crash between COMMIT and the SSE notify is harmless: the client's EventSource reconnects, the first frame carries the current `v`, and a `since` gap or a `Lagged` broadcast (ui.rs:63, `broadcast::channel(64)`) means "refetch everything visible" (H11).

### 3.3 Raw-line storage and part sealing (R1-D1: mechanism OPEN-W20)

R1-D1 replaced D-1: the raw-line store is OPEN between (D) a zstd VARCHAR/BLOB column inside DuckDB (transactional, no staging, 0.22 GB/GB, higher CPU), (C1) Parquet parts written by DuckDB `COPY` (0.128 GB/GB) and (C2) Parquet parts written by the Rust parquet crate (0.138 GB/GB); the Rust bench decides, and on a tie in RAM and CPU DuckDB-native (D or C1) is preferred. With D this section does not apply (step 5 writes the final table inside the batch transaction). The rest of this section is the protocol every part-based candidate MUST carry (R1-D1):

- The SEALER thread (background QoS, a read-only connection, one snapshot) reads the oldest staged rows up to a part boundary and encodes the part to a TEMPORARY name; the row-group size is capped in BYTES, not rows, so writer memory is bounded even with 4.4 MiB lines (D-DAT-7; CAP §2g: a 3 KB-line Parquet COPY hit "Out of Memory" at a 512 MB limit until row groups were small).
- Crash protocol, in this order: write the temp file, `fsync` it, `rename` it to its final name, `fsync` the directory, THEN submit `SealCommit(part, row range)` to the writer. The writer's transaction: `INSERT INTO raw_index SELECT file_id, gen, byte_off, :part, row FROM raw_staging WHERE <range>`; `DELETE FROM raw_staging WHERE <range>`; bump `meta.version` and write an `ingest_batch` row of kind `seal`. Readers see either "in staging" or "in the part", never both and never neither, because both changes are one transaction (CF H10 snapshot argument). Staging is not ART-indexed, so the DELETE is allowed by D-ENG-2.
- Parts are self-describing: every row carries `(file_id, gen, byte_off, path)`, so `raw_index` can be rebuilt from the parts alone (the `reindex --from-raw` path of R1-ENG6, §7.4).
- Startup reconciles the manifest against the files in both directions: a part file not in `raw_index` is MOVED to `parts/_unreferenced/` (a rename, RULE 0; OPEN-W3: who may empty that folder, default never automatic) and its staged rows are still in the index, so nothing is lost; a `raw_index` row naming a missing part is a corruption (exit non-zero naming it, §7.2, never auto-fixed).

### 3.4 Failure handling (fail fast, never hang, never hide)

Classification is by the DuckDB error text captured at the failing statement (the exact strings are INFERRED and each is pinned by a real-engine test, W-T07/W-T08):

| Class | Examples | Action |
|---|---|---|
| ENGINE-FATAL | `FATAL Error`, "database has been invalidated because of a previous fatal error" (an OOM with an ART index loaded, D-ENG-2, CAP §5) | the writer cannot continue: log the raw text, `flush_before_exit`, exit non-zero with a distinct code (OPEN-W7: code table). The file is intact (CAP §5: 6.3M rows after reopen); restart replays the WAL. No retry |
| TRANSIENT | `TransactionContext Error: Conflict on update!` (CAP §13) | cannot occur with one writer; if it does the cause is a second writer, i.e. a bug. ROLLBACK and retry the SAME group up to 3 times with 10 ms / 50 ms / 250 ms backoff; a 4th failure is escalated as ENGINE-FATAL |
| CAS-MISS | step 13/16 row count != 1, or the step 8 row count differs from the step 7 capture | ROLLBACK, log loudly, count `cas_miss_total`, and drop the job (the scheduler re-fetches `file` and re-queues). Two CAS misses for the same file within 1 min = ENGINE-FATAL (a scheduler bug must not spin) |
| DATA | conversion error, constraint violation, any other statement error attributable to row content | poison-line path below |
| IO | disk full, `fsync` error | treat as ENGINE-FATAL (fail fast); disk space is the owner's to free: stop, tell the owner, never delete anything to reclaim it (git-and-destructive-safety) |

Poison-line path (CF H7; replaces "retry forever"):
1. ROLLBACK. Retry the IDENTICAL group once immediately (rules out a one-off).
2. Second failure: isolate per job (each job of the group in its own transaction). The jobs that pass commit normally.
3. A failing job with more than one line is bisected by line range over its byte order: first half as its own transaction (commits and advances `off` to the middle line boundary), then second half; recursion until ONE line fails. Cost O(log n) transactions; offsets stay line-aligned.
4. The single failing line is committed in a transaction that (a) keeps its RAW bytes (staging row, so full content is preserved), (b) inserts `ingest_error(file_id, byte_off, len, error, line_head 4 KiB, ts_ms, batch_id)`, (c) skips the derived rows of that line, (d) advances `off` past the line with the CAS, (e) bumps `ingest_error_count`. If even this raw-only transaction fails, the cause is the schema or the engine, not the line: ENGINE-FATAL.
5. A line larger than `LINE_HARD_CAP` (256 MiB, PROPOSED; the corpus maximum is 4.4 MiB, D-DAT-7) is stored as `{truncated:true, bytes:N, head:first 1 MiB}`, logged at error level and also recorded in `ingest_error`. This is the ONLY path in the design that discards content the owner's rule says must be copied in full; it exists only because an unbounded line would break the memory budget, and it loses data only if the source transcript is later deleted. OPEN-W16: keep it, or store an oversize line byte-exact outside the batch path.
6. The release gate asserts `ingest_error` is EMPTY on the real corpus (CF H7). A re-drive job that re-derives rows from the raw bytes of `ingest_error` entries after a parser fix is OPEN-W6 (follow-up, not required for freeze).

## 4. One owner per file

### 4.1 Scheduler state machine (single thread; it never touches DuckDB itself)

State per `file_id` (the identity key is OPEN-W18: `(dev, inode)` with the path as an updatable attribute per R1-D5, or the path per D-5; DAT-5: subagent session ids collide across parents, so the session id alone is never an identity):

```
Idle ──watcher/backstop names it (size>off)──► Dirty
Idle ──backfill pull (size>off, newest first)──► Queued(BACKFILL)
Dirty ──a LIVE parser worker is free──► Queued(LIVE) ──worker takes it──► InFlight(lane, epoch, expected_off)
Queued(BACKFILL) ──worker takes it──► InFlight(BACKFILL, epoch, expected_off)
InFlight ──watcher names it again──► InFlight + dirty_flag=1          (no second read, ever)
InFlight ──Committed(file, new_off)──► (dirty_flag? Dirty : (new_off<size? Queued(BACKFILL) : Idle))
InFlight ──Dropped(file, StaleOffset|EpochChanged|IdentityChanged)──► re-fetch the `file` row through the reader pool, then Dirty
any ──stat() says gone──► Missing (the `file` row and its offset are KEPT, state='missing'; rows are never deleted, CF H6.6)
any ──epoch changes──► Idle for all, `file` rows re-fetched from the DB (no cached offsets, D-8)
```

Rules:
- A file is handed to at most one parser worker at a time. The backfill pull never selects a file that is `Dirty`, `Queued` or `InFlight`. A watcher/backstop event for an `InFlight` file only sets `dirty_flag` (CF H3 scenario: B2 built from a stale offset cannot exist because there is no second reader).
- The scheduler holds no DuckDB handle. Whenever it needs database state (the `file` row after a `Dropped`, the latest `file_ctx` row at hand-out) it sends a `Fetch` request to the reader pool, which runs ONE point query on a normal-QoS `rt` blocking thread and returns the value over a channel. At boot the main thread loads every `file` row before the scheduler starts (§7.1 step 6).
- Large-gap rule (CF H3): if `size - off` exceeds `LIVE_MAX_GAP` (8 MiB, PROPOSED) the LIVE worker ingests ONE bounded LIVE batch (at most the 4 MiB slice) and the scheduler moves the remainder to the BACKFILL lane. A file never visited, size 700 MB, offset 0, is never read at LIVE priority. Today's `read_lines_from` does `read_to_end` into one buffer (log_reader.rs:667-675); the new reader is bounded by the slice size (bytes read cut at the last `\n`).
- The 60 s backstop (log_reader.rs:1263 `FULL_RESCAN`, a stat of ~13.5k files) and the recursive watcher stay; their output is now "stat + mark Dirty", never a parse (CF H31). A full poll every 5 s (`LOG_SWEEP_INTERVAL`) only when no watcher attached (log_reader.rs:1479).
- Unchanged-file gate stays an equality test on `(mtime, size, inode)`, not an ordering (CF H20; log_reader.rs:456).
- Scheduler death = writer starved: the scheduler is supervised; a panic exits the process (fail fast), it is never restarted in place.

### 4.2 Reading one slice (what a parser worker does, in order)

1. `open()` the file, then `fstat` the OPENED handle (never a path `stat` taken earlier: the prune-by-rename race of CF H6 #1 where `ino`/`size` describe the old file and the bytes come from the new one).
2. Identity check against the stored row: `(dev, inode)` equal AND content fingerprint equal: hash of the first 4 KiB, hash of the 64 bytes immediately before `off`, and the byte at `off-1` equals `\n` (D-DAT-1). Any mismatch (including inode reuse, truncate-and-regrow, a prune by rename, a misaligned `off`) = rotation: the worker returns `Rotated(file)`; the scheduler starts a NEW generation of that file (`gen` + 1, `off = 0`; old rows and the old offset are kept, never reset to a lower value) and queues it. How a generation is represented (a `gen` column on one `file` row, which is what D-4's keys `(file_id, gen, byte_off, sub_index)` assume, or a new `file_id`), the file/node identity rule, what happens to the old generation's rows in views, and how the node rollup is repaired are OPEN-W5 and OPEN-W18 (R1-D4(b), R1-D5; pending revision 2). R1-D4(b)'s candidate (old-gen rows hidden by `gen = file.gen`, node-scoped rollup recompute, archived-lines view) is NOT implemented here until revision 2 confirms it.
3. Read `[off, min(fstat.size, off + slice))`, cut at the last `\n`; a trailing partial line stays unread (it will be complete on a later read). Invalid UTF-8 is kept as bytes (BLOB, CAP Q17, CF H7).
4. Parse with the resume ctx the scheduler fetched through the reader pool at hand-out (D-9; never from a cache that outlives an epoch), producing a `FileBatch` and the new ctx.
5. Take the byte permit, enqueue. If the epoch changed while reading, discard instead of enqueueing (cheap early drop; the writer's guard is the authority).

### 4.3 CAS predicate and epoch

`UPDATE file SET off = :new ... WHERE file_id = :id AND gen = :gen AND off = :expected AND epoch = :epoch`, row count 1 (§3.2 step 13). `epoch` is `meta.clear_epoch` mirrored in an `AtomicU64`; every `Job` carries the epoch it was handed out under. The writer drops a job whose epoch differs from `meta` (checked inside the transaction, step 2); the CAS predicate is the second line of defence and also catches a scheduler bug (CF H3/H4). Whether a clear bumps the epoch at all depends on OPEN-W19 (§5.1); the guard is identical either way.

## 5. Clear, import, retention as writer jobs; restart during clear

### 5.1 `/api/clear` (mechanism OPEN-W19; the machinery below is the D-10 outcome, kept until revision 2)

Status. D-10 decided a rebuild of the derived tables beside the live index, swapped in, with raw content never deleted. R1-D10 replaced it with a "forget-before-T" watermark (no rebuild, no deletion; every read hides data older than T; rebuild only as a separate admin `reindex` after a free-disk check). The coordinator reports that the final review found flaws in R1-D10 and that revision 2 will most likely restore today's meaning (drop the OTEL spans, rebuild the derived data). Until revision 2 lands, this spec specifies the concurrency of the rebuild-and-swap form, because it is the superset: it contains the rebuild machinery that a `reindex` needs under every candidate, and the epoch, guard and CAS rules of §3-4 are identical under all of them. If revision 2 picks the watermark, this section collapses to ONE control transaction that records T in `meta` (`clear_epoch`, `clear_ts`), inserts `ingest_batch(kind='clear')`, bumps `meta.version`, and moves nothing else (no job needs to be dropped, no offset resets); the rebuild below then serves only the admin `reindex`.

Today: `clear_all` empties the card store under the state lock (lib.rs:705-711), then `Msg::Clear` reaches the sweeper (log_reader.rs:1305, handled at :1506-1510) which sets `tailer.clear()`, `needs_full = true`; the guard is the `clear_in_progress` meta flag (card_store.rs:536-547) with a documented residual window for a second clear (log_reader.rs:1486-1490). Rebuild form: derived tables are rebuilt from the RAW store (raw parts + staging + legacy rows), in a side database, then swapped. Raw parts and legacy rows are untouched (D-10, `/api/import` rows included).

Mechanism (PROPOSED; D-10 fixes the outcome, this spec fixes the concurrency):
1. Admission: the handler checks the memory budget with a second index instance (§9) AND the free disk space (R1-D10: free space must cover the side database; PROPOSED threshold: at least the current size of `index.duckdb` plus 1 GiB, because on APFS the clone below costs nothing at first but diverges as the derived tables are rewritten); refuse with 409 and the numbers if either does not fit. A second clear while one is `rebuilding` returns 409 `clear_in_progress` (this closes the residual window of log_reader.rs:1486-1490).
2. PREPARE (control job on the writer): `CHECKPOINT`; `cp -c index.duckdb index.duckdb.next` (APFS clone, instant, copy-on-write; the checkpointed file has an empty WAL so the file alone is consistent; on a filesystem without clones the copy is a measured cost, OPEN-W8); record in the old `meta`: `clear_state = rebuilding`, `clear_started_ms`, per-file watermark = every `file.off`; write `index.swap.json` (journal: `{phase, next, old_version}`). Bump `meta.clear_epoch` ONLY at the swap, see step 5.
3. REBUILD (a `Rebuilder`, own thread at background QoS plus its own `IndexWriter` on `index.duckdb.next`, a SECOND Database instance on a DIFFERENT file, which DuckDB allows, INFERRED, W-T22): in `next`, `DROP`/`CREATE` the derived tables (never touching raw tables, raw index, staging, `ingest_batch`, `ingest_error`), zero every `file.off` and `file_ctx`, then re-ingest by running the same parse path whose line source is `raw index + staging + parts` instead of the disk file, ordered by `(file_id, gen, byte_off)`. It uses the SAME recipe (§3) and its own queue; it needs no new write path.
4. Meanwhile the LIVE index keeps ingesting (the dashboard stays correct and responsive). The rebuilder follows it: after its first pass it loops "process raw rows with `byte_off` past my watermark" reading them from the live index through a pool reader.
5. SWAP (control job on the live writer) once the remaining delta is under `SWAP_DELTA_BYTES` (8 MiB, PROPOSED): (a) scheduler paused, parser workers drained, LIVE/BACKFILL queues flushed; (b) the rebuilder processes the final delta; (c) `CHECKPOINT` + close `next`; (d) take the pool's exclusive gate (readers get 503 `overloaded` + `Retry-After`; the gate wait is bounded by the reader deadline 20 s, SPEC-read-api §4.3; if it times out the swap aborts BEFORE any rename and retries later); (e) `CHECKPOINT`, close every connection and the Database of the live index; (f) rename `index.duckdb` -> `index.duckdb.pre-clear-<ts>`; (g) rename `index.duckdb.next` -> `index.duckdb`; (h) reopen with the normal open policy (§7.2), recreate temp staging tables, reload the nk map, recreate the pool; (i) the first transaction on the new index inserts `ingest_batch(kind='clear')`, sets `clear_epoch += 1` and continues `meta.version` from the old value + 1 (H17); (j) delete `index.swap.json` (a journal file, regenerated tmp content; allowed). Readers' window is steps (d)-(h): seconds. The old file stays until the owner removes it; `/api/server-stats` shows its name and size.
6. `meta.clear_epoch` bumps only in step (i), so batches read under the old epoch and still in flight at (a) are drained (committed to the OLD index, which the rebuilder's final delta then consumes) before the swap. After the swap the scheduler re-fetches `file` from the NEW index (offsets = the rebuilder's final offsets) and resumes (no cached offsets, D-8).
7. If (f)-(h) fails after the first rename: rename back (`pre-clear` -> `index.duckdb`), log, exit non-zero (fail fast); the boot table below completes the job on the next start.

Restart during clear: boot reads `index.swap.json` first (before the open policy) and decides:

| Files present at boot | Meaning | Action |
|---|---|---|
| `index.duckdb` only | no clear, or it completed | normal open |
| `index.duckdb` + `index.duckdb.next`, `meta.clear_state = rebuilding` | crashed during REBUILD or before step (f) | open the live index normally; reopen `next` with a Rebuilder and resume (its `file` offsets are its own resume points; it is the same ingest machinery) |
| `index.duckdb.pre-clear-<ts>` + `index.duckdb.next`, no `index.duckdb` | crashed between (f) and (g) | complete (g), then normal open |
| `index.duckdb.pre-clear-<ts>` + `index.duckdb` (new), `index.swap.json` present | crashed after (g) | open the new index; if `meta.clear_epoch` was not yet bumped run step (i), delete the journal |
| `index.duckdb.next` + corrupt/missing `index.duckdb` | unexpected | never auto-fix: exit non-zero naming the files (D-11); the §7.4 snapshot fallback applies only to a corrupt live index |

Nothing in that table deletes a file. A `next` that fails its own open policy is renamed `index.duckdb.next.corrupt-<ts>` and the clear restarts from PREPARE.

`/action clearAll` (spans only, lib.rs:695, ui.rs:1496-1512): a `ClearSpans` control job. Today it unlinks the span store files; R1-D6 forbids removing a day file the tailer has not finished, so the job first flushes the span writer and waits until the tailer offset equals the size of every day file, and only then unlinks them (the rows the tailer ingested while draining are removed by the next step). Then `meta.span_epoch += 1`, tailer batches carry `span_epoch` and are dropped on mismatch (same rule as `clear_epoch`), and `otel_span` rows are removed by chunked `DELETE` ranges of `received_ms` as RetentionChunk jobs. R1-D6 makes `otel_span` unique on `(trace_id, span_id)`: if that uniqueness is an ART index, a bulk DELETE against it is forbidden by D-ENG-2 (a write touching many keys loads the whole index, an OOM is FATAL), so retention and this clear must drop whole `received_ms` partitions or use an index-free uniqueness check instead; the mechanism is OPEN-W14 (decided together with `api_call` by experiment E6). The tailer's `file` rows reset to `off = 0` when the new NDJSON files appear.

### 5.2 Retention (spans, `ingest_batch`, `file_ctx`) as BACKFILL-lane jobs

- Span retention (chores.rs:68-100 `span_tick`, today holding the state lock for the whole pass) becomes a timer that submits `RetentionChunk(cutoff_received_ms, window = 1 hour of received_ms)` one at a time. Retention is by `received_ms`, not `start_ms` (H15.2: a delayed backlog keeps its 30 days from arrival), and bounds `otel_span` to 30 days (R1-D6). A day file is removed only when the tailer offset equals its size (R1-D6): a file the tailer has not finished is skipped and retried by the next chunk, whatever its age. Chunks run on the BACKFILL lane, time-budgeted: a deviation from CF H16, which says LIVE lane, made on purpose, because the goal there ("a month-old backlog never blocks ingest") is met better by a lane that yields to LIVE between chunks; the cost is that a 2-hour backfill delays retention, which only delays disk reuse.
- Raw lines and legacy rows are NEVER retained away (D-10, D-DAT-9).
- `CtxPrune` (keep the latest `file_ctx` row per file) and `ingest_batch` prune (rows older than N days AND id below every active cursor, H28) are control jobs on the BACKFILL lane. `meta.version` is a counter, so pruning never makes `v` fall (§3.2 step 16); the newest `ingest_batch` row is never pruned.
- DuckDB never shrinks the file after deletes (D-ENG-8): the design is append-only for the big tables, so the plateau is accepted.

### 5.3 `/api/import` (ui.rs:1595-1612, import_card.rs:77)

The handler reads the body capped at 64 MiB (ui.rs:1599), parses it in `spawn_blocking`, then submits `ImportChunk` jobs of <= 4 MiB to the LIVE lane. An import is modelled as a synthetic `file` row `import:<sha256(body)>` whose "lines" are cards: the same CAS offset gives idempotency (re-importing the same body adds nothing, a half-failed import resumes at the next chunk), the nodes carry `origin='import'` (R1-ORIGIN: `node.source` keeps the agent source such as `claude_code` or `codex`, and `node.origin` = `live|legacy|import` is the separate column) and the `file_id` of the synthetic row (CF H16). A synthetic file has no `(dev, inode)`; its identity is the string key. No new write path. Whether the route survives at all is CONTRACT-DELTA (CF H16, OCAT); the one-time legacy-card import is SPEC-legacy-card-import and uses the same mechanism through the BACKFILL lane (its node `origin` is `legacy`; R1-ORIGIN asks that spec to be aligned).

## 6. Readers

### 6.1 Pool and lanes (DECIDED shape in SPEC-read-api §4; sizes OPEN)

`try_clone` of the single Database: 4 interactive + 1 heavy connections created at boot, each behind a `tokio::sync::Semaphore` (a `Connection` is `Send`, not `Sync`, CF H19). No clone per `spawn_blocking` task: the blocking pool would otherwise run hundreds of concurrent queries (CF H19). A request waits for a permit `queue_wait_ms` (200 ms) then gets 503 `overloaded` + `Retry-After`. Deadlines 2 s interactive / 20 s heavy via `Connection::interrupt()` from a timer; 408 `deadline`; the slot returns to the pool only after the statement has unwound. Sizes, deadlines and per-connection overhead are OPEN-R2/R9 in SPEC-read-api and not re-decided here. The scheduler's `Fetch` requests (§4.1) use an interactive slot for one point query.

### 6.2 Snapshots and transactions (D-ENG-4)

- Every request is ONE short read transaction on one pool connection, opened and closed inside the handler: `BEGIN TRANSACTION READ ONLY; SELECT value FROM meta WHERE key='version'; <page query>; COMMIT`. The response carries `v` read in the same snapshot (H9, H17). Writer and readers never block each other (CAP §2f: reader median 0.7 ms while a 2M-row transaction ran).
- NEVER hold a transaction across HTTP requests (H9, H19): pagination is by an immutable keyset cursor plus `v`, not by a pinned snapshot.
- Streamed responses hold one transaction for the stream, bounded by the 5 s per-chunk write deadline and a hard wall-clock limit; on timeout the response is aborted, the connection is interrupted and returned (SPEC-read-api §4.5). Pages <= 2 MiB are materialised and the connection returned before the first byte is sent.
- Readers never run at background QoS (H12): a background thread starved by the OS keeps its snapshot, and so old row versions, alive. Chores that need a read (`resident_blob_scan` chores.rs:472, `composition_tick` :618, `bodies_pass` :250, the StopFailure calibration) use a pool slot run on a `rt` blocking thread, with short statements.
- Reader connections are read-only handles into the same instance: no reader can write. The old "read route that writes" (`stamp_and_store_reparsed`, ui.rs:918-945) must not be ported (CF H16); `timeline_page` always has rows.

### 6.3 Checkpoint coordination: evidence supersedes the audit's gate (D-ENG-4, D-ENG-7, CAP §2f, §7, R1-CKPT)

CF H13 proposed a `parking_lot::RwLock<()>` gate (readers shared, writer exclusive during `CHECKPOINT`) on the INFERRED belief that auto-checkpoint is skipped while any transaction is open; SPEC-read-api §4.6 recorded it as DECIDED. R1-CKPT demotes that gate to a fallback: CAP §7 measured the opposite on 1.5.5 (with a reader holding `BEGIN; SELECT` open for the whole run and 1000 MB inserted, the WAL peaked at 18 MB and stayed at 12-18 MB), and CAP §2f: `CHECKPOINT` with a concurrent reader thread returned in 0.03 s and a reader never blocked. Test W-T16 decides. Position of this spec:
1. `checkpoint_threshold` stays at the default 16 MiB (D-ENG-7). Auto-checkpoint does the work. No gate in the default path.
2. WAL watchdog in the writer: after every 100th transaction it `stat`s the `.wal`; above `WAL_ALARM` (64 MiB, PROPOSED, 4x the threshold) it issues a plain `CHECKPOINT` at the next batch boundary (never `FORCE CHECKPOINT`, it aborts other transactions, CF H13) and measures its duration and the WAL size afterwards (exported).
3. Fallback only if W-T16 or the soak shows the WAL not shrinking after 2 consecutive explicit checkpoints with readers active: build and switch on the shared/exclusive gate (it does not exist at HEAD: a search of `rust-core/crates` for a checkpoint gate or an `RwLock<()>` found nothing), and log the event. SPEC-read-api §4.6 is to be read as "fallback", not "DECIDED" (the amendment of that spec is the remaining action; this spec's OPEN-W9 is closed by R1-CKPT).
4. A stream or a stalled client cannot hold a checkpoint hostage in either mode: the 5 s write deadline bounds snapshot age.
5. `temp_directory` for `index.duckdb` is its own directory, excluded from the hourly spill sweeper (chores.rs:219, :928-945), which today deletes by 1 h age (CF H13).

### 6.4 Heavy lane vs writer

`threads` is instance-wide; there is no per-connection priority (CF H19, INFERRED). The mitigations are structural: one heavy permit; BACKFILL pauses at rss pressure stage 1 (§2.4); deadlines. Whether a heavy aggregate measurably delays LIVE commit latency is W-T14 (§8); the knob if it does is `SET threads` lower (INSTANCE-wide) or a smaller heavy deadline. OPEN-W10.

## 7. Startup and shutdown order (D-11, D-ENG-7, H1, H13, H14, H30, R1-ENG1, R1-ENG6)

### 7.1 Startup

Today (bin/alcore.rs): parse config at boot (:175, TRDD-N60JUWU3) -> `pid_lock::claim` (:194, refuses a live owner BEFORE any DB open; pid_lock.rs:118-160 reclaims a stale lock) -> runtimes (:328) -> chores, sweeper -> boot sweep gated on `boot_rx` (log_reader.rs:1642) -> listeners.

New order (each step has a deadline; a failure exits non-zero naming the step):

| # | Step | Deadline | On failure |
|---|---|---|---|
| 1 | parse config, validate all knobs (incl. the budget check, §9) | immediate | exit, message names the term that overflows the cap |
| 2 | `pid_lock::claim` (unchanged) | immediate | exit naming the holder pid (existing text, bin/alcore.rs:198) |
| 3 | `open_index()`: the open policy (7.2) incl. swap-journal recovery (§5.1 table) and the snapshot fallback (§7.4) | `OPEN_DEADLINE` 120 s (PROPOSED) | per 7.2 |
| 4 | immediately `CHECKPOINT` after a successful open (PROPOSED, CAP §14: open does NOT truncate the WAL, so without this every restart pays the full replay again and a crash-loop under rss_guard re-reads the same WAL forever) | 60 s | log, continue (the WAL is still valid) |
| 5 | readback of settings: `memory_limit`, `threads`, `checkpoint_threshold`; the extension policy of §7.5 (json and parquet reported statically linked by `duckdb_extensions()`, `autoinstall/autoload = false` on EVERY instance of the process, D-ENG-1, R1-ENG1); schema version step table; `meta` sanity (`version`, `clear_epoch`, `boot_id` regenerated and written) | immediate | exit (fail fast) |
| 6 | create temp staging tables, load `node_key` map, `next_nk`, load every `file` row and the tailer offsets from `file` for the scheduler (D-8: no sidecar offsets, `log-offsets` retires), pool creation, sealer start (part-based raw store only), writer thread start, orphan-part listing (§3.3) | 30 s | exit |
| 7 | start OTLP listener FIRST (it needs no DuckDB, D-6), then the other listeners; index-dependent routes answer 503 `index_opening` (+ `Retry-After`) until step 6 completes; `/api/health` reports `{state: opening|replaying|ready}` | n/a | n/a |
| 8 | start parser workers and the scheduler; the boot sweep is BACKFILL work and NO LONGER gates readiness (today it does, log_reader.rs:1424-1450; the aggregate responses carry `{complete, backfill:{files_done, files_total, bytes_done}}` instead, CF H18) | not gating | n/a |
| 9 | start the chores last (the WAL replay RSS peak, ~1 GB per GB WAL (D-ENG-7), must not coincide with other instances opening) | n/a | n/a |

`server start` readiness (the CLI's ready probe) must wait for `state=ready`, not for the first TCP accept; its deadline must be raised above `OPEN_DEADLINE` (EHT-03 in SPEC-effects-handling; OPEN-W11: the exact CLI constant). It must not report failure while the replay is still running (CF H13).

### 7.2 Open policy: never delete, never fall back to an empty database (D-11, H1, R1-ENG6)

`CardStore::open` today deletes the database on ANY open error (card_store.rs:221-222 `remove_file` of file and WAL; :259-290 the triggers). `index.duckdb` is the only copy of raw content that Claude Code may already have deleted (`cleanupPeriodDays`, log_reader.rs:690-703), so the same behaviour is forbidden. Classification of the open result (the error texts are INFERRED and pinned by W-T07, W-T08):

| Result | Action |
|---|---|
| file absent, no sibling artifacts, no snapshot | create, apply schema, write `meta` |
| file absent (or renamed aside) and a snapshot exists | never create an empty database: the §7.4 fallback restores the newest snapshot and re-ingests from its offsets |
| lock conflict ("Could not set lock on file ... Conflicting lock is held in <process> (PID n)") | exit 2 naming the holder; do NOT retry, do NOT fall back (CAP, CF H14) |
| corrupt header / WAL checksum failure | rename `index.duckdb` -> `index.duckdb.corrupt-<ts>` and `.wal` -> `index.duckdb.wal.corrupt-<ts>` (a move, RULE 0), then the §7.4 integrity fallback to the newest snapshot; if no snapshot opens cleanly, exit non-zero asking the owner (never an empty database) |
| file written by a NEWER DuckDB than the binary | exit non-zero, no rebuild (a downgrade cannot be fixed by deleting) |
| `meta.schema_version` older | pre-flight clone `cp -c index.duckdb index.duckdb.pre-migrate-<from>-<ts>` (kept), then forward migration (`ALTER`/`CREATE TABLE AS`, one transaction per step, step recorded in `meta`); never a rebuild |
| `meta.schema_version` newer than the binary | exit non-zero |
| anything else | exit non-zero with the raw engine text; no fallback (fail fast) |

WAL size gate BEFORE the open: `stat` the `.wal`; replay needs ~1 GB RSS per GB of WAL and ~2.5 s per GB (D-ENG-7, CAP §14: 65 MB 0.11 s / 197 MB; 258 MB 0.61 s / 702 MB; 1,031 MB 2.53 s / 1,058 MB). If `wal_bytes x 1.1 + the open-time baseline` exceeds the cap headroom (§9), exit non-zero explaining the remedy (raise `AGENTLENS_RSS_HARD_CAP_MB` once; rss_guard.rs:31). The WAL is never deleted. Steady state it is ~16 MiB (D-ENG-7) so the gate only fires after a pathological crash.

### 7.3 Shutdown (today: bin/alcore.rs:420-493, one shared `stop_deadline`, `stop_timeout` default 15 s from serverControl)

Order (every step takes from the same `stop_deadline`, using the existing `remaining()` helper at :432):

| # | Step | Budget | Notes |
|---|---|---|---|
| 1 | stop accepting: scheduler Paused; HTTP write routes answer 503 `shutting_down`; control jobs other than `Shutdown` rejected | immediate | |
| 2 | drain the LIVE queue | <= 40% of remaining | BACKFILL queue discarded (its offsets did not move) |
| 3 | `interrupt()` any in-flight BACKFILL statement (duckdb-rs `InterruptHandle`): the transaction rolls back, the offset is unchanged, nothing is lost (H2) | immediate | |
| 4 | the existing flushes as today: `shutdown::flush_with_deadline` of `CoreState` (shutdown.rs:30; bin/alcore.rs:442-469), span writer, statusline, account timeline | existing | |
| 5 | final `CHECKPOINT` on the writer thread | <= 50% of remaining, minimum 3 s | |
| 6 | close the index: drop the writer connection, every reader slot (waiting in-flight readers up to the reader deadline), the sealer connection, then the `Database`; assert `Arc::strong_count == 1` before the drop and log the leak if not (an extra clone keeps the file lock and the checkpoint undone) | remaining | |
| 7 | existing: sweeper/scheduler join, `rt.shutdown_timeout` and `bg_rt.shutdown_timeout` (:487-488) | existing | |
| 8 | `pid_lock::release` (:493) | last | |

If step 5 times out the instance cannot be dropped safely: skip step 6 and 8's explicit release and `exit(0)` immediately; the WAL stays and is replayed at the next boot (§7.1 steps 3-4), the stale pid file is handled by `pid_lock::claim`'s stale-lock path (pid_lock.rs:118-160), and the OS releases the DuckDB file lock at process exit. This keeps the invariant of bin/alcore.rs:429-431 (no pid-lock release while this process may still hold the DB). Never release the pid lock before the instance is dropped (H1).

rss_guard hard exit (`check_and_enforce`, rss_guard.rs:539-554: `flush_before_exit()` then `std::process::exit(1)`, no destructors): the `flush_before_exit` closure gains `writer.request_abort()`: stop taking jobs and do NOT attempt a `CHECKPOINT` (it needs memory the process no longer has) and do NOT start a commit. Consequences, all intended: a transaction in flight is absent after restart (CAP §6: `kill -9` with 10,000 flushed uncommitted rows, reopen shows only the committed ones); committed batches survive (D-ENG-6: plain fsync survives process kill); the WAL replay at the next boot is bounded by the 16 MiB threshold plus one batch; the post-open `CHECKPOINT` of 7.1 step 4 breaks any crash-loop. POWER LOSS is different (D-ENG-6 and R1-ENG6): plain fsync does not flush the drive cache, so the last seconds of commits may be lost AND writes may be reordered, which can corrupt the file; because the index (+ parts) can be the only copy of deleted transcripts and legacy cards, the defence is the snapshot set of §7.4, not the earlier assumption that the lost seconds are simply re-ingested from the transcript (true only while the transcript still exists).

### 7.4 Backup snapshots and the integrity fallback (R1-ENG6; the snapshot PROCEDURE is OPEN-W15)

Decided by R1-ENG6 (stands): a rotating backup set of the index (+ parts), keeping 3, taken daily and after a backfill completes; the legacy cards exported once as an immutable NDJSON file (owned by SPEC-legacy-card-import); a `reindex --from-raw` path (rebuild the derived tables from raw parts, the same machinery as §5.1's rebuilder); and a startup integrity check that falls back to the NEWEST snapshot and re-ingests from that snapshot's offsets, never to an empty database (§7.2 rows).

Procedure, OPEN-W15 (the coordinator reports the final review changed it; revision 2 and experiment E7 settle it). The candidate this spec implements until then is a `Snapshot` control job on the writer: the writer pauses (no job runs between its start and its end), runs `CHECKPOINT`, and clones the database file and its WAL TOGETHER (`cp -c`, APFS); a clone of the DB file shares blocks only until the live file diverges, so each retained snapshot costs real disk over time, whereas the Parquet parts are immutable and their clone is free. Disk accounting for the 3-snapshot set is therefore part of the §9 headroom and of the reindex free-disk check. Rotation: the oldest set is moved aside to `backups/_rotated/` and not deleted by the server (OPEN-W15: who purges it; RULE 0 allows no inferred exemption).

Integrity check at open: after a clean open, `PRAGMA integrity`-class verification is not available in DuckDB 1.5.5 as far as CAP shows (INFERRED: not tested), so the check is: schema and `meta` readable, the `raw_index` parts all present (§3.3), and, per snapshot restore, `count(raw)` per file up to `off` equals the newline census of the part files (W-T23 logic). A failure routes to the §7.2 corrupt-header row.

### 7.5 Extension policy (R1-ENG1, D-ENG-1)

Order matters, and it is a build-and-verify order, not a runtime toggle: (1) enable the `json` and `parquet` crate features (static, offline-safe); do NOT depend on `icu` (day buckets are computed in Rust, D-14); (2) verify that EVERY other DuckDB instance in the process works with autoload off (CAP §16 shows `to_json`, `json_extract_string` and Parquet `COPY` fail with autoload off when the extension is not linked; `transcript_sql` uses `read_ndjson_auto` and the bodies store uses Parquet `COPY`, both need the static features); (3) only then set `autoinstall_known_extensions=false; autoload_known_extensions=false` on every instance, so a missing feature fails at startup (step 5) and never silently at runtime. Test W-T27.

## 8. Hazard map H1-H31 and the tests that prove them

Test ids `W-Tnn` are defined below the table. All tests are real: a real DuckDB 1.5.5 file, real files on disk, real alcore processes where a process boundary matters, no mocks (global rule). Failpoints are `failpoint!(name)` sites compiled in under `cfg(feature = "failpoints")` in test builds; each site blocks on a barrier or kills the process (`kill -9` from the harness), so an interleaving is forced deterministically instead of hoped for (CF H29).

Invariants checked after every crash/interleaving test (I1-I6):
- I1: for every file, `file.off` equals the end of the last committed line of the current generation, and every line below `off` is in raw storage.
- I2: `node_rollup` equals the aggregate recomputed from the leaf tables (`api_call`, `event`, `tool_use`) under the rule OPEN-W5/W17 settles for old generations and cross-file duplicates; until then the check runs on fixtures without a rotation or a cross-file duplicate, and, for fixtures WITH them, asserts batch-size independence and that every message is counted at most once.
- I3: the raw line count equals an INDEPENDENT count (newline counting on the files themselves, not the offsets: CF H29 third bullet).
- I4: no duplicate display row (`event`, `tool_use`, `tool_result`, `spawn_*` keyed `(file_id, gen, byte_off, sub_index)`).
- I5: `meta.version` equals the highest `ingest_batch.id` ever allocated; it is dense and monotone across restarts and clears (the newest `ingest_batch` row is never pruned, so it also equals `max(id)`).
- I6: `meta.clear_epoch` equals the number of `ingest_batch(kind='clear')` rows; no job from an older epoch is in the tables.

| H | Hazard (one line) | Design element that resolves it | Test |
|---|---|---|---|
| H1 CRITICAL | open error deletes the only copy (card_store.rs:221-222) | §7.2 classified open policy, never delete, rename aside, never an empty database (R1-ENG6); §7.3 CHECKPOINT, drop instance, then release pid lock (D-11) | W-T05, W-T08, W-T18, W-T28 |
| H2 CRITICAL | funnel unbounded/blocking/dropping | §2: byte-bounded two-lane queue, per-producer blocking, OTLP never enqueues (D-6, D-7), group commit | W-T13, W-T15 |
| H3 CRITICAL | live tail vs backfill on one file | §4.1 scheduler: one owner per file, `dirty_flag`, large-gap rule; §4.3 CAS (D-8) | W-T01, W-T24, W-T25 |
| H4 CRITICAL | clear vs queued batch | §5.1 epoch on every job, guard inside the transaction; mechanism OPEN-W19 (rebuild-and-swap until revision 2); 409 on a second clear | W-T02, W-T03 |
| H5 CRITICAL | cross-line parser state lost between batches | §3.2 step 14 `file_ctx` in the same transaction (D-9); §4.2 step 4 | W-T11, W-T04 |
| H6 CRITICAL | file identity, rotation, moved/pruned files | §4.2 fstat of the opened handle, `(dev,inode)` + fingerprint, new generation never lowers an offset; identity rule and read-side visibility OPEN-W5/W18 | W-T06 |
| H7 CRITICAL | one bad line stalls a file forever | §3.4 two retries, per-job isolation, bisect to one line, `ingest_error`, raw kept, offset advanced; no ENUM, BLOB lines | W-T07 |
| H8 CRITICAL | child before parent needs UPDATE of parent/root/path | writer obligation here: no UPDATE of parent, root or path links, `node_key` allocated on first reference (§3.2 step 3, 10); the only `node` UPDATEs are the set-once `created_ms` (and a path change if OPEN-W18 keeps path as an attribute); the read-time join (`v_node`) is owned by the schema spec (D-5) | W-T09 |
| H9 CRITICAL | cursor stability and `v` across requests | §6.2 one read transaction per request returns `v`; no transaction across requests; immutable list key owned by SPEC-read-api; writer guarantees monotone `meta.version` in the batch transaction | W-T12 |
| H10 | rollup UPDATE vs MVCC, partial visibility | §3.1 invariants 1, 4; §3.2 steps 6, 7, 11: one explicit transaction, set-based `UPDATE ... FROM`, numeric columns only, no indexed column updated, QUALIFY before every upsert | W-T10, W-T11, W-T26 |
| H11 | state derivable only from the DB at restart | §7.1 steps 5-6 rebuild every cache from `file`, `node_key`, `meta`; no sidecar offsets; SSE `{v,since,boot_id,clear_epoch}` gap detection (§3.2 note) | W-T04, W-T12 |
| H12 | QoS inversion between backfill and writer | §1.2: BACKFILL parse at background QoS, LIVE producers and the writer at NORMAL QoS (R1-D7), readers never background, chores via pool on `rt` | W-T14 |
| H13 | WAL, checkpoint, replay | §6.3 default threshold, WAL watchdog, plain CHECKPOINT, gate as a not-yet-built fallback (evidence CAP §7, R1-CKPT); §7.1 steps 3-4 post-open CHECKPOINT; §7.2 WAL size gate | W-T16, W-T17 |
| H14 | file lock, other processes, several DuckDB instances | §7.1 order (pid lock before open), §7.2 lock conflict exit naming the holder; contract: no external tool opens the live file (use HTTP or a CHECKPOINT + `cp -c` copy); §9 budget is the SUM of all instances | W-T05, W-T22 |
| H15 | OTLP ingest does more than append spans | §1.3 OPEN-W2: no handler-side enqueue; derived rows through a file the tailer reads; retention by `received_ms` (§5.2); `otel_span` unique on `(trace_id, span_id)` (R1-D6, OPEN-W14) | W-T13, W-T20, W-T29 |
| H16 | other state writers (import, reparse-on-demand, StopFailure, retention, NDJSON import) | §5.3 import as a synthetic file; §6.2 no read route writes; StopFailure via pool after releasing the state lock (§1.3); §5.2 retention chunks; idempotent re-run by offset CAS | W-T20 |
| H17 | version counter monotone across restart and clear | §3.2 step 16 `meta.version` CAS in the batch; §5.1 step (i) clear row, `ingest_batch` never deleted by clear; SSE frame carries `boot_id`, `clear_epoch` | W-T12, W-T03 |
| H18 | backfill ordering, partial-corpus answers | §2.4 duty cycle; §7.1 step 8 backfill does not gate readiness; aggregates carry `complete` and progress (contract owned by SPEC-read-api); mtime gate stays equality | W-T14, W-T19 |
| H19 | reader connections, concurrency, streams | §6.1-6.2 bounded pool, semaphores, deadlines, stream write deadline, no snapshot pinning | W-T19 |
| H20 | clocks, day buckets, future timestamps | writer obligations: ordering by `ingest_batch.id`/`byte_off`, never wall time; clamp `min(ts, now+5 min)` in the delta (§3.2 step 7); day buckets in Rust from `tz` (D-14, SPEC-golden-capture-and-clock owns the clock) | W-T21 |
| H21 | whole-window `collect()` in Rust | writer side: no `collect()` over a result > N rows, queue is byte-bounded (§2.1); read side owned by SPEC-read-api; budget §9 | W-T22 |
| H22 | `otelAttributionBySession` join key | not a writer concern (read-side merge, OCAT FND-06); writer obligation: both feeds' keys are stored (`request_id`, `message_hash`, D-DAT-10) | none here (owner: OCAT) |
| H23 | usage dedup parity: first row wins vs last row | §3.2 steps 6-8: global `api_call` keyed `(source, message_id)`, QUALIFY collapse, delta from changed rows only; the guard predicate (last row of the same file, or largest usage) is OPEN-W17 (D-DAT-2/3, R1-D4) | W-T26, W-T11 |
| H24 | `done`-only placeholders, attributable results | parser/schema obligation (only a single-tool_result user line may produce a `spawn_result`); writer inserts what it is given | W-T11 fixture (owner: ingest spec) |
| H25 | bounded caps become unbounded growth | CONTRACT-DELTA; writer: `file_ctx` size cap and `ingest_batch` pruning (§5.2) | none here (owner: CONTRACT-DELTA) |
| H26 | set-once / latest-wins fields | §3.2 step 10 `node_meta` INSERT-only, read as arg_min/arg_max; ordering by `(gen, byte_off)` is valid because one owner reads a file in order (§4.1); `created_ms` set-once UPDATE | W-T11 |
| H27 | `created_ms` of the first batch | §3.2 step 10 set-once UPDATE `WHERE created_ms IS NULL` from the batch minimum (R1-D5); a tail-only creation cannot happen because created_ms is only set from a batch whose first timestamped line it holds | W-T02 |
| H28 | `ingest_batch` / `file_ctx` growth | §3.2 step 16 counter, §5.2 `CtxPrune` and batch prune below every cursor | W-T12 (v never falls after a prune) |
| H29 | test gaps | this section: failpoint interleavings, real second process, kill -9 at named points, prune fixture, same-stem fixture, poison fixture, independent census (I3) | W-T01-W-T06, W-T23 |
| H30 | shutdown deadline and the RSS guard | §7.3 deadlines, timeout path without pid release, `request_abort` in the rss_guard closure | W-T18, W-T17 |
| H31 | fsync rate and file descriptors | §2.2 group commit (<= 50 commits/s); watchers/backstop reduced to stat + mark (§4.1); fsync of Parquet parts in the sealer thread only | W-T15 |

Test definitions:

| id | What it does | Passes when |
|---|---|---|
| W-T01 | two producers one file: hold a BACKFILL batch of file F at `FP_AFTER_READ`; let the watcher name F; release in both orders | exactly one reader existed at any time; final `off`, rows and rollup equal a single pass (I1-I4); the second event only set `dirty_flag` |
| W-T02 | clear vs batch: hold a LIVE batch at `FP_BEFORE_COMMIT`, run the full clear (§5.1 mechanism in force), release the batch | the old-epoch job is dropped (`Dropped(EpochChanged)`); after the swap I1-I6 hold; no raw byte missing (I3); if revision 2 picks the watermark: the batch commits normally, T is recorded, nothing is deleted and no offset moved backward |
| W-T03 | clear robustness: second `/api/clear` during rebuild; admission refused for lack of free disk or memory; `kill -9` at `FP_SWAP_AFTER_CLONE`, `_AFTER_RENAME1`, `_AFTER_RENAME2`, `_BEFORE_EPOCH_BUMP`; restart each time | 409 for the second clear and for a refused admission; each restart follows the §5.1 boot table; no file deleted (the test lists the directory before/after); raw count unchanged; `v` never decreases |
| W-T04 | crash matrix: 50 runs of `kill -9` at random named failpoints (`FP_MID_STAGE`, `FP_BEFORE_ROLLUP`, `FP_BEFORE_CAS`, `FP_BEFORE_COMMIT`, `FP_AFTER_COMMIT_BEFORE_NOTIFY`, `FP_AFTER_PART_FSYNC`, `FP_AFTER_PART_RENAME`) on the real-corpus sample, restart, resume to completion | I1-I6 and table checksums equal a clean single pass |
| W-T05 | real second process: (a) a second alcore on the same data dir; (b) a separate process that opens `index.duckdb` read-write (a tiny binary linked to the same libduckdb); (c) start alcore while (b) holds it | (a) pid_lock refusal naming the pid; (b)/(c) lock-conflict exit code 2 naming the holder; the file and its WAL are byte-identical afterwards (sha256) |
| W-T06 | identity fixtures: prune-by-rename (smaller replacement, same path); truncate-and-regrow in place; moved directory; two files with one stem; inode reuse (same path, same inode, different head); file deleted while being read | each starts a new generation or a new owner as the rule OPEN-W5/W18 will specify (until then the test asserts only the writer obligations: nothing lost, no offset moved backward, no `api_call` counted twice, a deleted file keeps `state='missing'` and its rows) |
| W-T07 | poison line: (a) `FP_POISON(file,off)` makes one statement fail; (b) a real data failure (an out-of-range value for a typed column); (c) invalid UTF-8; (d) a 4.4 MiB line; (e) a line over `LINE_HARD_CAP`; (f) a failure that also breaks the raw-only transaction | (a)-(b) `ingest_error` has one row, raw bytes stored, offset advanced past the line, other lines of the batch committed, O(log n) transactions; (c)-(d) stored byte-exact; (e) truncated marker + loud log; (f) process exits non-zero (no loop) |
| W-T08 | error-text pinning on the real engine: lock conflict, truncated header, bit-flipped WAL, `Conflict on update`, an OOM-with-ART FATAL, newer-version file (only if a fixture can be produced; else OPEN) | each maps to the §7.2/§3.4 class; any unrecognised text exits non-zero with the raw text |
| W-T09 | child before parent: ingest a subagent file first, the parent later | no UPDATE statement ran on `node_key` or on any parent/root/path link of `node` (the set-once `created_ms` UPDATE is allowed); the read-time join resolves; the intermediate state shows an orphan root with a badge |
| W-T10 | transaction discipline: a poller reads rows, rollup and `file.off` in one snapshot 10,000 times during ingest; the connection wrapper asserts `in_txn` | the poller never sees rows without their rollup or offset; `count(ingest_batch)` equals the commit count; an autocommit attempt panics the test build |
| W-T11 | rollup equals recompute: fixtures with a growing subagent usage row, sibling subagent files with identical rows, a usage-less first row, a batch boundary between `tool_use` and `tool_result` | I2 holds; the result equals a single pass with batches of a different size (batch-size independence) |
| W-T12 | cursor and version: walk a list while the writer ingests new sessions and touches old ones; SSE reader that drops frames (`Lagged`); restart; clear | no duplicate/missing row in the walk by the immutable key; every response's `v` comes from its own snapshot; a gap or `boot_id`/`clear_epoch` change triggers refetch; `v` never decreases |
| W-T13 | backpressure and no loss: the repo's 32-poster OTLP flood with the writer stalled by a failpoint sleep; backfill running; hook posts | every POST returns 200 (D-6); queue bytes never exceed the budget; RSS growth below the budget; `tailer_lag_bytes` rises then drains to 0; span rows equal the NDJSON lines flushed (spans still in the 5 s buffer at a SIGKILL are outside the claim, R1-D6) |
| W-T14 | latency and QoS: LIVE job queue-wait and commit latency while BACKFILL runs and the machine is CPU-saturated; read each thread's class with `pthread_get_qos_class_np` | the writer, the LIVE parser worker, the scheduler and the span tailer are NORMAL; only the BACKFILL parser worker and the sealer are BACKGROUND; no reader thread is BACKGROUND; LIVE p95 queue-wait under a bound set from the baseline run (OPEN: bound) |
| W-T15 | group commit: 32 posters + live tailing | commits/s <= 50 (counted from `ingest_batch` rows per second); group sizes > 1 under load |
| W-T16 | T-CKPT: a reader holds `BEGIN; SELECT` for 10 min while 1 GB is ingested; then an explicit `CHECKPOINT` with the reader still open | WAL <= `WAL_ALARM`; `CHECKPOINT` returns; the reader's snapshot is still consistent; if the gate fallback has been built, its path also passes |
| W-T17 | WAL replay: `kill -9` with a 64 / 256 / 1,024 MiB WAL (threshold raised in the test only), reopen; the WAL size gate with a tiny cap; rss_guard exit mid-ingest then restart | open time and RSS are recorded next to CAP §14 and stay within 25% of it; the gate refuses without touching the WAL; the post-open CHECKPOINT zeroes the WAL; the restart converges (no loop) |
| W-T18 | shutdown: stop during backfill with a 100 MiB WAL; stop with a `CHECKPOINT` made slow by failpoint | finishes inside `stop_timeout`; in-flight BACKFILL rolled back with `off` unchanged; timeout path exits without releasing the pid file and the next start succeeds; `Arc::strong_count == 1` assertion holds |
| W-T19 | reader pool: 40 concurrent calls, a deadline-exceeding call, a stalled stream client | at most 5 queries run at once; 503 within `queue_wait_ms`; 408 within deadline + 100 ms and the connection is reusable; a stalled stream releases its snapshot and the next checkpoint succeeds |
| W-T20 | import and retention: import the same body twice and kill mid-import; run a retention chunk while a LIVE flood runs; a late-delivered backlog with old `startTime` | second import adds nothing, resume continues at the next chunk; LIVE p95 unchanged by retention; the backlog survives by `received_ms` |
| W-T21 | time: a line stamped 2099; the injected clock stepping backward | `last_active_ms` clamped to now + 5 min and `ts_suspect` set; ordering by `ingest_batch.id` unaffected |
| W-T22 | memory: start with a configuration over the cap; clear/rebuild admission with and without headroom; 40 concurrent reads + backfill + clear soak; a second Database instance on a different file in the same process | exit non-zero naming the term; 409 with numbers; RSS stays below the budget sum; the two instances are independent |
| W-T23 | independent census: count newlines in the corpus files with a streaming Rust scan and compare with `count(raw)` per file up to `off` | equal for every file |
| W-T24 | huge gap: a never-visited 700 MB file | one bounded LIVE batch, the rest through BACKFILL, another file's LIVE latency unaffected |
| W-T25 | scheduler defect injection: hand the same file out twice | the CAS refuses the second batch, `cas_miss_total` increments, nothing lost or duplicated; a repeat inside 1 min exits non-zero |
| W-T26 | upsert semantics: a batch with two usage rows for one message id; sibling-file duplicates; growing rows across batches; a usage-less first row; a control run WITHOUT the QUALIFY; a control run whose step 8 predicate differs from step 7 | with QUALIFY: the row the OPEN-W17 rule selects wins and the delta is applied once; the control run reproduces D-ENG-3 first-row-wins, proving the collapse is needed; a diverged predicate is caught by the row-count assertion (CAS-MISS class) |
| W-T27 | extension policy: build with the `json` and `parquet` features; for every DuckDB instance in the process (`transcript_sql` `read_ndjson_auto`, the bodies-store Parquet `COPY`, the index, the others) run its real queries with autoload off; then run with the feature removed | all instances work with autoload off and `duckdb_extensions()` reports json and parquet statically linked; with a feature removed alcore exits at startup step 5 naming it, never at a query |
| W-T28 | integrity fallback: bit-flip the live `index.duckdb`; delete it; truncate a snapshot; no snapshot at all | with a good snapshot the newest one is restored and ingest resumes from its offsets (I1-I3 hold after convergence); with none usable alcore exits non-zero; in no case is an empty database created; nothing is deleted (corrupt files renamed aside) |
| W-T29 | span tailer gates (R1-D6): seal a day file while the tailer is behind; read a `.gz` day file; run retention and `ClearSpans` while the tailer is behind | gzip happens only when the tailer offset equals the size; the gzip file is ingested completely; no day file is removed before the tailer finished it; `otel_span` has no duplicate `(trace_id, span_id)` |

## 9. Memory budget (D-ENG-9, D-16, H14, H21, R1-BUDGET)

Fact base: `memory_limit` counts only DuckDB-managed memory; RSS runs 120-330 MB above it (D-ENG-9, CAP §2g: 631 MB RSS at a 512 MB limit); ART nodes are counted but never evicted, and an OOM with an ART index loaded is FATAL (D-ENG-2, CAP §5); the WAL replay at open costs ~1 GB RSS per GB of WAL (D-ENG-7); reader connections cloned from one Database share its `memory_limit` and `threads` (D-ENG-4).

Budget (all numbers are limits or caps, not measurements; the bench fixes them, D-15/D-16):

| Term | Symbol | Value | Source |
|---|---|---|---|
| index instance `memory_limit` (the `api_call` ART, `otel_span` index if any, and every other index live INSIDE it) | L_idx | 512 MiB (OPEN: bench) | CAP experiments; D-16 |
| `api_call` ART resident, a sub-budget of L_idx with its own test, not an extra term | A_art | <= 64 MiB (PROPOSED; OPEN: measure at 1M, 5M and 20M keys: R1-D4-ART gives growth of 5-9M keys per year, so "~1M keys" is only today's count; and whether CHECKPOINT or only a reopen releases ART memory; a test fails above the budget) | D-4, R1-D4-ART, D-ENG-2 |
| writer queue | Q | 64 MiB (LIVE 40, BACKFILL 24) | §2.1 |
| parser workers | P | 2 workers x (4 MiB slice x 4 expansion) + ctx ~ 40 MiB | PROPOSED |
| other DuckDB instances (cards.duckdb until retired 256 MiB, transcript heavy slot 1 GiB transcript_sql.rs:27-29, session_summary_sql.rs:117, bodies_evidence.rs:77, statusline_store.rs:230, agentlens-store/src/lib.rs:158) | L_other | sum of the limits read from each module at startup; only the first two figures are known today | CF H14 |
| allocator + appender margin | M | 330 MiB | D-16 |
| Rust base (CoreState, hook ring, burn, span NDJSON writer buffers) | R | measured (OPEN: composition line, chores.rs:549) | |
| reader pool overhead (5 connections) | R_pool | OPEN-R2 | SPEC-read-api §5 |
| second instance while a clear/reindex rebuild runs | L_next + Q_next | 512 + 16 MiB, only during the rebuild | §5.1 |
| WAL replay transient | W | <= 1.1 x WAL bytes at open, before chores start | D-ENG-7 |

Formula: `B = L_idx + Q + P + L_other + M + R + R_pool` (A_art is inside L_idx and is not added again; plus `L_next + Q_next` while rebuilding, plus `W` only during open). Startup check (step 1 of §7.1, fail fast): refuse to start if `B > cap` with the message listing each term; warn if `B > 0.70 x cap` (stage 1 of the pressure ladder, rss_guard.rs:400 `pressure_fracs` on macOS), because steady state above stage 1 means the ladder fires permanently. The rebuild admission (§5.1 step 1) repeats the check with the rebuild terms added and answers 409 with the numbers. A runtime gauge compares `duckdb_memory()` of each instance and the process footprint against `B` on the composition tick (chores.rs:618) and exports the margin to `/api/server-stats`. The rss_guard hard exit (rss_guard.rs:539-554) remains the backstop, not the plan.

Arithmetic with the figures above, as a finding and not a conclusion: L_idx 512 + Q 64 + P 40 + L_other 1,280 (only the two known limits, 256 + 1,024) + M 330 = 2,226 MiB, a LOWER BOUND because R, R_pool and the limits of the four other instances are still unmeasured, against today's cap of 2,048 MiB (rss_guard.rs:25-36). R1-BUDGET: the startup check, as specified, therefore refuses to start at today's cap; it requires the interim 4,096 MiB cap (D-13, serverControl.ts:222), or a smaller sum after the bench (a smaller L_idx and a smaller transcript heavy slot). D-13 is a PLAN (the cap raise plus a 65-minute watch), not a verified fact (R1-D13); this spec depends on it only as the named remedy. OPEN-W12 (narrowed): whether the static check sums LIMITS (a guarantee, conservative) or a measured steady state plus the limits of eager instances (looser, weaker). This spec asks for the limit sum for the index instance and the measured peak for the others, because only the index instance can take the whole process down with a FATAL (D-ENG-2). The disk headroom of the §7.4 snapshot set is checked by the reindex admission, not here.

Ordering rule that follows: the index opens BEFORE the other instances and the chores start (§7.1 step 9), so the WAL replay peak does not stack on their allocations. Bulk work that would exceed `L_idx` must not be a single DuckDB statement: staging per batch bounds every statement by the batch size (the Parquet `COPY` of a 3 KB-line table already hit "Out of Memory" at a 512 MB limit, CAP §2g, and needed small row groups; a part-based raw store therefore caps row groups in bytes, §3.3, and which of C1/C2 writes them is OPEN-W20).

## 10. Open points

| id | Question | Decided by |
|---|---|---|
| OPEN-W1 | do hook events become a table (OCAT NS-3) or stay in bucket files | schema spec / OCAT |
| OPEN-W2 | which table receives each OTLP-logs-derived row; the extra NDJSON file if any | schema spec (constraint: through a file with an offset) |
| OPEN-W3 | who may empty `parts/_unreferenced/` | owner (default: never automatic) |
| OPEN-W4 | (a) `DO UPDATE ... WHERE` accepted by DuckDB 1.5.5 (and a row-comparison `GUARD`, if W17 needs one) | a 10-line engine test before schema freeze |
| OPEN-W5 | generation bump: representation (`gen` column vs new `file_id`), what is hidden, rollup repair, archived-lines view (R1-D4(b); the earlier "read-side visibility" question) | DUCKPLAN revision 2 / E7, then schema/ingest spec |
| OPEN-W6 | re-drive of `ingest_error` rows after a parser fix | follow-up card |
| OPEN-W7 | process exit code table (lock conflict 2, corrupt, fatal, budget) | EHT-03 with the CLI |
| OPEN-W8 | cost of `cp -c` on a filesystem without clones | measured at the rebuild bench |
| OPEN-W10 | does a heavy read delay LIVE commit latency; the `threads` knob | W-T14 |
| OPEN-W11 | the CLI start deadline constant above `OPEN_DEADLINE` | EHT-03 |
| OPEN-W12 | static memory check: limit sum vs measured (R1-BUDGET already decided that the check applies and needs the 4,096 MiB cap or a smaller sum) | bench + owner |
| OPEN-W13 | numbers marked PROPOSED: 20 ms group window, 1000-row group cap, 50 ms BACKFILL batch, 4 MiB cap and slice, duty 0.5, Q 64 MiB (40/24), 1 LIVE + 1 BACKFILL parser worker, `LIVE_MAX_GAP` 8 MiB, `SWAP_DELTA_BYTES` 8 MiB, `WAL_ALARM` 64 MiB, `LINE_HARD_CAP` 256 MiB, `OPEN_DEADLINE` 120 s, the free-disk threshold of the rebuild admission | SPEC-method-bench per D-15 |
| OPEN-W14 | `otel_span` uniqueness on `(trace_id, span_id)` (R1-D6) without an ART index that a retention DELETE would load whole (D-ENG-2) | experiment E6 (with W21) |
| OPEN-W15 | snapshot procedure (writer paused, CHECKPOINT, DB + WAL cloned together, DB clones diverge, parts clone free) and who purges rotated-out snapshots | DUCKPLAN revision 2 / E7 and the owner |
| OPEN-W16 | `LINE_HARD_CAP` truncation discards content; keep, or store oversize lines byte-exact elsewhere | owner |
| OPEN-W17 | `api_call` guard predicate and attribution (R1-D4(c); revision-2 candidate: largest usage wins, attribution fixed at first insert, totals never gen-filtered) and the step 6 collapse order that goes with it | DUCKPLAN revision 2 / E7 |
| OPEN-W18 | file/node identity rule: path (D-5) vs `(dev, inode)` with a path attribute (R1-D5), and how a prune-by-rename (new inode, same path) is classified | DUCKPLAN revision 2 / E7 |
| OPEN-W19 | clear semantics: R1-D10 watermark vs the likely revision-2 meaning (drop OTEL spans, rebuild derived data); the admin `reindex` | DUCKPLAN revision 2 / E7 |
| OPEN-W20 | raw-line storage: D (zstd column) vs C1 (Parquet via DuckDB COPY) vs C2 (Parquet via the Rust crate), R1-D1 | Rust bench (SPEC-method-bench) |
| OPEN-W21 | `api_call` uniqueness mechanism: ART on a 128-bit key vs index-free anti-join restricted by timestamp vs monthly key partitions (R1-D4-ART) | experiment E6 |

Verified-here / not-verified-here. VERIFIED by reading: the engine facts quoted from DEC, R1 and CAP (their own VERIFIED marks; the QoS numbers in §1.2 were re-read in CAP §4), the absence of a checkpoint gate in `rust-core/crates` (a case-insensitive search for `checkpoint_gate`, `ckpt_gate`, `CheckpointGate` and `RwLock<()>` returned nothing), and the code locations cited in the first revision (hook, handler, sweeper, shutdown, rss_guard and pid_lock lines; not re-read in this revision, they drift). INFERRED and not run: that `BEGIN TRANSACTION READ ONLY`, `DO UPDATE ... WHERE`, a row-comparison guard, a `TEMP` table `DROP` inside a transaction, and the lock-conflict/corruption error texts behave as written; that an APFS clone of a checkpointed DuckDB file opens cleanly; that two `Database` instances on two different files in one process are independent (CF H14 states it, CAP did not run it); that DuckDB 1.5.5 has no integrity-check pragma. Each is the first line of one of the tests above.

## Revision log

Revision 1, 2026-10-03. Inputs: docs_dev/duckplan-decisions.md, docs_dev/duckplan-decisions-r1.md (R1 wins), the two DUCKPLAN reports, and the coordinator's note that R1-D4(b), R1-D4(c), R1-D5 identity, R1-D10 and the R1-ENG6 snapshot procedure are OPEN pending revision 2/E7.

Fixes (each names what was wrong):
1. Sources and status: the spec cited only DEC as authoritative; R1 added and made win, CAP sections used but not listed (2g, 3, 4, 5/8, 9, 16) added.
2. QoS (R1-D7): the diagram, the roles table, section 2.3/2.4 and H12/W-T14 put ALL producers at background QoS; now LIVE producers, scheduler and tailer are NORMAL and only the BACKFILL worker and the sealer are background; worker pools split 1 + 1 so the memory total is unchanged.
3. CAP section 4 misquoted: "CPU-seconds equal at both QoS" replaced by the measured figures (5.0 vs 7.9 CPU-s/GB, 30,400 vs 975 lines/s).
4. OTLP acknowledgement (R1-D6): the spec said ack-after-append to the NDJSON file; today's behaviour is ack BEFORE the up-to-5 s flush, the loss window is unchanged and owned by card S1. Fixed in 1.2, 1.3, 2.3 and W-T13.
5. Span tailer gates (R1-D6) were absent: sealing only at offset == size, gzip reads, retention and `ClearSpans` never remove an unfinished day file (5.1, 5.2, W-T29).
6. `otel_span` unique on `(trace_id, span_id)` bounded by 30-day retention (R1-D6) contradicted "ART only on api_call" and "no bulk delete on an indexed table"; the conflict is stated and the mechanism made OPEN-W14.
7. Per-row idempotency (R1-D4(a),(d)) applied to invariant 3 and steps 6-8 and 11; the old "idempotency comes only from the offset CAS, ONE indexed upsert" wording replaced; the `seq` column (undefined across files, OPEN-W4(b)) replaced by `job_ord` and `byte_off`.
8. R1-D4(d) changed-row capture: step 7 now uses the same predicate as the upsert and step 8 asserts the row counts agree.
9. R1-D4(b),(c) NOT implemented as written: made OPEN-W5 and OPEN-W17 per the coordinator, with the statement shape fixed and the predicate parameterized (`GUARD`).
10. D-ENG-3 QUALIFY collapse was applied only to `api_call`; now stated for every upsert (`api_call`, `otel_span`, `node_key`/`node`), with the guarantee that a group never holds two batches of one file.
11. `api_call` "~1M keys" was unbacked against R1-D4-ART's 5-9M keys per year; the key budget is to be measured at 1M, 5M and 20M and the mechanism is OPEN-W21.
12. Node creation (R1-D5): "created_ms by DO NOTHING" and "no UPDATE of node" (H8, W-T09) contradicted R1-D5's set-once UPDATE of a non-indexed column; fixed, nodes without a timestamped line stay unlisted; the identity key itself is OPEN-W18.
13. CAS and display keys now carry `gen` (D-4 keys `(file_id, gen, byte_off, sub_index)`); the invented `superseded` state and "new generation = new file_id" removed in favour of OPEN-W5.
14. Contradiction: the scheduler was "no DB access" yet section 4.2 had it read `file_ctx` from a pool reader; replaced by `Fetch` requests served by the reader pool on a normal-QoS thread.
15. Raw-line storage (R1-D1) was presented as decided (Rust parquet crate); now OPEN-W20 with the required crash protocol (fsync of the directory, bidirectional manifest reconcile, self-describing parts carrying `gen`, row-group BYTE cap); step 5 covers the no-staging option D.
16. Clear (R1-D10) marked OPEN-W19; the D-10 mechanism is kept as the superset, the free-disk admission check and the single-transaction collapse under a watermark outcome are specified.
17. Backups (R1-ENG6) were absent and the open policy ended in "exit non-zero" or an empty create: added section 7.4 (rotating set of 3, never an empty database, newest-snapshot fallback, reindex from raw), the 7.2 rows, and W-T28; the snapshot procedure is OPEN-W15.
18. Power-loss wording (D-ENG-6 vs R1-ENG6): "the last seconds are re-ingested from the transcript" understated the risk; reordered writes can corrupt the file (3.2 step 18, 7.3).
19. Extension order (R1-ENG1): autoload-off was a startup readback only; added the build-verify-then-disable order (7.5), the step 5 check and W-T27.
20. Budget formula double-counted `A_art` (it is inside `L_idx`); `L_other` 1,280 covered only 2 of 6 instances and is now labelled a lower bound; R1-BUDGET and R1-D13 stated (check requires the interim 4,096 MiB cap, which is a plan).
21. Section 6.3 claimed the checkpoint gate was "a feature flag already in the code"; a search found no such code; corrected, and OPEN-W9 closed by R1-CKPT.
22. R1-ORIGIN: imported nodes carried `source='import'`; now `origin='import'`, `source` keeps the agent source.
23. Garbled IO-failure cell ("D: fail fast; ... CLAUDE.md git-and-destructive-safety") rewritten; "step 3-4 above" in 7.3 made explicit.
24. Step 11 `NOT IN` replaced by `NOT EXISTS` (NULL safety).
25. `LINE_HARD_CAP` truncation silently contradicted "full content copied"; the content loss is now stated and made OPEN-W16.
26. Invariants I1, I2, I4, I5 and I6 aligned with `gen` keys, the OPEN rollup rule and the never-pruned newest batch.
27. Tests: W-T02, W-T03, W-T06, W-T14, W-T16, W-T22 and W-T26 rewritten for the above; W-T27, W-T28, W-T29 added; H-table rows H1, H4, H6, H8, H12, H13, H15, H23, H26, H27 updated.
28. OPEN list renumbered and extended (W14-W21); W9 closed; W12 narrowed; W4(b) merged into W17.

Still OPEN: 20 items (OPEN-W1 to W8, W10 to W21).
