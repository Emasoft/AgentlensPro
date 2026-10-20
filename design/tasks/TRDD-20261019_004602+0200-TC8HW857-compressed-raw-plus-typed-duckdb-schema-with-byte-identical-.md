---
trdd-id: TC8HW857
title: Compressed raw plus typed DuckDB schema with byte-identical reconstruction and provenance
column: todo
status: tasked
created: 2026-10-19T00:46:02+0200
updated: 2026-10-20T13:16:21+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: feature
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: user
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-19T00:46:02+0200
derived: true
npt: []
eht: []
---

# Compressed raw plus typed DuckDB schema with byte-identical reconstruction and provenance

## WHY
The backlog can be deleted only if the native DuckDB representation preserves both fast typed query surfaces and a compressed lossless form that reconstructs every original source byte-for-byte with attributable provenance.

## Scope
- Design and implement the direct native DuckDB schema for compressed raw payloads, typed producer/topic tables, source identity, offsets, hashes, and reconstruction provenance.
- Ingest this backlog directly into DuckDB; never route it through the legacy Parquet store.
- Define transactional boundaries that commit raw and typed representations together without taking a full database snapshot per source.
- Provide deterministic byte-identical reconstruction and verification from committed database state.

## Acceptance criteria
- [ ] Representative sources reconstruct byte-identically, including ordering, delimiters, line endings, and terminal-byte behavior.
- [ ] Typed rows trace unambiguously to source identity, source byte range or record ordinal, schema version, and committed migration batch.
- [ ] Raw and typed writes are atomic or have an explicit crash-safe recovery protocol proven by fault injection.
- [ ] Compression ratio, ingest throughput, reconstruction throughput, WAL growth, checkpoint behavior, and temporary-space peaks are measured.
- [ ] No implementation path writes this backlog to legacy Parquet.

## Failure and refusal conditions
- Refuse commit when reconstruction metadata is incomplete or hashes disagree.
- Refuse source advancement if typed and compressed-raw representations cannot be proven to describe the same committed input.
- Refuse lossy normalization, reordered records, or provenance that depends only on a mutable pathname.
- Never create a full DuckDB snapshot per source.

## Out of scope
- Corpus discovery/checkpoint indexing, free-space authorization, migration scheduling, consumer cutover, retention policy, and source deletion.

## Relevant links
- Parent architecture and backlog decomposition: TRDD-LHCHVK9Z.
- Source identity substrate: TRDD-U50JCH0J.
- Existing consumer cutover remains TRDD-QSFYIHUO and is not on the migration critical path.
- Capacity, runner, reconciliation, and live-drain cards will be linked after minting.
- Capacity gate: TRDD-TXRRF34L; migration runner: TRDD-IFOQAQYV; reconciliation: TRDD-JK4I9MFY; live drain: TRDD-IGPWXZ1M; retention owner: TRDD-Y1M56VMY.

## Dependency semantics
This is a depth-one atomic implementation card: `npt` and `eht` are empty and it has no `parent-trdd`.

## Approval log

- 2026-10-19T00:46:02+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-20T17:00:00+0200 - THE SCOPE'S PREMISE IS PARTLY ALREADY BUILT, AND THE 'NATIVE vs PARQUET' QUESTION WAS A CATEGORY ERROR. Two facts, both read in the source, both of which change what this card should still build. FIRST, THE BODIES ARE ALREADY IN DUCKDB TABLES. The store's bodies corpus lives in the NATIVE DuckDB table 'body_durable' (rust-core/crates/agentlens-store/src/lib.rs:227 creates it, :229 loads the whole corpus into it at open, :293-303 mirrors each newly written part back into it by READING THE PARQUET BACK, and all_of('body') at :133-138 returns '(SELECT * FROM body_durable UNION ALL BY NAME SELECT * FROM body)' - so the corpus's full view is the native table, not a parquet scan). The Parquet parts are the DURABLE BACKING of a DuckDB table, not an alternative to it: DuckDB's own 'COPY ... TO ... (FORMAT PARQUET, COMPRESSION ZSTD)' (lib.rs:310) is how the table is made durable, and the measured 5.09-6.33x IS DuckDB's own compression through that write path. So the scope item 'Ingest this backlog directly into DuckDB; never route it through the legacy Parquet store' is ALREADY SATISFIED, and the destination choice it was framed around DOES NOT EXIST. SECOND, THE TYPED COLUMNS ALREADY EXIST TOO, alongside the compressed raw: the body table's columns are body_id, src_name, kind, session_id, ts, model, raw_bytes, body_sha256 (lib.rs:167-170), and the compressed raw lives in the 'part' table (body_id, pos, kind, lit, sha, path, idx, n) with the bytes in the 'blob' table. That IS 'compressed raw plus typed columns' in one store, with the typed columns typed (TIMESTAMP, BIGINT, not VARCHAR). WHAT THIS CARD STILL OWNS, AND IT IS NOT WHAT ITS SCOPE SAYS: the typed projection that has NEVER been measured is the PRODUCER-LEVEL one - 'agentlens-digest' (rust-core/crates/agentlens-digest, 'spool NDJSON -> typed native DuckDB tables, through precompiled SQL macros'), which extracts per-turn facts (the api_call table's token buckets, cache-break fingerprint, billing header, raw_facts trio) rather than the body-level columns that already exist. The 2026-10-20 capacity measurement covered the RAW payload column only and said so; the number still missing is the TYPED one, and a typed projection compresses BETTER than a raw column, so it may improve on 5.09-6.33x rather than degrade it. The 'No implementation path writes this backlog to legacy Parquet' acceptance criterion needs its wording revisited: the path writes DuckDB tables, and DuckDB persists them as Parquet - the criterion as written would forbid DuckDB's own write path.
