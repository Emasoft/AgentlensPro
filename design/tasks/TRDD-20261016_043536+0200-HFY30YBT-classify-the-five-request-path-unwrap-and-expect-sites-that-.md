---
trdd-id: HFY30YBT
title: Classify the five request-path unwrap and expect sites that exit-on-panic turns into a client-triggered collector kill
column: todo
status: tasked
created: 2026-10-16T04:35:36+0200
updated: 2026-10-16T04:40:03+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-16T04:35:36+0200
project-id: agentlenspro
---

# Classify the five request-path unwrap and expect sites that exit-on-panic turns into a client-triggered collector kill

TRDD-3RVTC1HY (542ceca2) makes every panic exit alcore, so an unwrap or expect a client request can reach now kills the collector. Five non-test sites are UNCLASSIFIED (docs_dev/20261016-3rvtc1hy-impl-report.md, Residual survey): ui.rs:1192, mcp.rs:32, mcp_tools.rs:683 (win.unwrap), mcp_tools.rs:2313 (parent_arg.unwrap in format), mcp_tools.rs:3263 (threshold_ms.unwrap). For each: can client input reach it (trace from the HTTP/MCP handler); if yes, replace the panic with an error response and add a test that sends that input. Acceptance: each site classified with file:line evidence; every reachable one fixed and tested.

## Approval log

- 2026-10-16T04:35:36+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Notes and lessons learned

Line numbers are as of commit 542ceca2: ui.rs:1192 in substitute_tokens, mcp.rs:32 in tools, mcp_tools.rs:683 in get_account_status, mcp_tools.rs:2313 in get_agent_tokens, mcp_tools.rs:3263 in assess_cache_expiry.
