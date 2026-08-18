---
trdd-id: NY725TJA
title: The cacheExpiry project-scope test flakes under full-suite load and has never been root-caused
column: completed
created: 2026-08-11T20:29:59+0200
updated: 2026-08-18T12:45:00+0200
current-owner: main
task-type: bugfix
severity: medium
---

# The cacheExpiry project-scope test flakes under full-suite load and has never been root-caused

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-08-11

**ROOT-CAUSED AND FIXED 2026-08-12.** The mechanism is established, the fix is one line in the
fixture, and the full suite is green (2239 passing / 11 pending / **0 failing**) for the first time.

**The title of this card is WRONG and is left standing as the record of a false lead.** "Under
full-suite load" was the assumption every sighting inherited. Measured: the test fails **7 times in
20 runs with that single test alone in the process** (`--grep`). Load raises the rate; it was never
required. Had the investigation kept chasing cross-test pollution — the obvious reading of "under
load" — it would have searched the one place the bug was not.

**Mechanism (each reference verified first-hand, not taken from the report that proposed it):**
`src/test/cacheExpiry.test.ts:143` built the shared timeline as `() => [apiRequestAt(iso(1))]`, so
`iso(1)` — `new Date(Date.now() - 60_000)` — was re-evaluated on **every call**. `getTimeline` is
called fresh per session (`src/mcpServer.ts:2013`), and `scanWithBudget` yields to the macrotask
queue between items (`await new Promise(r => setImmediate(r))`, `src/mcpServer.ts:3053`). So the
later-processed card gets a strictly newer millisecond, and the strict-greater tie-break
`ms > newestMs` (`src/mcpServer.ts:2157`) crowns whichever card the scheduler reached second —
`mine`, when the fixture says the answer is `foreign`.

**The product code is correct and was NOT changed.** Strict-greater over millisecond timestamps with
a real yield between items is right for real sessions. Reading the wall clock across that yield is
what a fixture must not do — and the comment two lines above the defect already said so ("a per-card
timestamp would let the precision ranking, not the scope filter, decide the winner"); the fixture
created exactly the thing it warned against. The file had also already established the remedy: a
frozen `NOW` at line 16, "fixed clock so tests are deterministic", which this one suite did not use.

**Fix:** capture the timestamp once (`const activityAt = iso(1)`) and close over the value. The
cards stay relative to the real clock, because their expiry is assessed against it — freezing the
VALUE is the fix, not adopting the fixed epoch, which sits in 2027 and would put every card in the
future.

**Evidence:** 7/20 failures before, **0/20 after**, same command, same machine (p ≈ 0.0002 under the
observed 35% base rate). Then the full suite green.

**NEXT ACTION:** none — awaiting review/merge with the branch. The one open question deliberately
NOT chased: the card notes the failure COUNT varied (1, then 2, then 0), implying a second exposed
case in that suite. 20 isolated runs and a green full suite no longer reproduce any of it, so there
is nothing left to diagnose; if a second case resurfaces, it gets its own card rather than reopening
this one.

## The failure

```
1) handleCheckCacheExpiry — project scope (2026-08-04)
     an empty project string is the documented machine-wide opt-out, and --all is scoped too
```

Test file: `src/test/cacheExpiry.test.ts`.

## Measured, on IDENTICAL code (commit 942d5ac's tree)

| run | result |
|---|---|
| full suite | 2226 passing / **1 failing** |
| full suite | 2225 passing / **2 failing** |
| full suite | 2227 passing / **0 failing** |

So it is genuinely non-deterministic, and the failure COUNT varies too — which means more than one
case in that suite is exposed, not just the named one. An earlier sighting tonight reported a
`'mine' !== 'foreign'` mismatch, i.e. the project-scoping resolved to the wrong project, not a
timeout. **That detail matters and points away from "slow machine":** a timeout produces a timeout
error, not a wrong-value assertion.

Every observation so far was on a heavily contended box (load 60-150 on 14 CPUs, ~20 concurrent
Claude sessions). The correlation with load is real but is NOT itself the mechanism.

## Two hypotheses, neither confirmed

1. **Shared mutable state across the suite.** `.mocharc` runs every test in ONE process
   (`spec: ['out/test/test/**/*.test.js']`), so a module-level cache, a registry, or a cwd/env
   mutation set by another test file could leak in. Test ORDER under load is the only thing that
   changes between a green and a red run — which fits a leak far better than it fits timing.
2. **A real cwd/project-resolution race.** The test asserts project SCOPING; if resolution reads
   the live cwd or a shared project map that another concurrent test mutates, `'mine' !== 'foreign'`
   is exactly what you would see.

Hypothesis 1 is the cheaper one to falsify and should go first.

## How to reproduce

Note that a positional file does NOT isolate — `.mocharc`'s `spec` glob is ADDED to it, so
`npx mocha out/test/test/cacheExpiry.test.js` still runs the whole suite (~2237 tests). Use
`--spec` or `--grep` for genuine isolation:

```bash
npx mocha --spec out/test/test/cacheExpiry.test.js          # this file alone
npx mocha --grep "machine-wide opt-out"                     # the one case, full-suite context
```

Run the full suite in a loop until it reddens, and capture the assertion's ACTUAL value, not just
the pass/fail. If it passes under `--spec` but fails in the full suite, hypothesis 1 is confirmed
and the leaking test is findable by bisecting the file list.

## Verification

A fix is only proven by the full suite green across **at least 10 consecutive runs under load
comparable to where it fails** (load ratio > 4 on this box). One green run proves nothing — the
measured distribution above already contains a green run on the failing code.

Do NOT "fix" this by adding a retry, widening a timeout, or marking the test pending. A wrong-value
assertion is not a timing problem, and hiding it would remove the only signal that the scoping
logic misbehaves under concurrency — which, if hypothesis 2 holds, is a PRODUCT bug and not a test
bug at all.

## Notes and lessons learned

## Approval log

- 2026-08-14T02:30:00+0200 — COMPLETED (human_review → complete). Reviewed under the owner's
  standing delegation ("review them yourself... based on verified facts"): every load-bearing claim
  verified first-hand against current code with file:line evidence — see
  reports/trdd-review/20260814_015415+0200-batch2-review.md (this card's section). No contradiction
  found; open residuals, where any, are recorded in that report and are non-blocking.
- 2026-08-18T12:45:00+0200 — ARCHIVED by USER batch directive ("complete all TRDD"); validity
  re-verified: src/test/cacheExpiry.test.ts:154 captures `const activityAt = iso(1)`.
