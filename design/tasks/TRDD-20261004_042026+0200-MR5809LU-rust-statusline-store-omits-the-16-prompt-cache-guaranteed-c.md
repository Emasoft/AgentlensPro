---
trdd-id: MR5809LU
title: Rust statusline store omits the 16 prompt_cache guaranteed columns the TypeScript store had
column: backburner
status: tasked
created: 2026-10-04T04:20:26+0200
updated: 2026-10-04T04:20:26+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-04T04:20:26+0200
---

# Rust statusline store omits the 16 prompt_cache guaranteed columns the TypeScript store had

## Symptom / risk
The Rust statusline store guarantees 26 columns; the TypeScript store guarantees 42. The 16 missing are all prompt_cache_*. A query over a window holding only samples older than CC 2.1.252 (which lack the whole prompt_cache block) would hit a DuckDB binder error if it referenced those columns.

## Evidence
- Rust: rust-core/crates/agentlens-core/src/statusline_store.rs:155 GUARANTEED_COLUMNS has 24 entries, plus 2 chained in column_template() (~line 184-190: exceeds_200k_tokens, rate_limits_seven_day_resets_at) = 26. No prompt_cache name appears anywhere in rust-core (grep, VERIFIED).
- TS: src/statuslineStore.ts:170 GUARANTEED_COLUMNS = 42 entries (VERIFIED by reading), 26 shared + 16 prompt_cache_*: warm, caching_observed, ttl, expires_at, requests, misses, expected_rebuilds, hit_ratio, cache_write_tokens, miss_recache_tokens, last_miss_at, recache_tokens_if_cold, last_miss_cause_causes (VARCHAR[]), last_miss_cause_tools_added, last_miss_cause_tools_removed, last_miss_cause_system_char_delta.
- TS comment (~line 235-240): pre-2.1.252 samples lack the block, so a window of only old samples would otherwise kill any view referencing them (binder error).
- Can a Rust query hit the error today? No Rust code references a prompt_cache_ column (VERIFIED by grep), so not today; it becomes live the moment a Rust query (e.g. port of cache-expired / cache view) reads them. INFERRED.
- TS store is still production: src/cli/statuslineHistoryCli.ts imports queryStatusline from ../statuslineStore (CLI path), so it is not only a parity oracle. Rust side is covered by tests/statusline_parity.rs.

## Fix sketch
Add the 16 names with the TS types to GUARANTEED_COLUMNS in statusline_store.rs (fix array length; fold the 2 chained entries in while there). Add a test that queries a window of samples lacking the block and selects a prompt_cache_ column, asserting NULL not binder error; extend statusline_parity.rs.

Found by: schema-draft work for TRDD-LHCHVK9Z on 2026-10-04.

## Approval log

- 2026-10-04T04:20:26+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
