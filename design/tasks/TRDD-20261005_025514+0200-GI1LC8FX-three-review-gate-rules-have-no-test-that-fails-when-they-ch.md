---
trdd-id: GI1LC8FX
title: Three review-gate rules have no test that fails when they change
column: todo
status: tasked
created: 2026-10-05T02:55:14+0200
updated: 2026-10-05T02:55:14+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-05T02:55:14+0200
---

# Three review-gate rules have no test that fails when they change

Found on 2026-10-05 by the reviews of TRDD-2CYTNLY1 and TRDD-0E3W5C45 (mutation sweep report docs_dev/20261005_025411+0200-sweep-0E3W5C45.md, gitignored). (1) mainBlockReason with a non-empty detail: replacing ARM_CAUSE_TEXT[cause] by ARM_CAUSE_TEXT.edit in src/cli/reviewGate.ts leaves all three gate suites green, so a write-shaped command or a proposal could be reported under the wrong cause. (2) The rule that a read-only Bash command does not arm is caught only by a reviewSupervisor test ("prose about committing is not a commit"); reviewGate.test and reviewGateTriggers.test stay green when the Bash branch is made to arm always. (3) The minimum length of 8 for a "no review possible" reason (reviewGateTriggers.ts, reason.length >= 8): the existing test asserts only that "rate-limited" passes and "ab" fails, which also holds with the old floor of 3; "foo" and the other entries of NO_REVIEW_SENTINEL_EXAMPLES are asserted nowhere. Done when each of the three has a test in the gate's own test files that goes red on its assertion under the mutation named here.

## Approval log

- 2026-10-05T02:55:14+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
