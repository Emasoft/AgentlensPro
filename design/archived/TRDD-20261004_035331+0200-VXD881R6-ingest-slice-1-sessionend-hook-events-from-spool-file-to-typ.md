---
trdd-id: VXD881R6
title: Ingest slice 1 - SessionEnd hook events from spool file to typed DuckDB table via a precompiled digest macro
column: complete
status: archived
created: 2026-10-04T03:53:31+0200
updated: 2026-10-04T08:12:11+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: feature
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-04T03:53:31+0200
implementation-commits: [69b7d406, 6f8d1d16]
---

# Ingest slice 1 - SessionEnd hook events from spool file to typed DuckDB table via a precompiled digest macro

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-10-04T03:59:08+0200
NEXT ACTION: DONE inside crate agentlens-digest (commits 69b7d406, 6f8d1d16), in a broader form than this card specified: all hook events and the status line, spool groups, no view. The body below is the original slice plan and is superseded by TRDD-LHCHVK9Z "What is built".
Architecture and owner rulings: TRDD-LHCHVK9Z (read it first).

## Scope
One producer_type `hook_session_end_v1`, proven end to end as a library + tests. NOT wired into alcore, no settings.json change, no reader ported. Why a new crate rather than a module of agentlens-store: the digesters must stay small and free of the store's dependencies.

## What is built
- New crate rust-core/crates/agentlens-ingest (depends on duckdb at the workspace's version; no dependency on agentlens-core).
- Fixed schema file for the SessionEnd hook line (producer line {"ts_ns": <integer unix nanoseconds added by the spool writer>, "payload": <the raw hook JSON exactly as Claude Code delivers it>}); payload keys taken from reports/ingest-redesign/20261004_032952+0200-plan-premises-measure.md section 3 plus a look at key NAMES in ~/.agentlens/hook-events (never copy values). Always-present keys (cwd, hook_event_name, session_id, transcript_path) are NOT NULL; optional keys are nullable. The digest macro FLATTENS the payload fields into top-level table columns (NOT NULL cannot be applied inside a STRUCT).
- `register(conn)`: creates schema `_ingest` (tables `files` ledger, `table_timeline`), table `hook_session_end_v1` (no PK/unique index; columns _meta_event_id, _meta_ingest_id, _meta_record_ordinal, _meta_recorded_at_ns, _meta_recorded_at, _meta_ingested_at + the typed fields), the table macro `digest_hook_session_end_v1(path)` = fixed SELECT over read_ndjson(path, columns={explicit types}) (never ignore_errors), the timeline row, and the view `v_hook_session_end` over all versions.
- `collect(conn, ingest_dir)`: for each file in ready/hook_session_end_v1/: BEGIN; insert ledger row (status loading) returning ingest_id; `INSERT INTO hook_session_end_v1 SELECT … FROM digest_hook_session_end_v1(?)` as a prepared statement, with _meta_record_ordinal = row_number() over () inside the macro (correct only with preserve_insertion_order=true and a single-threaded scan) and _meta_event_id derived from ingest_id and ordinal; update ledger to complete with record_count; COMMIT; rename the file to done/. A load that raises: ROLLBACK, move the file to failed/ with `<name>.error.txt`, continue with the next file. `reconcile()` at start: a ready/ file whose ledger row is complete is moved to done/ without reinserting.
- events.duckdb opened with memory_limit='256MB', threads=1 for the slice (provisional for the slice; the real budget is build step "Memory budget").

## Tests (each must be able to fail; fixtures are SYNTHETIC, ids visibly fake)
All tests live in ONE test file (each test binary statically links DuckDB).
1. Happy path: N lines in, N rows out, fields land in the right columns, view returns them in (_meta_recorded_at_ns, _meta_ingest_id, _meta_record_ordinal) order; _meta_record_ordinal equals the line position.
2. Unknown key in a line is ignored; the row loads.
3. Missing optional key -> NULL; missing required key -> the file goes to failed/ with an error file, zero rows from it. (Test 2 and the first half of this test are regression guards that pin DuckDB's default behaviour.)
4. Wrong type -> failed/, zero rows from that file, the next file still loads.
5. Crash after COMMIT before rename (run the load in a child process killed with SIGKILL after COMMIT returns and before the rename, then open the database fresh in the parent): restart, reconcile, row count unchanged (no duplicates).
6. Crash after the INSERT, before COMMIT (child process killed with SIGKILL, then open the database fresh in the parent): the file loads once.
7. Re-running collect on an empty ready/ is a no-op.
8. A second producer version `hook_session_end_v2` with one added field and one renamed field, its own table, macro and timeline row: the view returns rows from both versions with the rename mapped.
9. Two files in one collect where the second fails: the first stays committed.
10. An empty file.
11. A last line without a newline.
12. The same filename presented twice is skipped via the ledger.

## Pass bars
No pass bar yet: report CPU time and peak RSS for a 1,000-line file; bars are set from that measurement.

## Out of scope
The spool writer binary (TRDD-HH1NP0KD), sealing inbox->ready, retention deletion, alcore wiring, other hook events, the generator of step 4.

## Open
- OWNER: the producer line is the raw hook payload wrapped with a writer-added ts_ns (hook payloads carry no timestamp). Today's alcore envelope {ev, payload, session, ts} is not reused.
- The crate name agentlens-ingest in this card is taken by the existing OTLP crate; the new crate is agentlens-digest (see TRDD-LHCHVK9Z D-H).

## Related
Parent architecture card: TRDD-LHCHVK9Z (build step 2; it uses the SessionEnd schema from build step 1).

## Checks before done
cargo test --release -j 2 -p agentlens-ingest; cargo clippy --release -j 2 -p agentlens-ingest --all-targets -- -D warnings; `pnpm run check-identities` (fixtures must pass it).
Never a debug build (it would compile DuckDB from scratch; disk is 97% full). Add the crate to rust-core/Cargo.toml workspace members; Cargo.lock is committed with it. rust-core has no CI job yet (TRDD-NDKKOABG), so these tests run only locally.

## Approval log

- 2026-10-04T03:53:31+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-04T03:58:52+0200 — column → design by main-agent@agentlenspro. waits on the schema set (parent build step 1); design being corrected
- 2026-10-04T08:12:11+0200 — COMPLETE by main-agent@agentlenspro. built inside agentlens-digest, see LHCHVK9Z.

## Acceptance

- [x] Delivered inside crate agentlens-digest (commits 69b7d406, 6f8d1d16), in a broader form than this card specified; see TRDD-LHCHVK9Z "What is built".
