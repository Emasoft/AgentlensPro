---
trdd-id: 9VX3WTGU
title: alcore stays within the 2048 MB cap — phased memory redesign
column: dev
status: tasked
created: 2026-09-29T20:20:37+0200
updated: 2026-09-29T20:25:24+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: feature
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-09-29T20:20:37+0200
---

# alcore stays within the 2048 MB cap — phased memory redesign

## Context

alcore crash-loops: the RSS guard (rss_guard.rs) kills the server at phys_footprint > 2048 MB, ~1 kill per 2.3 min under load. Worker-measured forensics: the growth is **freed-resident mimalloc churn residue ~9:1 over live data** — live at kill ~130-200 MB vs 1.6-2.0 GB freed-but-resident; growth saturates at 2231-2327 MB (churn equilibrium above the cap); restart drops 1.2-1.7 GB; `mi_collect` drops 0/172 (residue hides in partially-used pages). **Churn formation must be reduced at its sources; shedding live data alone cannot decommit the equilibrium.**

Owner direction: DuckDB is "the very memory of agentlenspro"; Rust-side materializations discarded when unused; stay within the 2048 MB cap (never raised); no more crashes.

### Root causes (code-verified; two earlier errors corrected by audit)

1. **Summary rebuild is the churn engine — via `summary_snapshot` + `summary_over`, NOT the merge fn.** Rebuild loop polls every 25 ms (ui.rs:242-254); actual cadence = max(25 ms, ~5× pass cost) via cost back-off (REBUILD_COST_FACTOR=4, ui.rs:168) — EXCEPT the READER_WAITING override (ui.rs:286-290) forces an immediate pass whenever a reader waits and the last pass took ≤500 ms, so with readers polling the floor IS ~25 ms. Each pass: `summary_snapshot` (lib.rs:341-348) copies the full card corpus text out of DuckDB under the state lock (`cards_json()`, 37,746 rows / ~69 MB observed) + window Arc clone + accounts snapshot; `summary_from` (lib.rs:353-357) parses every string fresh; **`summary_over` (lib.rs:407) deep-clones the entire OTEL sessions array out of the summary per pass** (and lib.rs:395-399 clones every api_request timeline entry for attribution); `merge_otel_and_log_sessions` (feed_merge.rs:90) itself clones nothing — it moves. Result cached in `summary_cache`; `stripped_cache` then clones every card AGAIN (ui.rs:476) → **two full-corpus derived copies resident simultaneously** (56 MB each observed). The ui.rs:95-148 doc records 8.7 GB resident churn from this path. Second inline caller: `summary_now` cold-boot (ui.rs:451-462).
2. **The pressure valve is doubly dead.** `prune_window` (lib.rs:683-684) samples `server_stats::rss_bytes()` against `rss_budget_bytes()` = 4096 MB (lib.rs:656-664); the kill uses `primary_metric` = **phys_footprint** at 2048 MB (rss_guard.rs:266-271). Wrong metric AND wrong threshold — the defense never fires before the kill. `summary_cache`/`stripped_cache` (derived_cache.rs) have **no `clear()`** (confirmed API: get/current/store_if_newer/cached_*/is_empty/version/stats). `rss_bytes()` itself is NOT changed by this plan (it feeds /api/resource, /api/server-stats `rssMb`, request_log rows — wire format stays).
3. **DuckDB limits sum far above the cap — 8 open sites.** card_store 256MiB (file DB, spills — intended); bodies pass 2 GB per 60s reopen (chores.rs:287); statusline 2 GB (statusline_store.rs:229-242); bodies_evidence 2 GB per call (bodies_evidence.rs:73-88); transcript_sql 2 GB (:401-404) + DuckSession 2 GB (:572-577); burn-seismic DuckSession 2 GB (ui.rs:2839); body_archive export **8 GB** (agentlens-store lib.rs:42 via body_archive.rs:135); session_summary_sql 1 GB (:122-127). Any one balloon kills; DuckDB's own C allocator is invisible to mimalloc but counts in phys_footprint. All non-card connections spill-disabled.
4. **Boot restore materializes everything — before the version gate.** `restore()` (log_reader.rs:839-847) calls `cards.load()`/`offsets.load()` FIRST (delta_log.rs:66-110: `read_to_string` whole file, IndexMap of all JSON trees), THEN checks `version_is_current()` and discards on stale. `save()` (delta_log.rs:163-191) deletion-diffs + compacts (>256 KB delta & >1× snapshot). Tombstones exist (`{"k":key,"d":1}`). Stale-version boots fall to the 26k-file cold scan (chunked 2,000) — the burst survives that path; noted below.
5. **SpanWindow holds up to 1M `Arc<Value>` spans** (span_window.rs:73-78, env-overridable; effective_ms 24h, floor 5 min) — GB-class live risk; FSMISF5K measured 1 of 23,274 served cards originates from the window: it is a recency cache; history answers from disk (`/api/timeline` load_range).
6. **A deliberate 100 MB leak every boot**: `abandoned_control_pass` (chores.rs:773-821) allocates 200×512 KiB ballast on an OS thread and `mem::forget`s it (:793), unconditionally. Instrument proven — retire to 8 MB or env-gate.
7. **Uncovered per-request paths (audit)**: SSE `push_update`/`sse_response` (ui.rs:524-539, :1042-1050) build the FULL update payload (walks every span, re-strips cards, full `to_string`) per broadcast tick and per SSE connect; ingest POST accumulates the body into `Vec<u8>` up to 64 MB (MAX_BODY_BYTES lib.rs:102) then full Value parse + per-span String serialization + Arc wrap (lib.rs:972-1031); MCP `tools/list` deep-clones the ~1,200-line schema per request (mcp.rs:159); `get_recent_sessions` clones the sessions array per call (ui.rs:2172); request_log takes an rss syscall per request (request_log.rs:30). `MIMALLOC_PURGE_DELAY=0` already landed (serverControl.ts:193,:279,:853); TS sets no memory-shaping envs.

