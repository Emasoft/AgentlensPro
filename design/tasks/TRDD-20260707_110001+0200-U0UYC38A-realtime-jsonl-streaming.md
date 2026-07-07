---
trdd-id: U0UYC38A
title: Realtime incremental jsonl streaming — tail every session log, live-refresh the dashboard
column: todo
created: 2026-07-07T11:00:01+0200
updated: 2026-07-07T11:00:01+0200
current-owner: null
assignee: null
priority: 1
severity: HIGH
effort: L
task-type: feature
parent-trdd: TRDD-TKN5VALS
relevant-rules: []
release-via: none
target-branch: fix/logreader-large-jsonl
test-requirements: [typecheck, lint]
impacts: []
external-refs: []
---

# TRDD-U0UYC38A — Realtime incremental jsonl streaming

## ⏵ STATE — READ FIRST
User: "the jsonl is not read as streaming and updated with the latest content, instead only the otel
data is shown … every single change to the jsonl sessions must be tracked in realtime."

**Current state (verified):** `standalone/server.ts` already has `fs.watch(dir,{recursive:true})` on the
Claude project dirs + a 5s `setInterval(runLogScan)` + SSE push of the session summary. BUT `runLogScan()`
calls `logReader.scan()` which RE-SCANS whole files each time (not incremental), and the on-demand
composition/history/`sessionCompositions`/`sessionHistories` caches (media/src/state.ts) are fetched ONCE
and NEVER refreshed when a session's jsonl grows. So the live view lags and the History/trace of the
ACTIVE session is a stale snapshot.

## Spec
1. **Incremental tail** in `src/logReader.ts`: track per-file byte offset; on a watch event read only the
   APPENDED bytes (new lines) and update that session's card/timeline incrementally, instead of re-parsing
   the whole file. Keep the full-scan as the cold-start/fallback path.
2. **Push deltas over SSE**: when a session changes, push a targeted update (that session's card + a
   `sessionChanged: <id>` signal) not just the whole summary. Debounce ~300ms (already present).
3. **Live-refresh the drill caches**: when the ACTIVE/selected session's jsonl grows, invalidate its
   entry in `sessionCompositions` / `sessionHistories` (media/src/state.ts) so the History tab + the
   Traces composition re-fetch and show the newest turns live (guard against refetch storms — only
   invalidate when the byte offset advanced AND the tab is showing that session).
4. **Coalesce** with OTEL: OTEL sessions already stream live via the SessionStore span window; make the
   jsonl-derived sessions feel equally live (sub-second after a write, not 5s).

## Acceptance
- Editing/growing a live session's `.jsonl` reflects in the dashboard (session list + the open History
  tab) within ~1s without a manual refresh; no full-file rescans on each append (verify via a log/counter);
  no refetch storms. check-types+lint+esbuild clean; headless proof appending to a fixture jsonl.
