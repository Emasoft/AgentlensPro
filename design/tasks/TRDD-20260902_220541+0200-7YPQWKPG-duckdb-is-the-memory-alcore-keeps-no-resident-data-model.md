---
trdd-id: 7YPQWKPG
title: DuckDB is the memory and alcore keeps no resident data model
column: todo
created: 2026-09-02T22:05:41+0200
updated: 2026-09-02T22:05:41+0200
current-owner: main-session
task-type: refactor
priority: high
min-approval-requirement: none
requested-by: user
blocked-by: []
related: [768NEX6E, CAJ5RCP9, O3ICDRLO, XX1UAZHS, N60JUWU3]
---

## WHY

USER directive (2026-09-02, verbatim, architecture ruling):

> what? you are storing the data in a rust data structure, instead of leaving
> it in duckdb!??? duckdb is your memory! the rust code should only make
> queries and report the ephemeral answers to the cli! never storing anything!
> or at best passing the data of the lazy loaded typescript dashboard in the
> browser, still only paged and ephemeral.. discared as the user go to the
> next page..

Earlier in the same thread:

> agentlenspro server is written in rust now.. it should be incredibly memory
> efficient and fast.. the data is fetched by duckdb from the disk, and each
> query just return the answer in milliseconds, not using much memory

USER directive (2026-09-02, verbatim, marked IMPERATIVE): "THIS IS
IMPERATIVE: your only memory is duckdb (and the ondisk files: parqet and
jsonl, read only via duckdb and never directly)".

PRRD proposal: "On-disk data (parquet, JSONL, any sink) is read ONLY through
DuckDB — never parsed directly by Rust or TS code; DuckDB is the memory; the
server holds no resident data model beyond a bytes-bounded ingest buffer" —
for the USER to ratify as a golden rule (the USER owns golden rules).

### Measured facts (orchestrator-verified)

- `alcore` (pid 67312, the Rust server) measured RSS **9,425 MB** 39 s after
  boot.
- On the previous process, `vmmap` showed **8.8 GB resident in the mimalloc
  (Rust) heap** vs ~2.5 GB in the C heap (DuckDB, mostly reclaimable) — see
  `.claude/project/memory/vmmap-ioaccelerator-is-the-mimalloc-heap.md`.
- `agentlenspro server status` at 39 s: "spans: 334638 in memory (90m window)
  … store 650.1MB (4577580 spans / 31 segments)", "log sessions: 27953".
- Four "memory pressure — summarization window now …" governor shrinks fired
  in the first minute alone.
- Per-structure byte attribution is being measured right now
  (TRDD-768NEX6E box 4; report will land under `reports/trdd-768nex6e/`).

## PRINCIPLE

1. On-disk data (parquet, JSONL transcripts, any sink) is read ONLY through
   DuckDB (`read_parquet` / `read_json_auto` / views) — never parsed directly
   by Rust or TS code.
2. Every durable fact lives in DuckDB/parquet the moment it is ingested.
3. A request is a DuckDB query whose answer is built, returned, and dropped —
   no cross-request cache of *data*, only of query plans/prepared statements.
4. The only RAM the server may hold is a bytes-bounded ingest buffer between
   arrival and flush, sized in MB, not minutes.
5. The dashboard receives paged results and discards them on navigation.

## INVENTORY TO RETIRE

Known resident structures (rust-core/crates/agentlens-core/src/):

- **Span window replay** (`SessionStore`, 90-min window). Today it serves:
  the live/recent-spans view and the 5-min burn window. Replacement: a
  DuckDB query over the last N minutes of parquet, plus the bytes-bounded
  ingest buffer for data not yet flushed.
- **Log-session cards map** (filled by the boot/incremental scan,
  `log_reader.rs` ~line 1052 lock site). Today it serves: session list/detail
  lookups. Replacement: DuckDB table of session cards, upserted on ingest,
  queried per request.
- **`summary_cache` / `stripped_cache`** (`ui.rs` ~line 367). Today it
  serves: pre-built summaries every route reads. Replacement: a materialized
  DuckDB view/table refreshed on the ingest tick, queried per request.
- **`latest_resident_blobs`**. Today it serves: latest-value lookups across
  routes. Replacement: DuckDB query for the latest row per key.
- **Boot/incremental log scan** (`log_reader.rs`: Rust parses
  `~/.claude/**/*.jsonl` with rayon and builds session cards in RAM). Today
  it serves: session cards for `agentlenspro`'s log-based sessions. Baseline
  to beat (`.claude/project/memory/log-scan-performance.md`, measured
  2026-08-29 on an ~8.78 GB corpus): cold scan reaches only ~3.05-3.47 of 14
  cores (`(user+sys)/real`), 22-32 s sys / 48-54 s user, 405,436
  `filesStatted`, cause of the core ceiling still UNKNOWN as of that page's
  last update (stat-fan-out and lock/allocator/thread-count hypotheses all
  ruled out by controlled experiment). Replacement: DuckDB queries over the
  JSONL corpus (`read_json_auto`), no Rust-side parse-to-RAM step.

## OPEN QUESTIONS (for the advisor)

- The 5-min burn window / live status route today reads the span window in
  memory — served instead by a query over the last N minutes of parquet plus
  the ingest buffer?
- The summary rebuild every route reads today — becomes a materialized table
  refreshed by the ingest tick?
- Boot time once nothing is replayed into memory at startup.
- Query latency targets per route (the "milliseconds, not much memory" bar
  from the directive).
- Migration order — which resident structure to retire first, and whether
  any route needs a hybrid (buffer + DuckDB) during the swap.
- DuckDB `read_json_auto` over ~28k JSONL files per query vs a
  DuckDB-maintained index table refreshed by the ingest tick — the advisor
  decides.

## ACCEPTANCE

- [ ] Steady-state RSS after a 24 h run stays under a bound the advisor sets
      (proposed ≤ 512 MB, excluding DuckDB's own configured `memory_limit`).
- [ ] Every existing `agentlenspro` tool still answers with identical shape,
      measured against the fixtures.
- [ ] No "state lock held ≥ 250 ms" in a 15-min read, because there is no
      big resident model under it anymore.
- [ ] Dashboard pages are served paged and discard prior pages on navigation.

## NON-GOALS

- No rewrite of ingestion sources (OTLP collector, log readers stay as-is).
- No new MCP server.

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-02

NEXT ACTION: wait for the TRDD-768NEX6E box-4 per-structure sizing, then get
advisor review of the migration order (which structure first), then split
this TRDD into per-structure child TRDDs (NPT/EHT).

## Approval log

## Notes and lessons learned
