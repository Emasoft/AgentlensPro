---
trdd-id: 4QNK59A0
title: X70L1O3S capture-clock test never asserts the non-Claude span was ingested
column: todo
status: tasked
created: 2026-10-16T20:52:43+0200
updated: 2026-10-16T20:52:43+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-16T20:52:43+0200
---

# X70L1O3S capture-clock test never asserts the non-Claude span was ingested

The test only_claude_spans_tick_the_capture_activity_clock (rust-core/crates/agentlens-core/tests/server_stats.rs:119-136) ingests a span named 'invoke_agent copilot' and asserts last_ingest_activity_ms stays 0. It never asserts that span was ingested (e.g. spans_appended > 0), so a later ingest change that dropped non-Claude spans would make the first assertion pass vacuously. Fix: assert the span landed before asserting the clock did not move; mutation-check by making the stamp unconditional (the card's own 'mutation-verified' box was met by reasoning only).

Disclosure for the 2026-10-16 closures of X70L1O3S, LZ2JDIJP and 5IDBAJ6O (archived, immutable, so recorded here): their Acceptance boxes were written at close time from the verifier's findings, keeping only met items (docs_dev/20261016-ai-review-3cards-report.md). The closing commit and LZ2JDIJP's move reason say main read src/cli/reviewGate.ts:851; that read had failed on a wrong path and was done only afterwards (it confirms the ownAgentId filter). LZ2JDIJP's replay box rests on the fix author's own report with its script lost. 5IDBAJ6O: the spawn-env audit is unverified, and its isolation has documented limits (dd63e56d, setup.js:186-190).

## Approval log

- 2026-10-16T20:52:43+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
