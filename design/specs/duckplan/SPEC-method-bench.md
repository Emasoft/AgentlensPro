---
title: DuckDB-index redesign - method benchmark (two infrastructure choices first, then each operation gets its measured best method)
status: draft (revision 1, 2026-10-03)
scope: project
sources: design/specs/duckplan/SPEC-operation-catalog.md; docs_dev/duckplan-decisions.md; docs_dev/duckplan-decisions-r1.md (R1 wins); reports/DUCKPLAN/20261003_185350+0200-e1-raw-storage.md, 20261003_190622+0200-e1b-raw-storage-settle.md, 20261003_185422+0200-e2-rollup.md, 20261003_190033+0200-e3-dedup.md, 20261003_185312+0200-e4-tree-paging.md, 20261003_190027+0200-e5-spill-and-images.md, 20261003_192823+0200-duckdb-capabilities.md; E6 (ART memory at scale) when it lands
---

# Method benchmark: two infrastructure choices first, then the best method per operation, measured on the real stack

Owner rule (verbatim, decision log): "each operation the best method: less ram used, less cpu if ram is equal." Tie on both: the simplest / most DuckDB-native method ("everything must be handled by duckdb. the server should be a thin wrapper over duckdb and the sql functions"). The bench therefore has two stages:

- **Stage 0 - infrastructure.** Settles the two choices the decision log left OPEN in R1: **R1-D1** (raw-line storage: D in-DB zstd, C1 DuckDB `COPY` Parquet, C2 Rust `parquet` crate) and **R1-D4-ART** (how `api_call` uniqueness is enforced). They fix schema, write protocol and memory budget, so no per-operation work starts before both are decided (section 1).
- **Stage 1 - per operation.** Every write path and read function of the operation catalog (`SPEC-operation-catalog.md`; the count of 126 is the previous draft's and was NOT re-verified in this revision) is implemented in each viable method and measured; the winner is wired per operation (sections 2-6).

It decides nothing by itself: the numbers do.

## 0. Measured pitfalls (what the experiments actually showed, and what the harness does about each)

| pitfall (source) | consequence in this spec |
|---|---|
| Machine load: ~190 at the start of the capabilities work (a 1.8 s awk loop took 80 s, i.e. ~2% of a core); 36-74 during E1b (round means 74 down to 36); background QoS (`taskpolicy -b`) inflates wall ~30x at equal CPU (975 vs 30,400 lines/s; 7.9 vs 5.0 CPU-s/GB); `nice -n 19` builds starved | run at NORMAL QoS with a modest `nice` (header states the value; never `taskpolicy -b`, never `nice -n 19` for a measured cell); record load at start and end of every cell (section 3.7); CPU-seconds and byte counts are load-independent (capabilities section 4), latency and wall are not, so latency verdicts use quiet cells only and RAM/CPU verdicts use all cells |
| Python harness RSS: 47 MB (E4), 75 MB (E3), 192 MB (E1 read+decode baseline), ~245 MB (E2) of baseline; E1 builds ran ~1.2 GB above `memory_limit` from Arrow copies; E1b "RSS read" 131-283 MB includes the Python baseline | the harness is a Rust binary on the real stack; every RSS figure in D-1 (131 MB) and in E1/E1b/E2/E3/E4 is a Python figure and is a hint, never a decision input |
| RSS spreads under ~10% are noise (E2: 346-381 MB across 7 options, baseline moves 8 MB run to run) | the tie rule uses a noise floor MEASURED by the harness on identical-method pairs (section 4.3), not an assumed 2%; decision D-3 relied on the 10% tie, this spec's former 2% floor contradicted it |
| 3 rounds cannot decide a p95 gate (E1: C cold p95 73.5, 78.4, 10.9 ms); E1b used 10 interleaved rounds and still saw first-rounds (high load) own most p95 maxima | at least 20 paired rounds for small cells, 7 for expensive ones; latency from quiet cells only |
| E2 scaled 236 real sessions (82,560 unique message ids) by a 12x SYNTHETIC replication to 990,720 `api_call` rows / 60,504 sessions (the 41k target is exceeded); `tool_calls` and `errors` are synthetic, tokens and timestamps real | frozen data is the real index (section 3.2); synthetic variants are labelled SYNTHETIC; the scale guard of section 4.7 exists because E2's winner (C_noidx) reads by scanning `api_call`, linear in rows |
| `memory_limit` covers only DuckDB-managed memory: process RSS ran 120-330 MB above it (D-ENG-9, capabilities 2g: 631 MB at a 512 MB limit); ART nodes are counted but not evictable and an OOM is FATAL (D-ENG-2) | peak memory is the process high-water mark, never the limit; a FATAL OOM is a cell result (`FATAL`), not a harness error |
| `to_json` differs from serde for |x| >= 1e16, FLOAT, NaN/Infinity, DECIMAL, TIMESTAMP, BLOB; `to_json(row(..))` emits empty keys (D-ENG-10, capabilities 2e); `to_json` is NOT statically linked today and autoloads from the network (D-ENG-1, capabilities 16: every to_json/parquet measurement so far used the autoloaded official extension) | the bench binary enables the `json` and `parquet` crate features and sets `autoload_known_extensions=false; autoinstall_known_extensions=false`; the header proves it (`duckdb_extensions()` lists them as built in) or the run does not start; O1 shapers obey the D-ENG-10 type rule |
| pyarrow default Parquet writer is a trap: dictionary on + low zstd level gave 0.207 GB/GB; `compression_level=3, use_dictionary=False` gave 0.138 (E1b) | the Rust `parquet` crate writer properties are set explicitly (zstd level 3, dictionary off, 512-row groups) and printed in the header; the crate itself is UNMEASURED so far: every C2 number in the decision log is pyarrow |
| DuckDB `COPY` cannot write row groups under 2048 rows (E1b: ROW_GROUP_SIZE 512 and 100, with and without ROW_GROUP_SIZE_BYTES + preserve_insertion_order=false, all gave 2048); a 512 MB limit OOMed on 3 KB-line rows until ROW_GROUP_SIZE 5000 + preserve_insertion_order=false (capabilities 2g) | C1 is only the 2048-row variant; with `preserve_insertion_order=false` a Parquet row number is not an insertion position, so parts must be self-describing and looked up by column filter (section 1.1) |
| Appender is not idempotent; in-statement duplicate keys collapse FIRST-ROW-WINS even for DO UPDATE (D-ENG-3); Appender supports no LIST parameter (capabilities 1) | every upsert batch is staged and pre-collapsed with `QUALIFY row_number() OVER (PARTITION BY key ORDER BY seq DESC) = 1`; candidate W1 does NOT use an Appender (section 2.1) |
| Commits use plain `fsync`, not F_FULLFSYNC (D-ENG-6, capabilities 15: commit p50 0.12 ms) | durability cost is compared like for like in Stage 0 (section 1.1.4) |

## 1. Stage 0: infrastructure choices (before any per-operation work)

Common setup: same Rust harness, header settings and statistics as Stage 1 (sections 3-4). Inputs are the real corpus and real spill files, not synthetic, except where labelled SYNTHETIC. The per-operation rule is the owner's: lowest peak memory, then lowest CPU, tie -> DuckDB-native / simplest. Disk is NOT in the owner rule: it is reported, and used only as a disqualifier (a layout above 1.0x raw bytes is out: E1 measured plain VARCHAR/BLOB at 1.7-1.96x raw, capabilities 1.74x, and the volume has ~76 GB free at 96% used, E5) and as a tie-breaker note. The earlier E1b "lowest disk first" criterion is NOT the owner's rule and is not used.

### 1.1 R1-D1 raw-line storage

Candidates:

| id | method | measured so far (all Python harness) |
|---|---|---|
| D | `lines(file_id, byte_off, line BLOB)` inside DuckDB, `STORAGE_VERSION latest` + `force_compression='zstd'`; transactional, no staging, no part files | disk 0.222-0.227 GB/GB; CPU 19.8-22.4 CPU-s/GB in Python vs 11.5 CPU-s/GB with a Rust Appender (capabilities 4) vs 5.0 uncompressed; point p95 cold 8.4-12.8 ms; heaviest tails (warm single-round p95 up to 226 ms) |
| C1 | zstd Parquet parts written by DuckDB `COPY` (row groups of at least 2048 rows) + index table | 0.128 GB/GB; CPU 5.8; point p95 cold 12.4 (9.3 low-load) ms |
| C2 | zstd Parquet parts written by the Rust `parquet` crate (512-row groups, level 3, dictionary off) + index table | 0.138 GB/GB; CPU 5.4 direct, 7.0-8.2 through staging; point p95 cold 6.2 (4.6 low-load) ms; the Rust crate has NOT been run |

Shared design (from R1-D1): lines are staged in a DuckDB table until a part fills; reads union staging and parts; parts are self-describing (file_id, gen, byte_off, path columns) so the index can be rebuilt from parts alone; a row-group BYTE cap bounds writer memory. Lines are stored as BLOB / BYTE_ARRAY in all candidates (lossless: VARCHAR mangles invalid UTF-8 into escaped text, E1 and capabilities Q17; BLOB cost no extra disk, E1b D2 0.223 vs D1 0.222).

Scope pitfall to test, not assume (INFERRED): `force_compression` is a connection/database setting; applying it to the whole index instance would also force zstd on every integer column. D must be measured with the raw table in its own attached database file (or prove the setting is table-local).

#### 1.1.1 Workloads (real data)

1. **Ingest replay**: the same ~1 GB newest sample used by E1/E1b/E3 (1,237 files, ~281k lines; path list and SHA-256 recorded; the sample grows while sessions are live, so the list is frozen by file and byte length), batches of 2,000 lines or the byte cap, whichever first, through the real writer thread. Measure peak memory, CPU-s/GB, disk bytes, bytes of WAL, wall.
2. **Adversarial row-group workload (SYNTHETIC ordering of REAL lines)**: the 300 real lines above 1 MB (corpus max line 4,575,124 bytes, capabilities 3) arranged contiguously, to expose an unbounded row group: 512 rows x 4.58 MB = 2.34 GB (C2 without a byte cap) and 2048 rows x 4.58 MB = 9.37 GB (C1, whose minimum row group is 2048 rows). The byte cap must hold writer peak under the budget; C1 must be shown to do the same by `ROW_GROUP_SIZE_BYTES` / limits, or it is out.
3. **Spill files (E5)**: the real `tool-results/` set (46,632 files, 940 MB: p50 3.9 KB, p99 125.6 KB, max 64 MiB; 142 are binary `.jpg`), stored through the same path (D-2). A single value up to 64 MiB cannot be split by a row-group cap: the writer memory bound for that case is part of the measurement.
4. **Reads**: 200 random point reads cold (fresh connection) and warm, 10 x 200-line ranges, and the union read (staging hit, staging miss then index then part) with staging holding ~10,000 rows / 32 MB (E1b method, now in Rust). `first_call_ms` recorded. Fixed seed; identical across candidates.
5. **Invalid UTF-8 round trip**: lines with 0xFF/0xFE bytes (SYNTHETIC injection, none in the corpus) must come back byte-exact.
6. **Snapshot divergence (backup disk cost, R1-ENG6)**: the index (+ parts) is the only copy of deleted transcripts, so it is snapshotted by APFS clone into a rotating set of 3 (daily and after backfill). A clone shares blocks until they are rewritten; a DuckDB file rewrites blocks at every checkpoint (and a checkpoint can even grow the file, capabilities 10), so a clone of `index.duckdb` can diverge toward 1x the database size per snapshot over days, while immutable Parquet parts are never rewritten and clone for free. Measured per candidate: take an APFS clone (`cp -c`) of the whole store after workload 1, then apply N further batches (N = 10, 50, 250 batches of 2,000 lines, each batch committed, `CHECKPOINT` after each N) to the live store, and record the bytes the clone no longer shares with the live store (clone-divergence bytes, from the volume's free-space delta and per-file allocated blocks, `du`-style) and the live store's own growth. Report divergence as a fraction of the store size for each N and the projected disk cost of 3 retained snapshots over 7 days at 0.3-0.7 GB/day raw growth (D-DAT-8). Tooling caveat: shared-block accounting on APFS is not exposed by `du`; the harness derives it from the free-space delta of the volume before and after, and the number is reported with that method named.

#### 1.1.2 Byte-capped row group

The writer closes a row group at `min(rows_cap, bytes_cap)` (512 rows or `bytes_cap`, e.g. 32 MiB: a proposal; the bench measures 8, 32 and 128 MiB for C2 and reports writer peak and read p95 for each). A row larger than the cap forms its own row group.

#### 1.1.3 Crash-consistency protocol (C1 and C2 carry it; D has it from the WAL)

Protocol under test (R1-D1): write part to a temp name; `fsync` the file; `rename`; `fsync` the directory; then ONE transaction inserts the index rows and deletes the staged lines; on startup, reconcile the part manifest against the files on disk (orphan part -> removed or adopted; index row without part -> rebuilt from the self-describing part or quarantined).

Measured per part: wall and CPU of each step, and the same totals for D's commit. Crash injection: a `kill -9` at each of the protocol's steps (after temp write, after file fsync, after rename, after directory fsync, mid-transaction, after commit before staging cleanup is visible) on a real slice, then reopen; asserted: no lost line, no duplicated line, reconcile ends with every part referenced exactly once. INFERRED, to be measured: Rust `File::sync_all` on macOS issues `F_FULLFSYNC`, while the bundled DuckDB commit uses plain `fsync` (D-ENG-6); if so the part steps pay a real drive-cache flush that D's WAL commit does not, and the comparison must say it rather than hide it.

#### 1.1.4 Metrics and decision

Per candidate: peak memory (writer, ingest of workload 1 and 2; reader, workload 4), CPU-s/GB, disk GB/GB, snapshot divergence bytes (workload 6) and the resulting backup disk cost, point and range p50/p95, crash-protocol cost per part. The snapshot cost is a MEASURED criterion that adds to the disk figure: a candidate's total disk = live store + retained snapshots, so D (whose clones diverge with checkpoints) is not compared with C1/C2 on live size alone. It remains a report-and-disqualify criterion, not a rank: the owner rule order is unchanged, least RAM first, then least CPU, and "prefer DuckDB-native" applies only on a full tie of both; the only effect of disk is the disqualifier below. Disqualifiers: any lost or duplicated line, any non-byte-exact round trip, any crash-injection failure, writer peak above the budget of D-16 on workload 2 or 3, point-read p95 above 50 ms on quiet cells (the E1 gate; E1b: all six variants passed), layout above 1.0x raw bytes, projected total disk (live + 3 retained snapshots over 7 days) above the budget stated in the header (free disk is ~76 GB at 96% used, E5). Winner: lowest `peak_mem` (reader and writer both reported; the decision uses the writer ingest peak because that is the memory held while live ingestion runs, and the reader peak is reported next to it), then lowest CPU, tie (statistics of section 4) -> DuckDB-native: D, then C1, then C2 (R1-D1). Output: `reports/DUCKPLAN/<timestamp>-bench-infra-d1.md`.

### 1.2 R1-D4-ART `api_call` uniqueness

`api_call` is unique on (source, message_id); usage fields are updated only by a later row of the SAME file (R1-D4 c); rollup deltas come from rows the batch actually applied (R1-D4 d). Growth is ~5-9M keys per year (R1; the corpus holds ~0.9M message ids now: 47,686 per ~1 GB in E3). E3 measured PK + ON CONFLICT only at 47,686 keys; E2 only at ~1M; nothing measured the ART at 5M+. E6 is the planned experiment; the Rust bench measures the same points and E6 is an input, not a substitute (E6's harness language decides whether its memory figures count).

Candidates:

| id | mechanism |
|---|---|
| ART | PRIMARY KEY on a 128-bit key (HUGEINT, or UUID type as the 16-byte alternative; E3: UUID key -13% CPU vs VARCHAR at equal RSS, 64-bit hash -31% CPU but silent-collision risk) with `INSERT ... ON CONFLICT DO UPDATE ... WHERE excluded.file_id = api.file_id AND excluded.byte_off > api.byte_off` from a staged, pre-collapsed batch |
| ANTI | no index: anti-join of the batch against `api_call` restricted by a timestamp window |
| PART | monthly key partitions (one table or one PK per month), batch routed by month |

Preconditions that are NOT yet verified and are checked first: (a) ANTI is only valid if duplicates share the exact timestamp (R1-D4 text); D-DAT-2 says a growing subagent row of the same message.id is a later row, which may carry a later timestamp, so the window width must be derived from the real data (max gap between duplicate rows of one message id), not assumed zero; (b) duckdb-rs binding of a 128-bit key: the Appender/ToSql list in capabilities 1 names no 128-bit integer type, so HUGEINT/UUID binding is tested, with a fallback of two BIGINT columns as a fourth candidate only if both fail.

Workloads: synthetic random 128-bit keys at 1M, 5M and 20M (SYNTHETIC, labelled; real keys exist only at ~0.9M), plus the real ~0.9M; for each: (1) resident ART memory after open (`duckdb_memory()` ART_INDEX tag) and process peak; (2) memory after one 2,000-row batch (lazy load: capabilities 5 measured a point read at ~1-2 MB per index and a bulk DELETE at 1.65 GB for six indexes; a 2,000-key upsert batch is the unmeasured case that decides everything); (3) whether `CHECKPOINT` releases ART memory or only a reopen does; (4) insert CPU per 1M rows; (5) re-read of the same slice: zero rows added and zero rows updated (changed-row counts, D-ENG-5); (6) cross-file duplicate (sibling subagent file, fork copy) never reassigns or re-counts; (7) a same-file later row updates usage; (8) the memory limit set to the production value, where a FATAL OOM (handle invalidated, capabilities 5) is a `FATAL` disqualification, not a skipped cell.

Disqualifiers: any row added or changed by a re-read; any reassignment by a cross-file duplicate; `FATAL`; resident ART above a budget stated in the header at 20M keys (D-ENG-2 requires a measured bound for any index on a corpus-growing table). Winner: lowest `peak_mem` at 5M keys (the one-year horizon), then lowest CPU, tie -> ART (DuckDB constraint, one statement) over ANTI over PART, but only if ART passes the bound. Output: `reports/DUCKPLAN/<timestamp>-bench-infra-d4art.md`.

### 1.3 Stage 0 gate

Both decisions are recorded in `methods.toml` under an `[infra.*]` namespace (section 5) and in the two reports; the schema spec, the writer spec and the memory budget (D-16, R1-BUDGET: the writer spec sums to 2,226 MiB against the 2,048 MiB cap, so the startup check needs the interim 4,096 MiB cap or a smaller sum from this bench) are updated from them before Stage 1 starts. The measured `overhead_over_limit_mb` of the winners feeds D-16.

## 2. Stage 1: candidate methods and the pruning stage

### 2.1 Candidates

Writes (the W operations: HTTP POST ingest, hook events, statusline, import, clear, and the log-reader and OTLP ingest paths):

| id | method |
|---|---|
| W1 | Rust prepared statement per row (or small group) with `INSERT ... ON CONFLICT`, no Appender; starting shape is the R1-D4 upsert (seq / same-file guard), NOT E3 option A (a PK on every line key, which D-4 rejected for display rows because of ART memory) |
| W2 | Rust-registered DuckDB scalar/table function (`duckdb-rs` `vtab` / `vscalar` features) that performs the transform inside the engine. Feasibility facts already measured (capabilities 1, D-ENG-11): a VTab or VScalar can write rows through a `try_clone` connection held in the extra info/state, from bind, init and func; the feature adds 80 bytes to a minimal binary; gotcha: `func` is called until it returns 0 rows |
| W3 | staged batch: Appender into a TEMP staging table, then one set-based `INSERT ... SELECT` with in-batch `QUALIFY` collapse and `ON CONFLICT` / anti-join into the target (this is the only Appender-based method, and the only one that can be idempotent: D-ENG-3) |

Reads (the PL, SSD, AGG, TOPN, OTEL classes):

| id | method |
|---|---|
| R1 | SQL table macro stored in the database, called with parameters (works from Rust with `?` parameters and persists across reopen: capabilities 2d) |
| R2 | Rust `VTab` table function registered at connection open |
| R3 | prepared SQL text held in Rust, parameters bound per call |

Output stage (on top of any read method):

| id | method |
|---|---|
| O1 | DuckDB `to_json` / `json_group_array` streamed to the HTTP/MCP response; requires the static `json` feature (section 0), named struct fields (never `row(..)`), and the D-ENG-10 type rule (BIGINT counts, DOUBLE below 1e16, epoch-ms BIGINT timestamps, no FLOAT/DECIMAL/NaN) |
| O2 | `serde_json` from rows fetched into Rust structs |

Intricate logic (branching, folds, clock logic, e.g. the burn and gate engines):

| id | method |
|---|---|
| R4a | SQL port of the logic (window functions, CTEs) |
| R4b | Rust fold over rows returned by a plain SELECT |

A (read, output, logic) combination is one "method"; the report lists the full triple. Invalid combinations (O1 with R4b) are not candidates.

Reads of the production workload include the production predicates: the clear watermark `ts >= clear T` (R1-D10) and the generation filter `gen = file.gen` (R1-D4 b). A method measured without them is not representative.

### 2.2 Pruning stage (viability per operation CLASS)

Classes are those of the catalog legend: SSD, PL, AGG, TOPN, OTEL, FS, W, ST. FS and ST touch no table and are excluded (their method is recorded in `methods.toml` as `none`).

For each class pick two representative operations (one simple, one the most intricate by catalog notes) and attempt every candidate. Record per (class, method): `expressible` (yes/no; the exact compiler, binder, feature-not-built or parity error is written verbatim to `reports/DUCKPLAN/<timestamp>-method-pruning.md`), `golden parity` (see 5.1), and `builds` (for W2/R2: the `vtab`/`vscalar` features build and register under the pinned DuckDB; if not, W2/R2 are pruned everywhere with the error recorded once). A method that cannot express a class is pruned for the whole class. Only surviving pairs are implemented per operation; a single survivor is assigned without measurement (`only-survivor`).

## 3. Harness: `alcore-bench`

### 3.1 Binary

A Rust binary in the `rust-core` workspace, linked against the same `agentlens-core` code, the same DuckDB build (with `json` and `parquet` statically enabled, autoload off), allocator (mimalloc) and settings as `alcore`. Not Python (section 0). A dev tool, not shipped in the npm package (`scripts/check-dist-contents.js` stays green). One process per cell (operation, method, round): open the database, warm up, run the measured calls, print one JSON line, exit.

### 3.2 Frozen data

- Stage 0 uses the raw sample and spill files of section 1. Stage 1 uses `frozen.duckdb`, built once from the real corpus by the real ingest path, using the Stage 0 winners and the simplest write method that passes golden parity (reference build; W methods are then measured by replaying a slice into their own database, so the frozen file does not depend on the W decision). The size, session count, DuckDB version and git commit are in the run header.
- Every cell starts from an APFS clone (`cp -c`) of the frozen file, taken after a `CHECKPOINT` so no WAL replay is paid at open (D-ENG-7). Clones are regenerable artifacts under `scripts_dev/duckplan-bench/` and are deleted after the cell.
- A SYNTHETIC scale-up is permitted as an additional variant by a documented generator, always labelled SYNTHETIC. The scale guard (4.7) makes one mandatory for operations whose methods differ in how their cost grows with rows.

### 3.3 Workloads

- Reads: a fixed-seed parameter set per operation (`bench/params/<op>.json`, generated from the frozen data), at least 200 measured calls per round after 20 discarded warm-up calls, identical across methods, same pseudo-random order. The first call after open is recorded as `first_call_ms`. Cold disk reads are not measurable (no privilege to purge the page cache, E1/E1b), so "cold" means a fresh process and connection only.
- Writes: replay of a fixed JSONL slice (path and SHA-256 in the header; the smaller of 100,000 lines or 200 MB; a 0.2 GB slice costs ~1-4.5 CPU-s at 5-22 CPU-s/GB, section 7), same batches for every method, then a second replay of the same slice (E3's re-read case). Checked against golden row counts and table checksums; the second replay must change zero rows.
- Concurrent-load variant (writes): the writer replays the slice while 4 reader threads (own connections) run a read mix. The mix 50% PL, 30% SSD, 10% AGG, 10% TOPN is a proposal of this spec; E2 used 50/40/5/5 over its Q1..Q4 and a 500/400/50/50 mix for read CPU, so E2 does not back these shares. Reader p50/p95 and writer throughput are recorded.

### 3.4 Order and pairing

Paired, interleaved rounds: round k runs the methods in a seeded Latin-square permutation, so slow drift of load hits every method equally. At least 20 paired rounds for cells under 10 s, at least 7 for expensive ones (write replays, Stage 0 builds), with the wider CI stated.

### 3.5 Metrics

- Idle baseline: after open and one trivial query each process records `rss_idle` and `maxrss_idle`.
- **Decision metric `peak_mem` = `maxrss` (getrusage high-water mark) minus `maxrss_idle`.** Changed from the previous draft (which sampled at 10 ms): a sampler can miss a short peak, the high-water mark cannot, and E1-E4 used it. Cross-checks reported with it: mimalloc peak committed (`mi_process_info`) and `duckdb_memory()` peak; probe disagreement above 15% is flagged.
- CPU: `getrusage` user+sys (all threads) over the measured section; wall recorded, not decisive. Also `cpu_wall_ratio` (a starvation indicator for a nominally single-stream cell).
- Latency: per-call p50/p95. Load: `getloadavg` 1-minute at cell start and end; the cell's load is the maximum.
- Header (frozen, printed): DuckDB `threads` (2, as in every experiment), `memory_limit`, `nice` value, QoS class, mimalloc, Rust and DuckDB versions, git commit, `checkpoint_threshold` (default 16 MB), extension state, the Parquet writer properties.

### 3.6 Output of one cell

One JSON line: `{stage, op, method, round, load_start, load_end, rss_idle_mb, peak_mem_mb, mi_peak_mb, duck_peak_mb, overhead_over_limit_mb, cpu_user_s, cpu_sys_s, cpu_wall_ratio, calls, p50_ms, p95_ms, first_call_ms, errors, result: ok|FATAL|error, parity: ok|fail, rows_checksum}`. A driver (Rust or shell, it must not measure) launches the cells and concatenates the lines into `scripts_dev/duckplan-bench/<timestamp>/cells.jsonl`; analysis reads only that file.

### 3.7 Load handling

Thresholds are empirical, not core-count formulas: `LOAD_START` = 80 (a cell does not start above it; E1b's usable rounds were means 36-74, while ~190 left a process ~2% of a core), `LOAD_QUIET` = 50 (E1b's low-load rounds were 36-48). All values are printed in the header and are overridable only by editing the header, never mid-run.
- RAM and CPU statistics use ALL completed cells: bytes and CPU-seconds are load-independent, and pairing plus interleaving cancels the rest. The load of each round is reported and its correlation with the paired difference is printed; a correlation that explains the verdict marks it `LOAD-SENSITIVE`.
- Latency disqualifiers (section 5) and latency columns use only cells with `max(load_start, load_end)` at or below `LOAD_QUIET`. With none, the latency verdict is `LATENCY-UNVERIFIED` (listed, never guessed); it does not make the RAM/CPU verdict `INCONCLUSIVE`. The previous draft's rule (quietest quartile of 20 rounds, against a 20-round minimum) could never be satisfied and is removed.
- Cells above `LOAD_START` at their end are kept in `cells-highload.jsonl` and reported in their own column, never silently dropped.

## 4. Statistics

For each operation (or Stage 0 choice) and each pair of surviving methods (X, Y), per metric (`peak_mem`, then CPU):

1. Pairing: `d_k = X_k - Y_k` on baseline-subtracted values; a round missing for either is dropped for both.
2. Estimate: the median of `d_k` with a 95% CI by bootstrap (10,000 resamples of the paired rounds, percentile method, fixed seed); per-method medians reported alongside.
3. Noise floor (calibration, run once per harness build and per run header): 20 rounds of the SAME method run twice (X vs X, different processes) on one cheap read operation and one write replay; `noise_floor_mem` and `noise_floor_cpu` are the median absolute paired difference as a percentage of the median, with a minimum of 2%. A value above 10% is reported as a harness fault to fix, not accepted (E2's ~10% was a Python baseline artifact; the Rust harness subtracts a measured baseline).
4. "Equal": the CI of the difference includes 0, OR the absolute median difference is below `noise_floor` x the median of the lower method.
5. Ordering: memory not equal -> lower `peak_mem` wins; memory equal -> compare CPU the same way; both equal -> `tie -> simplest`. Tie order (DuckDB-native first, then fewest components): W3 over W1 over W2; R1 over R3 over R2; O1 over O2; R4a over R4b; D1: D over C1 over C2; D4-ART: ART over ANTI over PART. The previous draft preferred O2 and W1 on "simplest", which contradicts the owner's "DuckDB-native" tie-break and R1-D1.
6. Three or more survivors: a tournament by the ordering above, then the winner is compared with every other survivor; if it loses any pairwise comparison the cycle is reported and the operation is `INCONCLUSIVE` pending more rounds.
7. Scale guard (rows-dependent methods): for any operation whose surviving methods differ asymptotically (a scan of `api_call` against a rollup, E2: C_noidx Q1 p50 21 ms at ~1M rows, ~100 ms projected at 5M), the winner must also pass the section 5 limits on a SYNTHETIC variant at the one-year horizon (~5M `api_call` keys, R1), else it is flagged `SCALE-RISK` and the best method that passes at scale is chosen, with the disagreement listed.

## 5. Disqualifiers (a method failing any is out before the statistics)

- Any error in any round, a `FATAL` result, or a parity failure.
  - 5.1 Reads: output byte-equal (key order included) to the FND-00 golden capture (`SPEC-golden-capture-and-clock.md`) MODIFIED by the CONTRACT-DELTA entries (D-12 / R1-D12: the parser fixes D-DAT-2/3/5 and the fixed quirks latestSession, dailyStats, burn weights with the 1h tier, workspace filter); operations touched by a delta use the delta-adjusted golden, everything else is exact.
  - Writes: table checksums after replay and after the second replay.
- Idempotency: the second replay must add zero rows and change zero rows (not "add no rows": R1-D4 allows a usage update only from a later row of the same file, never from a re-read), and a write method must expose applied-row counts from which the rollup deltas are computed (R1-D4 d).
- Paged operations: a walk with concurrent updates and inserts shows zero duplicates and zero misses against the start snapshot (E4: the mutable cursor `last_active_ms DESC` gave 197 duplicates and 248 misses; the immutable `created_ms DESC, nk` gave 0 and 0).
- Latency on quiet cells only (3.7): p95 above 100 ms for pages, detail (SSD) and leaf operations, above 1 s for aggregates (the E2 limits), and above 50 ms for raw-line point reads (the E1 gate); the same limits apply to the readers during the concurrent-load variant.
- A write method whose concurrent-load run makes any reader exceed those limits.
- Peak above the process cap in the header in any round. The cap is the one in force when the run starts (2,048 MiB today; the interim 4,096 MiB if D-13 is applied; D-13 is a plan until its 65-minute watch passes, R1-D13); the header states which.

If every survivor is disqualified for an operation it is `NO-METHOD`: that blocks its implementation card and is escalated, never relaxed.

## 6. Output

1. Decision reports (Stage 0, pruning, Stage 1): `reports/DUCKPLAN/<timestamp>-bench-infra-d1.md`, `-bench-infra-d4art.md`, `-method-pruning.md`, `-method-decisions.md`. The Stage 1 report has one row per operation: id, chosen method (full triple), delta `peak_mem` vs the runner-up with CI, delta CPU with CI, p95 (quiet cells), cells used, flags (`LOAD-SENSITIVE`, `LATENCY-UNVERIFIED`, `SYNTHETIC`, `SCALE-RISK`, `tie -> simplest`, `only-survivor`, `INCONCLUSIVE`, `NO-METHOD`). Raw `cells.jsonl` stays in `scripts_dev/duckplan-bench/<timestamp>/`.
2. `rust-core/crates/agentlens-core/methods.toml` (tracked): one entry per operation id, plus the two Stage 0 choices in a separate namespace:
   ```
   [H2]
   method = "R1+O1"
   run = "<timestamp>"
   reason = "rss"   # rss | cpu | tie-simplest | only-survivor | none

   [infra.D1]
   method = "C2"
   run = "<timestamp>"
   reason = "rss"
   [infra.D4ART]
   method = "ART"
   run = "<timestamp>"
   reason = "tie-simplest"
   ```
   `build.rs` generates the dispatch table; a missing or unknown method is a build error (fail fast, no fallback).
3. Test `methods_toml_covers_catalog`: ids come from `design/specs/duckplan/SPEC-operation-catalog.md` section 1 via the generated `bench/operations.txt` (checked in by a script, compared with the catalog in the same test); every id has exactly one entry; no entry has an unknown id (the `infra.*` tables are checked separately: exactly `D1` and `D4ART`); every `method` names a candidate of section 1 or 2.1.
4. Re-run triggers: a schema change to a table an operation reads or writes; a DuckDB pin bump; a change of `threads`, `memory_limit` or the process cap; a change of the operation's golden output; a change to `infra.*` (re-runs everything that touched it). `alcore-bench --stale` compares the `run` stamp, DuckDB version and a schema hash in `methods.toml` with the tree and lists stale operations; the build prints (does not fail on) the list.

## 7. Cost, hard caps, load (nothing launches before the cell cost is measured)

Measured costs of one cell so far (Python harness, so prior estimates only; step 1 re-measures in Rust):

| cell | measured | source |
|---|---|---|
| raw-line build, ~1 GB sample | 5.4-22.4 CPU-s/GB (C 5.4-5.8, D 19.8-22.4; Rust Appender 5.0 default, 11.5 zstd); wall 7-30 s at load 36-190, one outlier of 100 s (E3 B+ART); staged part write +2.5-3.5 CPU-s/GB | E1, E1b, E3, capabilities 4 |
| write replay of the 0.2 GB slice | about 1-4.5 CPU-s, a few to ~10 s wall at normal priority; at background QoS ~30x wall (116-166 s for 0.5 GB) | derived from the rows above, capabilities 4 |
| read cell, 220 calls | 0.5-4.9 CPU-s (E2: 2.3-22.1 CPU-s per 1,000-call mix) plus open; p95 limits imply at most ~22 s | E2 |
| 20M-key ART build | NOT measured | E6 / step 1 |

1. Measure first: one cell of the cheapest operation, one write replay, one Stage 0 build and one 20M-key build; the header states `cell_cost_s` per class.
2. Hard caps (proposals; the owner may change them in the header; the harness refuses to exceed them without a new header): Stage 0 at most 400 cells and 3 hours wall; Stage 1 `max_cells` = (classes x survivors x rounds) after pruning, limited by a wall budget of 6 hours (default) divided by the measured cell cost, and never above 3,000 cells; whole bench never above 12 hours. If the matrix does not fit, operations are measured in catalog-card order and the rest stay `unmeasured`; rounds are never reduced below the minimums of 3.4.
3. Machine load: a cell starts only at load at or below `LOAD_START` (3.7); above it the run pauses and records the wait; 30 consecutive minutes above it stops the run. The bench itself is bounded at `threads=2` and one cell at a time, at normal QoS with the header's `nice`.
4. Other stop conditions, checked before each cell: wall budget exhausted; free disk below 20 GB (the user frees disk, per the standing rule); 5 consecutive cell errors (the harness stops and writes the failing command and output).
5. Cells run strictly one at a time (two measurement processes would contend for CPU and RAM); only one agent drives a run.

## 8. Tests for the harness itself (real data, no mocks)

The harness must be shown to detect what it claims to, with the section 4 statistics and no special-casing:

1. `detects_20pct_rss_regression`: one real read operation; X unmodified, Y the same plus a held allocation of 20% of X's `peak_mem` (test-only `--inject-rss-pct 20`, compiled under `cfg(test)` / a bench feature). 20 paired rounds; Y ranks worse on memory, the CI excludes 0, "equal" is false.
2. `detects_2x_cpu_regression`: `--inject-cpu-x 2` (a spin loop doubling the CPU of the measured section at equal memory); memory judged equal, CPU different, CI excludes 0, X wins.
3. `no_false_positive_on_identical_methods`: X versus X in different processes; `tie -> simplest` in at least 95% of 40 repeated analyses (10,000-resample bootstrap on the same cells file, 40 seeds, 40 cell subsets).
4. `load_thresholds_split_cells`: a cells file with load above `LOAD_START`, between, and below `LOAD_QUIET`; above-start cells go to `cells-highload.jsonl`; memory and CPU statistics use every completed cell; latency uses only quiet cells; none quiet gives `LATENCY-UNVERIFIED`, not `INCONCLUSIVE`.
5. `methods_toml_covers_catalog` (6.3), including the `infra.*` check.
6. `baseline_is_subtracted`: a cell with a deliberate 100 MB allocation before the baseline probe and one after; only the second shows +100 MB.
7. `noise_floor_is_measured`: the calibration of 4.3 on X-versus-X yields a floor within 2%-10%; a value above 10% fails the run.
8. `crash_injection_leaves_no_loss`: the Stage 0 crash-injection driver on a small real slice (the six kill points of 1.1.3) for C1 and C2 ends with every line present once and every part referenced once.

Each test runs the real `alcore-bench` binary on a small real slice and cleans up cells directories and clones, leaving the process table as found.

## 9. Open points (settle before the first run)

- `vtab` / `vscalar` feasibility on the pinned DuckDB as built in-tree: capabilities 1 measured it in a scratch crate; the pruning stage (2.2) decides it for the product.
- Whether the Rust `File::sync_all` really maps to `F_FULLFSYNC` on macOS (1.1.3): decides whether C1/C2 durability cost is higher than D's like for like.
- E6: when it lands, its report is an input to 1.2 (and its harness language decides whether its memory numbers count).
- Whether `force_compression='zstd'` can be scoped to one table or needs a separate database file (1.1).
- Whether the concurrent-load variant also runs for read operations with no write counterpart (default: no).
- The `bytes_cap` and `LOAD_START`/`LOAD_QUIET`/wall-budget values are proposals; the owner may set them.

## Revision log

Revision 1, 2026-10-03: fact-check against decisions + R1 and reports e1, e1b, e2, e3, e4, e5, duckdb-capabilities. 33 fixes:

1. Sources listed only e1-e4 and the catalog; added e1b, e5, capabilities, both decision logs, E6.
2. The bench decided nothing about the two R1-open infrastructure choices; added Stage 0 (R1-D1 D/C1/C2, R1-D4-ART) before any per-operation work.
3. R1-D1 workloads added: ingest, adversarial row group (2.34 GB / 9.37 GB worst cases computed from the 4,575,124-byte max line), spill files (E5, 64 MiB max, binary jpg), reads, invalid UTF-8.
4. Crash-consistency protocol cost and kill-injection at each step added for C1/C2, compared with D's WAL commit.
5. Byte-capped row group added (R1-D1), measured at 8/32/128 MiB.
6. R1-D4-ART mechanisms ART / index-free anti-join / monthly partitions added with the unmeasured case (a 2,000-key batch against a multi-million-key ART) and CHECKPOINT-vs-reopen release.
7. R1-D4-ART precondition "duplicates share the exact ts" contradicts D-DAT-2 (growing later rows); made a verified precondition, window derived from data.
8. HUGEINT/UUID binding through duckdb-rs is not listed in the capabilities supported types; added as a tested precondition.
9. E1b used "lowest disk" as the primary rule; that is not the owner's rule; disk is now report-only plus a 1.0x-raw disqualifier.
10. D-1's "read RSS 131 MB" and every C2 figure are Python/pyarrow numbers and the Rust `parquet` crate was never run; recorded as unbacked, Rust re-measure mandatory.
11. pyarrow writer-defaults trap (0.207 vs 0.138 GB/GB) recorded; Rust writer properties printed in the header.
12. D's CPU: 19.8-22.4 CPU-s/GB (Python) vs 11.5 (Rust Appender, capabilities) recorded; the Python penalty must not decide.
13. `force_compression` scope (database-wide?) flagged INFERRED and made a test.
14. Rust `sync_all` = `F_FULLFSYNC` on macOS flagged INFERRED, to be measured.
15. W1 ("Appender plus prepared upserts") was impossible (Appender is not idempotent, D-ENG-3) and overlapped W3; W1 is now per-row prepared upsert, W3 the only Appender-based method.
16. W1's starting shape cited E3 option A, which D-4/R1-D4 rejected for display rows; now the R1-D4 seq/same-file-guard upsert.
17. W2/R2 feasibility facts (D-ENG-11, capabilities 1) recorded, including the loop-until-0-rows gotcha.
18. R1 table macros verified from Rust with parameters and persistence (capabilities 2d) recorded.
19. O1 requirements added: static `json` feature, autoload off with a startup proof, D-ENG-10 type rule, named struct fields.
20. Tie order contradicted the owner's "DuckDB-native" tie-break (preferred O2 and W1); reordered DuckDB-native first.
21. Noise floor of 2% contradicted the ~10% noise finding that D-3 relied on; replaced with a calibrated floor (X vs X) and a fail above 10%.
22. Peak metric was ambiguous (RSS vs max of two probes sampled at 10 ms); now the `maxrss` high-water delta, probes as cross-checks.
23. Load rule was unsatisfiable (quietest quartile of 20 rounds against a 20-round minimum, with `INCONCLUSIVE`); replaced by empirical `LOAD_START` 80 / `LOAD_QUIET` 50 from E1b; RAM/CPU use all cells, latency quiet cells only, `LATENCY-UNVERIFIED`.
24. Run priority: normal QoS with `nice`, never `taskpolicy -b` (30x wall inflation) nor `nice -n 19` (starved builds); `cpu_wall_ratio` added.
25. E2 scale-up misdescribed ("236 sessions to 41k"): it was 60,504 sessions / 990,720 rows with synthetic `tool_calls`/`errors`; corrected, and a scale guard added because E2's winner reads linearly in rows.
26. The 50/30/10/10 reader mix was attributed to E2 (which used 50/40/5/5); marked a proposal.
27. A garbled sentence on cold-cache measurement was rewritten.
28. Frozen data was circular (built by an ingest path the bench has not yet chosen); now built by Stage 0 winners plus the simplest golden-passing write method.
29. Parity against the golden ignored CONTRACT-DELTA (D-12/R1-D12); now golden modulo deltas.
30. Idempotency rule "adds no rows" ignored R1-D4 (updates only from a later same-file row, zero on re-read) and applied-row counts; rewritten. Cursor correctness (E4) and the E1 50 ms raw point gate added as disqualifiers; production predicates (clear watermark, gen filter) added to workloads.
31. The RSS cap was hardcoded 2,048 MiB; it is now the cap in force per the header, with the 4,096 MiB interim as a plan (R1-D13, R1-BUDGET); `overhead_over_limit_mb` recorded for D-16.
32. Cost cap lacked a measured cell cost and a load cap; added measured costs from E1/E1b/E2/E3/capabilities, hard caps on cells, wall-clock and machine load, an `infra.*` namespace in `methods.toml` and harness tests 4, 7 and 8. The catalog's "126 operations" is unverified in this revision.
33. Coordinator update: added backup/snapshot disk cost as a measured Stage 0 criterion (APFS clone divergence of `index.duckdb` after N batches + CHECKPOINT versus free cloning of immutable Parquet parts, workload 6), a total-disk disqualifier, and restated the owner order (least RAM, then least CPU; DuckDB-native only on a full tie).
