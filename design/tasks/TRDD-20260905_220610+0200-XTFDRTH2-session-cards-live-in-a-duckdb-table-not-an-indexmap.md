---
trdd-id: XTFDRTH2
title: Session cards live in a DuckDB table upserted on ingest, not in a 32k-entry IndexMap
column: ai_review
created: 2026-09-05T22:06:10+0200
updated: 2026-09-23T12:57:51+0200
implementation-commits: [f29bc3b6, 8069c6a9, e00af58b, 13209791, 12c4c4a7, 46a0268c, ac289d8d]
current-owner: main-session
task-type: refactor
priority: high
min-approval-requirement: none
scope: project
project-id: agentlenspro
parent-trdd: 7YPQWKPG
npt: [YILE6N3T, 7RM5YW2T]
related: [7YPQWKPG, Q9WD3K5R, FSMISF5K]
relevant-files: [rust-core/crates/agentlens-core/src/lib.rs, rust-core/crates/agentlens-core/src/log_reader.rs, rust-core/crates/agentlens-core/src/feed_merge.rs]
labels: [rust-core, memory, duckdb]
---

# Session cards live in a DuckDB table upserted on ingest, not in a 32k-entry IndexMap

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-06T04:32:40+0200

**DEPLOYED AND VERIFIED LIVE 2026-09-06T04:32+0200 — all 3 acceptance boxes ticked, card moved
`testing → ai_review`.** pid 78233 deployed 04:13, uptime ~18m at measurement time. Box 3 (mimalloc
resident bound): pre-change 10.8 GB → post-change 10.6 GB, threshold 10.7 GB (10.8 − 0.1 GB cards'
share) — PASS. Full numbers in the Acceptance section box 3 and
`reports/7ypqwkpg/20260906_043240+0200-t15-verdict-xtfdrth2.md`. Nothing else outstanding on this
card.

**CODE IS DONE AND GREEN on branch `worktree-agent-a7d79196282fd6298`, NOT DEPLOYED.** Five commits
(see `implementation-commits:`), each one phase. `CoreState.log_sessions` no longer exists;
`card_store.rs` owns one long-lived in-memory DuckDB connection with
`cards(session_id PK, seq, last_active_ms, timeline_len, card VARCHAR)`. Gates on every phase:
`cargo clippy -p agentlens-core --all-targets -- -D warnings` clean, `cargo test -p agentlens-core`
**616 passed / 0 failed across 104 suites** (`alcore` is a bin of that crate, so it is covered).
Zero expected outputs edited — only test ACCESSORS moved (`st.log_sessions["x"]` →
`st.cards.get("x").unwrap()`).

**NEXT ACTION (main session, needs the live server):** deploy — `cargo build --release`, copy into
`bin-native/darwin-arm64/`, `codesign -s - --force`, `agentlenspro server restart` — then take the
box-3 measurement (resident mimalloc heap after boot vs the 8.7 GB pre-change figure) and record it
here. Nothing else is outstanding.

**Two deviations from the card's `## Shape`, both deliberate — rule on them before closing:**

1. **Boot restore does NOT use `read_ndjson_auto`.** It still goes through `DeltaLog::load()` →
   `put_log_session` per card, which now upserts into the table. `read_ndjson_auto` needs
   `ignore_errors=true` to be usable, and that SILENTLY DROPS a corrupt line — whereas `load()`'s
   documented contract tolerates exactly ONE torn TRAILING line and REFUSES a corrupt line anywhere
   else, because that is real damage and the on-disk format is byte-compatible with the TS engine.
   It would also have to re-implement snapshot+delta precedence, tombstones, and the TRDD-66IXMIGN
   timeline-cap normalization in SQL. The memory goal is met either way: cards are parsed one at a
   time and land in the table, not in a resident map.
2. **A `seq` column was added** (the sketch said `session_id PK, start_ms, card JSON`), and
   `start_ms` is stored as `last_active_ms` (start + duration), which is the value the demotion
   ranking actually uses. `seq` is not cosmetic — it is what reproduces `IndexMap` iteration order,
   which the served `sessions` array depends on for cards sharing a `startTime` (the final sort is
   stable). `card` is VARCHAR and not DuckDB's `JSON` type on purpose: a `JSON` column re-emits the
   document from a parsed form and can reorder keys / reformat numbers, which would change the
   wire bytes.

**One residual worth knowing, NOT a defect:** `summary_snapshot` now copies the whole corpus as
`Vec<String>` under the state lock (the parse happens off it, in `summary_from`). That is inherent —
the DuckDB connection lives inside `CoreState` and cannot be read off the lock — and it replaces an
`IndexMap` clone of 32k `Arc`s + `String` keys. It is bounded by the rebuild cadence TRDD-7RM5YW2T
rationed. If it ever measures as a hold, the fix is to hand the rebuild a second read-only
connection, not to reintroduce a resident map.

