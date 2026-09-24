---
trdd-id: 2CV1KNHS
title: gen-update-payload-expected.mjs requires src/updatePayload.ts, which does not exist
column: backburner
created: 2026-09-24T11:04:38+0200
updated: 2026-09-24T11:11:24+0200
current-owner: emanuelesabetta
created-by: emanuelesabetta
task-type: bugfix
min-approval-requirement: none
assignee: emanuelesabetta
mandate: false
mandated-by: none
approved: false
approval-judge: emanuelesabetta
approval-datetime: 2026-09-24T11:04:38+0200
---

# gen-update-payload-expected.mjs requires src/updatePayload.ts, which does not exist

rust-core's fixture generator gen-update-payload-expected.mjs references a nonexistent file, src/updatePayload.ts. Found incidentally while establishing the LIVE fixture-generator root set for TRDD-4BZPAQWM (dead-module-set.md, Section 2 — the 46-generator LIVE-root list and its cross-check against the 33-file DEAD set). Independent of TRDD-4BZPAQWM's scope; flagged there for a human, not fixed. Evidence: reports/4BZPAQWM/20260924_104703+0200-dead-module-set.md.

## Approval log

- 2026-09-24T11:04:38+0200 — MANDATE issued by emanuelesabetta (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
2026-09-24T11:11:23+0200 — CORRECTION: the MANDATE line above was stamped by trddgrep from the OS account (TRDD-FK4AXP7M); no owner mandated or approved this card; an agent created it during TRDD-4BZPAQWM.
