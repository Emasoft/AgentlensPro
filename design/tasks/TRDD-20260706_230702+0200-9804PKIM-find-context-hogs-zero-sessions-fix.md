---
trdd-id: 9804PKIM
title: Fix cross-session MCP aggregators returning sessionsScanned:0 in the standalone path
column: complete
created: 2026-07-06T23:07:02+0200
updated: 2026-07-06T23:40:00+0200
current-owner: claude-opus-4-8
assignee: claude-opus-4-8
priority: 3
severity: MEDIUM
effort: S
task-type: bugfix
parent-trdd: TKN5VALS
blocked-by: []
pre-block-column: null
relevant-rules: []
release-via: none
delivery: direct-push
target-branch: fix/logreader-large-jsonl
test-requirements: [typecheck, lint]
attempts: 0
implementation-commits: [92b0b2b]
external-refs: []
---

# TRDD-9804PKIM — find_context_hogs 0-sessions fix (follow-on to TKN5VALS)

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-07-06

**Bug:** the MCP tool `find_context_hogs` returns `sessionsScanned: 0, hogs: []`.
The cross-session aggregators — also `get_context_inflation_report` and
`get_cache_break_report --workspace` — do NOT iterate sessions in the standalone
MCP path. They work per-session but the cross-session/workspace scan finds nothing.

**Suspected location:** src/mcpServer.ts (the aggregator loop over sessions) and/or
standalone/server.ts (how it supplies the session list / SessionAccessor to the MCP
handlers — likely no `listSessions`/iterate accessor is passed, so the loop has an
empty set). Verify against the extension path (extension.ts) where it may work.

**UNBLOCKED (2026-07-06):** P7 (TRDD-KT87QPM0) committed `3ab4973` — its shared-file
edits (standalone/server.ts) are landed. column → dev; starting the fix now.
Also fold in the pre-existing `mcpHttpServer` unused-var micro-cleanup at
standalone/server.ts (~L134, from P4, outside the checked tsconfig so it never
failed the gate — but it lives in the same file this fix touches).

**DONE (2026-07-06, commit `92b0b2b`).** ROOT CAUSE was NOT an empty iterator — the
session list was full; the bug was pool SELECTION. All three cross-session handlers
took `sessions.slice(0, N)` of a recency-ordered pool dominated by cards with NO
reconstructable .jsonl (OTEL-only synth-*, sub-agent agent-*, deleted logs), for which
buildContextComposition() returns null → whole N-budget wasted → scanned 0. (Per-session
calls with an explicit UUID always worked — confirmed empirically via
get_context_inflation_report on a real full-UUID session → sessionsScanned:1 real data.)

FIX: `listSessionFileIds()` (contextComposition.ts) — one readdir pass → set of session
ids with a real <id>.jsonl. Shared `fileBackedPool()` (mcpServer.ts) filters the scoped
pool by that set BEFORE slicing; all 3 handlers (hogs, inflation --workspace, cache-break
--workspace) use it + report the honest funnel sessionsConsidered → sessionsWithLog →
sessionsScanned. Also removed the unused `mcpHttpServer` binding (server.ts, the P4
micro-cleanup folded in as planned).

VERIFIED LIVE (restarted standalone :4316 with fixed bundle): find_context_hogs →
considered 18630, withLog 342, scanned 25, top hog "agent catalog" 10.4M tok / 854
injections (the #1 token-waste source); inflation --workspace → considered 58, withLog 2,
scanned 2, runaway agent catalog 102K + skill catalog 95K. check-types(src+media)+lint+esbuild EXIT 0.
