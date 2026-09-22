---
trdd-id: D7MCI7OA
title: review-supervisor runner test fails since the 2026-09-15 gate changes -- possible false no-review-fork nags
column: todo
created: 2026-09-22T23:27:19+0200
updated: 2026-09-22T23:27:19+0200
current-owner: emanuelesabetta
created-by: emanuelesabetta
task-type: bugfix
min-approval-requirement: none
assignee: emanuelesabetta
mandate: true
mandated-by: none
approved: true
approval-judge: emanuelesabetta
approval-datetime: 2026-09-22T23:27:19+0200
---

# review-supervisor runner test fails since the 2026-09-15 gate changes -- possible false no-review-fork nags

src/test/reviewSupervisorRunner.test.ts test 'review-supervisor -- real CLI runner (end-to-end)' -> 'OK verdict: a fork after the changes and a registered gate produce exit 0 with EMPTY stdout' fails: its stdout carries a JSON warning containing the phrase 'with NO adversarial review fork after them'. Already failing before any edit this session (first measure run, 20 failures total in the suite). An earlier 'stale bundle' theory is REFUTED: the warning string IS present in the deployed bundle; the earlier grep mismatch was case-sensitive and missed it. Likely cause: the deployed review-supervisor (bundle built 2026-09-15 18:32, containing the TRDD-A37YM37G changes 268f3080..2c32a6ef) or its test broke together with those changes. Possible live effect: false 'no review fork' nags surfacing to users. Next: bisect which of the TRDD-A37YM37G commits (268f3080..2c32a6ef) changed the supervisor's OK-verdict path or the test's fixture, and fix the regression or update the test to match the new (correct) behavior.

## Approval log

- 2026-09-22T23:27:19+0200 — MANDATE issued by emanuelesabetta (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
