---
trdd-id: TC8HW857
title: Compressed raw plus typed DuckDB schema with byte-identical reconstruction and provenance
column: todo
status: tasked
created: 2026-10-19T00:46:02+0200
updated: 2026-10-19T00:57:55+0200
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
