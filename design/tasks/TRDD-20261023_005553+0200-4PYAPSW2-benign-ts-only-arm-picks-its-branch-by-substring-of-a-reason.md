---
trdd-id: 4PYAPSW2
title: Benign ts-only arm picks its branch by substring of a reason string that embeds the file name
column: todo
status: tasked
created: 2026-10-23T00:55:53+0200
updated: 2026-10-23T00:55:53+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-23T00:55:53+0200
---

# Benign ts-only arm picks its branch by substring of a reason string that embeds the file name

pass.rs:611 chooses the benign ts-only unlink arm with reason.contains("stored ts ") && reason.contains("!= capture time"), but every reason begins with the file name (lib.rs:1386, 1404, 1413). A file whose name contains both substrings and whose body the store does not hold would get an unknown-body reason, match the test, pass the content check and be unlinked at pass.rs:625 (R2 §1.4, not reproduced, needs a crafted name). Fix: return a typed verify result instead of a string. Found during TRDD-2HRA270Y.

## Approval log

- 2026-10-23T00:55:53+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
