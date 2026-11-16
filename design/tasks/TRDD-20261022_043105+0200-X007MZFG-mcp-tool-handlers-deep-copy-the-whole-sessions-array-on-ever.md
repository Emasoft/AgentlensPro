---
trdd-id: X007MZFG
title: MCP tool handlers deep-copy the whole sessions array on every call
column: todo
status: tasked
created: 2026-10-22T04:31:05+0200
updated: 2026-10-22T04:31:05+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-22T04:31:05+0200
---

# MCP tool handlers deep-copy the whole sessions array on every call

About 18 MCP handlers in rust-core/crates/agentlens-core/src/ui.rs take the summary Arc and then `.get("sessions")...cloned()` into an owned Vec of every session (examples: get_cost_by_cause ui.rs:2413-2425, get_agent_tokens :2448-2460, get_subagent_tree :2589-2594, get_cost_rollup :2640-2645, get_window_eta :3460-3492, get_account_burners :3511-3550, get_cache_break_report :3651-3678). Each call is a transient deep copy of the whole corpus summary (41k sessions on the live collector), and a memory spike under the RSS guard. Fix: pass borrowed slices (&[Value]) into the mcp_tools.rs shapers, since the Arc is already held. Distinct from TRDD-REKYAXKP (take_sessions) and TRDD-MBQ9LXAN (SSE re-strip). Evidence: docs_dev/20261022-summary-cache-map.md section 1.3. NEXT ACTION: list every .cloned() site with file:line, and check whether each shaper signature can take a slice.

## Approval log

- 2026-10-22T04:31:05+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