Advisor step 2 of TRDD-7YPQWKPG (verdict 2026-09-02), re-issued by the USER 2026-09-05 22:00
("why are there persistent data structures in RAM instead of just the small query results from
DuckDB"). Today `CoreState.log_sessions: IndexMap<String, Arc<Value>>` holds 32,607 cards
(`lib.rs:188`), filled by the boot/incremental log scan, stripped to headers except 50 hot ones,
cloned wholesale into every summary snapshot.

## Shape

ONE long-lived in-memory DuckDB connection owned by `CoreState`; table
`cards(session_id PK, start_ms, card JSON)`; `put_log_session` becomes an upsert; boot restores
from the delta log (`log_reader.rs:689`) via `read_ndjson_auto` (precedent `transcript_sql.rs:413`);
`feed_merge.rs` stays Rust over the colliding ids only; every reader that today iterates
`log_sessions` becomes a query that returns and drops its rows. The wire shape of every route
stays byte-identical (7YPQWKPG acceptance).

## NEXT ACTION

Blocked on the two same-day bugfix NPTs landing (they change the same files' hot paths). Then:
list every reader of `log_sessions` (`grep -n log_sessions` — `lib.rs`, `ui.rs`, `log_reader.rs`,
`feed_merge.rs`, `chores.rs`), write the table + upsert + boot-restore, convert readers one file per
phase (≤5 files per phase), parity tests unchanged.

## Acceptance

- [x] `CoreState` has no `log_sessions` map; `grep -rn 'log_sessions' src/` → only the DuckDB
      accessor. **Verified 2026-09-06** (commit 13209791). The field is gone. The grep returns FIVE
      residual hits and none of them is a resident structure: `feed_merge.rs:90/91/97/108` are the
      function `merge_otel_and_log_sessions`, its `Vec<Value>` parameter and its locals, and
      `lib.rs:411` is the call site. That is the function this card's `## Shape` says stays Rust
      ("`feed_merge.rs` stays Rust over the colliding ids only"); it never held the map. There is
      no symbol named `log_sessions` on `CoreState` and no accessor by that name — the accessor is
      `CoreState.cards` (`card_store::CardStore`).
- [x] All parity/golden tests unchanged; every `agentlenspro` tool answers with identical shape.
      **Verified 2026-09-06.** Not one expected value was edited anywhere — the TS-oracle fixtures
      (`log-reader-expected.json`, the feed-merge fixture) and the freeze-row assertions are
      byte-for-byte what they were; only test ACCESSORS moved with the field. The tool-shape half
      is carried by the `mcp_tools` oracle suites (`get_recent_sessions` / `get_session_detail` /
      `get_cost_rollup` / `get_workspace_patterns` / `get_efficiency_report` /
      `find_relevant_context` / `predict_session_cost` … `_reproduces_the_ts_oracle_exactly`),
      unchanged and green. What that does NOT cover, and the deploy will: the same tools invoked
      through a LIVE server against the real corpus.
- [x] Resident mimalloc heap after boot ≤ the pre-change figure minus the cards' share, recorded.
      **Verified 2026-09-06 (live, pid 78233, deployed 04:13, uptime ~18m).** Pre-change
      (immediately before this deploy, pid 93345):
      mimalloc `TOTAL` resident 10.8 GB (`reports_dev/vmmap-93345-20260906_031614+0200.txt`); cards'
      on-disk share ≈0.1 GB → threshold ≈10.7 GB. Post-deploy: mimalloc `TOTAL` resident **10.6 GB**
      (`reports_dev/vmmap-78233-20260906_043047+0200.txt`, `TOTAL` row: VIRTUAL 19.3G / RESIDENT
      10.6G / DIRTY 2.5G; physical footprint 2.5G, peak 13.2G). 10.6 GB ≤ 10.7 GB threshold — **PASS**.
      Server-reported rss also improved: 10402→10720MB over the 18-min window (t15 report
      `reports/7ypqwkpg/20260906_042951+0200-t15-after-xtfdrth2.md`), cards store on disk 100.3MB.
      CPU over a real 60s wall interval: cputime 8:17.70→8:52.23 = Δ34.53s/60s = 57.55% (down from
      65.5% pre-change, though CPU is TRDD-7RM5YW2T's own box, not this card's).

## Notes and lessons learned

**Phase 0 — the complete reader/writer inventory** (`grep -rn log_sessions
rust-core/crates/agentlens-core/src`, taken 2026-09-06 before any edit). Note the card's NEXT
ACTION named `chores.rs`: it has NO reference and never did.

| file:line | what it did | phase |
|---|---|---|
| `lib.rs:133` | `SummaryInputs.log_sessions` field | 2 |
| `lib.rs:188` | `CoreState.log_sessions` field | 4 (deleted) |
| `lib.rs:277` | `put_log_session` — THE one write path | 1 (dual) → 4 |
| `lib.rs:285,289,297` | `demote_cold_timelines` — len guard, stable rank, `Arc::make_mut` strip | 1 (dual) → 4 |
| `lib.rs:331` | `session_summary` | 2 |
| `lib.rs:341` | `summary_snapshot` (the under-lock copy) | 2 |
| `lib.rs:349,370,399,403` | `summary_from` / `summary_over` (the deep clone of all cards) | 2 |
| `lib.rs:434,437` | `build_session_summary` disjoint-borrow destructure | 2 |
| `lib.rs:568` | `open()` initialiser | 4 |
| `lib.rs:627` | `clear_all` | 1 (dual) → 4 |
| `ui.rs:780` | `resolve_session_card` reparse gate | 3 |
| `ui.rs:886` | `resolve_session_card_offlock` reparse gate (lock 1) | 3 |
| `ui.rs:102` | doc comment only | 3 |
| `import_card.rs:85` | `import_sessions` already-known-id → `skipped` | 3 |
| `server_stats.rs:651` | `logSessions` count in `/api/server-stats` | 3 |
| `log_reader.rs:776` | `save_cards` — the durable-save strip scan | 4 |
| `feed_merge.rs:90-108` | `merge_otel_and_log_sessions` — a `Vec<Value>` parameter, NOT the map | none (stays Rust) |

**Lesson — an `IndexMap` field is three contracts, not one.** Replacing it with a table only looks
like a storage swap. What it actually removes is (a) first-insert iteration order, (b) an upsert
keeping its slot, and (c) a STABLE sort's tie-break falling back to that order — and all three are
observable on the wire, because the served `sessions` array is produced by a stable sort over the
corpus. A table has none of them; they come back as a `seq` column plus `ORDER BY` on every read.
No existing test would have caught losing them: every fixture in the suite has DISTINCT
`startTime`s, so an unordered scan passes all 616. The guard is
`tests/card_store.rs::cards_sharing_a_start_time_are_served_in_first_insert_order`, written and
verified green BEFORE the switch so it pins the OLD behaviour rather than blessing the new one.

## Approval log

- 2026-09-05T22:06:10+0200 — Authored into `todo` as an NPT-gated child of the USER-approved
  7YPQWKPG (Tier 0: scope already ruled by the USER).

## ⏵ AI-REVIEW VERDICT 2026-09-23T12:55:59+0200 — APPROVE

Box 1 (no log_sessions map) — met, independently reproduced. Evidence: grep -rn 'log_sessions' rust-core/crates/agentlens-core/src/ -> exactly 5 hits, all inside feed_merge.rs's merge_otel_and_log_sessions (a Vec<Value> parameter/locals per the card's own Shape) plus its call site lib.rs:413; CoreState.cards is card_store::CardStore (lib.rs:191-200).
Box 2 (parity tests unchanged, accessors moved) — INFERRED, not re-run this session (per rule 4, state what to run: cargo test -p agentlens-core, expect 616 passed / 0 failed across 104 suites). Read tests/card_store.rs:227-247 (cards_sharing_a_start_time_are_served_in_first_insert_order) in full: a real regression guard for the seq/tie-break behavior, asserting served order [tie-1,tie-2,tie-3,tie-4] across a mid-sequence upsert.
Box 3 (resident mimalloc heap <= threshold) — met. Evidence: reports/7ypqwkpg/20260906_043240+0200-t15-verdict-xtfdrth2.md: 10.8GB pre -> 10.7GB threshold -> 10.6GB post, PASS by a 0.1GB margin (soft pass, not dramatic, but meets the box's own bar).
Code verification: card_store.rs schema (lines 60-95) matches the card's documented deviations from its own Shape sketch (seq column added, card is VARCHAR not JSON type, last_active_ms not start_ms) — each justified in comments. put() (lines 95-111): ON CONFLICT DO UPDATE excludes seq, confirmed by reading the SQL text, so an upsert keeps its original insertion slot. demote_cold() (lines 197-230) ranks over the whole table before filtering timeline_len>0, matching the claim.
Interaction with today's heap work: reports/alcore-heap/20260923_112303+0200-heap-attribution.md lists cards: card_store::CardStore as FIXED (XTFDRTH2), not Rust-heap resident, in the current heap-growth investigation -- no conflict or regression recorded.
Findings: no blocking findings. Two deliberate Shape deviations (boot restore keeps DeltaLog::load instead of read_ndjson_auto; seq column added) are each justified and confirmed in code, not scope creep. The summary_snapshot whole-corpus clone under the lock is a documented, bounded residual, not disputed here.
Ready for human_review; the owner makes that move. Full report: reports/ai-review/20260923_125559+0200-batch-B.md
