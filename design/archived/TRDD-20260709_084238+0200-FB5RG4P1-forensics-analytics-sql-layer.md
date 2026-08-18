---
trdd-id: FB5RG4P1
title: Forensics Analytics Layer — comparative config stats + SQL engine over cache-cost facts
column: completed
created: 2026-07-09T08:42:38+0200
updated: 2026-08-18T12:45:00+0200
current-owner: 777b8f52
assignee: null
priority: 3
severity: MEDIUM
effort: XL
labels: [mcp, cache-forensics, analytics, sqlite, comparative-stats, otel-raw-body, spawn-attribution]
task-type: feature
parent-trdd: TRDD-CCFORNSC
npt: []
eht: []
blocked-by: []
supersedes: []
superseded-by: []
pre-block-column: null
relevant-rules: []
release-via: none
delivery: direct-push
target-branch: fix/logreader-large-jsonl
feature-branch: fix/logreader-large-jsonl
merge-strategy: squash
must-pass-tests-before-merge: true
test-requirements: [unit, typecheck, lint]
audit-requirements: []
review-requirements: []
runtime-targets: [macos, linux]
impacts: [public-api, config-schema, migration]
migration-direction: forward
attempts: 0
test-failures: 0
last-test-result: pass
last-test-at: 2026-07-09T12:00:00+0200
implementation-commits: [5d381e3, 271b593, 3e83684, 68ae0af]
pr-url: null
external-refs: []
---

# Forensics Analytics Layer (FAL) — comparative + SQL analytics over cache/cost forensics

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-07-09

**Column: `complete` — BUILT + GATE-GREEN.** All phases landed in 4 LOCAL commits (frozen 6TQ2FBUR
files were already released, commits 77148e8/817763c, so no concurrency conflict). Gates green each
commit: `check-types` 0, `lint` 0 errors, `esbuild` 0, mocha (full suite 481 passing / 0 failing).

**Shipped:**
- `src/forensicsDb.ts` — `~/.agentlens/forensics.db` (sql.js, self-loaded via `require('sql.js')` +
  `require.resolve` — the standalone pattern; NO `McpServerOptions` change), full DDL (api_calls +
  call_content + call_injections + index_state), custom fns `billable_weight/tier_classify/cost_usd/
  spike` via `db.create_function` (confirmed present in sql.js 1.14.1). Commit **5d381e3**.
- `src/forensicsIndex.ts` — generalized bounded scan (ALL usage), previous_message_id join, spawn
  resolver ladder (direct/root/unresolved — never fabricated), effort from thinking budget,
  frontmatter_fp, cost/billable_weight, high-water + `ensureFreshIndex` (5-min freshness), content
  taxonomy (via `buildCallComposition`) + injection extraction (rule/claudemd/mcp exact, skill
  heuristic). Commits **5d381e3** (facts) + **271b593** (content/injections).
- `src/forensicsCompare.ts` + `src/forensicsSql.ts` — `compare_configs` (13 groupBy dims × 7 metrics ×
  7 aggs, min/max/avg/median/p95/count/sum always, verdicts, coverage) + `run_diagnostics_sql` (16
  presets + raw read-only SQL, fail-closed statement gate, bound params, in-memory snapshot, row cap,
  json/table/markdown). Registered in `src/mcpServer.ts` (TOOLS + switch). Commit **3e83684**.
- `spawn_subagent_type` EHT — schema/db-migration/writer/card-type/logReader/index. Commit **68ae0af**.

**EMPIRICAL FINDING (design §3.3 — RESOLVED, the unverified assumption):** on this machine's real
`~/.agentlens/otel-bodies` (1500-response sample), **sub-agent API calls carry the PARENT/root
`session_id`, NOT the child's `agentId`** — 0/6 distinct call-sessions matched a child agentId; all 6
matched a root session (of 2125 child agentIds / 11971 root sessions in `log-sessions.json`). So the
SECOND design branch is reality: a sub-agent's specific spawn context is invisible at the call level;
the resolver correctly attributes such calls to `root` (via the parent row) and NEVER fabricates a
child spawn_kind. Consequence: on real Claude Code telemetry, `compare_configs groupBy:spawn_kind`
buckets sub-agent calls under `root`/`unresolved`, not fork/fresh/worktree. True per-child attribution
needs the child-window flagging (design §3.3, a documented FUTURE enhancement — not built). The
synthetic tests prove the mechanism works WHEN child session_ids are carried; the empirical check
documents that they typically are not. Script: `scratchpad/empirical.js`.

