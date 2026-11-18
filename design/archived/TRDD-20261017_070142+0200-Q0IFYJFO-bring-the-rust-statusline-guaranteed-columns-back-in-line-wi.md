---
trdd-id: Q0IFYJFO
title: Bring the Rust statusline GUARANTEED_COLUMNS back in line with the TypeScript column list
column: complete
status: archived
created: 2026-10-17T07:01:42+0200
updated: 2026-11-16T23:00:09+0100
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
implementation-commits: [0bdad550, c7a43535]
---

# Bring the Rust statusline GUARANTEED_COLUMNS back in line with the TypeScript column list

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-10-17

- Fixed: 0bdad550 guarantees prompt_id and prompt_cache_ttl in the Rust GUARANTEED_COLUMNS; c7a43535 casts prompt_id to VARCHAR at the relation. See the Fixed section for the measured errors and tests.
- The first body paragraph is superseded. The gap measured 16 columns, not 19. The Binder error was measured, so it is no longer unverified. Which list governs is answered: the Rust list governs alcore; the TS list still binds the statusline-history CLI. The 'not a drive-by edit' caution applies to aligning all 15 remaining TS-only columns, not to the two that were added after three review rounds and a measured failure.
- Evidence levels: the seal COPY going through varchar_session_id was read by a worker; the main agent did not read it. 'This predates 0bdad550' is inferred, not run against the old code.
- NEXT ACTION: the owner decides how to close the card (column human_review).

Found 2026-10-17 in the TRDD-GVA8TTJF round-2 review (item m2). rust-core/crates/agentlens-core/src/statusline_store.rs GUARANTEED_COLUMNS (24 entries) decides the layout of every statusline data file written from then on, and it is reported to be 19 columns behind the TypeScript list it was copied from (src/statuslineStore.ts GUARANTEED_COLUMNS). Verified 2026-10-17: prompt_cache_ttl is in the TypeScript list (src/statuslineStore.ts:220) and absent from the Rust file. The reported consequence, a DuckDB Binder error in the cache_turns query when a sample lacks that key, is not verified here. prompt_id is not in the TypeScript GUARANTEED_COLUMNS list (its only mention there is a comment at line 28) and is absent from the Rust file too. The cache_turns query does read sl.prompt_id (PARTITION BY, the MIN/MAX windows and turn_key in cache_turns_relation, commit 56d960e1). What is unverified is whether statusline_store::relation_for projects a column that is missing from older files as NULL or fails to bind; the tests pass only because seed_statusline_usage always writes prompt_id. Changing the list changes the on-disk schema of new files, so this needs its own design and review, not a drive-by edit. First step: establish which list governs (the Rust writer is live; the TypeScript list survives as reference), then diff the two and record the exact missing columns here.
- 2026-11-16 23:00 REVIEW IN THE OWNER'S STEAD (owner order 2026-11-16, verbatim: "review in my stead. decide yourself."): ACCEPTED, and the close question is decided: close on a checklist that restates the two Fixed bullets. Re-checked today: 0bdad550 and c7a43535 are ancestors of HEAD; cargo test (agentlens-core lib) ran window_without_prompt_id_or_prompt_cache_ttl_still_binds and mixed_window_with_and_without_prompt_keys_binds_in_wal_and_sealed_forms, 2 passed, 0 failed. NOT re-run: the cast-removed mutation. The scope cut stands: the other 15 TypeScript-only columns have no Rust reader and are not aligned.

## Approval log

- 2026-10-17T07:01:42+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-17T09:24:14+0200 — column → human_review by main-agent@agentlenspro. fix done and verified (0bdad550, c7a43535); no acceptance checklist, so closing is the owner's call
- 2026-11-16T23:00:09+0100 — COMPLETE by main-agent@agentlenspro. reviewed in the owner's stead per the 2026-11-16 order; both named Rust tests re-run today, 2 passed.

## Column diff (2026-10-17)

