---
trdd-id: C6W0SWUT
title: Rust DuckDB readers were not examined for paths with pattern characters
column: todo
status: tasked
created: 2026-11-18T11:52:27+0100
updated: 2026-11-18T19:12:32+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-18T11:52:27+0100
---

# Rust DuckDB readers were not examined for paths with pattern characters

Opened 2026-11-18 by the main agent from TRDD-CXNUWXX7. Measured there (DuckDB v1.5.4, node package, macOS): read_json_auto, read_json, read_ndjson, read_ndjson_objects and read_parquet read a path holding star, question mark or open bracket as a file pattern when the path is only quote-doubled. The Rust crates under rust-core also build DuckDB read calls from paths under the data dir (for example read_json_auto in rust-core/crates/agentlens-core/src/statusline_store.rs). NOT known: which helper quotes the path at each Rust site, and whether the bundled DuckDB of the Rust crates expands such a path the same way.

## Acceptance
- [x] Every DuckDB file read site of the Rust crates is listed with the code that quotes its path.
- [ ] It is measured with the Rust binary whether a data dir holding star, question mark or open bracket is read as a pattern.
- [ ] Either the sites use one escaping helper with a committed test, or it is written here why they cannot receive such a path.
2026-11-18 main agent, BOX 1. Read sites listed by a worker (reports_dev/cheap-worker/20261118_w47-rust-duckdb-read-sites/report.md, revision 3, read whole by the main agent) for the pattern read_json_auto, read_json(, read_ndjson, read_ndjson_objects, read_parquet, parquet_scan, read_csv, read_text, read_blob, glob(: 63 hits, 28 production sites, 7 test-only, 28 skipped with a reason each. Sites 2 to 28 put the path in single quotes with the apostrophe doubled and escape nothing else, through the helpers q (agentlens-store/src/lib.rs:237, agentlens-core/src/statusline_store.rs:162), sq (agentlens-core/src/burn_seismic.rs:479) or inline doubling (session_summary_sql.rs:147, transcript_sql.rs:521). Site 1, the digest macro (agentlens-digest/src/register.rs:149), binds the path as a statement parameter (collect.rs:146-149), so it gets no quoting; whether DuckDB expands a bound path as a pattern is not known. Wider grep by the main agent (read_json_objects, parquet_metadata, parquet_schema, COPY ... FROM, ATTACH, IMPORT DATABASE, FROM quote, read_json word): no further read site; it adds agentlens-core/src/card_store.rs:605 (ATTACH of a database file built from a path, apostrophe doubled), agentlens-core/src/statusline_store.rs:805 (COPY TO target, q) and the test COPY at cache_turns_sql.rs:1352. NOT traced: the callers of most helpers (listed under Unresolved in the report), so whether a path can come from outside the data dir is not established; the report also notes that parquet_scan drops non-UTF-8 part paths (lib.rs:278-291) and that the to_string_lossy sites rewrite invalid bytes.
- 2026-11-18 wider grep (review finding 1-2): `grep -rnE "FROM \{|FROM '\{|COPY " --include='*.rs' rust-core/crates` gave 86 hits, all read. The `FROM {x}` hits in production take a relation string built elsewhere (all_of, parquet_scan, read_json, a scan variable); they hold no path literal of their own, so the path is escaped (or not) at the builder, which is one of the 28 counted sites. Production COPY TO targets: agentlens-store/src/lib.rs:689 and agentlens-core/src/statusline_store.rs:805, both through q (apostrophe doubled). A COPY TO target is a write path, not a read glob, so q is enough there; box 2 keeps q on them. The other COPY hits are in test modules (cache_turns_sql.rs:865 and 1352 after its #[cfg(test)] at 571; lib.rs:1793 after 1751; statusline_store.rs:996-997 after 969) or in tests/. statusline_store.rs:806 is a read site, read_json_auto({wal_q}), inside the counted set by W47's own report (not re-checked here).

## Approval log

- 2026-11-18T11:52:27+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
