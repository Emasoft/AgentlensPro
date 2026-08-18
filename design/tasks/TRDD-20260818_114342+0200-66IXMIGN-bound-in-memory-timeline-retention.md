---
trdd-id: 66IXMIGN
title: bound in-memory timeline retention so the server heap cannot grow with machine history
column: dev
created: 2026-08-18T11:43:42+0200
updated: 2026-08-18T11:43:42+0200
current-owner: AgentlensPro session
task-type: bugfix
severity: HIGH
parent-trdd: MFSUMOJ9
labels: [memory, ingestion, hot-path]
relevant-files: [src/logReader.ts, src/summarizers/claude.ts, standalone/server.ts, src/shared/summarizerTypes.ts]
release-via: publish
---

# Bound in-memory timeline retention (fix for TRDD-MFSUMOJ9)

Root cause (snapshot-proven on the parent card): `SessionSummaryCard.timeline` retains every
message/tool entry with full inline text for EVERY session file on the machine; the heap is
proportional to total entry count (2.83M strings averaging ~330B at death — truncating field
sizes would not help; the COUNT must be bounded).

## The fix

1. ONE choke point `pushTimelineEntry(timeline, entry, cap)` (shared, runtime-neutral) replacing
   every direct `timeline.push(...)` in the log-ingestion accumulators; evicts oldest-first,
   amortized (overflow to cap×1.25, splice down to cap). Card carries `timelineTruncatedCount`.
2. Cap knob `AGENTLENS_TIMELINE_MAX_ENTRIES` (default 2000) resolved once at boot.
3. Enforce on boot-load too: `cardsLog.load()` may return giant legacy cards — normalize on load.
4. Aggregates (tokens/costs/counts) are accumulated during parse, NOT derived from the retained
   timeline — unaffected by eviction. Verify with a test.
5. Pin with a test: synthetic transcript with >cap entries → retained length ≤ cap,
   truncated counter set, aggregates equal to the uncapped parse.

## Acceptance

- [ ] repro from parent card (1GB cap, isolated DATA_DIR, real HOME) survives the boot scan
- [ ] `pnpm run check-types` + `pnpm run lint` + unit tests green
- [ ] no direct `timeline.push` remains in log-ingestion accumulation paths
