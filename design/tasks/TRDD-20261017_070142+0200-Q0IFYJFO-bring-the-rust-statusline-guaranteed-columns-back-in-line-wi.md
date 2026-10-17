---
trdd-id: Q0IFYJFO
title: Bring the Rust statusline GUARANTEED_COLUMNS back in line with the TypeScript column list
column: backburner
status: tasked
created: 2026-10-17T07:01:42+0200
updated: 2026-10-17T08:48:53+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-17T07:01:42+0200
---

# Bring the Rust statusline GUARANTEED_COLUMNS back in line with the TypeScript column list

Found 2026-10-17 in the TRDD-GVA8TTJF round-2 review (item m2). rust-core/crates/agentlens-core/src/statusline_store.rs GUARANTEED_COLUMNS (24 entries) decides the layout of every statusline data file written from then on, and it is reported to be 19 columns behind the TypeScript list it was copied from (src/statuslineStore.ts GUARANTEED_COLUMNS). Verified 2026-10-17: prompt_cache_ttl is in the TypeScript list (src/statuslineStore.ts:220) and absent from the Rust file. The reported consequence, a DuckDB Binder error in the cache_turns query when a sample lacks that key, is not verified here. prompt_id is not in the TypeScript GUARANTEED_COLUMNS list (its only mention there is a comment at line 28) and is absent from the Rust file too. The cache_turns query does read sl.prompt_id (PARTITION BY, the MIN/MAX windows and turn_key in cache_turns_relation, commit 56d960e1). What is unverified is whether statusline_store::relation_for projects a column that is missing from older files as NULL or fails to bind; the tests pass only because seed_statusline_usage always writes prompt_id. Changing the list changes the on-disk schema of new files, so this needs its own design and review, not a drive-by edit. First step: establish which list governs (the Rust writer is live; the TypeScript list survives as reference), then diff the two and record the exact missing columns here.

## Approval log

- 2026-10-17T07:01:42+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Column diff (2026-10-17)

- Counts (read-only diff, 2026-10-17): TS-only 16, Rust-only 0, type mismatches 0 across 26 shared names. Rust effective list 26 (statusline_store.rs:156-179 array of 24, plus 188-189 appended in column_template at 183-193). TS list 42 (statuslineStore.ts:175-239). The card says 19 behind; measured 16 against the effective Rust list, or 18 against the Rust array alone.
- TS-only names, all prompt_cache_*: warm, caching_observed, ttl, expires_at, requests, misses, expected_rebuilds, hit_ratio, cache_write_tokens, miss_recache_tokens, last_miss_at, recache_tokens_if_cold (statuslineStore.ts:218-229); last_miss_cause_causes, last_miss_cause_tools_added, last_miss_cause_tools_removed, last_miss_cause_system_char_delta (statuslineStore.ts:236-239). Rust-only: none. Type mismatches: none.
- Governing list: the Rust list governs alcore binding (query_statusline statusline_store.rs:560; relation_for :210; column_template :183-193). The TS list is still on a production path: statuslineHistoryCli.ts:23 imports queryStatusline, called at :570 and :667; src/cli/main.ts:39 imports it; standalone/cli.ts:11 bundles main; standalone/cli.js:12892 carries statuslineStore.ts.
- Writer is Rust only: StatuslineStore at statusline_store.rs:260, append :290, flush :315, maybe_seal called at chores.rs:1229. No non-test TS caller of StatuslineStore; the TS writer is the parity oracle (gen-statusline-expected.mjs:15).
- Rust reader of a TS-only name: cache_turns_sql.rs:357 selects sl.prompt_cache_ttl in the production cache-turns SELECT, over the Rust relation (:336). The Rust list does not guarantee it. INFERRED from code, NOT RUN: a window whose samples all predate the prompt_cache block should fail to bind it (the trap described at statuslineStore.ts:214-217).
- The other 15 TS-only names have no Rust source reader. Rust hits are test-only: cache_turns_sql.rs:667 seeds prompt_cache_ttl; spool_tap.rs:852 is test JSON; agentlens-digest/tests/digest.rs:160, 267, 292-293 use a nested prompt_cache struct path, not the flattened names.
- Name in NEITHER list: prompt_id. cache_turns_sql.rs reads it at 7 places (e.g. :327, :342, :356) with no guarantee in either list; statuslineStore.ts:28 mentions it only in a comment. Confirms the card point that prompt_id is missing from both lists.
- Report: /Volumes/EmaUITEK4TBSSD/Code/AgentlensPro/docs_dev/20261017_084820+0200-q0ifyjfo-column-diff.md (read-only code evidence; no test or query was run).
