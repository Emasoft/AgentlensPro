---
trdd-id: B22NYTOY
title: Conversation transcript view — narrative per-turn session reader (CLI tool + dashboard)
column: human_review
created: 2026-07-16T02:10:29+0200
updated: 2026-08-02T11:34:56+0200
current-owner: main
task-type: feature
severity: major
scope: project
npt: []
eht: []
---

# Conversation transcript view — narrative per-turn session reader

## ⏵ STATE — 2026-07-16 ~03:20 — ALL 4 PHASES LANDED + LIVE-VERIFIED; column → ai_review

- **P4 DONE:** card enrichment — logReader `_claudeOnEntry` harvests `ai-title` (latest wins) +
  top-level `entrypoint` (first wins) into `SessionSummaryCard.title/entrypoint` (spread-conditional
  in `_buildCard`; 3 TDD tests in `logReader.cardTitle.test.ts`); Sessions row headlines the title
  (upright/medium, prompt → tooltip); `conversation.ts` entrypoint/cwd harvest hoisted
  record-agnostic (was assistant-only — user/attachment/system records carry it too, live-verified).
  Browser smoke: 4th TITLED fixture + 2 Transcript sub-tab tests (dark/light screenshots,
  role-colored turns, `→ Read` collapsed rows, exact-span `cli` badge check — a substring test
  false-passes on "click"). Suite 1259 green WITH browser tests; gate clean; deployed pid 70383.
- **LIVE-VERIFIED (2026-07-16 ~03:18):** `/api/summary` card for session a0fce09a carries
  `title: "conversation-transcript-viewer"`, `entrypoint: "cli"`; dashboard Transcript tab renders
  the real 3196-turn session (title header, cli badge, compaction dividers, paging).
- **Known limitations (deliberate scope cuts, follow-up TRDDs if wanted):**
  (a) title/entrypoint are NOT persisted to SQLite (fixed-column schema; migration needed) — cards
  served from the DB snapshot lose them; live-scanned cards (any session that appends) carry them.
  Forward-only enrichment: dormant sessions stay prompt-headlined.
  (b) opencode's DB has its own `title` column — could feed card.title for that source too.
- **HARNESS LESSON (headless-Chrome stall):** in headless puppeteer an idle page parks — Preact's
  rAF-deferred effects AND fetch-response delivery stalled ~25s while the server answered external
  curl in 0.03s at 0% CPU. In-page rAF-polled `waitForFunction` generates no renderer activity and
  never unsticks it; TEST-SIDE `page.evaluate` polling (each evaluate = a renderer task) does —
  response landed in 504ms. Pattern now in dashboardSmoke `pollFor()`.

## ⏵ [SUPERSEDED] STATE — 2026-07-16 ~03:05 — P1+P2+P3 LANDED; NEXT: P4 (card enrichment + smoke + close)

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
- 2026-08-02 — AI review PASSED (ai_review backlog audit): implementation verified present in the code first-hand, not from prose. Column ai_review → human_review; the remaining gate is the human. Evidence: reports/ai-review-audit/20260802_113207+0200-batchA-diagnostics.md
