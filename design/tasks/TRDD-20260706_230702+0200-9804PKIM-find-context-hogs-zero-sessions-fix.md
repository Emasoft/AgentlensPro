---
trdd-id: 9804PKIM
title: Fix cross-session MCP aggregators returning sessionsScanned:0 in the standalone path
column: blocked
created: 2026-07-06T23:07:02+0200
updated: 2026-07-06T23:12:00+0200
current-owner: claude-opus-4-8
assignee: claude-opus-4-8
priority: 3
severity: MEDIUM
effort: S
task-type: bugfix
parent-trdd: TKN5VALS
blocked-by: [TRDD-KT87QPM0]
pre-block-column: todo
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

**BLOCKED-BY TRDD-KT87QPM0 (P7):** P7 edits the SAME files (src/mcpServer.ts +
standalone/server.ts) to wire statusline ingestion into the MCP read paths. Running
this concurrently would corrupt P7's in-flight edits. Serialize AFTER P7 commits.
On unblock: restore column → todo → dev.

**NEXT ACTION (after P7 lands + commits):** read the standalone MCP wiring, find
why the session iterator is empty, pass a real session-list accessor, re-verify by
calling find_context_hogs / get_context_inflation_report over the real 18k-session
store (headless standalone on isolated ports) → expect non-zero sessionsScanned +
ranked hogs. check-types(src+media)+lint+esbuild EXIT 0; commit.
