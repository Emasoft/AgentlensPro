---
trdd-id: HCK5162J
title: Guard the store schema so a column type can never drift across files
column: todo
created: 2026-09-03T20:42:45+0200
updated: 2026-09-03T20:42:45+0200
current-owner: unassigned
task-type: infra
severity: MEDIUM
labels: [store, parquet, guard, silent-failure]
relevant-files: [rust-core/crates/agentlens-store/src/lib.rs, scripts/check-no-mirrors.js, package.json]
blocked-by: []
npt: []
eht: []
release-via: publish
---

# Guard the store schema against type drift

Per-column compression is chosen from a column's type and content, so a column whose type drifts
across files loses its scheme and the parquet grows. **This failure is silent** — nothing errors, the
store just quietly stops compressing, and it surfaces months later as unexplained disk growth. That
is precisely the class of bug that needs an executable check rather than a documented rule.

Verified 2026-09-03: no drift exists today (`bodies` 8 columns, `parts` 8, `blobs` 3, each with
exactly one physical type across every file). The guard is to keep it that way as the typed element
columns land.

## The rules being enforced (from TRDD-2LH25PBB)

1. A column's type is set at creation and NEVER changed. Nullability may change; the type may not.
2. New semantics get a NEW column. A name is never reused for a different meaning or type.
3. An unknown or newly-appearing API field NEVER goes into an existing typed column. It lands in a
   dedicated homogeneous overflow, or a typed key/value side table.
4. A migration that would re-type a column instead adds one and backfills.

Rule 3 is the one that will actually fire: the Anthropic response shape keeps gaining fields
(`ephemeral_1h_input_tokens` arrived with the 1h tier, then `stop_details`, `inference_geo`,
`iterations`).

## What to build

A check that scans every parquet file in the store and fails when any column carries more than one
physical type. The working query is already proven:

```sql
select "name", "type", count(*) from parquet_schema('<dir>/*.parquet')
where "type" is not null group by 1, 2
```

Fail when any `name` has more than one distinct `type`.

## Open questions

1. **Where does it run?** A live store may not exist in CI. A unit test over a temp store the test
   writes itself always passes and proves little; a check over the real store cannot run on a clean
   machine. Decide and record: probably BOTH — a unit test that writes two files with conflicting
   types and asserts the guard catches it (verify-fail, so the guard is proven to fire), plus a CLI
   verb for the live store. A guard that has never been seen to fail is not a guard.
2. **What does an unknown field do at ingest?** Reject the body, or route to the overflow? Measure
   how often unknown fields actually appear over a week of captures before choosing, since rejecting
   would lose data and the store's whole purpose is completeness.
3. **Does the overflow column itself stay homogeneous?** If it accumulates JSON of many shapes it
   becomes the very thing the rules forbid. Measure its compression ratio after a week.

## Acceptance

- [ ] The guard is proven to FAIL against a deliberately drifted pair of files, then pass on the real
      store (verify-fail first — an unfired guard is decorative).
- [ ] Wired into `pnpm run compile` or the publish gates, whichever the team already trusts.
- [ ] The unknown-field path is decided with a measurement of how often it fires.
