---
trdd-id: B22NYTOY
title: Conversation transcript view — narrative per-turn session reader (CLI tool + dashboard)
column: dev
created: 2026-07-16T02:10:29+0200
updated: 2026-07-16T03:05:00+0200
current-owner: main
task-type: feature
severity: major
scope: project
npt: []
eht: []
---

# Conversation transcript view — narrative per-turn session reader

## ⏵ STATE — 2026-07-16 ~03:05 — P1+P2+P3 LANDED; NEXT: P4 (card enrichment + smoke + close)

- **P1 DONE** (e4d7bfa): `src/conversation.ts` ordered-blocks parser + 15 fixture tests (suite
  1251 green); findSessionFile + classifyAttachment de-duped into contextComposition exports.
  Real-world: 15,304-line transcript in 190ms, compactions exact.
- **P2 DONE** (6aa5b11): `get_conversation` MCP tool (progressive drill-down; range cap 20),
  accessor + `GET /api/conversation/:id` (heavyGuard), SKILL.md row, CHANGELOG. CLI live-verified.
- **P3 DONE** (31ab64f): dashboard Transcript sub-tab — `media/src/TranscriptView.tsx` chat-reader
  (role-colored turns, collapsibles that grow the page, compaction dividers, last-300 paging),
  Sessions.tsx navBtn+section, state.ts requestConversation. DESIGN DEVIATION from plan: DIRECT
  fetch (requestCompositionSummary precedent) instead of App.tsx message branch + server shim
  branch — standalone is the only runtime; 2 fewer files. Endpoint live-verified (3132 turns).
- **NEXT ACTION (P4):** card enrichment — `src/logReader.ts` parse `ai-title` → card.title +
  `entrypoint` → card.entrypoint (SessionSummaryCard optional fields in summarizerTypes),
  Sessions.tsx row headline shows title; browser smoke: dashboardSmoke Transcript sub-tab click +
  light/dark screenshots (AGENTLENSPRO_BROWSER_TESTS=1); full gate; esbuild + restart;
  live-verify dashboard visually; close TRDD (column → ai_review).

## ⏵ [SUPERSEDED] STATE — 2026-07-16 ~02:10 — PLAN APPROVED, starting Phase 1 (parser core, TDD)

**USER intent (2026-07-16):** token-companion shows "the actual output and prompt of each agent
and tool — AgentlensPro does not show them, or does but in a confusing way". Approved plan:
conversation-first lens — `get_conversation` MCP/CLI tool + dashboard Transcript sub-tab, built
purely from the session `.jsonl`, folding in the skipped transcript signals.

**The authoritative plan** (exploration facts with file:line, data model, 4 phases, verification)
lives at `~/.claude/plans/cheerful-herding-meteor.md` — read it before resuming; do not re-derive.
Research grounding: `reports/research/20260716_005512+0200-token-companion-jsonl-ingest-distill.md`.

**Phases:** P1 parser core (`src/conversation.ts` + shared types + tests + findSessionFile
de-dup) → P2 MCP tool + `/api/conversation/:id` → P3 dashboard Transcript sub-tab
(`TranscriptView.tsx`) → P4 card enrichment (ai-title/entrypoint) + browser smoke + deploy +
live-verify. Each phase: TDD → full gate → commit.

**NEXT ACTION:** Phase 1 — write `src/test/conversation.test.ts` (fixture-driven, ~12 tests),
then `src/conversation.ts` (ordered-blocks streaming parser reusing contextHistory's
classification approach), export `findSessionFile` from contextComposition, import in
contextHistory.

## Key design decisions

- **Ordered blocks, not merged**: contextHistory's `${kind}:${label}` Map collapses intra-turn
  order and same-tool repeats — correct for composition analytics, wrong for a narrative. The new
  parser emits blocks in arrival order.
- **Streaming-chunk merge by message.id** (token-companion technique, verified in our
  transcripts): CC writes multiple assistant records per turn (thinking → text → tool_use, same
  message.id) — merged into ONE turn.
- **Progressive drill-down bounding** (get_context_history contract): summaries → turn → full
  text; leanify still caps everything.
- **Signals folded in**: turn_duration, compact_boundary (pre/post/dropped tokens), ai-title,
  agent-name, entrypoint, cache_creation ephemeral 5m/1h — all verified present in live
  transcripts and unparsed today (research report).
- **Unknown record types → systemNote passthrough** — never silently dropped (sink philosophy,
  TRDD-AMEA4O4Z).

## Approval log

- 2026-07-16 USER: "ok, i like the new proposals. do as you think is best. enter plan mode and
  improve agentlenspro." → plan approved via plan-mode approval (ExitPlanMode accepted).
