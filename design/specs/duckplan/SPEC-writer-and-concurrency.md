---
title: SPEC - writer thread, queues, transactions, locks and races of alcore's new DuckDB index
status: draft
scope: project
created: 2026-10-03
unit: WRITER
sources: docs_dev/duckplan-decisions.md (DEC, authoritative); reports/DUCKPLAN/20261003_165118+0200-concurrency-and-flaws.md (CF, hazards H1-H31); reports/DUCKPLAN/20261003_192823+0200-duckdb-capabilities.md (CAP, sections 1, 2f, 6, 7, 13, 14, 15); code at HEAD 94125a8d
siblings: SPEC-read-api.md (reader pool), SPEC-legacy-card-import.md, SPEC-golden-capture-and-clock.md, SPEC-method-bench.md, SPEC-interim-stabilization.md, SPEC-effects-handling.md, SPEC-operation-catalog.md
---

# Writer and concurrency design for `index.duckdb`

Conventions. DECIDED = a decision in DEC (cited `D-n`, `D-ENG-n`, `D-DAT-n`). CF `Hn` = audit hazard. CAP `§n` = capabilities report. `file:line` is under `rust-core/crates/agentlens-core/src/` unless stated and was read at HEAD 94125a8d (it drifts; re-grep before editing). PROPOSED = this spec's own choice (nobody decided it yet, but it follows from DECIDED facts). OPEN = not decided; the named test/bench decides. Table and column names are the names used in DEC/CF; the schema spec owns the columns, this spec owns the ORDER of statements and the concurrency semantics. Nothing in this spec deletes a user-visible artifact: every "remove" is a rename aside (RULE 0, D-11).

One-sentence rationale: the index becomes the only copy of the content, so exactly one thread may mutate it, every mutation is one explicit transaction that is all-or-nothing together with its file offset, and every other thread only produces finished batches or reads snapshots.

## 1. Thread model

### 1.1 Diagram

```
 PRODUCERS (parse + read; background QoS; NEVER hold a DuckDB connection or transaction)
 ┌────────────────────────────────────────────────────────────────────────────────────────┐
 │ watcher thread(s) (notify, log_reader.rs:1413 attach_watchers) ─┐                     │
 │ 60 s backstop FULL_RESCAN (log_reader.rs:1263) ────────────────┤                     │
 │ boot sweep / backfill pull (newest first) ─────────────────────┼─► SCHEDULER (1 thread,│
 │ NDJSON span tailer (own offset, D-6) ──────────────────────────┤   owns file work set, │
 │ /api/import handler, /api/clear handler (ui.rs:1487,1595) ─────┤   bg QoS, no DB)      │
 │ retention chore timer (chores.rs:68 span_tick) ────────────────┘        │             │
 │                                                                         ▼             │
 │              PARSER WORKERS (N std threads, bg QoS, set_background_qos bg_qos.rs:12)   │
 │              read bounded slice of ONE file -> parse -> finished row batch            │
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
 │ 4 interactive + 1 heavy connections,   │   │ connection): encodes raw staging into     │
 │ normal QoS (tokio blocking threads of  │   │ Parquet parts, then submits a SealCommit  │
 │ `rt`, never `bg_rt`), semaphores,      │   │ job to the writer (§3.6)                  │
 │ deadlines, short read transactions     │   └──────────────────────────────────────────┘
 └────────────────────────────────────────┘
 CHORES (bg_rt, max 4 blocking threads bin/alcore.rs:329): touch the index ONLY by submitting
 writer jobs, or by a pool slot run on `rt` (§6.5). They never open a connection of their own.
 OTHER DuckDB instances (unchanged, in-memory; budget §9): session_summary_sql.rs:117,
 transcript_sql.rs:409, bodies_evidence.rs:77, statusline_store.rs:230, agentlens-store/src/lib.rs:158.
```

### 1.2 Who does what (and the QoS rule)

| Role | Thread | QoS | Touches DuckDB? | Source of the rule |
|---|---|---|---|---|
| tokio HTTP handlers (OTLP, hooks, statusline, import, clear, reads) | `rt`, 2 workers (bin/alcore.rs:328) | normal | readers only via pool; writes via writer jobs | H2 |
| OTLP handler | `rt` | normal | NO. Appends to the span NDJSON through today's span writer, then answers 200 (ack-after-append, contract kept, lib.rs:940) | D-6 |
| scheduler | 1 std thread (replaces the file-selection half of `log-sweeper`, log_reader.rs:1413-1640) | background | NO | D-8, H3 |
| parser workers | N std threads, N = 2 (PROPOSED; OPEN: SPEC-method-bench) | background | NO | D-7, H12 |
| NDJSON span tailer | one producer, LIVE lane | background | NO | D-6 |
| writer | 1 std thread `idx-writer` | NORMAL | YES, the only writer | D-7, H12 |
| sealer | 1 std thread | background | read-only connection, snapshot | D-1 |
| reader pool | tokio blocking threads on `rt` | normal | read-only clones | H12, H19 |
| chores | `bg_rt` (chores.rs:928-1200) | background | only by submitting jobs | H12 |

Why the writer is NOT at background QoS: a commit fsyncs; at background I/O priority the OS throttles the fsync and every LIVE job waits behind it (priority inversion; the repo documents the same inversion for the sweeper, log_reader.rs:1440-1447; bg_qos.rs:8-20 sets only the thread QoS class). Parsing is the CPU-heavy part and stays background (D-7). CAP §4 measured CPU-seconds equal at both QoS and wall time inflated 30x at background QoS under load, so only CPU-seconds are used to size jobs.

### 1.3 What stays OUTSIDE DuckDB (and why it does not funnel)

| State | Where | Rule |
|---|---|---|
| span NDJSON (the write-ahead log for OTLP) | existing span writer files | the tailer reads it with its own offset stored in `file` (D-6) |
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
Job = { kind, lane, epoch: u64, bytes: usize (accounted), batches: Vec<FileBatch> | Control }
FileBatch = { file_id, identity (dev,inode,fingerprint), expected_off, new_off,
              rows (columnar staging buffers), ctx: Vec<u8>, touched_roots, line_count }
