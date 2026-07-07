---
trdd-id: PJC8N1HO
title: Collector resilience — supervision, downtime gap markers, durable tail offsets, zero-loss restart
column: dev
created: 2026-07-07T13:30:49+0200
updated: 2026-07-07T18:20:00+0200
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
---

# TRDD-PJC8N1HO — Collector resilience + zero-loss ingestion

## ⏵ STATE — DISPATCHED 2026-07-07 18:20 (column dev) — scope EXTENDED with specs 5-7 after 2× reproduced OOM
New evidence (2026-07-07 ~17:45-17:55): the server V8-OOM-aborted TWICE (exit 134, "Ineffective
mark-compacts near heap limit", Node 26, even with --max-old-space-size=6144), both times while the
dashboard History/Context tabs were loading their data. Crash logs: /tmp/agentlens-server5.log +
/tmp/agentlens-server6.log. The log shows only span-ingestion lines before the abort because there is
NO request logging — the offending endpoint cannot be attributed from logs. An ops-level supervisor
loop (orchestrator shell) currently keeps the collector alive; it is a stopgap, not the fix.
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
