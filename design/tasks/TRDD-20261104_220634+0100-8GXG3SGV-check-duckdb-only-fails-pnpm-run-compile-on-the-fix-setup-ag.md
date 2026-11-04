---
trdd-id: 8GXG3SGV
title: check-duckdb-only fails pnpm run compile on the fix-setup-agent-preflight branch because check-dist-contents.js lists sql.js
column: todo
status: tasked
created: 2026-11-04T22:06:34+0100
updated: 2026-11-04T22:06:34+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-04T22:06:34+0100
---

# check-duckdb-only fails pnpm run compile on the fix-setup-agent-preflight branch because check-dist-contents.js lists sql.js

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-11-04
- `pnpm run compile` fails on branch fix/setup-agent-preflight at its fifth step: `pnpm run check-duckdb-only` exits 1 with «check-duckdb-only: FAIL — on-disk data reached without DuckDB» and «scripts/check-dist-contents.js: sql.js / sql-wasm (SQLite in TS)» (measured 2026-11-04).
- Cause: scripts/check-dist-contents.js line 50 lists 'sql.js' in the esbuild `external:` array of readAgentNames(), which bundles src/cli/hookInstall.ts in memory to read AGENT_NAMES; the line came from e9e173ad (2026-10-22, git blame and git log -S). It reads no SQLite data. The matcher that fires is scripts/check-duckdb-only.js line 31 (`\bsql\.js['"]`). e9e173ad is not on main.
- Consequence: compile stops before check-pricing-export, check-identities, check-guards, check-dist-contents and esbuild. Run alone on 2026-11-04, all four checks exit 0.
- NEXT ACTION: pick one fix. (1) Drop 'sql.js' from that externals list, if bundling src/cli/hookInstall.ts does not reach sql.js (verify by building without it). (2) Add the file to check-duckdb-only's ALLOW list. That list is budgeted, and raising the budget must be justified in the commit message (scripts/check-duckdb-only.js lines 114-126). (3) Narrow the matcher. Every option keeps the TRDD-7YPQWKPG directive. Then rerun `pnpm run compile` until it exits 0.
- Blocks the merge of fix/setup-agent-preflight; TRDD-U4HP8TVD's commits ride on that branch.

## Approval log

- 2026-11-04T22:06:34+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
