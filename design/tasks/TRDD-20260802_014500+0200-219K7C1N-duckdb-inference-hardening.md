---
trdd-id: 219K7C1N
title: Apply the per-file schema-inference hardening to the OTHER DuckDB store
column: todo
created: 2026-08-02T01:45:00+0200
updated: 2026-08-02T01:45:00+0200
current-owner: unassigned
task-type: refactor
npt: []
eht: []
---

# Apply the per-file schema-inference hardening to the OTHER DuckDB store

## Why

`src/statuslineStore.ts` shipped SIX distinct bugs in one day, and five were **one root cause**:
DuckDB infers a schema PER FILE, and a store built from append-only files therefore holds files whose
schemas disagree. Every one was found by probing the next surface after fixing the last — none by
reading the code.

| # | surface | symptom |
|---|---|---|
| 1 | UUID inference, in the RESULT | id returned as `{hugeint:…}`, not a string |
| 2 | UUID inference, in the READ | `Could not convert string 'x' to INT128` — 3 of 5 views dead |
| 3 | a STRUCT field absent from one file | `Could not find key "effort" in struct` — whole view dead |
| 4 | a top-level column absent from every file in the window | `Referenced column … not found` — **all five** views dead |
| 5 | inference COLLAPSE from one bad line | whole file read as one opaque `json` column; every field NULL, row count unaffected, so verify-before-delete passed it |

`src/store/db.ts` is the SAME pattern — immutable zstd Parquet parts read by a fileless DuckDB — and
predates all of this. It has had none of these fixes. The store this task is about (OTEL response
bodies) is larger and older, so its files span more schema generations, not fewer.

## Scope

`src/store/db.ts` and its readers (`transcriptSql.ts`, anything doing `read_parquet`/`read_json_auto`).

## Acceptance

- [ ] For each of the five surfaces above: does `src/store/db.ts` have it? Answer with a probe that
      REPRODUCES or refutes it on a real store, not by reading the code — that is what worked.
- [ ] Every confirmed instance fixed with the shape already proven here: normalize **per file**
      (never a multi-file reader, which resolves one schema from the FIRST file), union a zero-row
      TYPED template for the columns queries may reference, and refuse a file whose record structure
      collapsed rather than sealing all-NULL rows over it.
- [ ] Regression tests **verified to fail** against the unfixed version.
- [ ] If a surface genuinely does not apply, write down why — a store that reads only ONE file per
      query has no cross-file reconciliation and is exempt.

## Load-bearing details, so they are not re-derived

- `* REPLACE` is a **binder error** when the column is absent, so a normalization that uses it needs
  the zero-row template underneath it or it trades one total failure for another.
- The template does NOT win a type reconciliation (UUID still beats VARCHAR) — it guarantees the
  column EXISTS; an outer cast fixes the TYPE. Both are needed.
- Fixing a read-time symptom can remove an accidental guard. Guaranteeing `ts` here removed a binder
  error that had been *preserving* a corrupt WAL, converting a recoverable degradation into permanent
  data loss. Check what a failure was protecting before removing it.

Reference: `.claude/project/memory/statusline-capture-and-store.md`, traps 1–5.
