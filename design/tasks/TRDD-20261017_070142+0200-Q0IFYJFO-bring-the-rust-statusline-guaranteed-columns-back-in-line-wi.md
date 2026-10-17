---
trdd-id: Q0IFYJFO
title: Bring the Rust statusline GUARANTEED_COLUMNS back in line with the TypeScript column list
column: backburner
status: tasked
created: 2026-10-17T07:01:42+0200
updated: 2026-10-17T07:05:59+0200
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
