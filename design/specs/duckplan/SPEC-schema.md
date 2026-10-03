---
title: DuckDB-index redesign - schema spec (index.duckdb DDL + raw-line store)
status: draft (revised against decision log R1; items pending revision 2 / experiment E7 are marked OPEN)
scope: project
sources: docs_dev/duckplan-decisions.md (D), docs_dev/duckplan-decisions-r1.md (R1, wins on conflict), reports/DUCKPLAN/20261003_192823+0200-duckdb-capabilities.md (CAP), reports/DUCKPLAN/20261003_182757+0200-transcript-format-facts.md (T), reports/DUCKPLAN/20261003_165118+0200-concurrency-and-flaws.md (H), reports/DUCKPLAN/20261003_185350+0200-e1-raw-storage.md (E1), reports/DUCKPLAN/20261003_190622+0200-e1b-raw-storage-settle.md (E1b), reports/DUCKPLAN/20261003_185422+0200-e2-rollup.md (E2), reports/DUCKPLAN/20261003_190033+0200-e3-dedup.md (E3), reports/DUCKPLAN/20261003_185312+0200-e4-tree-paging.md (E4), reports/DUCKPLAN/20261003_190027+0200-e5-spill-and-images.md (E5), design/specs/duckplan/SPEC-operation-catalog.md (K), design/specs/duckplan/SPEC-legacy-card-import.md (L)
---

# Schema of alcore's new `index.duckdb` and its raw-line store

Citation rule: every choice cites a decision id (D-*, R1-*) or a report section (CAP §n, T Qn, H<n>, E<n>, K §n, L §n). VERIFIED/INFERRED/OPEN: byte and row estimates in section 6 are INFERRED (rows from the reports, bytes-per-row assumed) unless marked MEASURED; every OPEN item is collected in section 11. This spec defines data shape only; the writer funnel, read API and bench are SPEC-read-api, SPEC-method-bench and SPEC-writer-and-concurrency.

Decision status carried by this revision. R1 supersedes the D items it names. A later review (revision 2, after experiment E7) reopened four R1 items; this spec therefore does NOT implement them as written and keeps the schema able to carry each candidate: R1-D4(b) generation-bump rollup recompute and R1-D4(c) same-file-only usage update (OPEN-O4, OPEN-O6), R1-D10 clear semantics (OPEN-O12), R1-D5 node/file identity rules (OPEN-O25), R1-ENG6 snapshot mechanics (OPEN-O26). Also still OPEN by R1 itself: R1-D1 raw-line backend (OPEN-O1, OPEN-O3) and R1-D4-ART api_call uniqueness mechanism (OPEN-O20, experiment E6). Not a schema matter, so not applied here: R1-D12 (consumer sweep for the D-12 field changes: owned by SPEC-effects-handling / CONTRACT-DELTA).

## 0. Conventions

### 0.1 Legend

- Writer paths (D-7: one writer thread owns the single write connection; producers never touch a connection; R1-D7: LIVE producers - watcher-driven reads, NDJSON tailer - run at NORMAL QoS, only BACKFILL runs at background QoS):
  `W-LIVE` live-lane batch from a file reader; `W-BACK` backfill-lane batch; `W-OTLP` NDJSON span tailer (D-6, R1-D6); `W-ACCT` account-state / OTLP-log account events; `W-HOOK` hook POSTs (H10-H12 in K); `W-LEG` legacy import (L §3); `W-IMP` `/api/import` (H16); `W-MAINT` part sealing, retention prune, heartbeat, migrations, snapshots; `W-CLEAR` clear / reindex into the side database (OPEN-O12).
- Class (for clear/reindex, section 8): RAW = never derived, never cleared (D-10, R1-D10); DERIVED = rebuilt from RAW by a reindex; SIDE = sourced outside the raw-line store (NDJSON/hook/OTLP), carried over unless stated.
- Line key = `(file_id, gen, byte_off, sub_index)`: identifies one derived row of one physical line (R1-D4). `byte_off` replaces `seq` as the only ordering inside a file (H6). The ordering key across the files of a node is `(ts_ms, file_id, byte_off)` (H6).
- Idempotency (R1-D4, per ROW): (a) same-file re-reads are prevented by the offset compare-and-set (D-8, U1) - the only protection of the index-free display tables; (b) a generation bump ingests the new gen as new rows, old-gen rows stay in the archive (their visibility and the rollup consequence are OPEN-O4); (c) cross-file duplicates (sibling subagent files, fork copies) matter only for totals: `api_call` is unique on `(source, message_id)` and attribution is fixed at first insert (the update guard is OPEN-O6); (d) rollup deltas are computed from the rows a batch actually APPLIED (changed-row capture, section 3.3 U4/U5), never from the batch input.
- Types (D-ENG-10, D-14): counts and times are BIGINT, times are epoch-ms (no TIMESTAMP/DATE column anywhere), no FLOAT/DECIMAL, DOUBLE only for values < 1e16, no ENUM (H7: `type`/`kind` are VARCHAR, dictionary-compressed by the engine), no LIST column (appender cannot bind LIST, CAP §1). Identifiers: `file_id`, `nk`, `gen`, `part_id` INTEGER; byte offsets BIGINT.
- 128-bit values (`api_call.call_key`): duckdb-rs binds no i128 (CAP §1 ToSql list ends at u64), so the writer computes the key in Rust (xxh3-128 over `source`, a 0x00 byte, and the message id text; the hash function is INFERRED, not yet benched) and stages `(hi BIGINT, lo UBIGINT)` in the TEMP staging table, combined in SQL as `hi::HUGEINT * 18446744073709551616 + lo::HUGEINT` (exact for the whole signed range; a shift form `(hi::HUGEINT << 64) | lo::HUGEINT` is UNVERIFIED for HUGEINT, so the multiplication is the stated form). HUGEINT is never serialised to JSON (the text id is).
- Every append-only line-derived table carries `batch_id` (the `meta.data_version` value of its transaction): it freezes a paging walk with `batch_id <= v` (H9) and links a row to its change-feed entry.
- Bounded-ART rule (D-ENG-2): an ART index exists only on a table whose key count has a stated bound (section 3). No other table has PK/UNIQUE/INDEX. Idempotency for index-free tables comes from the per-file offset compare-and-set (R1-D4(a), D-8, section 4.1 `file`), not from a key; the invariant I17 detects a duplicate line key after the fact.

### 0.2 Table inventory (29 tables with raw backend P, 27 with backend D; 5 views; macros)

Raw-line backend (R1-D1, OPEN-O1/O3): backend P = Parquet parts (`raw_stage`, `raw_part`, `raw_index`, tables 7-9), backend D = a zstd BLOB column inside DuckDB (`raw_line`, replacing tables 7-9). Exactly one backend is created per data dir (`meta.raw_backend`); everything outside section 4.2 is identical under both.

| # | table | class | ART index | # | table | class | ART index |
|---|---|---|---|---|---|---|---|
| 1 | meta | RAW | PK(key) | 16 | spawn_result | DERIVED | none |
| 2 | file | RAW | PK(file_id) | 17 | event | DERIVED | none |
| 3 | file_ctx | DERIVED | none | 18 | api_call | DERIVED | PK(call_key) (mechanism OPEN-O20, E6) |
| 4 | ingest_batch | RAW | none | 19 | tool_use | DERIVED | none |
| 5 | ingest_batch_root | RAW | none | 20 | tool_result | DERIVED | none |
| 6 | ingest_error | RAW | none | 21 | otel_span | SIDE | PK(trace_id, span_id) (R1-D6, OPEN-O27) |
| 7 | raw_stage (P) / raw_line (D) | RAW | none | 22 | otel_span_attr | SIDE | none |
| 8 | raw_part (P) | RAW | none | 23 | account_map | SIDE | none |
| 9 | raw_index (P) | RAW | none | 24 | account_state | SIDE | none |
| 10 | node_key | DERIVED | PK(key_kind,key_text) | 25 | call_block | SIDE | none |
| 11 | node | DERIVED | PK(nk) | 26 | hook_event | SIDE | none |
| 12 | node_meta | DERIVED | none | 27 | collector_run | SIDE | none |
| 13 | node_rollup | DERIVED | none | 28 | legacy_card | RAW | PK(natural_key) |
| 14 | root_cache | DERIVED | none | 29 | legacy_import_run | RAW | none |
| 15 | spawn_edge | DERIVED | none | | | | |

Backend P has all 29 rows; backend D replaces rows 7-9 by the single table `raw_line`, giving 27. Views: `node_visible`, `node_account`, `v_api_call`, `v_spawn_link`, `v_raw_keys` (5, section 4.7).

## 1. DuckDB settings applied at every open (writer and every `try_clone` reader share one Database)