## Phases (one TRDD card + one commit each = the revert unit)

### Per-phase expected effect (the honest contract)

| Phase | Effect | Kills the loop? |
|---|---|---|
| 0 instrument | attribution: which source forms the residue | — |
| A ladder | buys headroom; bounds worst-case; sheds live data; cannot decommit freed pages | **no** |
| B DuckDB bounds | prevents DuckDB-side overshoot; spill converts over-limit from kill-risk to latency | no (defense) |
| C rebuild churn | cuts churn FORMATION (the engine) | **primary fix** |
| F incremental save | cuts save-cadence full scans | contributes |
| D streaming restore | cuts boot burst + baseline | fixes boot half |
| E window shrink | cuts live span residency | contributes (live half) |
| G request paths | cuts per-request allocations | contributes |

**Gate: kills=0 is verified only after C+F+D land** (24 h soak at organic load). A and B are verified by synthetic stage/limit behavior, not by kills.

### Phase 0 — byte-level instrument + 24 h attribution gate
- `rss_guard.rs`: `mi_live_bytes() -> Option<u64>` via `mi_heap_visit_blocks`/`mi_heap_get_backing` (verify binding in vendored libmimalloc-sys 0.1.49; else print `approx` = committed − abandoned-pages under the WARNED contract).
- `chores.rs composition_tick`: append `mi live {X} MB, mi free-in-page {Y} MB`. **Update the exact-shape unit test (chores.rs:1060-1068)** — no TS consumer parses the line (verified: only `alcore: stop` is parsed, serverControl.ts:519), shape free to extend.
- Retire the 100 MB ballast leak (chores.rs:793) → 8 MB, or gate `AGENTLENS_ABANDON_CONTROL=1`.
- **ATTRIBUTION GATE: run ≥24 h under normal load with the new fields. Confirm rebuild-pass churn dominance before starting C; re-rank C/F/D/E/G by measured `free-in-page` contribution.** If bodies-pass reopen or cold-scan dominates, reorder.
- Verify: fields print; `live ≤ committed` unit test; 64 MB ballast moves `live`.

