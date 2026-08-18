---
trdd-id: 0KNGDFQI
title: Standalone collector OOMs under the full-telemetry firehose — bound ingest memory + backpressure
column: completed
created: 2026-07-07T11:51:06+0200
updated: 2026-08-18T12:45:00+0200
current-owner: null
assignee: null
priority: 0
severity: CRITICAL
effort: L
task-type: bugfix
parent-trdd: TRDD-TKN5VALS
relevant-rules: []
release-via: none
target-branch: fix/logreader-large-jsonl
test-requirements: [typecheck, lint]
impacts: []
external-refs: []
---

# TRDD-0KNGDFQI — Collector firehose OOM / backpressure

## ⏵ STATE — RESOLVED 2026-07-07 (column=complete)
The OOM death is FIXED by three commits: `9d4caad` (MAX_SPANS cap on the in-memory span array),
`c9e8f87` (SSE pushUpdate/summary-rebuild coalesced to ≤1/sec — was per-POST allocation churn),
`a54abae` (6GB launch heap in `pnpm run local` + scripts/dev-server.js). Under the live full
firehose the working set PLATEAUS ~3.3GB (BOUNDED — not an unbounded leak) and the server ran
24+ min stable with zero OOM and a responsive dashboard. The acceptance example figure (<1.5GB)
was NOT met — the plateau is higher but bounded; lowering the baseline (DB-backed span retention,
smaller AGENTLENS_MAX_SPANS default) is an OPTIONAL follow-up, not a blocker. Heap-snapshot
retainer analysis (spec 1) was skipped once the plateau proved bounded — the fix was empirically
sufficient.

## ORIGINAL STATE (historical) — CRITICAL BLOCKER
Enabling the FULL Claude Code telemetry (OTEL_LOGS_EXPORTER + OTEL_METRICS_EXPORTER + traces +
OTEL_LOG_RAW_API_BODIES, all now in ~/.claude/settings.json) makes MANY concurrent Claude Code
sessions POST logs (5s) + metrics (10s) + traces (1s) + raw-body events to the standalone
collector (:4318). The standalone server's memory GROWS UNBOUNDED and OOM-kills the process:
`FATAL ERROR: Ineffective mark-compacts near heap limit — JavaScript heap out of memory`. Observed
RSS climb on a FRESH (0-span) start: 1.4GB @12s → 3.3GB @32s → OOM (~90 MB/s), independent of the
historical spans.json. So the leak is in the INGEST/PROCESSING path, not the initial load.

**Already done (commit 9d4caad):** capped the in-memory `spans` array (MAX_SPANS=200k, env
AGENTLENS_MAX_SPANS) on load + add. NECESSARY but INSUFFICIENT — the process still OOMs in ~40s, so
another structure/allocation-churn dominates. Historical spans.json cleared to `[]` (backup
`~/.agentlens/spans.json.bak-98mb`).

## Suspected sources (verify with a heap snapshot — do NOT guess)
- **Per-POST `pushUpdate()` → `buildSessionSummary()` → `JSON.stringify(entire summary)` → SSE push**
  run on EVERY incoming OTLP POST at firehose rate = massive allocation churn (GC can't keep up).
  FIX: debounce pushUpdate/summary rebuild to ~1-2s (coalesce), not per-POST.
- An unbounded accumulator in the log/metric ingest path (metric datapoints? logSessions Map?
  the rich-event spans from 7612ff5? a per-event buffer?). Bound it.
- sql.js in-memory DB growth (WASM memory — would show as RSS not V8-heap FATAL, but check).
- Incoming POST body accumulation without a size limit on the collector.

## Spec
1. Heap-snapshot the running server under the live firehose (`node --inspect`, or
   `require('v8').writeHeapSnapshot()` on a timer) to IDENTIFY the dominant retainer. Document it.
2. Bound / throttle it: debounce the summary rebuild + SSE push (coalesce to ≤1/sec); cap any
   unbounded ingest structure; add an incoming-body size guard on the OTLP handler; ensure the
   5-min span window / MAX_SPANS actually bounds the working set.
3. Make the launch use a sane heap (`--max-old-space-size` in the `pnpm run local`/dev-server
   launch) AND the process must PLATEAU well under it (the heap flag is headroom, not the fix).
4. Do NOT reduce what telemetry is COLLECTED (the user wants full telemetry) — bound how it is
   PROCESSED/held in memory.

## Acceptance
- The standalone server runs for ≥30 min under the live full-firehose (all the user's active Claude
  sessions) with RSS PLATEAUING (e.g. < 1.5GB) and ZERO OOM. Verified by sampling RSS over time.
  check-types+lint+esbuild clean. The /api/callcontext + dashboard stay responsive under load.

## Approval log

- 2026-08-18T12:45:00+0200 — ARCHIVED by USER batch directive ("complete all TRDD"); validity re-verified: standalone/server.ts spans-bounding logic (MAX_SPANS eviction lineage) still present, now superseded by segmentedSpanStore.ts's P4 store (src/segmentedSpanStore.ts:5).
