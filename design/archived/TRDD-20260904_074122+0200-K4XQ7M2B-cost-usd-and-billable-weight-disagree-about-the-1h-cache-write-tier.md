---
trdd-id: K4XQ7M2B
title: cost_usd and billable_weight disagree about the 1h cache-write tier in the same api_calls row
column: complete
created: 2026-09-04T07:41:22+0200
updated: 2026-10-28T23:23:18+0100
current-owner: main-session
task-type: bugfix
project-id: agentlenspro
scope: project
min-approval-requirement: none
labels: [pricing, forensics, parity]
priority: high
severity: high
effort: S
relevant-rules: []
npt: []
eht: []
implementation-commits: [c8eb737d]
external-refs: []
status: archived
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-28T23:23:18+0100
---

# cost_usd understates every 1h-tier cache write, and the row's own sibling column knows it

## Why this exists

Found while fixing the sonnet-5 mispricing (897f51eb → 2abda566), flagged twice by review, and
filed rather than mentioned because a finding left in prose is a finding that gets forgotten. It is
**not** part of that bug — it is older, independent, and unlike the sonnet-5 issue it is **still
live**.

## The defect

Both indexers price a row with the 1h cache-write bucket hard-coded to zero, then compute
`billable_weight` for the *same row* from the real tier split:

| | file | 1h argument to the cost call | tier split used by `billable_weight` |
|---|---|---|---|
| TS | `src/forensicsIndex.ts` (`apiCallParams`) | `0` | `ev.tier1hTokens` |
| Rust | `rust-core/crates/agentlens-core/src/forensics_scan.rs` | `0.0` | `ev.tier1h_tokens` |

So within one `api_calls` row, `cost_usd` asserts every cache write was 5-minute tier while
`billable_weight` asserts the measured split. They cannot both be right.

**Size of the error.** Per CLAUDE.md's cache doctrine (measured, three ways): an Anthropic-shaped
cache write is **1.25× input at the 5m tier and 2× at the 1h tier**. Pricing 1h tokens at the 5m
rate therefore yields `1.25/2 = 62.5%` of the true bucket cost — an understatement of
**37.5%** of truth (`1 − 1.25/2`), needing a **×1.6** correction (`2/1.25`) to restore it. Both
framings describe one defect; a review of this card quoted the second as "a 60% understatement",
which is the markup, not the shortfall. The row's total is understated by 37.5% of whatever share
the write bucket carries.

**It is the dominant shape, with one stated exception.** CLAUDE.md doctrine 3: *"MAIN conversation
→ 1h TTL automatically"* — but **"drops to 5m when the account is drawing usage credits / in
overage"**, and `get_subscription_usage`'s `usageCreditsEnabled` is the live oracle for which
regime is active. So interactive traffic is the traffic being understated on a subscription, and an
overage account sees little or none of this — size the impact against the regime, not the default.
The 7 sessions in the sonnet-5 measurement were 100% 5m tier, which is a property of **subagent**
traffic and is why that measurement could not have surfaced this
(`reports/pricing-measurement/20260904_061757+0200-sonnet5-billed-rate.md` records the all-5m
sample; the derived 1h rate was explicitly noted there as unmeasured).

`calcTokenCostUsd` already takes the 1h bucket as its 6th argument and `cacheWrite1hRate` already
derives 2× — only for entries with the Anthropic 1.25× shape, so a provider that prices writes
differently is never handed a rate it does not charge. The machinery exists; these two call sites
do not use it.

## Direction (not prescriptive — verify before building)

- Pass the real 1h token count at both call sites instead of `0`.
- Note this **changes existing computed numbers upward** — unlike the sonnet-5 fix, which corrected
  a number nothing had a right to. Decide deliberately whether persisted rows are reindexed, and
  say so in `CHANGELOG.md` either way. See the disclosure precedent in the `[Unreleased]` entry.
