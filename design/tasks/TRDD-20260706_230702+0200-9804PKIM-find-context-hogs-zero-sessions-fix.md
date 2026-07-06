---
trdd-id: 9804PKIM
title: Fix cross-session MCP aggregators returning sessionsScanned:0 in the standalone path
column: dev
created: 2026-07-06T23:07:02+0200
updated: 2026-07-06T23:20:00+0200
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
implementation-commits: []
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

**NEXT ACTION (after P7 lands + commits):** read the standalone MCP wiring, find
why the session iterator is empty, pass a real session-list accessor, re-verify by
calling find_context_hogs / get_context_inflation_report over the real 18k-session
store (headless standalone on isolated ports) → expect non-zero sessionsScanned +
ranked hogs. check-types(src+media)+lint+esbuild EXIT 0; commit.
