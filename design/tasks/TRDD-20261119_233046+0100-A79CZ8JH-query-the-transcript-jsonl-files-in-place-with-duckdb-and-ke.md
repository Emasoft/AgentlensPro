---
trdd-id: A79CZ8JH
title: Query the transcript JSONL files in place with DuckDB and keep only an index, never a digested copy
column: design
status: tasked
created: 2026-11-19T23:30:46+0100
updated: 2026-11-20T00:27:46+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: refactor
min-approval-requirement: none
scope: project
project-id: agentlenspro
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-19T23:30:46+0100
---

# Query the transcript JSONL files in place with DuckDB and keep only an index, never a digested copy

Owner directive 2026-11-19T23:30+0100 (verbatim): "duckdb doesn't need to load the jsonl transcripts into its own db. for duckdb, jsonl is already a native db format it can query against. there is no need to digest jsonl files at all, only indexing them." Scope: every path that parses Claude/Codex/Copilot transcript JSONL and copies its content into a DuckDB table, the card store or another store. Target: DuckDB reads the .jsonl files directly (read_json / read_ndjson_objects, as agentlenspro search and causingToolCall already do); alcore keeps only an index (which files exist, session id, project, mtime/size, byte offsets or line ranges per session/turn if a query needs them). Related: 7YPQWKPG (DuckDB is the memory), HFV4AIT7 (its 'JSONL to DuckDB load' contradicts this directive), IPLPDD19, LHCHVK9Z, Q9WD3K5R. First step: an inventory of every JSONL-to-store copy, with file:line.

## Approval log

- 2026-11-19T23:30:46+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Process log

2026-11-20T00:02+0100 inventory r2 read whole by the main agent: reports_dev/A79CZ8JH/20261119-jsonl-copy-inventory-r2.md (supersedes the first file, whose title still says rev 2). Within the swept patterns (INSERT INTO, INSERT OR, COPY..TO, CREATE [OR REPLACE] [TEMP] TABLE, read_ndjson, read_json, read_parquet, Appender; case-insensitive; rust-core/crates, src, standalone, scripts) the only DuckDB store fed from transcript content is cards.duckdb (Card pipeline C1-C5). No transcript line is loaded as a table of rows. Non-SQL file writers other than the card and offset delta logs were not swept (INFERRED).
2026-11-20T00:02+0100 blockers for the redesign, from the inventory: (1) retention, code-backed: put_arc only upserts and restore re-puts every card, so for sessions whose transcript Claude Code deleted (cleanupPeriodDays) or whose Codex/Copilot/OpenCode source rotated, the card is the only remaining copy; an in-place query cannot answer those sessions. (2) OpenCode is SQLite and Copilot VS Code is a delta log, not row JSONL. (3) A corpus-wide per-session GROUP BY over read_json is UNMEASURED; the measured facts are the searchCli window OOM at 1.8 GiB and about 2x maximum_object_size per reader thread. (4) The log-offsets delta log is already an index (path, size, mtime, ino); about 9 independent walks of the projects tree could share one queryable file index.
2026-11-20T00:02+0100 non-transcript JSONL to DuckDB loads also exist (spool to events.duckdb, OTEL span segments, statusline WAL to parquet, raw bodies to parquet); listed for the owner, not in this card's scope until the owner says so. NEXT: advisor on the redesign after the v2.34.0 release; ask the owner the retention question (keep a card copy for sessions whose transcript is gone, or accept losing them).
2026-11-20T00:05+0100 retention premise checked by the main agent (✓ VERIFIED, rust-core/crates/agentlens-core/src): production card deletes are only discard_cards at log_reader.rs:1128 (card-store reuse refused because the offsets log carries another ingest version; then a cold rescan) and CardStore::clear via lib.rs:1036 clear_all (POST /api/clear); the other .clear() hits at log_reader.rs:2675/2865/2997 sit after #[cfg(test)] at :2099. No path drops a card because its transcript vanished, so the card is the only surviving record for a deleted transcript. Nuance: an ingest-version bump or /api/clear already loses those sessions today, so retention is not guaranteed now either.
2026-11-20T00:11+0100 correction of the previous retention line (it rested on a discard_cards/clear grep only). Wider sweep (DELETE FROM, .remove(, .retain(, tombstone, CARD_SCHEMA_VERSION, DROP TABLE over card_store.rs, log_reader.rs, lib.rs; 71 hits read whole): in steady state no path drops a card because its transcript vanished (log_reader.rs:1079 comment: the snapshot puts keep the gone-file cards). Cards ARE dropped on three events: /api/clear (card_store.rs:964); an ingest-version change, which tombstones every key the rescan did not rebuild, gone-file cards included (log_reader.rs:990, discard_cards at :1128); and the card-file rebuild with DROP TABLE when reuse is refused (card_store.rs:437; whether the snapshot log then restores the gone-file cards: INFERRED, not traced). Test-only: log_reader.rs:2100-3064 is mod sweeper_backstop_tests (last top-level closer at :3064).
2026-11-20T00:27+0100 retention, settled by reading log_reader.rs:950-1012 (restore_from_snapshot) and card_store.rs: (a) no production shift_remove/swap_remove on the resident layer (hits at card_store.rs:1582/1606 are inside mod tests, lines 1425-2145); (b) an ingest-version change and an interrupted /api/clear put no card into the store and tombstone both logs, so cards of deleted transcripts are lost then (✓ VERIFIED); (c) a schema-version refusal (the DROP TABLE rebuild, card_store.rs:437) does NOT take that branch: the code comment says its snapshot cards are kept (restore path itself not traced further). Net: in steady state the card is the only surviving record of a deleted transcript; it is lost on /api/clear and on an ingest-version bump.
