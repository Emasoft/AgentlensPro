---
trdd-id: AS5DZJRC
title: Close the 1.3 percent gap where the structural boundary and billed usage disagree
column: todo
created: 2026-09-03T20:42:45+0200
updated: 2026-09-03T20:42:45+0200
current-owner: unassigned
task-type: spike
severity: MEDIUM
labels: [cache, attribution, measurement, open-question]
relevant-files: [src/shared/cacheClassification.ts, reports/trace-redesign/20260903_202229+0200-classifier-validation.md]
blocked-by: []
npt: []
eht: []
release-via: none
---

# Close the 1.3 percent gap

The classifier agrees with billed usage on 296 of 300 real turns (median share error 1.6e-4). The
four that disagree are NOT noise — each has a known shape, and two of them point at a real modelling
limit. This card is the measurement work to decide whether to close them or accept them permanently.

## The four, from the validation run

| shape | n | evidence |
|---|---|---|
| TTL / eviction the structure cannot see | 2 | one pair is BYTE-IDENTICAL (same `body_id`) after a 1,422 s idle gap and still paid ~600k `cache_creation` with low `cache_read` |
| the surviving entry was written by an EARLIER turn | 2 | a genuine mid-list edit at `messages[694]` of 750 breaks the prefix there, yet billed says ~99% was read: the entry hit was written by an earlier turn whose trailing marker sat BEFORE the edit |

## Open questions — answer each with a measurement

1. **How often does the earlier-entry shape actually occur?** `survivingBoundary(prev, …)` looks only
   at the immediately preceding request. Anthropic's lookback is documented as 20 blocks, so entries
   from several turns back are reachable. MEASURE: over ≥1,000 pairs, how many turns would reconcile
   better if the boundary were the best match over the last N requests (N = 2, 5, 10, 20) instead of
   just the previous one? Report agreement per N and the cost of the extra scans.
2. **Is the multi-entry search worth its complexity?** If N = 20 buys under 1 percentage point of
   agreement, record that and keep the previous-request rule with the gap documented. Decide on the
   number, not on elegance.
3. **Can TTL eviction be PREDICTED rather than merely observed?** We know the TTL regime per session
   (`get_account_status` reports 5m vs 1h) and the idle gap between requests. MEASURE: over the
   corpus, does `idle_gap > ttl` predict the byte-identical-resend-with-full-write case? If it
   predicts well, the trace can say "cold write after a 23-minute idle gap, TTL expired" instead of
   reporting an unexplained disagreement.
4. **What is the honest display for a residual disagreement?** Once 1 and 3 are answered, decide what
   the trace shows for a turn that still cannot be explained. It must not show the flattering number.

## Constraint on any fix

The billed usage stays the ORACLE and the structural diff explains it. A change that improves
agreement by making the structure "vote" against billed usage is a regression, not a fix — that is
the failure this whole line of work exists to eliminate.

## Acceptance

- [ ] Agreement measured for N = 1, 2, 5, 10, 20 over ≥1,000 pairs, with the scan cost of each.
- [ ] A decision recorded with its number: adopt multi-entry search, or accept the gap.
- [ ] The TTL predictor is measured (precision and recall against the observed cold writes) and
      either shipped as a named cause or rejected with its numbers.
- [ ] The module's KNOWN GAP comment is updated to match whatever the measurements conclude.
