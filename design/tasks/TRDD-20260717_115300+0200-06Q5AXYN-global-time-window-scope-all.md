---
trdd-id: 06Q5AXYN
title: Global time-window — scope every list, stat, and chart to the picker
column: dev
created: 2026-07-17T11:53:00+0200
updated: 2026-07-17T11:53:00+0200
current-owner: main
task-type: feature
relevant-rules: []
implementation-commits: []
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

NEXT ACTION: Phase 1 — add `sessionInWindow(card, since, until)` to media/src/state.ts, switch
`rangedSessions` to it, reroute the 4 surfaces; write interval-overlap unit tests; full gate.

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
