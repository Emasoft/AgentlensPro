---
trdd-id: ORGJ0E3G
title: Transcript session cost bills every cache write at the 5m rate
column: dev
created: 2026-09-24T14:38:23+0200
updated: 2026-09-24T14:40:20+0200
current-owner: emanuelesabetta
created-by: emanuelesabetta
task-type: bugfix
min-approval-requirement: none
assignee: emanuelesabetta
mandate: true
mandated-by: none
approved: true
approval-judge: emanuelesabetta
approval-datetime: 2026-09-24T14:38:23+0200
---

# Transcript session cost bills every cache write at the 5m rate

## Approval log

- 2026-09-24T14:38:23+0200 — MANDATE issued by emanuelesabetta (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Evidence

Report: reports/cc-alignment/20260924_142509+0200-acceptance-7ab3ebfc.md — a 1h-tagged main-conversation transcript's server-reported cost_usd ($29.2513, n=230) undercounts the tier-aware recompute ($32.4828) by ~10%, because session_cost / speedBlendedCostUsd hand calc_token_cost_usd a hardcoded 0.0 for the 1h cache-write argument while the accumulator (agentlens-logscan lib.rs Buckets) never even extracts usage.cache_creation.ephemeral_1h_input_tokens. Distinct from TRDD-K4XQ7M2B, which is the same defect shape in the PER-CALL forensics api_calls row (forensicsIndex.ts / forensics_scan.rs), not the session CARD.

## File-line list

rust-core/crates/agentlens-logscan/src/lib.rs: Buckets/disjoint_anthropic (~132-149) now extracts cache_create_1h from usage.cache_creation.ephemeral_1h_input_tokens; ClaudeAccum.total_cache_create_1h + SubAgentRec.cache_create_1h + BlendTurn.cache_create_1h accumulate it; Card.cache_create_1h_tokens persists it. copilot.rs/codex.rs/opencode.rs Card literals set it to 0.0 (no Anthropic tier split). rust-core/crates/agentlens-core/src/mcp_tools.rs:699-712 session_cost reads cacheCreate1hTokens instead of a hardcoded 0.0. rust-core/crates/agentlens-core/src/log_reader.rs:93 speedBlendedCostUsd passes t.cache_create_1h. src/shared/summarizerTypes.ts SessionSummaryCard gained cacheCreate1hTokens?: number. src/mcpServer.ts sessionCost (dead TS server, survives only as the gen-sessionreports/gen-mcptools parity oracle) reads it too, for TS/Rust agreement if that path is ever re-activated.

## Acceptance

The card cost for a 1h-tagged transcript equals the tier-aware recompute to the cent — pinned by rust-core/crates/agentlens-core/tests/ui.rs::get_session_detail_bills_the_1h_cache_write_tier (fails on 0.0-hardcoded old code, passes after; asserts cost_usd equals a direct calc_token_cost_usd call with the real 1h split). disjoint_anthropic covered for all-1h, mixed-5m/1h, and flat-total-no-split-object shapes in rust-core/crates/agentlens-logscan/src/lib.rs tests::disjoint_anthropic_*. Old DurableState snapshots with no cacheCreate1hTokens field read as 0 (mcp_tools.rs::f() default) — same behavior as before this fix, never a crash.

## Persisted-row decision

UPDATED 2026-09-24: reindexed via LOG_INGEST_VERSION 7→8 (rust-core/crates/agentlens-core/src/log_reader.rs; TS twin src/collectorState.ts) — a stale version makes DurableState::restore() restore nothing, so the next boot's sweep cold_scans every discovered file exactly once, rebuilding cacheCreate1hTokens for every card from its transcript. Until that next restart, a card restored from a pre-fix delta log (or a file unchanged since the last restart, which LogTailer's unchanged() gate would otherwise skip forever) still reads cacheCreate1hTokens as 0 via mcp_tools.rs f()'s default — the exact pre-fix behavior, never a crash. CHANGELOG.md [Unreleased] updated to match; no longer follows the K4XQ7M2B precedent (that card is still unfixed and still NOT reindexed). Other calc_token_cost_usd call sites still passing a hardcoded 0.0 (mcp_tools.rs:165, heartbeat_cost.rs:124, forensics_db.rs:272, context_composition_index.rs:285, cache_break_timeline.rs:2543, cache_creation_forensics.rs:328/444) remain unaudited — each is a candidate for the same bug (review-fork finding, 2026-09-24) and stays out of this bounded fix's scope.
