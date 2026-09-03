---
trdd-id: TP3BA3ED
title: The TypeScript store twin flushes and fsyncs only blobs bodies and parts so api_calls is invisible to it
column: backburner
created: 2026-09-03T08:35:19+0200
updated: 2026-09-03T08:35:19+0200
current-owner: main-session
task-type: bugfix
min-approval-requirement: none
parent-trdd: CAJ5RCP9
created-by: main-session
npt: []
eht: []
---

## Symptom

`src/store/{db,bodyStore,verifyInStore,ingestPass}.ts` is the documented
compatibility twin of the Rust store — same layout, same fsync-barrier
contract. Its flush/fsync and directory list cover only `blobs`, `bodies`,
and `parts`. TRDD-9SYRK6SW added a fourth table, `api_call`, to the Rust
store only (`API_CALLS_DIR`, `pass.rs` fsync barrier). A store written by
the TypeScript engine never contains an `api_calls` directory, and the
twin's own size/verify passes never look for one — so any store produced by
the TS path silently lacks the table the join view in TRDD-GVA8TTJF depends
on.

## Decision needed

Two options, not yet chosen:

1. **Extend the twin** — port `extract_api_call_meta` + the `api_call`
   table writer to TypeScript so both engines stay in lockstep.
2. **Declare the Rust engine the only writer of `api_calls`** — the USER's
   standing ruling is that DuckDB/parquet via Rust IS the memory; the TS
   twin's job may be read-compatibility only, in which case the twin should
   at most read the table if present, never write it, and the fsync/verify
   passes should treat `api_calls` as optional.

Option 2 is the likely answer given the ruling, but record both here rather
than assume — a wrong assumption here breaks store compatibility silently,
the exact failure mode this TRDD exists to prevent.

## Acceptance

- [ ] Decision recorded (1 or 2) with the reasoning, referencing the USER's
      Rust-is-the-memory ruling.
- [ ] If option 1: TS twin writes `api_call` rows with schema parity to
      `rust-core/crates/agentlens-store/src/api_call.rs`; roundtrip test
      added.
- [ ] If option 2: TS twin's verify/fsync passes explicitly treat
      `api_calls` as an optional directory (present-or-absent both valid),
      documented as such in a comment at the check site.

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-03

- NEXT ACTION: read `src/store/db.ts` + `bodyStore.ts` + `verifyInStore.ts`
  to enumerate every place the three-dir list is hardcoded, then pick
  option 1 or 2 per the USER ruling above.
- Filed alongside TRDD-9SYRK6SW landing the Rust-side `api_call` table
  (`reports/trdd-9syrk6sw/20260903_061039+0200-writer-implementation.md`,
  "The one real asymmetry" section) and TRDD-GVA8TTJF (the join view that
  will read `api_call`).

## Approval log
