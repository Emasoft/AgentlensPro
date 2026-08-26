---
trdd-id: R4DHDK7L
title: PricingRates has no long-context-surcharge mechanism so 4 models under-report cost past their threshold
column: todo
created: 2026-08-26T05:17:34+0200
updated: 2026-08-26T05:17:34+0200
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

# The pricing model cannot express a long-context surcharge

## The gap (from the 2026-08-26 incompleteness sweep)

`PricingRates` carries no surcharge field or threshold logic. Four models' own
comments in `src/shared/pricing.ts` say so explicitly:

- `:77` gpt-5.4 — ">272K tokens surcharge not implemented"
- `:80` gpt-5.5 — rate "TBD per docs", surcharge threshold unknown
- `:132` gemini-2.5-pro — ">200K tokens surcharge not implemented"
- `:135` gemini-3.1-pro — ">200K tokens surcharge not implemented"

Every large-context call on these models is silently under-costed once the
threshold is crossed. Degrades cost accuracy; nothing crashes.

## Constraints from the house doctrine (CLAUDE.md)

- Rates change in ONE place: `src/shared/pricing.ts` (bump `PRICING_LAST_UPDATED`;
  `PRICING_SOURCES.md` holds the authoritative per-provider rate URLs).
- The module is shared host+webview: no Node imports, no DOM APIs.
- `scripts/check-no-mirrors.js` guards against re-declaring exports under media/.
- Verify current provider rates from the LIVE rate pages before encoding them —
  the sweep found gpt-5.5's base rate is itself marked "TBD per docs".

## Acceptance

- [ ] `PricingRates` (or a sibling structure) can express "above N input tokens,
      these rates apply instead/additionally", per model, optional.
- [ ] The cost calculators that consume the table apply it (find every consumer of
      the rates — calcTokenCostUsd and any per-bucket weighting — and confirm which
      need the threshold; cite each).
- [ ] The four models carry their real, source-verified thresholds and surcharge
      rates, with the rate URLs recorded in PRICING_SOURCES.md.
- [ ] A unit test pins one below-threshold and one above-threshold cost per
      surcharged model, plus one model WITHOUT a surcharge asserting unchanged math.
- [ ] check-mirrors and check-types stay green.
