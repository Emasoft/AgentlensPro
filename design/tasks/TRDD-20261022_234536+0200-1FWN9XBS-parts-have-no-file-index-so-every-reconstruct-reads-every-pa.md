---
trdd-id: 1FWN9XBS
title: Parts have no file index so every reconstruct reads every parts file and the export rebuilds bodies one at a time
column: todo
status: tasked
created: 2026-10-22T23:45:36+0200
updated: 2026-10-23T00:55:50+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-22T23:45:36+0200
---

# Parts have no file index so every reconstruct reads every parts file and the export rebuilds bodies one at a time

Mechanism (docs_dev/20261023-reconstruct-body-sql.md §2, file:line in rust-core/crates/agentlens-store/src/lib.rs unless noted). Statement A, per body in reconstruct_body (lib.rs:1111-1120), selects pos, kind, lit, sha from all_of(part), which is read_parquet over EVERY parts file plus the staging table. Statement B (lib.rs:1132-1137, only when the body has a blob part) does the same over EVERY blobs file with an IN list of the body shas. Statement C is the verify gate in reconstruct_chunk (lib.rs:1220-1230, caller lib.rs:1380, reached from pass.rs:554); it also scans every parts file, once per chunk; only its blob read, blob_fetch_sql (lib.rs:1178-1211), is file-scoped through known_blob. Parts have no part-to-file relation (body_durable.file_id names the bodies file, lib.rs:397/408), no statement has a file-level predicate, and body_id and sha are random sha256 keys in unsorted row groups, so row-group pruning is expected to skip nothing (INFERRED). The export calls reconstruct_body once per window row (agentlens-core/src/body_archive.rs:162-174), so it issues 1 + about 2N statements for N bodies, each a full read of its corpus. Measured (docs_dev/20261022-narrowed-export-measure.md, 50 bodies, byte-exact in both runs): warm 9.5 s per body steady, cold 23.2 s per body steady, first file 13 s warm; the request thread is 100% under reconstruct_body and 71-72% of it is ZSTD decompression; reconstruct_chunk and blob_fetch_sql show 0 samples. At 43k bodies that is about 113 h (9.5 s x 43,000). "decompresses the whole corpus" is INFERRED from those frames and the code, not measured. Fix order. (a) Time statement A against B (docs_dev/20261023-statement-a-vs-b-timing.md, pending) before choosing. (b) Export through a batched reconstruct_chunk (make it pub) in chunks, plus SELECT DISTINCT body_id in the window query so a body shared by several src_names is read once. (c) Add a part-to-file relation (known_part, body_id to file_id) filled in the flush transaction (the after match at lib.rs:580-583 has no part arm), with any legacy seed at open a body_id,filename projection only, then scope statement C to the owning files like blob_fetch_sql. Unsound shortcut: do NOT derive a parts file by swapping the bodies file stem (docs_dev/20261023-verify-gate-and-flush-naming.md §2.2), because a flush that wrote no new parts skips the parts COPY (lib.rs:561-566) so bodies/<tag> has no parts/<tag>, and the dedup path (lib.rs:990-994) writes a body row into a later flush whose parts sit in an earlier flush. Doc fixes that ride with the code fix: lib.rs:1108 says reconstruct_body reads ONLY its own parts and blobs, which is false; the bulk-reconstruction doc at lib.rs:1158-1166 sits above SpanCache instead of reconstruct_chunk; pass.rs:269-272 cites stale lib.rs:335 and lib.rs:800; the sha compare at lib.rs:1390 duplicates the one at lib.rs:1277. Owner rule: the work belongs in DuckDB queries (one batched query per settle group), not per-body round trips.

## Approval log

- 2026-10-22T23:45:36+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
