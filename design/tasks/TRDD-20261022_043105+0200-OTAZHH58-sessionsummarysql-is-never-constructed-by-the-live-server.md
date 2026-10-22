---
trdd-id: OTAZHH58
title: SessionSummarySql is never constructed by the live server
column: todo
status: tasked
created: 2026-10-22T04:31:05+0200
updated: 2026-10-22T04:31:05+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: refactor
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-22T04:31:05+0200
---

# SessionSummarySql is never constructed by the live server

rust-core/crates/agentlens-core/src/session_summary_sql.rs (428 lines; an in-memory DuckDB table session_summary with 10 columns, sourced from today's and yesterday's OTEL segments, claude_code only) has no production writer or reader. The only references are `pub mod` (lib.rs:85), three comments (lib.rs:689, span_window.rs:19, chores.rs:256) and tests/session_summary_sql.rs. Evidence: docs_dev/20261022-summary-cache-map.md section 2. Decide: wire it into a route (it cannot replace the summary cache, because its columns cover one source only), or remove it and its test, after checking that the TS parity oracles under rust-core/crates/agentlens-core/tests/fixtures do not depend on it. NEXT ACTION: grep every reference, then decide.

## Approval log

- 2026-10-22T04:31:05+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
