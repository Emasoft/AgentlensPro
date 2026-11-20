---
trdd-id: C6W0SWUT
title: Rust DuckDB readers were not examined for paths with pattern characters
column: complete
status: archived
created: 2026-11-18T11:52:27+0100
updated: 2026-11-18T19:57:48+0100
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
implementation-commits: [290f0bc8, 02f6a0ca]
---

# Rust DuckDB readers were not examined for paths with pattern characters

Opened 2026-11-18 by the main agent from TRDD-CXNUWXX7. Measured there (DuckDB v1.5.4, node package, macOS): read_json_auto, read_json, read_ndjson, read_ndjson_objects and read_parquet read a path holding star, question mark or open bracket as a file pattern when the path is only quote-doubled. The Rust crates under rust-core also build DuckDB read calls from paths under the data dir (for example read_json_auto in rust-core/crates/agentlens-core/src/statusline_store.rs). NOT known: which helper quotes the path at each Rust site, and whether the bundled DuckDB of the Rust crates expands such a path the same way.

## Acceptance
- [x] Every DuckDB file read site of the Rust crates is listed with the code that quotes its path.
- [x] It is measured with the Rust binary whether a data dir holding star, question mark or open bracket is read as a pattern.
- [x] Either the sites use one escaping helper with a committed test, or it is written here why they cannot receive such a path.
2026-11-18 main agent, BOX 1. Read sites listed by a worker (reports_dev/cheap-worker/20261118_w47-rust-duckdb-read-sites/report.md, revision 3, read whole by the main agent) for the pattern read_json_auto, read_json(, read_ndjson, read_ndjson_objects, read_parquet, parquet_scan, read_csv, read_text, read_blob, glob(: 63 hits, 28 production sites, 7 test-only, 28 skipped with a reason each. Sites 2 to 28 put the path in single quotes with the apostrophe doubled and escape nothing else, through the helpers q (agentlens-store/src/lib.rs:237, agentlens-core/src/statusline_store.rs:162), sq (agentlens-core/src/burn_seismic.rs:479) or inline doubling (session_summary_sql.rs:147, transcript_sql.rs:521). Site 1, the digest macro (agentlens-digest/src/register.rs:149), binds the path as a statement parameter (collect.rs:146-149), so it gets no quoting; whether DuckDB expands a bound path as a pattern is not known. Wider grep by the main agent (read_json_objects, parquet_metadata, parquet_schema, COPY ... FROM, ATTACH, IMPORT DATABASE, FROM quote, read_json word): no further read site; it adds agentlens-core/src/card_store.rs:605 (ATTACH of a database file built from a path, apostrophe doubled), agentlens-core/src/statusline_store.rs:805 (COPY TO target, q) and the test COPY at cache_turns_sql.rs:1352. NOT traced: the callers of most helpers (listed under Unresolved in the report), so whether a path can come from outside the data dir is not established; the report also notes that parquet_scan drops non-UTF-8 part paths (lib.rs:278-291) and that the to_string_lossy sites rewrite invalid bytes.
- 2026-11-18 wider grep (review finding 1-2): `grep -rnE "FROM \{|FROM '\{|COPY " --include='*.rs' rust-core/crates` gave 86 hits, all read. The `FROM {x}` hits in production take a relation string built elsewhere (all_of, parquet_scan, read_json, a scan variable); they hold no path literal of their own, so the path is escaped (or not) at the builder. INFERRED, not traced: that each builder ({parts}, {scan}, {read_json}, the argument at body_archive.rs:155) is one of the 28 counted sites. The C6 worker reconciles this FIRST, before any edit. Production COPY TO targets: agentlens-store/src/lib.rs:689 and agentlens-core/src/statusline_store.rs:805, both through q (apostrophe doubled). A COPY TO target is a write path, not a read glob, so q is enough there; box 2 keeps q on them. The other COPY hits are in test modules (cache_turns_sql.rs:865 and 1352 after its #[cfg(test)] at 571; lib.rs:1793 after 1751; statusline_store.rs:996-997 after 969) or in tests/. statusline_store.rs:806 is a read site, read_json_auto({wal_q}), site #10 of W47's report rev3 (its table row at line 47, checked 2026-11-18).
- Review finding 4: the planned evidence for box 2 is a crate test of agentlens-store (tests/duck_path_pattern.rs). It measures the library code that alcore links, not a run of the alcore binary; the box is ticked only with that sentence beside it, or after a binary run is added.
- Review finding 6: that site 1 (the digest macro, register.rs:149) binds the path as a parameter rests on W47's report (collect.rs:146-149, caller collect.rs:70-77). The coordinator saw only collect.rs:71 in a grep, which has the placeholder ?::VARCHAR; the binding code was not read.
- 2026-11-18 W48 (report reports_dev/sonnet-worker/20261118_w48-c6-rust-glob-escape/report.md, diff read whole by the coordinator): agentlens-store gains glob_escape and sq_path (lib.rs:241-270); 27 of the 28 sites switched (parquet_scan covers #2,#3,#13-#20; #21-#28 in store lib.rs and transcript_sql.rs; #4,#5,#6-#12 in agentlens-core). COPY TO targets, ATTACH and the part_file value stay on q. Reconcile: no FROM-{x} builder outside the 28 (reconcile.md, by the worker's report).
- Evidence by the worker's report: tests/duck_path_pattern.rs 5 passed; red-then-green only for the store chain (red4 vs green1); the canary tests document the misread and pass before and after; cargo test -p agentlens-store all ok; cargo check -p agentlens-core --tests ok; statusline_store lib tests 2 passed; clippy no warning. NOT run after their edits: the burn_seismic and session_summary_sql unit tests. No pattern-dir test for the core sites (code read and compile only). Bound-path glob expansion shown with a stand-in macro of the digest shape, not the real macro. Residual: a path holding a backslash is left unescaped (same rule as src/duckPath.ts).
- OPEN: site #1, the digest macro (agentlens-digest collect.rs:149 binds the path). Decision 2026-11-18: agentlens-digest takes a path dependency on agentlens-store (same duckdb 1.10506.0 bundled, so one DuckDB build) and binds glob_escape(path).
- Correction (harness review): DuckDB falls back to the literal path when a pattern matches nothing (W48's measurement), so a store dir with a pattern character misreads, or fails to reopen, only when another path also matches the pattern; the reopen failure quoted in commit 290f0bc8 came from a test that planted such a sibling dir. The commit message is not edited (history is kept).
- reconcile.md (26 lines) read whole by the coordinator 2026-11-18: every production FROM-{x} builder traces to one of the 28 sites or to a native table; the earlier INFERRED label on this is now supported by that read of the worker's trace (the builders themselves were not re-read).
- Dependency check for site #1: agentlens-digest/Cargo.toml read whole. Its serde_json already has preserve_order, the same feature agentlens-store declares, so the new path dependency unifies no new serde_json feature; it adds regex, fs2 and libc to aldigest. duckdb is the same 1.10506.0 bundled in both.
- 2026-11-18 W52 (report reports_dev/sonnet-worker/20261118_w52-c6-digest-site1/report.md, read whole; diff read whole by the coordinator): agentlens-digest depends on agentlens-store and binds glob_escape(path) at collect.rs:147-149. Tests h1a (star), h1b (question mark), h1c (open bracket) and h2 (directory name) in tests/digest.rs each failed with the fix turned off (red2.txt, red3.txt, by the worker's logs) and pass with it.
- Coordinator's own run 2026-11-18 (load 16, CARGO_BUILD_JOBS=6): cargo test -p agentlens-digest 61 passed; cargo clippy -p agentlens-digest --all-targets -- -D warnings rc 0; cargo tree -e features --depth 1 shows agentlens-store with its default features only. Not measured: the transitive features that regex, fs2 and libc bring into aldigest, and the size of aldigest.
- The dependency check above was read after the worker had added the dependency, so it confirmed the decision afterwards; it did not precede it.
- Box 2 evidence: the misread is measured with the bundled Rust DuckDB in crate tests (agentlens-store canary and store round-trip, agentlens-digest h1a to h2), not with a run of the alcore or aldigest binary. The agentlens-core sites (statusline_store, burn_seismic, session_summary_sql, transcript_sql) have no pattern-dir test: code read and compile only; no test name contains burn_seismic.
- Box 3: all 28 sites use glob_escape (through sq_path, or bound at site 1); the committed tests are agentlens-store/tests/duck_path_pattern.rs and the h tests in agentlens-digest/tests/digest.rs. Known limits: a path holding a backslash is left unescaped (same rule as src/duckPath.ts); a non-UTF-8 digest path still errors at to_str.

## Approval log

- 2026-11-18T11:52:27+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-18T19:57:48+0100 — COMPLETE by main-agent@agentlenspro. all three acceptance boxes ticked with evidence; fix in 290f0bc8 and 02f6a0ca.