- The 5m/1h split is already stored (`tier_5m_tokens` / `tier_1h_tokens`, populated from the raw
  OTEL body's `cache_creation.ephemeral_*` fields), so no new capture is needed.
- Watch the flat-total case: `apiCallParams` already synthesizes a 5m attribution when a response
  carries a flat `cache_creation` with **both** tiers zero. That path must keep behaving the same,
  and it is the reason `billable_weight` and `cost_usd` were reconciled once before — read that
  comment before changing either.

## Acceptance criteria

- [x] `cost_usd` and `billable_weight` agree about the tier split for the same row, in BOTH
      languages, pinned by a test that fails if either call site reverts to a hard-coded `0`.
- [x] A row with a flat `cache_creation` total and no tier sub-object is unchanged.
- [x] TS↔Rust parity fixtures regenerated, and a fixture case actually EXERCISES 1h tokens —
      otherwise the suites stay green while proving nothing about the change, which has happened
      three times in this area already.
- [x] The persisted-row decision is made explicitly and recorded in `CHANGELOG.md`.

## Non-goals

- Do NOT fold in the sonnet-5 work; that is landed (897f51eb, f7610871, 8f00e737, 2abda566).
- Do NOT repair the 3,283 sonnet-5 rows here — that is a separate, still-undecided call.

## Acceptance evidence

Box 1 evidence: both call sites pass the measured 1h count. src/forensicsIndex.ts:623 passes ev.tier1hTokens as the 6th argument of calcTokenCostUsd, and rust-core/crates/agentlens-core/src/forensics_scan.rs:358 calls event_cost_usd (forensics_scan.rs:675), which passes ev.tier_1h_tokens. Absolute-dollar tests: src/test/forensicsIndexPricingTs.test.ts (a 1h-tier cache write is priced at the 1h rate, expects $10.00) and forensics_scan.rs event_cost_tests (a_1h_tier_write_is_priced_at_the_1h_rate_not_the_5m_rate, expects $10.00). Mutation: reverting the TS 6th argument to 0 turned the 1h test red (docs_dev/k4-mocha-red.txt); reverting the Rust helper to pass 0.0 turned the 1h cargo test red (docs_dev/k4-cargo-red.txt); both restored and green.
Box 2 evidence: flat-total rows (both tiers 0) keep the all-5m number. Tests: src/test/forensicsIndexPricingTs.test.ts (a flat cache_creation total with both tiers 0 is unchanged, expects $6.25) and forensics_scan.rs event_cost_tests (a_flat_total_row_with_both_tiers_zero_is_priced_as_all_5m, expects $6.25). Both are labelled in the code as regression guards, not mutation evidence: they pass with or without the 1h argument, so they cannot detect a revert to 0.
Box 3 evidence: rust-core/crates/agentlens-core/tests/fixtures/forensicsindexer-expected.json regenerated. Its claude-opus-5 row with tier_1h_tokens 15 changed cost_usd 0.0059 -> 0.00595625 (= 15 x (10.00 - 6.25) / 1e6), so that fixture case exercises 1h tokens. Parity suites passed (cargo): forensicsindexer, forensicsdb, forensicsscan, forensicsindex, pricing (docs_dev/k4-cargo-parity2.txt).
Box 4 evidence: CHANGELOG.md [Unreleased] Fixed entry for api_calls.cost_usd (line 134) states that rows indexed from this version on use the 1h rate, existing rows keep the old value, there is no rebuild command (the indexer rewrites a row only when its call is re-scanned inside its bounded window), and the cutover step-up is an accounting correction, not a cost increase. No reindex was done.
Test scope: scoped runs only (host overloaded), meaning targeted mocha and cargo filters plus the named parity suites; no full Rust suite was run for this close-out. The impl report also cites an earlier full mocha run (3256 passing) without recording its code state.

## Approval log

- 2026-10-28T23:23:18+0100 — COMPLETE by main-agent@agentlenspro. all four acceptance boxes met with evidence; commit c8eb737d reviewed.
