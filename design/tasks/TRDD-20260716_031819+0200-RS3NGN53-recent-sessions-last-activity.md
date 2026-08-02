---
trdd-id: RS3NGN53
title: get_recent_sessions ranks by LAST ACTIVITY — currently-active sessions surface first
column: human_review
created: 2026-07-16T03:18:19+0200
updated: 2026-08-02T11:34:56+0200
current-owner: main
task-type: bugfix
severity: major
scope: project
npt: []
eht: []
---

# get_recent_sessions ranks by LAST ACTIVITY — active sessions surface first

## Defect (found 2026-07-16, this session — USER: "fix all issues")

`get_recent_sessions` relies on the caller's start-date ordering, so a long-running session
started days ago (still emitting spans NOW — e.g. THIS orchestrator session) ranks below fresh
short sessions and can fall off the top-10 entirely. Live-confirmed: 4 actively-emitting sessions
were absent from the default listing while idle newer sessions filled it. "Recent" must mean
recently ACTIVE, not recently STARTED — the tool's stated purpose is "what was I working on".

## Fix

In `handleGetRecentSessions` (src/mcpServer.ts:1343):
- sort by `lastActive = Date.parse(startTime) + durationMs` DESC (never trust caller order),
- add `lastActive` (ISO minute) to each row,
- add `active: true` when lastActive is within the last 5 minutes (the OTEL span-window
  heartbeat cadence bound) — the marker the orchestrator uses to spot live sessions.
- TDD: unit tests for the re-ranking + the active flag (exported handler or via tool dispatch).

## Approval log

- 2026-08-02 — AI review PASSED (ai_review backlog audit): implementation verified present in the code first-hand, not from prose. Column ai_review → human_review; the remaining gate is the human. Evidence: reports/ai-review-audit/20260802_113207+0200-batchA-diagnostics.md
