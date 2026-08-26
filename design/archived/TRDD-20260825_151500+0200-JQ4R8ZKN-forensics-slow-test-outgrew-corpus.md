---
trdd-id: JQ4R8ZKN
title: The forensicsIndex real-machine slow test has outgrown its 180s ceiling
column: complete
created: 2026-08-25T15:15:00+0200
updated: 2026-08-26T20:55:00+0200
current-owner: main
task-type: bugfix
severity: LOW
priority: 4
labels: [tests, flaky, slow-test]
min-approval-requirement: none
relevant-files: [src/test/forensicsIndex.test.ts]
---

# The forensicsIndex 🐌 real-machine test times out under ordinary load

## Measured 2026-08-25

`FAL Phase 1 — 🐌 real machine data / indexApiCalls over the real ~/.agentlens degrades honestly
whether or not bodies exist` hit its **180s timeout in 3 of 4 full-suite runs** today, and passed
only in the one run executed with the machine otherwise idle. The failure is a timeout, not an
assertion: the test scans the LIVE `~/.agentlens` corpus, whose size grows daily (5.5M spans,
240k+ events at last count), so its runtime is unbounded by construction and its fixed ceiling
has been outgrown.

Not caused by any code change — the diff in flight touched burnInvestigator/burnGuard/store
repair paths with no import path into forensicsIndex (verified via its import list).

## Why it matters

`.mocharc` pulls this spec into every mocha invocation, including `publish.yml`'s pre-publish
gate context — a test whose pass/fail depends on machine load and corpus size makes the whole
suite's green untrustworthy exactly where it gates a release.

## Acceptance

- [x] The test either bounds its input (cap DISCLOSED in the assertion message), or moves behind
      an explicit opt-in env var, or gets a ceiling derived from corpus size rather than a
      constant. ATTEMPTED 2026-08-26 (ceiling derived from spool entry count, floor 180s /
      cap 600s, `src/test/forensicsIndex.test.ts` — one scoped run passed in 2.6s) and then
      REFUTED by review before it could count as done: the bodies spool held the SAME ~1045
      entries during yesterday's 3/4 timeouts, so the derivation evaluates to exactly the old
      180s floor under the exact condition that failed — the multiplier only exceeds the floor
      past 36,000 entries, dead code today. The 2.6s-scoped vs >180s-in-suite spread (70×, same
      corpus) points at FULL-SUITE context (shared-process state, disk contention, mocha
      ordering), not corpus size — and the card's own blame line names the forensics evidence
      base (5.5M spans), a different corpus than the spool the fix measures. The diff stays in
      tree — harmless today, adds headroom only for a grown corpus — but box 2's suite runs are
      the decider; the pre-planned fallback
      on refutation is the OPT-IN ENV GATE variant, chosen now so a box-2 failure converts
      directly instead of re-litigating.

      **RESOLVED 2026-08-26 — box 2 passed, so the fallback is NOT taken.** The card's own rule was
      that box 2's suite runs are the decider; they came back 4/4 clean with 0 timeouts, so the
      opt-in env gate is not needed and adding it would gate a test that is not failing. The
      derived ceiling stays in tree as headroom (`fa9472a`) with its limits recorded above — it is
      satisfied as written ("a ceiling derived from corpus size rather than a constant"), while the
      note in box 2 keeps the record straight that it is not what made the runs pass. Closing this
      as the option that was actually exercised, rather than backfilling a justification for it.
- [x] ≥4 consecutive full-suite runs under ordinary load with the test enabled: 0 timeouts.
      **DONE 2026-08-26.** Four consecutive `npx mocha` runs, test enabled, machine under
      ordinary load: `2482 passing / 0 failing / 8 pending / 0 timeouts` — identical four times.
      (A first attempt at this box reached 3 clean runs and broke on the 4th with 2 failures — NOT
      timeouts: an unrelated port-reuse race in the OtlpCollector specs, fixed in `43540bc` and
      stress-verified 0/200 after being reproduced 1/200 before. The four runs above are all
      post-fix, because a streak that includes the run you then fixed is not a streak.)

      **WHAT ACTUALLY CHANGED, stated honestly: probably not this card's diff.** Review had already
      refuted the derived ceiling as inert here — it evaluates to exactly the old 180 s floor below
      36,000 spool entries, and the spool held ~1045. So these four clean runs happened with that
      code dead. What DID change between the 3/4-timeout measurement and now is the machine: the
      timeouts were measured around 05:21 on 2026-08-26, while a runaway `store repair-parked` had
      been consuming 230-880% CPU continuously since 04:23 (TRDD-8TM7I49X — it ran 12h38m and was
      ~0.5% done). That process is gone. A 70x spread between the same test scoped (2.6 s) and
      in-suite (>180 s) on an unchanged corpus always pointed at contention rather than size, and
      this is the contention it pointed at.
      Correlation, not proof — nobody re-ran the suite under a deliberately loaded machine to close
      it. But it is a better-supported account than "the corpus grew", and it means the ceiling
      this card set is headroom for later, not the fix.
- [x] Whatever changes preserves what the test PROVES (honest degradation with and without
      bodies) — do not delete the claim to fix the clock. **PRESERVED.** The test still asserts
      the same things it did before: `dbAvailable === true`, `responseFilesTotal >= 0`, zero
      malformed rows, and a non-empty forensics DB path — with and without bodies present
      (`src/test/forensicsIndex.test.ts:465-503`). Nothing was weakened, skipped, or deleted; the
      only change was to the ceiling it is allowed to take, and per box 2 that ceiling was not
      even the operative constraint.
