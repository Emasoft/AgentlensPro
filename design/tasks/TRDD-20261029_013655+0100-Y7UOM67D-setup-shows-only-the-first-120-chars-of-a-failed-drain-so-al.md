---
trdd-id: Y7UOM67D
title: setup shows only the first 120 chars of a failed drain so alstore's reason never reaches the user
column: todo
status: tasked
created: 2026-10-29T01:36:55+0100
updated: 2026-10-29T01:37:00+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-29T01:36:55+0100
priority: medium
---

# setup shows only the first 120 chars of a failed drain so alstore's reason never reaches the user

src/cli/setup.ts line 646 shows drainErr.message.slice(0, 120). Node execFile builds that message as "Command failed: <full command line>" followed by stderr, and the command line with the store and bodies paths is longer than 120 characters, so alstore's own reason (exit 1/2/3/4 stderr) is cut away before the user sees it. Found by the review of TRDD-FINMFYDE. Direction: show the child's stderr separately (the execFile error .stderr), bounded in length.

## Acceptance criteria

- [ ] a failing alstore drain's stderr reason appears in setup output (test).
- [ ] the full message is still in the log.

## Approval log

- 2026-10-29T01:36:55+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
