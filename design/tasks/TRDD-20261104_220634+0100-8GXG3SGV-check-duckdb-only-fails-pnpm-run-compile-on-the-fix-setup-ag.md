---
trdd-id: 8GXG3SGV
title: check-duckdb-only fails pnpm run compile on the fix-setup-agent-preflight branch because check-dist-contents.js lists sql.js
column: todo
status: tasked
created: 2026-11-04T22:06:34+0100
updated: 2026-11-04T22:46:22+0100
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
implementation-commits: [4577cfec]
---

# check-duckdb-only fails pnpm run compile on the fix-setup-agent-preflight branch because check-dist-contents.js lists sql.js

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-11-04
- `pnpm run compile` fails on branch fix/setup-agent-preflight at its fifth step: `pnpm run check-duckdb-only` exits 1 with «check-duckdb-only: FAIL — on-disk data reached without DuckDB» and «scripts/check-dist-contents.js: sql.js / sql-wasm (SQLite in TS)» (measured 2026-11-04).
- Cause: scripts/check-dist-contents.js line 50 lists 'sql.js' in the esbuild `external:` array of readAgentNames(), which bundles src/cli/hookInstall.ts in memory to read AGENT_NAMES; the line came from e9e173ad (2026-10-22, git blame and git log -S). It reads no SQLite data. The matcher that fires is scripts/check-duckdb-only.js line 31 (`\bsql\.js['"]`). e9e173ad is not on main. At its parent e9e173ad^, check-dist-contents.js held no 'sql.js' and compile already ran check-duckdb-only; check-duckdb-only.js last changed on 2026-10-17 (728b143b) and no later commit touches it. So e9e173ad introduced the string that trips the guard; whether the guard passed at e9e173ad^ was not run.
- Consequence: compile stops before check-pricing-export, check-identities, check-guards, check-dist-contents and esbuild. Run alone on 2026-11-04, all four checks exit 0. After 4577cfec, compile still stops at check-duckdb-only, now because of TRDD-J91CFAT8.
- NEXT ACTION: none; this card closes. Option (1) is done in 4577cfec, and check-dist-contents exits 0 when run alone (2026-11-04). pnpm run compile still exits 1, on TRDD-J91CFAT8.
- Was a merge blocker for fix/setup-agent-preflight until 4577cfec; the branch still cannot pass `pnpm run compile`, because of TRDD-J91CFAT8 (CI and branch protection not checked); TRDD-U4HP8TVD's commits ride on that branch.
- Option (1) landed in 4577cfec (2026-11-04): check-dist-contents.js no longer lists sql.js. check-duckdb-only no longer reports that file; the hookInstall.ts bundle is byte-identical without the entry and still yields 9 AGENT_NAMES.
- The next failure check-duckdb-only reports, «test opener cap exceeded: 12 > 11», has a different cause and needs an owner decision: rust-core/crates/agentlens-store/tests/real_store_measure.rs, which 8c658bd1 added after 728b143b froze the cap. It is carded as TRDD-J91CFAT8. It did not print before 4577cfec, because the offender check exits at scripts/check-duckdb-only.js line 352, before the cap checks run (they print at line 367 and exit at line 391).

## Approval log

- 2026-11-04T22:06:34+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
