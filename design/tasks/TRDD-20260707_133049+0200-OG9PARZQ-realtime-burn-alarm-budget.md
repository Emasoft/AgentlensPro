---
trdd-id: OG9PARZQ
title: Realtime burn-rate alarm + rate-limit window budget — smoke detector, not just microscope
column: dev
created: 2026-07-07T13:30:49+0200
updated: 2026-07-07T15:10:00+0200
current-owner: null
assignee: null
priority: 1
severity: HIGH
effort: L
task-type: feature
parent-trdd: TRDD-TKN5VALS
approval-tier: 2
relevant-rules: []
release-via: none
target-branch: fix/logreader-large-jsonl
test-requirements: [typecheck, lint]
impacts: []
external-refs: []
---

# TRDD-OG9PARZQ — Realtime burn-rate alarm + window budget

## ⏵ STATE — PROPOSAL (awaiting USER evaluation)

## Why (the gap, verified 2026-07-07)
AgentLens is now an excellent POST-MORTEM microscope (History diffs, cache-break causes,
per-call context trees) — but the founding incident ("a single session consumed all tokens
in a minute; four agents failed") would STILL produce no proactive signal today. The user
learns of a burn from the provider's rate-limit wall, not from AgentLens. Nothing models
the subscription rate-limit window, so "how close am I to exhaustion?" is unanswerable.

## Spec
1. **Burn-rate series**: rolling tokens/min and $/min, per session and global, computed in the
   standalone server from live OTEL `api_request` events + jsonl tail (both already ingested).
2. **Window budget model**: track consumption inside the Claude subscription windows (5h rolling
   + weekly), fed by exact statusline usage (KT87QPM0) + api_request costs; show % consumed and a
   time-to-exhaustion PROJECTION at the current burn rate. Window capacity is user-configurable
   (plans differ); default from observed historical resets.
3. **Alerts**: threshold rules (tokens/min, $/hr, %window, single-call cache-create ≥N) →
   dashboard banner + Alerts-tab entry + SSE push; optional macOS notification (osascript,
   opt-in env). Each alert names the SESSION and the CAUSE (dominant attribution from
   api_request: agent/skill/fleet-spawn/compaction).
4. **MCP tool** `get_burn_status()`: current burn rate, window %, projection, active alerts —
   so agents can self-throttle.
5. **Agent-facing self-serve tool** `get_session_status(sessionId? , workspace?)` (added on
   approval 2026-07-07 — the fleet's Claudes asked for exactly this): one call returning, for
   the caller's session (resolve by sessionId, else newest live session under workspace):
   current context usage + peak, the 4 usage buckets + avg 5 values, cache hit rate, last LLM
   call cost, session-total cost, tokens/min rate, remaining 5h + 7d window %, and a compact
   comparison to the caller's previous sessions (same workspace): cost/turns/cache-hit deltas.
   Context diff/composition stay in the existing get_context_history/get_context_composition
   tools — reference them in the tool description so agents discover the drill path.

## Approval log
- 2026-07-07T15:10:00+0200 — APPROVED (USER demand relayed 2026-07-07: "the other projects
  claudes are asking if they can use the mcp of agentlens to get detailed info on the token
  usage of their sessions … remaining 5h and 7d window percentage, token usage rate per
  minute, cache hit rate, average 5 values, last peak tokens usage, costs of last llm call,
  cost since the beginning of the session, comparison to previous sessions, context diff,
  context composition"). Moved to design/tasks, column dev, dispatched.

## Acceptance
- A synthetic firehose session (replayed fixture) triggers the banner + alert within ≤10s,
  naming session + cause; window % and projection visible on the dashboard; opt-in macOS
  notification fires. check-types+lint+esbuild clean; headless proof.
