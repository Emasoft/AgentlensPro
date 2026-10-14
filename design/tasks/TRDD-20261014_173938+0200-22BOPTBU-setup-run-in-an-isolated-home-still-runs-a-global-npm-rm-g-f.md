---
trdd-id: 22BOPTBU
title: setup run in an isolated HOME still runs a global npm rm -g for the old package
column: todo
status: tasked
created: 2026-10-14T17:39:38+0200
updated: 2026-10-14T17:39:53+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-14T17:39:38+0200
---

# setup run in an isolated HOME still runs a global npm rm -g for the old package

## Approval log

- 2026-10-14T17:39:38+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Problem

2026-10-14, found by the review of 857cc34a: `agentlenspro setup --yes` includes an old-package step that runs a GLOBAL `npm rm -g` (for the retired agentlens-dashboard package). Isolated instances (own HOME + DATA_DIR, the recipe CLAUDE.md documents and the 3c measurement used) and any test that runs setup in a fake HOME therefore reach outside their sandbox on a real machine. In the 3c run it was a no-op only because the worker first checked the old package was absent.
Fix candidates: skip the old-package step when HOME is not the real user home (or when DATA_DIR/HOME are overridden), or require an explicit flag; add a test that setup in a fixture HOME never spawns npm; add a warning to CLAUDE.md's isolated-instance recipe. Verify first which tests run setup --yes and whether any reaches the npm step (grep the old-package step's function name in src/cli/setup.ts and its callers).
Related: TRDD-YL3EWT6N (self-heal), where the hazard was found.
