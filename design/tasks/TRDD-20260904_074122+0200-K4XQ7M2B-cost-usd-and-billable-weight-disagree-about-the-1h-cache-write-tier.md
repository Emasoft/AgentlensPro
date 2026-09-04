---
trdd-id: K4XQ7M2B
title: cost_usd and billable_weight disagree about the 1h cache-write tier in the same api_calls row
column: todo
created: 2026-09-04T07:41:22+0200
updated: 2026-09-04T07:41:22+0200
current-owner: main-session
task-type: bugfix
project-id: agentlenspro
scope: project
min-approval-requirement: none
labels: [pricing, forensics, parity]
severity: high
effort: S
relevant-rules: []
npt: []
eht: []
implementation-commits: []
external-refs: []
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
rate therefore understates that bucket by **37.5%** (1.25/2), and understates the row's total cost
by whatever share the write bucket carries.

**It is not an edge case.** CLAUDE.md doctrine 3: *"MAIN conversation → 1h TTL automatically"*. So
interactive traffic — the dominant shape for a human's own sessions — is exactly the traffic being
understated. The 7 sessions in the sonnet-5 measurement were 100% 5m tier, which is a property of
**subagent** traffic and is why that measurement could not have surfaced this
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

- [ ] `cost_usd` and `billable_weight` agree about the tier split for the same row, in BOTH
      languages, pinned by a test that fails if either call site reverts to a hard-coded `0`.
- [ ] A row with a flat `cache_creation` total and no tier sub-object is unchanged.
- [ ] TS↔Rust parity fixtures regenerated, and a fixture case actually EXERCISES 1h tokens —
      otherwise the suites stay green while proving nothing about the change, which has happened
      three times in this area already.
- [ ] The persisted-row decision is made explicitly and recorded in `CHANGELOG.md`.

## Non-goals

- Do NOT fold in the sonnet-5 work; that is landed (897f51eb, f7610871, 8f00e737, 2abda566).
- Do NOT repair the 3,283 sonnet-5 rows here — that is a separate, still-undecided call.
