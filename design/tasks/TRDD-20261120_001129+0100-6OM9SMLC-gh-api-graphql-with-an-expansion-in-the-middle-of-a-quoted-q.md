---
trdd-id: 6OM9SMLC
title: gh api graphql with an expansion in the middle of a quoted query value is judged on its literal text and reads as a read
column: todo
status: tasked
created: 2026-11-20T00:11:29+0100
updated: 2026-11-20T00:11:29+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
scope: project
project-id: agentlenspro
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-20T00:11:29+0100
---

# gh api graphql with an expansion in the middle of a quoted query value is judged on its literal text and reads as a read

Split out of TRDD-1ZVRZGF1 on 2026-11-20T00:11:26+0100. ghApiIsMutating (src/cli/reviewGateTriggers.ts) sees the command text before the shell expands it. A quoted query value with an expansion mid-value (query="$Q { x }", query="$A$B") reaches queryText, holds no literal mutation word, and is classed a read, so a mutation inside the variable goes unreviewed (fail-open). Hiding every $ was rejected: parameterized GraphQL reads (query($o: String!)) in single quotes would then count as writes. Fix idea: have shellWords report whether a $ sat in single quotes (literal) or in double quotes or unquoted (an expansion), and hide the query only in the expansion case. Acceptance: a test row for each quoted mid-value form expects gh api (mutating); a single-quoted parameterized read stays a read.

## Approval log

- 2026-11-20T00:11:29+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
