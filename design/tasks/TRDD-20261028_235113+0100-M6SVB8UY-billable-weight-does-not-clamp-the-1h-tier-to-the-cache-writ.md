---
trdd-id: M6SVB8UY
title: billable_weight does not clamp the 1h tier to the cache-write total that cost_usd clamps
column: todo
status: tasked
created: 2026-10-28T23:51:13+0100
updated: 2026-10-28T23:53:06+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-28T23:51:13+0100
priority: high
labels: [pricing, forensics, parity]
---

# billable_weight does not clamp the 1h tier to the cache-write total that cost_usd clamps

Found by the second review of commit c8eb737d (TRDD-K4XQ7M2B) and verified by reading the code. cost_usd clamps the 1h cache-write count to the write total in the pricing functions (src/shared/pricing.ts:327-328, rust-core/crates/agentlens-core/src/pricing.rs:163-164: w1h = max(0, min(1h, cacheWrite)), w5m = cacheWrite - w1h). billable_weight does not: rust-core/crates/agentlens-core/src/forensics_db.rs:180-203 and src/forensicsDb.ts:155-170 compute cc5m*r5 + cc1h*r1h from the raw tier fields, which the callers (forensics_scan.rs:365-379, src/forensicsIndex.ts:631-633) pass unchanged. Nothing upstream enforces tier_5m + tier_1h == cache_creation (forensics_scan.rs:621-623 reads them as separate usage fields). So on a row whose tier sub-object is present (at least one tier above 0) and where tier_1h > cache_creation or the two tiers do not sum to the total, cost_usd and billable_weight still disagree (the flat-total case, both tiers 0, is already reconciled by the callers' synthesized 5m attribution; the line ranges above are from the round-2 worker's code read) about the same row, which K4XQ7M2B box 1 claimed was fixed for all rows; it holds only for consistent rows.

Direction (verify first): clamp in billable_weight the same way the pricing does (1h = min(max(1h, 0), cc), 5m = cc - 1h when cc > 0), either at the callers or by giving billable_weight the cc total; keep the flat-total path (both tiers 0, synthesized 5m) unchanged; regenerate the TS/Rust parity fixtures. Measure first how many real api_calls rows have inconsistent tiers, so the size of the defect is known before choosing.

Acceptance: a test in each language with tier_1h > cache_creation asserting cost_usd and billable_weight describe the same tier split, failing on revert; flat-total row unchanged; parity fixtures regenerated with such a case.

## Approval log

- 2026-10-28T23:51:13+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Correction to the archived TRDD-K4XQ7M2B

TRDD-K4XQ7M2B is archived and immutable, so its correction is recorded here. Its COMPLETE approval entry says commit c8eb737d was reviewed; that commit's own review had not returned when the card closed. It returned with no blockers and three should-fix items: the full suites (since run: pnpm run test:unit 3260 passing; the Rust agentlens-core suite has 4 failures, in core_cap_guard and three log_reader_parity 1h-backfill tests that c8eb737d does not touch), the gemini test label and CHANGELOG wording (fixed in commit 17748752), and this card. K4XQ7M2B box 1 holds only for rows whose 5m and 1h tiers sum to the cache-write total.
The 4 Rust agentlens-core failures are pre-existing and already carded before c8eb737d: core_cap_guard::no_literal_duckdb_threads_outside_the_allowlist is TRDD-T29F5MOZ (created 2026-10-23), and the three log_reader_parity backfill tests (restore_backfill_fills_the_correct_deduplicated_value_and_touches_nothing_else, run_1h_backfill_step_persists_before_returning_so_a_hard_exit_loses_nothing, run_1h_backfill_step_does_not_scan_the_whole_card_store) are TRDD-AMSCZHF5 (created 2026-10-27, the day before c8eb737d).
