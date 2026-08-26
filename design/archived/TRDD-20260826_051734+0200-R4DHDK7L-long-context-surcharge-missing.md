---
trdd-id: R4DHDK7L
title: Long-context surcharge is unencoded for 4 models and its threshold is hardcoded 200k with unverified semantics
column: complete
created: 2026-08-26T05:17:34+0200
updated: 2026-08-26T08:05:00+0200
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
implementation-commits: [31e1d24]
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

## SETTLEMENT (2026-08-26, from the LIVE rate pages)

**Whole-request STEP on total input size (input + cacheRead + cacheWrite; output
excluded from the threshold), never per-bucket marginal.** All buckets — output
included — bill at premium once the total crosses the threshold.

- Gemini: rates keyed "prompts <= 200k / > 200k" — <https://ai.google.dev/gemini-api/docs/pricing>
- OpenAI: tables keyed "(<272K context length)" vs long-context — <https://developers.openai.com/api/docs/pricing>
- Anthropic: NO surcharge on any current model — "Claude 4.6 and later models
  include the full 1M token context window at standard pricing. (A 900k-token
  request is billed at the same per-token rate as a 9k-token request.)" —
  <https://platform.claude.com/docs/en/about-claude/pricing#long-context-pricing>.
  claude-sonnet-4's Above fields are historical (1M-beta) and were corrected to
  step semantics.

The shipped per-bucket marginal `tieredCost` DID disagree and was replaced with
the step in both TS and Rust. gemini-3-pro (delisted live, launched with the
identical tier 3.1 shows) was also encoded, under the retained-historical-pricing
precedent (claude-opus-4-7-fast). gpt-5.5's base rates are now published and
match the table ($5/$0.50/$30).

## Acceptance

- [x] Surcharge SEMANTICS settled from the LIVE provider rate pages and recorded
      (above + PRICING_SOURCES.md); the shipped tieredCost corrected (step).
- [x] `surchargeThresholdTokens?` (default 200_000) added to the flat shape, TS
      and Rust in the same commit, parity fixtures regenerated (409 cases +
      2 new divergence buckets; Rust oracle parity exact, 2/2).
- [x] gpt-5.4 (272K), gpt-5.5 (272K), gemini-2.5-pro, gemini-3.1-pro (+
      gemini-3-pro) carry source-verified thresholds/rates; URLs in
      PRICING_SOURCES.md.
- [x] Unit tests pin below/above threshold per surcharged model, the
      combined-buckets divergence case, output-alone-never-trips, and
      claude-sonnet-4-5 flat (no surcharge) unchanged.
- [x] check-mirrors green (121 exports), check-types green, export --check in
      lockstep (44 models), full mocha suite green (1 load-flake timeout in
      cacheBreakTimeline passed clean standalone).
