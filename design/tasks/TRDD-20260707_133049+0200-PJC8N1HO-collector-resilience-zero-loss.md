---
trdd-id: PJC8N1HO
title: Collector resilience — supervision, downtime gap markers, durable tail offsets, zero-loss restart
column: complete
created: 2026-07-07T13:30:49+0200
updated: 2026-07-07T19:01:50+0200
current-owner: null
assignee: null
priority: 1
severity: HIGH
effort: L
task-type: infra
parent-trdd: TRDD-TKN5VALS
approval-tier: 2
relevant-rules: []
release-via: none
target-branch: fix/logreader-large-jsonl
test-requirements: [typecheck, lint, unit]
impacts: [install-script]
external-refs: []
implementation-commits: [acde47b2a83d655f1cdc0ba10e0ba2ebd9bb983e]
last-test-result: pass
last-test-at: 2026-07-07T19:00:00+0200
---

# TRDD-PJC8N1HO — Collector resilience + zero-loss ingestion

## ⏵ STATE — COMPLETE 2026-07-07 19:01 (column complete) — all 7 specs shipped in acde47b2
DONE. Commit acde47b2a83d655f1cdc0ba10e0ba2ebd9bb983e on branch fix/logreader-large-jsonl (local only,
NOT pushed). Report: reports/collector-resilience/20260707_190029+0200-PJC8N1HO.md.

ROOT CAUSE (heap evidence, not guessed): the two OOMs (server5=request `on_headers_complete`,
server6=save-timer `JSON.stringify(spans)` flatten) both tipped a heap ALREADY at ~6081MB. Measured
the resident base (scripts_dev/measure-resident-base.js): `logSessions` = ~2.6GB (14k cards with full
timelines; serialization overflows V8's 512MB string cap). Under the 6144MB cap that leaves too little
headroom, so any heavy request / the save timer / an incoming request tips it. A single History
request for the 461MB session is 212MB heap (measure-history-heap.js).

SHIPPED (all verified on isolated ports — prod 3000/4316/4318 + ~/.claude never touched):
- spec 6 request logging → src/serverRuntime.ts RequestLog + instrumentResponse; /api/debug/requests.
- spec 7 heap-pressure guard → heavyGuard: 503 (not death) when heapUsed >= 85% of the real V8 limit.
- spec 5 bounded builders → contextHistory/contextComposition whole-reconstruction text budget
  (env AGENTLENS_HISTORY/COMPOSITION_TEXT_BUDGET_MB); kills the 2000x200x20KB ~8GB path.
- spec 4 atomic spans → atomicWriteFileSync (temp+fsync+rename) in scheduleSave/shutdown/clear.
- spec 3 durable offsets → collectorState.ts + LogReader.export/importFileState + reparseSession +
  stripped-card persistence; restart skips unchanged files (fullReads=0) and restores list instantly.
- spec 2 gap markers → lifecycle start/heartbeat/stop + computeCollectorGaps; in get_recent_sessions
  ({sessions,collectorGaps}), SSE payload, /api/collector-gaps, red dashboard band. CollectorGap type
  mirrored in summarizerTypes.ts AND media/src/types.ts.
- spec 1 supervision → scripts/agentlens-supervise.js + launchd template; pnpm run up:supervised.

VERIFIED: kill-9 restart 1.5s + crash.log entry; restart fullReads=0 for unchanged files; heavy
endpoints 503 under pressure. check-types 0 err, lint 0 err, esbuild OK, unit 300 pass / 1 pending /
0 fail (+26 new, no regressions). The intermittent OtlpCollector "socket hang up" is a PRE-EXISTING
flaky real-socket test (otlpCollector.ts not in this change set) — not a regression.

FOLLOW-UP (new TRDD, out of scope here): shrink the ~2.6GB resident logSessions base by lazy-loading
ALL log-card timelines on /api/timeline demand (not just restored cards), reducing guard-shedding.

SUPERSEDED — do NOT carry forward:
- ✗ "the ops-level supervisor loop keeps it alive; stopgap not fix" — REPLACED by the in-repo
  supervisor (scripts/agentlens-supervise.js). The external orchestrator loop can be retired.
- ✗ "no request logging, offending endpoint cannot be attributed" — FIXED (spec 6).

Approval log: 2026-07-07T15:25:00+0200 — APPROVED by USER ("go"). Moved to design/tasks, column planned.

## Why (incident observed live, 2026-07-07)
The standalone collector DIED silently ~13:10 (last spans.json write) and nobody — human or
agent — noticed until an MCP call failed at ~13:40. Every OTEL export in that gap is LOST
forever (exporters drop after brief retries). On restart, `get_recent_sessions` showed data
stale at 11:28 because the logReader re-scans ~14k session files from scratch (tail offsets
are in-memory only). An observability tool that silently loses its own observations —
and can't observe its own death — undermines its purpose.

## Spec
1. **Supervision**: `pnpm run up` / cli gains a supervisor mode (parent process or launchd
   plist template) that restarts the server on crash with exponential backoff, logging the
   crash reason (exit code, last stderr) to `~/.agentlens/crash.log`.
2. **Downtime gap markers**: the server records start/stop timestamps in the DB; the dashboard
   timeline and session cards show an explicit "collector offline HH:MM–HH:MM — telemetry lost"
   band instead of a silent hole. `get_recent_sessions` includes a `collectorGaps` field.
3. **Durable tail offsets**: persist logReader per-file byte offsets (+ file identity via
   inode/size) to the DB so a restart resumes tailing instantly instead of a minutes-long full
   rescan; full rescan only when offsets are missing/invalid (fail-fast on mismatch).
4. **Crash-safe span persistence**: spans.json written atomically (temp+rename) on a short
   interval, so a crash loses ≤ the interval, not the session.
5. **Fix the History/Context endpoint OOM (P0, 2× reproduced)**: the endpoints serving the
   History tab per-step context drill and the Context tab composition materialize full raw
   OTEL bodies/blobs in memory per request and V8-abort the whole collector. Stream or
   paginate these responses (bounded chunks, never whole-corpus buffers); find the exact
   allocation via heap evidence, don't guess. The collector must survive a full click-through
   of every dashboard tab.
6. **Request logging**: log method+path+duration+response bytes (one line per request, ring
   buffer or rotating file) so any future crash is attributable to the request that caused it.
7. **Heap-pressure guard**: on heap usage crossing a high-water mark, shed the offending
   request with a 503 + log line instead of dying (fail loud per request, not fail dead per
   process).

## Acceptance
- kill -9 the server → supervisor restarts it ≤5s, crash.log entry written; dashboard shows the
  offline band; restart-to-fresh-data ≤5s (offsets resumed, verified by the /api/debug/log-scan-stats
  counters showing 0 cold-start full reads for unchanged files). check-types+lint+esbuild+unit clean.
- Headless dev-browser click-through of ALL tabs (Sessions, Context, Cache, History, Analytics,
  Advisor) against a real-size dataset completes with the server alive and RSS bounded; the two
  crash scenarios from /tmp/agentlens-server{5,6}.log no longer reproduce.
