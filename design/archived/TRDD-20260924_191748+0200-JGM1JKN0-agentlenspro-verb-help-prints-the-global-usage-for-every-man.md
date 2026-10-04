---
trdd-id: JGM1JKN0
title: agentlenspro <verb> --help prints the global usage for every management verb
column: complete
status: archived
created: 2026-09-24T19:17:48+0200
updated: 2026-10-04T12:51:18+0200
current-owner: emanuelesabetta
created-by: emanuelesabetta
task-type: bugfix
min-approval-requirement: none
assignee: emanuelesabetta
mandate: true
mandated-by: none
approved: true
approval-judge: emanuelesabetta
approval-datetime: 2026-09-24T19:17:48+0200
implementation-commits: [3e5521ca]
---

# agentlenspro <verb> --help prints the global usage for every management verb

agentlenspro <verb> --help currently prints tool-specific help only; for a management verb (setup, server, list, etc.) followed by --help it should print the global usage block instead. Fix: intercept in src/cli/main.ts MANAGEMENT_VERBS list before falling through to tool-schema help. Evidence: reports/cc-alignment/20260924_181819+0200-I15-polish.md.

## Approval log

- 2026-09-24T19:17:48+0200 — MANDATE issued by emanuelesabetta (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-04T12:51:18+0200 — COMPLETE by main-agent@agentlenspro. Owner directive 2026-10-04 "complete all TRDDs!". Independent verification docs_dev/20261004_123602+0200-close-verify-cv3.md, HEAD 8b9e9637: management verb --help test passes (8 passing, exit 0), setup/server/list --help print the global usage; the fix 3e5521ca predates the card; delivered..

## Acceptance

- [x] 1. a management verb with --help prints the global usage (verified: src/cli/main.ts ~175-182; test 'every management verb with --help exits 0, prints help, and leaves HOME untouched' passes, 8 passing; setup/server/list --help printed by hand; fix 3e5521ca; cv3 2026-10-04)
