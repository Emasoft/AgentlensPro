---
trdd-id: Z228SAC7
title: Generators that require plain out/ read a stale build with no script to refresh it
column: todo
status: tasked
created: 2026-09-25T00:09:31+0200
updated: 2026-09-25T00:09:38+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-09-25T00:09:31+0200
---

# Generators that require plain out/ read a stale build with no script to refresh it

gen-burnscan-expected.mjs requires ../out/burnInvestigator.js, the plain out/ tree from tsconfig.json. compile-tests only builds out/test/, check-types emits nothing, and no npm script rebuilds out/, which was last built 2026-09-22. A regeneration therefore read pre-fbaae7d0 code and produced false fixture drift.

Evidence: reports/cc-alignment/20260924_234354+0200-I9b2-main-verify.md, "Correction" section.

## Approval log

- 2026-09-25T00:09:31+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## STATE

Next action: list every generator under rust-core/crates/agentlens-core/tests/fixtures/ that requires ../out/ rather than ../out/test/, then either repoint each to the compiled test output or add one npm script that builds plain out/ before fixture regeneration. — 2026-09-25
