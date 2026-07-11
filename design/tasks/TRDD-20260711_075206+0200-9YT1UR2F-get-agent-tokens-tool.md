---
trdd-id: 9YT1UR2F
title: get_agent_tokens — exact per-agent token/cost query, CC-display reconcilable
column: dev
created: 2026-07-11T07:52:06+0200
updated: 2026-07-11T07:52:06+0200
current-owner: orchestrator-agentlenspro
assignee: agent-tokens-agent
priority: 2
severity: LOW
effort: S
labels: [diagnostics, mcp-tool, cli]
task-type: feature
release-via: publish
target-branch: main
feature-branch: feat/get-agent-tokens
merge-strategy: merge
must-pass-tests-before-merge: true
test-requirements: [unit, lint, typecheck]
implementation-commits: []
---

# get_agent_tokens — exact tokens/cost for ONE agent

## ⏵ STATE — READ THIS FIRST ON RESUME — 2026-07-11

- **Current state**: spec approved (USER order 2026-07-11: "does our tool have a command to
  get the exact tokens used by a given agent? if not, you should add it"). Implementation
  agent launching on feat/get-agent-tokens.
- **NEXT ACTION**: agent delivers; orchestrator verifies, deploys, ships in next release.

## Requirement

A direct tool answering "exactly what did agent X consume": `get_agent_tokens` (MCP tool +
`agentlenspro get_agent_tokens --agentId <id>` CLI path via the existing diagnostics
dispatch — no new subcommand plumbing needed, it rides the 36-tool surface).

## Design

- **Input**: `agentId` (accepts bare `a1b2…`, `agent-a1b2…`, or a full sessionId; resolve
  case-insensitively). Optional `parentSessionId` to disambiguate; error listing candidates
  on ambiguity (never guess silently).
- **Output** (all provenance-carrying, reusing existing card fields — no new accounting):
  - the FOUR disjoint buckets (input, output, cacheRead, cacheCreation) + totalTokens
    (non-cache-read convention, same as cards) — from the agent-* child card (P8 linkage);
  - `cost_usd` (weighted, same pricing tables), `model`, `spawnKind`, `warm`,
    `parentSessionId`, `spawnedByTurn`, `startedAt/lastSeenAt`, `turns` if derivable;
  - `ccDisplayEquivalent`: { lastTurnContextRead, cumulativeInputTokens } — the numbers
    comparable 1:1 with Claude Code's per-agent ↓ display (which shows live context-read,
    NOT billing) so users can reconcile the two views; document the mapping in the tool
    description;
  - `tokensSource` + `coverageNote` (log vs otel provenance, P7 fields).
- **Where**: same registry as the other 36 tools (src/mcpServer tool table + whatever the
  single-executable CLI dispatch reads); one implementation, no mirrors (anti-mirror guard
  applies).
- **Tests**: real-fs — build a fixture parent transcript + subagents/*.jsonl child, assert
  exact buckets round-trip; ambiguous-prefix error case; agent-/bare-id normalization;
  unknown id → clean error. Suite grows from 774/0, zero regressions.
- **Docs**: skill SKILL.md gains the tool (one line in the tool table + a "reconcile with
  CC's ↓ display" note); CHANGELOG minor entry (v2.1.0 — additive feature).

## Acceptance

- `agentlenspro get_agent_tokens --agentId <live-agent-id>` returns exact buckets matching
  `get_subagent_tree`'s entry for the same child (cross-tool consistency assertion in
  tests).
- Gates green (tsc root+media+test, eslint, check-no-mirrors, esbuild, mocha Node 20).
- Merged --no-ff, pushed; version 2.1.0 + CHANGELOG.

## Approval log

- 2026-07-11T07:52:06+0200 — USER ordered the capability in session ("if not, you should
  add it"); Tier 0 in-scope feature.