- Counts (read-only diff, 2026-10-17): TS-only 16, Rust-only 0, type mismatches 0 across 26 shared names. Rust effective list 26 (statusline_store.rs:156-179 array of 24, plus 188-189 appended in column_template at 183-193). TS list 42 (statuslineStore.ts:175-239). The card says 19 behind; measured 16 against the effective Rust list, or 18 against the Rust array alone.
- TS-only names, all prompt_cache_*: warm, caching_observed, ttl, expires_at, requests, misses, expected_rebuilds, hit_ratio, cache_write_tokens, miss_recache_tokens, last_miss_at, recache_tokens_if_cold (statuslineStore.ts:218-229); last_miss_cause_causes, last_miss_cause_tools_added, last_miss_cause_tools_removed, last_miss_cause_system_char_delta (statuslineStore.ts:236-239). Rust-only: none. Type mismatches: none.
- Governing list: the Rust list governs alcore binding (query_statusline statusline_store.rs:560; relation_for :210; column_template :183-193). The TS list is still on a production path: statuslineHistoryCli.ts:23 imports queryStatusline, called at :570 and :667; src/cli/main.ts:39 imports it; standalone/cli.ts:11 bundles main; standalone/cli.js:12892 carries statuslineStore.ts.
- Writer is Rust only: StatuslineStore at statusline_store.rs:260, append :290, flush :315, maybe_seal called at chores.rs:1229. No non-test TS caller of StatuslineStore; the TS writer is the parity oracle (gen-statusline-expected.mjs:15).
- Rust reader of a TS-only name: cache_turns_sql.rs:357 selects sl.prompt_cache_ttl in the production cache-turns SELECT, over the Rust relation (:336). The Rust list does not guarantee it. INFERRED from code, NOT RUN: a window whose samples all predate the prompt_cache block should fail to bind it (the trap described at statuslineStore.ts:214-217).
- The other 15 TS-only names have no Rust source reader. Rust hits are test-only: cache_turns_sql.rs:667 seeds prompt_cache_ttl; spool_tap.rs:852 is test JSON; agentlens-digest/tests/digest.rs:160, 267, 292-293 use a nested prompt_cache struct path, not the flattened names.
- Name in NEITHER list: prompt_id. cache_turns_sql.rs reads it at 7 places (e.g. :327, :342, :356) with no guarantee in either list; statuslineStore.ts:28 mentions it only in a comment. Confirms the card point that prompt_id is missing from both lists.
- Report: /Volumes/EmaUITEK4TBSSD/Code/AgentlensPro/docs_dev/20261017_084820+0200-q0ifyjfo-column-diff.md (read-only code evidence; no test or query was run).

## Fixed (2026-10-17)

- 0bdad550: prompt_id and prompt_cache_ttl added to the Rust GUARANTEED_COLUMNS (VARCHAR). Measured before the fix: 'Binder Error: Values list "sl" does not have a column named "prompt_id"' on a window whose samples lack both. GUARANTEED_COLUMNS shapes both the read relation and the seal COPY (through varchar_session_id), so the claim that it decides the layout of files written from then on is verified. Rust-only columns are now 1 (prompt_id, which the TS list lacks); TS-only columns are 15.
- c7a43535: prompt_id cast to VARCHAR at the relation, like session_id. Found by the mixed-window test: real Claude Code prompt ids are UUIDs, read_json_auto types them as UUID, and cache_turns' COALESCE failed with 'Cannot mix values of type UUID and VARCHAR'. This predates 0bdad550. The test covers four layouts, including a legacy UUID-typed parquet part.
- Scope cut, stated: 'back in line with the TypeScript list' was reduced to 'the columns a Rust reader needs'. The other 15 TS-only columns have no Rust reader. Full alignment for the TS statusline-history CLI would be its own card if ever wanted.
- Layout 3 (legacy UUID-typed part) mutation, run alone with the cast removed: FAIL, 'Binder Error: Cannot mix values of type UUID and VARCHAR in COALESCE operator' (reports_dev/q0if4-mut.txt); files restored, cmp clean. Layouts 0 and 3 were each shown to fail without the c7a43535 cast; layouts 1 and 2 were not run on their own without it.
- Not closed: trddgrep refuses `complete` on a card with no acceptance checklist, and project practice is not to write acceptance at close time. Left for the owner: tick a checklist matching the Fixed bullets, or close as is. The owner's 2026-10-05 review delegation was considered and not used for this close.

## Acceptance

- [x] prompt_id and prompt_cache_ttl are guaranteed columns in the Rust list, so a window whose samples lack both still binds (0bdad550; Rust test window_without_prompt_id_or_prompt_cache_ttl_still_binds passed 2026-11-16)
- [x] prompt_id is cast to VARCHAR at the relation, so a window mixing UUID-typed and text ids binds (c7a43535; Rust test mixed_window_with_and_without_prompt_keys_binds_in_wal_and_sealed_forms passed 2026-11-16)
(Written at closing time by the reviewer from the Fixed section; the card had no checklist.)