**OPERATIONAL NOTE:** there is currently **no `~/.agentlens/agentlens.db`** on this machine (the
standalone server persists cards to `log-sessions.json`, not a file DB at FAL's expected path). When
the main DB is absent, `loadSpawnMap` returns empty and every call resolves `unresolved` — honest
degradation. FAL's spawn dimension becomes meaningful once a main DB exists at `~/.agentlens/
agentlens.db` (or the caller points `mainDbPath` at wherever the DB lives).

**FUTURE (not built, non-blocking):** (1) child-window spawn attribution (§3.3); (2) break_cause/
culprit_fingerprint/gap population via the optional `cacheBreakTimeline` import (§3.7 — columns stay
NULL and break-related presets degrade gracefully until wired); (3) high-water SKIP optimization (the
indexer currently re-processes the capped slice idempotently each run rather than skipping
`ts<=high_water`).

---

### (original design-phase STATE, superseded by the above)

**Column: `backburner` — DESIGN ONLY, not started.** This TRDD + the design doc are the
deliverables of the current session; NO code was written. Build is phased and **sequenced
after the in-flight TRDD-6TQ2FBUR agent finishes** (see DEPENDENCIES).

**Goal:** a persisted, queryable **fact table (one row per API call)** on top of the
cache_creation forensics, plus two MCP tools that answer FLEET-WIDE COMPARATIVE + AD-HOC-SQL
questions the per-session timeline can't:
- `compare_configs` — rank configs worst→best on a metric with per-group min/max/avg/median/
  p95/count. "Do FORKED agents consume less cache_creation than FRESH? Do WORKTREE cost more?
  Which model/effort/isolation/subagent_type breaks cache least on average?"
- `run_diagnostics_sql` — ~16 curated PRESET queries + RAW read-only SQL with custom fns
  (`billable_weight()`, `tier_classify()`, `cost_usd()`, `spike()`).

**Design doc (READ IT — has the full DDL, tool JSON schemas, preset SQL list):**
`reports/context-composition/20260709_084238+0200-forensics-analytics-layer-design.md`

**Load-bearing facts:**
- DB engine is **sql.js** (WASM SQLite), `db.exec(sql)` + `db.run(...)`; **`db.create_function`
  works** → custom SQL fns are feasible. sql.js does NOT reliably honor `ON DELETE CASCADE`
  → the indexer deletes child rows manually (like `DatabaseWriter`).
- **DEDICATED DB** `~/.agentlens/forensics.db` (NOT the main `agentlens.db` — different
  lifecycle/grain; main DB is full-DELETE-rebuilt each rescan and would clobber facts).
- **Spawn config = One-Source-of-Truth in the sessions table** (`spawn_kind`,
  `spawn_model_override`, `spawn_isolation`, `is_sidechain`, `parent_session_id`), populated by
  `logReader._buildSubAgentCards` → `DatabaseWriter`. FAL DENORMALIZES a read-only copy at
  index time; NEVER re-parses the parent transcript. `subagent_type` is NOT a persisted column
  yet → Phase 2 EHT adds `spawn_subagent_type` to schema/writer/logReader.
- **Join key** = OTEL `metadata.user_id.session_id` (reached via CCFORNSC's
  `previous_message_id` chain). **Child-card `sessionId = agentId`** may NOT equal the call's
  session_id → the resolver ladder (§3.3 of the doc) handles BOTH, records `spawn_resolution`
  (direct|root|unresolved) honestly, NEVER fabricates a spawn_kind. Phase-2 EMPIRICAL check on
  real bodies pins which branch is reality; build not blocked on it.
- `calcTokenCostUsd(input, cacheRead, cacheWrite, output, model)` — arg order confirmed.
- `effort` is read DIRECTLY from the request body's `thinking` budget (per-call, not spawn-
  derived) → always available when the request body resolved.

**DEPENDENCIES / sequencing (do NOT build concurrently):**
- **FROZEN in-flight files (TRDD-6TQ2FBUR agent is editing them RIGHT NOW):**
  `src/cacheCreationForensics.ts`, `src/mcpServer.ts`, `src/cacheBreakTimeline.ts`
  (+ `.test.ts`), and the 6TQ2FBUR TRDD. **DO NOT TOUCH.** Import their exports; do not edit.
- FAL reuses CCFORNSC's exported scan primitives (`listBySuffix`, `boundedRecent`,
  `readJsonBounded`, caps) by IMPORT.
- `break_cause`/`culprit_fingerprint` columns are populated by 6TQ2FBUR's `cacheBreakTimeline.ts`
  → **optional dependency**: those columns stay NULL (graceful) until 6TQ2FBUR lands; FAL's
  token/spawn/content/injection dimensions do NOT depend on it and can start once the frozen
  files are released.
- The `mcpServer.ts` tool-registration step (adding `compare_configs` + `run_diagnostics_sql`)
  MUST wait until the 6TQ2FBUR agent has committed and released `mcpServer.ts`.

**NEXT ACTION (when promoted + frozen files released):** Phase 1 — create `src/forensicsDb.ts`
(schema DDL + custom-fn registration) and `src/forensicsIndex.ts::scanApiCallEvents` (fact rows:
tokens+tiers+spawn-join+spawn_resolution only; no content/injection yet) + unit tests; gate
green; commit LOCAL by name.

**CONSTRAINTS:** commits LOCAL only, NEVER push; stage BY NAME; don't touch
`~/.claude/settings.json`; don't restart the server; don't delete `media/src/tabs/.CacheTab.tsx.swp`.
lean-ctx shell blocks `python3 -c`, `{…}` groups, `$(…)` in args → use script files. Gates per
commit: `pnpm run check-types`, `pnpm run lint`, `node esbuild.js`, `pnpm run compile-tests &&
npx mocha out/test/test/forensics*.test.js`.

## Background

Verified burn finding (CCFORNSC, `cc_ttl.py`): **cache_creation = cache BREAKS, not TTL** —
67 % of big writes at <4.5-min gaps; a heartbeat is the wrong fix for most burn. The shipped
tools answer who / what's-inside / TTL-or-break (CCFORNSC) and which-element-broke-it for ONE
session chronologically (6TQ2FBUR). Missing: the FLEET-WIDE COMPARATIVE view — group every call
by its spawn/model/effort/isolation/subagent_type/skill/mcp/rule/content config and rank which
config is cheapest/most-cache-friendly ON AVERAGE — and an AD-HOC read-only SQL surface with
cost-aware helper functions. Hypotheses to TEST with the tools: fork (warm) < fresh (cold) <
worktree (cold+isolated) for cache_creation/call; fleet children cold-heavy; model-override pays
a full cold write.

## Design (summary — full detail in the design doc)

- **`forensics.db`** (sql.js): `api_calls` (one row/call: ids, spawn config denormalized +
  `spawn_resolution`, token buckets + 5m/1h tiers, break_cause/culprit_fingerprint/gap_minutes,
  frontmatter_fp, cost_usd, billable_weight), `call_content` (per-call content tags), 
  `call_injections` (per-call skill/mcp/rule/claudemd/hook), `index_state` (incremental high-
  water mark + coverage).
- **Lazy incremental indexer**: reuse CCFORNSC's bounded/recency-capped scan (generalized to
  keep ALL usage, not just cc>0); high-water-mark incremental + idempotent `INSERT OR REPLACE`;
  spawn resolver ladder (direct→model-override→root→unresolved→unattributed); content taxonomy
  via `buildCallComposition`; injection extraction via `classifySystem` + tools-name scan;
  optional break_cause via `cacheBreakTimeline`.
- **`compare_configs`** MCP tool: groupBy spawn_kind|model|effort|isolation|subagent_type|
  frontmatter|skill|mcp|rule|content_tag|break_cause|account|session; metric cache_creation|
  cache_read|output|input|breaks|total|billable_weighted; agg min|max|avg|median|p95|sum|count
  (all returned per group); filter + rankOrder + verdicts + coverage.
- **content taxonomy** (image|binary|big_file_read|tool_result:<Kind>|tool_catalog_large|
  thinking_heavy) usable as filter AND groupBy dimension.
- **skill/mcp/rule attribution**: enrichment/lift stats (avg-with / avg-global; P(present|spike)
  / P(present|all)) via compare_configs groupBy + presets 5–8.
- **`run_diagnostics_sql`** MCP tool: ~16 presets + raw read-only SQL (statement gate: single
  SELECT/WITH only, DDL/DML/ATTACH/PRAGMA rejected; snapshot isolation; params bound; row-cap;
  custom fns `billable_weight/tier_classify/cost_usd/spike`).
- **Composition with chronological tools**: FAL aggregate (worst config / culprit_fingerprint)
  → drill via `get_cache_break_timeline` / `trace_expensive_writes` / `get_call_context` on the
  shared session_id + response_ref/request_ref + cause/fingerprint vocabulary.

## Phased build plan (each phase ≤5 files, gate-green, commit LOCAL by name)

- **Phase 0 — DONE this session:** this TRDD + the design doc.
- **Phase 1 — schema + generalized scanner + fact rows (token/spawn only).**
  `src/forensicsDb.ts` (DDL, open/create, custom-fn registration), `src/forensicsIndex.ts`
  (`scanApiCallEvents` generalized bounded scan; fact insert: ids+tokens+tiers+spawn-join+
  spawn_resolution+frontmatter_fp+cost_usd+billable_weight). Unit tests (synthetic + 🐌 real
  `~/.agentlens/otel-bodies`). DERIVED: coverage/high-water honesty; sql.js manual-cascade.
- **Phase 2 — incremental indexer + spawn resolver + subagent_type EHT + empirical verify.**
  High-water incremental; resolver ladder; EHT: add `spawn_subagent_type` to `schema.ts` +
  `writer.ts` + `logReader.ts` (editable — NOT frozen). EMPIRICAL: check if any response
  session_id == a child agentId; record the verdict in this STATE. DERIVED: migration of
  existing DBs (nullable column, safe); re-index picks up subagent_type on next run.
- **Phase 3 — `compare_configs` engine + tool.** `src/forensicsCompare.ts` (grouped SQL +
  TS quantiles + verdicts). Register in `mcpServer.ts` — **SEQUENCED after 6TQ2FBUR releases
  mcpServer.ts.** DERIVED: unresolved group always shown; coverage block.
- **Phase 4 — content taxonomy.** Extend indexer to fill `call_content`; add content_tag filter
  + groupBy to compare_configs. DERIVED: pointer-only guarantee test (no base64/raw text).
- **Phase 5 — skill/mcp/rule injection + attribution.** Extend indexer to fill `call_injections`;
  enrichment/lift stats + groupBy skill|mcp|rule. DERIVED: heuristic-skill-parse documented +
  tested against a real body.
- **Phase 6 — `run_diagnostics_sql` engine + presets.** `src/forensicsSql.ts` (safety gate,
  snapshot isolation, ~16 presets, formats, custom fns). Register in `mcpServer.ts` (sequenced).
  DERIVED: statement-gate negative tests (reject INSERT/DROP/ATTACH/PRAGMA/2-statement).
- **Phase 7 — tests + MCP finalize + report.** Full unit coverage (indexer, resolver ladder,
  compare, sql-safety) + 🐌 real-data slow tests; both tools registered + smoke-tested; report to
  `reports/context-composition/`. Gate: check-types, lint, esbuild, mocha all green.

## Approval log
(Tier-0: in-scope feature work on the current project by the dedicated agent — no external
approval needed. Build is deferred/sequenced behind TRDD-6TQ2FBUR to avoid concurrent edits to
the shared frozen files.)
- 2026-08-18T12:45:00+0200 — ARCHIVED by USER batch directive ("complete all TRDD"); validity re-verified: src/forensicsDb.ts, src/forensicsIndex.ts, src/forensicsCompare.ts, src/forensicsSql.ts exist; src/mcpServer.ts:1481,1506 register compare_configs/run_diagnostics_sql.
