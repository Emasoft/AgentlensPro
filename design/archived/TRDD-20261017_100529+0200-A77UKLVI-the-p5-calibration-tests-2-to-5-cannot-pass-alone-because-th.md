---
trdd-id: A77UKLVI
title: The P5 calibration tests 2 to 5 cannot pass alone because they read the config file test 1 writes
column: complete
status: archived
created: 2026-10-17T10:05:29+0200
updated: 2026-10-17T10:32:15+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-17T10:05:29+0200
project-id: agentlenspro
implementation-commits: [c65252c3]
---

# The P5 calibration tests 2 to 5 cannot pass alone because they read the config file test 1 writes

## Symptom

In src/test/serverCalibration.test.ts, tests 2 to 5 of the suite "standalone server — P5 window auto-calibration" read burn-config.json through observedOf, which throws ENOENT when the file does not exist. Only the stall in test 1 writes that file. So tests 3 to 5, which assert that calibration does NOT happen (a state in which no file need exist), cannot pass when run alone (mocha --grep) or in another order. Seen 2026-10-17: with test 1 broken by a mutation, all four failed on ENOENT before reaching their own assertions (docs_dev/20261017-cs2w7e77-mutation-report.md, gitignored scratch).

## Correction for archived TRDD-CS2W7E77 (the tool refuses writes to archived cards)

The first line of its section "Closing evidence 2026-10-17" overstates two things. (1) Tests 2 to 5 are order-dependent cascades of test 1 through the shared suite state, not independent evidence of one cause; the single root cause is the missing account window in test 1. (2) Which alcore the suite booted was read from the source of alcoreTestBin in src/test/helpers/freePort.ts (out/rust-core and out/bin-native do not exist, so the first executable candidate is rust-core/target/release/alcore, built from HEAD); it was not observed in a runtime log. Also: the baseline ran at a 1-minute load of 14 to 15 and the mutant at 18 to 22, and the mutant failure signature matches the one recorded on 2026-09-04. The card's verdict is unaffected.
The same source-read caveat applies to box 2 of TRDD-CS2W7E77 ("all five pass against alcore built from HEAD"): the binary was selected by alcoreTestBin's candidate order, read from source, not observed in a runtime log.

## Acceptance

- [x] Each of tests 2 to 5 passes when run alone with --grep, against alcore built from HEAD.
- [x] Tests 3 to 5 treat a missing burn-config.json as no observed capacity, or set up their own precondition, without weakening what each asserts.
- [x] With test 1 broken by a mutation, tests 3 to 5 report their own result rather than ENOENT.

## Notes and lessons learned

## Approval log

- 2026-10-17T10:05:29+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-17T10:31:27+0200 — column → ai_review by main-agent@agentlenspro. implemented in c65252c3 and verified by runs and three mutations; the main agent reviews it next under the owner order of 2026-10-05
- 2026-10-17T10:32:15+0200 — COMPLETE by main-agent@agentlenspro. reviewed: c65252c3 verified by 3 full-suite runs, 4 stand-alone runs and three mutations (logs checked by the main agent), adversarial review kept it; closed under the owner order of 2026-10-05.

## Implementation evidence 2026-10-17

Commit c65252c3 (src/test/serverCalibration.test.ts only): tests 2 to 5 each use their own account and session with a clean 300k window, wait until /api/burn-status shows that consumption before the stall, and assert only on output their own stall produced (log searched from a mark taken before the stall, polled up to 2 s). Test 2 seeds a real observation written by alcore, raises only window5hTokens, stalls again, and asserts the figure is kept and observedAt unchanged. Test 5 restores the prior config bytes in a finally. Test 1 unchanged.
Runs at HEAD 1efc0d24, alcore built from HEAD at rust-core/target/release (sha256 b77e6b7897f03ccd892eb56db366b31de21a954a7a6e66b27f49c3b7822f57ce), AGENTLENS_ALCORE unset: full suite 3 of 3 runs with 5 passing; each of tests 2 to 5 alone (--grep "second replay with LOWER consumption", "natural 5h window rollover", "non-rate-limit StopFailure", "user-configured capacity is never overwritten") 1 passing.
Mutations, each undone: test 1 broken (first assert.ok inverted) gives 4 passing, 1 failing, tests 2 to 5 report their own results with no ENOENT; test 4 with a rate-limit-class fixture fails; test 2 without the raise to 9_999_999_999 fails (300000 vs 9999999999). tsc and eslint exit 0. Logs: docs_dev/a77-*.log, report docs_dev/20261017-a77uklvi-impl-report.md (gitignored scratch).
Review of c65252c3 (2026-10-17, adversarial fork): keep. Correction to the commit message: tests 4 and 5 asserted on an account with nothing to calibrate only when run outside suite order (in suite order they stalled on sess-cal-a, which carried test 1's consumption), and test 5 asserts the user-configured veto, not "does not calibrate". Residual coupling: tests 4 and 5 still read the config file earlier tests leave behind (test 4 compares whole-file bytes against it; test 5 restores it in a finally). Flake watch: logLineSince is bounded at 2 s; if tests 3 or 5 ever fail on it under heavy load, lengthen the bound to 5 s rather than drop the check.