### Phase A — pressure ladder below the kill cap
Keyed on `primary_metric` (NOT `rss_bytes()`, which stays untouched) as fractions of the 2048 cap; one-stage-per-tick; actions on transition edge; hysteresis −10%. Env kill-switch **`AGENTLENS_PRESSURE_LADDER=off`** disables (default on).

| Stage | Engage | Release | Cumulative actions |
|---|---|---|---|
| 1 | ≥1434 MB | <1229 MB | `stripped_cache.clear()` (cheap: derived from still-cached summary); abandoned-pressure (expose `abandoned_pressure()` from chores.rs:721-728) |
| 2 | ≥1638 MB | <1434 MB | + `summary_cache.clear()` (safe: window inputs changing ⇒ rebuild scheduled anyway); existing `effective_ms` halving re-keyed here; `latest_resident_blobs.clear()`; composition LRU clear |
| 3 | ≥1843 MB | <1638 MB | + `max_spans = max(max_spans/2, 10_000)`; `effective_ms` floor 5 min |
| kill | ≥2048 MB | — | `check_and_enforce` unchanged |

- `mi_collect(true)` is DROPPED from the ladder (measured 0/172 — useless for in-page residue; the abandoned-pressure mechanism is the proven reclaim).
- `derived_cache.rs`: add `clear()`; `lib.rs`: `pressure_stage: u8`, pure `pressure_stage(metric, cap)`; rewrite `prune_window`; delete `rss_budget_bytes` + `AGENTLENS_RSS_BUDGET_MB` (sole consumer confirmed lib.rs:684).
- Expected effect: headroom of a few hundred MB + bounded worst case. **Not kills=0.**
- Verify: unit tests (thresholds; engage/hold/release/oscillation-at-boundary); fake-metric integration test drives 1→2→3→release; synthetic overload run shows stage transitions on the composition line.

### Phase B — DuckDB limit right-sizing + spill
| Site | Today | New | Spill dir |
|---|---|---|---|
| card_store.rs:82 | 256MiB | keep | cards.duckdb.tmp (existing) |
| statusline_store.rs:229 | 2GB | **512MiB** | `<data_dir>/statusline/tmp` |
| bodies_evidence.rs:73 | 2GB | **256MiB** | `<data_dir>/store/tmp` |
| transcript_sql.rs:401 + :572 DuckSession + ui.rs:2839 burn-seismic | 2GB ×3 | **512MiB** each | `<data_dir>/store/tmp` |
| chores.rs:287 bodies pass | 2GB | **512MiB** | `<data_dir>/store/tmp` |
| agentlens-store lib.rs:42 (body_archive export) | 8GB | **1GB** | store tmp |
| session_summary_sql.rs:122 | 1GB | **512MiB** | `<data_dir>/tmp/session-summary` |

- Theoretical concurrent sum ≈ 2.3 GB — over cap — but practical concurrency is 2-3 connections and **spill is the safety valve, not the arithmetic**: every site above sets `temp_directory` to a real dir (create at open), so over-limit = latency + disk, never kill. Tmp-cleanup chore: boot deletes `*/tmp`; 60s tick unlinks files >1 h old. Keep `AGENTLENS_DUCKDB_MEMORY_LIMIT` override (statusline + bodies_evidence share it today — keep shared).
- Verify: `current_setting` read-backs (pattern card_store.rs:363-373); over-limit sort succeeds, leaves no tmp file after close; cleanup removes planted stale file.

