---
trdd-id: 7YPQWKPG
title: DuckDB is the memory and alcore keeps no resident data model
column: dev
created: 2026-09-02T22:05:41+0200
updated: 2026-10-05T02:35:10+0200
current-owner: main-session
task-type: refactor
priority: critical
min-approval-requirement: user
requested-by: user
blocked-by: []
npt: [YILE6N3T, 7RM5YW2T, XTFDRTH2, FSMISF5K]
related: [768NEX6E, CAJ5RCP9, O3ICDRLO, XX1UAZHS, N60JUWU3, Q9WD3K5R]
approved-by: user
approved-at: 2026-09-02T22:05:41+0200
---

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-06T04:42:39+0200

**RE-ISSUED BY THE USER 2026-09-05 22:00 and moved `todo → dev`.** Verbatim: *"why the hell alcore
is using 17Gb of ram??? haven't i told you to make duckdb the only memory of agentlenspro? why there
are things kept in memory and not written down in parquet files? why there are persistent data
structures in ram instead of just the small query results from duckdb??? why a rust process is
using so much memory and it is so slow??? fix all this"*. This card sat in `todo` since 09-03 with
NEXT ACTION "wait for 768NEX6E box-4 sizing, then advisor, then split" — the sizing landed 09-02
and the advisor verdict is below; the split never happened. It is done now, and the two same-day
slices are in `dev` with workers.

**Measured today on pid 574 (`3b9018e0`), all ✓ VERIFIED:** footprint 13.1 GB (peak 21.3 GB), of
which mimalloc (the Rust heap) 8.7 GB resident and DuckDB/system malloc 0.38 GB; `spans.inMemory`
570,550 and growing at the ingest rate while `windowMs` = 300,000 after four memory-pressure
narrowings — the 24-hour `boot_load` is never pruned (TRDD-YILE6N3T); the 25-ms rebuild loop
rebuilds the whole window back-to-back under ingest, 84% of a core, and is the churn mimalloc never
returns (TRDD-7RM5YW2T); 32,607 log cards resident (TRDD-XTFDRTH2). The per-structure sizing
(`reports/trdd-768nex6e/20260902_220716+0200-box4-heap-by-structure.md`) stands: bounded
structures < 1 GB, the rest is rebuild churn + the unpruned window.

**Children (advisor order, ≤5 files per phase):** YILE6N3T (window never prunes — critical bugfix,
`dev`, worker) → 7RM5YW2T (rebuild back-off — critical bugfix, `dev`, worker) → XTFDRTH2 (cards →
DuckDB table, `todo`, NPT on the two above) → FSMISF5K (summaries as DuckDB SQL, delete
`SpanWindow`/`boot_load`, `todo`, NPT on XTFDRTH2). The log scan → `read_json_auto` replacement
(inventory item 5) stays inside this card's own acceptance and is sequenced after FSMISF5K.
**Measured 2026-09-06 on pid 78233 (after YILE6N3T + 7RM5YW2T + XTFDRTH2 deployed), ✓ VERIFIED by main:**
RSS 10.7 GB but `vmmap` Physical footprint **2.8 GB** (peak 13.2 GB); IOAccelerator (= the mimalloc
heap) 9.5 GB reserved / 7.0 GB resident / **1.9 GB dirty**. The ~8 GB gap is freed pages mimalloc
has MADV_FREE'd that macOS keeps in RSS until memory pressure — INFERRED mechanism, resident-clean
numbers measured. The "17 GB" the USER saw is mostly this residue, not live data.
What sets the high-water mark: the boot replay still parses **528,219 spans** into `window.spans`
at startup (peak 13.2 GB), then prunes to the 5-min window (309 resident). Second contributor: the
summary rebuild re-scans + re-parses all 33k cards every ~1.73 s (0.58/s), a ~0.7 GB sawtooth and
the reason 7RM5YW2T's CPU box MISSED (57–65% of a core vs ≤15%).
Both are owned by **FSMISF5K** (delete `SpanWindow`/`boot_load`, summaries as DuckDB SQL). Evidence:
reports/7ypqwkpg/20260906_043059+0200-heap-by-structure-after-xtfdrth2.md,
reports/7ypqwkpg/20260906_043240+0200-t15-verdict-xtfdrth2.md,
reports/7ypqwkpg/20260906_031902+0200-t15-verdict.md.
Children status: YILE6N3T testing (live box PASS), 7RM5YW2T testing (live box MISS, deferred to
FSMISF5K), XTFDRTH2 ai_review (merged ac289d8d), GR6WHHK5 testing (merged c89148ce).
**NEXT ACTION:** FSMISF5K dispatched (kraken, worktree). After it lands + deploys: re-measure
footprint AND RSS; expect peak ≤ 3 GB and CPU ≤ 15%. If RSS still carries MADV_FREE residue,
evaluate `MIMALLOC_PURGE_DELAY=0` / eager decommit as a one-line knob card, not a refactor.

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
      (proposed — advisor sets the final number — ≤ 512 MB, excluding DuckDB's own configured
      `memory_limit`).
