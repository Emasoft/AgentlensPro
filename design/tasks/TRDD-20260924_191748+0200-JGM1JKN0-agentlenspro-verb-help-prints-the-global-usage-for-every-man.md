---
trdd-id: JGM1JKN0
title: agentlenspro <verb> --help prints the global usage for every management verb
column: backburner
status: tasked
created: 2026-09-24T19:17:48+0200
updated: 2026-09-24T19:17:48+0200
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
---

# agentlenspro <verb> --help prints the global usage for every management verb

agentlenspro <verb> --help currently prints tool-specific help only; for a management verb (setup, server, list, etc.) followed by --help it should print the global usage block instead. Fix: intercept in src/cli/main.ts MANAGEMENT_VERBS list before falling through to tool-schema help. Evidence: reports/cc-alignment/20260924_181819+0200-I15-polish.md.

## Approval log

- 2026-09-24T19:17:48+0200 — MANDATE issued by emanuelesabetta (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
