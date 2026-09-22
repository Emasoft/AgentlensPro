---
trdd-id: VESNWRL0
title: Review loop section C guards so an agent cannot switch the gate off
column: backburner
created: 2026-09-22T22:57:57+0200
updated: 2026-09-22T22:57:57+0200
current-owner: emanuelesabetta
created-by: emanuelesabetta
task-type: security
min-approval-requirement: none
assignee: emanuelesabetta
mandate: true
mandated-by: none
approved: true
approval-judge: emanuelesabetta
approval-datetime: 2026-09-22T22:57:57+0200
---

# Review loop section C guards so an agent cannot switch the gate off

Split out of TRDD-40M4UPK3 stage 1a on owner-default 2026-09-22 (loop core first; security is reactive-only in this project). Covers spec section C (C1-C5, loop-integrity guards checked before any allow rule) plus tests 23-26: C1 deny-listed paths (hooks, kill-switch, settings, janitor-control, ~/.claude/projects/** except memory/design, shell startup files), C2 settings post-state diff (disableAllHooks, off-switch env vars, dropped/shrunk hook registrations, added permissions.deny on Agent), C3 off-switch commands (agentlenspro disable/--hooks/launchctl setenv, window-gated --install-hooks/--install-otel/setup), C4 target extraction (redirects, fastedit/memgrep/trddgrep tables, file-verb positionals, payload-argument exclusion), C5 residual-comment items. Spec: reports/review-loop-gate/20260914_095303+0200-stage1a-loop-spec.md (section C, lines 57-63; tests 23-26 at line 69). Status: reports/review-loop-gate/20260922_120000+0200-stage1a-status.md (C1-C4 rows: MISSING/PARTIAL).

## Approval log

- 2026-09-22T22:57:57+0200 — MANDATE issued by emanuelesabetta (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
