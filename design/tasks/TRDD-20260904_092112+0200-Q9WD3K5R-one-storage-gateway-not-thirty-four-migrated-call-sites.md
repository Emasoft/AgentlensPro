---
trdd-id: Q9WD3K5R
title: One storage gateway — the exemption count is the architecture defect, not the engine
column: todo
created: 2026-09-04T09:21:12+0200
updated: 2026-09-04T09:21:12+0200
current-owner: main-session
task-type: refactor
project-id: agentlenspro
scope: project
min-approval-requirement: user
labels: [architecture, storage, duckdb]
priority: high
severity: high
relevant-rules: []
npt: []
eht: []
implementation-commits: []
external-refs: []
---

# One storage gateway, not thirty-four migrated call sites

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-09-04

**Supersedes the P2/P3/P4 "migrate each database" plan** encoded in
`scripts/check-duckdb-only.js`'s allowlist. That plan is not wrong so much as aimed one level too
low, and shipping it would have produced a green guard over an unchanged architecture. The guard,
the ratchet and the phase tags all stay — what changes is what "done" means.

**NEXT ACTION:** decide gateway shape (below), then move callers onto it. Do NOT start by swapping
engines file-by-file.

## Why this exists

USER, 2026-09-04, on being shown a 34-entry exemption allowlist:

> exemptions are code smells. they are the clear sign of a bad architecture.

Correct, and it exposes an error in the plan those exemptions encoded. **34 exemptions means 34
files that reach disk directly.** The engine those files use is a symptom; the count is the defect.

The P2/P3/P4 plan would have migrated each file from sql.js/rusqlite to DuckDB one-for-one. That
lands **34 files each opening their own DuckDB connection** — exemption count zero, guard green,
architecture identical. Worse, it would have *looked* like completion.

This is the same defect class the guard itself hit twice while being written (see its header): **a
check whose scope is narrower than the invariant it claims to guard.** `check-duckdb-only.js` asks
"which engine?" and never "how many places?", so it certifies the post-migration tree as clean while
the smell is untouched.

The original directive already said the right thing (TRDD-7YPQWKPG, USER 2026-09-02, IMPERATIVE):

> duckdb is your memory! the rust code should only make queries and report the ephemeral answers to
> the cli! never storing anything!

That is one storage boundary. It was flattened into a per-database checklist.

## What to build

- **ONE gateway owns every on-disk read** — parquet, JSONL, the fact table, everything. It exposes
  SQL and nothing else. No other file opens any store.
- **Callers hold no handle and no resident data.** They ask a question, get an ephemeral answer, and
  keep nothing — which is the half of the directive about memory residency, not about engines.
- **The engine swap becomes a one-line change inside the gateway**, not 34 coordinated edits across
  two languages.
- **Endpoint: 1 exemption (the gateway) or 0.** If the endpoint is not 1, the exercise was
  bookkeeping. That number is the acceptance test for this card.

## Derived work this exposes

- **`check-duckdb-only.js` measures the wrong invariant** and must gain a second cap: how many files
  may open a store AT ALL, regardless of engine. Without it the guard cannot distinguish "migrated"
  from "fixed". Ratchet that cap to 1 alongside the migration.
- **The allowlist is defensible only as a countdown.** As a migration ledger with a ratchet to zero
  it earns its place; as a standing list of 34 permanent carve-outs it is exactly the smell the USER
  named. Keep it only while it is shrinking.

## Open question, to answer FIRST

**Does the gateway rebuild the fact table from parquet, or convert it in place?** This is the first
design decision, not an implementation detail, and it has a consequence outside this card: if it
rebuilds from parquet, the 3,283 sonnet-5 rows currently overstated by $104.60 are recomputed with
correct pricing as a side effect, and that separate repair decision dissolves. That is a *reason to
decide the rebuild question early* — it is NOT a finding that the rows are already handled.

## Non-goals

- Do NOT migrate `opencode.db` off SQLite — OpenCode owns that file. The gateway reads it through
  DuckDB's `sqlite_scanner`; the file stays as it is.
- Do NOT delete `check-duckdb-only.js` because its allowlist looks like a smell. The allowlist is
  the smell's *measurement*; removing the thermometer does not lower the fever.
