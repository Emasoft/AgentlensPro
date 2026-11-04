---
trdd-id: J91CFAT8
title: check-duckdb-only test opener cap is exceeded 12 to 11 since real_store_measure.rs was added
column: proposal
status: proposed
created: 2026-11-04T22:40:14+0100
updated: 2026-11-04T22:40:14+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: user
approved: false
---

# check-duckdb-only test opener cap is exceeded 12 to 11 since real_store_measure.rs was added

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-11-04
- `pnpm run check-duckdb-only` exits 1 on branch fix/setup-agent-preflight with «check-duckdb-only: FAIL — test opener cap exceeded: 12 > 11.», listing 12 test files that open a store (measured 2026-11-04, after 4577cfec fixed TRDD-8GXG3SGV). `pnpm run compile` stops there, before check-pricing-export, check-identities, check-guards, check-dist-contents and esbuild.
- Cause: 728b143b (2026-10-17, TRDD-4BZPAQWM) raised MAX_TEST_OPENERS to 11 in a defended commit (its subject is "defended opener-cap raise to 26/11") and froze it there (scripts/check-duckdb-only.js line 234). Since then, only one commit has touched the 12 listed files or the guard (`git log 728b143b..HEAD`): 8c658bd1 (2026-10-22, TRDD-2HRA270Y), which added rust-core/crates/agentlens-store/tests/real_store_measure.rs. Neither commit is on main. The failure stayed unreported until 4577cfec, because the offender check exits at line 352, before the cap checks run (they print at line 367 and exit at line 391).
- The rule of the guard: the cap is frozen and may only go DOWN. A new test that opens its own handle should first ask whether it can use the entry point the product uses.
- NEXT ACTION: the owner decides between two options. (a) Raise MAX_TEST_OPENERS to 12 in a commit that justifies it. This loosens a guard that enforces the USER imperative TRDD-7YPQWKPG, so it needs the owner. (b) Move real_store_measure.rs onto the product store entry point. This loosens nothing, but the test belongs to TRDD-2HRA270Y and, judging by its name, may exist to measure a real store through its own handle, so ask before changing it. Then rerun `pnpm run compile` until it exits 0.
- Treated as a merge blocker for fix/setup-agent-preflight (CI and branch protection not checked); the TRDD-U4HP8TVD commits ride on that branch.

## Approval log