| setting | value | why / cite |
|---|---|---|
| crate features | `bundled`, `json`, `parquet`; NOT `icu` | `to_json`/`json_*` are not statically linked and would autoload from the network (D-ENG-1, CAP §16); `read_parquet` for raw parts and the bodies store; ICU not needed (D-14) |
| `autoinstall_known_extensions`, `autoload_known_extensions` | `false` on the index instance, applied ONLY after the R1-ENG1 sequence: (1) enable the static `json` and `parquet` features, (2) verify that every other DuckDB instance in the process (`transcript_sql` `read_ndjson_auto`, the bodies store Parquet `COPY`, the in-memory summary instance) works with autoload off, (3) only then turn autoload off | a missing feature must fail at startup, never at runtime (D-ENG-1, R1-ENG1); the settings are per instance, so each instance is checked separately |
| startup self-test | `SELECT to_json({'a':1});` then `COPY (SELECT 1 AS x) TO '<index-tmp>/selftest.parquet' (FORMAT parquet); SELECT count(*) FROM read_parquet('<index-tmp>/selftest.parquet');` | proves json+parquet are linked with autoload off (a self-written tiny part replaces the earlier unexplained "embedded part"); failure = exit with error (fail fast) |
| `memory_limit` (index instance) | OPEN-O2 (number fixed by SPEC-method-bench) | covers only DuckDB-managed memory; RSS runs 120-330 MB above it (D-ENG-9: CAP §2g 631 MB RSS at a 512 MB limit, ingest 790-840 MB); budget in section 6.4 (D-16, R1-BUDGET) |
| `threads` | OPEN-O2 (proposal: 2) | no long high-CPU bursts; responsiveness (owner rule in D) |
| `checkpoint_threshold` | default 16 MB, not raised | WAL replay costs ~2.5 s and ~1 GB RSS per GB of WAL and open does not truncate it (D-ENG-7, CAP §14); CAP §7 measured the WAL staying 12-18 MB with a long-lived reader, so no checkpoint gate is in the schema (R1-CKPT: SPEC-read-api §4.6 gate is a fallback, test W-T16 decides) |
| `temp_directory` | `<dataDir>/index-tmp/` (own directory, exempt from the hourly temp sweeper) | H13 (sweeper `chores.rs:219` must not delete an active spill) |
| storage version, `force_compression` | engine default `v0.10.2` and no forced compression under backend P; under backend D the raw table needs `STORAGE_VERSION 'latest'` AND `force_compression='zstd'` (CAP §3: automatic choice never picks zstd; E1b D1/D2). Recorded in `meta.storage_version`. Whether D uses a second attached file for `raw_line` (so only that file is forced to zstd) or the single file is part of OPEN-O1 | D-1 moved raw lines out of DuckDB, R1-D1 reopened that choice, so the zstd condition is backend-dependent (an earlier version of this table called it "gone") |
| time zone | not set (no ICU) | D-14 |
| `preserve_insertion_order` | default | batches are small; revisit only if the bench shows memory gain (OPEN-O2); CAP §2g needed `false` only for a Parquet `COPY` of large rows at 512 MB |
| shutdown | `CHECKPOINT`, drop the Database instance, then release `pid_lock` | D-11, H1, H30 (a stopped-then-restarted alcore must not overlap its predecessor) |
| open policy | lock conflict: exit naming the holder; corrupt/unopenable: rename aside, then exit, and NEVER start on an empty database (R1-ENG6: recovery from a newest snapshot is OPEN-O26); never delete; version change: forward migration | D-11 (replaces today's delete-on-error, H1) |
| durability statement | commits use plain `fsync` (no `F_FULLFSYNC` in the bundled build): durable across process kill, NOT across power loss, where writes may also reorder and corrupt the file (R1-ENG6). The accepted loss "re-ingest the last seconds from the transcript" holds only while the transcript still exists; once Claude Code deletes it the index is the only copy, hence the startup integrity check and the snapshot/reindex paths (R1-ENG6, OPEN-O26) | D-ENG-6, CAP §15. H2/H30/H31 assume `F_FULLFSYNC` from a code comment (`card_store.rs:410-411`); CAP §15 read the engine source and measured sub-millisecond commits: CAP is the verified source |

## 2. Migration framework

- `meta.schema_version` (INTEGER) is the only version. The binary embeds an ordered list of steps `V(n-1) -> V(n)`; version 1 is the baseline = the DDL of section 4 as written here for the backend frozen by OPEN-O1/O3/O20.
- Forward-only, never delete-and-rebuild (D-11): a step never drops or truncates a RAW-class table (`meta, file, ingest_batch*, ingest_error, raw_*, legacy_*`) and never drops the raw-line store. A DERIVED table may be rebuilt by `CREATE TABLE new AS SELECT ... FROM old`, a swap by rename and re-creation of its macros, because DERIVED data is reproducible from RAW; RAW tables change only by `ALTER TABLE ... ADD COLUMN` (nullable or defaulted), `CREATE TABLE`, `INSERT ... SELECT`.
- Each step runs in ONE transaction: the DDL/DML plus `UPDATE meta SET value_int = :to WHERE key='schema_version' AND value_int = :from`; a row count other than 1 aborts and rolls back (compare-and-set, CAP §13 `execute` row count).
- Before the first step of a startup that must migrate: `CHECKPOINT`, then `cp -c` (clone) of `index.duckdb` to `index.duckdb.pre-migrate-v<from>-<UTC stamp>` kept until the user removes it (H1: "pre-flight copy before any migration or clear"; RULE 0). Raw parts are not copied (immutable, never rewritten). Cost caveat (R1-ENG6, OPEN-O26): a clone of the database file shares blocks only until the next checkpoint rewrites them, so it is a point-in-time copy, not a free one.
- Startup compares `schema_version` with the binary's maximum: equal = continue; lower = run steps in order; higher = refuse to start with an error naming both versions (never downgrade); absent `meta` in an existing file = treat as corrupt (rename aside + exit, D-11); no file = create at the latest baseline by applying all steps from 0 in one transaction each (same code path as migration, so a fresh DB and a migrated DB are the same by construction).
- A crash mid-step leaves the previous version (single transaction, WAL replay): the next start re-runs the step.
- Macros and views (4.7) are NOT migration steps: they are `CREATE OR REPLACE`d at every open from the binary's embedded SQL (selected by `meta.raw_backend`), because persisted macros survive close/reopen (CAP §2d) and would otherwise go stale when a function body changes. Only table shape is versioned.
- `ALTER TABLE ... ADD COLUMN` on a table that has an ART index (`meta, file, node, node_key, api_call, legacy_card, otel_span`) may be refused by DuckDB with a dependency error: UNVERIFIED, OPEN-O9. Until measured, a step on those seven tables is written as create-new + `INSERT ... SELECT` + rename + recreate the PK, executed on the cloned file and checked by the invariants of section 9.

## 3. Index policy (D-ENG-2, R1-D4)

### 3.1 The only ART indexes

| index | key count (bound) | resident ART estimate | bound source |
|---|---|---|---|
| `meta` PK(key) | < 16 | negligible | fixed key list |
| `file` PK(file_id) | 27,723 files today, ~+46k/yr | < 4 MiB | T Q5 file count; growth = 27.7k files / 218 days (D-DAT-8) |
| `node` PK(nk) | ~33k today (27.6k transcript files without the 112 `journal.jsonl` + 5.7k legacy orphans), budgeted at 40k + imports | < 4 MiB | T Q5, D-DAT-9 (R1-DAT9: the orphan count is re-derived by the import); L §1.1 bounds legacy at 40,979. One node per file or legacy card. An earlier draft wrote "33k transcript + 5.7k legacy": the transcript count is 27.7k (T Q5), not 33k |
| `node_key` PK(key_kind, key_text) | same as node (more than one key per node is possible, OPEN-O25) | < 16 MiB (path/inode strings) | one or two keys per node |
| `legacy_card` PK(natural_key) | <= 40,979 (all cards ever merged), one-off import | < 4 MiB | L §1.1 |
| `api_call` PK(call_key HUGEINT) | ~1.0M today; ~1.7M/yr @avg rate, ~7.5M/yr @recent rate (R1-D4-ART: growth 5-9M keys/year, boundedness must be measured) | ~16-20 MiB today; BIGINT measured 8.1 B/key persisted (51 MB / 6.3M keys, CAP §5), HUGEINT assumed 2x (INFERRED) | R1-D4-ART: the mechanism is OPEN until E6 (ART on a 128-bit key vs index-free anti-join restricted by timestamp, duplicates share the exact ts, vs monthly key partitions); the PK is the default pending E6 |
| `otel_span` PK(trace_id, span_id) | unmeasured; 30-day retention (R1-D6); span NDJSON volume is in no report read here | unmeasured; VARCHAR keys, so larger per key than the BIGINT figure | R1-D6 requires the unique key; its resident size and the retention delete against an indexed table (D-ENG-2 forbids bulk deletes there) are OPEN-O27 |

Budget (D-16, the test of section 10): total resident ART after a worst-case batch <= 64 MiB through the first year at the average rate; the startup check also compares `count(api_call) * 20 B` with the budget and logs a warning at 50% and refuses new-key batches at 100% instead of an OOM (an ART OOM is FATAL and invalidates the handle, CAP §5). This check exists only while the PK mechanism of `api_call` stands (E6 may replace it). The escape hatches if the recent growth rate persists (7.5M keys = ~150 MiB) are the two other E6 candidates (OPEN-O20).

### 3.2 Forbidden

Any other PK/UNIQUE/INDEX. A bulk DELETE/UPDATE never runs against a table that has an index (CAP §5: a write touching many keys loads the whole index). The append-only retention paths `ingest_batch*` and `hook_event` are on index-free tables for exactly this reason; `otel_span` is the exception R1-D6 forces (OPEN-O27: chunked delete vs per-day tables vs `DROP`/`CREATE`).

### 3.3 UPDATE allowlist (anything else is a defect; H "only updated table" note: the draft's claim was false)

| id | statement (columns written) | table | why it is safe |
|---|---|---|---|
| U1 | `UPDATE file SET next_off=:new, tail_fp=:fp, size_seen=:sz, mtime_ms=:mt, last_batch_id=:b WHERE file_id=:id AND gen=:gen AND next_off=:expected` row count must be 1, else ROLLBACK the batch (D-8, H3, CAP §13) | file | non-indexed columns; one row |
| U2 | `UPDATE file SET gen=gen+1, next_off=0, head_fp=:h, tail_fp=:t, state='active'` (replacement/rotation, D-DAT-1; whether `dev`, `inode` are rewritten and how the row is found are OPEN-O25) and `SET path=:p` (a move) and `SET state=:s` (`missing`), always `WHERE file_id=:id AND gen=:gen` | file | non-indexed; never zeroes a row's history |
| U3 | `UPDATE meta SET value_int=value_int+1 WHERE key='data_version'` (and the `next_*` counters) inside the batch transaction | meta | one row, non-key column |
| U4 | `UPDATE node_rollup r SET ... = r.x + b.dx, last_active_ms = greatest(...) FROM (applied-set aggregate) b WHERE r.nk=b.nk`, one statement per batch (D-3, H10). `dx` comes from the rows the batch APPLIED (R1-D4(d)): for the index-free display tables the batch rows themselves (the offset CAS of U1 guarantees each row is applied once), for `api_call` the applied-set table of U5 | node_rollup | no index; set-based; the columns are not in any index |
| U5 | `api_call` upsert in two steps inside the batch transaction. Step 1 (applied-set capture, R1-D4(d)): `CREATE TEMP TABLE applied AS SELECT s.*, a.nk AS owner_nk, <old usage columns>, CASE WHEN a.call_key IS NULL THEN 'insert' ELSE 'update' END AS action FROM st_api s LEFT JOIN api_call a USING (call_key) WHERE a.call_key IS NULL OR <guard>`, after the in-batch collapse `QUALIFY row_number() OVER (PARTITION BY call_key ORDER BY <guard order> DESC) = 1` (D-ENG-3: duplicates inside one statement are silently collapsed first-row-wins even for DO UPDATE). Any joined row whose `message_id_text` differs from the stored one is a hash collision: insert `ingest_error(kind='collision')` and ROLLBACK (fail loudly; the invariant I3 reports it). Step 2: `INSERT INTO api_call ... ON CONFLICT (call_key) DO UPDATE SET <usage columns and winning line key> WHERE <guard>` (the form measured by E3 D1). Single writer + one transaction mean steps 1 and 2 see the same `api_call`. `nk` is never in the SET list: attribution is fixed at first insert (D-DAT-4). The `<guard>` is OPEN-O6: candidate G1 (R1-D4(c)) `excluded.file_id = api_call.file_id AND (excluded.gen, excluded.byte_off) > (api_call.gen, api_call.byte_off)`; candidate G2 (reported direction of revision 2) `excluded.output_tokens > api_call.output_tokens` (largest usage wins). `<guard order>` is `(gen, byte_off) DESC` for G1 and `output_tokens DESC` for G2 | api_call | the key column is never in the SET list; the delta credited to `owner_nk` is `new - old` for an update and `new` for an insert; sibling or fork copies that lose the guard apply nothing and credit nothing |
| U6 | `UPDATE node SET created_ms=:ms WHERE nk=:nk AND created_ms IS NULL` (once per node, when the first timestamped line arrives; D-DAT-6, H27, R1-D5) | node | non-indexed column; set-once; CAP §9 verified even indexed-column UPDATEs |
| U7 | legacy adoption: `UPDATE node SET origin='live', kind=:k, file_id=:f WHERE nk=:nk AND origin='legacy'` (`source` already holds the agent, R1-ORIGIN); `UPDATE legacy_card SET shadowed_ms, shadowed_by_nk`; `UPDATE legacy_card SET partial, deficit_calls, twin_nk` (L §1.3, §4) | node, legacy_card | `nk` kept stable; key columns untouched |
| U8 | `UPDATE collector_run SET last_seen_ms=:t` (every 5 s) and `SET stopped_clean=true` (NS-9); `UPDATE legacy_import_run SET finished_ms, status ...` (one row per run) | collector_run, legacy_import_run | tiny, non-indexed |

DELETE allowlist: `raw_stage` rows of a sealed part (same transaction as the `raw_index` insert; backend P only), `file_ctx` rows older than the latest 2 per file, `ingest_batch`/`ingest_batch_root` older than the retention horizon, `root_cache` rows of touched `nk` before reinsert, `otel_span`/`otel_span_attr` by `received_ms` and `hook_event` in bounded chunks on the LIVE lane (H16; for `otel_span` see OPEN-O27). RAW tables are never deleted from, except the staging hand-off above and the horizon prune of the two change-feed tables `ingest_batch`/`ingest_batch_root` (they carry no content; class RAW only because they are copied by a reindex). Clear semantics (OPEN-O12) may add `DROP TABLE` + `CREATE TABLE` of the span tables in one transaction (H4), never a `DELETE` of an indexed table.

## 4. Tables

DDL is the contract. Column meaning is in the comment. "Rows/bytes" are INFERRED (see 6) unless MEASURED.

### 4.1 Control: meta, file, file_ctx, ingest_batch, ingest_batch_root, ingest_error

#### meta
Purpose: version, settings and counters. Writer: W-MAINT (migrations), every batch transaction (U3).
```sql
CREATE TABLE meta(
  key        VARCHAR PRIMARY KEY,
  value_int  BIGINT,
  value_text VARCHAR
);
-- seeded keys: schema_version (int), storage_version (text), raw_backend (text: 'parquet' | 'duckdb', R1-D1),
-- clear_epoch (int, D-8/H4), data_version (int, monotone change counter, H17/H28),
-- next_file_id, next_nk, next_node_seq, next_part_id (backend P only), next_run_id, next_hook_id
-- (ints; allocated on the writer thread inside the batch txn: no gap problem, no max() scan, H11),
-- index_created_ms, created_by_version (text). The key a clear variant needs beyond clear_epoch
-- (a watermark such as clear_before_ms) is added only if OPEN-O12 chooses it: meta is key/value, no DDL change.
```
Mutability: updated in place (U3); migrations may add keys. Retention: forever. Rows: ~13. `next_hook_id` is seeded in version 1 because `hook_event` is part of the version-1 DDL (an earlier draft said "added by the first migration that needs it", contradicting that). Read by: every function (`data_version` read INSIDE the page transaction and returned with the page, H9/H17: `BEGIN; SELECT value_int FROM meta WHERE key='data_version'; <page>; COMMIT` on one connection; no transaction is held across HTTP requests, H9/H19). `data_version` is a counter, not `max(ingest_batch.id)`, so pruning or a clear never lowers it (H17, H28); a clear raises it.

#### file
Purpose: one row per physical file (transcript, spill file, NDJSON tail source): identity, resume offset, generation. Writer: W-LIVE/W-BACK (U1), discovery in W-MAINT (insert, U2). Spill files are included (D-2).
```sql
CREATE TABLE file(
  file_id       INTEGER PRIMARY KEY,
  kind          VARCHAR NOT NULL,   -- transcript | spill | otel_ndjson | account_ndjson | codex | copilot
  path          VARCHAR NOT NULL,   -- current path (updated on a move)
  dev           UBIGINT NOT NULL,   -- fstat of the OPENED handle (H6), never a path stat
  inode         UBIGINT NOT NULL,
  codec         VARCHAR NOT NULL,   -- none | gzip (R1-D6: a sealed span day file is gzip; next_off/size_seen then count DECOMPRESSED bytes)
  head_fp       UBIGINT NOT NULL,   -- xxh3-64 of the first min(4096,size) bytes at gen start
  tail_fp       UBIGINT NOT NULL,   -- xxh3-64 of the 64 bytes before next_off (0 when next_off=0)
  gen           INTEGER NOT NULL,   -- generation; +1 when the file is replaced/rotated (D-DAT-1)
  next_off      BIGINT  NOT NULL,   -- byte offset of the first unread byte; always just after a '\n'
  size_seen     BIGINT  NOT NULL,   -- size at the last read (diagnostics, backfill progress)
  mtime_ms      BIGINT  NOT NULL,
  state         VARCHAR NOT NULL,   -- active | missing (deleted by Claude Code; rows are kept, H6)
  session_hint  VARCHAR,            -- spill files: see OPEN-O11
  first_seen_ms BIGINT  NOT NULL,   -- ingest clock, diagnostics
  last_batch_id BIGINT
);
```
Resume rule (D-DAT-1, H6): a file continues (same gen) only if `(dev,inode)`, `head_fp`, `tail_fp` and the byte at `next_off-1 == '\n'` all match and `size >= next_off`; otherwise it is a rotation: new gen with `next_off=0` (U2). The three identity cases that the row must make decidable are: same path with a new inode (replace-by-rename: a gen bump, H6 scenario 1), a known inode at a new path (a move), and a copy or relocation recognised only by fingerprint. R1-D5 names `(dev, inode)` as node identity with the path an updatable attribute; a later review found the lookup and the three cases under-specified (a replaced file has a NEW inode, so a lookup keyed on `(dev,inode)` alone would not find it), so the lookup order and which row keeps or rewrites `dev`/`inode` are OPEN-O25 pending revision 2. The columns above (`path`, `dev`, `inode`, `head_fp`, `tail_fp`, `gen`) are the minimum every candidate rule needs. The writer keeps an in-memory map rebuilt at boot by `SELECT` (28k rows; no index needed). Raw lines of an old gen are never deleted (D-10, R1-D4(b)); whether display rows of an old gen stay visible and whether the rollup is recomputed is OPEN-O4. Reading a gzip file supports no mid-stream seek: the reader decompresses and skips `next_off` bytes (R1-D6).
Mutability: U1/U2 only. Retention: forever (rows are tiny; 27.7k now, +~46k/yr, D-DAT-8). Rows/bytes: 27.7k, ~3 MB. Read by: backfill progress (`complete`/`backfill` block on aggregates, H18), `sql_body_writers` (K C30), `raw_*` macros.

#### file_ctx
Purpose: the parser's cross-line resume state, committed in the SAME transaction as the batch (D-9, H5): next turn, next idx, open `pending_reads`/`pending_tool_results`, open sub-agent records, rolling fast-mode flags, set-once values, last model, `seen_message_ids` including first rows without usage. Writer: W-LIVE/W-BACK.
```sql
CREATE TABLE file_ctx(
  file_id     INTEGER NOT NULL,
  gen         INTEGER NOT NULL,
  batch_id    BIGINT  NOT NULL,
  ctx_version INTEGER NOT NULL,  -- version of the Rust ctx layout
  ctx         BLOB    NOT NULL   -- Rust-serialised struct; OPEN-O15: BLOB vs JSON
);
```
Append-only, latest row per `(file_id, gen)` wins (`arg_max(ctx, batch_id)`); rows older than the latest 2 per file are deleted in W-MAINT (index-free table, D-ENG-2). Rows: <= 2 x 28k = 56k. Bytes: INFERRED and NOT bounded by this spec. Corrected arithmetic (an earlier draft claimed "<= ~300 MB worst case", which does not follow): the seen-id set of today's parser is capped at 4096 (H5, H25); at 8 B per hashed id that is 32 KB per ctx, so 56k rows x 32 KB = ~1.8 GB if every file held a full set; the realistic figure is far lower (T Q2 M300: 96,039 ids in 300 main files = ~320 ids per file, ~2.6 KB per ctx, ~150 MB for 56k rows, INFERRED). Each batch appends a new ctx row and the prune deletes the old ones, so the write volume is batches x ctx size even when the table stays small (freed blocks are reused, D-ENG-8). OPEN-O15 measures ctx bytes on the real corpus and decides the encoding and whether the id set is bounded by the 4096 cap (a CONTRACT-DELTA parity item) or stored unbounded. Read by: the writer's resume path only (no read function).

#### ingest_batch
Purpose: one row per committed transaction: the change-feed header and diagnostics (D-7, H11, H17, H28). Writer: every batch (kinds: `live backfill otel legacy import clear migrate seal`).
```sql
CREATE TABLE ingest_batch(
  batch_id     BIGINT  NOT NULL,   -- = meta.data_version after this batch's bump (U3)
  kind         VARCHAR NOT NULL,
  lane         VARCHAR NOT NULL,   -- live | backfill | maint
  epoch        BIGINT  NOT NULL,   -- clear_epoch the batch was read under (D-8; whether a stale-epoch batch is dropped depends on OPEN-O12)
  file_id      INTEGER,            -- NULL for non-file batches
  committed_ms BIGINT  NOT NULL,
  n_lines      INTEGER NOT NULL,
  n_bytes      BIGINT  NOT NULL,
  n_api_calls  INTEGER NOT NULL,
  n_errors     INTEGER NOT NULL
);
```
Append-only; pruned older than the horizon (OPEN-O22; proposal 30 days, never below the oldest connected SSE cursor). A clear inserts one row `kind='clear'` and never empties the table (H17). Rows: NOT estimated here - they depend on the batch policy that SPEC-writer-and-concurrency fixes (time-budgeted batches of ~50 ms, group commit for LIVE, H2). H28's bound is one batch per 50 ms under load = ~1.7M rows/day, ~52M over a 30-day horizon; an earlier draft's "0.1-0.3M rows, ~10 MB" rested on an unstated "few thousand batches a day" and is withdrawn. OPEN-O22 therefore also decides whether the horizon is in days or in rows. Read by: SSE frames `{v, since, boot_id, clear_epoch}` (H17), `sql_sidebar` (K C34), progress.

#### ingest_batch_root
Purpose: roots touched by a batch, so a lagging or reconnecting client can ask "what changed since v" (H11, D-5).
```sql
CREATE TABLE ingest_batch_root(batch_id BIGINT NOT NULL, root_nk INTEGER NOT NULL);
```
Append-only, same horizon as `ingest_batch`. Rows: ~2-3x `ingest_batch` (INFERRED), bounded by OPEN-O22. Read by: change-feed query `SELECT DISTINCT root_nk FROM ingest_batch_root WHERE batch_id > :since` (a gap beyond the horizon = "refetch everything visible", H11).

#### ingest_error (dead letters)
Purpose: a poison line is a visible defect, never a hang (H7). Policy: when a transaction fails twice, bisect to the offending line, insert here, advance past it in the same transaction, bump a counter exposed in `/api/server-stats`.
```sql
CREATE TABLE ingest_error(
  batch_id  BIGINT  NOT NULL,
  ts_ms     BIGINT  NOT NULL,
  file_id   INTEGER,
  gen       INTEGER,
  byte_off  BIGINT,
  kind      VARCHAR NOT NULL,   -- unparsable | invalid_utf8 | oversize | constraint | collision (call_key hash collision, U5) | other
  error     VARCHAR NOT NULL,
  line_head BLOB                -- first 64 KiB of the line (the full line is in the raw store)
);
```
Append-only, never deleted. The raw line of a poison line is still stored (raw is independent of parsing). Release gate on the real corpus: ZERO rows (H7); a nonzero `unparsable` count is a finding to review, not a pass (today such lines are silently skipped, H7). Read by: `/api/server-stats`, invariants I3 and I11.

### 4.2 Raw-line store (R1-D1 OPEN: backend P = Parquet parts, backend D = zstd column in DuckDB)

Contract common to both backends (it is what every reader and the writer rely on):
- Every `\n`-terminated line of every `file` is stored byte-exact, empty lines included (an empty line has `len = 1`), so that the lines of one `(file_id, gen)` tile `[0, next_off)` exactly (invariant I4). A trailing partial line (no newline yet) is never stored; `next_off` stays before it.
- `len` = bytes INCLUDING the terminating `\n`; the stored `line` is WITHOUT the newline, as BLOB (invalid UTF-8 is not mangled, CAP §3 Q17: a VARCHAR bind would store the escaped text, 4 raw bytes becoming 8 chars).
- Written in the batch transaction (or, for backend P, in the seal transaction) together with the derived rows and the `file.next_off` CAS (U1).
- Read through the view `v_raw_keys(file_id, gen, byte_off, len)` (keys only, used by the invariants) and the table macro `raw_lines(file_id, gen, from_off, to_off)` returning `(byte_off, len, line)` (4.7). Both are defined per backend from `meta.raw_backend`.
- Spill files (D-2, `file.kind='spill'`) use the same path. They are not line-structured (E5: a `.txt` or a binary `.jpg` up to 64 MiB, referenced only through a path embedded in the tool_result text), so for them a "line" is a fixed-size chunk and the newline tiling rule does not apply: OPEN-O24.

Measured sizes of the candidates (E1b, 1.02 GB sample, MEASURED per GB raw): C1 Parquet rg2048 via DuckDB `COPY` 0.128 GB; C2 Parquet rg512 via a non-DuckDB writer (the Rust `parquet` crate in the product) 0.138 GB; D1/D2 zstd VARCHAR/BLOB column 0.222-0.223 GB at 21.7-22.4 CPU-s/GB (E1: 0.227 and 19.8); plain VARCHAR/BLOB 1.7-1.96x raw (disqualified, CAP §3, E1). Point-read p95 (low-load rounds, cold): C1 9.3 ms, C2 4.6 ms, D1 11.0 ms, D2 8.4 ms; all pass the 50 ms gate. The RSS figures of E1/E1b include the Python/Arrow harness (E1 caveat; R1-D1: "Python-harness RSS gaps were noise"), so the 131 MB "read RSS" of C2 is NOT a Rust figure; the Rust bench decides (OPEN-O3).

#### Backend P: raw_stage, raw_part, raw_index and the Parquet parts

Design (R1-D1 C1/C2, CAP §3, E1/E1b): zstd Parquet parts, plus a DuckDB index `(file_id, gen, byte_off) -> (part_id, row_in_part)`; lines are staged in a DuckDB table until a part fills; reads union staging + parts. Crash protocol required by R1-D1: write the temp part, fsync it, rename it, fsync the directory, THEN commit the `raw_part` and `raw_index` rows and the staging delete in one transaction; startup reconciles `raw_part` against the files (below); parts are self-describing so the index can be rebuilt from parts alone; a row-group BYTE cap bounds writer memory (lines reach 4.4 MiB).

Lifecycle of a line: (1) the writer inserts it into `raw_stage` in the batch transaction; a committed line is never lost; (2) when staged bytes reach the part target, the WRITER thread reads the oldest staged lines in one maintenance step (one part's worth, bounded memory) and hands the bytes to a background-QoS sealer that compresses and writes `p<id>.parquet.tmp`, fsyncs it, renames it to `p<id>.parquet` and fsyncs the directory; the sealer never holds a DuckDB connection or transaction (H12: a background-QoS reader pins an MVCC snapshot while starved; an earlier draft had the background task read `raw_stage` itself); (3) the writer's seal transaction inserts the `raw_part` row, inserts the `raw_index` rows for those lines and deletes them from `raw_stage` (one transaction, so a line is always in exactly one of stage/index, invariant I6). For C1 the compress-and-write is a DuckDB `COPY (SELECT ... FROM raw_stage ...) TO` run by the writer connection instead of a Rust writer; the transaction rules are the same.
Startup reconcile of part files against `raw_part` (never deletes): a `raw_part` row whose file is missing is corruption (exit naming the part; snapshot recovery is OPEN-O26); a part file with no row whose lines are all still in `raw_stage` is the crash between rename and the seal transaction: it is MOVED to `<dataDir>/raw/orphan/` (RULE 0) and the lines are sealed again under a new part id; a part file with no row whose lines are NOT in stage or index (the database was restored from an older state) is ADOPTED: its `raw_part` and `raw_index` rows are rebuilt from the part's own columns and footer.

##### raw_stage
```sql
CREATE TABLE raw_stage(
  file_id  INTEGER NOT NULL,
  gen      INTEGER NOT NULL,
  byte_off BIGINT  NOT NULL,   -- offset of the first byte of the line
  len      INTEGER NOT NULL,   -- bytes INCLUDING the terminating '\n' (contiguity invariant I4)
  batch_id BIGINT  NOT NULL,
  line     BLOB    NOT NULL    -- bytes WITHOUT the newline, byte-exact
);
```
Append-only apart from the seal hand-off. Bounded: <= one part target + one batch (section 6). Stored uncompressed by the engine (1.7-1.96x, CAP §3, E1), hence the small target. Rows/bytes: <= ~22k lines (64 MiB / 3,096 B average line, CAP §3) / ~110 MiB on disk (64 MiB x 1.7). An earlier draft said "~15k lines", which does not match its own 64 MiB target and the 3.1 KB average. Read by: `raw_lines` macros (staging half of the union).

##### raw_part (the manifest)
The manifest is this table (single source of truth); the Parquet footer of each part additionally carries key-value metadata `{part_id, schema_ver, n_rows, rel_path, file_map}` where `file_map` lists `{file_id, gen, path, dev, inode, kind}` of the files whose lines the part holds, so the part alone identifies its lines and files (R1-D1: parts are self-describing; the per-row `file_id, gen, byte_off` columns are already in the part). No separate manifest file (one source of state).
```sql
CREATE TABLE raw_part(
  part_id        INTEGER NOT NULL,   -- from meta.next_part_id
  rel_path       VARCHAR NOT NULL,   -- relative to <dataDir>/raw/
  n_rows         INTEGER NOT NULL,
  raw_bytes      BIGINT  NOT NULL,   -- sum(len) of the lines in the part
  file_bytes     BIGINT  NOT NULL,
  sha256         VARCHAR NOT NULL,   -- hex; verified by the verifier script, not on every read
  zstd_level     INTEGER NOT NULL,   -- per part: changing the level later is data-compatible
  row_group_rows INTEGER NOT NULL,   -- 512 (C2) or 2048 (C1); see below
  created_ms     BIGINT  NOT NULL,
  batch_id       BIGINT  NOT NULL    -- the seal transaction
);
```
Append-only, never deleted (D-10, R1-D10: raw content is never deleted). Rows: ~300 parts for the corpus at a 64 MiB target (INFERRED: 18.7 GB / 64 MiB), tiny.

Part file layout:
- Directory `<dataDir>/raw/<part_id/1000 zero-padded to 4>/` (at most 1000 parts per directory); file name `p<part_id zero-padded to 8>.parquet` (so `raw/0000/p00000042.parquet`); temp name `p00000042.parquet.tmp` in the same directory (no new dot folders).
- Schema: `file_id INT32, gen INT32, byte_off INT64, line BYTE_ARRAY` with no UTF8 annotation (reads as BLOB: INFERRED; E1/E1b wrote VARCHAR-annotated columns and E1 only noted that Parquet VARCHAR accepted invalid bytes without validation, so byte-exact BLOB round trip is covered by test 12, not by a report). `len` is not stored in the part (it is in `raw_index`).
- Row order inside a part: sorted by `(file_id, gen, byte_off)`: adjacent lines of one session compress together and row-group min/max statistics prune.
- Row groups, backend C2 (Rust crate): 512 rows (D-1, E1b), and the writer also closes a group at 64 MiB buffered (OPEN-O3): CAP §2g measured that a large-line group OOMs at a 512 MB limit unless groups are small, and the corpus has 300 lines over 1 MB and a 4.4 MiB maximum (D-DAT-7, CAP §3), so a 512-row group could reach ~2 GB. Backend C1 (DuckDB `COPY`): E1b finding 1 measured that DuckDB cannot write groups smaller than 2048 rows, and a byte cap through `ROW_GROUP_SIZE_BYTES` was tried there and did not change the group size, so under C1 the worst-case group is ~9 GB of 4.4 MiB lines unless a measured setting bounds it: C1 needs its own memory test (OPEN-O3).
- Codec: zstd **level 3 with dictionary encoding OFF**, recorded in `raw_part.zstd_level`. E1b finding 2: the writer's default settings (dictionary on unique lines, low level) gave 0.207 GB/GB and only level 3 without dictionary gave the measured 0.138; the Rust `parquet` crate's defaults must therefore be overridden, not inherited (an earlier draft said "the level used by e1b (crate default)").
- Part target size: 64 MiB raw (proposal; bounds staging to ~110 MiB on disk; E1b measured ~72 MB parts). OPEN-O3.
- No line is truncated: corpus maximum 4.4 MiB (D-DAT-7). A pathological line above a hard cap (H7 proposes 256 MiB) is stored as head 1 MiB + an `ingest_error(kind='oversize')` row: cap value OPEN-O18.

Size: MEASURED 0.138 GB/GB for C2 (0.128 for C1). Corpus 18.72 GB (D-DAT-8) -> ~2.58 GB (C2); per year ~4.3 GB @avg rate, ~19.5 GB @recent rate; spill files add 4-7 GB/yr raw (E5, D-DAT-8) -> ~0.6-1.0 GB/yr only if the same ratio held (INFERRED: the 26 MB of `.jpg` spill is incompressible and spill text was not measured).

##### raw_index
```sql
CREATE TABLE raw_index(
  file_id     INTEGER NOT NULL,
  gen         INTEGER NOT NULL,
  byte_off    BIGINT  NOT NULL,
  len         INTEGER NOT NULL,   -- as raw_stage.len
  part_id     INTEGER NOT NULL,
  row_in_part INTEGER NOT NULL    -- 0-based; equals Parquet `file_row_number`
);
```
NO index (D-ENG-2: 6.3M keys, unbounded growth, and a bulk-touch loads the whole ART): lookups `WHERE file_id=? AND gen=? AND byte_off=?` are pruned by row-group zonemaps (each seal inserts its rows sorted by `(file_id,gen,byte_off)`; ~50 row groups per 6.3M rows at 122,880 rows per group). Point read of a line: `raw_stage` hit, else `raw_index` -> `read_parquet(<part path>, file_row_number=true) WHERE file_row_number = :row`. E1b measured the second step as a filter on `(file_id, byte_off)` over the part (p95 4.6 ms cold, C2), not on `file_row_number`; whether `file_row_number` pushdown prunes row groups is unverified: OPEN-O16. Range read of a file: `byte_off BETWEEN`. Append-only; never deleted. Rows: 6.30M (T, D-DAT-8) now, +10.5M/yr @avg, +47M/yr @recent; ~12 B/row -> ~76 MB (INFERRED; the raw column widths sum to 28 B before engine compression). Read by: every operation that needs content (K C12-C14, C17, C18, C25, C26: `raw_lines` and the `transcripts` view over it; Q29-Q31 presets use a glob over all parts in the heavy lane).

#### Backend D: raw_line
```sql
CREATE TABLE raw_line(
  file_id  INTEGER NOT NULL,
  gen      INTEGER NOT NULL,
  byte_off BIGINT  NOT NULL,
  len      INTEGER NOT NULL,   -- as raw_stage.len
  batch_id BIGINT  NOT NULL,
  line     BLOB    NOT NULL    -- byte-exact, zstd-compressed by the engine
);
```
Transactional with the derived rows (the line is written in the batch transaction itself): no staging, no seal step, no manifest, no part files, no crash protocol, no orphan reconcile. Requires `STORAGE_VERSION 'latest'` and `force_compression='zstd'` (section 1; E1b D1/D2: BLOB stored 0.223 vs VARCHAR 0.222 GB/GB, ZSTD segments confirmed, ~3-4x the CPU of C2). No index: point lookups rely on zonemaps because a batch holds one file's lines in offset order (E1: rows "inserted in file order"). Deletes clean (E1b: 3 delete-10%+checkpoint+reinsert cycles reused the freed blocks, +8-13% used blocks, file never shrank). Rows: as `raw_index` (6.30M now); bytes ~0.222 GB/GB -> ~4.2 GB for the corpus (E1b projection 4.2 GB), +6.9 GB/yr @avg, +31 GB/yr @recent (INFERRED from 0.222 x the growth factors of 6.1). The R1-D1 tie rule (equal RAM and CPU: prefer DuckDB-native, D or C1) applies only if the Rust bench ties them; E1b measured D at ~3-4x C2's CPU and 1.6x its disk.

### 4.3 Tree and node facts: node_key, node, node_meta, node_rollup, root_cache, spawn_edge, spawn_result

Design (D-5, H8, E4 variant C): immutable node facts + node_key + spawn_edge + spawn_result; parent/root/depth resolved by joins at read time (tree depth <= 3, T Q5/Q13, so two fixed LEFT JOINs, no recursive CTE); a small `root_cache` rebuilt per batch for touched roots (E4: lowest peak RSS 170 MB vs 224/240, all p95 < 25 ms, in a Python harness).

#### node_key
Purpose: identity -> `nk`. D-DAT-5: subagent session ids collide across parents (408), so the session id alone is never a key. R1-D5 sets node identity to `(dev, inode)` of the session file with the path an updatable attribute (a moved file keeps its node); D-DAT-5 had said "file path". The key kinds below carry both candidates; which key(s) a node holds and how a replaced file (new inode, same path) is mapped to the existing node is OPEN-O25 pending revision 2.
```sql
CREATE TABLE node_key(
  key_kind VARCHAR NOT NULL,   -- 'inode' ('<dev>:<inode>', R1-D5) | 'path' (D-DAT-5, first-seen path) | 'legacy' (card natural key = sessionId) | 'import'; the set in use is fixed by OPEN-O25
  key_text VARCHAR NOT NULL,
  nk       INTEGER NOT NULL,
  PRIMARY KEY (key_kind, key_text)
);
```
Writer: the writer thread allocates `nk` from `meta.next_nk` on the first line of a new file (W-LIVE/W-BACK), W-LEG (kind 'legacy'), W-IMP. Never updated or deleted; a node may have more than one key row (OPEN-O25). A directory move changes `file.path` but not this row (H6: same file, same node). ART bounded (3.1). Rows: ~33-40k, ~4 MB. Read by: writer (identity lookup, legacy adoption L §4), `node_visible` view.

#### node
```sql
CREATE TABLE node(
  nk                INTEGER PRIMARY KEY,
  seq               BIGINT  NOT NULL,   -- ingest order, allocated from meta.next_node_seq (NS-1 / K FND-01); pins "start desc then seq"
  kind              VARCHAR NOT NULL,   -- structural role: main | subagent | workflow_agent
  source            VARCHAR NOT NULL,   -- AGENT: claude_code | codex | copilot | opencode (agent filters Q1 agent/agentSources); never 'legacy' (R1-ORIGIN)
  origin            VARCHAR NOT NULL,   -- live | legacy | import (R1-ORIGIN)
  file_id           INTEGER,            -- the node's own file; NULL for legacy/import until adopted
  session_id        VARCHAR NOT NULL,   -- sessionId from the first line (else the file stem); NOT unique (D-DAT-5)
  agent_id          VARCHAR,            -- from the file name agent-<id> (D-DAT-5; links to spawn_result.agent_id)
  parent_session_id VARCHAR,            -- from the PATH: <sid>/subagents/[workflows/wf_<id>/]agent-*.jsonl (D-DAT-5 fixes the 3,137 workflow files); a string, never an nk (H8)
  created_ms        BIGINT,             -- first TIMESTAMPED line (D-DAT-6, H27); set once by U6, NULL until one is read
  first_seen_ms     BIGINT  NOT NULL    -- ingest clock, diagnostics
);
```
Immutable except U6 (created_ms once) and U7 (legacy adoption). R1-ORIGIN resolves what an earlier draft left as OPEN-O13: `node.source` keeps the agent, a separate `node.origin` says `live | legacy | import` (the earlier text used `transcript`, now `live`). `kind` is purely structural now: the earlier list also contained `legacy`, `import`, `codex`, `copilot`, `opencode`, which duplicated `origin` and `source` (the legacy spec L §2 is to be aligned to this, per R1-ORIGIN; a legacy sub-agent card carries its own structural kind). Nodes with `created_ms IS NULL` are not listed as sessions (D-DAT-6: today a node with no timestamp yields no card, H8 tail). Listing order is `(created_ms DESC, nk DESC)`: both immutable, so a row never moves between pages (D-5, H9, E4 cursor (i): 0 duplicates, 0 misses; late inserts appear as harmless phantoms); activity/token/cost orders are capped top-N, not paged. `journal.jsonl` and `*.orphaned-*.jsonl` produce no node (D-DAT-5). Read by: every list/detail function (`node_visible`, K C01-C05, C34). Rows/bytes: ~33-40k, ~4 MB. Legacy nodes: `origin='legacy'`, `file_id NULL`, `source` = the agent of the card (L §2 "agent lost" resolved without a view hack).

Not stored on `node` (decided against K §3): `account_id` (learned later: stamping at ingest leaves it NULL forever, H11) -> view `node_account` joins `account_map`; `conversation_id` (codex.rs:695) -> `node_meta` key `conversation_id`; `parent_nk`, `root_nk`, `path`, `depth` -> joins/`root_cache` (H8).

#### node_meta
Purpose: set-once and latest-wins text fields as append-only rows, read as `arg_min`/`arg_max` (H10, H26; keeps strings out of the hot rollup).
```sql
CREATE TABLE node_meta(
  nk       INTEGER NOT NULL,
  key      VARCHAR NOT NULL,   -- title | user_request | workspace | entrypoint | initiator | model | conversation_id | outcome
  value    VARCHAR NOT NULL,
  ts_ms    BIGINT,
  file_id  INTEGER NOT NULL,
  gen      INTEGER NOT NULL,
  byte_off BIGINT  NOT NULL,
  batch_id BIGINT  NOT NULL
);
```
Read rule per key (by `(gen, byte_off)` order within the node's file; across files `(ts_ms, file_id, byte_off)`): set-once = `arg_min` (user_request, workspace = first cwd, entrypoint = first, conversation_id); latest-wins = `arg_max` (title = last ai-title, model = last non-synthetic). `initiator` flips to `agent` only while `user_request` is still empty (H5 `:790-800`): the writer decides from `file_ctx` and appends a row only when the effective value changes (OPEN-O21 for the exact encoding). The writer appends a row only when the value changed relative to the ctx; T Q2 counted 4,977 ai-title rows in 558 files (~9 per file) but not how many carry a different title, so the growth is INFERRED and bounded above by ~9 title rows plus a few other keys per node. Rows: ~0.2-0.4M, ~20-40 MB. Read by: `sql_summary_sessions`, `sql_cards_*` (title, workspace, model), Q1 filters (K C01-C04).

#### node_rollup
Purpose: session totals (D-3: updated in place once per batch, no PK/ART, windowed top-N scans `api_call`; compute-at-read was rejected as linear in rows; E2: A_nopk 7.0 CPU-s per 1M rows ingested + 1k reads vs 23.2 for scanning `api_call`, RSS a tie of 346-381 MB in a Python harness). Numeric only (H10).
```sql
CREATE TABLE node_rollup(
  nk                    INTEGER NOT NULL,   -- exactly one row per node (invariant I9; no PK by D-3/D-ENG-2)
  n_api_calls           BIGINT  NOT NULL,
  n_turns               BIGINT  NOT NULL,   -- OPEN-O7b: parity of 'turns' vs 'totalLlmCalls' fixed by the FND-03 golden
  input_tokens          BIGINT  NOT NULL,
  output_tokens         BIGINT  NOT NULL,
  cache_read_tokens     BIGINT  NOT NULL,
  cache_create_tokens   BIGINT  NOT NULL,   -- as reported (5m+1h)
  cache_create_1h_tokens BIGINT NOT NULL,   -- sum over calls that carry the split
  n_calls_1h_known      BIGINT  NOT NULL,   -- calls that carry the split (348 of 11,904 rows lack it, T Q2)
  n_events              BIGINT  NOT NULL,
  n_tool_calls          BIGINT  NOT NULL,
  first_ts_ms           BIGINT,             -- min
  last_active_ms        BIGINT,             -- monotone max, clamped to min(ts, ingest wall ms + 5 min) (H20; resolves OPEN-O14)
  peak_context_per_turn BIGINT  NOT NULL    -- max
);
```
Additive (+) columns and monotone max/min only: distinct-file counts (`files*`) are not additive, so they are computed at read from `tool_use` for transcript nodes and served from `legacy_card` for legacy nodes (OPEN-O10). Cost is NOT stored: priced at `now` from the totals by the Rust pricing function (K FND-04, R decision 4). Legacy and imported nodes get their row from the card at import (L §2). Exact update: U4. Deltas follow R1-D4(d): they are computed from the rows the batch APPLIED. For `api_call` that is the applied-set table of U5: an inserted row credits its full usage to its node, an updated row credits `new - old` to the row's OWNING node (attribution is fixed at first insert), and a sibling-file or fork copy that wins no guard (D-DAT-3/D-DAT-4: the same message already attributed to another `nk`) credits nothing. A change of generation (OPEN-O4: R1-D4(b) proposes recomputing the node's rollup from current-gen rows, a later review proposes that `api_call` totals are never gen-filtered) does not alter this table's shape; only the recompute statement, which is not in the U-allowlist until O4 is settled. The clamp: a line stamped far in the future must not pin a session on top under max semantics (H9, H20); the raw `ts_ms` stays on the leaf rows with `ts_suspect=true` (H20). Rows: ~33-40k, ~6 MB (hot rows rewritten at each checkpoint: measure bytes per checkpoint, H10). Read by: all list/aggregate functions (`sql_summary_sessions`, `sql_cards_page`, Q1/Q2/Q4/Q10/Q11; burn/window functions use `api_call` instead).

#### root_cache
Purpose: `nk -> root_nk, depth`, rebuilt (delete + insert) per batch for the touched nodes only (D-5); makes root listing and `ingest_batch_root` cheap.
```sql
CREATE TABLE root_cache(nk INTEGER NOT NULL, root_nk INTEGER NOT NULL, depth TINYINT NOT NULL, batch_id BIGINT NOT NULL);
```
Derivation (read-time semantics; the cache is a copy): `root = coalesce(gp.nk, p.nk, n.nk)` from two LEFT JOINs on `node.session_id = node.parent_session_id` restricted to `kind='main'` (main session ids are unique: 4,502 stems, none duplicated, T Q14). Unresolvable parent -> the node is its own root with a badge (H8). DERIVED, no index (~40k rows scan). Rows ~40k, ~1 MB. Read by: `sql_cards_page`, `sql_cards_children`, change feed.

#### spawn_edge and spawn_result
Purpose: the spawn taxonomy from the parent's Task/Agent/Workflow `tool_use` and its completion from the later `tool_result`, as two append-only rows linked by join (H8 "no UPDATE"; T Q5). A result row is written only when the user line holds exactly one tool_result block (H24: multi-result lines must not populate `spawn_result`).
```sql
CREATE TABLE spawn_edge(
  file_id INTEGER NOT NULL, gen INTEGER NOT NULL, byte_off BIGINT NOT NULL, sub_index SMALLINT NOT NULL,
  parent_nk      INTEGER NOT NULL,
  tool_use_id    VARCHAR NOT NULL,
  spawn_turn     INTEGER,
  spawn_ts_ms    BIGINT,
  kind           VARCHAR NOT NULL,   -- task | agent | workflow
  subagent_type  VARCHAR,
  model_override VARCHAR,
  isolation      VARCHAR,
  batch_id       BIGINT NOT NULL
);
CREATE TABLE spawn_result(
  file_id INTEGER NOT NULL, gen INTEGER NOT NULL, byte_off BIGINT NOT NULL, sub_index SMALLINT NOT NULL,
  parent_nk       INTEGER NOT NULL,
  tool_use_id     VARCHAR NOT NULL,
  agent_id        VARCHAR,           -- toolUseResult.agentId (matches node.agent_id)
  status          VARCHAR,           -- e.g. async_launched | completed
  is_async        BOOLEAN,
  usage_input BIGINT, usage_output BIGINT, usage_cache_read BIGINT, usage_cache_create BIGINT,
  tool_use_count  BIGINT,
  duration_ms     BIGINT,
  batch_id        BIGINT NOT NULL
);
```
Link (view `v_spawn_link`): `spawn_edge e JOIN spawn_result r USING (parent_nk, tool_use_id)` (latest `r` by `(batch_id, byte_off)` when `async_launched` is followed by a completion), child node by `node.agent_id = r.agent_id`, with the `link_pair_ok` predicates (parent equality; transcript-has-traffic condition read from live `node_rollup`, `feed_merge.rs:171-190`) written as SQL (H8, K FND-06). A placeholder edge with no `agent_id` yet is yielded as a child with `agent_id` NULL; the `<parent>-sub-<tool_use_id>` placeholder is a pure edge row with no node (H8). No index: ~25-50k rows each. Rows/bytes: spawn_edge ~23-25k (23.2k subagent files, T Q5), spawn_result ~25-50k, ~5 MB total (INFERRED). Read by: `sql_sub_agent_children`, `sql_spawn_rollup`, `sql_cards_children` (K C02, C05).

### 4.4 Line content: event, api_call, tool_use, tool_result

All four are written in the same batch transaction as the lines' raw-store rows and the `file.next_off` CAS.

#### event
Purpose: per-line display rows, deliberately NOT deduplicated across files: sibling subagent files legitimately show the same rows (D-DAT-3). Idempotency = the offset CAS (R1-D4(a)), not a key; I17 detects a duplicate line key.
```sql
CREATE TABLE event(
  file_id INTEGER NOT NULL, gen INTEGER NOT NULL, byte_off BIGINT NOT NULL, sub_index SMALLINT NOT NULL,
  nk         INTEGER NOT NULL,
  batch_id   BIGINT  NOT NULL,
  ts_ms      BIGINT,                 -- UTC ms parsed from 'YYYY-MM-DDTHH:MM:SS.mmmZ' (D-DAT-7, T Q12); NULL for untimestamped metadata types
  ts_suspect BOOLEAN,                -- true when ts_ms is beyond ingest wall ms + 5 min (H20); the raw value is kept
  type       VARCHAR NOT NULL,       -- open string: new types appear every release (H7)
  subtype    VARCHAR,                -- system subtypes (compact_boundary, turn_duration, ...)
  turn       INTEGER,                -- per-turn ordinal (Q7 growth); K FND-03
  is_sidechain BOOLEAN,
  is_meta    BOOLEAN,
  call_key   HUGEINT,                -- link to api_call for assistant rows (same hash as api_call.call_key)
  len        INTEGER NOT NULL,       -- line bytes (display sizes)
  compaction_trigger     VARCHAR,    -- compact_boundary (T Q4)
  compaction_pre_tokens  BIGINT,
  compaction_post_tokens BIGINT
);
```
Covers lines of type user/assistant/system/attachment (73.9% of lines carry a uuid, T Q15); metadata types (mode, last-prompt, ai-title, ...) feed `node_meta`/rollup only, and their raw line is in the raw store. No `uuid` column: parent chains are not modeled (cost counting must not dedupe by chain, T Q3). No display text column: content is read from the raw store at page time (OPEN-O5; a `text_head` column is the fallback if the bench shows point reads too slow for a 200-event page). Mutability: append-only. Retention: forever (index never shrinks, D-ENG-8; append-only design). Visibility of rows of an old generation: OPEN-O4. Rows: ~4.66M (74% of 6.30M, INFERRED), ~40 B -> ~190 MB. Read by: `sql_session_timeline`, `sql_turn_growth`, `sql_conversation`, `sql_last_request_per_node`, compaction readers (K C03, C05, C11, C14).

#### api_call
Purpose: one row per API message, deduplicated GLOBALLY by `(source, message_id)` (R1-D4(c); D-DAT-3: sibling subagent files share identical rows; D-DAT-4: fork copies count once, attributed to the first-ingested session - documented delta). Which row of a message wins when usage grows (D-DAT-2: output grows across rows in subagent files; today's parser takes the first row, a bug fixed by D-12) is OPEN-O6: R1-D4(c) lets only a later row of the SAME file update, a later review proposes the largest-usage row wins. Either way the owner `nk` never changes.
```sql
CREATE TABLE api_call(
  call_key        HUGEINT PRIMARY KEY,  -- 128-bit hash of (source, message.id text); D-4/R1-D4-ART: mechanism OPEN-O20 (E6); the columns below are identical under every candidate
  source          VARCHAR NOT NULL,     -- agent source (R1-D4(c)): claude_code | codex | copilot | opencode (non-Claude mapping: OPEN-O23)
  message_id_text VARCHAR NOT NULL,     -- original 'msg_...' id (display, joins from OTEL, collision check U5/I3)
  nk              INTEGER NOT NULL,     -- FIRST-ingested node; never changes on a later row
  file_id INTEGER NOT NULL, gen INTEGER NOT NULL, byte_off BIGINT NOT NULL, sub_index SMALLINT NOT NULL,  -- line key of the WINNING row
  batch_id        BIGINT  NOT NULL,
  ts_ms           BIGINT  NOT NULL,
  ts_suspect      BOOLEAN,              -- as event.ts_suspect (H20)
  request_id      VARCHAR,              -- transcript requestId on ~half of assistant rows (D-DAT-10: 6,075 of 11,904, T Q2); join key to OTEL api_request
  model           VARCHAR,
  turn            INTEGER,
  speed           VARCHAR,              -- 'fast' | 'standard' | NULL (usage.speed; K FND-03, speedBlendedCostUsd)
  service_tier    VARCHAR,
  effort          VARCHAR,
  is_sidechain    BOOLEAN,
  is_api_error    BOOLEAN,
  input_tokens         BIGINT NOT NULL, -- as reported: EXCLUDES cache (K R decision 1: both conventions exposed by view v_api_call)
  output_tokens        BIGINT NOT NULL,
  cache_read_tokens    BIGINT NOT NULL,
  cache_create_tokens  BIGINT NOT NULL, -- as reported = 5m + 1h
  cache_create_5m      BIGINT,          -- usage.cache_creation.ephemeral_5m_input_tokens
  cache_create_1h      BIGINT,          -- NULLABLE: 348 of 11,904 sampled rows (2.9%) carry usage without the tier split (T Q2); NULL never means 0 (rollup keeps n_calls_1h_known)
  cache_break_cause    VARCHAR          -- OPEN-O7: cause columns for Q38-Q40/C07 (grouping by cause) are not specified in the sources read here
);
```
The `seq` column of the earlier draft (line `ts_ms`, ties larger `output_tokens`) is dropped: the winning row's line key `(file_id, gen, byte_off)` orders rows of one file (H6) and `output_tokens` serves the largest-usage candidate, so neither OPEN-O6 candidate needs a stored sequence. The key column was `message_id`; it is `call_key` (and `source` joined the key) per R1-D4(c), and the same rename applies to `event`, `tool_use`, `call_block`.

Uniqueness mechanism (R1-D4-ART, OPEN-O20, experiment E6): the schema must support three candidates with the SAME columns: (A, the DDL above) `PRIMARY KEY (call_key)` plus U5; (B) no PK, with U5 run as an anti-join/guarded update restricted to `ts_ms` (duplicates of one message share the exact timestamp, so zonemaps prune), the table kept in `ts_ms` order; (C) a key-only table per month (`api_key_<YYYYMM>(call_key HUGEINT PRIMARY KEY)`, created lazily by W-MAINT, so a single ART stays small) and U5 probing the month of `ts_ms`. Only the constraint line and the probe in U5 differ; E6 measures resident memory at 1M/5M/20M keys, whether CHECKPOINT releases ART memory or only a reopen does, and insert CPU, and the choice is frozen before schema version 1 ships. Both bucket conventions are exposed by the view `v_api_call` (4.7): `input_tokens` (cache-exclusive) and `input_incl_cache = input + cache_read + cache_create` (history `usage.input` is cache-INCLUSIVE, K C13), so no stored duplicate.

Upsert: U5 (in-batch collapse first, applied-set capture, then the upsert). Rows whose first row has no usage: parity with today's `seen_message_ids` (a first row without usage marks the id seen, a later usage row ignored, H5/H23) lives in `file_ctx`, not in this table. Mutability: key never updated. Retention: forever. Rows: ~1.0-1.1M (D-4 "~1M keys"; cross-check 1.33M assistant rows x 1/1.2 rows per id, T Q2: 114,862 rows / 96,039 ids = 1.196), ~110 B -> ~110 MB (INFERRED); the PK ART is the one bounded index (3.1). Read by: window/burn/forensics functions (`sql_burn_events`, `sql_cache_creation_groups`, `sql_expensive_writes`, `sql_session_burn_profile`, `sql_cache_event_log`, `sql_cost_by_cause`, `sql_billed_usage_by_hour_model`; K C07-C11, C22-C26), the windowed top-N scans (D-3), the rollup invariant I1. Day buckets are computed in Rust from a tz parameter and passed as boundaries (D-14).

#### tool_use
```sql
CREATE TABLE tool_use(
  file_id INTEGER NOT NULL, gen INTEGER NOT NULL, byte_off BIGINT NOT NULL, sub_index SMALLINT NOT NULL,
  nk INTEGER NOT NULL, batch_id BIGINT NOT NULL, ts_ms BIGINT,
  tool_use_id VARCHAR NOT NULL,
  tool_name   VARCHAR NOT NULL,
  turn        INTEGER,
  call_key    HUGEINT,           -- owning api_call
  op_kind     VARCHAR,           -- read | write | edit | search | shell | spawn | other (files* classification)
  file_path   VARCHAR,           -- for read/write/edit/search ops (distinct-file counts at read, OPEN-O10)
  input_bytes BIGINT,
  is_spawn    BOOLEAN,
  files_changed_note VARCHAR     -- claude.rs:716 (K FND-03)
);
```
No index; matched to results by `(nk, tool_use_id)` hash join at read (H5: a result can arrive any distance later; async Agent launches complete later, T Q2: results seen up to 21 lines away, the unbounded case INFERRED). Not deduplicated across files (D-DAT-3). Rows ~0.73M (INFERRED: tool_result ratio 11.5% of lines, T Q2 first-200: 6,084 of 52,727), ~60 B -> ~44 MB. Read by: `sql_session_pool` (Q1/Q2 tool counts), `sql_instruction_inputs`, file ops in `sql_session_timeline`, `sql_cache_risk_commands` (also needs raw), `sql_spawn_rollup`.

#### tool_result
```sql
CREATE TABLE tool_result(
  file_id INTEGER NOT NULL, gen INTEGER NOT NULL, byte_off BIGINT NOT NULL, sub_index SMALLINT NOT NULL,
  nk INTEGER NOT NULL, batch_id BIGINT NOT NULL, ts_ms BIGINT,
  tool_use_id  VARCHAR NOT NULL,
  is_error     BOOLEAN,
  result_bytes BIGINT,           -- read bytes joined to tool_use.file_path (replaces pending_reads, H5)
  spill_file_id INTEGER,         -- file.file_id of the copied tool-results/ spill file (D-2); the link is parsed from the path embedded in the result text (E5); OPEN-O11
  agent_id     VARCHAR,          -- toolUseResult.agentId (T Q5)
  status       VARCHAR
);
```
Rows ~0.73M, ~40 B -> ~29 MB (INFERRED). Read by the same functions as `tool_use`.

### 4.5 OTEL, accounts, hooks, collector, call bodies

#### otel_span (SIDE)
Purpose: OTLP spans. D-6/R1-D6: the existing span NDJSON stays the write-ahead log (the OTLP handler acks BEFORE the <= 5 s flush today (A4); up to 5 s of spans can be lost on SIGKILL, unchanged here, owned by card S1); the DuckDB writer tails it as a `file` row (`kind='otel_ndjson'`) with its own offset. The tailer offset GATES sealing: a day file is gzipped only when `next_off == size`, gzip reads are supported (`file.codec`), and neither retention nor a clear removes a day file the tailer has not finished. R1-D6 makes `(trace_id, span_id)` unique: it replaces the earlier text "no key: it would be an unbounded ART", which R1-D6 corrects; the bound is the 30-day retention, whose size and delete behaviour are OPEN-O27.
```sql
CREATE TABLE otel_span(
  file_id INTEGER NOT NULL, gen INTEGER NOT NULL, byte_off BIGINT NOT NULL,   -- NDJSON line key
  batch_id    BIGINT NOT NULL,
  trace_id    VARCHAR NOT NULL,
  span_id     VARCHAR NOT NULL,
  parent_span_id VARCHAR,
  name        VARCHAR NOT NULL,
  start_ms    BIGINT,
  end_ms      BIGINT,
  received_ms BIGINT NOT NULL,   -- ingest stamp (K FND-05; today's `receivedAt`); retention and `isActive` use it (H15 point 2)
  session_id  VARCHAR,           -- promoted from the span/resource attributes
  status_code VARCHAR,
  service     VARCHAR,
  PRIMARY KEY (trace_id, span_id)
);
```
Idempotent insert: staged then `INSERT ... ON CONFLICT DO NOTHING` (first row wins, D-ENG-3; a collector retry is the same span, whether today's store keeps the first or the last duplicate is unverified: OPEN-O8). The offset CAS still resumes the tail. Retention: 30 days by `received_ms` (today's behaviour, H15/H16), in bounded chunks (e.g. one hour of `received_ms` per transaction) on the LIVE lane; because the table is now indexed, whether a chunked delete stays cheap on the ART is part of OPEN-O27 (CAP §5 measured the whole-index load only for a 1.5M-key delete). Rows/bytes: not in any source read here: OPEN-O8 (measure the span NDJSON line count and bytes before freeze). Read by: the log-vs-OTEL merge function (K FND-06), `sql_summary_sessions` (`efficiency`/`backgroundSpans`), `sql_heartbeat_fires`, `sql_cache_event_log`, `sql_codex_trace_ids`. `/action clearAll` touches only this table family (OPEN-O12).

#### otel_span_attr (SIDE)
Purpose: full attribute values (NS-8) and the `gen_ai.output.messages` overlay, as append-only rows, latest per `(trace_id, span_id, key)` wins at read; removes today's 500-entry overlay cap and works when the overlay arrives before its span (H15 point 1).
```sql
CREATE TABLE otel_span_attr(
  file_id INTEGER NOT NULL, gen INTEGER NOT NULL, byte_off BIGINT NOT NULL,
  batch_id    BIGINT  NOT NULL,
  trace_id    VARCHAR NOT NULL,
  span_id     VARCHAR NOT NULL,
  key         VARCHAR NOT NULL,
  value       VARCHAR,            -- full value, never truncated (NS-8)
  value_type  VARCHAR NOT NULL,   -- string | int | double | bool | json
  received_ms BIGINT  NOT NULL
);
```
Same retention as `otel_span`; index-free (an overlay row may precede its span, so it cannot reference the span's key). Rows/bytes: OPEN-O8. Read by: `sql_span_attr(traceId,spanId,key)` (K C33), `sql_summary_sessions`, `sql_call_context`.

#### account_map (SIDE)
Purpose: session -> account, from OTLP log events, read by join at read time (H11: stamping at card build time leaves NULL forever when the account is learned later).
```sql
CREATE TABLE account_map(
  session_id   VARCHAR NOT NULL,
  account_uuid VARCHAR NOT NULL,
  ts_ms        BIGINT  NOT NULL,
  batch_id     BIGINT  NOT NULL
);
```
Append-only; a row only when the mapping for a session changes or first appears (latest by `ts_ms` wins). Rows ~40k, ~3 MB (INFERRED: <= nodes). Read by: view `node_account`, `sql_window_events(account, window)`, account functions (K C08-C11). Writer: W-ACCT.

#### account_state (SIDE; NS-4)
Purpose: account/plan/TTL-regime/capacity facts replacing `account-state.ndjson` and the in-RAM `AccountRegistry` (K FND-09). Column set is the minimum from K §3; FND-09 may extend it by migration: OPEN-O17.
```sql
CREATE TABLE account_state(
  ts_ms        BIGINT  NOT NULL,
  account_uuid VARCHAR NOT NULL,
  label        VARCHAR,
  plan         VARCHAR,
  usage_credits_enabled BOOLEAN,  -- live TTL-regime oracle: credits off = 1h TTL (project doctrine)
  ttl_regime   VARCHAR,           -- '1h' | '5m'
  capacity_5h  BIGINT,
  capacity_7d  BIGINT,
  five_hour_used_pct DOUBLE,      -- < 1e16 (D-ENG-10)
  seven_day_used_pct DOUBLE,
  source       VARCHAR NOT NULL,
  batch_id     BIGINT  NOT NULL
);
```
Append-only, latest per account by `ts_ms` (`account_state_at(ts)` = last row <= ts, K C10). Rows ~ <10k/yr (INFERRED), < 1 MB. Keychain/OAuth reads (Q53) stay outside DuckDB (secrets, K §3). Writer: W-ACCT.

#### call_block (SIDE; NS-2)
Purpose: API request/response bodies decomposed into blocks (K FND-07, replaces `CallBodyRegistry`/forensics.db tables `call_content`, `call_injections`); the body archive volumes themselves stay outside (K C37).
```sql
CREATE TABLE call_block(
  batch_id    BIGINT NOT NULL,
  request_id  VARCHAR,           -- links to api_call.request_id / OTEL api_request
  call_key    HUGEINT,           -- api_call.call_key when known
  nk          INTEGER,           -- NULL until the session is resolved
  session_id  VARCHAR,
  turn        INTEGER,
  section     VARCHAR NOT NULL,  -- system | tools | messages | response
  block_idx   INTEGER NOT NULL,
  kind        VARCHAR NOT NULL,  -- text | tool_use | tool_result | image | thinking | tool_schema | ...
  label       VARCHAR,
  role        VARCHAR,
  tokens      BIGINT,
  bytes       BIGINT,
  text_hash   UBIGINT,           -- xxh3-64 of text; identical blocks repeat on every turn (dedup is OPEN)
  text        VARCHAR,           -- full text; images never carry bytes (K C20 "image-never-ships-bytes")
  captured_ms BIGINT NOT NULL
);
```
Volume and retention cannot be estimated from the sources (a request body is ~220k tokens, 226,910 measured by ctxmap per the project CLAUDE.md; only captured bodies are stored, not all 1.0M calls): OPEN-O8. Proposal pending measurement: store each distinct `text` once keyed by `text_hash` (a `block_text` side table) and keep `call_block` as references. Not part of the corpus size estimate. Read by: `sql_call_context`, `sql_composition_summary`, `sql_block_content`, `sql_scope_pool`, forensics views (K C19-C26). Writer: the body-capture path of W-OTLP/W-HOOK.

#### hook_event (SIDE; NS-3)
Purpose: lifecycle-hook events replacing the in-RAM ring (K FND-08).
```sql
CREATE TABLE hook_event(
  hook_id     BIGINT  NOT NULL,   -- from meta.next_hook_id (seeded in version 1)
  ts_ms       BIGINT  NOT NULL,
  received_ms BIGINT  NOT NULL,
  session_id  VARCHAR,
  event       VARCHAR NOT NULL,   -- hook_event_name
  tool_name   VARCHAR,
  cwd         VARCHAR,
  payload     JSON    NOT NULL,   -- full payload; needs the json feature (D-ENG-1)
  batch_id    BIGINT  NOT NULL
);
```
Retention and ring size of today's store were not read: OPEN-O8 (proposal: 30 days by `received_ms`, bounded-chunk delete). Read by: `sql_hook_events`, `sql_lifecycle_events`, burn-risk gate inputs (K C09, C26, C27). Writer: W-HOOK. StopFailure calibration is a reader query, not a writer (H16).

#### collector_run (SIDE; NS-9)
```sql
CREATE TABLE collector_run(
  run_id        BIGINT  NOT NULL,   -- meta.next_run_id
  boot_id       VARCHAR NOT NULL,   -- random per process; carried in SSE frames (H17)
  started_ms    BIGINT  NOT NULL,
  last_seen_ms  BIGINT  NOT NULL,   -- U8: heartbeat every 5 s
  stopped_clean BOOLEAN NOT NULL,   -- true only after the shutdown CHECKPOINT
  pid           BIGINT,
  version       VARCHAR
);
```
A gap = `started_ms(run n+1) - last_seen_ms(run n) >= 15 s` (K C36 rule); not derivable from `otel_span.received_ms` gaps (K NS-9). Rows ~ boots (< 1k/yr), negligible. Read by: `sql_collector_gaps()`. Writer: W-MAINT.

### 4.6 Legacy import: legacy_card, legacy_import_run (L §2-§3)

```sql
CREATE TABLE legacy_card(
  natural_key    VARCHAR PRIMARY KEY,   -- NDJSON `k` = sessionId; ON CONFLICT DO NOTHING (L §3: frozen history is never overwritten)
  nk             INTEGER NOT NULL,      -- the node row (origin='legacy'), allocated on the writer thread
  card           JSON    NOT NULL,      -- the verbatim NDJSON `v`
  imported_ms    BIGINT  NOT NULL,
  origin_sha     VARCHAR NOT NULL,      -- 'snapshot:<sha256>+delta:<sha256>' of the FROZEN copy (L §1.1, §7)
  run_id         BIGINT  NOT NULL,
  partial        BOOLEAN NOT NULL DEFAULT false,   -- L §1.3
  deficit_calls  BIGINT,
  twin_nk        INTEGER,                          -- L §1.2: agent-<id> orphan with a surviving bare17 twin
  shadowed_ms    BIGINT,                           -- set when a transcript for the key appears (L §4); the row is HIDDEN, not deleted
  shadowed_by_nk INTEGER
);
CREATE TABLE legacy_import_run(
  run_id BIGINT NOT NULL, source_snapshot_sha256 VARCHAR NOT NULL, source_delta_sha256 VARCHAR NOT NULL,
  started_ms BIGINT NOT NULL, finished_ms BIGINT, cards_seen BIGINT, orphans_imported BIGINT,
  skipped_existing BIGINT, status VARCHAR NOT NULL
);
```
Writer: W-LEG in bounded batches (a few hundred rows per transaction, one `legacy_import_run` row opened before and closed after, L §3); mutability: U7 only (`partial`, `deficit_calls`, `twin_nk`, `shadowed_*`); a close of `legacy_import_run` is covered by U8 (tiny, non-indexed). Never deleted by retention, `/api/clear` or `clearAll` (L §6, D-9/D-10; every statement touching `node` carries `WHERE origin <> 'legacy'`). Rows/bytes: D-DAT-9 counts 5,742 orphan cards (14%), 10.4 MiB (L §1.3/§5: 10,943,984 bytes of card JSON, MEASURED) -> ~11-12 MB; R1-DAT9: the count may be skewed by colliding stems and moved files, so the import applies its own exact rule and reports its own count (`legacy_import_run.orphans_imported`), and 5,742 is a planning figure, not a constraint; one-off, no growth beyond re-runs on new keys (<= 40,979 total, L §1.1). The frozen NDJSON snapshot and delta (L §7) are already the immutable export of these cards that R1-ENG6 asks for. Read by: view `node_visible`, `legacy` flavours of H32a-d, H2, H39 (`timeline: []` + `timelineTruncatedCount`), Q1/Q4/Q10 (K C01-C04, L §2.1). Legacy nodes also get a `node_rollup` row filled from the card (L §2).

### 4.7 Views and macros (re-created at every open, section 2)

| name | definition (summary) | used by |
|---|---|---|
| `node_visible` | `node` minus legacy nodes whose `legacy_card.shadowed_ms IS NOT NULL` (L §2.1: every read function reads this, never `node`); the clear-visibility predicate of OPEN-O12 is added here when decided, so no function repeats it | all list/detail functions |
| `node_account` | `node` LEFT JOIN latest `account_map` per `session_id` | account functions |
| `v_api_call` | `api_call` + `input_incl_cache = input_tokens + cache_read_tokens + cache_create_tokens` and the 5m/1h tier view; both bucket conventions (K R decision 1) | burn/forensics/context-history |
| `v_spawn_link` | `spawn_edge` JOIN latest `spawn_result` JOIN child `node`, with `link_pair_ok` (H8) | tree functions |
| `v_raw_keys` | backend P: `SELECT file_id, gen, byte_off, len FROM raw_index UNION ALL SELECT ... FROM raw_stage`; backend D: the same four columns of `raw_line` | invariants I4-I6, I16; startup census |
| macro `raw_lines(file_id, gen, from_off, to_off)` | backend P: `raw_stage` UNION ALL (`raw_index` JOIN parts via `read_parquet(..., file_row_number=true)`); backend D: `raw_line`; both ordered by `byte_off`, returning `(byte_off, len, line)` | content functions, `transcripts` view (K C18) |
| macros `sql_*` | the operation-catalog functions (K §2.2), prepared with `?` parameters (CAP §2d works with persisted macros) | HTTP/MCP wrappers (D: the server is a thin wrapper over SQL functions) |

An "archived-lines" view (R1-D4(b): pruned lines stay viewable) and any `gen`-filtered display views are NOT defined until OPEN-O4 is settled.

## 5. Retention summary

| table | retention | mechanism |
|---|---|---|
| raw store (`raw_part`, `raw_index`, `raw_stage` after seal / `raw_line`), legacy_*, ingest_error, file, node*, event, api_call, tool_*, spawn_*, account_*, node_meta, node_rollup | forever | append-only (D-ENG-8: DuckDB never shrinks; design is append-only so that is acceptable); raw content never deleted (D-10, R1-D10) |
| file_ctx | latest 2 per file | prune delete (W-MAINT) |
| ingest_batch, ingest_batch_root | horizon (OPEN-O22; proposal 30 days) | prune delete; `meta.data_version` unaffected (H28) |
| root_cache | rebuilt per batch | delete + insert of touched `nk` |
| otel_span, otel_span_attr | 30 days by `received_ms` (R1-D6) | bounded-chunk delete on LIVE lane (H16; OPEN-O27 for the indexed `otel_span`); an NDJSON day file the tailer has not finished (`next_off < size`) is never retired |
| hook_event, call_block | OPEN-O8 | |
| collector_run | forever | tiny |

## 6. Size and memory budget

### 6.1 Corpus and growth inputs

18.72 GB, 6,302,007 lines, 27,723 files, 218 days old (CAP §3, T header, D-DAT-8). Growth: 0.086 GB/day average over the corpus age (= ~31 GB/yr, factor 1.67 of the corpus), 0.3-0.7 GB/day recently with 11.6 GB in the last 30 days (T Q11, attributed by mtime, which overstates the day of a long file; = ~141 GB/yr, factor 7.5). "@avg" and "@recent" below use those two factors; the truth lies between and must be re-measured at cutover.

### 6.2 Row and byte estimates (INFERRED unless stated; replace with bench numbers from SPEC-method-bench)

| table | rows now | rows/yr @avg | rows/yr @recent | assumed B/row | bytes now | basis |
|---|---|---|---|---|---|---|
| raw parts (backend P, C2) | 6.30M lines | 10.5M | 47M | MEASURED 0.138 GB/GB | 2.58 GB (C1 0.128: 2.40 GB) | E1b |
| raw_line (backend D) | 6.30M | 10.5M | 47M | MEASURED 0.222 GB/GB | 4.16 GB | E1b |
| raw_index (P only) | 6.30M | 10.5M | 47M | 12 | ~76 MB | T/D-DAT-8 |
| raw_stage (P only, transient) | <= ~22k | - | - | ~5.3 KB on disk (3.1 KB x 1.7) | <= ~110 MB | 64 MiB target, CAP §3 |
| event | ~4.66M | 7.8M | 35M | 40 | ~190 MB | 74% of lines (T Q15) |
| api_call | ~1.0M | 1.7M | 7.5M | 110 | ~110 MB | D-4 |
| tool_use | ~0.73M | 1.2M | 5.5M | 60 | ~44 MB | T Q2 first-200 ratio |
| tool_result | ~0.73M | 1.2M | 5.5M | 40 | ~29 MB | same |
| node_meta | ~0.2-0.4M | 0.3M | 1.5M | 100 | ~20-40 MB | section 4.3 |
| node, node_key, node_rollup, root_cache, spawn_*, legacy_* | ~33-40k nodes (+46k/yr) | | | | ~30 MB (legacy JSON 11 MB MEASURED) | T Q5, L §5 |
| file, meta | 27.7k files | | | | ~3 MB | section 4.1 |
| file_ctx, ingest_batch(+root) | | | | | NOT estimated (OPEN-O15, OPEN-O22) | corrected in 4.1 |
| otel_*, call_block, hook_event | OPEN-O8 | | | | not estimated | |
| ART indexes (persisted) | | | | | ~25-48 MB | 3.1 |
| **index.duckdb steady state, backend P** | | | | | **~0.55-0.67 GB (incl. staging) before ctx, change-feed and otel/body tables** | sum |
| **index.duckdb steady state, backend D** | | | | | **~4.7 GB (raw_line 4.16 GB + the same derived tables)** | sum |

Disk total for the corpus, backend P: ~2.6 GB Parquet + ~0.6 GB index (vs 18.7 GB source). Per year, Parquet +4.3 GB @avg / +19.5 GB @recent; index +0.78 GB @avg / +3.5 GB @recent (sum of the "rows/yr x B/row" columns above for raw_index, event, api_call, tool_use, tool_result, node_meta; an earlier draft wrote "+0.1 / +0.45 GB", which is ~7x too low for its own table). The index file never shrinks (D-ENG-8) and may grow during a checkpoint that rewrites partly-deleted row groups (CAP §10, E1b D), so the deleting paths (otel/hook retention, file_ctx) are on small tables only.

### 6.3 ART budget (see 3.1; test in section 10)

Resident ART total <= 64 MiB for the first year at the average rate while the `api_call` PK stands (E6 may replace it); the `api_call` PK is the dominant term. Persisted size is not resident size: lazy load means a read-only point query touches ~1-2 MiB per index (CAP §5), a batch upsert loads the whole `api_call` index (~16-20 MiB today), and a bulk write against any other index would load it fully, which is why none exists. `otel_span` adds a VARCHAR-keyed index whose size is unmeasured (OPEN-O27).

### 6.4 Process memory budget (D-16, D-ENG-9, D-13, R1-BUDGET)

`RSS cap >= index.memory_limit + Σ memory_limit of other DuckDB instances + Rust overhead + 330 MiB allocator margin`, enforced by a startup check that refuses to start otherwise. R1-BUDGET: the writer spec sums the static memory budget to 2,226 MiB, above today's 2,048 MiB cap, so the check requires the interim 4,096 MiB cap (D-13) or a smaller sum after the bench.

| term | value | status |
|---|---|---|
| index.duckdb `memory_limit` | OPEN-O2 (e.g. 512 MiB) | fixed by bench (D-15/D-16) |
| other instances (in-memory summary, transcript heavy slot 1 GiB, bodies pass, cards.duckdb which the new engine does NOT open, L §7) | stated limits of `session_summary_sql.rs`, `transcript_sql.rs:27-29`, `bodies_evidence.rs` (H14) | to be summed once at startup; retire as K cards C01-C27 land |
| Rust overhead (queues, ctx, parser buffers, byte-bounded writer queue D-7, the part buffer of one seal) | OPEN-O2 | measured by bench |
| allocator/appender margin | 330 MiB | D-ENG-9, D-16 (MEASURED 120-330 MB over the limit) |
| WAL replay at open | <= ~16 MB WAL x ~1 GB RSS/GB = ~16 MB | D-ENG-7 MEASURED rule |
| RSS cap (interim) | 4096 MB | a PLAN, not a verified fact (R1-D13: cap raise plus a 65-minute watch, SPEC-interim-stabilization) |
| Parquet point read | 131 MB (C2), 154 MB (C1), 283 MB (D1) | E1b MEASURED in a Python harness: ordering meaningful, absolute values not (E1 caveat, R1-D1); the Rust bench replaces them |
| appender 2M rows at memory_limit 512 MB | RSS 206-253 MB; GROUP BY 631 MB | CAP §2g MEASURED |

## 7. Retention of the "never delete" promises (RULE 0 mapping)

`/api/clear` (H7), `/action clearAll` (H8), retention and migrations never delete the raw-line store (`raw_part`, `raw_index`, `raw_stage`, `raw_line`, the part files), `legacy_card`, `legacy_import_run`, `ingest_error`, `file` (D-10, R1-D10, L §6). The span tables are the one place where the clear candidates of OPEN-O12 differ (hide vs drop). Orphan part files are moved aside, never deleted (4.2). The old `cards.duckdb`, NDJSON snapshot/delta and `log-offsets` files are not touched by this schema (L §7).

## 8. Clear, reindex and recovery (OPEN-O12, OPEN-O26)

Semantics of `POST /api/clear` are OPEN pending revision 2 / experiment E7. Three candidates; the schema carries all of them, and every one needs `meta.clear_epoch` (raised by a clear), an `ingest_batch(kind='clear')` row, and `data_version` never decreasing (H17):
- Candidate 1 (D-10, side-database rebuild): build `index.duckdb.next` with the same DDL, copy RAW tables, re-derive every DERIVED table from `raw_lines` + `legacy_card`, carry SIDE tables over except the span tables, swap by rename, keep the old file as `index.duckdb.pre-clear-<UTC stamp>`.
- Candidate 2 (R1-D10, forget-before-T): record a watermark T (`meta.clear_before_ms`, added only if this is chosen) and make every read hide data older than T; nothing is deleted or rebuilt (no disk doubling); the "unclear" operation is lowering the watermark. Which timestamp T is compared with (`event.ts_ms`, `received_ms`, `node_rollup.last_active_ms`) and whether a node cut by T keeps its totals are read-API questions; the single place such a predicate goes is `node_visible` and the window macros (4.7).
- Candidate 3 (the direction reported for revision 2): keep today's meaning of clear - drop the OTEL span data and rebuild the derived data from the raw store. The span drop is `DROP TABLE` + `CREATE TABLE` of `otel_span`/`otel_span_attr` in one transaction (H4), never a `DELETE` of the now-indexed table (D-ENG-2).
Common to all three: a reindex from raw (re-derive DERIVED tables into a side database after a free-disk check; also needed after a parser change and by R1-ENG6's `reindex --from-raw`), and the epoch rule of D-8 (a batch read under an older epoch is dropped) whose necessity depends on the candidate (a watermark deletes nothing, so a late batch loses nothing): OPEN-O12. `/action clearAll` (H8) acts on the span family only and follows the same candidate.

Recovery and snapshots (R1-ENG6). The premise stands: the index (+ parts) becomes the only copy of deleted transcripts and legacy cards, on a platform whose `fsync` does not flush the drive cache (section 1), so power loss may reorder writes and corrupt the file. What stays decided: a startup integrity check that never falls back to an empty database; the reindex-from-raw path above; the legacy cards' immutable export (4.6). What is OPEN-O26 pending revision 2: the snapshot mechanism (periodic `CHECKPOINT` + APFS clone into a rotating set of 3, daily and after a backfill, with fallback to the newest snapshot and re-ingest from its offsets). The review's finding: a clone of the DB file diverges from the original after the next checkpoint rewrites blocks, so it costs real disk, while the immutable Parquet parts clone for free. The metadata that any variant needs must outlive a corrupt database, so it cannot live only inside `index.duckdb`: a sidecar manifest `<dataDir>/index-backup/manifest.ndjson` (append-only; one record per snapshot with `snapshot_id`, `kind` daily|post-backfill|manual, `taken_ms`, `data_version`, `index_bytes`, `max_part_id`, `index_sha256`) is the proposed form, with `meta.last_snapshot_ms` as the only in-database echo. Fallback consequence under backend P: parts written after the snapshot are adopted by the startup reconcile of 4.2, and lines whose transcript still exists are re-read from the snapshot's `file.next_off`.

## 9. Invariants (SQL; each returns ZERO rows when it holds; run after every test and at boot in the soak, L §7)

```sql
-- I1 rollup == aggregate over api_call for every non-legacy node (legacy nodes are card-filled).
-- All generations are summed; if OPEN-O4 keeps R1-D4(b), join api_call to file ON (file_id, gen) first.
SELECT r.nk FROM node_rollup r JOIN node n USING (nk)
LEFT JOIN (SELECT nk, count(*) c, sum(input_tokens) i, sum(output_tokens) o, sum(cache_read_tokens) cr,
                  sum(cache_create_tokens) cc, sum(coalesce(cache_create_1h,0)) c1, count(cache_create_1h) k1
           FROM api_call GROUP BY nk) a USING (nk)
WHERE n.origin <> 'legacy'
  AND (r.n_api_calls <> coalesce(a.c,0) OR r.input_tokens <> coalesce(a.i,0) OR r.output_tokens <> coalesce(a.o,0)
    OR r.cache_read_tokens <> coalesce(a.cr,0) OR r.cache_create_tokens <> coalesce(a.cc,0)
    OR r.cache_create_1h_tokens <> coalesce(a.c1,0) OR r.n_calls_1h_known <> coalesce(a.k1,0));
-- I1b every rollup row belongs to an existing node
SELECT nk FROM node_rollup WHERE nk NOT IN (SELECT nk FROM node);
-- I2 api_call attribution exists
SELECT call_key FROM api_call WHERE nk NOT IN (SELECT nk FROM node);
-- I3 no call_key hash collision was ever detected (U5 records one and rolls the batch back; a PK would otherwise drop the colliding message silently)
SELECT * FROM ingest_error WHERE kind = 'collision';
-- I4 byte contiguity: lines of each (file,gen) tile [0, next_off) exactly (stored lines incl. newline); spill files excluded (OPEN-O24)
WITH l AS (SELECT file_id, gen, byte_off, len FROM v_raw_keys)
SELECT f.file_id, f.gen FROM file f LEFT JOIN
  (SELECT file_id, gen, sum(len) s, count(*) c, count(DISTINCT byte_off) d, min(byte_off) m FROM l GROUP BY 1,2) x
  ON x.file_id=f.file_id AND x.gen=f.gen
WHERE f.kind <> 'spill'
  AND (f.next_off <> coalesce(x.s,0) OR coalesce(x.c,0) <> coalesce(x.d,0) OR coalesce(x.m,0) <> 0);
-- I4b no gaps: each line starts where the previous ends
WITH l AS (SELECT file_id, gen, byte_off, len FROM v_raw_keys)
SELECT file_id, gen, byte_off FROM (SELECT *, lag(byte_off+len) OVER (PARTITION BY file_id, gen ORDER BY byte_off) AS e FROM l)
WHERE e IS NOT NULL AND e <> byte_off;
-- I5 index <-> manifest (backend P only)
SELECT p.part_id FROM raw_part p LEFT JOIN (SELECT part_id, count(*) c, sum(len) s FROM raw_index GROUP BY 1) i USING (part_id)
WHERE p.n_rows <> coalesce(i.c,0) OR p.raw_bytes <> coalesce(i.s,0);
SELECT part_id FROM raw_index WHERE part_id NOT IN (SELECT part_id FROM raw_part) LIMIT 1;
-- I6 a line is in exactly one of stage/index (backend P only)
SELECT s.file_id FROM raw_stage s JOIN raw_index i USING (file_id, gen, byte_off) LIMIT 1;
-- I7 version counter
SELECT 1 WHERE (SELECT value_int FROM meta WHERE key='data_version') < coalesce((SELECT max(batch_id) FROM ingest_batch),0);
SELECT 1 WHERE (SELECT max(epoch) FROM ingest_batch) > (SELECT value_int FROM meta WHERE key='clear_epoch');
-- I8 schema version = binary maximum (supplied as :max_version)
SELECT 1 WHERE (SELECT value_int FROM meta WHERE key='schema_version') <> :max_version;
-- I9 at most one rollup row per node
SELECT nk FROM node_rollup GROUP BY nk HAVING count(*) > 1;
-- I10 derived rows reference nodes
SELECT 1 FROM event WHERE nk NOT IN (SELECT nk FROM node) LIMIT 1;
SELECT 1 FROM tool_use WHERE nk NOT IN (SELECT nk FROM node) LIMIT 1;
-- I11 dead letters: release gate on the real corpus = ZERO rows (H7); fixtures list the rows they expect
SELECT * FROM ingest_error;
-- I12 legacy rows are whole
SELECT natural_key FROM legacy_card WHERE nk NOT IN (SELECT nk FROM node);
SELECT nk FROM node WHERE origin='legacy' AND nk NOT IN (SELECT nk FROM legacy_card);
-- I13 file_ctx pruned
SELECT file_id, gen FROM file_ctx GROUP BY 1,2 HAVING count(*) > 2;
-- I14 index inventory: only the allowlisted ART indexes exist (D-ENG-2); api_call leaves the list or api_key_% joins it if E6 picks candidate B or C
SELECT table_name FROM duckdb_constraints() WHERE constraint_type IN ('PRIMARY KEY','UNIQUE')
  AND table_name NOT IN ('meta','file','node','node_key','api_call','legacy_card','otel_span');
SELECT table_name FROM duckdb_indexes();   -- must be empty (only constraint-backed indexes)
-- I15 type policy (D-ENG-10/D-14): no FLOAT/DECIMAL/TIMESTAMP/DATE/ENUM/LIST column
SELECT table_name, column_name FROM duckdb_columns()
WHERE data_type ILIKE 'FLOAT%' OR data_type ILIKE 'DECIMAL%' OR data_type ILIKE 'TIMESTAMP%' OR data_type ILIKE 'DATE%'
   OR data_type ILIKE 'ENUM%' OR data_type ILIKE '%[]';
-- I16 stage bounded (backend P only)
SELECT 1 WHERE (SELECT coalesce(sum(len),0) FROM raw_stage) > :stage_cap_bytes;
-- I17 no duplicate line key in the index-free display tables (R1-D4(a): the offset CAS is their only protection, this detects its failure)
SELECT 'event', file_id, gen, byte_off, sub_index FROM event GROUP BY ALL HAVING count(*) > 1
UNION ALL SELECT 'tool_use', file_id, gen, byte_off, sub_index FROM tool_use GROUP BY ALL HAVING count(*) > 1
UNION ALL SELECT 'tool_result', file_id, gen, byte_off, sub_index FROM tool_result GROUP BY ALL HAVING count(*) > 1
UNION ALL SELECT 'spawn_edge', file_id, gen, byte_off, sub_index FROM spawn_edge GROUP BY ALL HAVING count(*) > 1
UNION ALL SELECT 'spawn_result', file_id, gen, byte_off, sub_index FROM spawn_result GROUP BY ALL HAVING count(*) > 1;
```
Not expressible in SQL (checked by scripts): the independent line census (count newlines with a `wc`-style pass over the files, NOT from stored offsets, then compare with the count of `v_raw_keys`; H29: a census from the same offsets is circular), the Parquet sha256 verification, and legacy token sums vs the frozen NDJSON (L §5).

## 10. Test list (real files and a real DuckDB, no mocks; file name proposal `rust-core/crates/agentlens-core/tests/index_schema.rs`)

1. `ddl_applies_on_empty_db`: open a new file for each raw backend, apply all steps; assert 29 tables (backend P) or 27 (backend D), the 7 PK constraints (`meta`, `file`, `node_key`, `node`, `api_call`, `legacy_card`, `otel_span`; adjusted when E6 changes `api_call`), 5 views, macros exist; apply the idempotent macro/view script twice with no error; `schema_version` = binary maximum; `meta` seeded keys present (including `next_hook_id`, `raw_backend`).
2. `settings_fail_fast`: with `autoload_known_extensions=false` and `autoinstall_known_extensions=false` in the shipped binary, the startup self-test (`to_json`, a Parquet write+read round trip) passes; a build without the `json` or `parquet` crate feature cannot be simulated in-process, so the test builds the crate once without the feature (CI job) and asserts the self-test exits non-zero with a clear message. Also asserts the other DuckDB instances (`transcript_sql` `read_ndjson_auto`, the bodies Parquet `COPY`) pass with autoload off (R1-ENG1).
3. `migration_from_each_version`: for every shipped version N, build a fixture DB at version N (kept in the repo as a generated-by-script file or built by replaying the N-version DDL), fill with the fixture corpus, run the migration to the latest, assert invariants I1-I17, row counts equal, RAW rows byte-identical, the pre-migrate clone exists, and `meta.schema_version` advanced exactly one step per transaction.
4. `migration_crash_resumes`: failpoint inside a step; reopen; the previous version is intact (single transaction) and the re-run completes.
5. `migration_refuses_newer`: a DB at max+1 makes the binary exit with an error naming both versions and leaves the file untouched; an unreadable DB is renamed aside, never deleted, and never replaced by an empty one.
6. `alter_on_indexed_tables` (closes OPEN-O9): `ADD COLUMN` on each of the seven PK tables with data; record which succeed.
7. `invariants_hold_on_fixture`: ingest a fixture of real small transcripts (main + sibling subagent pair with identical rows + a growing-usage pair + a fork-copy pair + a workflow agent file + a journal.jsonl + an untimestamped-first-line file + a poison line) through the real writer; assert I1-I17, and the specific facts: sibling pair counts once (D-DAT-3), growing usage resolves as the guard of OPEN-O6 decides (the test is written for both candidates and the undecided one is skipped, not faked), fork copy attributed to the first node (D-DAT-4), workflow file gets `parent_session_id` (D-DAT-5), journal.jsonl yields no node, `created_ms` = first timestamped line (D-DAT-6), poison line is in `ingest_error` and its raw line is stored.
8. `rollup_equals_aggregate_under_rewrites`: random batches including replaced usage rows and cross-file duplicates, deltas taken from the applied set (R1-D4(d)); I1 after every commit.
9. `cas_offset_and_epoch`: two producers on one file via failpoint interleaving: the loser's UPDATE returns 0 and rolls back; a clear between read and commit loses nothing (H3, H4); the stale-epoch drop rule is asserted only for the clear candidate that keeps it (OPEN-O12).
10. `rotation_new_gen`: replace a file (new inode / changed head / missing newline at offset-1): `gen+1`, `next_off=0`, old-gen raw lines and `api_call` rows kept, no duplicate tokens (D-DAT-1, H6); the same-path/new-inode, known-inode/new-path and relocation-by-fingerprint cases each get a case once OPEN-O25 fixes the rules.
11. `seal_part_crash` (backend P): kill between the Parquet rename and the seal transaction, and between the temp write and the rename: reopen moves the orphan part aside, lines are re-sealed, I4-I6 hold; a part that is not in `raw_part` and whose lines are in neither stage nor index is adopted; footer metadata `{part_id, n_rows}` matches `raw_part`.
12. `raw_roundtrip_bytes`: on each backend, every stored line (including invalid UTF-8, a 4.4 MiB line, a 1-byte line, an empty line) reads back byte-exact through `raw_lines` from stage and from a part; a point read p95 is reported against the E1b figures (4.6-11 ms cold) as a bench, not a hard gate.
13. `art_budget`: insert 1M synthetic `api_call` keys (HUGEINT), checkpoint, reopen, run a batch upsert touching 50k random keys; assert `SELECT sum(memory_usage_bytes) FROM duckdb_memory() WHERE tag='ART_INDEX'` <= the budget of 3.1, assert RSS growth, and assert the startup warning at 50% and refusal at 100% of the key budget (D-ENG-2: never an OOM). It becomes experiment E6 at 1M/5M/20M keys and runs for each candidate mechanism.
14. `no_bulk_write_on_indexed_tables`: static scan of the Rust SQL strings: every `UPDATE`/`DELETE` statement text must match the U1-U8 / DELETE allowlist of 3.3; any other fails the test.
15. `appender_duplicate_collapse`: stage duplicate call keys in one batch: the in-batch `QUALIFY` leaves one row; an existing key updates only when the guard of OPEN-O6 says so (D-ENG-3).
16. `clear_semantics`: written per candidate once OPEN-O12 is decided: raw store, `legacy_card`, `ingest_error`, `data_version` monotone, `clear_epoch+1`, no `DELETE` against an indexed table (D-10/R1-D10, H4, H17).
17. `legacy_rows_survive_clear_and_adoption`: import a legacy card, clear, then add a transcript for the key: same `nk` kept, `origin` flips to `live`, `shadowed_ms` set, legacy row still present (L §4, §6, §8 tests 3 and 8).
18. `retention_chunks`: `otel_span` retention deletes in bounded transactions and never touches `legacy_*`/RAW tables; `ingest_batch` prune leaves `data_version` untouched (H28).
19. `type_policy_and_json_golden`: I15 plus a golden comparing `to_json` of every exposed column type with serde output (D-ENG-10).
20. `wal_replay_budget`: kill -9 with a 16 MB WAL, reopen, assert replay time and RSS under the figures of D-ENG-7.
21. `writer_restart_state`: `data_version`, `next_*` counters and `file_ctx` resume reproduce the same state after kill -9 x N (compare checksums to a clean single pass, H29 U4), including a batch ending between a tool_use and its tool_result (H5).
22. `second_process_lock`: a real second process opening `index.duckdb` is refused and the error names the holder; the file is not deleted or renamed (D-11, H1, H14).
23. `call_key_collision_detected`: force two different message ids onto one `call_key` (a test-only key override); the batch is rolled back and `ingest_error(kind='collision')` is written; I3 reports it. Without this test I3 could never fail.
24. `raw_backend_equivalence`: the same fixture ingested under backend P and backend D gives identical `raw_lines` output, identical I1-I17 results (I5, I6, I16 skipped on D) and identical DERIVED tables (R1-D1: the schema supports both).
25. `otel_span_idempotent_and_gated`: re-reading a span day file (plain, then its gzip form) adds no span rows (R1-D6); a day file with `next_off < size` is never sealed or retired; the chunked retention delete runs on the indexed table within the memory budget of OPEN-O27.

## 11. OPEN items (not decided by D or R1, or reopened after R1; each needs a measurement or a user decision)

| id | open question | default used above | settles with |
|---|---|---|---|
| O1 | storage version and `force_compression` (needed only by backend D: `latest` + zstd, single file vs an attached second file) | engine default under backend P | Rust bench (SPEC-method-bench): index size and checkpoint cost; R1-D1 |
| O2 | `memory_limit`, `threads`, `preserve_insertion_order`, Rust overhead numbers; R1-BUDGET startup check (2,226 MiB sum vs cap) | 512 MiB / 2 threads | SPEC-method-bench, D-16 startup check |
| O3 | raw-line backend: D vs C1 vs C2; part target size, zstd level 3 without dictionary, row-group byte cap, C1 worst-case group memory (2048 rows x 4.4 MiB) | backend P C2, 64 MiB, level 3, 64 MiB cap | Rust bench re-confirm (R1-D1; tie on RAM and CPU prefers D or C1) |
| O4 | visibility of display rows of an old gen and the rollup consequence of a gen bump (R1-D4(b) recompute vs `api_call` totals never gen-filtered) | no gen filter, no recompute statement | revision 2 / E7 |
| O5 | `event` text column vs raw fetch at page time | no text column | bench of a 200-event page |
| O6 | `api_call` update guard (G1 same-file later row, R1-D4(c); G2 largest usage wins) and, for either, how many message ids grow in a non-owning file | guard left as a placeholder in U5 | revision 2 / E7; a corpus scan for growth in non-owning files; FND-03 golden |
| O7 | cause columns for Q38-Q40/C07; O7b `n_turns` vs `n_llm_calls` parity | one nullable column; both counters | R sections not read here; FND-03 golden |
| O8 | volume, row shape and retention of `otel_span`, `otel_span_attr`, `call_block`, `hook_event`; duplicate-span behaviour of today's store | 30 days for spans; hook 30 days | measure the live span NDJSON and hook ring; sources not among those read |
| O9 | `ALTER ... ADD COLUMN` on tables with a PK | create+copy+rename | test 6 |
| O10 | non-additive `files*` counters | read-time over `tool_use`; legacy from card JSON | bench; K C04/C06 golden |
| O11 | spill-file link and layout: E5 shows the link is NOT a structured field but a path embedded in the tool_result text (`<persisted-output>` block), so it is parsed at ingest; how `session_hint` is derived from the path is not stated | `file.kind='spill'`, `session_hint`, `tool_result.spill_file_id` | the ingest spec (SPEC-ingest) and a path-shape check on the 743 `tool-results` directories |
| O12 | clear semantics (three candidates, section 8), which SIDE tables each touches, whether the stale-epoch drop rule stays | candidate-neutral schema | revision 2 / E7, with CONTRACT-DELTA D11 |
| O15 | `file_ctx.ctx` encoding, size bound and the id-set cap | BLOB | measure ctx size on the real corpus |
| O16 | row-group pruning of `file_row_number` filters in `read_parquet` (E1b measured a `(file_id, byte_off)` filter) | assumed | bench |
| O17 | `account_state` column set | minimum from K §3 | FND-09 |
| O18 | per-line hard cap | none observed (4.4 MiB max); H7 proposes 256 MiB | decide with the writer card |
| O19 | read-only enforcement for SQL exposed by Q29-Q31 on `try_clone` connections | not specified here | SPEC-read-api |
| O20 | `api_call` uniqueness mechanism (PK/ART vs timestamp-restricted anti-join vs monthly key partitions) | PK | experiment E6 (resident memory at 1M/5M/20M keys, release by CHECKPOINT vs reopen, insert CPU), R1-D4-ART |
| O21 | encoding of the `initiator` flip rule in `node_meta` | effective-value rows | writer card |
| O22 | `ingest_batch` retention horizon (days vs rows) | 30 days | change-feed requirements; H28 bound |
| O23 | non-Claude sources in `api_call`/`file`: Codex tokens are cumulative last-wins snapshots, Copilot tokens exist only at `session.shutdown`, OpenCode is a SQLite database updated in place (T Q7) - none fits a per-message tail | `source` is part of the key; no per-source rule here | K FND-03 and SPEC-ingest |
| O24 | representation of spill files in the raw store (not newline-structured, up to 64 MiB, `.jpg` incompressible, E5) | fixed-size chunks, `len` = chunk bytes, excluded from I4 | measurement of the spill set under the chosen backend |
| O25 | node and file identity rules: `(dev, inode)` as identity (R1-D5), how a same-path/new-inode replacement maps to the existing node as a gen bump, move detection, relocation by fingerprint; which `node_key` kinds are used | columns for every candidate; no lookup rule | revision 2 / E7 |
| O26 | snapshot mechanism and its metadata (R1-ENG6): DB-file clones diverge after checkpoints, Parquet parts clone for free; recovery fallback | sidecar manifest, `meta.last_snapshot_ms` | revision 2 / E7 |
| O27 | `otel_span` PK (R1-D6): key count and resident size (VARCHAR keys), and a chunked retention delete against an indexed table (D-ENG-2 forbids bulk deletes on indexed tables) vs per-day tables vs drop-and-recreate | PK + chunked delete | span NDJSON measurement (O8) and an E6 extension |

Resolved since the earlier draft: O13 (`node.origin` separate from `node.source`: R1-ORIGIN) and O14 (`last_active_ms` clamp: `min(ts, ingest wall ms + 5 min)`, H20).

## 12. Revision log

Revision against `docs_dev/duckplan-decisions-r1.md` and a fact-check against D and the cited reports. Items R1-D4(b), R1-D4(c), R1-D10, R1-D5 and R1-ENG6 were reopened by the coordinator after the final review and are recorded as OPEN, not implemented.

1. Header and sources: added the R1 decision file and the E1-E5 reports the text cites but the front matter omitted; status line says which items wait for revision 2 / E7. Reason: R1 wins on conflict; uncited reports were used as evidence.
2. New "Decision status" paragraph: R1-D4(b), R1-D4(c), R1-D10, R1-D5, R1-ENG6 recorded as OPEN (O4, O6, O12, O25, O26) instead of being implemented, and R1-D12 listed as not a schema matter. Reason: coordinator message after the final review.
3. Legend: D-4 and D-10 citations replaced by R1-D4 and R1-D10; R1-D7 QoS split added (LIVE producers normal QoS, only BACKFILL background); `W-CLEAR` now means the side-database reindex. Reason: R1 supersedes those items.
4. New "Idempotency" legend bullet with R1-D4 (a)-(d). Reason: R1-D4 per-row idempotency; the earlier text relied on the per-offset compare-and-set alone, the drift the review named.
5. 128-bit key: computed in Rust over `(source, message id)`, combined as `hi * 2^64 + lo`; the `<<` form is marked UNVERIFIED for HUGEINT. Reason: R1-D4(c) puts `source` in the key; a HUGEINT shift is not in any report.
6. Table inventory rewritten as 29 clean rows (the old table had a combined row 15 and a placeholder row 29 that contradicted its own count), plus backend D (27 tables), the `otel_span` PK and 5 views. Reason: garbled sentence and R1-D1 needing both backends.
7. Settings: the R1-ENG1 sequence (features, verify every other instance, then autoload off). Reason: R1-ENG1; autoload is per instance.
8. Startup self-test rewritten as a self-written tiny Parquet round trip. Reason: the old "tiny embedded part" was unexplained and could not be run.
9. Storage version / `force_compression` made backend-dependent. Reason: the old text said the zstd reason "is gone" because lines left DuckDB; R1-D1 reopened that, and CAP §3 / E1b show zstd needs `STORAGE_VERSION latest` + `force_compression`.
10. Durability statement: R1-ENG6 premise (reordering on power loss, index may be the only copy); noted that H2/H30/H31 assume `F_FULLFSYNC` from a code comment while CAP §15 verified plain `fsync`. Reason: contradiction between sources; CAP is verified.
11. Open policy: never starts on an empty database; recovery mechanism left OPEN-O26. Reason: R1-ENG6 principle kept, mechanism reopened.
12. `checkpoint_threshold` row: no checkpoint gate in the schema. Reason: R1-CKPT, CAP §7.
13. Migration section: clone citation corrected from "H1, H30" to H1 (H30 says nothing about a clone); clone cost caveat; "six tables" became seven with `otel_span`; macros selected by `meta.raw_backend`. Reason: wrong citation, R1-D6, R1-D1.
14. Section 3.1 `node` bound: "33k transcript + 5.7k legacy" corrected to ~27.6k transcript files + 5.7k legacy (~33k) budgeted at 40k. Reason: T Q5 counts 27,723 files; the old sum was wrong.
15. Section 3.1 `api_call`: growth 5-9M keys/year (R1-D4-ART), resident ~16-20 MiB, mechanism OPEN-O20 (experiment E6), startup check conditional on the PK. Reason: R1-D4-ART.
16. Section 3.1/3.2: `otel_span` PK row and the exception to the no-bulk-delete rule, OPEN-O27. Reason: R1-D6 vs D-ENG-2.
17. U-allowlist: U2 identity left OPEN-O25; U4 uses the applied set; U5 rewritten (key `(source, message_id)`, in-batch collapse, applied-set capture, collision detection, guard as a placeholder for O6 with both candidates); U6 cites R1-D5; U7 uses `origin='live'` and no `source` rewrite; U8 covers `legacy_import_run`. Reason: R1-D4(a)(d), R1-ORIGIN, items 18-33.
18. DELETE allowlist: the horizon prune of `ingest_batch`/`ingest_batch_root` is stated as the second exception to "RAW tables are never deleted from". Reason: the old text allowed that prune and forbade it in the same section.
19. `meta`: seeded `raw_backend` and `next_hook_id`; the clear-watermark key is conditional. Reason: `next_hook_id` was "added later" although `hook_event` is in the version-1 DDL.
20. `file`: added `codec` (R1-D6 gzip reads); identity and lookup flagged OPEN-O25 because a replaced file has a new inode, so "found by (dev,inode)" could not find it. Reason: internal inconsistency; R1-D5 reopened.
21. `file_ctx`: replaced "<= ~300 MB worst case" (not derivable) by explicit arithmetic (1.8 GB worst, ~150 MB realistic) and the write-volume note; OPEN-O15. Reason: unsupported number.
22. `ingest_batch`: `epoch` comment tied to O12; row estimate withdrawn in favour of the H28 bound (~1.7M rows/day worst case). Reason: "few thousand/day" had no source and contradicted H28.
23. `ingest_error`: added kind `collision`; release gate is zero rows. Reason: U5 collision detection; H7 says the gate asserts the table empty, the old I11 let `unparsable` pass.
24. Section 4.2 restructured into a backend-neutral contract, backend P and backend D, with `v_raw_keys` and `raw_lines` per backend; empty lines stored (`len = 1`). Reason: R1-D1 OPEN, and I4 tiling needs empty lines.
25. Backend P protocol: fsync of the directory, startup reconcile against `raw_part` (missing file = corruption, orphan moved aside, restored-state part adopted), self-describing footer (`rel_path`, `file_map`), row-group byte cap, seal read done by the writer thread. Reason: R1-D1 crash protocol; the old background-QoS task read `raw_stage` itself, which H12 forbids.
26. Part facts: staged lines "~15k" corrected to ~22k (64 MiB / 3,096 B); zstd level 3 with dictionary OFF instead of "crate default"; C1 cannot write groups under 2048 rows (E1b finding 1) so it needs its own worst-case memory test; Parquet BYTE_ARRAY without UTF8 annotation marked INFERRED; E1b measured a `(file_id, byte_off)` filter, not `file_row_number`. Reason: contradictions with E1b/CAP §3 and unsupported claims.
27. The "131 MB read RSS" figure is flagged as a Python-harness number everywhere it appears (4.2, 6.4). Reason: E1/E1b caveat and R1-D1.
28. Backend D DDL and sizes (0.222 GB/GB, ~4.2 GB, ~3-4x C2 CPU). Reason: R1-D1; E1b D1/D2.
29. `node_key`: key kinds `inode` (R1-D5) and `path` (D-DAT-5) both representable, several keys per node allowed. Reason: R1-D5 reopened (O25).
30. `node`: `origin` is `live | legacy | import`, `source` never `legacy`, `kind` reduced to the structural roles. Reason: R1-ORIGIN; the old `kind` list duplicated `origin` and `source`. Resolves O13.
31. `node_meta` growth: "~6 rows/node" replaced by an upper bound from T Q2 (4,977 ai-title rows in 558 files). Reason: the old figure contradicted its cited fact.
32. `node_rollup`: clamp changed from "commit time + 60 s, cite H9/H27" to `min(ts, ingest wall ms + 5 min)` per H20; delta rule uses the applied set; no gen-recompute statement until O4. Reason: wrong citation and value; R1-D4(b) reopened. Resolves O14.
33. `event`, `api_call`: added `ts_suspect` (H20 asks to keep the raw timestamp and flag it).
34. `api_call`: `message_id` renamed `call_key` (also in `event`, `tool_use`, `call_block`), `source` added to the key, `seq` dropped, update guard left OPEN-O6, uniqueness mechanism OPEN-O20 with the three candidates sharing one column set. Reason: R1-D4(c), R1-D4-ART and the coordinator note.
35. Invariant I3 replaced: the old distinct-hash vs distinct-text comparison could never fail (a PK drops the colliding row, so stored rows always agree). It now reads `ingest_error(kind='collision')`, and test 23 forces a collision. Reason: an assertion that cannot fail.
36. `otel_span`: the PK `(trace_id, span_id)` replaces the "no key" text; ack-before-flush and the gating/gzip rules added; idempotent `ON CONFLICT DO NOTHING`. Reason: R1-D6.
37. `tool_result.spill_file_id`: the link is parsed from the path embedded in the result text (E5 §1), not a structured field; O11 narrowed. Reason: E5 was marked "not read here".
38. Legacy section: the garbled "(O 4 via L §1.3/§5)" replaced by the sources; R1-DAT9 caveat on the 5,742 count; the frozen NDJSON noted as the immutable export. Reason: garbled sentence, R1-DAT9, R1-ENG6.
39. Views: `v_raw_keys` added; `raw_lines` defined per backend; archived-lines view deferred to O4. Reason: R1-D1, R1-D4(b) reopened.
40. Section 5 retention: span day-file gating, backend-neutral raw store row. Reason: R1-D6, R1-D1.
41. Section 6.2: `raw_index` growth 10.6M corrected to 10.5M; per-year index growth corrected from "+0.1 / +0.45 GB" to +0.78 / +3.5 GB; persisted ART ~25 corrected to ~25-48 MB; steady state given per backend; unestimated tables listed. Reason: arithmetic from the table's own columns.
42. Section 6.4: R1-BUDGET paragraph; the 4096 MB cap marked a PLAN (R1-D13). Reason: R1-BUDGET, R1-D13.
43. Section 8 rewritten as "Clear, reindex and recovery" with three clear candidates, the reindex path and the R1-ENG6 premise with a sidecar manifest proposal (a manifest inside the possibly corrupt database cannot serve recovery). Reason: R1-D10, R1-ENG6 reopened; D-10 had been superseded.
44. Invariants: I1 note on generations, I1b comment fixed (garbled), I4/I4b read `v_raw_keys` and exclude spill files, I5/I6/I16 marked backend P only, I14 allowlist now includes `otel_span`, new I17 (duplicate line keys in the index-free tables). Reason: backends, R1-D6, R1-D4(a).
45. Tests: counts and PK numbers corrected, test 2 reworded (the old text described a test it said could not be done), tests 6, 7, 9, 10, 11, 12, 13, 16 adjusted, tests 23-25 added. Reason: backends, open items, assertions that must be able to fail.
46. Open items: O13 and O14 resolved; O1, O3, O4, O6, O11, O12, O15, O20, O22 reworded; O23-O27 added (non-Claude sources T Q7, spill representation E5, identity rules, snapshots, `otel_span` bound). Reason: decisions answered some; others reopened or newly found.
