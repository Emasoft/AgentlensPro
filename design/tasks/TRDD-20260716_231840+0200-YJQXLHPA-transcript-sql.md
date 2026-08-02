---
trdd-id: YJQXLHPA
title: run_transcript_sql — ad-hoc DuckDB SQL over the Claude session transcripts
column: human_review
created: 2026-07-16T23:18:40+0200
updated: 2026-08-02T11:34:56+0200
current-owner: main
task-type: feature
severity: minor
scope: project
npt: []
eht: []
labels: [duckdb, transcripts, diagnostics, corpus-mining]
implementation-commits: []
test-requirements: [unit, typecheck, lint]
---

# run_transcript_sql — SQL over the transcripts (DuckDB corpus item 1)

## ⏵ STATE — 2026-07-16 23:45 — SHIPPED END-TO-END

All three phases done same-evening: engine + 12 real-DuckDB tests (phase-1 commit), MCP tool
`run_transcript_sql` + CHANGELOG + skill row (phase-2 commit), gate 1328/0 + tsc ×2 + lint 0,
deploy law honored (esbuild OK, symbol grep 2 hits in standalone/server.js, server restarted
pid 37329), and LIVE-verified on the real corpus: no-arg lists the 4 presets; `--preset
usage_by_model --window 6` returned 7 models (98,707 opus assistant records — correct: the
window bounds FILES by mtime, and a recently-touched long transcript carries its whole history;
record-level time filtering is what the raw SQL surface is for, e.g. WHERE "timestamp" >= …).
Gate: human review.

## Original plan — 2026-07-16 23:18

The last open item of the DuckDB-skills mining shortlist
(`reports/duckdb-skills-mining/20260716_190500+0200-SYNTHESIS.md` item 1), resumed on the user's
"resume". Ad-hoc cost/cause/content questions over the `.jsonl` session transcripts WITHOUT a
hand-written drill handler per question. NOT a LogReader replacement — an analysis surface beside
the cards/summarizers.

## Design (decided up front)

- **New MCP tool `run_transcript_sql`**, NOT an extension of `run_diagnostics_sql`: different
  engine (DuckDB vs the sql.js forensics snapshot), different data (live transcripts vs the fact
  DB), different presets. The 802FP7ZL correction is the precedent: the two engines must not be
  conflated.
- **Engine module `src/transcriptSql.ts`** (Node-only, lazy `@duckdb/node-api` import like
  `store/db.ts`): enumerate `.jsonl` files under `claudeProjectsDirs()` (test override
  `projectsDirs`), pre-filter in JS by `sessionId` (fast path: the one file) or an mtime
  `windowHours` cutoff (default 24h — the transcripts corpus is 17k+ files; an unbounded scan is
  the X2E6OSWK wedge shape on disk I/O), then
  `CREATE VIEW transcripts AS SELECT * FROM read_ndjson_auto([<explicit file list>],
  union_by_name=true, ignore_errors=true, filename=true, maximum_object_size=67108864)`.
  Explicit LIST, never a bare glob (empty glob is a DuckDB ERROR — the store learned this), and
  the list is what makes the JS-side bounding real. `ignore_errors` handles live still-growing
  files; `maximum_object_size` 64MB for multi-MB transcript lines (corpus gotcha: the JSON reader
  inflates 3-5×; connection memory_limit 2GB, threads 2).
- **Safety = the proven forensicsSql gate, reused**: `assertReadOnlySelect` (single SELECT/WITH;
  DDL/DML/ATTACH/PRAGMA rejected). No user string is ever interpolated into SQL — `sessionId`
  filters the FILE LIST in JS; the only embedded values are validated integers (limit). Presets
  are frozen SQL. This is a local diagnostics surface over the user's own files (project stance:
  security reactive-only).
- **Result shape mirrors `run_diagnostics_sql`** (mode/columns/rows/rowCount/presets/error) plus
  an honest `coverage` block ({filesTotal, filesQueried, windowHours, note}) — the store's
  coverage-honesty convention. Row cap: default 50, hard max 2000 (same constants rationale).
- **Presets (small, frozen, windowed)**: usage_by_model (per-model turns/tokens),
  cache_heavy_turns (top cache_creation), sessions_by_output (per-session output tokens),
  record_type_histogram (what record shapes exist — the schema-discovery entry point).
  Presets tolerate sparse union_by_name schemas by filtering `type='assistant'` before touching
  `message.usage.*`; a window with no such records surfaces the binder error honestly.

## Phases (≤5 files each; TDD)

1. Engine + tests: NEW `src/transcriptSql.ts`, NEW `src/test/transcriptSql.test.ts` (tmp-dir
   fixture transcripts — real DuckDB, no mocks), this TRDD.
2. MCP tool: `src/mcpServer.ts` (TOOLS entry + dispatch), `CHANGELOG.md`,
   `skills/agentlenspro-diagnostics/SKILL.md` cheat-sheet row, TRDD close-out. CLI comes free
   from the schema.
3. Gate + deploy law (esbuild + server restart + symbol grep) + live CLI verification.

## Verify

Unit suite green (+~10); tsc ×2; lint 0 errors; `agentlenspro run_transcript_sql` lists presets
and answers a windowed query against the real corpus.

## Approval log

- 2026-08-02 — AI review PASSED (ai_review backlog audit): implementation verified present in the code first-hand, not from prose. Column ai_review → human_review; the remaining gate is the human. Evidence: reports/ai-review-audit/20260802_113207+0200-batchA-diagnostics.md
