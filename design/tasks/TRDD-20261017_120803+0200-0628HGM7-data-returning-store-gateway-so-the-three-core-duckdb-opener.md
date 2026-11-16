---
trdd-id: 0628HGM7
title: Data-returning store gateway so the three core DuckDB openers stop holding their own handles
column: backburner
status: tasked
created: 2026-10-17T12:08:03+0200
updated: 2026-10-17T12:16:13+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: refactor
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-17T12:08:03+0200
project-id: agentlenspro
---

# Data-returning store gateway so the three core DuckDB openers stop holding their own handles

## Problem

Three store openers in rust-core/crates/agentlens-core/src each open and hold their own DuckDB handle: burn/investigator_scan.rs (load_store_window), cache_event_log.rs (load_store_facts) and cache_turns_sql.rs. They were counted as store openers by cbe06222, cc49a819 and fb09facf (origin TRDD-4BZPAQWM, commit 728b143b). Three identical 512MiB copies of the same open also exist: bodies_evidence with_duck, statusline_store open_duck and cache_turns_sql open_duck. investigator_scan and cache_event_log use 256MiB with no spill and no preserve_insertion_order, so they are not part of the 512MiB dedup.

## Scope

- Scope investigator_scan.rs load_store_window, cache_event_log.rs load_store_facts and cache_turns_sql.rs (all in rust-core/crates/agentlens-core/src). Each opener becomes a function that RETURNS DATA, so the handle is opened and dropped inside the store gateway instead of being held by the caller.
- Deduplication of the three 512MiB copies (bodies_evidence with_duck, statusline_store open_duck, cache_turns_sql open_duck) is optional and lowers no count. If done, the shared function's call sites are counted by check-duckdb-only, with that rule added to the guard in the same change.

## Rules settled by measurement

- Deduplicating into a helper that returns a Connection lowers no count. Any such helper call site must be counted by check-duckdb-only (scripts/check-duckdb-only.js). Only a function that returns data removes the handle from the caller.
- Commit a per-site current_setting test for each site and measure it with the OLD code first. DuckDB normalises memory_limit, so an assertion never measured on the old code proves nothing.
- Settings per site: docs_dev/20261017-4bz-measure-report.md section 3 (gitignored scratch).
- No change to alcore memory behaviour (TRDD-H8F9S7MY).

## Acceptance

- The three named openers no longer construct or hold a DuckDB Connection: each calls a store-crate function that returns rows or structs, verified by reading the three files, and any Connection-returning helper's call sites are counted by the guard.
- Per-site current_setting tests committed, with the old-code measurement recorded first. Record the old-code current_setting values on this card before migrating.
- Both opener caps in scripts/check-duckdb-only.js (MAX_NON_TEST_OPENERS, MAX_TEST_OPENERS) lowered to the new exact counts, and node scripts/check-duckdb-only.js exits 0.

## Origin

TRDD-4BZPAQWM, commit 728b143b.

## Approval log

- 2026-10-17T12:08:03+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Notes

When this card next touches scripts/check-duckdb-only.js, fix three comments left by 728b143b: replace 'follow-up card named on TRDD-4BZPAQWM' with 'TRDD-0628HGM7'; 'and none stopped' becomes 'and no gate stopped them'; move '(raised again 2026-10-17, see above)' on the 2026-09-24 line to the end of that sentence. They were left because fastedit cannot replace comment lines between symbols.
