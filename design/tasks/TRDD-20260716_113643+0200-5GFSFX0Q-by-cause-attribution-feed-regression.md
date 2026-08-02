---
trdd-id: 5GFSFX0Q
title: Per-cause attribution feed regressed by the Phase B log-wins merge — graft OTEL api_request entries onto the served log card
column: human_review
created: 2026-07-16T11:36:43+0200
updated: 2026-08-02T11:35:13+0200
current-owner: main
task-type: bugfix
severity: major
scope: project
parent-trdd: O981ZJKV
npt: []
eht: []
labels: [cost, attribution, tokens-by-cause, merge-policy]
test-requirements: [unit, typecheck, lint]
---

# Per-cause attribution feed regressed by the Phase B log-wins merge

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-07-16

**✅ IMPLEMENTED + LIVE-VERIFIED (2026-07-16).** Fix exactly as designed below (pure
`graftOtelAttribution` in feedMergePolicy + pre-merge side-map + shallow-copy graft in
`resolveSessionCard`). Gate GREEN: tsc 0 errors, lint 0 errors, **1285 passing / 0 failing**
(+4 graft unit tests, +1 real-boot end-to-end that posts a real OTLP api_request record beside a
transcript fixture and asserts the composed timeline). Deployed (esbuild + restart). LIVE PROOF on
the fixing session: `get_cost_by_cause` went **0 → 957** attributed calls, with real rows —
skill `third-party` $34.90 / `code-review` $12.40, agents `custom`/`Explore`, querySource split —
and honest reconciliation (394M of 1.47B attributed; OTEL is the expected lower bound).

Derived bugfix of TRDD-O981ZJKV (Tier 0 — the regression was introduced by that umbrella's own
Phase B token-feed fix). Found 2026-07-16 while re-grounding item 11 (skill-cost ranking):
`get_cost_by_cause` reports **0 `api_request` calls across 50 sessions / 2 days** on a machine
with full rich-event telemetry enabled and log events flowing.

## Root cause (verified in code + live)

- The per-call attribution ground truth (exact `cost_usd` + `query_source`/`agent.name`/
  `skill.name`/`plugin.name`/`mcp_*.name`) exists ONLY as `api_request` timeline entries on the
  **OTEL** Claude card (built by `src/summarizers/claude.ts:472-502` from the rich log-event
  spans). They are deliberately totals-neutral (never added to session aggregates).
- Phase B's `mergeOtelAndLogSessions` (`src/feedMergePolicy.ts`) drops the colliding OTEL card
  WHOLESALE when the log transcript card wins — correct for token TOTALS (OTEL is a measured
  lossy lower bound), but it discards the only attribution feed with it.
- Every drill consumer reads the served card's timeline via `resolveSessionCard`
  (`standalone/server.ts`): `get_cost_by_cause` (the whole tokensByCause engine incl. the skill/
  plugin dimensions of TRDD-UBEP5XY7), the webview per-cause toggle, and `burnMonitor`'s
  last-api_request cost read — all starved for every transcript-covered Claude session, i.e. ALL
  interactive sessions.

## Fix

Timeline-dimension MERGE instead of displacement, applied at serve time:

1. `src/feedMergePolicy.ts` — new pure `graftOtelAttribution(logTimeline, otelTimeline)`:
   append the OTEL side's `type === 'api_request'` entries (the one type the transcript parser
   never produces) to the log timeline, dedupe by spanId, sort by timestamp. Exported + unit
   tested; doctrine comment updated (log wins TOTALS; OTEL attribution entries are grafted).
2. `standalone/server.ts` — `computeSessionSummary` captures a pre-merge side-map
   `sessionId → otel api_request entries` (references, rebuilt with the memoized summary);
   `resolveSessionCard` returns a shallow copy of the served log card with the graft applied
   (never mutates the stored card, so reparse stays pure and the graft is idempotent per drill).
3. Reconciliation stays honest by construction: card totals (log ground truth) vs Σ grafted
   api_request buckets (OTEL lower bound) → the existing signed-remainder note.

## Verify

- Unit: graft filters/sorts/dedupes; empty-OTEL is identity.
- Real boot: transcript fixture + OTLP rich api_request log record (bare name, `session.id`,
  `skill.name`) for the SAME session → `/api/timeline/:id` serves transcript entries AND the
  attributed api_request entry.
- Live: `get_cost_by_cause --sessionId <this session>` reports >0 api_request calls with real
  skill/agent rows after deploy.

## Notes and lessons learned

## Approval log

- 2026-08-02 — AI review PASSED (ai_review backlog audit): implementation verified present in the code first-hand, not from prose. Column ai_review → human_review; the remaining gate is the human. Evidence: reports/ai-review-audit/20260802_113227+0200-batchB-server-ingestion.md
