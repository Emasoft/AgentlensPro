---
trdd-id: PJC8N1HO
title: Collector resilience — supervision, downtime gap markers, durable tail offsets, zero-loss restart
column: proposal
created: 2026-07-07T13:30:49+0200
updated: 2026-07-07T13:30:49+0200
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

## ⏵ STATE — PROPOSAL (awaiting USER evaluation)

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

## Acceptance
- kill -9 the server → supervisor restarts it ≤5s, crash.log entry written; dashboard shows the
  offline band; restart-to-fresh-data ≤5s (offsets resumed, verified by the /api/debug/log-scan-stats
  counters showing 0 cold-start full reads for unchanged files). check-types+lint+esbuild+unit clean.
