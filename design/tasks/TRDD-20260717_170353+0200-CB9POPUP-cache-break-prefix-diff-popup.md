---
trdd-id: CB9POPUP
title: Cache-break icon opens a before/after prompt-prefix diff popup
column: complete
created: 2026-07-17T17:03:53+0200
updated: 2026-08-02T14:25:00+0200
current-owner: spark
task-type: feature
relevant-rules: [no-nested-scrollbars]
implementation-commits: [2edb933]
---

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-07-17

- **Feature (#92):** the trace's `⚡ cache break` icon showed only cause + wasted tokens. Now
  clicking it opens a **popup** with the BEFORE/AFTER prompt-prefix block diff between the two
  consecutive turns, the first-divergent block highlighted.
- **Render surface (LIVE):** `TurnGroup` in `media/src/tabs/Traces.tsx` (~L1010), reached via
  `TimelineWaterfall` (reused by `Sessions.tsx` `SessionDetail`, section `trace`). The ⚡ badge is
  at ~L1042; clicking toggled `breakOpen` → inline `CacheBreakDetail` (~L991). Confirmed against
  `.claude/project/memory/dashboard-tree-render-topology.md` (Cache TAB exists; Traces/Flow tabs are
  dead — but `TurnGroup`/`TimelineWaterfall` ARE live via Sessions).
- **Data path (client-reachable — NO new endpoint):** `sessionCompositions.value[sessionId]`
  (`ContextComposition`) carries per-turn `ContextSource[]`; each source has `label, kind, tokens,
  bytes, count, excerpt?` where **`excerpt` is a capped excerpt of the ACTUAL injected text**. This
  is the before/after content, at BLOCK granularity, already shipped when the composition loads
  (the P5 drill-tree already renders `excerpt`). Raw request BODIES (bodyArchive.ts .wad store) are
  NOT needed for the block-level diff.
- **One source of truth:** the block set-diff lives in `src/shared/cacheBreak.ts` —
  `diffTurnSources(prev, cur)` (new, exported); `firstDivergentBlock` was refactored to reuse it so
  the popup's "first divergence" is identical to the engine's `breakSourceLabel/Kind`. Diff entry
  type `TurnSourceDiff` added to `src/shared/summarizerTypes.ts` (auto re-exported to media).
- **NEXT ACTION:** DONE. Shipped in commit 2edb933. Gates green (check-types ×2, lint 0-err/238-warn,
  check-mirrors OK 113 exports, mocha 1381 passing incl. 3 new diffTurnSources tests). esbuild ok +
  server restarted; bundle grep `cache-break-diff-popup` = present. In-browser at :3000: clicked a
  REAL ⚡ badge (Turn 1→2, "Tools changed") → popup rendered the agent-catalog ADDED first-divergence
  with its real excerpt + 5 changed blocks; 0 nested scrollers; fits viewport; verified light AND dark.
  Awaiting human review.
- **Graceful degradation (no fabrication):** non-block causes (MODEL_SWITCHED / FAST_MODE /
  EFFORT_CHANGED / IDLE_TTL_EXPIRY / COMPACTION / UPGRADE) → popup states the cause is not a
  block-content change and shows whatever block diff exists. Missing previous composition (turn 1 /
  reconstructed fork / still loading) → clear note, no diff. Missing `excerpt` on the offender →
  token-size delta only + "enable raw-body capture for full text" note.
- **No-nested-scrollbars:** the popup card has NO `overflow:auto`; content is bounded by the parser's
  excerpt cap + a capped changed-block list, text wraps (`pre-wrap`/`break-word`). See rule
  `~/.claude/rules/no-nested-scrollbars.md`.

## Investigation findings

- `cacheBreak.ts` already computes the first divergence via private `firstDivergentBlock(prev,cur)`
  (set diff by `kind::label`, first added/resized in `cur` order, else first dropped from `prev`).
  It returns only ONE block; the popup needs the FULL diff → extracted `diffTurnSources`.
- `TimelineWaterfall` builds `hostSourcesByTurn` (turn → sources). It lacked the PREVIOUS turn's
  sources; added `prevTurnByTurn` from the chronological timeline turn set (independent of the
  display `sortByValue` order) so the "before" turn is always the real previous turn.

## Popup design

`CacheBreakModal` (fixed overlay + centered card, theme-aware CSS vars):
1. Header: cause + turn N-1 → N; wasted tokens/cost; idle gap; remediation (folds in the old
   `CacheBreakDetail` content).
2. First-divergence block (matched to the engine's `breakSourceKind::breakSourceLabel`): stacked
   BEFORE / AFTER excerpt with per-line change highlight; labelled new/removed/resized.
3. Full changed-block list (added / removed / resized) with before→after token counts, capped, with
   "+N unchanged blocks share the prefix" summary.

## Deploy

`node esbuild.js` must print success (stale-bundle trap), then `agentlenspro server restart`, grep
bundle for the distinctive `cache-break-diff-popup` marker, browser-check at :3000.

## Approval log
- 2026-08-02 — AI review (backlog audit, this session): verified live first-hand — the popup ships in media/src/tabs/Traces.tsx (the comment at ~L1056 cites this TRDD; `cache-break-diff-popup` dialog ~L1091, `breakOpen` ~L1184 — the STATE's `CacheBreakDetail` was folded into the popup, a rename not a removal), and commit 2edb933 is an ancestor of HEAD.
- 2026-08-02 — HUMAN gate closed by USER delegation ("evaluate the whole status of the project and decide yourself. just base all decisions on verified facts."); release-via absent → none → terminal. Column human_review → complete.
