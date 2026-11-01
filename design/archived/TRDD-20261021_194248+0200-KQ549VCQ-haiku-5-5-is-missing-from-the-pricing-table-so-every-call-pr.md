---
trdd-id: KQ549VCQ
title: Haiku 5.5 is missing from the pricing table so every call prices at zero
column: complete
status: archived
created: 2026-10-21T19:42:48+0200
updated: 2026-11-01T09:21:02+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-21T19:42:48+0200
project-id: agentlenspro
implementation-commits: [f1b252d4, ced881fb]
---

# Haiku 5.5 is missing from the pricing table so every call prices at zero

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-11-01

- Fixed in f1b252d4: one RATES row for claude-haiku-5-5 with the over-100K rates and surchargeThresholdTokens 100_000; pricing.json and the Rust parity fixture regenerated; PRICING_LAST_UPDATED is 2026-11-01; the sonnet-4 per-category sentence in PRICING_SOURCES.md is corrected; 4 tests pin the flat rate, the over-100K rate and the 100,000 / 100,001 boundary for the bare and [1m] ids.
- Scope item 1 (the unknown multiplier) moved to TRDD-CK0DWLFQ, because it changes the whole table. Multiplier 0 on this row equals what a missing row already produced.
- Acceptance is amended accordingly: "the multiplier reads as unknown" now belongs to TRDD-CK0DWLFQ.
- Known limit: session totals from the flat calcTokenCost path ignore prompt-length tiers; see TRDD-YUKBM2I4.
- Open question answered for the session log: a cheap-worker transcript on 2026-11-01 records message.model and requestedModel as claude-haiku-5-5 (36 of 36 assistant entries), an exact RATES key. The OTEL model attribute was not checked because the collector is disabled.
- Deploy: the running server picks up the new rates only after an alcore rebuild, codesign and restart.
- 2026-11-01, review of f1b252d4: the fixture and quote gaps it found are fixed in ced881fb.
- 2026-11-01, review of f1b252d4, correction: the f1b252d4 message said that changing the threshold to 200,000 fails all four new TS tests; it fails two of the four. Its Rust parity pass came from the previous round and was re-run in ced881fb.
- 2026-11-01, review of f1b252d4, correction: the claim that request-mode figures do not move is false for callers that showed a Haiku 5.5 call as unpriced when lookupRates returned null; they now show 0 premium requests, which reads as free (recorded on TRDD-CK0DWLFQ).
- Costs persisted before the fix stay at $0: card DT1RRMNB (its id).
- 2026-11-01, box 1 (unit tests): suite pricing — claude-haiku-5-5 (TRDD-KQ549VCQ) in src/test/pricing.test.ts (commit f1b252d4); mocha run 40 passing, 0 failing, in /Volumes/EmaUITEK4TBSSD/Code/AgentlensPro/reports_dev/kq549vcq/v3-mocha-pricing.txt. Checked by the worker: that file holds the four suite tests and the 40 passing line.
- 2026-11-01, box 2 (parity oracle): /Volumes/EmaUITEK4TBSSD/Code/AgentlensPro/reports_dev/kq549vcq/20261101_091748+0100-review-fixes.md, sections New fixture rows and Mutation check (commit ced881fb). Checked by the worker: both section headings are present in that file.
- 2026-11-01, box 3 (rates and context window): orchestrator verification, read from the raw markdown at platform.claude.com/docs/en/about-claude/pricing.md (table lines 34-35, both Haiku 5.5 rows; all ten figures match RATES) and models/overview.md (Haiku 5.5 context window column: 1M tokens). Not re-checked by the worker.
- 2026-11-01, box 4 (readers): orchestrator verification, grep for Above200k and surchargeThresholdTokens over src, media/src, standalone and rust-core/crates with tests excluded finds only src/shared/pricing.ts lines 343-356 (calcTokenCostUsd) and rust-core/crates/agentlens-core/src/pricing.rs lines 64 and 167-168, both reading the threshold. Not re-checked by the worker.

## Problem
`src/shared/pricing.ts` has no `claude-haiku-5-5` row. `lookupRates` only prefix-matches a LONGER id onto a SHORTER key, so `claude-haiku-5-5[1m]` (now used by the shipped cheap-worker and fast-worker agents) finds no rate and every call is priced at $0 — silently understating burn.

## Official rates (USD per MTok), from Anthropic's pricing page
At or below 100,000 input tokens per request: input 0.10, 5-minute cache write 0.125, 1-hour cache write 0.20, cache read 0.01, output 0.50. Above 100,000: input 0.50, 5-minute write 0.625, 1-hour write 1.00, read 0.05, output 2.50. Threshold 100,000 (not the 200,000 default of `surchargeThresholdTokens`); context window 1M.

## Blocker for a complete row
`ModelRates.multiplier` (GitHub Copilot premium-request multiplier) uses `0` to mean included/free. GitHub's docs list no Haiku 5.5 multiplier (Haiku 4.5 = 0.33), so there is no way to encode "unknown" without claiming free. Add an explicit unknown representation first.

## Scope
1. Unknown-multiplier representation in `ModelRates` and every consumer.
2. The `claude-haiku-5-5` row with the long-context fields and threshold 100,000.
3. Fix the stale per-category Sonnet 4 sentence in `PRICING_SOURCES.md`.
4. Regenerate `pricing.json` via `scripts/export-pricing.js` (it serializes `RATES` verbatim, including the above-threshold fields; `rust-core` `pricing.rs` maps them).
5. Bump `PRICING_LAST_UPDATED`.

## Acceptance
A unit test prices a `claude-haiku-5-5[1m]` call below and above 100,000 tokens to the rates above, and the multiplier reads as unknown, not 0.

## Approval log

- 2026-10-21T19:42:48+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-01T09:21:02+0100 — COMPLETE by main-agent@agentlenspro. fix and review fixes landed in f1b252d4 and ced881fb; every acceptance box verified.

## Evidence

Verified 2026-10-21 by reading src/shared/pricing.ts: RATES has only claude-haiku-3-5 and claude-haiku-4-5 for Haiku, neither a prefix of claude-haiku-5-5, so lookupRates (line 259) returns null and calcTokenCostUsd returns 0 (the `if (!rates) return 0` line); callers that check lookupRates for null report the call as unpriced instead.
Open question: a probe transcript recorded requestedModel=claude-haiku-5-5[1m] but message.model as a proxy id; check which id the session log and OTEL actually carry for a cheap-worker call before declaring the fix done.
Rates source: the Claude API pricing page (https://www.anthropic.com/pricing), re-fetch and confirm each figure when implementing.

## Acceptance checklist

- [x] A unit test prices claude-haiku-5-5 and claude-haiku-5-5[1m] below, at and above 100,000 total input to the rates on the pricing page (src/test/pricing.test.ts, suite named pricing — claude-haiku-5-5; f1b252d4).
- [x] The Rust parity oracle pins the step: cases at 100,000, 100,001 and 150,000 total input; setting the threshold to 200,000 fails calc_token_cost_usd_reproduces_the_ts_oracle_exactly (ced881fb).
- [x] All ten rates and the 1M context window checked byte-exact against the raw Anthropic pricing and models pages on 2026-11-01.
- [x] The only readers of the over-threshold fields are calcTokenCostUsd (src/shared/pricing.ts) and pricing.rs, and both read surchargeThresholdTokens.
- [x] "The multiplier reads as unknown" moved to card CK0DWLFQ (whole-table change).