Control = Clear | SwapIndex | SealCommit | RetentionChunk | ImportChunk | CtxPrune | Checkpoint | Shutdown
```

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
| OTLP handler | nothing: it does not use the queue. It appends to the span NDJSON and answers 200 exactly as today (lib.rs:1090-1150, :940). No 503 backpressure (D-6) | the NDJSON file IS the buffer; unbounded disk lag is visible as `tailer_lag_bytes` |
| NDJSON span tailer | blocks on the LIVE permit; stops reading; its offset stays where the last COMMIT left it | the bytes are still in the file |
| Live file parser (watcher/backstop/tail) | blocks on the LIVE permit before reading; the file stays `Queued`/`Dirty` in the scheduler | the transcript is the source; the CAS offset is unchanged |
| Backfill parser | blocks on the BACKFILL permit, no deadline | same |
| `/api/import` handler | body already parsed; chunks submitted with `try_acquire` with a 5 s deadline, then 503 + `Retry-After` and a visible counter (CF H2/H16) | the client still holds the card; a refused chunk is not partially imported (chunks are independent idempotent jobs, §5.3) |
| `/api/clear`, Checkpoint, Shutdown, SwapIndex | control jobs have zero byte cost and are always admitted | never refused |
| retention timer | submits ONE `RetentionChunk` at a time and does not submit the next until the previous one is acknowledged | no queue growth |
| hook events (only if OPEN-W1 makes them a table) | same as the live parser | the bucket file is the WAL |

Exported gauges (in `/api/server-stats`): `queue_bytes{lane}`, `queue_jobs{lane}`, `producer_blocked_ms{producer}`, `tailer_lag_bytes`, `commits_per_s`, `group_size`, `backfill_starved_groups`, `ingest_error_count`.

### 2.4 CPU politeness (owner: "no long high-CPU bursts; the system must stay responsive")

After every BACKFILL transaction the writer sleeps `duty_pause = batch_wall_ms * (1/duty - 1)` with `duty` = 0.5 (PROPOSED, OPEN: bench; target "<= 0.5 core" from CF H18). LIVE batches get no pause. Parsers are at background QoS and are throttled by the OS and by the permit. rss_guard pressure (rss_guard.rs:400 `pressure_fracs` 0.70/0.80/0.90 of the cap, :420 `pressure_thresholds`): at stage 1 the writer pauses the BACKFILL lane entirely until pressure clears (PROPOSED; OPEN: which stage).

## 3. Batch transaction recipe

### 3.1 Invariants (hold for every transaction, every lane)

1. One explicit `BEGIN` ... `COMMIT` per group. No autocommit statement ever touches the index in a batch path: an autocommit statement would commit alone and let a reader see rows without their rollup (H10; the repo already guards this class at card_store.rs:537). The writer wraps the connection in a type whose `execute` panics unless `in_txn` is set (a test asserts it, §8 W-T10).
2. Every index-resident table touched by the batch commits together with `file.off`; nothing is durable that the offset does not cover, and the offset never covers anything not durable (D-8).
3. Idempotency of display rows comes from the offset CAS, NOT from a global key (D-4). The ONE indexed upsert path is `api_call` (message hash HUGEINT, ~1M keys, budgeted).
4. No table that grows with the corpus gets an ART index except `api_call`; no bulk DELETE runs against an indexed table (D-ENG-2). `UPDATE`d columns are never indexed (D-ENG-4: UPDATE of non-indexed columns works).
5. The writer holds NO cache of file offsets across a clear epoch (D-8): the guard step (3.2 step 2) reads `file` and `meta` inside the transaction.

### 3.2 Exact statement order

`stg_*` are `TEMP` tables created once at writer start, without any index, same columns as their targets plus `seq`. They are filled by the DuckDB Appender (CAP §1: the Appender participates in the open transaction; always check `flush()`; LIST values are unsupported, so lists are staged as JSON/VARCHAR or flattened). Statement names below are logical; the SQL is parameterized and prepared once at writer start.

| # | Step | Statement (logical) | Notes / failure meaning |
|---|---|---|---|
| 1 | open | `BEGIN` | |
| 2 | guard | `SELECT value FROM meta WHERE key='clear_epoch'`; `SELECT file_id, off, state, identity FROM file WHERE file_id IN (batch files)` | Compare in Rust. Epoch differs from the epoch the job was read under: ROLLBACK, discard the whole job (D-8). Offset differs from `expected_off` for one batch of a group: that batch is dropped before any write and the scheduler is told `Dropped(file_id, StaleOffset)` (it re-reads `file` and requeues). All stale checks are done BEFORE the first write so a group never half-applies |
| 3 | node ids | resolve `session/path key -> nk` from the writer's in-memory `HashMap` (loaded at boot from `node_key`, ~40k rows, CF H8); allocate new nk from `next_nk` (initialised `max(nk)+1` at boot) | allocation only on the writer thread; the map and `next_nk` are updated only AFTER COMMIT (a rolled-back batch leaves a harmless gap, CF H11) |
| 4 | stage | Appender -> `stg_raw_line`, `stg_api_call`, `stg_event`, `stg_tool_use`, `stg_tool_result`, `stg_node`, `stg_node_meta`, `stg_spawn_edge`, `stg_spawn_result`, `stg_span`; `flush()` each, error = abort | rows carry `(file_id, byte_off, sub_index)`; `seq` orders rows of one api_call key |
| 5 | raw | `INSERT INTO raw_staging SELECT file_id, byte_off, len, line FROM stg_raw_line` | raw lines (BLOB, byte-exact, CF H7) stay in DuckDB staging until a part is sealed (D-1) |
| 6 | collapse | `CREATE TEMP TABLE c_api AS SELECT * FROM stg_api_call QUALIFY row_number() OVER (PARTITION BY message_hash ORDER BY seq DESC) = 1` | D-ENG-3: in-statement duplicates are silently FIRST-ROW-WINS even for DO UPDATE; D-DAT-2: the LAST row (max seq) wins. `DROP` at step 17 (temp tables are transactional) |
| 7 | rollup delta | `INSERT INTO stg_rollup_delta SELECT nk, sum(new.tokens - coalesce(old.tokens,0)), ..., count(new rows that insert), max(least(ts_ms, :now_ms + 300000)) FROM c_api new LEFT JOIN api_call old USING (message_hash) WHERE old.message_hash IS NULL OR new.seq > old.seq GROUP BY nk` plus the non-api_call deltas (counts of event/tool_use rows, bytes) | MUST run BEFORE step 8: a growing subagent usage row (D-DAT-2) updates an already counted message, so the rollup needs `new - old`, not `new`. The `+5 min` clamp is H20 (a future-stamped line cannot pin a session). Counts of display rows come from the staging tables: they are safe because the offset CAS makes each row arrive once |
| 8 | api_call | `INSERT INTO api_call SELECT ... FROM c_api ON CONFLICT (message_hash) DO UPDATE SET <usage columns> = excluded.<..>, seq = excluded.seq WHERE excluded.seq > api_call.seq` | the only upsert and the only ART index (D-4). OPEN-W4: (a) that DuckDB 1.5.5 accepts `WHERE` on `DO UPDATE` (INFERRED, to be run before freeze), (b) the exact `seq` definition across files for one message id (siblings share identical rows, D-DAT-3; ties keep the existing row) |
| 9 | display | `INSERT INTO event/tool_use/tool_result/spawn_edge/spawn_result SELECT ... FROM stg_*` | no PK, no ART, no ON CONFLICT (D-4). Nothing can dedupe them but the offset CAS: this is exactly why step 2 and step 13 are mandatory |
| 10 | nodes | `INSERT INTO node_key/node SELECT ... FROM stg_node QUALIFY row_number() OVER (PARTITION BY nk ORDER BY byte_off) = 1 ON CONFLICT DO NOTHING`; `INSERT INTO node_meta SELECT ... FROM stg_node_meta` (append-only, read as arg_min/arg_max at read time, H26) | `node.created_ms` is set once by DO NOTHING from the batch minimum (H27). `node_key` has a PK of ~40k rows (bounded, D-4) |
| 11 | rollup | (a) `INSERT INTO node_rollup SELECT d.* FROM stg_rollup_delta d WHERE d.nk NOT IN (SELECT nk FROM node_rollup)` (b) `UPDATE node_rollup SET c1 = c1 + d.c1, ..., last_active_ms = greatest(last_active_ms, d.last_active_ms) FROM stg_rollup_delta d WHERE node_rollup.nk = d.nk` | ONE set-based statement per table (CF H10, D-3). `node_rollup` has no PK/ART (D-3), so the writer asserts `rowcount(a) + rowcount(b) = count(distinct nk in stg_rollup_delta)`. numeric columns only; text stays in `node_meta` (H10) |
| 12 | root cache | `DELETE FROM root_cache WHERE nk IN (touched roots)`; `INSERT INTO root_cache SELECT ... ` | small table, no index (D-5) |
| 13 | CAS offset | per file in the batch: `UPDATE file SET off=:new, size_seen=:sz, last_batch=:b, state=:st WHERE file_id=:id AND off=:expected AND epoch=:epoch`, check `execute()` row count == 1 | CAP §13: `Ok(1)` / `Ok(0)` verified. Count 0 = the guard missed something (a bug): ROLLBACK, `FATAL: CAS miss` logged with the file id and both offsets, treated as a defect (§3.4), not retried silently |
| 14 | resume ctx | `INSERT INTO file_ctx(file_id, batch_id, ctx) VALUES ...` | append-only, latest wins (D-9, H5); old rows pruned by the `CtxPrune` control job, never in this transaction |
| 15 | batch + roots | `INSERT INTO ingest_batch(id, kind, ts_ms, epoch, rows, bytes, lane, files)`; `INSERT INTO ingest_batch_root SELECT :id, root_nk FROM touched_roots` | `ts_ms` is informational only; ordering is by `id` (H20). `ingest_batch` is never deleted by a clear (H17) |
| 16 | version | `UPDATE meta SET value = :id WHERE key = 'version' AND value = :id - 1`, row count must be 1 | `meta.version` is the monotone counter, not `max(id)` of what survives (H28). It is the last write: the commit point of the group |
| 17 | cleanup | `DELETE FROM stg_*` (temp, unindexed), `DROP TABLE c_api` | inside the transaction, so a ROLLBACK also empties staging |
| 18 | commit | `COMMIT` | plain fsync (D-ENG-6): durable across process kill, not across power loss; accepted and documented |

After COMMIT succeeds and only then: apply the pending nk map/`next_nk`/file-state updates; publish the SSE frame `{v, since, boot_id, clear_epoch}` (H17); release permits; send `Committed(file_id, new_off)` to the scheduler; add `rows/s` to the EWMA. A crash between COMMIT and the SSE notify is harmless: the client's EventSource reconnects, the first frame carries the current `v`, and a `since` gap or a `Lagged` broadcast (ui.rs:63, `broadcast::channel(64)`) means "refetch everything visible" (H11).

### 3.3 Part sealing is a writer job, not part of the batch (D-1)

Raw lines sit in `raw_staging` until a Parquet part fills. The SEALER thread (background QoS, a read-only connection, one snapshot) reads the oldest staged rows up to a part boundary, writes the part with the Rust parquet crate (zstd, 512-row groups) to a temporary name, fsyncs it, renames it to its final name, then submits `SealCommit(part, row range)` to the writer. The writer's transaction: `INSERT INTO raw_index SELECT file_id, byte_off, :part, row FROM raw_staging WHERE <range>`; `DELETE FROM raw_staging WHERE <range>`; bump `meta.version` and write an `ingest_batch` row of kind `seal`. Readers see either "in staging" or "in the part", never both and never neither, because both changes are one transaction (CF H10 snapshot argument). Staging is not ART-indexed, so the DELETE is allowed by D-ENG-2. A crash between the part rename and the SealCommit leaves an unreferenced part file: at boot the writer lists parts not in `raw_index` and MOVES them to `parts/_unreferenced/` (a rename, RULE 0), never deletes them (OPEN-W3: who may empty that folder; default: never automatic). The staged rows are still in the index, so no content is lost.

### 3.4 Failure handling (fail fast, never hang, never hide)

Classification is by the DuckDB error text captured at the failing statement (the exact strings are INFERRED and each is pinned by a real-engine test, W-T07/W-T08):

| Class | Examples | Action |
|---|---|---|
| ENGINE-FATAL | `FATAL Error`, "database has been invalidated because of a previous fatal error" (an OOM with an ART index loaded, D-ENG-2, CAP §5) | the writer cannot continue: log the raw text, `flush_before_exit`, exit non-zero with a distinct code (OPEN-W7: code table). The file is intact (CAP §5: 6.3M rows after reopen); restart replays the WAL. No retry |
| TRANSIENT | `TransactionContext Error: Conflict on update!` (CAP §13) | cannot occur with one writer; if it does the cause is a second writer, i.e. a bug. ROLLBACK and retry the SAME group up to 3 times with 10 ms / 50 ms / 250 ms backoff; a 4th failure is escalated as ENGINE-FATAL |
| CAS-MISS | step 13/16 row count != 1 | ROLLBACK, log loudly, count `cas_miss_total`, and drop the job (the scheduler re-reads `file` and re-queues). Two CAS misses for the same file within 1 min = ENGINE-FATAL (a scheduler bug must not spin) |
| DATA | conversion error, constraint violation, any other statement error attributable to row content | poison-line path below |
| IO | disk full, `fsync` error | treat as ENGINE-FATAL (D: fail fast; the owner frees disk, CLAUDE.md git-and-destructive-safety) |

Poison-line path (CF H7; replaces "retry forever"):
1. ROLLBACK. Retry the IDENTICAL group once immediately (rules out a one-off).
2. Second failure: isolate per job (each job of the group in its own transaction). The jobs that pass commit normally.
3. A failing job with more than one line is bisected by line range over its byte order: first half as its own transaction (commits and advances `off` to the middle line boundary), then second half; recursion until ONE line fails. Cost O(log n) transactions; offsets stay line-aligned.
4. The single failing line is committed in a transaction that (a) keeps its RAW bytes (staging row, so full content is preserved), (b) inserts `ingest_error(file_id, byte_off, len, error, line_head 4 KiB, ts_ms, batch_id)`, (c) skips the derived rows of that line, (d) advances `off` past the line with the CAS, (e) bumps `ingest_error_count`. If even this raw-only transaction fails, the cause is the schema or the engine, not the line: ENGINE-FATAL.
5. A line larger than `LINE_HARD_CAP` (256 MiB, PROPOSED; the corpus maximum is 4.4 MiB, D-DAT-7) is stored as `{truncated:true, bytes:N, head:first 1 MiB}`, logged at error level and also recorded in `ingest_error`.
6. The release gate asserts `ingest_error` is EMPTY on the real corpus (CF H7). A re-drive job that re-derives rows from the raw bytes of `ingest_error` entries after a parser fix is OPEN-W6 (follow-up, not required for freeze).

## 4. One owner per file

### 4.1 Scheduler state machine (single thread, no DB access)

State per `file_id` (identity = `(dev, inode)`, the path is an attribute that can change, CF H6; node identity is the file path, D-DAT-5):

```
Idle ──watcher/backstop names it (size>off)──► Dirty
Idle ──backfill pull (size>off, newest first)──► Queued(BACKFILL)
Dirty ──a parser worker is free──► Queued(LIVE) ──worker takes it──► InFlight(lane, epoch, expected_off)
Queued(BACKFILL) ──worker takes it──► InFlight(BACKFILL, epoch, expected_off)
InFlight ──watcher names it again──► InFlight + dirty_flag=1          (no second read, ever)
InFlight ──Committed(file, new_off)──► (dirty_flag? Dirty : (new_off<size? Queued(BACKFILL) : Idle))
InFlight ──Dropped(file, StaleOffset|EpochChanged|IdentityChanged)──► reload `file` row from the DB, then Dirty
any ──stat() says gone──► Missing (the `file` row and its offset are KEPT, state='missing'; rows are never deleted, CF H6.6)
any ──epoch changes──► Idle for all, `file` rows re-read from the DB (no cached offsets, D-8)
```

Rules:
- A file is handed to at most one parser worker at a time. The backfill pull never selects a file that is `Dirty`, `Queued` or `InFlight`. A watcher/backstop event for an `InFlight` file only sets `dirty_flag` (CF H3 scenario: B2 built from a stale offset cannot exist because there is no second reader).
- Large-gap rule (CF H3): if `size - off` exceeds `LIVE_MAX_GAP` (8 MiB, PROPOSED) the live worker ingests ONE bounded LIVE batch and the scheduler moves the remainder to the BACKFILL lane. A file never visited, size 700 MB, offset 0, is never read at LIVE priority. Today's `read_lines_from` does `read_to_end` into one buffer (log_reader.rs:667-675); the new reader is bounded by the slice size (bytes read cut at the last `\n`).
- The 60 s backstop (log_reader.rs:1263 `FULL_RESCAN`, a stat of ~13.5k files) and the recursive watcher stay; their output is now "stat + mark Dirty", never a parse (CF H31). A full poll every 5 s (`LOG_SWEEP_INTERVAL`) only when no watcher attached (log_reader.rs:1479).
- Unchanged-file gate stays an equality test on `(mtime, size, inode)`, not an ordering (CF H20; log_reader.rs:456).
- Scheduler death = writer starved: the scheduler is supervised; a panic exits the process (fail fast), it is never restarted in place.

### 4.2 Reading one slice (what a parser worker does, in order)

1. `open()` the file, then `fstat` the OPENED handle (never a path `stat` taken earlier: the prune-by-rename race of CF H6 #1 where `ino`/`size` describe the old file and the bytes come from the new one).
2. Identity check against the stored row: `(dev, inode)` equal AND content fingerprint equal: hash of the first 4 KiB, hash of the 64 bytes immediately before `off`, and the byte at `off-1` equals `\n` (D-DAT-1). Any mismatch (including inode reuse, truncate-and-regrow, a prune by rename, a misaligned `off`) = rotation: the worker returns `Rotated(file)`; the scheduler creates a NEW `file` row (new generation, `off = 0`), marks the old row `superseded` (offset and rows kept), and queues the new one. The read-side visibility of an older generation's display rows is OPEN-W5 (owner: schema/ingest spec; CF H6 recommends natural-key idempotency, D-4 chose per-(file, gen) display keys and global dedup only for `api_call`); the writer-side obligation is only "a new generation is a new file_id, never a reset of an old row's offset".
3. Read `[off, min(fstat.size, off + slice))`, cut at the last `\n`; a trailing partial line stays unread (it will be complete on a later read). Invalid UTF-8 is kept as bytes (BLOB, CAP Q17, CF H7).
4. Parse with the resume ctx loaded from the latest `file_ctx` row (D-9), producing a `FileBatch` and the new ctx. The ctx is read by the worker from a snapshot taken by the scheduler at hand-out (the scheduler gets it from a pool reader at the moment it sets `InFlight`, never from a cache that outlives an epoch).
5. Take the byte permit, enqueue. If the epoch changed while reading, discard instead of enqueueing (cheap early drop; the writer's guard is the authority).

### 4.3 CAS predicate and epoch

`UPDATE file SET off = :new ... WHERE file_id = :id AND off = :expected AND epoch = :epoch`, row count 1 (§3.2 step 13). `epoch` is `meta.clear_epoch` mirrored in an `AtomicU64`; every `Job` carries the epoch it was handed out under. The writer drops a job whose epoch differs from `meta` (checked inside the transaction, step 2); the CAS predicate is the second line of defence and also catches a scheduler bug (CF H3/H4).

## 5. Clear, import, retention as writer jobs; restart during clear

### 5.1 `/api/clear` (D-10): rebuild derived tables beside, swap in, never delete raw

Today: `clear_all` empties the card store under the state lock (lib.rs:705-711), then `Msg::Clear` reaches the sweeper (log_reader.rs:1305, handled at :1506-1510) which sets `tailer.clear()`, `needs_full = true`; the guard is the `clear_in_progress` meta flag (card_store.rs:536-547) with a documented residual window for a second clear (log_reader.rs:1486-1490). New design: derived tables are rebuilt from the RAW store (raw parts + staging + legacy rows), in a side database, then swapped. Raw parts and legacy rows are untouched (D-10, D-9 `/api/import` rows included).

Mechanism (PROPOSED; D-10 fixes the outcome, this spec fixes the concurrency):
1. Admission: the handler checks the memory budget with a second index instance (§9); refuse with 409 and the numbers if it does not fit. A second clear while one is `rebuilding` returns 409 `clear_in_progress` (this closes the residual window of log_reader.rs:1486-1490).
2. PREPARE (control job on the writer): `CHECKPOINT`; `cp -c index.duckdb index.duckdb.next` (APFS clone, instant, copy-on-write; on a filesystem without clones the copy is a measured cost, OPEN-W8); record in the old `meta`: `clear_state = rebuilding`, `clear_started_ms`, per-file watermark = every `file.off`; write `index.swap.json` (journal: `{phase, next, old_version}`). Bump `meta.clear_epoch` ONLY at the swap, see step 5.
3. REBUILD (a `Rebuilder`, own thread at background QoS plus its own `IndexWriter` on `index.duckdb.next`, a SECOND Database instance on a DIFFERENT file, which DuckDB allows): in `next`, `DROP`/`CREATE` the derived tables (never touching raw tables, raw index, staging, `ingest_batch`, `ingest_error`), zero every `file.off` and `file_ctx`, then re-ingest by running the same parse path whose line source is `raw index + staging + parts` instead of the disk file, ordered by `(file_id, byte_off)`. It uses the SAME recipe (§3) and its own queue; it needs no new write path.
4. Meanwhile the LIVE index keeps ingesting (the dashboard stays correct and responsive). The rebuilder follows it: after its first pass it loops "process raw rows with `byte_off` past my watermark" reading them from the live index through a pool reader.
5. SWAP (control job on the live writer) once the remaining delta is under `SWAP_DELTA_BYTES` (8 MiB, PROPOSED): (a) scheduler paused, parser workers drained, LIVE/BACKFILL queues flushed; (b) the rebuilder processes the final delta; (c) `CHECKPOINT` + close `next`; (d) take the pool's exclusive gate (readers get 503 `overloaded` + `Retry-After`; the gate wait is bounded by the reader deadline 20 s, SPEC-read-api §4.3; if it times out the swap aborts BEFORE any rename and retries later); (e) `CHECKPOINT`, close every connection and the Database of the live index; (f) rename `index.duckdb` -> `index.duckdb.pre-clear-<ts>`; (g) rename `index.duckdb.next` -> `index.duckdb`; (h) reopen with the normal open policy (§7.2), recreate temp staging tables, reload the nk map, recreate the pool; (i) the first transaction on the new index inserts `ingest_batch(kind='clear')`, sets `clear_epoch += 1` and continues `meta.version` from the old value + 1 (H17); (j) delete `index.swap.json` (a journal file, regenerated; allowed). Readers' window is steps (d)-(h): seconds. The old file stays until the owner removes it; `/api/server-stats` shows its name and size.
6. `meta.clear_epoch` bumps only in step (i), so batches read under the old epoch and still in flight at (a) are drained (committed to the OLD index, which the rebuilder's final delta then consumes) before the swap. After the swap the scheduler re-reads `file` from the NEW index (offsets = the rebuilder's final offsets) and resumes (no cached offsets, D-8).
7. If (f)-(h) fails after the first rename: rename back (`pre-clear` -> `index.duckdb`), log, exit non-zero (fail fast); the boot table below completes the job on the next start.

Restart during clear: boot reads `index.swap.json` first (before the open policy) and decides:

| Files present at boot | Meaning | Action |
|---|---|---|
| `index.duckdb` only | no clear, or it completed | normal open |
| `index.duckdb` + `index.duckdb.next`, `meta.clear_state = rebuilding` | crashed during REBUILD or before step (f) | open the live index normally; reopen `next` with a Rebuilder and resume (its `file` offsets are its own resume points; it is the same ingest machinery) |
| `index.duckdb.pre-clear-<ts>` + `index.duckdb.next`, no `index.duckdb` | crashed between (f) and (g) | complete (g), then normal open |
| `index.duckdb.pre-clear-<ts>` + `index.duckdb` (new), `index.swap.json` present | crashed after (g) | open the new index; if `meta.clear_epoch` was not yet bumped run step (i), delete the journal |
| `index.duckdb.next` + corrupt/missing `index.duckdb` | unexpected | never auto-fix: exit non-zero naming the files (D-11) |

Nothing in that table deletes a file. A `next` that fails its own open policy is renamed `index.duckdb.next.corrupt-<ts>` and the clear restarts from PREPARE.

`/action clearAll` (spans only, lib.rs:695, ui.rs:1496-1512): a `ClearSpans` control job; the span store files are unlinked as today, `meta.span_epoch += 1`, tailer batches carry `span_epoch` and are dropped on mismatch (same rule as `clear_epoch`), and `otel_span` rows are removed by chunked `DELETE` ranges of `received_ms` as RetentionChunk jobs (the table has no index, D-ENG-2). The tailer's `file` rows reset to `off = 0` when the new NDJSON files appear.

### 5.2 Retention (spans, `ingest_batch`, `file_ctx`) as BACKFILL-lane jobs

- Span retention (chores.rs:68-100 `span_tick`, today holding the state lock for the whole pass) becomes a timer that submits `RetentionChunk(cutoff_received_ms, window = 1 hour of received_ms)` one at a time. Retention is by `received_ms`, not `start_ms` (H15.2: a delayed backlog keeps its 30 days from arrival). Chunks run on the BACKFILL lane, time-budgeted: a deviation from CF H16, which says LIVE lane, made on purpose, because the goal there ("a month-old backlog never blocks ingest") is met better by a lane that yields to LIVE between chunks; the cost is that a 2-hour backfill delays retention, which only delays disk reuse.
- Raw lines and legacy rows are NEVER retained away (D-10, D-DAT-9).
- `CtxPrune` (keep the latest `file_ctx` row per file) and `ingest_batch` prune (rows older than N days AND id below every active cursor, H28) are control jobs on the BACKFILL lane. `meta.version` is a counter, so pruning never makes `v` fall (§3.2 step 16).
- DuckDB never shrinks the file after deletes (D-ENG-8): the design is append-only for the big tables, so the plateau is accepted.

### 5.3 `/api/import` (ui.rs:1595-1612, import_card.rs:77)

The handler reads the body capped at 64 MiB (ui.rs:1599), parses it in `spawn_blocking`, then submits `ImportChunk` jobs of <= 4 MiB to the LIVE lane. An import is modelled as a synthetic `file` row `import:<sha256(body)>` whose "lines" are cards: the same CAS offset gives idempotency (re-importing the same body adds nothing, a half-failed import resumes at the next chunk), the nodes carry `source='import'` and `file_id` of the synthetic row (CF H16). No new write path. Whether the route survives at all is CONTRACT-DELTA (CF H16, OCAT); the one-time legacy-card import is SPEC-legacy-card-import and uses the same mechanism through the BACKFILL lane.

## 6. Readers

### 6.1 Pool and lanes (DECIDED shape in SPEC-read-api §4; sizes OPEN)

`try_clone` of the single Database: 4 interactive + 1 heavy connections created at boot, each behind a `tokio::sync::Semaphore` (a `Connection` is `Send`, not `Sync`, CF H19). No clone per `spawn_blocking` task: the blocking pool would otherwise run hundreds of concurrent queries (CF H19). A request waits for a permit `queue_wait_ms` (200 ms) then gets 503 `overloaded` + `Retry-After`. Deadlines 2 s interactive / 20 s heavy via `Connection::interrupt()` from a timer; 408 `deadline`; the slot returns to the pool only after the statement has unwound. Sizes, deadlines and per-connection overhead are OPEN-R2/R9 in SPEC-read-api and not re-decided here.

### 6.2 Snapshots and transactions (D-ENG-4)

- Every request is ONE short read transaction on one pool connection, opened and closed inside the handler: `BEGIN TRANSACTION READ ONLY; SELECT value FROM meta WHERE key='version'; <page query>; COMMIT`. The response carries `v` read in the same snapshot (H9, H17). Writer and readers never block each other (CAP §2f: reader median 0.7 ms while a 2M-row transaction ran).
- NEVER hold a transaction across HTTP requests (H9, H19): pagination is by an immutable keyset cursor plus `v`, not by a pinned snapshot.
- Streamed responses hold one transaction for the stream, bounded by the 5 s per-chunk write deadline and a hard wall-clock limit; on timeout the response is aborted, the connection is interrupted and returned (SPEC-read-api §4.5). Pages <= 2 MiB are materialised and the connection returned before the first byte is sent.
- Readers never run at background QoS (H12): a background thread starved by the OS keeps its snapshot, and so old row versions, alive. Chores that need a read (`resident_blob_scan` chores.rs:472, `composition_tick` :618, `bodies_pass` :250, the StopFailure calibration) use a pool slot run on a `rt` blocking thread, with short statements.
- Reader connections are read-only handles into the same instance: no reader can write. The old "read route that writes" (`stamp_and_store_reparsed`, ui.rs:918-945) must not be ported (CF H16); `timeline_page` always has rows.

### 6.3 Checkpoint coordination: evidence supersedes the audit's gate (D-ENG-4, D-ENG-7, CAP §2f, §7)

CF H13 proposed a `parking_lot::RwLock<()>` gate (readers shared, writer exclusive during `CHECKPOINT`) on the INFERRED belief that auto-checkpoint is skipped while any transaction is open; SPEC-read-api §4.6 recorded it as DECIDED. CAP §7 measured the opposite on 1.5.5: with a reader holding `BEGIN; SELECT` open for the whole run and 1000 MB inserted, the WAL peaked at 18 MB and stayed at 12-18 MB; CAP §2f: `CHECKPOINT` with concurrent readers returned in 0.03 s and a reader never blocked. Position of this spec (PROPOSED, to be confirmed by T-CKPT):

1. `checkpoint_threshold` stays at the default 16 MiB (D-ENG-7). Auto-checkpoint does the work. No gate in the default path.
2. WAL watchdog in the writer: after every 100th transaction it `stat`s the `.wal`; above `WAL_ALARM` (64 MiB, PROPOSED, 4x the threshold) it issues a plain `CHECKPOINT` at the next batch boundary (never `FORCE CHECKPOINT`, it aborts other transactions, CF H13) and measures its duration and the WAL size afterwards (exported).
3. Fallback only if T-CKPT or the soak shows the WAL not shrinking after 2 consecutive explicit checkpoints with readers active: switch on the shared/exclusive gate (a feature flag already in the code, off by default), and log the event. SPEC-read-api §4.6 should be read as "fallback", not "DECIDED" until T-CKPT passes (OPEN-W9: reconcile that spec).
4. A stream or a stalled client cannot hold a checkpoint hostage in either mode: the 5 s write deadline bounds snapshot age.
5. `temp_directory` for `index.duckdb` is its own directory, excluded from the hourly spill sweeper (chores.rs:219, :928-945), which today deletes by 1 h age (CF H13).

### 6.4 Heavy lane vs writer

`threads` is instance-wide; there is no per-connection priority (CF H19, INFERRED). The mitigations are structural: one heavy permit; BACKFILL pauses at rss pressure stage 1 (§2.4); deadlines. Whether a heavy aggregate measurably delays LIVE commit latency is T-LAT (§8); the knob if it does is `SET threads` lower (INSTANCE-wide) or a smaller heavy deadline. OPEN-W10.

## 7. Startup and shutdown order (D-11, D-ENG-7, H1, H13, H14, H30)

### 7.1 Startup

Today (bin/alcore.rs): parse config at boot (:175, TRDD-N60JUWU3) -> `pid_lock::claim` (:194, refuses a live owner BEFORE any DB open; pid_lock.rs:118-160 reclaims a stale lock) -> runtimes (:328) -> chores, sweeper -> boot sweep gated on `boot_rx` (log_reader.rs:1642) -> listeners.

New order (each step has a deadline; a failure exits non-zero naming the step):

| # | Step | Deadline | On failure |
|---|---|---|---|
| 1 | parse config, validate all knobs (incl. the budget check, §9) | immediate | exit, message names the term that overflows the cap |
| 2 | `pid_lock::claim` (unchanged) | immediate | exit naming the holder pid (existing text, bin/alcore.rs:198) |
| 3 | `open_index()`: the open policy (7.2) incl. swap-journal recovery (§5.1 table) | `OPEN_DEADLINE` 120 s (PROPOSED) | per 7.2 |
| 4 | immediately `CHECKPOINT` after a successful open (PROPOSED, CAP §14: open does NOT truncate the WAL, so without this every restart pays the full replay again and a crash-loop under rss_guard re-reads the same WAL forever) | 60 s | log, continue (the WAL is still valid) |
| 5 | readback of settings: `memory_limit`, `threads`, `checkpoint_threshold`, `autoinstall/autoload = false` (D-ENG-1); schema version step table; `meta` sanity (`version`, `clear_epoch`, `boot_id` regenerated and written) | immediate | exit (fail fast) |
| 6 | create temp staging tables, load `node_key` map, `next_nk`, scheduler loads every `file` row, tailer offsets from `file` (D-8: no sidecar offsets, `log-offsets` retires), pool creation, sealer start, writer thread start, orphan-part listing (§3.3) | 30 s | exit |
| 7 | start OTLP listener FIRST (it needs no DuckDB, D-6), then the other listeners; index-dependent routes answer 503 `index_opening` (+ `Retry-After`) until step 6 completes; `/api/health` reports `{state: opening|replaying|ready}` | n/a | n/a |
| 8 | start parser workers and the scheduler; the boot sweep is BACKFILL work and NO LONGER gates readiness (today it does, log_reader.rs:1424-1450; the aggregate responses carry `{complete, backfill:{files_done, files_total, bytes_done}}` instead, CF H18) | not gating | n/a |
| 9 | start the chores last (the WAL replay RSS peak, ~1 GB per GB WAL (D-ENG-7), must not coincide with other instances opening) | n/a | n/a |

`server start` readiness (the CLI's ready probe) must wait for `state=ready`, not for the first TCP accept; its deadline must be raised above `OPEN_DEADLINE` (EHT-03 in SPEC-effects-handling; OPEN-W11: the exact CLI constant). It must not report failure while the replay is still running (CF H13).

### 7.2 Open policy: never delete (D-11, H1)

`CardStore::open` today deletes the database on ANY open error (card_store.rs:221-222 `remove_file` of file and WAL; :259-290 the triggers). `index.duckdb` is the only copy of raw content that Claude Code may already have deleted (`cleanupPeriodDays`, log_reader.rs:690-703), so the same behaviour is forbidden. Classification of the open result (the error texts are INFERRED and pinned by W-T07, W-T08):

| Result | Action |
|---|---|
| file absent, no sibling artifacts | create, apply schema, write `meta` |
| lock conflict ("Could not set lock on file ... Conflicting lock is held in <process> (PID n)") | exit 2 naming the holder; do NOT retry, do NOT fall back (CAP, CF H14) |
| corrupt header / WAL checksum failure | rename `index.duckdb` -> `index.duckdb.corrupt-<ts>` and `.wal` -> `index.duckdb.wal.corrupt-<ts>`, exit non-zero asking the owner (a move, RULE 0) |
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

If step 5 times out the instance cannot be dropped safely: skip step 6 and 8's explicit release and `exit(0)` immediately; the WAL stays and is replayed at the next boot (step 3-4 above), the stale pid file is handled by `pid_lock::claim`'s stale-lock path (pid_lock.rs:118-160), and the OS releases the DuckDB file lock at process exit. This keeps the invariant of bin/alcore.rs:429-431 (no pid-lock release while this process may still hold the DB). Never release the pid lock before the instance is dropped (H1).

rss_guard hard exit (`check_and_enforce`, rss_guard.rs:539-554: `flush_before_exit()` then `std::process::exit(1)`, no destructors): the `flush_before_exit` closure gains `writer.request_abort()`: stop taking jobs and do NOT attempt a `CHECKPOINT` (it needs memory the process no longer has) and do NOT start a commit. Consequences, all intended: a transaction in flight is absent after restart (CAP §6: `kill -9` with 10,000 flushed uncommitted rows, reopen shows only the committed ones); committed batches survive (D-ENG-6: plain fsync survives process kill); the WAL replay at the next boot is bounded by the 16 MiB threshold plus one batch; the post-open `CHECKPOINT` of 7.1 step 4 breaks any crash-loop. Power loss may lose the last seconds of commits (D-ENG-6): they are re-ingested from the transcript, which still exists at that point (documented, not hidden).

## 8. Hazard map H1-H31 and the tests that prove them

Test ids `W-Tnn` are defined below the table. All tests are real: a real DuckDB 1.5.5 file, real files on disk, real alcore processes where a process boundary matters, no mocks (global rule). Failpoints are `failpoint!(name)` sites compiled in under `cfg(feature = "failpoints")` in test builds; each site blocks on a barrier or kills the process (`kill -9` from the harness), so an interleaving is forced deterministically instead of hoped for (CF H29).

Invariants checked after every crash/interleaving test (I1-I6):
- I1: for every file, `file.off` equals the end of the last committed line, and every line below `off` is in raw storage.
- I2: `node_rollup` equals the aggregate recomputed from the leaf tables (`api_call`, `event`, `tool_use`), including growing usage rows.
- I3: the raw line count equals an INDEPENDENT count (newline counting on the files themselves, not the offsets: CF H29 third bullet).
- I4: no duplicate display row (`event`, `tool_use`, `tool_result`, `spawn_*` keyed `(file_id, byte_off, sub_index)`).
- I5: `meta.version` equals `max(ingest_batch.id)` and is dense/monotone across restarts and clears.
- I6: `meta.clear_epoch` equals the number of `ingest_batch(kind='clear')` rows; no job from an older epoch is in the tables.

| H | Hazard (one line) | Design element that resolves it | Test |
|---|---|---|---|
| H1 CRITICAL | open error deletes the only copy (card_store.rs:221-222) | §7.2 classified open policy, never delete, rename aside; §7.3 CHECKPOINT, drop instance, then release pid lock (D-11) | W-T05, W-T08, W-T18 |
| H2 CRITICAL | funnel unbounded/blocking/dropping | §2: byte-bounded two-lane queue, per-producer blocking, OTLP never enqueues (D-6, D-7), group commit | W-T13, W-T15 |
| H3 CRITICAL | live tail vs backfill on one file | §4.1 scheduler: one owner per file, `dirty_flag`, large-gap rule; §4.3 CAS (D-8) | W-T01, W-T24, W-T25 |
| H4 CRITICAL | clear vs queued batch | §5.1 epoch on every job, guard inside the transaction, side-by-side rebuild and swap (D-10); 409 on a second clear | W-T02, W-T03 |
| H5 CRITICAL | cross-line parser state lost between batches | §3.2 step 14 `file_ctx` in the same transaction (D-9); §4.2 step 4 | W-T11, W-T04 |
| H6 CRITICAL | file identity, rotation, moved/pruned files | §4.2 fstat of the opened handle, `(dev,inode)` + fingerprint, new generation = new `file_id`; read-side visibility is OPEN-W5 | W-T06 |
| H7 CRITICAL | one bad line stalls a file forever | §3.4 two retries, per-job isolation, bisect to one line, `ingest_error`, raw kept, offset advanced; no ENUM, BLOB lines | W-T07 |
| H8 CRITICAL | child before parent needs UPDATE of parent/root/path | writer obligation here: no UPDATE of `node`, `node_key` allocated on first reference (§3.2 step 3, 10); the read-time join (`v_node`) is owned by the schema spec (D-5) | W-T09 |
| H9 CRITICAL | cursor stability and `v` across requests | §6.2 one read transaction per request returns `v`; no transaction across requests; immutable list key owned by SPEC-read-api; writer guarantees monotone `meta.version` in the batch transaction | W-T12 |
| H10 | rollup UPDATE vs MVCC, partial visibility | §3.1 invariants 1, 4; §3.2 steps 6, 7, 11: one explicit transaction, set-based `UPDATE ... FROM`, numeric columns only, no indexed column updated, QUALIFY before every upsert | W-T10, W-T11, W-T26 |
| H11 | state derivable only from the DB at restart | §7.1 steps 5-6 rebuild every cache from `file`, `node_key`, `meta`; no sidecar offsets; SSE `{v,since,boot_id,clear_epoch}` gap detection (§3.2 note) | W-T04, W-T12 |
| H12 | QoS inversion between backfill and writer | §1.2: parse at background QoS, writer at NORMAL QoS, readers never background, chores via pool on `rt` | W-T14 |
| H13 | WAL, checkpoint, replay | §6.3 default threshold, WAL watchdog, plain CHECKPOINT, gate as measured fallback (evidence CAP §7); §7.1 steps 3-4 post-open CHECKPOINT; §7.2 WAL size gate | W-T16, W-T17 |
| H14 | file lock, other processes, several DuckDB instances | §7.1 order (pid lock before open), §7.2 lock conflict exit naming the holder; contract: no external tool opens the live file (use HTTP or a CHECKPOINT + `cp -c` copy); §9 budget is the SUM of all instances | W-T05, W-T22 |
| H15 | OTLP ingest does more than append spans | §1.3 OPEN-W2: no handler-side enqueue; derived rows through a file the tailer reads; retention by `received_ms` (§5.2) | W-T13, W-T20 |
| H16 | other state writers (import, reparse-on-demand, StopFailure, retention, NDJSON import) | §5.3 import as a synthetic file; §6.2 no read route writes; StopFailure via pool after releasing the state lock (§1.3); §5.2 retention chunks; idempotent re-run by offset CAS | W-T20 |
| H17 | version counter monotone across restart and clear | §3.2 step 16 `meta.version` CAS in the batch; §5.1 step (i) clear row, `ingest_batch` never deleted by clear; SSE frame carries `boot_id`, `clear_epoch` | W-T12, W-T03 |
| H18 | backfill ordering, partial-corpus answers | §2.4 duty cycle; §7.1 step 8 backfill does not gate readiness; aggregates carry `complete` and progress (contract owned by SPEC-read-api); mtime gate stays equality | W-T14, W-T19 |
| H19 | reader connections, concurrency, streams | §6.1-6.2 bounded pool, semaphores, deadlines, stream write deadline, no snapshot pinning | W-T19 |
| H20 | clocks, day buckets, future timestamps | writer obligations: ordering by `ingest_batch.id`/`byte_off`, never wall time; clamp `min(ts, now+5 min)` in the delta (§3.2 step 7); day buckets in Rust from `tz` (D-14, SPEC-golden-capture-and-clock owns the clock) | W-T21 |
| H21 | whole-window `collect()` in Rust | writer side: no `collect()` over a result > N rows, queue is byte-bounded (§2.1); read side owned by SPEC-read-api; budget §9 | W-T22 |
| H22 | `otelAttributionBySession` join key | not a writer concern (read-side merge, OCAT FND-06); writer obligation: both feeds' keys are stored (`request_id`, `message_hash`, D-DAT-10) | none here (owner: OCAT) |
| H23 | usage dedup parity: first row wins vs last row | §3.2 steps 6-8: global `api_call` by message hash, QUALIFY collapse, last `seq` wins (D-DAT-2/3, D-4); delta-based rollup | W-T26, W-T11 |
| H24 | `done`-only placeholders, attributable results | parser/schema obligation (only a single-tool_result user line may produce a `spawn_result`); writer inserts what it is given | W-T11 fixture (owner: ingest spec) |
| H25 | bounded caps become unbounded growth | CONTRACT-DELTA; writer: `file_ctx` size cap and `ingest_batch` pruning (§5.2) | none here (owner: CONTRACT-DELTA) |
| H26 | set-once / latest-wins fields | §3.2 step 10 `node_meta` INSERT-only, read as arg_min/arg_max; ordering by `byte_off` is valid because one owner reads a file in order (§4.1) | W-T11 |
| H27 | `created_ms` of the first batch | §3.2 step 10 `ON CONFLICT DO NOTHING` from the batch minimum; epoch drop (§4.3) prevents a tail-only creation | W-T02 |
| H28 | `ingest_batch` / `file_ctx` growth | §3.2 step 16 counter, §5.2 `CtxPrune` and batch prune below every cursor | W-T12 (v never falls after a prune) |
| H29 | test gaps | this section: failpoint interleavings, real second process, kill -9 at named points, prune fixture, same-stem fixture, poison fixture, independent census (I3) | W-T01-W-T06, W-T23 |
| H30 | shutdown deadline and the RSS guard | §7.3 deadlines, timeout path without pid release, `request_abort` in the rss_guard closure | W-T18, W-T17 |
| H31 | fsync rate and file descriptors | §2.2 group commit (<= 50 commits/s); watchers/backstop reduced to stat + mark (§4.1); fsync of Parquet parts in the sealer thread only | W-T15 |

Test definitions:

| id | What it does | Passes when |
|---|---|---|
| W-T01 | two producers one file: hold a BACKFILL batch of file F at `FP_AFTER_READ`; let the watcher name F; release in both orders | exactly one reader existed at any time; final `off`, rows and rollup equal a single pass (I1-I4); the second event only set `dirty_flag` |
| W-T02 | clear vs batch: hold a LIVE batch at `FP_BEFORE_COMMIT`, run the full clear and swap, release the batch | the old-epoch job is dropped (`Dropped(EpochChanged)`); after the swap I1-I6 hold; no raw byte missing (I3) |
| W-T03 | clear robustness: second `/api/clear` during rebuild; `kill -9` at `FP_SWAP_AFTER_CLONE`, `_AFTER_RENAME1`, `_AFTER_RENAME2`, `_BEFORE_EPOCH_BUMP`; restart each time | 409 for the second clear; each restart follows the §5.1 boot table; no file deleted (the test lists the directory before/after); raw count unchanged; `v` never decreases |
| W-T04 | crash matrix: 50 runs of `kill -9` at random named failpoints (`FP_MID_STAGE`, `FP_BEFORE_ROLLUP`, `FP_BEFORE_CAS`, `FP_BEFORE_COMMIT`, `FP_AFTER_COMMIT_BEFORE_NOTIFY`, `FP_AFTER_PART_RENAME`) on the real-corpus sample, restart, resume to completion | I1-I6 and table checksums equal a clean single pass |
| W-T05 | real second process: (a) a second alcore on the same data dir; (b) a separate process that opens `index.duckdb` read-write (a tiny binary linked to the same libduckdb); (c) start alcore while (b) holds it | (a) pid_lock refusal naming the pid; (b)/(c) lock-conflict exit code 2 naming the holder; the file and its WAL are byte-identical afterwards (sha256) |
| W-T06 | identity fixtures: prune-by-rename (smaller replacement, same path); truncate-and-regrow in place; moved directory; two files with one stem; inode reuse (same path, same inode, different head); file deleted while being read | each creates a new generation or a new owner as specified; nothing lost; no offset moved backward; no duplicate `api_call`; deleted file keeps `state='missing'` and its rows |
| W-T07 | poison line: (a) `FP_POISON(file,off)` makes one statement fail; (b) a real data failure (an out-of-range value for a typed column); (c) invalid UTF-8; (d) a 4.4 MiB line; (e) a line over `LINE_HARD_CAP`; (f) a failure that also breaks the raw-only transaction | (a)-(b) `ingest_error` has one row, raw bytes stored, offset advanced past the line, other lines of the batch committed, O(log n) transactions; (c)-(d) stored byte-exact; (e) truncated marker + loud log; (f) process exits non-zero (no loop) |
| W-T08 | error-text pinning on the real engine: lock conflict, truncated header, bit-flipped WAL, `Conflict on update`, an OOM-with-ART FATAL, newer-version file (only if a fixture can be produced; else OPEN) | each maps to the §7.2/§3.4 class; any unrecognised text exits non-zero with the raw text |
| W-T09 | child before parent: ingest a subagent file first, the parent later | no UPDATE statement ran on `node`/`node_key`; the read-time join resolves; the intermediate state shows an orphan root with a badge |
| W-T10 | transaction discipline: a poller reads rows, rollup and `file.off` in one snapshot 10,000 times during ingest; the connection wrapper asserts `in_txn` | the poller never sees rows without their rollup or offset; `count(ingest_batch)` equals the commit count; an autocommit attempt panics the test build |
| W-T11 | rollup equals recompute: fixtures with a growing subagent usage row, sibling subagent files with identical rows, a usage-less first row, a batch boundary between `tool_use` and `tool_result` | I2 holds; the result equals a single pass with batches of a different size (batch-size independence) |
| W-T12 | cursor and version: walk a list while the writer ingests new sessions and touches old ones; SSE reader that drops frames (`Lagged`); restart; clear | no duplicate/missing row in the walk by the immutable key; every response's `v` comes from its own snapshot; a gap or `boot_id`/`clear_epoch` change triggers refetch; `v` never decreases |
| W-T13 | backpressure and no loss: the repo's 32-poster OTLP flood with the writer stalled by a failpoint sleep; backfill running; hook posts | every POST returns 200 (D-6); queue bytes never exceed the budget; RSS growth below the budget; `tailer_lag_bytes` rises then drains to 0; span rows equal NDJSON lines |
| W-T14 | latency and QoS: LIVE job queue-wait and commit latency while BACKFILL runs and the machine is CPU-saturated; read each thread's class with `pthread_get_qos_class_np` | writer NORMAL, parsers/scheduler/sealer BACKGROUND, no reader thread BACKGROUND; LIVE p95 queue-wait under a bound set from the baseline run (OPEN: bound) |
| W-T15 | group commit: 32 posters + live tailing | commits/s <= 50 (counted from `ingest_batch` rows per second); group sizes > 1 under load |
| W-T16 | T-CKPT: a reader holds `BEGIN; SELECT` for 10 min while 1 GB is ingested; then an explicit `CHECKPOINT` with the reader still open | WAL <= `WAL_ALARM`; `CHECKPOINT` returns; the reader's snapshot is still consistent; with the fallback flag the gate path also passes |
| W-T17 | WAL replay: `kill -9` with a 64 / 256 / 1,024 MiB WAL (threshold raised in the test only), reopen; the WAL size gate with a tiny cap; rss_guard exit mid-ingest then restart | open time and RSS are recorded next to CAP §14 and stay within 25% of it; the gate refuses without touching the WAL; the post-open CHECKPOINT zeroes the WAL; the restart converges (no loop) |
| W-T18 | shutdown: stop during backfill with a 100 MiB WAL; stop with a `CHECKPOINT` made slow by failpoint | finishes inside `stop_timeout`; in-flight BACKFILL rolled back with `off` unchanged; timeout path exits without releasing the pid file and the next start succeeds; `Arc::strong_count == 1` assertion holds |
| W-T19 | reader pool: 40 concurrent calls, a deadline-exceeding call, a stalled stream client | at most 5 queries run at once; 503 within `queue_wait_ms`; 408 within deadline + 100 ms and the connection is reusable; a stalled stream releases its snapshot and the next checkpoint succeeds |
| W-T20 | import and retention: import the same body twice and kill mid-import; run a retention chunk while a LIVE flood runs; a late-delivered backlog with old `startTime` | second import adds nothing, resume continues at the next chunk; LIVE p95 unchanged by retention; the backlog survives by `received_ms` |
| W-T21 | time: a line stamped 2099; the injected clock stepping backward | `last_active_ms` clamped to now + 5 min and `ts_suspect` set; ordering by `ingest_batch.id` unaffected |
| W-T22 | memory: start with a configuration over the cap; clear admission with and without headroom; 40 concurrent reads + backfill + clear soak | exit non-zero naming the term; 409 with numbers; RSS stays below the budget sum |
| W-T23 | independent census: count newlines in the corpus files with a streaming Rust scan and compare with `count(raw)` per file up to `off` | equal for every file |
| W-T24 | huge gap: a never-visited 700 MB file | one bounded LIVE batch, the rest through BACKFILL, another file's LIVE latency unaffected |
| W-T25 | scheduler defect injection: hand the same file out twice | the CAS refuses the second batch, `cas_miss_total` increments, nothing lost or duplicated; a repeat inside 1 min exits non-zero |
| W-T26 | upsert semantics: a batch with two usage rows for one message id; sibling-file duplicates; growing rows across batches; a usage-less first row; a control run WITHOUT the QUALIFY | with QUALIFY: last `seq` wins, delta applied once; the control run reproduces D-ENG-3 first-row-wins, proving the collapse is needed |

## 9. Memory budget (D-ENG-9, D-16, H14, H21)

Fact base: `memory_limit` counts only DuckDB-managed memory; RSS runs 120-330 MB above it (D-ENG-9, CAP §2g: 631 MB RSS at a 512 MB limit); ART nodes are counted but never evicted, and an OOM with an ART index loaded is FATAL (D-ENG-2, CAP §5); the WAL replay at open costs ~1 GB RSS per GB of WAL (D-ENG-7); reader connections cloned from one Database share its `memory_limit` and `threads` (D-ENG-4).

Budget (all numbers are limits or caps, not measurements; the bench fixes them, D-15/D-16):

| Term | Symbol | Value | Source |
|---|---|---|---|
| index instance `memory_limit` | L_idx | 512 MiB (OPEN: bench) | CAP experiments; D-16 |
| `api_call` ART resident | A_art | <= 64 MiB (PROPOSED; OPEN: measure at 1M and 3M HUGEINT keys; a test fails above) | D-4, D-ENG-2 |
| writer queue | Q | 64 MiB (LIVE 40, BACKFILL 24) | §2.1 |
| parser workers | P | 2 x (4 MiB slice x 4 expansion) + ctx ~ 40 MiB | PROPOSED |
| other DuckDB instances (cards.duckdb until retired 256 MiB, transcript heavy slot 1 GiB transcript_sql.rs:27-29, session_summary_sql.rs:117, bodies_evidence.rs:77, statusline_store.rs:230, agentlens-store/src/lib.rs:158) | L_other | sum of the limits read from each module at startup | CF H14 |
| allocator + appender margin | M | 330 MiB | D-16 |
| Rust base (CoreState, hook ring, burn, span NDJSON writer buffers) | R | measured (OPEN: composition line, chores.rs:549) | |
| reader pool overhead (5 connections) | R_pool | OPEN-R2 | SPEC-read-api §5 |
| second instance while a clear runs | L_next + Q_next | 512 + 16 MiB, only during clear | §5.1 |
| WAL replay transient | W | <= 1.1 x WAL bytes at open, before chores start | D-ENG-7 |

Formula: `B = L_idx + A_art + Q + P + L_other + M + R + R_pool` (plus `L_next + Q_next` while clearing, plus `W` only during open). Startup check (step 1 of §7.1, fail fast): refuse to start if `B > cap` with the message listing each term; warn if `B > 0.70 x cap` (stage 1 of the pressure ladder, rss_guard.rs:400 `pressure_fracs` on macOS), because steady state above stage 1 means the ladder fires permanently. Clear admission (§5.1 step 1) repeats the check with the clear terms added and answers 409 with the numbers. A runtime gauge compares `duckdb_memory()` of each instance and the process footprint against `B` on the composition tick (chores.rs:618) and exports the margin to `/api/server-stats`. The rss_guard hard exit (rss_guard.rs:539-554) remains the backstop, not the plan.

Arithmetic with the figures above, as a finding and not a conclusion (A_art lives inside L_idx and is listed only so it gets its own test): L_idx 512 + Q 64 + P 40 + L_other 1,280 (256 + 1,024) + M 330 = 2,226 MiB, with R and R_pool still unmeasured, against today's cap of 2,048 MiB (rss_guard.rs:25-36). So the static check, as specified, would refuse to start at today's cap; it passes at the interim 4,096 MiB cap (D-13, serverControl.ts:222) and at 2,048 MiB only if the bench shrinks L_idx and the 1 GiB transcript slot. OPEN-W12: whether the static check sums LIMITS (a guarantee, conservative) or a measured steady state plus the limits of eager instances (looser, weaker). This spec asks for the limit sum for the index instance and the measured peak for the others, because only the index instance can take the whole process down with a FATAL (D-ENG-2).

Ordering rule that follows: the index opens BEFORE the other instances and the chores start (§7.1 step 9), so the WAL replay peak does not stack on their allocations. Bulk work that would exceed `L_idx` must not be a single DuckDB statement: staging per batch bounds every statement by the batch size (the Parquet `COPY` of a 3 KB-line table already hit "Out of Memory" at a 512 MB limit, CAP §2g, and needed small row groups; the sealer therefore writes with the Rust parquet crate, D-1).

## 10. Open points

| id | Question | Decided by |
|---|---|---|
| OPEN-W1 | do hook events become a table (OCAT NS-3) or stay in bucket files | schema spec / OCAT |
| OPEN-W2 | which table receives each OTLP-logs-derived row; the extra NDJSON file if any | schema spec (constraint: through a file with an offset) |
| OPEN-W3 | who may empty `parts/_unreferenced/` | owner (default: never automatic) |
| OPEN-W4 | `DO UPDATE ... WHERE` accepted by DuckDB 1.5.5; the `seq` definition across files for one message id | a 10-line engine test before schema freeze |
| OPEN-W5 | read-side visibility of older generations (D-4 per-file keys vs CF H6 natural-key idempotency) | schema/ingest spec |
| OPEN-W6 | re-drive of `ingest_error` rows after a parser fix | follow-up card |
| OPEN-W7 | process exit code table (lock conflict 2, corrupt, fatal, budget) | EHT-03 with the CLI |
| OPEN-W8 | cost of `cp -c` on a filesystem without clones | measured at the clear bench |
| OPEN-W9 | SPEC-read-api §4.6 says the checkpoint gate is DECIDED; this spec demotes it to a fallback on evidence | W-T16, then amend SPEC-read-api |
| OPEN-W10 | does a heavy read delay LIVE commit latency; the `threads` knob | W-T14 |
| OPEN-W11 | the CLI start deadline constant above `OPEN_DEADLINE` | EHT-03 |
| OPEN-W12 | static memory check: limit sum vs measured | bench + owner |
| OPEN-W13 | numbers marked PROPOSED: 20 ms group window, 1000-row group cap, 50 ms BACKFILL batch, 4 MiB cap, duty 0.5, Q 64 MiB (40/24), 2 parser workers, `LIVE_MAX_GAP` 8 MiB, `SWAP_DELTA_BYTES` 8 MiB, `WAL_ALARM` 64 MiB, `LINE_HARD_CAP` 256 MiB, `OPEN_DEADLINE` 120 s | SPEC-method-bench per D-15 |

Verified-here / not-verified-here. VERIFIED by reading: the code locations cited (hook, handler, sweeper, shutdown, rss_guard and pid_lock lines), and every engine fact quoted from DEC/CAP (their own VERIFIED marks). INFERRED and not run: that `BEGIN TRANSACTION READ ONLY`, `DO UPDATE ... WHERE`, a `TEMP` table `DROP` inside a transaction, and the lock-conflict/corruption error texts behave as written; that an APFS clone of a live DuckDB file after `CHECKPOINT` opens cleanly; that two `Database` instances on two different files in one process are independent (CF H14 states it, CAP did not run it). Each is the first line of one of the tests above.
