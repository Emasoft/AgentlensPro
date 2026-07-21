---
trdd-id: EYA3X5MQ
title: Add /reload-plugins + /clear to the diagnostic taxonomy (CLI + dashboard) + a reload-cost command
column: dev
created: 2026-07-21T11:42:36+0200
updated: 2026-07-21T11:42:36+0200
current-owner: main
task-type: feature
scope: project
implementation-commits: []
relevant-rules: []
---

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-07-21

**Goal:** name `/reload-plugins` (the machine's #1 cache-break cost, ~$235: skill catalog
$154.65/315× + agent catalog $80.63/124×, today mislabeled generic) and `/clear` (the
floor-reset remedy) in the diagnostic taxonomy; surface both in CLI + dashboard; add a
`reload-cost` CLI shortcut (tool `get_plugin_reload_costs`) listing recent reloads with
cache-write tokens + $; add a full lifecycle-events view (CLI + dashboard) from the hook store.

**Plan file:** `~/.claude/plans/swift-riding-otter.md` (approved).

**NEXT ACTION:** P1 — add `PLUGINS_RELOADED` to both taxonomies (`src/shared/summarizerTypes.ts`
`CacheBreakCause`; `src/cacheBreakTimeline.ts` `CacheBreakTimelineCause`) + `CAUSE_LABEL`/
`REMEDIATION` + a co-churn pre-check (≥2 of {tool,skill,agent} catalogs diverge in one turn →
`PLUGINS_RELOADED`, confidence high=3/med=2) in `classifyTurn`; tests.

**Load-bearing facts (verified):**
- Timing: `/reload-plugins` is a local command (no API call); the changed catalog rides the
  stable prefix of the NEXT model turn → billed as that turn's `cache_creation`. One occurrence
  = one reload. The classifier already attributes a turn's cache_creation to its first divergent
  prefix element.
- Detection: NO plugin-reload hook exists; built-ins don't fire `UserPromptSubmit`. Candidate
  hook = `ConfigChange` (matcher `skills`) — UNVERIFIED, confirm empirically (P3). Robust path =
  co-churn inference (covers the historical $235, no hook data). `/clear` = `SessionStart{clear}`
  (already captured). Full hooks reference: USER memory `[[claude-code-hook-types]]`.
- Two live taxonomies both need the cause: `src/shared/cacheBreak.ts` (P4, drives
  `get_cache_break_report` + dashboard `CAUSE_LABEL`) and `src/cacheBreakTimeline.ts` (drives
  `get_cache_break_timeline`). `cacheBreak.ts` has an UNUSED `PLUGIN_TOGGLE` enum value — repurpose.
- Deploy law: change ships only after `node esbuild.js` SUCCEEDS + `agentlenspro server restart`
  + symbol-grep the rebuilt bundle. Gates: check-types ×2 + lint + check-mirrors + mocha.
  `media/src/` must re-export shared symbols, never re-declare (check-mirrors).

**Phases:** P1 taxonomy+co-churn · P2 lifecycle model (`/clear`) · P3 ConfigChange hook (empirical
test) · P4 CLI (`get_plugin_reload_costs` + `reload-cost` + `get_lifecycle_events`) · P5 dashboard
(cause label + lifecycle view) · P6 deploy+verify+screenshots.

**SUPERSEDED — do NOT carry forward:** (none yet).

## Context

See the approved plan file for the full rationale, investigation findings, and phase detail.
This TRDD tracks execution; the plan is the design of record.

## Approval log

- 2026-07-21 — USER approved the plan (ExitPlanMode) after review of scope, detection design,
  and the three clarifying decisions (command name `reload-cost`; add a hook for detection;
  full lifecycle-events view for `/clear`).

## Notes and lessons learned