- [ ] Every existing `agentlenspro` tool still answers with identical shape,
      measured against the fixtures.
- [ ] No "state lock held ≥ 250 ms" in a 15-min read, because there is no
      big resident model under it anymore.
- [ ] Dashboard pages are served paged and discard prior pages on navigation.

## NON-GOALS

- No rewrite of ingestion sources (OTLP collector, log readers stay as-is).
- No new MCP server.

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-02

EVIDENCE (768NEX6E box 4, 2026-09-02): bounded resident structures (335k-span
window as `Arc<Value>`, 27,918 stripped + 50 hot cards, overlay ≤ 500) sum to
< 1 GB; the 7–8 GB mimalloc heap is churn from back-to-back whole-window
`summarize_spans` rebuilds that mimalloc never decommits (no `mi_collect`/
purge call exists); DuckDB's own C heap is a separate 3.6 GB resident from
parquet decompression. Under this ruling the whole-window summarizer becomes
a DuckDB query / materialized table instead of a Rust-side rebuild, which
removes the churn and the pinned cores at the source. Full report:
`reports/trdd-768nex6e/20260902_220716+0200-box4-heap-by-structure.md`.

NEXT ACTION: wait for the TRDD-768NEX6E box-4 per-structure sizing, then get
advisor review of the migration order (which structure first), then split
this TRDD into per-structure child TRDDs (NPT/EHT).

### ADVISOR VERDICT (Fable 5.1, 2026-09-02)

(a) Fix two card contradictions before splitting children: PRINCIPLE 1 "never
parsed directly by Rust" vs NON-GOALS "log readers stay as-is"; PRINCIPLE 5
"paged" vs the frozen wire contract `ui.rs:1-3` + acceptance "identical
shape" — and decide the freshness contract (read-your-writes case
`ui.rs:291-296` CI test: POST /v1/traces → GET /api/summary within 500 ms).

(b) Migration order:
- step 0 — zero-code today: restart with `MIMALLOC_SHOW_STATS=1`; A/B
  `MIMALLOC_PURGE_DELAY=0`; `AGENTLENS_MAX_WINDOW_SPANS=100000` (the RSS
  valve is exhausted at the 5-min floor, `span_window.rs:105`).
- step 1 — move the rebuild trigger from the 25 ms poll (`ui.rs:170-182`,
  rebuild on every `data_version` bump: `lib.rs:847/272/647`) onto the 5 s
  chores tick (`chores.rs:558`) and serve `cached_any` — kills the pinned
  cores, churn ≥10× lower.
- step 2 — cards → ONE long-lived in-memory DuckDB connection
  (`cards(session_id PK, start_ms, card JSON)` upserted in `put_log_session`,
  boot-restored from the delta log `log_reader.rs:689` via `read_ndjson_auto`,
  precedent `transcript_sql.rs:413`), `feed_merge.rs` stays Rust over the
  colliding ids only.
- step 3 — split `summarize_spans`: per-session aggregates → SQL over
  `read_ndjson_auto(today+yesterday)` into `session_summary` on the tick;
  timeline/synth-root/subagent logic stays Rust but per session on demand
  (`/api/timeline/:id`).
