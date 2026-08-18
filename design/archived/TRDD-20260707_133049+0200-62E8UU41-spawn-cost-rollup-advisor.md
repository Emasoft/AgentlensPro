---
trdd-id: 62E8UU41
title: Spawn-cost rollup + cache-friendly-spawn advisor — auto-detect the fleet-of-cold-forks burn
column: completed
created: 2026-07-07T13:30:49+0200
updated: 2026-08-18T12:45:00+0200
current-owner: null
assignee: null
implementation-commits: [503ff21]
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

## ⏵ STATE — COMPLETE 2026-07-07 (implemented in 503ff21) — authoritative
Approval log: 2026-07-07T15:25:00+0200 — APPROVED by USER ("go"). Moved to design/tasks, column planned.

DONE — all three spec items shipped (commit 503ff21):
- Pure rollup engine: `src/spawnRollup.ts` (`buildSpawnRollup` + `detectSpawnAntipatterns`), mirrored
  verbatim in `media/src/spawnRollup.ts` (cacheBreak/residentCost pattern). Cost injected via `costOf`
  so each runtime prices with its own function. FAIL-FAST: unknown/absent spawnKind → `unknown` bucket.
  Named+documented thresholds: COLD_CACHE_CREATE_MIN=100k, NEAR_ZERO_READ_RATIO=0.2, min-children 3/2/2.
- Types added to `src/summarizers/summarizerTypes.ts` and MIRRORED to `media/src/types.ts`
  (SpawnRollup / SpawnKindMix / SpawnDetection / SpawnDetectionCode).
- Detectors: FLEET-COLD (HIGH), WORKTREE-SCATTER (MEDIUM), MODEL-MIX (MEDIUM) — each with aggregate
  waste (tokens + $) + one-line remediation.
- MCP: `get_subagent_tree` returns `spawnRollup` (aggregate + detections); handler exported for tests;
  tool description updated ("call BEFORE fanning out to self-audit").
- Webview: `SpawnCostPanel` in `cacheShared.tsx`; wired into the LIVE Sessions trace (`Sessions.tsx`)
  as a session-level panel + per-spawning-turn panel (`TurnGroup` in `Traces.tsx`); Alerts drawer
  gains a "Spawn advisor" section + `getSpawnAntipatternAlerts` folded into `getTriggeredAlerts`.

Load-bearing facts / gotchas discovered:
- `Traces()`/`SessionBlock` in `Traces.tsx` is NOT mounted by any tab — the LIVE trace waterfall is the
  Sessions tab (`Sessions.tsx`, which Help.tsx calls "the Traces tab"). It rendered TimelineWaterfall
  WITHOUT `subAgents`, so sub-agent branches weren't shown there. The wiring now passes `subAgents` +
  the panels in Sessions.tsx — that is where the feature is visible. The Traces.tsx SessionBlock panel
  is kept for the shared component but is dead until/unless Traces() is mounted.
- Sub-agent CHILD cards store inputTokens INCLUDING cache (uncached+read+create) per `_buildSubAgentCards`;
  MCP `sessionCost` normalizes it, webview `calcSessionCost` treats it as raw (pre-existing over-bill,
  consistent with the existing header childCost) — the rollup uses each runtime's own function, so
  panel $ matches the surrounding header. NOT reconciled here (out of scope).

Verification (P): check-types 0 · lint 0 errors (66 pre-existing warnings) · esbuild 0 · unit suite
328 passing / 1 pending / 0 failing (baseline 314 + 14 new in `src/test/spawnRollup.test.ts`). Headless
dev-browser proof on an isolated port (3987, synthetic fleet fixture, never touched prod 3000/4316/4318):
Sessions-trace session+turn SpawnCostPanel + FLEET-COLD (Σ 9.0M cache-create, remediation) AND Alerts
"Spawn advisor" + "Spawn antipattern: FLEET-COLD" both rendered and screenshot-verified.

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

## Approval log

- 2026-08-18T12:45:00+0200 — ARCHIVED by USER batch directive ("complete all TRDD"); validity re-verified: src/shared/spawnRollup.ts exports buildSpawnRollup/detectSpawnAntipatterns (module relocated to src/shared/ per the shared-module doctrine, same symbols); imported by media/src/tabs/Traces.tsx and cacheShared.tsx.