### Phase C — incremental summary rebuild (the root-cause fix)
1. Resident parsed layer `parsed_cards: IndexMap<String, Arc<Value>>` in CoreState, maintained at `put_log_session` (the card is already a parsed `Value` there — zero extra parse; IndexMap preserves first-insert order + upsert-keeps-slot, matching today's replay); `demote_cold_timelines` strips demoted entries (CardStore::demote_cold returns affected ids); `cards.clear()` empties it; `summary_now` cold-boot path updated too. Resident ~200-350 MB is deliberate — live shared data replacing per-pass re-materialization.
2. `summary_snapshot` returns `Vec<Arc<Value>>` (pointer copies; lock hold = refcount bumps; `cards_json()` demoted to a cold-boot/CLI path).
3. **Attack the real clone sites**: `summary_over`'s OTEL-sessions deep clone (lib.rs:407) and the api_request attribution clones (lib.rs:395-399) — Arc the summary's sessions array (or clone-on-write: only sessions that changed are re-stamped via `Arc::make_mut` in the merge path).
4. `stripped_cache`: derive the stripped form incrementally from the same Arc layer (kill the strip-clones-every-card copy at ui.rs:476) — or make stripped a projection computed on demand; measure first.
- Files: lib.rs, ui.rs, card_store.rs, feed_merge.rs.
- Targets: free-in-page slope at equal load −80%; per-rebuild-pass committed delta → near zero.
- Verify: parity (byte-identical summary JSON + otel_attribution vs old path on a fixed corpus); incremental property (interleaved puts + rebuilds == full rebuild); demotion invalidation; `summary_now` cold-boot parity.

### Phase F — incremental save_cards (after C)
- Schema change is trivial — the card DB is deleted+recreated every boot: ADD column `updated_ms REAL` (wall-clock at put; `last_active_ms` is content-derived startTime+durationMs — a ranking, NOT a write watermark; `seq` is assign-once). `changed_since(w) -> IndexMap<String, Value>` on `updated_ms > w`.
- `save_cards`: dirty cadence (5 min) → `append_changed` subset (delta_log.rs:201-216 subset path exists); full `save` (whole scan) every 12th save (~hourly — deletion-diff + compaction need the full set) + immediately after `/api/clear`. `full_scan_calls` stays as tripwire.
- Target: `full_scan_calls` ~1/hour not 1/5 min.
- Verify: parity (changed_since ⊆ persist_records; delta-log replay of incremental+full sequence reproduces the store).

### Phase D — streaming boot restore (after F, same files)
- `delta_log.rs`: `load_streaming(apply: FnMut(&str, Option<&Value>)) -> Result<u64>` — BufReader lines (replaces `read_to_string`+split), blank-skip, torn-tail tolerance re-derived (last line fails parse + EOF = tolerate; corrupt line elsewhere = error), `written` seeded last-wins during stream.
- `log_reader.rs restore()`: **version gate FIRST** (kills the load-then-discard waste); stream cards → `put` in RESTORE_CHUNK transactions (keep — 256MiB pool fills without commits); tombstones → new `CardStore::delete(id)`; feeds `parsed_cards`. `save()` needs no change (writer side keeps the full set).
- Note: stale-version boots fall to the 26k-file cold scan — already chunked (2,000/chunk, flushed+dropped); D's win applies to the normal path; the cold-scan path's burst is bounded by existing chunking and visible on the Phase 0 line.
- Targets: boot abandoned burst (531-532 MB first tick) → <50 MB; boot baseline 625-1194 MB → <700 MB.
- Verify: parity matrix (tombstones, later-wins repeated keys, torn tail, corrupt middle errors, stale gate restores nothing cheaply); `written` seeding (first post-restore save appends 0 bytes); next_seq order preserved.

### Phase E — window shrink (riskiest, last)
- Defaults: `max_spans` 1M → **50,000**, `effective_ms` 24h → **30 min** (both env-overridable — an env-only revert exists). FSMISF5K: 1/23,274 cards from window.
- The three `window.spans.clone()` sites (ui.rs:533,:1048,:1127) feed `compute_sidebar_payload` which uses spans for EXACTLY `max(receivedAt)` (update_payload.rs:65-70) → new `last_received_at_ms: i64` set at `window.add`; kills three full-payload clones per push/frame/page (also shrinks the SSE full-frame build in G's scope).
- Wire the built-but-unwired `session_summary_sql` (TRDD-FSMISF5K) into the 60s chore for per-session OTEL aggregates (memory_limit 512MiB per Phase B).
- Pre-implementation: `tldr` reverse-impact sweep on `window.spans` (MCP `get_call_context` resolves via registry — expected clear); codex-store-groups debug endpoint accepts hot-tail scope.
- **Post-ship regression measure: count served cards originating from the window before/after the cut; alert on divergence** (the FSMISF5K counter is the baseline).
- Target: resident span bytes → <100 MB at load.
- Verify: consumer parity on fixtures (sidebar isActive identical; codex-store-groups); summary parity within the hot window.

### Phase G — per-request allocation hardening (after E; re-rank on Phase 0 data)
- SSE `push_update`/`sse_response`: stop rebuilding the full payload per broadcast tick — send deltas or throttle full frames; measure the tick cost first.
- Ingest POST: bound the 64 MB body accumulation (stream-parse or cap by config); per-span String + Arc is necessary (store + window) — leave unless Phase 0 shows it dominating.
- MCP: `tools()` returns `Arc` (schema is static); `get_recent_sessions` clones the array per call — Arc it. request_log rss syscall: throttle to the 5s tick.
- Targets: set from Phase 0 attribution data.

## Execution order

**0 → A → B → [24 h attribution gate] → C → F → D → E → G.** One lean-worker per phase (one writer per file set; chores.rs sequenced between A and B commits; lib.rs/ui.rs sequences A→C→E). Main session verifies per phase: `cargo test --workspace --manifest-path rust-core/Cargo.toml` (workspace confirmed; integration tests live in `rust-core/crates/agentlens-core/tests/` — card_store.rs, delta_log.rs, rss_hard_cap.rs, span_window_memory_guard.rs — plus agentlens-store/tests/memory_limit_scope.rs).

**Live soak gate (after C+F+D): kills=0 over ≥24 h at organic load** (baseline: a kill every 2.3 min), free-in-page slope collapse, boot baseline <700 MB. Repeatable harness: replay a captured day of OTLP POSTs (record one from the current server.log-adjacent OTLP stream or fixtures) — synthetic load drives every soak, not organic luck.

## Cap-margin budget (all phases landed, worst-case steady state)

| Component | MB |
|---|---|
| mimalloc live (parsed_cards 200-350 + window <100 + summary/stripped ~112 + misc ~100) | ≤ 660 |
| mimalloc freed-residue (post-C/D/F target) | ≤ 400 |
| DuckDB practical concurrent (card 256 + bodies 512 + one 512 site) | ≤ 1,280 |
| DuckDB burst headroom (spill absorbs over-limit) | — |
| **Total (design target)** | **≤ 1,950 < 2,048** |

Ladder stage 3 (≥1843) is the last defense inside the margin.

## Not changing
Cap 2048 MB. `check_and_enforce`. Ingestion durability (spans → NDJSON day files, cards → delta log → DuckDB) — no data-loss path; Phase F/D changes are read/write-cadence only, parity-tested. `rss_bytes()` semantics (dashboard/stats/request-log wire format). `MIMALLOC_PURGE_DELAY=0`. mimalloc as allocator (churn is cut by not allocating, not by swapping allocators).

## Approval log

- 2026-09-29T20:20:37+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Amendment 1 — dashboard reads: DuckDB pagination + SQL stats (owner directive 2026-09-29, verbatim)

Owner: 'i still see 600 cards loaded in memory.. why does it needs so many cards at the same time? if it is for displaying the dashboard, duck db pagination is enough for a lazy loading pagination, especially if only one tree branch can be expanded at any time. if it is for computing statistics and find culprits, using duckdb sql functions it is way faster and only returns the list with the results. why those?' — DESIGN RULE ADOPTED: the dashboard NEVER receives the whole card corpus. Card listing endpoints serve DuckDB-paginated pages (keyset pagination on cards.duckdb seq; one expanded tree branch fetched at a time); statistics and culprit searches run as DuckDB SQL aggregations returning small result lists, never in-Rust scans of the corpus; the per-rebuild whole-corpus materialization (Phase C target) and the whole-corpus summary/stripped caches SHRINK to a hot-set consistent with this rule. Scope landing: extends Phase C (summary/snapshot shrinks to what a page query needs) and Phase E (session_summary_sql wiring is the stats-engine exemplar); the dashboard-side pagination contract (media/src message protocol) is Phase E scope, implemented with Phase C's card-layer changes. The LRU caches (bodies 200, accounts 200, composition 64, overlay 500, hook ring 600->500) are re-judged against this rule when Phase G touches their consumers: keep only what a paginated + SQL-stats dashboard actually reads hot.
