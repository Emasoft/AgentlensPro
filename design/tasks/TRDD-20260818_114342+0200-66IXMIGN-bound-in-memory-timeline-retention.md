---
trdd-id: 66IXMIGN
title: bound in-memory timeline retention so the server heap cannot grow with machine history
column: complete
created: 2026-08-18T11:43:42+0200
updated: 2026-08-18T12:28:36+0200
implementation-commits: [52f81cb]
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

- [x] repro from parent card (1GB cap, isolated DATA_DIR, real HOME) survives the boot scan —
      6-min run, ~350-530MB steady RSS, zero near-limit snapshots (was: dead in 33-45s, 5/5 runs)
- [x] `pnpm run check-types` + `pnpm run lint` + unit tests green (2368 passing)
- [x] no direct `timeline.push` remains in log-ingestion accumulation paths

## What the fix became (the plan above was layer 1 of 4 — each next layer measured, not assumed)

1. Per-card entry cap + byte budget (`timelineRetention.ts`) — necessary, insufficient.
2. FLATTEN truncating slices: V8 SlicedString retains its parent, so `resultSummary = full.slice(0,200)`
   pinned a 352KB tool output and `userRequest.slice(0,500)` a 481KB prompt (retainer-edge walk).
   `snip()`/`flatten()` are the sanctioned truncators now.
3. Bounded accum collections (`_boundedSet`/`_boundedAdd`, 4096): one pendingToolResults table held
   33k+ evicted entries; seenMessageIds accreted one id per message forever.
4. Fleet-scale tier: parse-time cold-strip (`AGENTLENS_TIMELINE_HOT_AGE_HOURS`, 24h) because the
   scan's own results array defeats any post-scan bound at 12k files; server-side hot tier
   (`AGENTLENS_TIMELINE_HOT_CARDS`, 50) for what stays resident. Tests pin hot via setup.js.

## Approval log

- 2026-08-18T12:28:36+0200 — APPROVED human_review → complete by USER (batch "approved."). Live re-verify at approval: server pid 5888 heap 391/6240MB after 11m uptime. Ships in v2.27.0 (release-via: publish; → published on tag).
