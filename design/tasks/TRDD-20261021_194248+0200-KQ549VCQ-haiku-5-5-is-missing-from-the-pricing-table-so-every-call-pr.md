---
trdd-id: KQ549VCQ
title: Haiku 5.5 is missing from the pricing table so every call prices at zero
column: todo
status: tasked
created: 2026-10-21T19:42:48+0200
updated: 2026-10-21T19:42:48+0200
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
---

# Haiku 5.5 is missing from the pricing table so every call prices at zero

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
