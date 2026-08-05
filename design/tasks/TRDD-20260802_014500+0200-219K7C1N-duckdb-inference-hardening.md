---
trdd-id: 219K7C1N
title: Apply the per-file schema-inference hardening to the OTHER DuckDB store
column: human_review
created: 2026-08-02T01:45:00+0200
updated: 2026-08-05T04:51:11+0200
current-owner: session
task-type: refactor
implementation-commits: [db55b90]
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

- [x] For each of the five surfaces above: does `src/store/db.ts` have it? Answer with a probe that
      REPRODUCES or refutes it on a real store, not by reading the code — that is what worked.
- [x] Every confirmed instance fixed with the shape already proven here: normalize **per file**
      (never a multi-file reader, which resolves one schema from the FIRST file), union a zero-row
      TYPED template for the columns queries may reference, and refuse a file whose record structure
      collapsed rather than sealing all-NULL rows over it. — *fixed with a DIFFERENT shape; see below*
- [x] Regression tests **verified to fail** against the unfixed version.
- [x] If a surface genuinely does not apply, write down why — a store that reads only ONE file per
      query has no cross-file reconciliation and is exempt.

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-08-05

**DONE, FIXED, TESTED, DEPLOYED (`db55b90`). The card's premise was REFUTED; a different, real
defect was found underneath it.**

**The probe came first, as the card demanded.** Read-only footer scan (`parquet_schema`) over every
part of both store generations:

| store/sub | parts | DISTINCT schema shapes |
|---|---:|---:|
| `store/bodies` | 2,269 | **1** |
| `store/blobs` | 2,610 | **1** |
| `store/parts` | 2,610 | **1** |
| `store.old-v0/*` | 342 each | **1**, and IDENTICAL to current |

**So nothing is broken today, and four of the five surfaces cannot occur here at all.** The card
assumed this store was `statuslineStore` with more history. It is not: `statuslineStore` INFERS a
schema per file from JSON (`read_json_auto`), which is what makes UUID mis-inference, struct-key
absence and inference COLLAPSE possible. `src/store/db.ts` writes **Parquet from a declared
`CREATE TABLE`** — the schema is never inferred, and Parquet carries it explicitly. Surfaces 1, 2, 3
and 5 are therefore structurally impossible, not merely absent.

**Surface 4 (a column absent from some files) is REAL, latent, and worse than described.** Measured
on a two-generation fixture, the day any column is added to the `body`/`part` staging tables:

| what runs | unfixed result |
|---|---|
| `read_parquet([old,new])`, OLD file first | **silently DROPS the new column** — no error |
| `read_parquet([new,old])`, NEW file first | throws `schema mismatch in glob` |
| a query naming the new column | throws `Binder Error: Referenced column … not found` |
| `allOf` (positional `UNION ALL`) | throws `Set operations can only apply to expressions with the same number of result columns` — **every store read down** until the last old part ages out |

Parts are `part-<Date.now()>-…` and `partFiles` uses `readdirSync`, so **older sorts first** — the
silent branch is the reachable one for a bare scan.

**The fix is TWO halves, and my first attempt shipped only one.** `union_by_name := true` makes the
durable parts agree with EACH OTHER; it cannot make them agree with the STAGING table, because the
scan has no way to know about a column that exists only in staging. `allOf` needed
`UNION ALL BY NAME` as well. Kept BY NAME even though the arity error is loud, because positional
matching is silently WRONG when counts agree but ORDER does not — a column added in the MIDDLE of
`CREATE TABLE` shifts every value one column over with no symptom. That case is now pinned.

**Corroboration:** `statuslineStore.ts` already uses `UNION ALL BY NAME` (`:236`, `:255`). The
hardened store had independently arrived at the same shape; `db.ts` simply predated it.

**Cost measured, not assumed:** 84–134 ms either way across 2,610 parts, within noise once the
object cache is warm. No per-file 2,610-way UNION was used — that is the right shape for INFERRED
schemas, and the slower answer to a problem an explicit Parquet schema does not create.

**Tests:** 4 added, suite 2,133 → **2,137**. THREE fail against the unfixed code (all three on the
arity error); the fourth is the same-schema no-regression guard and must pass both ways by design —
a failure there would mean the fix changed ordinary reads.

**Deployed and verified live:** `scripts/safe-deploy.sh` (green gates, fresh bundle, server restart),
server pid 2490 healthy, `union_by_name := true` present in `standalone/server.js`. It is absent from
`cli.js` and correctly so — `openStore`/`BODIES_DIR` are 0 there, i.e. the body store is server-only.

**Nothing left open on this card.**

## Load-bearing details, so they are not re-derived

- `* REPLACE` is a **binder error** when the column is absent, so a normalization that uses it needs
  the zero-row template underneath it or it trades one total failure for another.
- The template does NOT win a type reconciliation (UUID still beats VARCHAR) — it guarantees the
  column EXISTS; an outer cast fixes the TYPE. Both are needed.
- Fixing a read-time symptom can remove an accidental guard. Guaranteeing `ts` here removed a binder
  error that had been *preserving* a corrupt WAL, converting a recoverable degradation into permanent
  data loss. Check what a failure was protecting before removing it.

Reference: `.claude/project/memory/statusline-capture-and-store.md`, traps 1–5.
