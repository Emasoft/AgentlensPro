---
trdd-id: 12FGMAEP
title: No whole-process memory ceiling once the RSS cap keys on mimalloc commit
column: todo
status: tasked
created: 2026-10-22T19:35:30+0200
updated: 2026-10-22T19:39:50+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-22T19:35:30+0200
parent-trdd: 
unblock-when: [decision:owner gives the whole-process backstop value or records a waiver]
---

# No whole-process memory ceiling once the RSS cap keys on mimalloc commit

Step 4 of TRDD-2HRA270Y moves the hard cap from phys_footprint to mimalloc committed bytes (owner 2026-10-22, DuckDB may exceed 2 GB). DuckDB allocates through system malloc and was measured overrunning its own memory_limit (512MB limit gave 1150 MiB RSS; 1536MB gave 2497 MiB). With the cap on commit, a DuckDB runaway grows until jetsam kills the process and leaves no culprit log. Needed: a footprint backstop well above 2 GB that writes the same culprit log (or a logged warning threshold). The threshold value is the owner's call; record it here when given. Review finding from the step-4 adversarial review, 2026-10-22.

## Approval log

- 2026-10-22T19:35:30+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
2026-10-22 review-2 notes: the RSS figures above are whole-process RSS (the 512MB figure was a Python host running DuckDB), not an isolated DuckDB measurement; the jetsam-with-no-log outcome is inferred, not observed. The session summary records an earlier owner answer on a 6 GB cap question; the search for it is incomplete (this session's transcript and the cards were grepped; the only 6 GB cap hits are archived 2026-08 cards 34B9JAZK and QK3L5QAS, a different context), so find it before choosing the backstop value. Moved to todo: this gates the 2HRA270Y deploy.
