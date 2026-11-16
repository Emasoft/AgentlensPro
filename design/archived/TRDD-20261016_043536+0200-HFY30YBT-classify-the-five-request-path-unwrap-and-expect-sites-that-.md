---
trdd-id: HFY30YBT
title: Classify the five request-path unwrap and expect sites that exit-on-panic turns into a client-triggered collector kill
column: complete
status: archived
created: 2026-10-16T04:35:36+0200
updated: 2026-10-16T09:23:04+0200
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
- 2026-10-16T09:21:44+0200 — column → dev by main-agent@agentlenspro. pulled: the last open EHT of 3RVTC1HY, which waits in testing
- 2026-10-16T09:23:04+0200 — COMPLETE by main-agent@agentlenspro. all five sites classified unreachable by client input; no code change.

## Notes and lessons learned

Line numbers are as of commit 542ceca2: ui.rs:1192 in substitute_tokens, mcp.rs:32 in tools, mcp_tools.rs:683 in get_account_status, mcp_tools.rs:2313 in get_agent_tokens, mcp_tools.rs:3263 in assess_cache_expiry.
2026-10-16: acceptance: each site classified with file and function evidence above; no site is reachable, so there is nothing to fix or test.
2026-10-16: classification (main agent, by reading each site at 4ebb9196): none of the five is reachable as a panic by client input, so no code change. (a) ui.rs substitute_tokens: Regex::new of the constant pattern @@[A-Z_]+@@ inside a OnceLock init; it cannot fail for any input. (b) mcp.rs tools: parses the include_str! asset assets/mcp-tools.json once; input-independent, and tests/ui.rs:1601 (tools/list served verbatim) fails the build on a malformed asset. (c) mcp_tools.rs get_account_status win.unwrap(): in an else-if chain directly after the win.is_none() branch, so win is Some there. (d) mcp_tools.rs get_agent_tokens parent_arg.unwrap(): inside if let Some(p) = parent_arg, so it is Some. (e) mcp_tools.rs assess_cache_expiry threshold_ms.unwrap(): only when override_ = threshold_ms.is_some_and(|t| t > 0.0) is true.

## Acceptance

- [x] each of the five sites classified with file:line and function evidence (see Notes and lessons learned); no site is reachable by client input, so none needed a fix or test
