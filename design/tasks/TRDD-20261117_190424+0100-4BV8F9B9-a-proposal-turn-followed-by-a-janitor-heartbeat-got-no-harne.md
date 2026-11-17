---
trdd-id: 4BV8F9B9
title: A proposal turn followed by a janitor heartbeat got no harness review
column: dev
status: tasked
created: 2026-11-17T19:04:24+0100
updated: 2026-11-17T20:18:08+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-17T19:04:24+0100
---

# A proposal turn followed by a janitor heartbeat got no harness review

## Problem
Seen twice on 2026-11-17 in the AgentlensPro session. A turn whose reply carried the exact line `PROPOSAL FOR ACTION - PLEASE REVIEW` (the clear-flag proposal of TRDD-PGMMB2QG, sent at about 18:39 and again at about 18:57) ended, and no harness review or measurement of that turn reached the main agent. The second time, the next prompt was a `[janitor-heartbeat]` fire, which is exempt from review; the prompt after it carried only the reviews of a subagent. Whether the first time had the same shape is not checked. INFERRED, not read in the mod code: the review of a turn is delivered with the next prompt, and an exempt next prompt drops it.

## Acceptance
- [ ] The delivery path of a turn review is read in agentlenspro-review-mod and the cause is stated with file and line.
- [ ] A reviewed turn followed by a janitor prompt still gets its review delivered (or the limit is documented where the proposer reads it).

## Approval log

- 2026-11-17T19:04:24+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-17T20:18:08+0100 — column → dev by main-agent@agentlenspro. read-only diagnosis handed to a worker (box 1)
