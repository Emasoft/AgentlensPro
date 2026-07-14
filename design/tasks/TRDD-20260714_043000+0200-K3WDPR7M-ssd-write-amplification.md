---
trdd-id: K3WDPR7M
title: SSD write amplification — raw OTEL bodies rewrite the whole conversation every turn; move the body store to compressed content-addressed SQLite
column: dev
created: 2026-07-14T04:30:00+0200
updated: 2026-07-14T12:25:00+0200
current-owner: main
task-type: bugfix
severity: critical
scope: project
npt: []
eht: []
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

## ⏵ PHASE 1 BAKE-OFF — DECIDED BY MEASUREMENT (2026-07-14)

Evidence: `reports/storage-bakeoff/20260714_122132+0200-duckdb-vs-sqlite.md`.
Harness: `scripts_dev/bakeoff-duckdb.mjs`. 40 real bodies, chronological, **real file sizes**,
marginal cost averaged over 10 turns (a 1-turn delta is 256 KB-block-quantized noise).

| layout | stored | ratio | **per-turn write** | ingest/turn |
|---|---|---|---|---|
| A whole-body row + zstd | 8.26 MB | 3.6× | 179 KB | 8 ms |
| B per-section, **no dedup** | 9.01 MB | 3.3× | 486 KB | 44 ms |
| C per-section + dedup (**DuckDB**) | 3.76 MB | 8.0× | 179 KB | 187 ms |
| **D per-section + dedup (SQLite)** | **2.58 MB** | **11.6×** | **16 KB** | 14 ms |

**DECISION: SQLite is the WRITE store; DuckDB is the ANALYTICS engine ATTACHed over it READ_ONLY**
(`INSTALL sqlite; ATTACH '…' (TYPE SQLITE, READ_ONLY)` — verified working, zero-copy, no second file).
This also sidesteps DuckDB's single-writer-process limit: the server owns the file, N readers attach it.

Three findings, each of which would otherwise have shipped a bug:
1. **The `storage_compatibility_version` trap.** It defaults to **`v0.10.2`**, which PREDATES zstd column
   compression (v1.2.0) ⇒ `USING COMPRESSION zstd` is **silently ignored** and big strings are stored
   **uncompressed**; the first run produced a DB **2× LARGER than the raw JSON**. Must opt in explicitly.
   **Never infer compression from a ratio — assert it** via `pragma_storage_info` (that is what caught it).
2. **HYPOTHESIS REFUTED — DuckDB's native cross-row zstd window does NOT capture our redundancy.** I
   predicted the columnar per-vector streaming zstd (`zstd.cpp`: `ZSTD_VECTOR_SIZE=2048`, `ZSTD_e_continue`
   between values, level 3 ⇒ ~2 MB window) would dedupe the identical 342 KB `tools` array natively.
   **B (3.3×) is no better than A (3.6×).** Sectioning alone buys nothing; **content-addressed
   `INSERT OR IGNORE` does 100 % of the work.**
3. **DuckDB writes 11× more per turn (179 KB vs 16 KB)** — architectural (256 KB blocks + row-group
   rewrite on checkpoint), not tunable. It is *worse* than measured: a row-group rewrite burns SSD
   without changing file size, so the size-delta proxy undercounts it.

Projected at ~30 req/min: today **35 GB/day** → DuckDB store **7.5 GB/day** → **SQLite store 0.7 GB/day**.

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
