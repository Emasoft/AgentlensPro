---
trdd-id: H693VQLU
title: Audit every place a CUMULATIVE field is differenced — baseline and gap
column: complete
created: 2026-08-02T01:45:00+0200
updated: 2026-08-14T02:40:00+0200
current-owner: session
task-type: audit
npt: []
eht: []
---

# Audit every place a CUMULATIVE field is differenced

## Why

Two of the largest wrong numbers this project has ever reported came from the same mistake, in two
different files, found four hours apart — so the third instance is a question of where, not whether.

| symptom | cause | magnitude |
|---|---|---|
| account 5h window showed **$2,097.68** against 265,845 tokens ($7,890/MTok, ceiling is $25) | no BASELINE: a restart re-met each live session at `prev = 0`, billing its lifetime cost as one turn | ~300x |
| a warm $0.35 turn reported as a **$5 cold write** | no GAP CHECK: sampling stops while idle, so the bracketing pair carries every turn between | ~15x |

Both were fixed where they were found (`4a44582`, `799595e`). Neither fix was systematic.

## Scope

Find EVERY site that subtracts two observations of a monotonically-growing field and treats the
result as one interval's activity. Known candidate surfaces (verify, do not assume):

- `src/statuslineUsage.ts` — fixed; use as the reference shape.
- `src/burnMonitor.ts` — `gatherConsumptionEvents`, the rolling-window math, `statuslineCostUsd`.
- `src/subscriptionUsage.ts`, `src/accountStateTimeline.ts` — window fills and rotation segments.
- `src/cli/statuslineHistoryCli.ts` — the `peaks` view (fixed; the gap column is the reference).
- `src/countCache.ts`, `src/exactTokens.ts` — anything differencing a running count.
- The dashboard: `media/src/**` may difference a card's cumulative totals for a rate.

## Acceptance

- [x] A list of every differencing site with file:line, and for each: does it establish a BASELINE on
      first observation, and does it bound or surface the GAP?
- [x] Every site that fails either check is fixed or has a written reason it cannot be wrong.
      (CLOSED 2026-08-14 — commit 38c16bb: the one failing site (burnMonitor.ts fallback) now
      returns `{costUsd, isIntervalTotal}`; the event carries `costIsIntervalTotal` + `intervalMs`
      (from the statusline reader's own prev-vs-current ts, seconds→ms — the ×1000 verified against
      statuslineUsage.ts:101's `Math.floor(tsMs / 1000)`). Additive fields; cost never lost.)
- [x] Each fix carries a regression test **verified to fail** against the unfixed version.
      (CLOSED 2026-08-14 — src/test/burnMonitor.test.ts: two samples straddling an idle gap with an
      unpriced model id, exactly the card's specced fixture; falsified against the unfixed code.
      Evidence: reports/trdd-review/20260814_020616+0200-H693VQLU-fix.md.)
- [x] `.claude/project/memory/cumulative-vs-per-turn-fields.md` updated with anything the audit adds.

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-08-05

**AUDIT DONE. ONE FINDING, NOT YET FIXED — the fix changes burn numbers, so it wants your call.**
Full site table with every verdict:
`reports/cumulative-delta-audit/20260805_043236+0200-differencing-sites.md`.

**The surface is far smaller than the card assumed.** Almost every `totalCostUsd`-shaped identifier
in this codebase is one of OUR OWN AGGREGATES (a sum over a scan), which is safe by construction.
**Exactly three** sites difference a genuinely cumulative observation:

| # | site | BASELINE | GAP | verdict |
|---|---|---|---|---|
| 1 | `src/statuslineUsage.ts:203-215` | **YES** (`firstSampleOfSession ? 0 : …`, plus a `Math.max(0, …)` clamp for a restart regression) | delegated downstream, documented | **PASS** |
| 2 | `src/cli/statuslineHistoryCli.ts:419-423` (`peaks`) | N/A — SQL `lag()` is NULL on row 1, so no phantom baseline exists | **YES** — `gap_s`/`span` beside the delta | **PASS** |
| 3 | `src/burnMonitor.ts:315-323` | inherited | **PARTIAL** | **FAILS on one branch** |

**Four of the six named candidate surfaces are NEGATIVE, verified file by file, not assumed:**
`subscriptionUsage.ts` and `accountStateTimeline.ts` subtract only TIMESTAMPS (durations — both
observations are real, so neither rule applies), and `countCache.ts` / `exactTokens.ts` contain
**zero** arithmetic subtractions. The dashboard (`media/src/**`) sums across DISTINCT sessions and
takes one average; it computes no cross-time delta at all.

**THE FINDING — it is not a missing check, it is a check that lives in the OTHER file.**
`statuslineUsage.ts:200-202` justifies suppressing its first delta *because* "burnMonitor.
statuslineCostUsd prices a turn from its own buckets whenever the model is known and falls back to
this delta only otherwise." That `otherwise` is `burnMonitor.ts:315-323`, which returns the raw
cumulative `be.deltaCostUsd` when the model is unknown **and** when `calcTokenCostUsd` yields 0.
`pricing.ts:195-196` is `if (!rates) return 0` — **any model id not in the table returns 0, not an
error**. So on that branch a cumulative delta is used as a turn cost, gap-unaware, unmarked. Using
the cumulative delta is what spiked the rolling $/hr **~4×** (burnMonitor's own measurement).

**It fires the day a NEW MODEL SHIPS** and is not yet in `pricing.ts` — exactly when burn is watched
hardest — and it fails silently, upward.

**NEXT ACTION — one decision from you, then I implement it immediately.** Carry the sampling
interval on the event and have the fallback branches label the value an INTERVAL total rather than a
turn cost. Site 2 already proves the shape (`gap_s` beside the delta), and it preserves "never lose
cost", which is the stated reason the fallback exists. I did not apply it unreviewed because it
changes burn numbers. The regression test ships with it and gets falsified against the unfixed code:
one session, two samples straddling an idle gap, an unpriced model id — today the event's cost is
the whole gap's spend presented as one turn.

**Worth wiring in separately (the card's closing note, now concrete):** the contradiction detector is
mechanical — any emitted `(costUsd, tokens)` pair implying a $/MTok outside the pricing table's
range is wrong without knowing which figure is wrong. Dearest rate today is $25/MTok. That assertion
would have caught the $2,097.68 bug at the source instead of by eye.

## Method

Grep is the wrong primary tool here — the pattern is semantic (`a.x - b.x` where x is cumulative),
not lexical. Enumerate the cumulative FIELDS first (that list is short and already written in the
memory page), then find their readers. Delegate the per-file read; keep the cross-file view.

**Include the cheap detector in the report**: two figures that cannot both be true (a cost against a
token count implying a rate outside the pricing table) found the first bug without knowing which
figure was wrong. Worth wiring into a diagnostic rather than leaving as a technique.

## Approval log

- 2026-08-14T02:40:00+0200 — COMPLETED (human_review → complete). The STATE block's "one decision
  from you" was resolved under the owner's standing review delegation: the card's own proposed
  shape (label the fallback an INTERVAL total, carry the gap) was implemented as specced, commit
  38c16bb, with the specced falsifying regression test. The contradiction-detector idea in the
  closing note remains a candidate for its own card, deliberately not smuggled into this one.
