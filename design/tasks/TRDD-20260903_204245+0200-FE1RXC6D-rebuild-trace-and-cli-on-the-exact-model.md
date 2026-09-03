---
trdd-id: FE1RXC6D
title: Rebuild the dashboard trace and the CLI views on the exact turn model
column: blocked
pre-block-column: todo
created: 2026-09-03T20:42:45+0200
updated: 2026-09-03T20:42:45+0200
current-owner: unassigned
task-type: refactor
severity: HIGH
labels: [dashboard, cli, trace, ux, cache]
relevant-files: [media/src/tabs/Traces.tsx, media/src/tabs/ContextTab.tsx, media/src/tabs/Sessions.tsx, src/cli/statuslineHistoryCli.ts, src/burnGuard.ts, src/burnInvestigator.ts, src/logReader.ts]
blocked-by: [3UJB4MN3]
npt: []
eht: []
release-via: publish
---

# Rebuild the trace and the CLI on the exact turn model

Phase 3–5 of the approved plan (`~/.claude/plans/snuggly-bubbling-diffie.md`). Blocked on the store
(TRDD-3UJB4MN3) because the whole point is that the view reads exact data instead of transcript
estimates.

## The design, already settled with the owner

One tree per turn. The four billed buckets are exact and partition the turn; every element shows
exact BYTES always, and exact TOKENS on demand via `count_tokens` differencing with the residual
printed. A turn with no captured body shows its billed buckets and names the capture gap — no
transcript fallback, no estimate, and the turn is never hidden. When a turn writes a large prefix,
the first divergent element is named inline with its previous and current value.

## What must be deleted, not adapted

The second axis. `buildTurnNodes` currently nests transcript-derived content blocks under the
cache-created bucket, which asserts a parent/child relation between two unrelated quantities. That is
the original defect (TRDD-0Y8BMVK2) and the reason this rebuild exists.

## Known-wrong sites to fix while here (each verified this session)

- `Traces.tsx:901` — `newInput` clamped to 0 by a stale incl-cache subtraction.
- `Traces.tsx` `FiveValues` — re-derives the hit rate and re-hardcodes colour thresholds instead of
  `cacheHitRate` / `hitRateColor`.
- `Traces.tsx:1855` and `BgSummaryBlock` — session totals that drop the cache buckets entirely.
- `Sessions.tsx:211` — hit rate on the wrong denominator, structurally unbounded (same class as the
  164662% bug); `Sessions.tsx:333` "Total context" = `inputTokens` alone.
- `ContextTab.tsx:551` — peak context missing `cacheCreateTokens`.
- `HistoryTab.tsx:81` — the same stale subtraction.
- `logReader.ts:2199` — sub-agent `cacheHitRate` divided by a harness footprint figure, unbounded.
- `statusline-history cache` — `in_tok` is selected and feeds both cost columns but is never
  displayed, and the `$` columns are computed locally with nothing saying so.
- `statusline-history subagents` — `fill%` is a max over samples divided by an arbitrary sample's
  window; not bounded.
- `burnGuard.ts:222` — bytes/4 printed as "k tokens".
- `burnInvestigator.ts:118` — `equivOf` hardcodes the 5m write tier, under-counting a 1h session ~40%.

Route every hit rate through `src/shared/tokenBuckets.ts::cacheHitRate`, which is the bounded one and
currently has almost no callers.

## Parity — read before touching a renderer

These outputs are byte-locked against Rust twins and need TS + regenerated fixture + Rust in ONE
commit: `get_cache_event_log`, `get_cost_peaks`, `trace_expensive_writes`, the cache-break timeline,
`check_burn_risk` details, `investigate_burn` totals and key order, `burn_seismic`,
`get_heartbeat_cost` JSON field names, statusline store column names, the composition drill block key
set and order. `statuslineHistoryCli.ts`, `ctxmapCli.ts` and `ctxvisCli.ts` have no twin and are free.

## Open questions

1. **What is the token cost of the exact-token measurement?** `count_tokens` differencing costs one
   API call per element boundary. MEASURE the calls and wall-clock for one 200-element turn before
   wiring the button, and show the user the cost before it runs.
2. **Does the trace stay responsive on a 900-turn session?** Measure render time with the new model
   at 100, 500 and 1,000 turns. The old tree hydrated compositions eagerly for a bounded set; the new
   one reads the element table.
3. **Inner scrollbars.** `waterfall.css:2` and `summaries.css:36` violate the no-nested-scrollbars
   rule today. Removing them changes what `.wf-sticky-toolbar` sticks to. Verify both themes and both
   the session and turn views after the change.

## Acceptance

- [ ] Children sum to their parent everywhere; the residual is displayed and is 0.
- [ ] The screenshot's own turn now reconciles, and the catalogs appear only on the turns that
      actually carried them.
- [ ] No view mixes the billing partition with content identity in one hierarchy.
- [ ] A capture-gap turn renders its billed buckets and names the gap.
- [ ] `pnpm run compile` clean, the served bundle verified to carry the change after deploy.
