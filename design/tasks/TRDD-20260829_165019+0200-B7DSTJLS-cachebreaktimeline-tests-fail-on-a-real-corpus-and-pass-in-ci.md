---
trdd-id: B7DSTJLS
title: cacheBreakTimeline tests pass in CI and fail on a developer machine, and fail differently depending on run order
column: todo
created: 2026-08-29T16:50:19+0200
updated: 2026-10-16T11:15:59+0200
current-owner: main-session
task-type: bugfix
scope: project
project-id: agentlenspro
relevant-rules: []
implementation-commits: [aef94208]
status: tasked
---

# cacheBreakTimeline tests fail on a real corpus and pass in CI

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes every block below) — 2026-09-05T20:56

**The fix landed on 2026-09-01 and the card never said so where it counts.** `aef94208`
(`fix(test): cacheBreakTimeline fixtures no longer scan the LIVE hook-events store`, test file only,
24 lines) is the implementing commit — it was recorded in a second STATE block at the BOTTOM of this
file and `implementation-commits:` stayed empty, which is exactly why the 09-05 07:02 AI review found
"nothing to review" and REJECTed to `dev`. Both fields are corrected now; the 08-29 block below is
history.

**Re-measured today, first-hand + one delegated trace (report
`reports/lean-worker/20260905_205526+0200-B7DSTJLS-fs-trace.md`):**
- The subset the 08-29 block recorded as **6 failing** (`--grep "previous_message_id chain\|subagents
  transcript"`) is now **7 passing** in 54 ms under load-avg 11–31, with every `fs` open traced
  through a preload (`scripts_dev/trace-fs-opens.cjs`): 171 opens, 147 inside mocha's `os.tmpdir()`
  scratch tree, **0 under `~/.claude/projects` and 0 under `~/.agentlens`** — counting
  `readdir`/`opendir`/`open`/`stat` calls, which is what the preload patches; a `readFileSync` of a
  hardcoded live path would be invisible to it, but the defect class here is a directory WALK, and a
  walk cannot read an entry without the visible listing that yields its path. Capture
  `reports_dev/b7ds-mocha-one-case.txt`, trace `reports_dev/b7ds-fs-trace.tsv`.
- Call-site census, read by me: 14 `buildCacheBreakTimeline(`/`buildCauseCostPeakReport(` calls in
  `src/test/cacheBreakTimeline.test.ts`; 12 pass BOTH `storeDir: noStore` AND `hookEventsDir:
  noStore` — paired PER SITE (each call's 4-line argument object grepped for both literals: 12 rows
  `Y Y`, 2 rows `N N`), not inferred from two matching counts; the two `N N` sites, `:709` and
  `:798`, are the DELIBERATE real-corpus tests — `scanCap: 300` caps the PARSE cost, while the
  LISTING cost is the whole spool (`readdirSync`, unbounded by `scanCap`, as the `:700-707` comment
  says) and is covered by a measured timeout (`derivedTimeoutMs(defaultBodiesDir(), 120_000)` /
  `loadScaledTimeout(240_000)`) plus `skipIfUnmeasurable`. The one `storeDir` mention without
  `noStore` is the `:487` comment.

**Acceptance status:** box 1 (bounded by construction) — holds for the 12 scratch sites by the
per-site census, the two real-corpus sites are parse-capped and timeout-covered by design, and the
09-01 block's 67/0 whole-file run plus
today's 0-live-opens trace are the evidence; box 2 (whole file passes on THIS machine) — the 09-01
run says 67/0 but was not re-run today; boxes 3 (3-vs-6 explained), 4 (mutation), 5 (comment
updated) — OPEN. **NEXT ACTION:** when the detached MVR6PXC0 cargo run ends (it owns the CPU), run
the whole file ONCE on this machine (`npx mocha --no-config --require src/test/setup.js --ui tdd
out/test/test/cacheBreakTimeline.test.js`, capture to a file) for box 2 and to see whether the
3-vs-6 shape still exists post-fix (box 3 may be moot: if the unbounded read was the ONLY cause, the
order dependence was the live store's size changing between invocations — state that as the
explanation only if the whole-file and `--grep` runs now agree); then box 4 (drop `hookEventsDir:
noStore` from ONE of the 12 sites, the case must go red under a live store, restore) and box 5 (the
`:485-490` comment gets the `hookEventsDir` half of the story). Then `dev → testing → ai_review`.

## STATE (history) — 2026-08-29

**AI-REVIEW VERDICT 2026-09-05 — REJECTED back to `dev`.** All five acceptance boxes are open and
the bug itself is unfixed: this is an open investigation, not something with a finished change to
review. Nothing was reviewed and nothing is being claimed about the diagnosis below, which still
stands on its own measurements. The card was simply in a column that asserts work I could not
find. NEXT ACTION is unchanged — the investigation in this block.

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
2026-10-16: moved to todo by the board triage (row 26). What remains: Whole-file pass, run-order explanation, mutation check and comment update: none ticked. Commit 3e767d69 puts part of the six failing suite tests here (the rest on CS2W7E77).

## STATE (history) — 2026-09-01 — FIX LANDED, verification pending (folded into the top block on 09-05)

Root cause found and fixed in `aef94208`: 12 fixture calls passed `storeDir: noStore` but not
`hookEventsDir`, so `loadCompactionHookInfo` (cacheBreakTimeline.ts:1369/1718) scanned the LIVE
229MB `~/.agentlens/hook-events` synchronously inside mocha's fixed timeout — load-dependent by
construction. All 12 sites now pass `hookEventsDir: noStore`. NOT a timeout raise.
Analysis: reports/cachebreak-flake/20260901_195900+0200-load-dependence-analysis.md.
VERIFIED 2026-09-01: compile-tests 0; cacheBreakTimeline.test.js alone = 67 passing / 0 failing,
exit 0, INCLUDING the real-corpus cost-peak test that was the full-suite run's one red (that run
used the pre-fix out/ and ran under a deliberate load storm). → ai_review.

## Approval log

- 2026-10-16T11:13:11+0200 — column → todo by main-agent@agentlenspro. work stalled mid-way or never started; no one works it now; triage row 26
