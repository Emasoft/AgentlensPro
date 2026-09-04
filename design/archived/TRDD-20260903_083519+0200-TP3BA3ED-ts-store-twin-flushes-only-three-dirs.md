---
trdd-id: TP3BA3ED
title: The TypeScript store twin flushes and fsyncs only blobs bodies and parts so api_calls is invisible to it
column: complete
created: 2026-09-03T08:35:19+0200
updated: 2026-09-04T14:09:41+0200
implementation-commits: [c3f011cb]
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

## DECISION — option 2 (recorded 2026-09-04, main-session)

**The TS twin is read-and-PRESERVE only. It must never create, write, verify or delete
`api_calls`.** Reasoning, in the order it actually decided the question:

1. The USER's standing ruling is that DuckDB/parquet via the Rust engine IS the memory. A
   second writer of the same table would make "which engine wrote this row" a live question
   on every read — the twin's job is read-compatibility, not co-authorship.
2. Option 1 (port `extract_api_call_meta` to TS) buys schema parity at the cost of a
   second implementation of the same extraction that must be kept byte-compatible with
   `rust-core/crates/agentlens-store/src/api_call.rs` forever. That is the drift this card
   was filed to prevent, re-created one layer down.

**The non-obvious half, and the reason this card was NOT a no-op:** "never write it" does
NOT mean "ignore it". `migrate.ts` swaps a staging dir in for the live store, so a layout
dir the twin does not know about would be silently DROPPED by the very engine that was
told not to touch it — deletion by omission. `migrate.ts:222-223` therefore copies
`api_calls` through the swap when present. That is why `API_CALLS_DIR` exists as a constant
at all: not so the twin can write the table, but so the one place that must not LOSE it can
name it.

Conversely `db.ts:138` deliberately does NOT create the dir — an empty `api_calls` would
assert a writer that does not exist, and a reader cannot tell "no calls yet" from "written
by an engine that never runs here".

## Acceptance

- [x] Decision recorded (1 or 2) with the reasoning, referencing the USER's
      Rust-is-the-memory ruling. — option 2, above; mirrored at the code site `src/store/db.ts:92-98`.
- [~] If option 1: TS twin writes `api_call` rows with schema parity to
      `rust-core/crates/agentlens-store/src/api_call.rs`; roundtrip test
      added. — **N/A, option 2 was chosen.**
- [x] If option 2: TS twin's verify/fsync passes explicitly treat
      `api_calls` as an optional directory (present-or-absent both valid),
      documented as such in a comment at the check site. — all four sites carry a
      `TRDD-TP3BA3ED` comment: `db.ts:92` (constant + why the dir is never created),
      `ingestPass.ts:270` (the **fsync barrier** — "three dirs, NOT four"),
      `validate.ts:72` (the **verify pass** — every check is TABLE-driven over
      blob/body/part, never a root listing, so the dir cannot be flagged unexpected),
      `migrate.ts:216` (the swap — the silent-loss case). Tests:
      `src/test/storeApiCallsDir.test.ts`, 3/3 passing 2026-09-04 (real store, real
      DuckDB-written Parquet, nothing mocked).

## Notes and lessons learned

- **A grep for a SYMBOL cannot find documentation ABOUT that symbol.** Verifying this
  card's box 3, both I and an adversarial reviewer ran `grep API_CALLS_DIR src/`, got
  hits in only `db.ts` and `migrate.ts`, and concluded the fsync and verify passes were
  undocumented — a conclusion confidently drawn and wrong. The comments were there the
  whole time; they spell the directory in prose (`api_calls`) rather than naming the
  constant, which is exactly what documentation does. The search that answers "is this
  documented?" is the card id (`grep -rn TP3BA3ED src/`), not the identifier. Same
  family as the standing no-semantic-search rule: the grep was measuring the wrong
  token, and a null result was read as an absence rather than as a failed measurement.

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-03

- NEXT ACTION: read `src/store/db.ts` + `bodyStore.ts` + `verifyInStore.ts`
  to enumerate every place the three-dir list is hardcoded, then pick
  option 1 or 2 per the USER ruling above.
- Filed alongside TRDD-9SYRK6SW landing the Rust-side `api_call` table
  (`reports/trdd-9syrk6sw/20260903_061039+0200-writer-implementation.md`,
  "The one real asymmetry" section) and TRDD-GVA8TTJF (the join view that
  will read `api_call`).

## Approval log

- 2026-09-04T14:09:41+0200 — COMPLETED by main-session. Option 2 recorded; all four layout
  sites documented; `storeApiCallsDir.test.ts` 3/3 green including the migration silent-loss
  case. `min-approval-requirement: none`, so no external approver was required.
