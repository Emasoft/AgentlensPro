---
trdd-id: L2HVOB5K
title: compile-tests leaves compiled tests of deleted sources in out, and the mocha spec glob still runs them
column: todo
created: 2026-09-23T13:24:06+0200
updated: 2026-09-23T13:24:06+0200
current-owner: main-session
created-by: main-session
task-type: bugfix
min-approval-requirement: none
assignee: main-session
mandate: true
mandated-by: none
approved: true
approval-judge: main-session
approval-datetime: 2026-09-23T13:24:06+0200
---

# compile-tests leaves compiled tests of deleted sources in out, and the mocha spec glob still runs them

Evidence — out/test/test/reviewGateEffects.test.js (dated 2026-09-14) exists while src/test/reviewGateEffects.test.ts is gone; .mocharc.cjs spec out/test/test/**/*.test.js picks it up, so test counts include tests of deleted code (seen 2026-09-23 on TRDD-2CYTNLY1's owed run). Fix candidates: clean out/test before compile-tests, or have compile-tests delete out/ outputs with no source. related: [2CYTNLY1].

## Approval log

- 2026-09-23T13:24:06+0200 — MANDATE issued by main-session (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
