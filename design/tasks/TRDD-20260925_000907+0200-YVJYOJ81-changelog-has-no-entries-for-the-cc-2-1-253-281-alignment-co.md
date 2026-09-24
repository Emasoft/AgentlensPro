---
trdd-id: YVJYOJ81
title: CHANGELOG has no entries for the CC 2.1.253-281 alignment commits
column: backburner
status: tasked
created: 2026-09-25T00:09:07+0200
updated: 2026-09-25T00:09:10+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: docs
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-09-25T00:09:07+0200
---

# CHANGELOG has no entries for the CC 2.1.253-281 alignment commits

Find the last commit that touched CHANGELOG.md (`git -C <repo> log -1 --format='%h %ad' -- CHANGELOG.md`) and list every later commit whose subject or body mentions TRDD-ZQQYRYBO, TRDD-ORGJ0E3G or TRDD-Z53IJFE9 (hash plus subject).

Known user-visible contract changes to name: meta.attachmentKind can no longer be "instructionsRule" (e02bb80a), and I6c2 (pending) adds a `ttlGapSource` field and an IDLE_TTL_PARTIAL_EXPIRY cause.

## Approval log

- 2026-09-25T00:09:07+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## STATE

Next action: run the git log query above, draft the CHANGELOG.md entries covering the alignment commits, and land them in one commit with the standard TRDD subject tag. — 2026-09-25
