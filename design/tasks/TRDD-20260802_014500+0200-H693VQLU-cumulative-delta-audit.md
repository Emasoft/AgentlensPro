---
trdd-id: H693VQLU
title: Audit every place a CUMULATIVE field is differenced — baseline and gap
column: todo
created: 2026-08-02T01:45:00+0200
updated: 2026-08-02T01:45:00+0200
current-owner: unassigned
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

- [ ] A list of every differencing site with file:line, and for each: does it establish a BASELINE on
      first observation, and does it bound or surface the GAP?
- [ ] Every site that fails either check is fixed or has a written reason it cannot be wrong.
- [ ] Each fix carries a regression test **verified to fail** against the unfixed version.
- [ ] `.claude/project/memory/cumulative-vs-per-turn-fields.md` updated with anything the audit adds.

## Method

Grep is the wrong primary tool here — the pattern is semantic (`a.x - b.x` where x is cumulative),
not lexical. Enumerate the cumulative FIELDS first (that list is short and already written in the
memory page), then find their readers. Delegate the per-file read; keep the cross-file view.

**Include the cheap detector in the report**: two figures that cannot both be true (a cost against a
token count implying a rate outside the pricing table) found the first bug without knowing which
figure was wrong. Worth wiring into a diagnostic rather than leaving as a technique.
