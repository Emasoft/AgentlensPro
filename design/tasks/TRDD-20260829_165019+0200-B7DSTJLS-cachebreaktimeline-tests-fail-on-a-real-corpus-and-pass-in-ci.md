---
trdd-id: B7DSTJLS
title: cacheBreakTimeline tests pass in CI and fail on a developer machine, and fail differently depending on run order
column: testing
created: 2026-08-29T16:50:19+0200
updated: 2026-09-01T19:54:09+0200
current-owner: main-session
task-type: bugfix
scope: project
project-id: agentlenspro
relevant-rules: []
implementation-commits: []
---

# cacheBreakTimeline tests fail on a real corpus and pass in CI

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-08-29

**Measured today, first-hand, on an unrelated change's verification run.** This card exists because
the failure was nearly written off as "a pre-existing flake" — the phrase a subagent used, and the
phrase that stops anyone looking. It is not a flake. A flake fails intermittently on the same
input; this fails **deterministically, differently, depending on how it is invoked**:

| invocation | result |
|---|---|
| whole file (`npx mocha out/test/test/cacheBreakTimeline.test.js`) | 2528 passing, **3 failing** (13 min) |
| the same tests via `--grep "previous_message_id chain\|subagents transcript"` | 1 passing, **6 failing** (2 min) |
| GitHub Actions on `main` at `02d25450` (the v2.32.0 tag) | **green**, all four jobs |

Every failure is the identical `Error: Timeout of 10000ms exceeded` — the mocha DEFAULT, which
means those cases never received a `this.timeout(loadScaledTimeout(...))` that their neighbours at
lines 700 / 791 / 818 do get.

**Ruled out as the cause: the change being verified when this surfaced.** `src/cli/serverControl.ts`
(`alcoreBin` fail-fast). `grep -c "alcoreBin\|serverControl" src/test/cacheBreakTimeline.test.ts`
→ **0**, and the same grep on the compiled `out/test/test/cacheBreakTimeline.test.js` → **0**. The
file neither imports nor transitively loads any module that change touched.

**The prime suspect is in the file's own comment, at `src/test/cacheBreakTimeline.test.ts:485-490`,**
which documents this exact incident from 2026-08-13: `buildCacheBreakTimeline` defaults `storeDir`
to `dataPath('store')` — **the developer's real multi-GB Parquet store** — so any scratch test that
omits it "silently scans the live corpus", and under load "11 of them blew every timeout". That
comment ends by saying it was "diagnosed as environmental until the absent-bodies test, which has
no data at all, also timed out" — i.e. the environmental diagnosis was WRONG last time too.

**So do not repeat that diagnosis without evidence.** The three call sites at lines 757 / 767 / 775
DO pass `storeDir: noStore`, which means the 2026-08-13 explanation does **not** obviously cover
these. Something else is unbounded. That gap is the whole content of this card.

**Why CI green is not reassurance:** CI runs on a clean `HOME` with no session corpus. A test whose
runtime scales with the developer's own history passes there forever and fails only on the machines
that have used the product most — which is precisely where a regression would matter. A suite that
can only pass on an empty machine is not testing what it claims to test.

## NEXT ACTION

Find what is unbounded, before changing any timeout. In order:

1. Run ONE failing case with the process's file opens traced, and see which directory it actually
   walks (`~/.claude/projects`, `~/.agentlens/store`, or the scratch dir). That answers the
   question in one measurement instead of by inspection.
2. Only then decide the fix. **Raising the timeout is the wrong fix and must not be the first one**
   — it converts a 10 s failure into a 120 s failure and hides the unbounded read. The fix is to
   bound the read (pass the scratch dir on every parameter that defaults to a real path), exactly
   as the file's own comment prescribes.
3. Explain the 3-vs-6 discrepancy. Two different failure counts for the same tests means shared
   state or ordering, and that is a second defect hiding behind the first.

## Acceptance

- [ ] The failing cases are bounded by construction — no parameter of `buildCacheBreakTimeline`
      defaults to a real user path in any test in this file.
- [ ] The whole file passes on THIS machine (a 26,377-session corpus), not only on a clean CI HOME.
- [ ] The run-order dependence is explained and gone: `--grep` on a subset gives the same verdict
      for those cases as the full-file run.
- [ ] Mutation-verified: reintroduce the unbounded default on one call site and its test must fail.
- [ ] The 2026-08-13 comment is updated with what was actually found, so the next reader does not
      re-derive it a third time.

## Notes and lessons learned

## ⏵ STATE — 2026-09-01 — FIX LANDED, verification pending

Root cause found and fixed in `aef94208`: 12 fixture calls passed `storeDir: noStore` but not
`hookEventsDir`, so `loadCompactionHookInfo` (cacheBreakTimeline.ts:1369/1718) scanned the LIVE
229MB `~/.agentlens/hook-events` synchronously inside mocha's fixed timeout — load-dependent by
construction. All 12 sites now pass `hookEventsDir: noStore`. NOT a timeout raise.
Analysis: reports/cachebreak-flake/20260901_195900+0200-load-dependence-analysis.md.
NEXT ACTION: after the in-flight full-suite gate finishes, `pnpm run compile-tests` and run
cacheBreakTimeline.test.js alone under load to confirm the flake is gone; then → ai_review.
