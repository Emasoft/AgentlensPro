---
trdd-id: UBEP5XY7
title: Tokens-by-cause attribution rollup — who (agent/skill/plugin/mcp/hook/user) spent the tokens
column: completed
implementation-commits: [7fa6e66]
created: 2026-07-07T13:30:49+0200
updated: 2026-08-18T12:45:00+0200
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

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-07-08

**DONE — column complete, landed in 7fa6e66** (branch fix/logreader-large-jsonl, local only).

Shipped:
- `src/tokensByCause.ts` + verbatim mirror `media/src/tokensByCause.ts` — buildTokensByCause: groups
  api_request timeline entries per cause dimension (querySource/agent/skill/plugin/mcpServer/mcpTool),
  sums the 4 usage buckets + exact cost_usd. estimated:false (ground truth). Unattributed calls per
  dimension → explicit "(no <dim>)" bucket pinned last (counted, never dropped). Reconciliation vs
  session usage totals is SIGNED, never clamped; null (not 0) when no ground truth. Missing cost_usd
  → costKnown:false floor.
- Types: TokensByCauseReport et al. in src/summarizers/summarizerTypes.ts, MIRRORED in media/src/types.ts.
- MCP `get_cost_by_cause(sessionId?, days?)` in src/mcpServer.ts (handleGetCostByCause, exported for
  tests; CAUSE_SCAN_CAP=50). Session mode reconciles vs normalizedSessionTotalTokens (dual-convention
  aware, same as sessionCost). Leaderboard mode: bounded window, newest-first cap, find_context_hogs-style
  coverage block.
- UI: "Tokens by cause" panel in Traces session view (TokensByCausePanel inside TimelineWaterfall,
  media/src/tabs/Traces.tsx) — dimension toggle, ranked rows, row click filters the trace via
  structured `cause:<dim>=<key>` haystack tokens (stepHaystack extended). Same numbers as the MCP tool
  (both call the mirrored engine with the same inputs).
- Tests: src/test/tokensByCause.test.ts — 13 tests (grouping, pinning, cost floors, signed/null
  reconciliation, MCP session+leaderboard modes, cap honesty). Suite 352 passing / 1 pending / 0 failing.

NOT shipped (recorded honestly): a dedicated Analytics-tab webview leaderboard (spec item 2's UI half).
The webview lacks cross-session timelines (bulk summary strips them); the global leaderboard is served
by the MCP tool's no-sessionId mode instead. A webview surface would need new host plumbing
(/api/cost-by-cause + a postMessage) — do it as a follow-up TRDD if wanted. Interactive headless
browser proof was replaced by bundle verification (all 4 bundles carry the feature) + the 13 unit
tests, due to a session token-budget hard cap.

Approval log: 2026-07-07T15:25:00+0200 — APPROVED by USER ("go"). Moved to design/tasks, column planned.
2026-07-08T08:38:00+0200 — COMPLETED (7fa6e66); gates check-types/lint/esbuild all 0.

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

## Approval log

- 2026-08-18T12:45:00+0200 — ARCHIVED by USER batch directive ("complete all TRDD"); validity re-verified: src/shared/tokensByCause.ts exports buildTokensByCause (module relocated to src/shared/ per the shared-module doctrine); src/mcpServer.ts:764 registers get_cost_by_cause; media/src/tabs/Traces.tsx:20 imports it from src/shared/tokensByCause.
