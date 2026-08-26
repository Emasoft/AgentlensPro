---
trdd-id: R4DHDK7L
title: Long-context surcharge is unencoded for 4 models and its threshold is hardcoded 200k with unverified semantics
column: todo
created: 2026-08-26T05:17:34+0200
updated: 2026-08-26T05:23:29+0200
current-owner: main
task-type: feature
severity: MEDIUM
scope: project
project-id: agentlenspro
min-approval-requirement: none
relevant-files: [src/shared/pricing.ts]
labels: [pricing, cost-accuracy]
npt: []
eht: []
---

# Long-context surcharge: 4 models unencoded, threshold hardcoded, semantics unverified

## PREMISE CORRECTION (advisor consult + first-hand grep, 2026-08-26)

This card originally claimed "PricingRates carries no surcharge field or
threshold logic". **False** — verified: `src/shared/pricing.ts:37-40` has
`inputAbove200kPerMTok` / `outputAbove200kPerMTok` / `cacheReadAbove200kPerMTok`
/ `cacheWriteAbove200kPerMTok`, applied by a tiered-cost path (threshold
hardcoded `200_000` at ~:192), and mirrored 1:1 in
`rust-core/crates/agentlens-core/src/pricing.rs:59-62,133` with parity tests.
The mechanism EXISTS. The real gaps are three:

1. **Four models don't use it** — their comments defer the surcharge:

- `:77` gpt-5.4 — ">272K tokens surcharge not implemented"
- `:80` gpt-5.5 — rate "TBD per docs", surcharge threshold unknown
- `:132` gemini-2.5-pro — ">200K tokens surcharge not implemented"
- `:135` gemini-3.1-pro — ">200K tokens surcharge not implemented"

2. **The threshold is a hardcoded 200_000** — gpt-5.4's own comment names 272K,
   so even encoding its rates into the existing fields would misprice it. Needs
   `surchargeThresholdTokens?` (default 200_000) on the existing FLAT shape —
   no nested struct, no second table, keeps the Rust field mapping 1:1.
3. **The existing semantics are unverified against providers** — the advisor's
   reading of the published rate pages is that Anthropic/Gemini long-context
   pricing is a whole-request STEP on TOTAL input tokens, while the shipped
   `tieredCost` applies per-bucket tiering (150K input + 150K cacheRead = 300K
   total, and no bucket trips 200K) — which would mean the mechanism already
   mispriced the models it DOES cover. SETTLE SEMANTICS FROM THE LIVE RATE
   PAGES FIRST; do not propagate the current model to 4 more entries until
   step vs marginal is decided from source.

Every large-context call on the 4 unencoded models is silently under-costed
past the threshold. Degrades cost accuracy; nothing crashes.

## Consumers (advisor-verified)

`calcTokenCostUsd` applies the tier — yes, changes. `calcTokenCost` (session
totals) explicitly does NOT (comment at :35) — leave it. Harness-reported
`cost_usd` stays preferred per doctrine. **The Rust `pricing.rs` + parity
fixtures must move in the same commit or parity goes red.**

## Constraints from the house doctrine (CLAUDE.md)

- Rates change in ONE place: `src/shared/pricing.ts` (bump `PRICING_LAST_UPDATED`;
  `PRICING_SOURCES.md` holds the authoritative per-provider rate URLs).
- The module is shared host+webview: no Node imports, no DOM APIs.
- `scripts/check-no-mirrors.js` guards against re-declaring exports under media/.
- Verify current provider rates from the LIVE rate pages before encoding them —
  the sweep found gpt-5.5's base rate is itself marked "TBD per docs".

## Acceptance

- [ ] Surcharge SEMANTICS (whole-request step on total input vs per-bucket
      marginal) settled from the LIVE provider rate pages and recorded here with
      the URLs; the shipped tieredCost corrected if it disagrees.
- [ ] `surchargeThresholdTokens?` (default 200_000) added to the existing flat
      shape, TS and Rust in the same commit, parity fixtures regenerated.
- [ ] The four models carry their real, source-verified thresholds and surcharge
      rates, with the rate URLs recorded in PRICING_SOURCES.md.
- [ ] A unit test pins one below-threshold and one above-threshold cost per
      surcharged model, plus one model WITHOUT a surcharge asserting unchanged math.
- [ ] check-mirrors and check-types stay green.
