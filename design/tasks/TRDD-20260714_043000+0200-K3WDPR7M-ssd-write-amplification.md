---
trdd-id: K3WDPR7M
title: SSD write amplification — raw OTEL bodies rewrite the whole conversation every turn; move the body store to a fileless-DuckDB to immutable-Parquet loop
column: dev
created: 2026-07-14T04:30:00+0200
updated: 2026-07-14T13:45:00+0200
current-owner: main
task-type: bugfix
severity: critical
scope: project
npt: []
eht: []
---

## ⏵ STATE — 2026-07-14 EVENING — Phases 2/3/4 LANDED, gate green (1093 passing)

**Every claim below is measured, not reasoned.** Device writes via `ri_diskio_byteswritten` —
file-size growth LIES (a row-group rewrite burns writes without growing the file).

| burn source | before | after | where |
|---|---|---|---|
| Claude Code raw bodies | ~21 MB/min | **0** (capture opt-in, default OFF) | TRDD-BKF5NZD3 |
| `.wad` archiver boot pass | **694 MB/min** | **retired** → throttled store ingest | `d925107` |
| `log-sessions.json` + `log-offsets.json` | 9.4 MB/min | **~0** (delta append) | `9985c34` |
| our store | — | **15 KB/turn** (floor is 14) | `e63ec01` |
| CPU spin | 50–78% | fix in flight | TRDD-X2E6OSWK |

**DRY RUN on the real corpus (deleteAfter=false — NOTHING deleted):**
`7,439 bodies · 4.00 GB → 0.024 GB zstd Parquet (167×) · VERIFIED 7439/7439 byte-identical from the
DURABLE store · 0 failures.`

**The extension is CANCELLED, on evidence** (user-ratified): the measured floor is 14 KB/turn and
plain SQL already achieves 15 KB/turn. A custom Rust DuckDB extension cannot beat the floor — at
best it recovers ~1 KB/turn — while costing a per-platform native binary loaded in-process, which
breaks the prebuilt-binary/npx-installable property. Reopen ONLY if profiling shows the JS
sectioner is a real bottleneck.

