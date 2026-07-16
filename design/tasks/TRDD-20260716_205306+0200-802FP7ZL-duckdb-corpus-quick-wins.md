---
trdd-id: 802FP7ZL
title: DuckDB corpus quick-win adoptions — object cache on the store connection + migration run-twice contract test
column: ai_review
created: 2026-07-16T20:53:06+0200
updated: 2026-07-16T21:10:00+0200
current-owner: main
task-type: refactor
severity: minor
scope: project
npt: []
eht: []
labels: [store, duckdb, tests, corpus-mining]
implementation-commits: [1c378c9]
test-requirements: [unit, typecheck, lint]
---

# DuckDB corpus quick-win adoptions (items 3 + 5 of the mining shortlist)

## ⏵ STATE — 2026-07-16 21:10 — SHIPPED

Both items landed in `1c378c9` (TDD: object-cache test red → db.ts line → green; run-twice test
pinned the existing short-circuit). Gate 1316/0, tsc 0, lint 0. Deployed per the law: esbuild OK,
symbol grep-verified in `standalone/server.js`, server restarted healthy (pid 201). The synthesis
report got a correction addendum for the two premise-wrong items. Gate: human review.

## Original scope — 2026-07-16 20:53

Adopting the two SMALL items from the DuckDB-skills corpus mining
(`reports/duckdb-skills-mining/20260716_190500+0200-SYNTHESIS.md`) that survived verification
against the actual code. Authored Tier-0 (in-scope, reversible, local) under the user's standing
"complete all pending tasks" directive.

### In scope

1. **`SET enable_object_cache = true` on the store connection** (`src/store/db.ts`, one line +
   comment). The store re-scans immutable Parquet part globs repeatedly (dedup reload at open,
   every body reconstruction, ingest verification); the object cache caches Parquet
   footers/metadata across those scans. Parts are content-addressed and never rewritten, so the
   cache can never serve stale metadata — the classic staleness risk does not exist here.
   Contract test: `current_setting('enable_object_cache')` is true on an opened store.
2. **Migration run-twice contract test** (`src/test/storeValidate.test.ts`): after a successful
   migrate to CURRENT_SCHEMA, a second `migrateStore(dir)` must be a byte-level no-op —
   `migrated:false`, no error, no new `.old-vN` backup, manifest + dir listing unchanged, store
   still validates. The existing suite proves the safety rails (loss/corruption rejection, staging
   retention) but never re-runs a completed migration.

### Explicitly RE-SCOPED OUT, with the verification that killed them

- **Synthesis item 2 (diagnostics preset pack) — premise WRONG, recorded as a correction.**
  `run_diagnostics_sql` presets live in `src/forensicsSql.ts` and execute on the **sql.js/SQLite
  forensics snapshot** (`openReadonlyForensicsSnapshot`), NOT on the DuckDB store — the statement
  gate even rejects `PRAGMA` outright. And the store itself is FILELESS (`:memory:` catalog +
  immutable Parquet parts): there is no database file, no WAL, so `pragma_database_size()` /
  `.wal`-presence checks are meaningless against it. A store-health surface (e.g.
  `parquet_metadata`/`SUMMARIZE` over the parts, folded into `validateStore` or a server-stats
  field) is a NEW design, not a preset addition — needs its own TRDD if ever wanted.
- **Synthesis item 4 (EXPORT DATABASE catalog hot-backup) — premise wrong for the same reason:**
  there is no persistent catalog file to back up; the catalog is rebuilt from the parts at every
  `openStore`. The Parquet parts + manifest.json ARE the complete durable state and are already
  hash-verified. Nothing to do.
- Item 1 (transcript-SQL via `read_ndjson_auto`) stays USER-gated — a real feature with design
  surface, deserves its own scoped TRDD/session.

### Verify

`pnpm run check-types` + `pnpm run compile-tests` + full mocha suite green (≥1316), lint 0 errors.
No deploy needed beyond the standard law if the server is restarted (db.ts is bundled into
`standalone/*.js`): `node esbuild.js` succeeds + `agentlenspro server restart`.
