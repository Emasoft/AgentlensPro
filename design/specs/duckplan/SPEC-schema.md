---
title: DuckDB-index redesign - schema spec (index.duckdb DDL + Parquet raw-line store)
status: draft
scope: project
sources: docs_dev/duckplan-decisions.md (D), reports/DUCKPLAN/20261003_192823+0200-duckdb-capabilities.md (CAP), reports/DUCKPLAN/20261003_182757+0200-transcript-format-facts.md (T), reports/DUCKPLAN/20261003_165118+0200-concurrency-and-flaws.md (H), design/specs/duckplan/SPEC-operation-catalog.md (K), design/specs/duckplan/SPEC-legacy-card-import.md (L)
---

# Schema of alcore's new `index.duckdb` and its Parquet raw-line store

Citation rule: every choice cites a decision id (D-*) or a report section (CAP §n, T Qn, H<n>, K §n, L §n). VERIFIED/INFERRED/OPEN: byte and row estimates in section 6 are INFERRED (rows from the reports, bytes-per-row assumed) unless marked MEASURED; every OPEN item is collected in section 11. This spec defines data shape only; the writer funnel, read API and bench are SPEC-read-api, SPEC-method-bench and the writer card.

## 0. Conventions

### 0.1 Legend

- Writer paths (D-7: one writer thread owns the single write connection; producers never touch a connection):
  `W-LIVE` live-lane batch from a file reader; `W-BACK` backfill-lane batch; `W-OTLP` NDJSON span tailer (D-6); `W-ACCT` account-state / OTLP-log account events; `W-HOOK` hook POSTs (H10-H12 in K); `W-LEG` legacy import (L §3); `W-IMP` `/api/import` (H16); `W-MAINT` part sealing, retention prune, heartbeat, migrations; `W-CLEAR` clear/rebuild into the side database (D-10).
- Class (for clear/rebuild, section 8): RAW = never derived, never cleared (D-10); DERIVED = rebuilt from RAW by clear; SIDE = sourced outside the raw-line store (NDJSON/hook/OTLP), carried over by clear unless stated.
- Line key = `(file_id, gen, byte_off, sub_index)`: identifies one derived row of one physical line (D-4). `byte_off` replaces `seq` as the only ordering inside a file (H6). The ordering key across the files of a node is `(ts_ms, file_id, byte_off)` (H6).
- Types (D-ENG-10, D-14): counts and times are BIGINT, times are epoch-ms (no TIMESTAMP/DATE column anywhere), no FLOAT/DECIMAL, DOUBLE only for values < 1e16, no ENUM (H7: `type`/`kind` are VARCHAR, dictionary-compressed by the engine), no LIST column (appender cannot bind LIST, CAP §1). Identifiers: `file_id`, `nk`, `gen`, `part_id` INTEGER; byte offsets BIGINT.
- 128-bit values (`api_call.message_id`): duckdb-rs binds no i128 (CAP §1 ToSql list), so the writer stages `(hi BIGINT, lo UBIGINT)` in the TEMP staging table and combines in SQL: `(hi::HUGEINT << 64) | lo::HUGEINT`. HUGEINT is never serialised to JSON (the text id is).
- Every append-only line-derived table carries `batch_id` (the `meta.data_version` value of its transaction): it freezes a paging walk with `batch_id <= v` (H9) and links a row to its change-feed entry.
- Bounded-ART rule (D-ENG-2): an ART index exists only on a table whose key count has a stated bound (section 3). No other table has PK/UNIQUE/INDEX. Idempotency for index-free tables comes from the per-file offset compare-and-set (D-4, D-8, section 4.1 `file`), not from a key.

### 0.2 Table inventory (29 tables, 4 views, macros)

| # | table | class | ART index | # | table | class | ART index |
|---|---|---|---|---|---|---|---|
| 1 | meta | RAW | PK(key) | 16 | event | DERIVED | none |
| 2 | file | RAW | PK(file_id) | 17 | api_call | DERIVED | PK(message_id) |
| 3 | file_ctx | DERIVED | none | 18 | tool_use | DERIVED | none |
| 4 | ingest_batch | RAW | none | 19 | tool_result | DERIVED | none |
| 5 | ingest_batch_root | RAW | none | 20 | otel_span | SIDE | none |
| 6 | ingest_error | RAW | none | 21 | otel_span_attr | SIDE | none |
| 7 | raw_stage | RAW | none | 22 | account_map | SIDE | none |
| 8 | raw_part | RAW | none | 23 | account_state | SIDE | none |
| 9 | raw_index | RAW | none | 24 | call_block | SIDE | none |
| 10 | node_key | DERIVED | PK(key_kind,key_text) | 25 | hook_event | SIDE | none |
| 11 | node | DERIVED | PK(nk) | 26 | collector_run | SIDE | none |
| 12 | node_meta | DERIVED | none | 27 | legacy_card | RAW | PK(natural_key) |
| 13 | node_rollup | DERIVED | none | 28 | legacy_import_run | RAW | none |
| 14 | root_cache | DERIVED | none | 29 | (see 4.7 views) | | |
| 15 | spawn_edge / spawn_result | DERIVED | none | | | | |

Rows 15 and 29 are shorthand: `spawn_edge` and `spawn_result` are two tables (section 4.3), and the row-29 entry is the view list (4.7). The table count is therefore 29: rows 1-14, spawn_edge, spawn_result, rows 16-28.

## 1. DuckDB settings applied at every open (writer and every `try_clone` reader share one Database)

