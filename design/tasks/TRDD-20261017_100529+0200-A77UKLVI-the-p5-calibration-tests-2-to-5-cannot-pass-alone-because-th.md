---
trdd-id: A77UKLVI
title: The P5 calibration tests 2 to 5 cannot pass alone because they read the config file test 1 writes
column: todo
status: tasked
created: 2026-10-17T10:05:29+0200
updated: 2026-10-17T10:07:31+0200
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
---

# The P5 calibration tests 2 to 5 cannot pass alone because they read the config file test 1 writes

## Symptom

In src/test/serverCalibration.test.ts, tests 2 to 5 of the suite "standalone server — P5 window auto-calibration" read burn-config.json through observedOf, which throws ENOENT when the file does not exist. Only the stall in test 1 writes that file. So tests 3 to 5, which assert that calibration does NOT happen (a state in which no file need exist), cannot pass when run alone (mocha --grep) or in another order. Seen 2026-10-17: with test 1 broken by a mutation, all four failed on ENOENT before reaching their own assertions (docs_dev/20261017-cs2w7e77-mutation-report.md, gitignored scratch).

## Correction for archived TRDD-CS2W7E77 (the tool refuses writes to archived cards)

The first line of its section "Closing evidence 2026-10-17" overstates two things. (1) Tests 2 to 5 are order-dependent cascades of test 1 through the shared suite state, not independent evidence of one cause; the single root cause is the missing account window in test 1. (2) Which alcore the suite booted was read from the source of alcoreTestBin in src/test/helpers/freePort.ts (out/rust-core and out/bin-native do not exist, so the first executable candidate is rust-core/target/release/alcore, built from HEAD); it was not observed in a runtime log. Also: the baseline ran at a 1-minute load of 14 to 15 and the mutant at 18 to 22, and the mutant failure signature matches the one recorded on 2026-09-04. The card's verdict is unaffected.
The same source-read caveat applies to box 2 of TRDD-CS2W7E77 ("all five pass against alcore built from HEAD"): the binary was selected by alcoreTestBin's candidate order, read from source, not observed in a runtime log.

## Acceptance

- [ ] Each of tests 2 to 5 passes when run alone with --grep, against alcore built from HEAD.
- [ ] Tests 3 to 5 treat a missing burn-config.json as no observed capacity, or set up their own precondition, without weakening what each asserts.
- [ ] With test 1 broken by a mutation, tests 3 to 5 report their own result rather than ENOENT.

## Notes and lessons learned

## Approval log

- 2026-10-17T10:05:29+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
