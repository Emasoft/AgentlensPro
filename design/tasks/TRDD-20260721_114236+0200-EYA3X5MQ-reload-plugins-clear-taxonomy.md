---
trdd-id: EYA3X5MQ
title: Add /reload-plugins + /clear to the diagnostic taxonomy (CLI + dashboard) + a reload-cost command
column: complete
created: 2026-07-21T11:42:36+0200
updated: 2026-07-21T12:20:00+0200
current-owner: main
task-type: feature
scope: project
implementation-commits: [c6a2a1a, 4429c34, 7231f63, a0cbdbd, 39be84e, 6ceb574]
relevant-rules: []
---

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-07-21

**Goal:** name `/reload-plugins` (the machine's #1 cache-break cost, ~$235: skill catalog
$154.65/315× + agent catalog $80.63/124×, today mislabeled generic) and `/clear` (the
floor-reset remedy) in the diagnostic taxonomy; surface both in CLI + dashboard; add a
`reload-cost` CLI shortcut (tool `get_plugin_reload_costs`) listing recent reloads with
cache-write tokens + $; add a full lifecycle-events view (CLI + dashboard) from the hook store.

**Plan file:** `~/.claude/plans/swift-riding-otter.md` (approved).

**NEXT ACTION:** none — feature COMPLETE + deploy-verified. Two follow-ups remain OPTIONAL/USER-
gated: (1) empirically confirm ConfigChange fires on /reload-plugins (needs `--install-hooks` +
session restart + one /reload-plugins — the co-churn inference already works without it); (2) ship
decision — these 6 commits are unpushed on local main (leave-local stands per the user).

**P5/P6 DONE:** Lifecycle dashboard tab + `/api/lifecycle-events`; PLUGINS_RELOADED label
auto-renders in Cache/Traces (shared CAUSE_LABEL — 'Plugins reloaded' verified in dashboard.js).
Default lifecycle view excludes STOP + SESSION_END noise → surfaces boundaries. Commit 6ceb574.
Deploy: esbuild + server restart, symbol-grep confirms all new symbols shipped; screenshots in
`reports/screenshots/lifecycle-tab-*.png`. All gates green, suite 1395.

**DONE:**
- Deliverable 0 — extended USER hooks reference `claude-code-hook-types` (full ~30-event catalog +
  no-plugin-reload-hook fact); cross-linked from `hook-events-pipeline`. Commit c6a2a1a.
- P1 — PLUGINS_RELOADED in both taxonomies + confidence + co-churn. Commit 4429c34.
- P2 — `src/lifecycleEvents.ts` pure model (/clear + siblings; ConfigChange pre-wired). Commit 7231f63.
- P3 — ConfigChange added to HOOK_EVENTS capture list (empirical confirm pending install+restart).
  Commit a0cbdbd.
- P4 — `reload-cost` (alias→get_plugin_reload_costs, COMPOSITION path) + get_lifecycle_events. LIVE-
  VERIFIED: 102 reloads/$9.19; /clear detected (this session, 10:19:36). Precision guard (reload =
  re-registration of EXISTING catalogs) dropped 197/$145 false-positive over-count → 102/$9.19.
  Commit 39be84e. Full suite 1394 green.

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
