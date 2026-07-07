---
trdd-id: UBEP5XY7
title: Tokens-by-cause attribution rollup — who (agent/skill/plugin/mcp/hook/user) spent the tokens
column: dev
created: 2026-07-07T13:30:49+0200
updated: 2026-07-08T00:20:00+0200
current-owner: null
assignee: null
priority: 3
severity: MEDIUM
effort: M
task-type: feature
parent-trdd: TRDD-TKN5VALS
approval-tier: 2
relevant-rules: []
release-via: none
target-branch: fix/logreader-large-jsonl
test-requirements: [typecheck, lint]
impacts: []
external-refs: [https://code.claude.com/docs/en/monitoring-usage]
---

# TRDD-UBEP5XY7 — Tokens-by-cause attribution rollup

## ⏵ STATE — APPROVED 2026-07-07 (USER: "go" after the P1-P6 evaluation) — queued for dispatch
Approval log: 2026-07-07T15:25:00+0200 — APPROVED by USER ("go"). Moved to design/tasks, column planned.

## Why
Since 7612ff5 every `claude_code.api_request` event carries its CAUSE (query_source, agent.name,
skill.name, plugin.name, mcp_server.name, mcp_tool.name) and per-call cost — ingested as
timeline entries and shown per-row (formatAttribution), but there is NO rollup. "Which
skill/plugin/subagent costs me the most?" still requires reading rows one by one.

## Spec
1. **Per-session rollup**: group api_request entries by cause dimension (querySource → agent →
   skill → plugin → mcp server/tool) and sum the 4 usage buckets + cost; render as a
   "Tokens by cause" ranked panel (per-dimension toggle) in the session view; each row filters
   the trace to its calls.
2. **Global leaderboard**: same aggregation across sessions (bounded window, honest coverage per
   TRDD-ZK37VG4X conventions) — "top causes this week" in the Analytics/Cache area.
3. **MCP**: `get_cost_by_cause(sessionId? , days?)` returning the rolled-up table for agent
   self-audit; complements find_context_hogs (which ranks CONTEXT sources, not per-call causes).
4. OTEL-only sessions fully supported (this is pure OTEL data — no jsonl required).

## Acceptance
- On a rich-telemetry session, the panel ranks causes whose bucket sums reconcile with the
  session totals (within the unattributed remainder, shown explicitly); the MCP tool returns the
  same numbers. check-types+lint+esbuild clean; headless proof.
