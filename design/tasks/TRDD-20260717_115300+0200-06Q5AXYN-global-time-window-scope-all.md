---
trdd-id: 06Q5AXYN
title: Global time-window — scope every list, stat, and chart to the picker
column: dev
created: 2026-07-17T11:53:00+0200
updated: 2026-07-17T12:30:00+0200
current-owner: main
task-type: feature
relevant-rules: []
implementation-commits: [a0d0eaf, 5f9b2f5, 3c2a757]
---

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-07-17 11:53 — STARTING

User directive: the time-range picker (15m/1h/…/All) must scope **everything listed — sessions,
file/hook events, turns, AND all statistics / bar charts / pie charts**. Today it renders on every
tab (`showFilterBars`, App.tsx:484) but only reaches surfaces that consume `filteredSessions`.

Approved plan: `~/.claude/plans/cheerful-herding-meteor.md`. Two defaulted decisions (user was away
at the AskUserQuestion, approved the plan carrying them):
- **D1** window match = interval-overlap (`startMs <= until && startMs+durationMs >= since`),
  replacing rangedSessions' start-time-only test (state.ts:514-518). Uses existing card fields.
- **D2** drilled per-turn views show the session WHOLE; turns older than `since` get a
  "before window" divider + dimming (not hidden — no broken partial conversations).

REUSE chain: `timeRange` → `rangedSessions` (state.ts:501) → `filteredSessions` (state.ts:539).
Un-scoped surfaces to reroute onto filteredSessions: HistoryTab.tsx:262, Flow.tsx:687,
Alerts.tsx:650, Automation.tsx:459. Independent feeds needing their own windowing: Cost 30-day
HistoryChart + lifetime tiles (dailyStats/lifetimeStats, Cost.tsx:502-503). Live-metric exemption
(proposed): burnRateData + serverBurnStatus (rolling "now"), labeled live.

Phases (each: TDD → full gate → commit; ≤5 files): 1 one `sessionInWindow` authority + reroute the
4 surfaces · 2 window the Cost/analytics aggregate feeds · 3 drilled "before window" divider (D2) ·
4 collector-gap banner scope+past-tense reword (folds in Task #91) · 5 verify + deploy.

⚠ LIVE-TREE CORRECTION (2026-07-17 12:30): the initial file-based inventory conflated files with
RENDERED components. The live top-level tabs are ONLY: Sessions, Context, Cache, History,
Analytics, Advisor(Patterns), Export, Import (App.tsx TABS + ActivePanel switch) — PLUS Alerts
(App.tsx:117) + Automation (App.tsx:120) rendered directly, and the CollectorGapBanner. Consequences:
- `Cost()` is a DEAD component — there is NO 'cost' tab; esbuild tree-shakes it (only CostBarChart /
  fmtUsd / CostSection are live, used by Analytics / Sessions / Help). The dailyStats/lifetimeStats
  30-day chart + lifetime tiles live ONLY inside dead Cost(), so they are NOT shown anywhere. ⇒
  PHASE 2 (commit 5f9b2f5) IS INERT — edited dead code; harmless + forward-correct if Cost is ever
  revived, but changes nothing the user sees. Kept, not reverted.
- `Flow()` (the standalone Flow tab, Flow.tsx:687) is also DEAD — the live Flow is <FlowCanvas> for
  ONE drilled session (Sessions detail sub-tab). ⇒ the Phase-1 Flow reroute is INERT (harmless).

What IS delivered & LIVE:
- Phase 1 rangedSessions→interval-overlap (sessionInWindow) → filteredSessions → windows EVERY live
  surface that flows from it: Sessions, Context(ContextTab), Cache(CacheTab), Analytics (+ its
  CostBarChart bar, ContextGrowthChart), Advisor(Patterns scatter), Tools (pie, rangedSessions),
  Insights, Instructions, Traces, Export. This is the core user ask (stats/graphs/pies windowed).
- Phase 1 LIVE reroutes: History ✓, Alerts ✓, Automation ✓.
- Phase 4 (commit 3c2a757): collector banner past-tense + windowed — LIVE-verified in browser.
Gate green throughout: tsc ×2, mirrors OK, lint 0 err, mocha 1368/0. Deploy: esbuild + server
restart (pid 4531); banner reword confirmed rendering; tab bar confirms no Cost tab.

NEXT ACTION: report the correction to the user. Open decisions: (1) D2 (Phase 3 drilled-turn
divider) still unconfirmed — user was away; (2) the removed Cost tab means the 30-day/lifetime cost
history is not visible at all — ask whether to restore it (as a live, windowed view) or leave it.
Do NOT start Phase 3 or a Cost-restore without the user's call.

Verify: pnpm run check-types (×2) + lint + check-mirrors + mocha; node esbuild.js + server restart +
symbol grep; live at :3000 pick 15m, walk every tab, light+dark screenshots.

SUPERSEDED — none yet.

Out of scope (separate): Task #92 cache-break diff drill-down (its own TRDD).

## Context

The time-range bar is shown on every tab, implying global scope, but only `rangedSessions` /
`filteredSessions` consumers honor it. Verified by two Explore inventories (session-signal
architecture + per-tab/chart/timestamp inventory): 4 list surfaces read raw `sessionSummary` /
`displaySessions`, and the Cost tab's 30-day + lifetime aggregates come from independent
`dailyStats`/`lifetimeStats` SSE feeds — none scope to the picker. This is why a 15m filter still
surfaced weeks-old content (compounded by drilled views reconstructing a resumed ancestor
transcript). One `sessionInWindow` helper becomes the single source of truth; every surface routes
through the windowed session list, and the independent aggregates derive from it under bounded
presets.
