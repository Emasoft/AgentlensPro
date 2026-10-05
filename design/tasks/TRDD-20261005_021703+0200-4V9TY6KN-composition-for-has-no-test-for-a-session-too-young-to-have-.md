---
trdd-id: 4V9TY6KN
title: composition_for has no test for a session too young to have a known project
column: todo
status: tasked
created: 2026-10-05T02:17:03+0200
updated: 2026-10-05T02:17:03+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-05T02:17:03+0200
---

# composition_for has no test for a session too young to have a known project

Follow-up of TRDD-UTFVMVT8 (accepted 2026-10-05). composition_for in rust-core/crates/agentlens-core/src/ui.rs skips caching an answer while the session's project is not yet known (the project_known guard), so a very young session fills its project later. That behaviour was only ever probed on the live collector (2026-09-05); no unit test pins it, so removing the guard would leave every test green. Done when a test builds a session with no project yet, calls composition_for, and asserts the answer is not cached and a later call fills the project; and a one-line mutation removing the guard turns it red.

## Approval log

- 2026-10-05T02:17:03+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