- step 4 — delete `boot_load` (`span_window.rs:66-69`) and `window.spans`;
  5-min burn window = flushed buffer + today's segment query; convert sealed
  segments to parquet.
- step 5 — `mi_collect(true)` only if step 0 shows purge works AND RSS still
  climbs after step 1.

(c) The ruling does not forbid a bytes-bounded ingest buffer (spanstore
`pending` `writer.rs:443-501` exists, bounded by COUNT 50k/100k — make it
bytes) nor a materialized DuckDB table, but it is RAM in DuckDB's heap and
counts; inventory MISSES to add: SSE ring `ui.rs:63` (64 frames × a full
stripped summary, bytes-unbounded with a lagging client),
`StatuslineUsageReader` HashMaps `statusline_usage.rs:303-308`,
`otel_attribution`, composition LRU, `recent_hook_events`, `forensics.db`
(SQLite via rusqlite `forensics_db.rs:1-7` — on-disk data read NOT via
DuckDB: exempt or route through CAJ5RCP9).

(d) DuckDB: FOUR independent 2 GB instances (`chores.rs:276`,
`statusline_store.rs:235`, `bodies_evidence.rs:76`, `transcript_sql.rs:402`;
CLI default 8 GB `lib.rs:39`) — `memory_limit` caps the buffer pool not
resident; ACCEPTANCE becomes: Rust heap (mimalloc committed) ≤ 512 MB AND
`phys_footprint` ≤ 512 MB + 1×`memory_limit` + ~1 GB slack (≈3.5 GB at
2 GB, ≈2.5 GB at 1 GB); name `phys_footprint` not RSS.

(e) Frontmatter: add `approved-by: user` and
`approved-at: 2026-09-02T22:05:41+0200`; the log line cites a PRRD proposal
but the repo has NO `design/requirements/PRRD.md` — add "PRRD absent;
ratification is a separate USER action" to the log line.

RISKS (verbatim): "(1) A SQL rewrite of summarize_spans (455 lines of
TS-parity logic) breaks the frozen contract; early signal = first fixture
diff on one aggregate column. (2) Tick-driven refresh breaks read-your-writes
(ui.rs:291-296). (3) If the USER means 'never parse JSONL directly'
literally, the sweeper (log_reader.rs 1086 lines + agentlens-logscan) is a
rewrite the card excludes — ask that one question before splitting
children."

NEXT ACTION (advisor): "USER answers: does 'read only via duckdb' include
the JSONL transcript sweeper (rewrite) or only queries (sweeper stays)?
then step 0, then children 1→4 each with a 15-min footprint read".

### STEP 0 RESULT (2026-09-03, non-regression only)

`MIMALLOC_SHOW_STATS=1 AGENTLENS_MAX_WINDOW_SPANS=100000` confirmed live on pid 2074 (`ps eww`).
Footprint did NOT climb over a 28-minute window (2712 MB → 2608 MB, RSS 9182 → 6490 MB,
declining). Spans-in-memory at start was 12,346 — well under the 100k cap, so the cap's
BINDING behaviour at the ceiling is still unexercised by this short window; only the
no-climb non-regression is verified here. Report:
`reports/deploy/20260903_053800+0200-deploy-420e6bb9-step0.md`.

## Approval log

- 2026-09-02T22:05:41+0200 — APPROVED by USER (Tier 3: architecture ruling + PRRD golden-rule
  proposal); directive quoted verbatim in ## WHY. PRRD absent; ratification is a separate USER
  action (repo has no design/requirements/PRRD.md).

## Notes and lessons learned

## Note 2026-10-05

- This card's title says alcore keeps no resident data model. That is no longer true in the code, by a deliberate later decision: TRDD-9VX3WTGU (dev) plans a resident parsed card layer by name with a memory budget, and commit 4306a017 (its Phase C part 1) re-added `parsed: IndexMap<String, Arc<Value>>` to CardStore. Children completed on 2026-10-05 in the owner's stead: YILE6N3T and XTFDRTH2. Children still open: 7RM5YW2T (blocked), BLAV6W15 (todo). Whether this parent should be superseded by 9VX3WTGU or reworded was not decided.