| setting | value | why / cite |
|---|---|---|
| crate features | `bundled`, `json`, `parquet`; NOT `icu` | `to_json`/`json_*` are not statically linked and would autoload from the network (D-ENG-1, CAP §16); `read_parquet` for raw parts; ICU not needed (D-14) |
| `autoinstall_known_extensions` | `false` | a missing feature must fail at startup, never at runtime (D-ENG-1) |
| `autoload_known_extensions` | `false` | same |
| startup self-test | `SELECT to_json({'a':1}); SELECT count(*) FROM read_parquet(<tiny embedded part>)` | proves json+parquet are linked with autoload off; failure = exit with error (fail fast) |
| `memory_limit` (index instance) | OPEN-O2 (number fixed by SPEC-method-bench) | covers only DuckDB-managed memory; RSS runs 120-330 MB above it (D-ENG-9); budget in section 6.4 (D-16) |
| `threads` | OPEN-O2 (proposal: 2) | no long high-CPU bursts; responsiveness (owner rule in D) |
| `checkpoint_threshold` | default 16 MB, not raised | WAL replay costs ~2.5 s and ~1 GB RSS per GB of WAL and open does not truncate it (D-ENG-7, CAP §14) |
| `temp_directory` | `<dataDir>/index-tmp/` (own directory, exempt from the hourly temp sweeper) | H13 (sweeper `chores.rs:219` must not delete an active spill) |
| storage version | recorded in `meta.storage_version`; default = engine default `v0.10.2` | raw lines no longer live in DuckDB (D-1), so the zstd-only reason for a newer STORAGE_VERSION (CAP §3) is gone; any other gain is unmeasured: OPEN-O1 |
| `force_compression` | not set | same |
| time zone | not set (no ICU) | D-14 |
| `preserve_insertion_order` | default | batches are small; revisit only if the bench shows memory gain (OPEN-O2) |
| shutdown | `CHECKPOINT`, drop the Database instance, then release `pid_lock` | D-11, H1, H30 (a stopped-then-restarted alcore must not overlap its predecessor) |
| open policy | lock conflict: exit naming the holder; corrupt/unopenable: rename aside + exit; never delete; version change: forward migration | D-11 (replaces today's delete-on-error, H1) |
| durability statement | commits use plain `fsync` (no `F_FULLFSYNC` in the bundled build): durable across process kill, not across power loss; the last seconds are re-ingested from the transcript (still on disk) | D-ENG-6, CAP §15 |

## 2. Migration framework

- `meta.schema_version` (INTEGER) is the only version. The binary embeds an ordered list of steps `V(n-1) -> V(n)`; version 1 is the baseline = the DDL of section 4 as written here.
- Forward-only, never delete-and-rebuild (D-11): a step never drops or truncates a RAW-class table (`meta, file, ingest_batch*, ingest_error, raw_*, legacy_*`) and never drops the Parquet parts. A DERIVED table may be rebuilt by `CREATE TABLE new AS SELECT ... FROM old`, a swap by rename and re-creation of its macros, because DERIVED data is reproducible from RAW (D-10); RAW tables change only by `ALTER TABLE ... ADD COLUMN` (nullable or defaulted), `CREATE TABLE`, `INSERT ... SELECT`.
- Each step runs in ONE transaction: the DDL/DML plus `UPDATE meta SET value_int = :to WHERE key='schema_version' AND value_int = :from`; a row count other than 1 aborts and rolls back (compare-and-set, CAP §13 `execute` row count).
- Before the first step of a startup that must migrate: `CHECKPOINT`, then `cp -c` (clone) of `index.duckdb` to `index.duckdb.pre-migrate-v<from>-<UTC stamp>` kept until the user removes it (H1, H30 "clone before migrate"; RULE 0). Parquet parts are not copied (immutable, never rewritten).
- Startup compares `schema_version` with the binary's maximum: equal = continue; lower = run steps in order; higher = refuse to start with an error naming both versions (never downgrade); absent `meta` in an existing file = treat as corrupt (rename aside + exit, D-11); no file = create at the latest baseline by applying all steps from 0 in one transaction each (same code path as migration, so a fresh DB and a migrated DB are the same by construction).
- A crash mid-step leaves the previous version (single transaction, WAL replay): the next start re-runs the step.
- Macros and views (4.7) are NOT migration steps: they are `CREATE OR REPLACE`d at every open from the binary's embedded SQL, because persisted macros survive close/reopen (CAP §2d) and would otherwise go stale when a function body changes. Only table shape is versioned.
- `ALTER TABLE ... ADD COLUMN` on a table that has an ART index (`meta, file, node, node_key, api_call, legacy_card`) may be refused by DuckDB with a dependency error: UNVERIFIED, OPEN-O9. Until measured, a step on those six tables is written as create-new + `INSERT ... SELECT` + rename + recreate the PK, executed on the cloned file and checked by the invariants of section 9.

## 3. Index policy (D-ENG-2, D-4)

### 3.1 The only ART indexes

| index | key count (bound) | resident ART estimate | bound source |
|---|---|---|---|
| `meta` PK(key) | < 16 | negligible | fixed key list |
| `file` PK(file_id) | 27,723 files today, ~+46k/yr | < 4 MiB | T Q5 file count; growth = 27.7k files / 218 days (D-DAT-8) |
| `node` PK(nk) | ~40k (33k transcript + 5.7k legacy + imports) | < 4 MiB | T Q5 + D-DAT-9; one node per file or legacy card |
| `node_key` PK(key_kind, key_text) | same as node | < 16 MiB (path strings) | one key per node |
| `legacy_card` PK(natural_key) | <= 40,979 (all cards ever merged), one-off import | < 4 MiB | L §1.1 |
| `api_call` PK(message_id HUGEINT) | ~1.0M today, ~1.7M/yr @avg rate, ~7.5M/yr @recent rate | ~20 MiB today; BIGINT measured 8.1 B/key persisted (51 MB / 6.3M keys, CAP §5), HUGEINT assumed 2x (INFERRED) | D-4 "the one bounded index, budgeted and tested" |

Budget (D-16, the test of section 10): total resident ART after a worst-case batch <= 64 MiB through the first year at the average rate; the startup check also compares `count(api_call) * 20 B` with the budget and logs a warning at 50% and refuses new-key batches at 100% instead of an OOM (an ART OOM is FATAL and invalidates the handle, CAP §5). The escape hatch if the recent growth rate persists (7.5M keys = ~150 MiB) is OPEN-O20: drop the PK and dedupe by anti-join on a table kept sorted by `message_id`, whose zonemaps prune.

### 3.2 Forbidden

Any other PK/UNIQUE/INDEX. A bulk DELETE/UPDATE never runs against a table that has an index (CAP §5: a write touching many keys loads the whole index). The three append-only retention paths (`ingest_batch*`, `otel_span*`, `hook_event`) are on index-free tables for exactly this reason.

### 3.3 UPDATE allowlist (anything else is a defect; H "only updated table" note: the draft's claim was false)

| id | statement (columns written) | table | why it is safe |
|---|---|---|---|
| U1 | `UPDATE file SET next_off=:new, tail_fp=:fp, size_seen=:sz, mtime_ms=:mt, last_batch_id=:b WHERE file_id=:id AND gen=:gen AND next_off=:expected` row count must be 1, else ROLLBACK the batch (D-8, H3, CAP §13) | file | non-indexed columns; one row |
| U2 | `UPDATE file SET gen=gen+1, next_off=0, head_fp=:h, tail_fp=:t, state='active' WHERE file_id=:id AND gen=:gen` (rotation, D-DAT-1) and `SET path=:p` (rename detected by (dev,inode)) and `SET state=:s` (`missing`) | file | non-indexed; never zeroes a row's history |
| U3 | `UPDATE meta SET value_int=value_int+1 WHERE key='data_version'` (and the `next_*` counters) inside the batch transaction | meta | one row, non-key column |
| U4 | `UPDATE node_rollup r SET ... = r.x + b.dx, last_active_ms = greatest(...) FROM (batch aggregate) b WHERE r.nk=b.nk`, one statement per batch (D-3, H10) | node_rollup | no index; set-based |
| U5 | `INSERT INTO api_call ... ON CONFLICT (message_id) DO UPDATE SET <token/usage columns, line key, seq> WHERE excluded.seq > api_call.seq` after in-batch `QUALIFY row_number() OVER (PARTITION BY message_id ORDER BY seq DESC)=1` (D-ENG-3, D-DAT-2) | api_call | the key column is never in the SET list |
| U6 | `UPDATE node SET created_ms=:ms WHERE nk=:nk AND created_ms IS NULL` (once per node; D-DAT-6, H27) | node | non-indexed column; set-once |
| U7 | legacy adoption: `UPDATE node SET origin='transcript', source=:agent, kind=:k, file_id=:f WHERE nk=:nk AND origin='legacy'`; `UPDATE legacy_card SET shadowed_ms, shadowed_by_nk`; `UPDATE legacy_card SET partial, deficit_calls, twin_nk` (L §1.3, §4) | node, legacy_card | `nk` kept stable; key columns untouched |
| U8 | `UPDATE collector_run SET last_seen_ms=:t` (every 5 s) and `SET stopped_clean=true` (NS-9) | collector_run | tiny, non-indexed |

DELETE allowlist (all on index-free tables): `raw_stage` rows of a sealed part (same transaction as the `raw_index` insert), `file_ctx` rows older than the latest 2 per file, `ingest_batch`/`ingest_batch_root` older than the retention horizon, `root_cache` rows of touched `nk` before reinsert, `otel_span`/`otel_span_attr`/`hook_event` by `received_ms` in bounded chunks on the LIVE lane (H16). RAW tables are never deleted from, except the staging hand-off above.

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
-- seeded keys: schema_version (int), storage_version (text), clear_epoch (int, D-8/H4),
-- data_version (int, monotone change counter, H17/H28), next_file_id, next_nk, next_node_seq,
-- next_part_id, next_run_id (ints; allocated on the writer thread inside the batch txn: no gap
-- problem, no max() scan, H11), index_created_ms, created_by_version (text)
```
Mutability: updated in place (U3); migrations may add keys. Retention: forever. Rows: ~12. Read by: every function (`data_version` read INSIDE the page transaction and returned with the page, H9/H17: `BEGIN; SELECT value_int FROM meta WHERE key='data_version'; <page>; COMMIT` on one connection; no transaction is held across HTTP requests, H9/H19). `data_version` is a counter, not `max(ingest_batch.id)`, so pruning or a clear never lowers it (H17, H28); a clear raises it.

#### file
Purpose: one row per physical file (transcript, spill file, NDJSON tail source): identity, resume offset, generation. Writer: W-LIVE/W-BACK (U1), discovery in W-MAINT (insert, U2). Spill files are included (D-2, D-1 "same storage path").
```sql
CREATE TABLE file(
  file_id       INTEGER PRIMARY KEY,
  kind          VARCHAR NOT NULL,   -- transcript | spill | otel_ndjson | account_ndjson | codex | copilot
  path          VARCHAR NOT NULL,   -- current path (updated on rename; identity is (dev,inode))
  dev           UBIGINT NOT NULL,   -- fstat of the OPENED handle (H6), never a path stat
  inode         UBIGINT NOT NULL,
  head_fp       UBIGINT NOT NULL,   -- xxh3-64 of the first min(4096,size) bytes at gen start
  tail_fp       UBIGINT NOT NULL,   -- xxh3-64 of the 64 bytes before next_off (0 when next_off=0)
  gen           INTEGER NOT NULL,   -- generation; +1 when the file is replaced/rotated (D-DAT-1)
  next_off      BIGINT  NOT NULL,   -- byte offset of the first unread byte; always just after a '\n'
  size_seen     BIGINT  NOT NULL,   -- size at the last read (diagnostics, backfill progress)
  mtime_ms      BIGINT  NOT NULL,
  state         VARCHAR NOT NULL,   -- active | missing (deleted by Claude Code; rows are kept, H6)
  session_hint  VARCHAR,            -- spill files: session directory name from the path (OPEN-O11)
  first_seen_ms BIGINT  NOT NULL,
  last_batch_id BIGINT
);
```
Identity and resume (D-DAT-1, H6): a file continues (same gen) only if `(dev,inode)`, `head_fp`, `tail_fp` and the byte at `next_off-1 == '\n'` all match and `size >= next_off`; otherwise a new gen with `next_off=0` (U2). The file row is keyed by `file_id`, found by `(dev,inode)` in a writer-owned in-memory map rebuilt at boot by `SELECT` (28k rows; no index needed). Raw lines and display rows of an old gen are never deleted (D-10); whether display rows of an old gen stay visible is OPEN-O4 (default: raw and `api_call` all gens, display tables current gen only).
Mutability: U1/U2 only. Retention: forever (rows are tiny; 27.7k now, +~46k/yr, D-DAT-8). Rows/bytes: 27.7k, ~3 MB. Read by: backfill progress (`complete`/`backfill` block on aggregates, H18), `sql_body_writers` (K C30), `raw_*` macros.

#### file_ctx
Purpose: the parser's cross-line resume state, committed in the SAME transaction as the batch (D-9, H5): next turn, next idx, open `pending_reads`/`pending_tool_results`, open sub-agent records, rolling fast-mode flags, set-once values, last model, `seen_message_ids` including first rows without usage. Writer: W-LIVE/W-BACK.
```sql
CREATE TABLE file_ctx(
  file_id     INTEGER NOT NULL,
  gen         INTEGER NOT NULL,
  batch_id    BIGINT  NOT NULL,
  ctx_version INTEGER NOT NULL,  -- version of the Rust ctx layout
  ctx         BLOB    NOT NULL   -- Rust-serialised struct (kilobytes); OPEN-O15: BLOB vs JSON
);
```
Append-only, latest row per `(file_id, gen)` wins (`arg_max(ctx, batch_id)`); rows older than the latest 2 per file are deleted in W-MAINT (index-free table, D-ENG-2). Rows: <= 2 x 28k = 56k, bytes: ctx grows with open state; INFERRED 2-50 KB each, bounded <= ~300 MB worst case only if every file kept a full 4096-id seen-set (OPEN-O15; measure). The 4096-entry caps of today's parser (H5, H25) are a parity delta listed in CONTRACT-DELTA, not a schema limit. Read by: the writer's resume path only (no read function).

#### ingest_batch
Purpose: one row per committed transaction: the change-feed header and diagnostics (D-7, H11, H17, H28). Writer: every batch (kinds: `live backfill otel legacy import clear migrate seal`).
```sql
CREATE TABLE ingest_batch(
  batch_id     BIGINT  NOT NULL,   -- = meta.data_version after this batch's bump (U3)
  kind         VARCHAR NOT NULL,
  lane         VARCHAR NOT NULL,   -- live | backfill | maint
  epoch        BIGINT  NOT NULL,   -- clear_epoch the batch was read under (D-8: stale epoch = dropped, never committed)
  file_id      INTEGER,            -- NULL for non-file batches
  committed_ms BIGINT  NOT NULL,
  n_lines      INTEGER NOT NULL,
  n_bytes      BIGINT  NOT NULL,
  n_api_calls  INTEGER NOT NULL,
  n_errors     INTEGER NOT NULL
);
```
Append-only; pruned older than the horizon (OPEN-O22; proposal 30 days, never below the oldest connected SSE cursor). A clear inserts one row `kind='clear'` and never empties the table (H17). Rows: backfill ~18.7 GB / 4 MiB per batch ~ 4.7k once; live ~ a few thousand/day (INFERRED); steady state with a 30-day horizon ~ 0.1-0.3M rows, ~10 MB. Read by: SSE frames `{v, since, boot_id, clear_epoch}` (H17), `sql_sidebar` (K C34), progress.

#### ingest_batch_root
Purpose: roots touched by a batch, so a lagging or reconnecting client can ask "what changed since v" (H11, D-5).
```sql
CREATE TABLE ingest_batch_root(batch_id BIGINT NOT NULL, root_nk INTEGER NOT NULL);
```
Append-only, same horizon as `ingest_batch`. Rows: ~2-3x `ingest_batch` (INFERRED), ~5 MB. Read by: change-feed query `SELECT DISTINCT root_nk FROM ingest_batch_root WHERE batch_id > :since` (a gap beyond the horizon = "refetch everything visible", H11).

#### ingest_error (dead letters)
Purpose: a poison line is a visible defect, never a hang (H7). Policy: when a transaction fails twice, bisect to the offending line, insert here, advance past it in the same transaction, bump a counter exposed in `/api/server-stats`.
```sql
CREATE TABLE ingest_error(
  batch_id  BIGINT  NOT NULL,
  ts_ms     BIGINT  NOT NULL,
  file_id   INTEGER,
  gen       INTEGER,
  byte_off  BIGINT,
  kind      VARCHAR NOT NULL,   -- unparsable | invalid_utf8 | oversize | constraint | other
  error     VARCHAR NOT NULL,
  line_head BLOB                -- first 64 KiB of the line (the full line is in raw store)
);
```
Append-only, never deleted. The raw line of a poison line is still stored (raw is independent of parsing). Expected rows: 0 on the real corpus (release gate asserts empty, H7); `kind='unparsable'` rows are allowed only for lines that are not valid JSON/UTF-8 (today these are silently skipped, H7). Read by: `/api/server-stats`, invariant I11.

### 4.2 Raw line store: raw_stage, raw_part, raw_index + Parquet layout

Design (D-1, CAP §3, e1/e1b): zstd Parquet parts written by the Rust `parquet` crate, 512-row groups, plus a DuckDB index `(file_id, gen, byte_off) -> (part_id, row_in_part)`; lines are staged in a DuckDB table until a part fills; reads union staging + parts. Measured: 0.138 GB per GB raw, read RSS 131 MB, point p95 4-6 ms (D-1, MEASURED by e1/e1b). Plain VARCHAR/BLOB columns are 1.7-1.96x raw and disqualified (D-1, CAP §3).

Lifecycle of a line: (1) the writer inserts it into `raw_stage` in the batch transaction (together with its derived rows and the `file.next_off` CAS), so a committed line is never lost; (2) when staged bytes reach the part target, a producer-side task (background QoS) reads the oldest staged lines, writes `p<id>.parquet.tmp`, fsyncs, renames to `p<id>.parquet`; (3) a W-MAINT transaction inserts the `raw_part` row, inserts the `raw_index` rows for those lines and deletes them from `raw_stage` (one transaction, so a line is always in exactly one of stage/index, invariant I6). A crash between rename and the transaction leaves an unreferenced part file: at startup, part files without a `raw_part` row are MOVED to `<dataDir>/raw/orphan/` (never deleted, RULE 0); their lines are still in `raw_stage` and are sealed again under a new part id.

#### raw_stage
```sql
CREATE TABLE raw_stage(
  file_id  INTEGER NOT NULL,
  gen      INTEGER NOT NULL,
  byte_off BIGINT  NOT NULL,   -- offset of the first byte of the line
  len      INTEGER NOT NULL,   -- bytes INCLUDING the terminating '\n' (contiguity invariant I4)
  batch_id BIGINT  NOT NULL,
  line     BLOB    NOT NULL    -- bytes WITHOUT the newline, byte-exact (H7; invalid UTF-8 is not mangled, CAP Q17)
);
```
Append-only apart from the seal hand-off. Bounded: <= one part target + one batch (section 6). Stored uncompressed by the engine (1.7-1.96x, CAP §3), hence the small target. Rows/bytes: <= ~15k lines / ~110 MiB on disk at a 64 MiB target (INFERRED from CAP §3 ratio and 3.1 KB avg line). Read by: `raw_lines` macros (staging half of the union).

#### raw_part (the manifest)
The manifest is this table (single source of truth); the Parquet footer of each part additionally carries key-value metadata `{part_id, schema_ver, n_rows}` so an orphan file is identifiable without the DB. No separate manifest file (one source of state).
```sql
CREATE TABLE raw_part(
  part_id        INTEGER NOT NULL,   -- from meta.next_part_id
  rel_path       VARCHAR NOT NULL,   -- relative to <dataDir>/raw/
  n_rows         INTEGER NOT NULL,
  raw_bytes      BIGINT  NOT NULL,   -- sum(len) of the lines in the part
  file_bytes     BIGINT  NOT NULL,
  sha256         VARCHAR NOT NULL,   -- hex; verified by the verifier script, not on every read
  zstd_level     INTEGER NOT NULL,   -- per part: changing the level later is data-compatible
  row_group_rows INTEGER NOT NULL,   -- 512 (D-1)
  created_ms     BIGINT  NOT NULL,
  batch_id       BIGINT  NOT NULL    -- the seal transaction
);
```
Append-only, never deleted (D-10: raw content is never deleted; a clear leaves it untouched). Rows: ~300 parts for the corpus at a 64 MiB target (INFERRED: 18.7 GB / 64 MiB), tiny.

Part file layout (D-1):
- Directory `<dataDir>/raw/<part_id/1000 zero-padded to 4>/` (at most 1000 parts per directory); file name `p<part_id zero-padded to 8>.parquet` (so `raw/0000/p00000042.parquet`); temp name `p00000042.parquet.tmp` in the same directory (no new dot folders).
- Schema: `file_id INT32, gen INT32, byte_off INT64, line BYTE_ARRAY` (no UTF8 annotation: reads as BLOB). `len` is not stored in the part (it is in `raw_index`).
- Row order inside a part: sorted by `(file_id, gen, byte_off)`: adjacent lines of one session compress together and row-group min/max statistics prune.
- Row groups: 512 rows (D-1), but the writer also closes a group at 64 MiB buffered (OPEN-O3): CAP §2g measured that a large-line group OOMs at 512 MB limit unless groups are small, and the corpus has 300 lines over 1 MB and a 4.4 MiB maximum (D-DAT-7, CAP §3), so a 512-row group can reach ~2 GB in the worst case.
- Codec: zstd; level = the level used by e1b (crate default), recorded in `raw_part.zstd_level`; the Rust bench re-confirms rg512-by-crate vs rg2048-by-COPY before freeze (D-1, OPEN-O3).
- Part target size: 64 MiB raw (proposal; bounds staging to ~110 MiB on disk). OPEN-O3.
- No line is truncated: corpus maximum 4.4 MiB (D-DAT-7). A pathological line above a hard cap (H7 proposes 256 MiB) is stored as head 1 MiB + an `ingest_error(kind='oversize')` row: cap value OPEN-O18.

Size: MEASURED 0.138 GB/GB (D-1). Corpus 18.72 GB (D-DAT-8) -> ~2.58 GB; per year ~4.3 GB @avg rate, ~19.5 GB @recent rate; spill files add 4-7 GB/yr raw (D-DAT-8) -> ~0.6-1.0 GB/yr (INFERRED: same ratio; spill content type unmeasured).

#### raw_index
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
NO index (D-ENG-2: 6.3M keys, unbounded growth, and a bulk-touch loads the whole ART): lookups `WHERE file_id=? AND gen=? AND byte_off=?` are pruned by row-group zonemaps (each seal inserts its rows sorted by `(file_id,gen,byte_off)`; ~50 row groups per 6.3M rows). Point read of a line: `raw_stage` hit, else `raw_index` -> `read_parquet(<part path>, file_row_number=true) WHERE file_row_number = :row` (row-group pruning to be confirmed, OPEN-O16). Range read of a file: `byte_off BETWEEN`. Append-only; never deleted. Rows: 6.30M (T, D-DAT-8) now, +10.6M/yr @avg, +47M/yr @recent; ~12 B/row -> ~76 MB (INFERRED). Read by: every operation that needs content (K C12-C14, C17, C18, C25, C26: `raw_lines(file_id, gen, from_off, to_off)` table macro and the `transcripts` view over it; Q29-Q31 presets use a glob over all parts in the heavy lane).

### 4.3 Tree and node facts: node_key, node, node_meta, node_rollup, root_cache, spawn_edge, spawn_result

Design (D-5, H8): immutable node facts + node_key + spawn_edge + spawn_result; parent/root/depth resolved by joins at read time (tree depth <= 3, T Q5/Q13, so two fixed LEFT JOINs, no recursive CTE); a small `root_cache` rebuilt per batch for touched roots.

#### node_key
Purpose: identity -> `nk` (D-DAT-5: node identity = file path; subagent session ids collide across parents, 408).
```sql
CREATE TABLE node_key(
  key_kind VARCHAR NOT NULL,   -- 'path' (transcript/spill-owner file path at first sight) | 'legacy' (card natural key = sessionId) | 'import'
  key_text VARCHAR NOT NULL,
  nk       INTEGER NOT NULL,
  PRIMARY KEY (key_kind, key_text)
);
```
Writer: the writer thread allocates `nk` from `meta.next_nk` on the first line of a new file (W-LIVE/W-BACK), W-LEG (kind 'legacy'), W-IMP. Never updated or deleted. A directory move changes `file.path` but not this row (H6: same file, same node). ART bounded (3.1). Rows: ~40k, ~4 MB. Read by: writer (identity lookup, legacy adoption L §4), `node_visible` view.

#### node
```sql
CREATE TABLE node(
  nk                INTEGER PRIMARY KEY,
  seq               BIGINT  NOT NULL,   -- ingest order, allocated from meta.next_node_seq (NS-1 / K FND-01); pins "start desc then seq"
  kind              VARCHAR NOT NULL,   -- main | subagent | workflow_agent | legacy | import | codex | copilot | opencode
  source            VARCHAR NOT NULL,   -- AGENT: claude_code | codex | copilot | opencode (agent filters Q1 agent/agentSources)
  origin            VARCHAR NOT NULL,   -- transcript | legacy | import   (OPEN-O13: replaces L §2's source='legacy')
  file_id           INTEGER,            -- the node's own file; NULL for legacy/import until adopted
  session_id        VARCHAR NOT NULL,   -- sessionId from the first line (else the file stem); NOT unique (D-DAT-5)
  agent_id          VARCHAR,            -- from the file name agent-<id> (D-DAT-5; links to spawn_result.agent_id)
  parent_session_id VARCHAR,            -- from the PATH: <sid>/subagents/[workflows/wf_<id>/]agent-*.jsonl (D-DAT-5 fixes the 3,137 workflow files); a string, never an nk (H8)
  created_ms        BIGINT,             -- first TIMESTAMPED line (D-DAT-6, H27); NULL until one is read
  first_seen_ms     BIGINT  NOT NULL    -- ingest clock, diagnostics
);
```
Immutable except U6 (created_ms once) and U7 (legacy adoption). Nodes with `created_ms IS NULL` are not listed as sessions (D-DAT-6: today a node with no timestamp yields no card, H8 tail). Listing order is `(created_ms DESC, nk DESC)`: both immutable, so a row never moves between pages (D-5, H9); activity/token/cost orders are capped top-N, not paged. `journal.jsonl` and `*.orphaned-*.jsonl` produce no node (D-DAT-5). Read by: every list/detail function (`node_visible`, K C01-C05, C34). Rows/bytes: ~40k, ~4 MB. Legacy nodes: `origin='legacy'`, `file_id NULL`, `source` = agent from the card (resolves L §2 "agent lost" without a view hack: OPEN-O13 asks the user to confirm because L §2/§9.1 defaulted to `source='legacy'`).

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
Read rule per key (by `(gen, byte_off)` order within the node's file; across files `(ts_ms, file_id, byte_off)`): set-once = `arg_min` (user_request, workspace = first cwd, entrypoint = first, conversation_id); latest-wins = `arg_max` (title = last ai-title, model = last non-synthetic). `initiator` flips to `agent` only while `user_request` is still empty (T/H5 `:790-800`): the writer decides from `file_ctx` and appends a row only when the effective value changes (OPEN-O21 for the exact encoding). The writer appends a row only when the value changed relative to the ctx (ai-title repeats: 4,977 rows in 558 files, T Q2), so growth is ~6 rows/node. Rows: ~200-250k, ~20 MB. Read by: `sql_summary_sessions`, `sql_cards_*` (title, workspace, model), Q1 filters (K C01-C04).

#### node_rollup
Purpose: session totals (D-3: updated in place once per batch, no PK/ART, windowed top-N scans `api_call`; compute-at-read was rejected as linear in rows). Numeric only (H10).
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
  last_active_ms        BIGINT,             -- monotone max, clamped to batch commit time + 60 s (H9/H27; value OPEN-O14)
  peak_context_per_turn BIGINT  NOT NULL    -- max
);
```
Additive (+) columns and monotone max/min only: distinct-file counts (`files*`) are not additive, so they are computed at read from `tool_use` for transcript nodes and served from `legacy_card` for legacy nodes (OPEN-O10). Cost is NOT stored: priced at `now` from the totals by the Rust pricing function (K FND-04, R decision 4). Legacy and imported nodes get their row from the card at import (L §2). Exact update: U4. Per batch the delta of a replaced `api_call` row is `new - old` (computed in the batch before the upsert, D-DAT-2), and a sibling-file duplicate (D-DAT-3/D-DAT-4: same message_id already attributed to another `nk`) contributes 0 to this node. Rows: ~40k, ~6 MB (hot rows rewritten at each checkpoint: measure bytes per checkpoint, H10). Read by: all list/aggregate functions (`sql_summary_sessions`, `sql_cards_page`, Q1/Q2/Q4/Q10/Q11, burn/window functions use `api_call` instead).

#### root_cache
Purpose: `nk -> root_nk, depth`, rebuilt (delete + insert) per batch for the touched nodes only (D-5); makes root listing and `ingest_batch_root` cheap.
```sql
CREATE TABLE root_cache(nk INTEGER NOT NULL, root_nk INTEGER NOT NULL, depth TINYINT NOT NULL, batch_id BIGINT NOT NULL);
```
Derivation (read-time semantics; the cache is a copy): `root = coalesce(gp.nk, p.nk, n.nk)` from two LEFT JOINs on `node.session_id = node.parent_session_id` restricted to `kind='main'` (main session ids are unique: 4,502 stems, none duplicated, T Q14). Unresolvable parent -> the node is its own root with a badge (H8). DERIVED, no index (~40k rows scan). Rows ~40k, ~1 MB. Read by: `sql_cards_page`, `sql_cards_children`, change feed.

#### spawn_edge and spawn_result
Purpose: the spawn taxonomy from the parent's Task/Agent/Workflow `tool_use` and its completion from the later `tool_result`, as two append-only rows linked by join (H8 "no UPDATE"; T Q5).
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
Link (view `v_spawn_link`): `spawn_edge e JOIN spawn_result r USING (parent_nk, tool_use_id)` (latest `r` by `(batch_id, byte_off)` when `async_launched` is followed by a completion), child node by `node.agent_id = r.agent_id`, with the `link_pair_ok` predicates (parent equality; transcript-has-traffic condition read from live `node_rollup`, `feed_merge.rs:171-190`) written as SQL (H8, K FND-06). A placeholder edge with no `agent_id` yet is yielded as a child with `agent_id` NULL; the `<parent>-sub-<tool_use_id>` placeholder is a pure edge row with no node (H8). No index: ~25-50k rows each. Rows/bytes: spawn_edge ~25k (23.2k subagent files, T Q5), spawn_result ~25-50k, ~5 MB total (INFERRED). Read by: `sql_sub_agent_children`, `sql_spawn_rollup`, `sql_cards_children` (K C02, C05).

### 4.4 Line content: event, api_call, tool_use, tool_result

All four are written in the same batch transaction as the lines' `raw_stage` rows and the `file.next_off` CAS.

#### event
Purpose: per-line display rows, deliberately NOT deduplicated across files: sibling subagent files legitimately show the same rows (D-DAT-3, D-4). Idempotency = the offset CAS, not a key (D-4).
```sql
CREATE TABLE event(
  file_id INTEGER NOT NULL, gen INTEGER NOT NULL, byte_off BIGINT NOT NULL, sub_index SMALLINT NOT NULL,
  nk         INTEGER NOT NULL,
  batch_id   BIGINT  NOT NULL,
  ts_ms      BIGINT,                 -- UTC ms parsed from 'YYYY-MM-DDTHH:MM:SS.mmmZ' (D-DAT-7, T Q12); NULL for untimestamped metadata types
  type       VARCHAR NOT NULL,       -- open string: new types appear every release (H7)
  subtype    VARCHAR,                -- system subtypes (compact_boundary, turn_duration, ...)
  turn       INTEGER,                -- per-turn ordinal (Q7 growth); K FND-03
  is_sidechain BOOLEAN,
  is_meta    BOOLEAN,
  message_id HUGEINT,                -- link to api_call for assistant rows (same hash as api_call.message_id)
  len        INTEGER NOT NULL,       -- line bytes (display sizes)
  compaction_trigger     VARCHAR,    -- compact_boundary (T Q4)
  compaction_pre_tokens  BIGINT,
  compaction_post_tokens BIGINT
);
```
Covers lines of type user/assistant/system/attachment (73.9% of lines carry a uuid, T Q15); metadata types (mode, last-prompt, ai-title, ...) feed `node_meta`/rollup only, and their raw line is in the raw store. No `uuid` column: parent chains are not modeled (cost counting must not dedupe by chain, T Q3). No display text column: content is read from the raw store at page time (OPEN-O5; a `text_head` column is the fallback if the bench shows point reads too slow for a 200-event page). Mutability: append-only. Retention: forever (index never shrinks, D-ENG-8; append-only design). Rows: ~4.66M (74% of 6.30M, INFERRED), ~40 B -> ~190 MB. Read by: `sql_session_timeline`, `sql_turn_growth`, `sql_conversation`, `sql_last_request_per_node`, compaction readers (K C03, C05, C11, C14).

#### api_call
Purpose: one row per API message, deduplicated GLOBALLY by `message_id` (D-DAT-3: sibling subagent files share identical rows; D-DAT-4: fork copies count once, attributed to the first-ingested session — documented delta), LAST row of a message wins (D-DAT-2: output grows across rows in subagent files; today's parser takes the first row, a bug fixed by D-12).
```sql
CREATE TABLE api_call(
  message_id      HUGEINT PRIMARY KEY,  -- 128-bit hash of message.id text (D-4: bounds ART size; collision probability negligible)
  message_id_text VARCHAR NOT NULL,     -- original 'msg_...' id (display, joins from OTEL, collision check I3)
  nk              INTEGER NOT NULL,     -- FIRST-ingested node; never changes on a later row
  file_id INTEGER NOT NULL, gen INTEGER NOT NULL, byte_off BIGINT NOT NULL, sub_index SMALLINT NOT NULL,  -- line key of the WINNING row
  batch_id        BIGINT  NOT NULL,
  seq             BIGINT  NOT NULL,     -- guard for the upsert (U5): line ts_ms; ties: larger output_tokens (OPEN-O6)
  ts_ms           BIGINT  NOT NULL,
  request_id      VARCHAR,              -- transcript requestId on ~half of assistant rows (D-DAT-10); join key to OTEL api_request
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
Both bucket conventions are exposed by the view `v_api_call` (4.7): `input_tokens` (cache-exclusive) and `input_incl_cache = input + cache_read + cache_create` (history `usage.input` is cache-INCLUSIVE, K C13), so no stored duplicate. Upsert: U5 (in-batch collapse first: duplicate keys inside one statement are silently collapsed first-row-wins even for DO UPDATE, D-ENG-3/CAP §2a). Rows whose first row has no usage: parity with today's `seen_message_ids` (a first row without usage marks the id seen, a later usage row ignored, H5/H23) lives in `file_ctx`, not in this table. A message in a SIBLING file with identical usage inserts nothing (conflict, equal `seq`); the same message in the later file with GROWN usage updates the usage columns only (nk unchanged), and the writer applies `new - old` to the OWNING node's rollup. Mutability: key never updated. Retention: forever. Rows: ~1.0M (D-4 "~1M keys"; cross-check 1.33M assistant rows x 1/1.2 rows per id, T Q2), ~110 B -> ~110 MB (INFERRED); the PK ART is the one bounded index (3.1). Read by: window/burn/forensics functions (`sql_burn_events`, `sql_cache_creation_groups`, `sql_expensive_writes`, `sql_session_burn_profile`, `sql_cache_event_log`, `sql_cost_by_cause`, `sql_billed_usage_by_hour_model`; K C07-C11, C22-C26), the windowed top-N scans (D-3), the rollup invariant I1. Day buckets are computed in Rust from a tz parameter and passed as boundaries (D-14).

#### tool_use
```sql
CREATE TABLE tool_use(
  file_id INTEGER NOT NULL, gen INTEGER NOT NULL, byte_off BIGINT NOT NULL, sub_index SMALLINT NOT NULL,
  nk INTEGER NOT NULL, batch_id BIGINT NOT NULL, ts_ms BIGINT,
  tool_use_id VARCHAR NOT NULL,
  tool_name   VARCHAR NOT NULL,
  turn        INTEGER,
  message_id  HUGEINT,           -- owning api_call
  op_kind     VARCHAR,           -- read | write | edit | search | shell | spawn | other (files* classification)
  file_path   VARCHAR,           -- for read/write/edit/search ops (distinct-file counts at read, OPEN-O10)
  input_bytes BIGINT,
  is_spawn    BOOLEAN,
  files_changed_note VARCHAR     -- claude.rs:716 (K FND-03)
);
```
No index; matched to results by `(nk, tool_use_id)` hash join at read (H5: a result can arrive any distance later; async Agent launches complete later, T Q2). Not deduplicated across files (D-4). Rows ~0.73M (INFERRED: tool_result ratio 11.5% of lines, T Q2 first-200), ~60 B -> ~44 MB. Read by: `sql_session_pool` (Q1/Q2 tool counts), `sql_instruction_inputs`, file ops in `sql_session_timeline`, `sql_cache_risk_commands` (also needs raw), `sql_spawn_rollup`.

#### tool_result
```sql
CREATE TABLE tool_result(
  file_id INTEGER NOT NULL, gen INTEGER NOT NULL, byte_off BIGINT NOT NULL, sub_index SMALLINT NOT NULL,
  nk INTEGER NOT NULL, batch_id BIGINT NOT NULL, ts_ms BIGINT,
  tool_use_id  VARCHAR NOT NULL,
  is_error     BOOLEAN,
  result_bytes BIGINT,           -- read bytes joined to tool_use.file_path (replaces pending_reads, H5)
  spill_file_id INTEGER,         -- file.file_id of the copied tool-results/ spill file (D-2); OPEN-O11
  agent_id     VARCHAR,          -- toolUseResult.agentId (T Q5)
  status       VARCHAR
);
```
Rows ~0.73M, ~40 B -> ~29 MB (INFERRED). Read by the same functions as `tool_use`.

### 4.5 OTEL, accounts, hooks, collector, call bodies

#### otel_span (SIDE)
Purpose: OTLP spans. D-6: the existing span NDJSON stays the write-ahead log (ack after append, always-200 contract kept); the DuckDB writer tails it as a `file` row (`kind='otel_ndjson'`) with its own offset, so idempotency is the offset CAS (no `(trace_id,span_id)` key: it would be an unbounded ART and retention would be a bulk delete on an indexed table, D-ENG-2).
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
  service     VARCHAR
);
```
Duplicate spans from collector retries collapse at read by `QUALIFY row_number() OVER (PARTITION BY trace_id, span_id ORDER BY received_ms DESC) = 1` (today's store behaviour for duplicates is unverified: OPEN-O8). Retention: 30 days by `received_ms` (today's behaviour, H15/H16), deleted in bounded chunks (e.g. one hour of `received_ms` per transaction) on the LIVE lane. Rows/bytes: not in the six source documents: OPEN-O8 (measure `<dataDir>` span NDJSON line count and bytes before freeze). Read by: the log-vs-OTEL merge function (K FND-06), `sql_summary_sessions` (`efficiency`/`backgroundSpans`), `sql_heartbeat_fires`, `sql_cache_event_log`, `sql_codex_trace_ids`. H8 (`/action clearAll`) deletes only this table's rows.

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
Same retention as `otel_span`. Rows/bytes: OPEN-O8. Read by: `sql_span_attr(traceId,spanId,key)` (K C33), `sql_summary_sessions`, `sql_call_context`.

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
  message_id  HUGEINT,           -- api_call.message_id when known
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
Volume and retention cannot be estimated from the sources (a request body is ~220k tokens, ctxmap evidence in the project CLAUDE.md; only captured bodies are stored, not all 1.0M calls): OPEN-O8. Proposal pending measurement: store each distinct `text` once keyed by `text_hash` (a `block_text` side table) and keep `call_block` as references. Not part of the corpus size estimate. Read by: `sql_call_context`, `sql_composition_summary`, `sql_block_content`, `sql_scope_pool`, forensics views (K C19-C26). Writer: the body-capture path of W-OTLP/W-HOOK.

#### hook_event (SIDE; NS-3)
Purpose: lifecycle-hook events replacing the in-RAM ring (K FND-08).
```sql
CREATE TABLE hook_event(
  hook_id     BIGINT  NOT NULL,   -- from meta.next_hook_id (added by the first migration that needs it; OPEN-O8)
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
Writer: W-LEG in bounded batches (a few hundred rows per transaction, one `legacy_import_run` row opened before and closed after, L §3); mutability: U7 only (`partial`, `deficit_calls`, `twin_nk`, `shadowed_*`); a close of `legacy_import_run` is one UPDATE on a 1-row-per-run table, covered by the same rule as U8 (tiny, non-indexed). Never deleted by retention, `/api/clear` or `clearAll` (L §6, D-9/D-10; every statement touching `node` carries `WHERE origin <> 'legacy'`). Rows/bytes: 5,742 rows now, 10,943,984 bytes of card JSON MEASURED (O 4 via L §1.3/§5) -> ~11-12 MB; one-off, no growth beyond re-runs on new keys (<= 40,979 total). Read by: view `node_visible`, `legacy` flavours of H32a-d, H2, H39 (`timeline: []` + `timelineTruncatedCount`), Q1/Q4/Q10 (K C01-C04, L §2.1). Legacy nodes also get a `node_rollup` row filled from the card (L §2).

### 4.7 Views and macros (re-created at every open, section 2)

| name | definition (summary) | used by |
|---|---|---|
| `node_visible` | `node` minus legacy nodes whose `legacy_card.shadowed_ms IS NOT NULL` (L §2.1: every read function reads this, never `node`) | all list/detail functions |
| `node_account` | `node` LEFT JOIN latest `account_map` per `session_id` | account functions |
| `v_api_call` | `api_call` + `input_incl_cache = input_tokens + cache_read_tokens + cache_create_tokens` and the 5m/1h tier view; both bucket conventions (K R decision 1) | burn/forensics/context-history |
| `v_spawn_link` | `spawn_edge` JOIN latest `spawn_result` JOIN child `node`, with `link_pair_ok` (H8) | tree functions |
| macro `raw_lines(file_id, gen, from_off, to_off)` | `raw_stage` UNION ALL (`raw_index` JOIN parts via `read_parquet(..., file_row_number=true)`), ordered by `byte_off`; returns `(byte_off, len, line)` | content functions, `transcripts` view (K C18) |
| macros `sql_*` | the operation-catalog functions (K §2.2), prepared with `?` parameters (CAP §2d works with persisted macros) | HTTP/MCP wrappers (D: the server is a thin wrapper over SQL functions) |

## 5. Retention summary

| table | retention | mechanism |
|---|---|---|
| raw_part, raw_index, raw_stage(after seal), legacy_*, ingest_error, file, node*, event, api_call, tool_*, spawn_*, account_*, node_meta, node_rollup | forever | append-only (D-ENG-8: DuckDB never shrinks; design is append-only so that is acceptable); raw parts never deleted (D-10) |
| file_ctx | latest 2 per file | prune delete (W-MAINT) |
| ingest_batch, ingest_batch_root | horizon (OPEN-O22; proposal 30 days) | prune delete; `meta.data_version` unaffected (H28) |
| root_cache | rebuilt per batch | delete + insert of touched `nk` |
| otel_span, otel_span_attr | 30 days by `received_ms` | bounded-chunk delete on LIVE lane (H16) |
| hook_event, call_block | OPEN-O8 | |
| collector_run | forever | tiny |

## 6. Size and memory budget

### 6.1 Corpus and growth inputs

18.72 GB, 6,302,007 lines, 27,723 files, 218 days old (CAP §3, T header, D-DAT-8). Growth: 0.086 GB/day average over the corpus age (= ~31 GB/yr, factor 1.67 of the corpus), 0.3-0.7 GB/day recently with 11.6 GB in the last 30 days (= ~141 GB/yr, factor 7.5). "@avg" and "@recent" below use those two factors; the truth lies between and must be re-measured at cutover.

### 6.2 Row and byte estimates (INFERRED unless stated; replace with bench numbers from SPEC-method-bench)

| table | rows now | rows/yr @avg | rows/yr @recent | assumed B/row | bytes now | basis |
|---|---|---|---|---|---|---|
| raw Parquet parts | 6.30M lines | 10.5M | 47M | MEASURED 0.138 GB/GB | 2.58 GB | D-1 |
| raw_index | 6.30M | 10.5M | 47M | 12 | ~76 MB | T/D-DAT-8 |
| raw_stage (transient) | <= ~15k | - | - | ~7 KB on disk | <= ~110 MB | 64 MiB target, CAP §3 1.7x |
| event | ~4.66M | 7.8M | 35M | 40 | ~190 MB | 74% of lines (T Q15) |
| api_call | ~1.0M | 1.7M | 7.5M | 110 | ~110 MB | D-4 |
| tool_use | ~0.73M | 1.2M | 5.5M | 60 | ~44 MB | T Q2 first-200 ratio |
| tool_result | ~0.73M | 1.2M | 5.5M | 40 | ~29 MB | same |
| node_meta | ~0.2M | 0.3M | 1.5M | 100 | ~20 MB | ~6 rows/node |
| node, node_key, node_rollup, root_cache, spawn_*, legacy_* | ~40k nodes (+46k/yr) | | | | ~30 MB (legacy JSON 11 MB MEASURED) | T Q5, L §5 |
| ingest_batch(+root), file, file_ctx, meta | | | | | ~20-30 MB (+ file_ctx OPEN-O15) | H28 |
| otel_*, call_block, hook_event | OPEN-O8 | | | | not estimated | |
| ART indexes (persisted) | | | | | ~25 MB | 3.1 |
| **index.duckdb steady state** | | | | | **~0.55-0.65 GB + otel/body tables** | sum |

Disk total for the corpus: ~2.6 GB Parquet + ~0.6 GB index (vs 18.7 GB source); per year ~+4.3 GB / +19.5 GB Parquet and +0.1 / +0.45 GB index. The index file never shrinks (D-ENG-8) and may grow during a checkpoint that rewrites partly-deleted row groups (CAP §10), so the deleting paths (otel/hook retention, file_ctx) are on small tables only.

### 6.3 ART budget (see 3.1; test in section 10)

Resident ART total <= 64 MiB for the first year at the average rate; `api_call` PK is the dominant term. Persisted size is not resident size: lazy load means a read-only point query touches ~1-2 MiB per index (CAP §5), a batch upsert loads the whole `api_call` index (~20 MiB today), and a bulk write against any other index would load it fully, which is why none exists.

### 6.4 Process memory budget (D-16, D-ENG-9, D-13)

`RSS cap >= index.memory_limit + Σ memory_limit of other DuckDB instances + Rust overhead + 330 MiB allocator margin`, enforced by a startup check that refuses to start otherwise.

| term | value | status |
|---|---|---|
| index.duckdb `memory_limit` | OPEN-O2 (e.g. 512 MiB) | fixed by bench (D-15/D-16) |
| other instances (in-memory summary, transcript heavy slot 1 GiB, bodies pass, cards.duckdb which the new engine does NOT open, L §7) | stated limits of `session_summary_sql.rs`, `transcript_sql.rs:27-29`, `bodies_evidence.rs` (H14) | to be summed once at startup; retire as K cards C01-C27 land |
| Rust overhead (queues, ctx, parser buffers, byte-bounded writer queue D-7) | OPEN-O2 | measured by bench |
| allocator/appender margin | 330 MiB | D-ENG-9, D-16 (MEASURED 120-330 MB over the limit) |
| WAL replay at open | <= ~16 MB WAL x ~1 GB RSS/GB = ~16 MB | D-ENG-7 MEASURED rule |
| RSS cap (interim) | 4096 MB | D-13 (SPEC-interim-stabilization) |
| Parquet point read | 131 MB read RSS | D-1 MEASURED |
| appender 2M rows at memory_limit 512 MB | RSS 206-253 MB; GROUP BY 631 MB | CAP §2g MEASURED |

## 7. Retention of the "never delete" promises (RULE 0 mapping)

`/api/clear` (H7), `/action clearAll` (H8), retention and migrations never delete raw parts, `raw_part`, `raw_index`, `raw_stage`, `legacy_card`, `legacy_import_run`, `ingest_error`, `file` (D-10, L §6). Orphan part files are moved aside, never deleted (4.2). The old `cards.duckdb`, NDJSON snapshot/delta and `log-offsets` files are not touched by this schema (L §7).

## 8. Clear and rebuild classes (D-10, H4)

`POST /api/clear` builds `index.duckdb.next` with the same DDL, copies RAW tables (including `file`, `raw_*`, `legacy_*`, `ingest_error`, `ingest_batch*`, `meta` with `data_version` raised by 1 and `clear_epoch` + 1), re-derives every DERIVED table from `raw_lines` + `legacy_card`, carries SIDE tables over except `otel_span`/`otel_span_attr` (today's clear drops cards and spans: OPEN-O12 confirms carrying `hook_event`, `account_*`, `call_block`, `collector_run`), then swaps by rename, keeping the old file as `index.duckdb.pre-clear-<UTC stamp>` (H4 fix: no DELETE against indexed tables, so the over-eager unique-constraint trap cannot occur). Every batch carries the epoch it was read under; the writer drops a stale-epoch batch and U1 is the second line of defence. `data_version` never decreases across a clear (H17). `/action clearAll` = chunked `DELETE FROM otel_span`/`otel_span_attr` only (H4 fallback, K C31).

## 9. Invariants (SQL; each returns ZERO rows when it holds; run after every test and at boot in the soak, L §7)

```sql
-- I1 rollup == aggregate over api_call for every transcript/import node (legacy nodes are card-filled)
SELECT r.nk FROM node_rollup r JOIN node n USING (nk)
LEFT JOIN (SELECT nk, count(*) c, sum(input_tokens) i, sum(output_tokens) o, sum(cache_read_tokens) cr,
                  sum(cache_create_tokens) cc, sum(coalesce(cache_create_1h,0)) c1, count(cache_create_1h) k1
           FROM api_call GROUP BY nk) a USING (nk)
WHERE n.origin <> 'legacy'
  AND (r.n_api_calls <> coalesce(a.c,0) OR r.input_tokens <> coalesce(a.i,0) OR r.output_tokens <> coalesce(a.o,0)
    OR r.cache_read_tokens <> coalesce(a.cr,0) OR r.cache_create_tokens <> coalesce(a.cc,0)
    OR r.cache_create_1h_tokens <> coalesce(a.c1,0) OR r.n_calls_1h_known <> coalesce(a.k1,0));
-- I1b every non-legacy node has a rollup row only if it has lines; rollup nk exists
SELECT nk FROM node_rollup WHERE nk NOT IN (SELECT nk FROM node);
-- I2 api_call attribution exists
SELECT message_id FROM api_call WHERE nk NOT IN (SELECT nk FROM node);
-- I3 hash has no collision on this corpus
SELECT 1 WHERE (SELECT count(DISTINCT message_id) FROM api_call) <> (SELECT count(DISTINCT message_id_text) FROM api_call);
-- I4 byte contiguity: lines of each (file,gen) tile [0, next_off) exactly (stored lines incl. newline)
WITH l AS (SELECT file_id, gen, byte_off, len FROM raw_index UNION ALL SELECT file_id, gen, byte_off, len FROM raw_stage)
SELECT f.file_id, f.gen FROM file f LEFT JOIN
  (SELECT file_id, gen, sum(len) s, count(*) c, count(DISTINCT byte_off) d, min(byte_off) m FROM l GROUP BY 1,2) x
  ON x.file_id=f.file_id AND x.gen=f.gen
WHERE f.next_off <> coalesce(x.s,0) OR coalesce(x.c,0) <> coalesce(x.d,0) OR coalesce(x.m,0) <> 0;
-- I4b no gaps: each line starts where the previous ends
WITH l AS (SELECT file_id, gen, byte_off, len FROM raw_index UNION ALL SELECT file_id, gen, byte_off, len FROM raw_stage)
SELECT file_id, gen, byte_off FROM (SELECT *, lag(byte_off+len) OVER (PARTITION BY file_id, gen ORDER BY byte_off) AS e FROM l)
WHERE e IS NOT NULL AND e <> byte_off;
-- I5 index <-> manifest
SELECT p.part_id FROM raw_part p LEFT JOIN (SELECT part_id, count(*) c, sum(len) s FROM raw_index GROUP BY 1) i USING (part_id)
WHERE p.n_rows <> coalesce(i.c,0) OR p.raw_bytes <> coalesce(i.s,0);
SELECT part_id FROM raw_index WHERE part_id NOT IN (SELECT part_id FROM raw_part) LIMIT 1;
-- I6 a line is in exactly one of stage/index
SELECT s.file_id FROM raw_stage s JOIN raw_index i USING (file_id, gen, byte_off) LIMIT 1;
-- I7 version counter
SELECT 1 WHERE (SELECT value_int FROM meta WHERE key='data_version') < coalesce((SELECT max(batch_id) FROM ingest_batch),0);
SELECT 1 WHERE (SELECT max(epoch) FROM ingest_batch) > (SELECT value_int FROM meta WHERE key='clear_epoch');
-- I8 schema version = binary maximum (supplied as :max_version)
SELECT 1 WHERE (SELECT value_int FROM meta WHERE key='schema_version') <> :max_version;
-- I9 exactly one rollup row per node that has one
SELECT nk FROM node_rollup GROUP BY nk HAVING count(*) > 1;
-- I10 derived rows reference nodes
SELECT 1 FROM event WHERE nk NOT IN (SELECT nk FROM node) LIMIT 1;
SELECT 1 FROM tool_use WHERE nk NOT IN (SELECT nk FROM node) LIMIT 1;
-- I11 dead letters (release gate on the real corpus; fixtures may expect rows)
SELECT * FROM ingest_error WHERE kind <> 'unparsable';
-- I12 legacy rows are whole
SELECT natural_key FROM legacy_card WHERE nk NOT IN (SELECT nk FROM node);
SELECT nk FROM node WHERE origin='legacy' AND nk NOT IN (SELECT nk FROM legacy_card);
-- I13 file_ctx pruned
SELECT file_id, gen FROM file_ctx GROUP BY 1,2 HAVING count(*) > 2;
-- I14 index inventory: only the allowlisted ART indexes exist (D-ENG-2)
SELECT table_name FROM duckdb_constraints() WHERE constraint_type IN ('PRIMARY KEY','UNIQUE')
  AND table_name NOT IN ('meta','file','node','node_key','api_call','legacy_card');
SELECT table_name FROM duckdb_indexes();   -- must be empty (only constraint-backed indexes)
-- I15 type policy (D-ENG-10/D-14): no FLOAT/DECIMAL/TIMESTAMP/DATE/ENUM/LIST column
SELECT table_name, column_name FROM duckdb_columns()
WHERE data_type ILIKE 'FLOAT%' OR data_type ILIKE 'DECIMAL%' OR data_type ILIKE 'TIMESTAMP%' OR data_type ILIKE 'DATE%'
   OR data_type ILIKE 'ENUM%' OR data_type ILIKE '%[]';
-- I16 stage bounded
SELECT 1 WHERE (SELECT coalesce(sum(len),0) FROM raw_stage) > :stage_cap_bytes;
```
Not expressible in SQL (checked by scripts): the independent line census (count newlines with a `wc`-style pass over the files, NOT from stored offsets, then compare with `count(raw_index)+count(raw_stage)`; H29: a census from the same offsets is circular), the Parquet sha256 verification, and legacy token sums vs the frozen NDJSON (L §5).

## 10. Test list (real files and a real DuckDB, no mocks; file name proposal `rust-core/crates/agentlens-core/tests/index_schema.rs`)

1. `ddl_applies_on_empty_db`: open a new file, apply all steps; assert 29 tables, the 6 PK constraints, 4 views, macros exist; apply the idempotent macro/view script twice with no error; `schema_version` = binary maximum; `meta` seeded keys present.
2. `settings_fail_fast`: with autoload off, a build lacking `json` or `parquet` fails the startup self-test with a clear error (simulated by running the self-test against a connection where the extension is unloadable is not possible; instead assert `to_json` and `read_parquet` work with `autoload_known_extensions=false` in the shipped binary).
3. `migration_from_each_version`: for every shipped version N, build a fixture DB at version N (kept in the repo as a generated-by-script file or built by replaying the N-version DDL), fill with the fixture corpus, run the migration to the latest, assert invariants I1-I16, row counts equal, RAW rows byte-identical, the pre-migrate clone exists, and `meta.schema_version` advanced exactly one step per transaction.
4. `migration_crash_resumes`: failpoint inside a step; reopen; the previous version is intact (single transaction) and the re-run completes.
5. `migration_refuses_newer`: a DB at max+1 makes the binary exit with an error naming both versions and leaves the file untouched; an unreadable DB is renamed aside, never deleted.
6. `alter_on_indexed_tables` (closes OPEN-O9): `ADD COLUMN` on each of the six PK tables with data; record which succeed.
7. `invariants_hold_on_fixture`: ingest a fixture of real small transcripts (main + sibling subagent pair with identical rows + a growing-usage pair + a fork-copy pair + a workflow agent file + a journal.jsonl + an untimestamped-first-line file + a poison line) through the real writer; assert I1-I16, and the specific facts: sibling pair counts once (D-DAT-3), growing usage keeps the last row (D-DAT-2), fork copy attributed to the first node (D-DAT-4), workflow file gets `parent_session_id` (D-DAT-5), journal.jsonl yields no node, `created_ms` = first timestamped line (D-DAT-6), poison line is in `ingest_error` and its raw line is stored.
8. `rollup_equals_aggregate_under_rewrites`: random batches including replaced usage rows and cross-file duplicates; I1 after every commit.
9. `cas_offset_and_epoch`: two producers on one file via failpoint interleaving: the loser's UPDATE returns 0 and rolls back; a batch read under an old epoch is dropped; a clear between read and commit loses nothing (H3, H4).
10. `rotation_new_gen`: replace a file (new inode / changed head / missing newline at offset-1): `gen+1`, `next_off=0`, old-gen raw lines and `api_call` rows kept, no duplicate tokens (D-DAT-1, H6).
11. `seal_part_crash`: kill between Parquet rename and the seal transaction: reopen moves the orphan part aside, lines are re-sealed, I4-I6 hold; Parquet footer metadata `{part_id, n_rows}` matches `raw_part`.
12. `raw_roundtrip_bytes`: every stored line (including invalid UTF-8, a 4.4 MiB line, a 1-byte line) reads back byte-exact through `raw_lines` from stage and from a part; a point read p95 is asserted against the D-1 figure (4-6 ms) as a bench, not a hard gate.
13. `art_budget`: insert 1M synthetic `api_call` keys (HUGEINT), checkpoint, reopen, run a batch upsert touching 50k random keys; assert `SELECT sum(memory_usage_bytes) FROM duckdb_memory() WHERE tag='ART_INDEX'` <= the budget of 3.1, assert RSS growth, and assert the startup warning at 50% and refusal at 100% of the key budget (D-ENG-2: never an OOM).
14. `no_bulk_write_on_indexed_tables`: static scan of the Rust SQL strings: every `UPDATE`/`DELETE` statement text must match the U1-U8 / DELETE allowlist of 3.3; any other fails the test.
15. `appender_duplicate_collapse`: stage duplicate message_ids in one batch: the in-batch `QUALIFY` leaves one row; an existing key with larger `seq` updates, equal/smaller `seq` does not (D-ENG-3).
16. `clear_side_by_side`: `/api/clear` equivalent on a fixture: raw parts, `legacy_card`, `ingest_error`, `data_version` monotone, `clear_epoch+1`, DERIVED tables identical to a clean ingest (checksums), old file kept (D-10, H4, H17).
17. `legacy_rows_survive_clear_and_adoption`: import a legacy card, clear, then add a transcript for the key: same `nk` kept, `origin` flips, `shadowed_ms` set, legacy row still present (L §4, §6, §8 tests 3 and 8).
18. `retention_chunks`: `otel_span` retention deletes in bounded transactions and never touches `legacy_*`/RAW tables; `ingest_batch` prune leaves `data_version` untouched (H28).
19. `type_policy_and_json_golden`: I15 plus a golden comparing `to_json` of every exposed column type with serde output (D-ENG-10).
20. `wal_replay_budget`: kill -9 with a 16 MB WAL, reopen, assert replay time and RSS under the figures of D-ENG-7.
21. `writer_restart_state`: `data_version`, `next_*` counters and `file_ctx` resume reproduce the same state after kill -9 x N (compare checksums to a clean single pass, H29 U4), including a batch ending between a tool_use and its tool_result (H5).
22. `second_process_lock`: a real second process opening `index.duckdb` is refused and the error names the holder; the file is not deleted or renamed (D-11, H1, H14).

## 11. OPEN items (not decided by D or the reports; each needs a measurement or a user decision)

| id | open question | default used above | settles with |
|---|---|---|---|
| O1 | storage version string (default `v0.10.2` vs a named newer one) | engine default | bench: index size and checkpoint cost |
| O2 | `memory_limit`, `threads`, `preserve_insertion_order`, Rust overhead numbers | 512 MiB / 2 threads | SPEC-method-bench, D-16 startup check |
| O3 | part target size, zstd level, row-group byte cap, C1 (crate rg512) vs C2 (COPY rg2048) | 64 MiB, e1b level, 64 MiB cap | Rust bench re-confirm (D-1) |
| O4 | visibility of display rows of an old gen (current gen only vs all) | raw + api_call all gens, display current gen | contract review with CONTRACT-DELTA |
| O5 | `event` text column vs raw fetch at page time | no text column | bench of a 200-event page |
| O6 | exact `api_call.seq` and tie-break | line `ts_ms`, ties larger `output_tokens` | FND-03 golden |
| O7 | cause columns for Q38-Q40/C07; O7b `n_turns` vs `n_llm_calls` parity | one nullable column; both counters | R sections not read here; FND-03 golden |
| O8 | volume, row shape and retention of `otel_span`, `otel_span_attr`, `call_block`, `hook_event`; duplicate-span behaviour | 30 days for spans; hook 30 days | measure the live span NDJSON and hook ring; sources not among the six read |
| O9 | `ALTER ... ADD COLUMN` on tables with a PK | create+copy+rename | test 6 |
| O10 | non-additive `files*` counters | read-time over `tool_use`; legacy from card JSON | bench; K C04/C06 golden |
| O11 | spill-file layout and its link to `tool_result` | `file.kind='spill'`, `session_hint`, `tool_result.spill_file_id` | reports/DUCKPLAN e5-spill-and-images (not read here) |
| O12 | which SIDE tables a clear carries over | all but `otel_*` | user, with CONTRACT-DELTA D11 |
| O13 | `node.origin` separate from `node.source` | separate column | user confirmation (L §9.1 defaulted to source='legacy') |
| O14 | `last_active_ms` clamp | commit time + 60 s | H9/H27 review |
| O15 | `file_ctx.ctx` encoding and size bound | BLOB | measure ctx size on the real corpus |
| O16 | row-group pruning of `file_row_number` filters in `read_parquet` | assumed (D-1 point p95 4-6 ms measured) | bench |
| O17 | `account_state` column set | minimum from K §3 | FND-09 |
| O18 | per-line hard cap | none observed (4.4 MiB max); H7 proposes 256 MiB | decide with the writer card |
| O19 | read-only enforcement for SQL exposed by Q29-Q31 on `try_clone` connections | not specified here | SPEC-read-api |
| O20 | escape hatch when `api_call` PK passes the ART budget | anti-join on a sorted table | revisit at 50% of budget |
| O21 | encoding of the `initiator` flip rule in `node_meta` | effective-value rows | writer card |
| O22 | `ingest_batch` retention horizon | 30 days | change-feed requirements |
