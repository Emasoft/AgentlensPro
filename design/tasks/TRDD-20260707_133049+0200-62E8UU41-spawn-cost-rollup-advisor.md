---
trdd-id: 62E8UU41
title: Spawn-cost rollup + cache-friendly-spawn advisor — auto-detect the fleet-of-cold-forks burn
column: planned
created: 2026-07-07T13:30:49+0200
updated: 2026-07-07T15:25:00+0200
current-owner: null
assignee: null
priority: 2
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
external-refs: []
---

# TRDD-62E8UU41 — Spawn-cost rollup + spawn advisor

## ⏵ STATE — APPROVED 2026-07-07 (USER: "go" after the P1-P6 evaluation) — queued for dispatch
Approval log: 2026-07-07T15:25:00+0200 — APPROVED by USER ("go"). Moved to design/tasks, column planned.

## Why
The founding burn (fable-5 parent spawning a FLEET of children, each re-billing a multi-M-token
inherited prefix ⇒ millions of tokens/minute) was diagnosed MANUALLY across several tools.
AgentLens has the pieces (subagent tree, spawn-kind taxonomy, per-child usage, ⚠ SPAWN burn
badge) but no automatic AGGREGATE: nothing says "this ONE Agent/Workflow call caused N children
× M cache-create = X tokens / $Y — and here is the cheaper spawn shape."

## Spec
1. **Per-spawn rollup**: for each spawning tool call (Agent/Workflow/Task), aggregate across all
   its children: total cache-create, cache-read, output, cost; children count; spawn-kind mix
   (fresh/fork/worktree/model-override/fleet). Surface on the spawning step row in Traces
   (expandable) + a session-level "spawn cost" panel.
2. **Antipattern detector** (extends detectBurnEvents / the Alerts tab):
   - FLEET-COLD: ≥3 children each with cache-create ≥100k and near-zero cache-read → "N cold
     children re-billed the prefix; prefer forks (inherit parent cache) or trim the inherited context".
   - WORKTREE-SCATTER: children in worktree isolation (separate cache scope) doing cache-heavy work.
   - MODEL-MIX: children on a different model than parent (separate cache) with big prefixes.
   Each detection carries the aggregate waste (tokens + $) and a one-line remediation.
3. **MCP**: extend `get_subagent_tree` with the rollup + detections so agents can self-audit
   before fanning out.

## Acceptance
- On the real burn session (fable-5 fleet parent), the spawn rollup shows the fleet aggregate and
  the FLEET-COLD detection fires with the right order-of-magnitude waste; visible in Traces +
  Alerts + MCP. check-types+lint+esbuild clean; headless proof.
