---
trdd-id: ISCVPP21
title: Other cost callers still price 1h cache writes at the 5m rate after K4XQ7M2B
column: todo
status: tasked
created: 2026-10-28T23:21:05+0100
updated: 2026-10-28T23:21:14+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-28T23:21:05+0100
priority: high
labels: [pricing, forensics, parity]
---

# Other cost callers still price 1h cache writes at the 5m rate after K4XQ7M2B

Found by the TRDD-K4XQ7M2B review. Its report docs_dev/20261028_224040+0100-K4XQ7M2B-review-followups.md (gitignored, so the facts are restated here) lists this as item 5. K4XQ7M2B (commit c8eb737d) fixed the 1h cache-write argument in the two forensics indexers only. The callers below were not fixed by it.

Candidates with a known 1h count that still pass 0 (so the cost ignores the measured 1h cache-write tier):
- src/cacheCreationForensics.ts:239 (the 1h count is read at :241 of the same event) and its Rust twin rust-core/crates/agentlens-core/src/cache_creation_forensics.rs:328 (the same split is INFERRED; not verified).
- SQL scalar function cost_usd: src/forensicsDb.ts:202 and rust-core/crates/agentlens-core/src/forensics_db.rs:272. It takes 5 arguments, so it cannot receive tier_1h_tokens although the api_calls table stores that column. Fixing it is a design change; the Rust comment says the 0 is deliberate for TS parity.
- src/cacheBreakTimeline.ts:1599 and rust-core/crates/agentlens-core/src/cache_break_timeline.rs:2618. The usage carries ephemeral1h (src/cacheBreakTimeline.ts:1336) but the cost call passes none (INFERRED; not verified).

Not a defect: src/statuslineHistoryCli.ts:494 passes 0 deliberately, because it prints a 5m/1h bracket.

Not checked for an available 1h count: burnInvestigator, sessionBurnProfile, skillAttribution, heartbeatCost, burnMonitor and monitor, src/mcpServer.ts:2408, rust-core/crates/agentlens-core/src/mcp_tools.rs:165.

Acceptance: each candidate verified by reading the code. Each candidate with a real 1h count either passes it, with an absolute-dollar test that fails on a revert to 0, or is documented as having none. Rust and TypeScript twins stay in parity.

## Approval log

- 2026-10-28T23:21:05+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