**CPU-spin root cause (profiled, and it REFUTES the old 4s-tick theory):** `buildUpdatePayload()`
rebuilds the whole dashboard on a **1-second** debounce floor (the code's own comment says 4s), and
`runLogScan()` does a full readdir+stat of **12,508 files every 5 s** *and* on every `fs.watch`
event. Together ~78% of non-idle CPU.
Evidence: `reports/cpu-profile/20260714_203932+0200-cpu-spin.md`.

**NEXT ACTION:** Phase 5 — full backfill + reclaim. Authorized by the user, gated on the dry run
above. `ingestPass` only deletes a body after proving it reconstructs byte-for-byte from a DURABLE
Parquet part.

**SUPERSEDED — do NOT carry forward:**
- ~~"the 4-second tickBurn rebuild causes the CPU spin"~~ — measured and refuted twice.
- ~~"memory_limit removes the write amplification"~~ — it does NOT (the persistent `.db` burned
  5 MB/turn *with* it set). Being FILELESS does. `memory_limit`'s real job is to stop DuckDB
  spilling to `temp_directory` (which defaults to `.tmp` — a hidden SSD write path we now disable).
- ~~"this session writes 0 raw bodies"~~ — it did; I read the wrong metadata field (`session_uuid`;
  the real one is `session_id`), so everything attributed to `?`.

---

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-07-14

**USER-REPORTED SYMPTOM (the trigger).** "We got a big problem with the server — it is burning my SSD
writing and rewriting the logs!" Activity Monitor: the server node process wrote **3.75 GB in 1h23m**.
The user's hard requirement: *"even 10 MB per minute is too much — you have to make it write only
optimized and compressed data into a SQLite DB."*

**MEASURED FACTS (all verified this session; no inference).**

| fact | value |
|---|---|
| `~/.agentlens/otel-bodies/` (loose JSON) | **8.1 GB**, 14,404 files |
| `~/.agentlens/otel-bodies-archive/bodies-2026-07.wad` | **14.7 GB** (single file) |
| total body storage | **~22 GB** |
| ONE raw request body | **~1.9 MB** |
| bodies written by Claude Code | ~30/min ⇒ **~57 MB/min** |
| `log-sessions.json` full rewrite | **33 MB every 5 min** (6.6 MB/min) |
| `log-offsets.json` full rewrite | **3.3 MB every 60 s** (3.3 MB/min) |

**ROOT CAUSE — TWO DISTINCT WRITE STREAMS, both amplifying.**

1. **Claude Code writes the bodies, not us.** `agentlenspro --install-otel` sets
   `OTEL_LOG_RAW_API_BODIES=file:~/.agentlens/otel-bodies` in `~/.claude/settings.json`. That makes
   **Claude Code itself** dump the *entire* request body — the whole conversation re-serialized — to a
   fresh ~1.9 MB JSON file on EVERY LLM request. We cannot change how CC writes; the only levers are
   (a) don't turn it on, (b) ingest-and-delete promptly.
2. **The server writes a SECOND copy.** `archiveOtelBodies()` (hourly) packs those loose bodies into an
   ever-growing `.wad` (now 14.7 GB, never pruned). So every byte lands on the SSD twice, and the
   archive grows without bound. This is what Activity Monitor attributed to the node process.
3. **Full-file rewrites of mutable state.** `log-sessions.json` (16,959 cards, 33 MB) and
   `log-offsets.json` (12,433 offsets, 3.3 MB) are rewritten IN FULL on a timer whenever any single card
   or offset changes — a whole-corpus rewrite to record a few KB of delta. (A cadence throttle was
   already applied — offsets 60 s, cards 5 min — but throttling a 33 MB full rewrite is treating the
   symptom; the file format is the bug.)

**THE KEY MEASUREMENT — the data is ~86% pure repetition.** Each request re-sends the whole transcript,
so body N+1 is almost entirely byte-identical to body N. Over a 40-body sample of one session:

```
raw bytes on disk:      45,184,010          (40 request bodies)
message blocks:         11,238  ->  unique 1,618  (14.4%)   <- 85.6% are exact repeats
dedup only:              6,405,841           (7.1x smaller)
dedup + per-block zlib:  3,035,790          (14.9x smaller)
```

Long-window compression confirms it independently: `zstd -19 --long=27` over 5 concatenated bodies gets
6,040,704 → 817,384 (7.4×), whereas per-file gzip only manages 2.6× — gzip's 32 KB window is blind to
the cross-body redundancy, which is exactly where all the waste lives.

**The load-bearing consequence:** with content-addressed message blocks, a turn's INCREMENTAL write is
only its NEW messages (`INSERT OR IGNORE` makes the 85.6% repeats cost ~0 bytes) — tens of KB per
request instead of 1.9 MB. That is the ~40–90× reduction on the write path, not merely a 15× shrink at
rest.

**ACTIONS ALREADY TAKEN (bleeding stopped).**
- Killed the runaway server (pid 75229: 78% CPU idle, 1.2 GB RSS) and an orphaned duplicate (18670).
- Removed `OTEL_LOG_RAW_API_BODIES` from `~/.claude/settings.json` via **`safeConfigEdit`** (the only
  sanctioned writer). Verified surgical: that ONE key gone; all 17 other OTEL keys and 19 top-level keys
  intact. Backup: `~/.claude/settings.json.agentlens-bak-20260714_042225291`.
  ⚠ **CC reads `env` at LAUNCH** — the current session keeps writing ~57 MB/min until the USER RESTARTS
  Claude Code. This is the single most urgent user action.
- Added an on-disk revive brake `<dataDir>/NO_REVIVE` (`reviveDisabledOnDisk()` in
  `src/cli/hookHandlers.ts`) — the env-only `AGENTLENS_NO_REVIVE` is unreachable in practice because a
  hook inherits the AGENT's env, so an operator cannot retrofit it onto a running agent, and `kill`
  alone is futile when the next hook resurrects the server. Rebuilt; verified the brake HOLDS across
  live hook fires (server stayed down, ports free). **The brake is currently ARMED — disarm with
  `rm ~/.agentlens/NO_REVIVE` once the fix lands.**

## ⏵ PHASE 1 BAKE-OFF — DECIDED BY **REAL DEVICE-WRITE** MEASUREMENT (2026-07-14, redone)

Evidence: `reports/storage-bakeoff/20260714_134500+0200-real-disk-writes.md`.
Harness: `scripts_dev/measure_writes.py` + `scripts_dev/writeprobe.mjs`. 40 real bodies,
chronological; 20-turn baseline then 20 MEASURED turns. Raw input = **881 KB/turn** (what CC writes today).

⚠ **SUPERSEDES the first bake-off** (`…122132+0200-duckdb-vs-sqlite.md`), which ranked engines on
**file-size growth** — a PROXY, and wrong by up to **57×**. The USER challenged whether the numbers were
real; they were not. We now read **`ri_diskio_byteswritten`** (`proc_pid_rusage`) — the same counter
Activity Monitor shows — **validated against a known 64 MB fsync'd write before use**, and every layout
is **forced fully durable (fsync) before sampling**. Without that forcing, `sqlite_tuned` measured
**0 KB/turn** — its pages were merely still dirty in the page cache. A too-good-to-be-true number is a
harness bug, not a result.

| layout | **REAL write/turn** | stored | vs raw |
|---|---|---|---|
| **floor** — append-only zstd, no index/engine (the yardstick) | **14 KB** | 1.98 MB | 63× |
| **duckdb_parquet** — fileless DuckDB → immutable ZSTD Parquet | **15 KB** | **1.21 MB** | **59×** |
| sqlite_tuned — WAL, synchronous=NORMAL, 16K pages, batched commit | 65 KB | 3.30 MB | 14× |
| sqlite — WAL, commit/turn, checkpoint(TRUNCATE) | 125 KB | 2.96 MB | 7× |
| **duckdb persistent `.db`** — content-addressed + `USING COMPRESSION zstd` | **5,018 KB** | 4.01 MB | **5.7× WORSE than raw** |

**DECISION: fileless (in-memory) DuckDB → immutable, hive-partitioned, ZSTD Parquet.** It writes at the
theoretical floor (15 KB vs 14 KB) AND produces the smallest store (1.21 MB — 39 % smaller than the
flat-file floor, because Parquet's column-chunk zstd + dictionary encoding beats per-section zstd).
Projected: **37 GB/day → 0.63 GB/day (59×).**

Findings, each of which would otherwise have shipped a bug:
1. **A persistent DuckDB file is the WORST option — 5 MB/turn to store a 881 KB body (5.7× worse than
   doing nothing).** Columnar OLAP: 256 KB blocks + row-group rewrite on checkpoint. Architectural, not
   tunable. The file-size proxy said 179 KB — a **28× underestimate**, because a row-group rewrite burns
   SSD writes without growing the file.
2. **`memory_limit` is NOT the mechanism** (correcting the guide's framing): it sizes the buffer pool; a
   persistent store still rewrote row groups at 5 MB/turn. The lever is the **fileless DB + `COPY … TO`
   Parquet** — parts are written once and never rewritten.
3. **The `storage_compatibility_version` trap.** Defaults to **`v0.10.2`**, which PREDATES zstd column
   compression (v1.2.0) ⇒ `USING COMPRESSION zstd` is **silently ignored** and big strings stored
   **uncompressed**; the first run produced a DB **2× LARGER than the raw JSON**. Never infer compression
   from a ratio — assert it (`pragma_storage_info`); that is what caught it.
4. **HYPOTHESIS REFUTED — DuckDB's native cross-row zstd window does NOT capture our redundancy.**
   Per-section rows without dedup (3.3×) are no better than whole-body rows (3.6×). **Content-addressed
   dedup does 100 % of the work** — Parquet has no cross-file content-addressing, so the dedup must stay
   OURS.
5. **The RAM disk is still required and is ORTHOGONAL.** No DuckDB setting can stop **Claude Code itself**
   from writing its ~881 KB raw body per request. The RAM disk targets CC's write; the Parquet loop
   targets ours. Both are needed.
6. **The raw bodies on the RAM disk ARE the write-ahead log** — never delete a body until the Parquet
   part containing it is durable. Bounds crash exposure to one flush interval at **zero SSD cost**.

**NEXT ACTION** — in order:
1. **Body store → compressed content-addressed SQLite** (per the bake-off). `blob(sha PK, n, z)` holding
   each unique section compressed once; `body` + `section(body_id, pos, path, idx, sha, n_bytes)` holding
   the ordered refs **with size + hash in clear** (so all analytics run with zero decompression).
   `INSERT OR IGNORE` ⇒ repeats write 0 bytes. Ingest each loose body, then DELETE it.
   **Retire the `.wad` archiver entirely** (it is the second-copy amplifier).
2. **Cards/offsets → SQLite rows, delta writes only.** UPSERT only the cards/offsets that actually
   CHANGED (`runLogScan` already returns just the advanced sessions). Kills the 10 MB/min of full-file
   rewrites outright. The project ALREADY has SQLite infra (`src/database/`) — reuse, do not re-invent.
3. **Raw-body capture becomes OPT-IN.** `--install-otel` must NOT default to a setting that costs the
   user ~80 GB/day of SSD writes. Gate it behind an explicit flag with the cost stated in the help text.
4. **Bound the store.** Retention/size cap on the body DB, enforced on write, not by an hourly sweep.
5. **Fix the CPU spin (TRDD-X2E6OSWK)** — SEPARATE defect, still open. See "Refuted" below.

**⚠ REFUTED — do NOT carry forward (from TRDD-X2E6OSWK).** I claimed the 4-second `tickBurn` full
rebuild was the cause of the ~100% CPU spin. **MEASURED: `buildSessionSummary()` = 289 ms** against the
real corpus (54,870 spans / 16,959 cards) — a **7.2% duty cycle**, which CANNOT explain the observed
50–78% CPU. Breakdown: summarizeSpans 263 ms · merge 3 ms · link 8.5 ms · sort 17 ms. The merge/link are
Map-based O(n), NOT the O(n²) I hypothesized. The 4 s rebuild is real waste and still worth memoizing,
but the spin has a DIFFERENT, still-unidentified cause — likely the 5 s `runLogScan` stat-ing 12,433
tailed files, and/or the 33 MB `JSON.stringify` of the card set. **Profile before fixing** (`--cpu-prof`);
do not repeat the mistake of shipping a fix for an unmeasured hypothesis.

**Open questions for the USER.**
- Reclaiming the **~22 GB** in `otel-bodies/` + `otel-bodies-archive/` needs explicit approval (RULE 0 —
  these are not regeneratable). Ingest-then-delete, or delete outright?

## Verification
- `bash scripts/safe-deploy.sh --dry-run` GREEN (baseline 1016 passing).
- New regression tests: (a) re-ingesting the same body twice writes ZERO new block bytes; (b) a card
  update writes only that card's row, not the corpus; (c) the body DB round-trips a body byte-identically.
- Live: run ≥1 h under real traffic; `iostat`/Activity-Monitor bytes-written stays in the **KB/min**
  range, not MB/min.

## Approval log
- Tier 0: in-scope bugfix on the project's own server. USER explicitly directed both the architecture
  revision ("we cannot permit that the server hangs in no circumstances… if a speed problem arises that
  cannot be optimized further, you must implement rust helpers") and the storage fix ("even 10 MB per
  minute is too much.. you have to make it write only an optimized and compressed data into sqlite db").
- Destructive-op approval for the 22 GB reclaim: PENDING USER.
