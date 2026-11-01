---
trdd-id: 7YPQWKPG
title: DuckDB is the memory and alcore keeps no resident data model
column: dev
created: 2026-09-02T22:05:41+0200
updated: 2026-11-01T12:15:16+0100
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
status: tasked
unblock-when: [trdd:7RM5YW2T terminal, trdd:FSMISF5K terminal]
pre-block-column: 
blocker-probe: [trddgrep, why, 7YPQWKPG]
blocker-holds-if: not-match:READY
approved: true
approval-judge: user
approval-datetime: 2026-11-01T02:38:17+0100
implementation-commits: [6c50142a, 4b408081]
---

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-11-01T02:36:38+0100

**2026-11-01 — CURRENT (supersedes the paragraphs below dated before 2026-11-01 and the 2026-09-02 history further down; the dated 2026-11-01 lines at the end of this block are current).** The owner re-issued this card directive on 2026-10-30, ruled on the memory budget and the dashboard, then answered the open plan questions with "decide yourself" (all four quoted verbatim under WHY). PLAN v3 is DELEGATED on that directive; its decisions, the CPU constraint, the step S amendments and the step A result are the last lines of the PLAN v3 section, and its Acceptance F replaces the boxes under ACCEPTANCE (those boxes are void). The 2 GB figure is indicative: a target that throttles, not an exit. Measured: step S (file-backed DuckDB; the bound does not hold in general, query shapes decide) and step A arms a to c (peaks 2477, 2186 and 1786 MB; arm d not run). Merged into feat/duckdb-is-the-memory, in this order: step 5a (7e40c96b, merge 54d55f3f), the core_cap_guard fix d825948b, step 2 (6c50142a, merge 4b408081), step 1b (e03eb631, merge 5364669a). Step 9a: uncommitted in 7yp-step9a on base fd5abaae; spool_tap passed 24/24 under the shared lock; its Linux check (cargo-zigbuild) pending; then its adversarial review, commit, and a merge whose checks run on the --no-commit merged tree before the merge commit. Step 1a: built and verified by its builder (ui tests 45/45, rewritten test 20/20, clippy clean, release build OK), still uncommitted and awaiting its adversarial review; merges LAST. Post-merge checks on 5364669a: pending. core_cap_guard no_literal_duckdb_threads_outside_the_allowlist is fixed on feat/duckdb-is-the-memory by d825948b; it is still red on fd5abaae and the step worktrees cut from it. The collector stays disabled (the DISABLED file belongs to the owner). NEXT ACTION: step 9a (Linux check, review, commit, checked merge), then step 1a (review, commit, checked merge, last), then the full suite on the integration branch including spool_tap under the shared lock at low load (if anything fails, compare base vs integration); then steps 3, 4, 6, 7, the storage-version migration, and step 8 per TRDD-IPLPDD19.

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
2026-10-16: correction to commit e5cd319d's message: its BLOCKED-WITHOUT-PROBE finding came from this triage (unblock-when alone does not satisfy the rule), not from before it; blocker-probe was added afterwards.
- 2026-11-01, Step 2 (32 typed card columns, schema v2 in place, batch-halving SQL backfill) committed 6c50142a, merged into feat/duckdb-is-the-memory as 4b408081. Post-merge checks (core_cap_guard, card_store tests, clippy on the merged head) not yet run.
- 2026-11-01, DEPLOY GATE: step 2 deploys with or after step 9a, never before (first-boot backfill retained +335 MB on the backfill alone; whether it adds to the resident load is unmeasured; today's build exits at the 2 GB cap).
- 2026-11-01, OWED after the merge: run typed_open_footprint_on_a_real_corpus (whole first open: migration plus backfill plus resident load) per the step 2 review-fixes report procedure. The 74,730-row / 6.7 s / 406 MB figures are from round 1, before round 2 changed the backfill; re-measure.
- 2026-11-01, NPT for the step that removes the resident layer: put_arc decides insert-or-update from the resident layer and panics on a divergence; when the layer goes, the existence test must become a primary-key probe (SELECT on session_id), never ON CONFLICT DO UPDATE (with 39 columns that held about 1 MB per statement until COMMIT and ran out of memory after 239 statements).
- 2026-11-01, at the step 1a merge, re-read put_arc together with step 1a's card_store.rs hunk (both change card_store.rs).
- 2026-11-01, the next CARD_SCHEMA_VERSION bump rebuilds every v2 file from the snapshot unless an in-place step is added beside migrate_v1.
- 2026-11-01, known residual: a single card that cannot be typed even at the 1024 MiB rebuild limit panics in finish_swap on every boot (crash loop); largest cards measured are 314 KB and 2.8 MB.
- 2026-11-01, step 2 review findings rejected, with reasons: mapping a one-row out-of-memory to NotEligible (it rebuilt the store empty in a_wal_is_carried_into_the_rewrite; the rewrite is the recovery for WAL replay); generalising the in-place migration beyond v1 (a v3's changes are unknown); "the rewrite cannot help an out-of-memory backfill" (it is the WAL-replay recovery and raises the limit).
- 2026-11-01, after all steps merge: remove the 7yp-step2 worktree and its merged branch.
- 2026-11-01, Step A measurements owed by step 1b: startup time on a busy host; request latency during a bodies pass and a /api/clear rescan (lock inversion vs default-QoS handlers); aldigest collect duration at background QoS vs its 600 s COLLECT_TIMEOUT; memory plateau with the 180 s chores keep-alive; per-core CPU of the bulk passes (to size a duty cycle and batch limits) and the shed counts an admission change to max_cores() would produce.
- 2026-11-01, DEPLOY-GATING: the item 'collect vs the 600 s timeout' gates deploy, because on 2026-11-01 one niced aldigest collect in a tiny spool_tap test data dir had run at least 5 min 32 s on 11 s of CPU when observed (it exited before it could be sampled), with two spool_tap runs contending, launched niced at load ~100 (step 9a's branch, launched niced, not under step 1b's QoS).
- 2026-11-01, Step 1b review findings rejected or deferred, with reasons: admission resizing (56/112 to 8/16 in flight) needs shed counts under real load first; a semaphore on handler DuckDB queries needs an inventory of the 68 spawn_blocking sites in ui.rs; merging the two QoS FFI copies rejected (agentlens-core deliberately does not depend on agentlens-digest); core's set_background_qos keeps report-and-continue (a separate decision; aldigest now exits 1 if its background-QoS call fails (builder-reported)).
- 2026-11-01, Step 1b's tests all ran under taskpolicy -b on base fd5abaae, so the requested QoS classes (boot at default QoS, bulk at background) are asserted and read back per thread (runtimes::qos::rayon_pool_starts_unlowered_and_is_lowered_after_boot, the bg_qos test), but the EFFECT — boot running unthrottled, bulk work yielding — is untested, because every run sat under taskpolicy -b; the spool_tap 24/24 pass shows only that the branch passes when everything runs at background priority.
- 2026-11-01, spool_tap rerun lock script defect: its EXIT trap removed the lockdir even when that run never acquired it; any reuse must set a flag after mkdir succeeds and rmdir only when set.
- 2026-11-01, spool_tap deadline headroom: 10-11 tests ran over 60 s each even at load1 ~12-30 (the runs were niced or under taskpolicy -b with RUST_TEST_THREADS=4, which inflates durations); the 300 s start deadline and 60 s read timeout are tight on a shared machine — candidate card, separate from TRDD-HFS3SSLY.
- 2026-11-01, Correction to merge 5364669a's message: 'the step's only open question was its spool_tap failures' means only the question blocking a merge into the integration branch; the step A measurements above remain open. Its clippy claim referred to the 4b408081 post-merge run, whose output names only agentlens-core; agentlens-store coverage unverified (the 5364669a post-merge clippy includes it).
- 2026-11-01, Correction to e03eb631's message: its test counts (960/8, 57/57, 6/6, 2/2, clippy) are builder-reported, not re-read by the orchestrator.
- 2026-11-01, after all merges: remove the 7yp-step1b worktree, as for step 2.
- 2026-11-01, TRDD-KBM09XHB still needs its pointer to TRDD-7YPQWKPG for progress.
- 2026-11-01, lesson for the remaining merges: run the targeted checks on the --no-commit merged tree BEFORE committing the merge; after step 9a merges, run spool_tap on the integration branch under the shared lock at low load.
- 2026-11-01, step 1b revision 2 departed from its round-1 review in three places no review has read: the log sweeper is not lowered at all (M1), m2 done differently, and m4's new exit-1 behaviour; and step 9a overlaps step 1b in lib.rs and log_reader.rs, both tested only on fd5abaae — the 9a merge's pre-commit checks must cover them.

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
OWNER DIRECTIVE RE-ISSUED 2026-10-30 (verbatim): *"it should not hit the memory limit. it should digest all data via duckdb at very high speed without allocating nothing. all must be handled by duckdb. duckdb will digest and save to disk. nothing will stay in memory. this is the task i gave you but you failed it. so we stopped agentlenspro since it is too slow now."*
OWNER RULING 2026-10-30 on the memory budget, answering "should the cap be the 2 GB DuckDB budget plus the measured Rust base usage?" (verbatim): *"yes, 2gb is the limit combined when digesting. when diagnosticating an issue or analyzing due to a cli command, it can grow to 4gb, but still using duckdb mostly. the rust code should allocate only the answer."*
OWNER RULING 2026-10-30 on the dashboard (verbatim): *"- the dashboard must not receive the whole data at all. it should be lasy updated with the only the data visible on the browser page at that moment, with a strict rule of only one element branch expanded st any time, and the whole scroll handled loading new values below lazily and discarding those above. or even better with pagination all over. tabs must nopreserve content, they losd the content when they sre sekected. everything is ephemeral and loaded when it is displayed and only when must be visible. what is not visible is discared. everything must be handled by direct query to duckdb, handled lasily."*
OWNER DIRECTIVE 2026-10-30 (verbatim), answering the open plan questions: *"decide yourself. base your deisions on verified facts. keep the memory as low as possible, no matter what. make sure to write all data ingested into duckdb database compressed tables, not keeping anything in memory. do not follow an exact rule. 2gb is indicative. but cpu core usages is also essential and must be kept below 100% per core. the system must never become unresponsive. so design well. you planned a lot last time. did you found some good solution? if not try again. but be sure to make certain that no process become too cpu consuming to prevent other processes."*
OWNER INSTRUCTION 2026-11-01 (verbatim): *"resumee and complete all pending tasks"* — the authority under which the delegated plan v3 steps are executed and merged.

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

## STATE HISTORY — 2026-09-02 (superseded; not authoritative)

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
- 2026-10-16T11:13:16+0200 — column → human_review by main-agent@agentlenspro. owner ruling: supersede by 9VX3WTGU or reword; row 2
- 2026-10-16T11:16:42+0200 — column → blocked by main-agent@agentlenspro. its NPTs 7RM5YW2T and FSMISF5K are unfinished (lint ORDER-NPT-VIOLATED); the owner ruling on supersede-by-9VX3WTGU or reword is also pending (triage row 2)
- OWNER 2026-10-24 (verbatim, recorded on TRDD-735Q3JF4, copied here 2026-10-27): "the functionalities and the diagnostic power must remain the same, but everything should be done via duckdb sql and sql functions. this is the idea, of course you have to evaluate case by case if there are potential issues and if certain functionalities needs a little more code and allocation in addition to the sql of duckdb. but you must plan and execute this with the clear aim to make duckdb able to ingest and structure/breakdown the raw data and all the otel logs in a way that statistical analysis is fast and smart functions will diagnose any problem and find the root cause of any cost peak or cache break."
- 2026-11-01T02:38:17+0100 — column → dev by user. owner directive 2026-10-30 answered the open plan questions: "decide yourself ... so design well"; PLAN v3 approved on it; blockers 7RM5YW2T (superseded by PLAN v3 steps 1 and 7) and FSMISF5K (title false in code, SpanWindow still a CoreState field) cleared on that directive Cleared blocked-by (--clear-blocker override).

## Notes and lessons learned

## Note 2026-10-05

- This card's title says alcore keeps no resident data model. That is no longer true in the code, by a deliberate later decision: TRDD-9VX3WTGU (dev) plans a resident parsed card layer by name with a memory budget, and commit 4306a017 (its Phase C part 1) re-added `parsed: IndexMap<String, Arc<Value>>` to CardStore. Children completed on 2026-10-05 in the owner's stead: YILE6N3T and XTFDRTH2. Children still open: 7RM5YW2T (blocked), BLAV6W15 (todo). Whether this parent should be superseded by 9VX3WTGU or reworded was not decided.

## PLAN v3 — 2026-10-30 (DECISIONS DELEGATED 2026-10-30, owner said decide yourself; executed under the owner's 2026-11-01 instruction)

PLAN v3 for TRDD-7YPQWKPG (2026-10-30) — PROPOSED; reviewed twice (adversarial rounds 1 and 2, two MEASURE reports in reports_dev/7ypqwkpg/); code steps wait for owner approval; measurement steps S and A started 2026-10-30
Rationale: nothing in alcore memory grows with the data; DuckDB on disk digests and answers, Rust allocates only the answer, so the whole process stays within 2 GB while digesting and 4 GB during a CLI diagnosis.
Evidence 1: 27 Oct death: footprint 2,247 MB vs cap 2,048; mimalloc commit 1,948 MB including freed pages not yet returned; 25.7 K of 26.6 K pages abandoned (exited threads); 298 MB outside the Rust allocator; first memory sample at second 38, one second before the kill; all 74,652 cards reloaded at second 2 (load_resident ran); the binary was older than this branch.
Evidence 2: TRDD-735Q3JF4: summary build on, commit 655 to 1,964 MB in 16 s; off, flat 660 MB for 120 s; boot sweep loop adds about 1.1 GB, almost all freed-but-retained. Measured transient sources: summary rebuild and parse churn. Resident card layer share: unmeasured.
Evidence 3: DuckDB memory_limit did not bound an IN-MEMORY DuckDB (512 MB gave 1,150 MiB; 1,536 MB gave 2,497 MiB; TRDD-2HRA270Y). A file-backed instance is unmeasured.
Branch: feat/duckdb-is-the-memory cut from fix/setup-agent-preflight HEAD (542 ahead of main, 0 behind) when code starts.
Step S (measurement): file-backed DuckDB on a copy of the data, memory_limit plus temp_directory plus capped threads, running the real query shapes (aggregates over typed columns, page scans, body-dedup insert at volume); record phys_footprint. It holds if peak footprint stays within memory_limit + 300 MB; if not, stop and re-plan.
Step A (measurement, TRDD-735Q3JF4): current build on a frozen full copy of ~/.agentlens incl. otel-bodies on a separate volume, each arm on a copy-on-write clone; CLAUDE_CONFIG_DIR and CODEX_HOME at the real transcript roots (read-only; never symlink below the root); pinned non-live ports. Arms: default warm; --no-log-scan; bodies moved out; cold (no offsets, no cards.duckdb); large-backlog warm; later, patched scratch builds with the summary rebuild off and with load_resident off (discarded after). Each arm reports footprint, Rust live, free-in-page, abandoned and non-Rust memory per phase. Synthetic load: scripts/bench/alcore-ingest-flood.mjs at 2x the highest per-minute span rate in the span store. Also captures the parity oracle (totals, full session list, field set) and p95 of the current /api/summary.
Step 1 (TRDD-7RM5YW2T, interim, removed by step 7): the 25 ms rebuild loop stops; a summary is built only when a reader asks and dropped after use. Gate: A arms re-run show the churn gone. Also allocator policy and thread reuse: per-request work runs on a bounded, reused thread pool and abandoned-page reclaim is measured, so freed pages of exited threads do not accumulate.
Step 2 (TRDD-KBM09XHB): typed columns on the cards table plus a bounded, resumable backfill of existing rows.
Step 3 (TRDD-Q9WD3K5R): page endpoints, additive: inventory every /api route and every caller (media/src, src/cli, skills, scripts, tests); one paged DuckDB query per view, including paged tab content; server-side filter, sort and search; no page query takes the global state lock.
Step 4: every consumer moves to queries: burn check (lib.rs:761), MCP tools (ui.rs:2480-2497), agent gate (ui.rs:2084-2096), call-context (ui.rs:1260), subagent rollup (mcp_tools.rs:1978), composition diagnostic (chores.rs:1026-1177), rebuild gate (derived_cache.rs:70-110), the other summary_now readers in ui.rs. The merge rule (log wins for Claude) moves into the save step, pinned by tests/feed_merge_parity.rs.
Step 5: the dashboard moves to pages per the owner ruling: one expanded branch; a window that drops rows above; tab data fetched on mount and released on unmount; a change notice re-queries only the visible page; the notice is capped and falls back to many-changed-re-query.
Step 6: the full summary push and the /api/summary full payload are removed.
Step 7 (TRDD-7RM5YW2T, TRDD-JJLI6GEH): delete the resident layers: card map and load_resident, summary engine, cached summaries, boot seed and save steps that read the map; migrate the engine tests and parity fixtures; machine diff against the A oracle.
Step 8 (TRDD-LHCHVK9Z, TRDD-HFV4AIT7, TRDD-2HRA270Y, TRDD-2JOIAH2G): ingest straight into DuckDB: the existing opt-in spool plus aldigest path becomes the only path (own design card, parity against the TypeScript oracles); body-store sets, hash tables, file positions and body links become tables read by key; the body registry stops copying; the span window becomes queries over span files; the span writer pending buckets, otel_attribution and composition entries get bounds.
Step 9 (TRDD-DKBGT7MQ, TRDD-12FGMAEP, TRDD-WKLD508O, TRDD-CQ4652DQ, TRDD-COJI87P7): one DuckDB instance with one memory limit, so the DuckDB total is bounded by construction (current separate limits: round-2 MEASURE report); the cap is on whole-process footprint including children (aldigest collect reaches about 730 MiB); 2 GB while digesting, 4 GB only while a diagnosis request is in flight, marked by its route; one combined cap when both run.
Acceptance F (every check can fail): Rust live after boot plus full scan within 10 percent on the 1x copy and a 2x copy (duplicates get new session ids), reported apart from DuckDB; peak footprint at most 2 GB through boot, cold scan, backlog scan and 30 min of the stated load, beside the A figures; a forced overshoot trips the cap; every /api route and push frame under a row and byte bound; page p95 at most 200 ms under concurrent ingest; first page and totals equal the A oracle; DOM rows at most 3 pages after scrolling the whole list; expanding a second branch collapses the first; leaving a tab frees its data and re-entering re-fetches; investigate_burn over 7 days and the two other heaviest CLI analyses stay under 4 GB; light and dark screenshots. Then the live collector is restarted.
Board: 7YPQWKPG is blocked by 7RM5YW2T and FSMISF5K. 7RM5YW2T is superseded by step 1 and step 7. FSMISF5K (human_review) says the span window is deleted, but SpanWindow is still a CoreState field (lib.rs:202): owner to rule. Dispositions: JJLI6GEH to step 7; COJI87P7 and CQ4652DQ to step 9; HFV4AIT7 and 2JOIAH2G to step 8; 1FWN9XBS stays separate (export speed, not memory); 9SOYXKNE (deploy) gives the live OTLP rate. This plan reverses the measure-and-cap approach of TRDD-9VX3WTGU.
Owner question a2: the 2026-10-22 directive set the cap on Rust allocator memory only ("it cannot use more memory than 2gb. but duckdb on the other hand can."); the 2026-10-30 ruling reads as 2 GB for the whole process. Does the 2026-10-30 ruling replace it?
Owner question b: body-dedup tables into the one database file (default yes).
Owner question d: the current build caps only Rust allocator memory, so its whole footprint can pass 2 GB unnoticed (TRDD-12FGMAEP); run it as an interim collector after step A, or stay down? Hook events are spooled on disk; OTLP spans are lost while down.
Owner question e: SessionSummarySql, connect or delete.
Review findings rejected: none. Partly rejected: one DuckDB instance is not needed: kept, because one instance with one limit bounds the DuckDB total by construction, which several independent limits do not; sequenced last.
Owner question f: clear the blockers 7RM5YW2T (superseded by steps 1 and 7) and FSMISF5K (its title says the span window is deleted; the code still has it, lib.rs:202), so this card can leave blocked?
Step 8 re-scoped 2026-10-30 after the ingest inventory: own design card TRDD-IPLPDD19 (15 gaps; the digest path has no transcript producers, has never run live, and nothing reads its database). Steps 1 to 7 do not depend on it.
Decision a2 2026-10-30 (the owner said "decide yourself"; directive verbatim under WHY): the cap counts the whole process plus its children; 2 GB (4 GB while a diagnosis runs) is a target that drives throttling, never an exit at that number; only a machine-protecting signal exits. Reason: "2gb is indicative" and "the system must never become unresponsive"; the exit cap produced the 8-death crash loop and the DISABLED file.
Decision b 2026-10-30: the body-dedup tables move into the one database, collected in-process, because DuckDB allows one process per database file; step S confirmed it (a second process cannot open the file at all, read-only included, while one holds it read-write).
Decision d 2026-10-30: the collector stays disabled until the plan lands; the DISABLED file belongs to the owner.
Decision e 2026-10-30: SessionSummarySql is kept; it is the half-built OTEL-sessions-as-SQL query (TRDD-IPLPDD19 gap 3) and is wired when the span tables exist.
Decision f 2026-10-30: the blockers 7RM5YW2T and FSMISF5K are cleared with the directive as the reason (7RM5YW2T is superseded by steps 1 and 7; the FSMISF5K title is false in code, SpanWindow is still a CoreState field at lib.rs:202); this card moves to dev.
New constraint 2026-10-30 (CPU): no core at 100 percent, no process starves others, the system never becomes unresponsive. Every pool is bounded to a fraction of the cores, DuckDB threads are capped at every open site, ingest, scan and digest threads run at background QoS, HTTP handlers at default. The all-cores goal of TRDD-HFV4AIT7 is superseded.
Ingest end state 2026-10-30: every ingested record lands in compressed native DuckDB tables in bounded batches (compression needs the storage version of amendment c); nothing is kept in memory beyond the batch in flight.
Step S result 2026-10-30 (reports_dev/7ypqwkpg/20261030_034335+0100-stepS-duckdb-bound.md; DuckDB v1.5.6, file-backed, 74,730 real cards): the bound does not hold in general, because memory_limit does not bound the process; the query shape decides the footprint. Aggregates over typed columns 18-26 MB, typed-column session pages 51-54 MB, no run spilled to temp, one page query stalled about 1.3 s during an insert (commit or checkpoint).
Step S amendment a (steps 3 and 5): every page pages keys from typed columns, then fetches card text by primary key; never sort with card text in the select list (card text in a sorted select reached 711-828 MB and ratcheted; key-first pages held 161-177 MB over 10 passes).
Step S amendment b (step 8 and decision b): no PRIMARY KEY or ART index for dedup (1,297-1,400 MB under a 1 GB limit, out of memory under 512 MB, about 474 MB of index resident once probed); key-sorted tables with an anti-join insert instead (stayed within 512 MB + 300 MB; lookups 0.4-1.4 ms).
Step S amendment c (new step): database files use STORAGE_VERSION v1.2.0 or later with zstd on text columns (owner: compressed tables). In the default storage version the card JSON is stored uncompressed (120 MiB for 125 MB) and forcing zstd does nothing; with v1.2.0 plus zstd it is 14.2 MiB (8.8x smaller); typed columns compress by default. cards.duckdb is migrated by copy.
Step S amendment d (steps 1b and 9): CPU is bounded by background QoS on DuckDB and ingest threads plus bounded batch size and a duty cycle, not by the threads setting (threads=2 still gave 185 percent average and 277 percent peak; one DuckDB thread holds a core near 100 percent for most of an insert).
Step S amendment e (TRDD-IPLPDD19 gap 9, topology): in-process collect is confirmed by the lock rule; one process owns the database file.
Step S amendment f (step 9): per-shape memory budgets are tested, and the whole-process metric is the target that throttles, because footprint does not come back down after a query (DuckDB uses the system malloc on macOS; SET memory_limit and malloc_zone_pressure_relief released nothing for card workloads).
Step A result 2026-11-01 (data in reports_dev/7ypqwkpg/stepA/ and the arm-c samples on the frozen copy): peak footprint arm a (default warm) 2477 MB at 243 s, arm b (no log scan) 2186 MB at 84 s, arm c (bodies moved out) 1786 MB at 65 s; arm c ran 46.8 h unattended after its fork died (its sampler had no duration bound) and held 1062-1533 MB footprint after the first hour with no crash; arm d (cold) never ran; the arm report is still to be written.
Found by step A: TRDD-NCHQ2LWS (a chore holds the CoreState lock for minutes); its own card, not part of steps 1–9.
Step 5a follow-up: TRDD-X0YTE00M (remaining resident lists and App signals).
