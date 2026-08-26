---
trdd-id: JQ4R8ZKN
title: The forensicsIndex real-machine slow test has outgrown its 180s ceiling
column: todo
created: 2026-08-25T15:15:00+0200
updated: 2026-08-26T05:21:00+0200
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

- [ ] The test either bounds its input (cap DISCLOSED in the assertion message), or moves behind
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
- [ ] ≥4 consecutive full-suite runs under ordinary load with the test enabled: 0 timeouts.
- [ ] Whatever changes preserves what the test PROVES (honest degradation with and without
      bodies) — do not delete the claim to fix the clock.
