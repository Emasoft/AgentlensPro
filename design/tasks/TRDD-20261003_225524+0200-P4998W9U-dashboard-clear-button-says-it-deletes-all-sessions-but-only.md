---
trdd-id: P4998W9U
title: Dashboard clear button says it deletes all sessions but only deletes OTEL spans
column: backburner
status: tasked
created: 2026-10-03T22:55:24+0200
updated: 2026-10-03T22:55:24+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-03T22:55:24+0200
---

# Dashboard clear button says it deletes all sessions but only deletes OTEL spans

## Symptom
media/src/tabs/Settings.tsx:61 tells the user the button "Permanently deletes all stored sessions. Log-sourced sessions rebuild from local log files on next scan." and :14 confirms "Clear all AgentLens session data? This cannot be undone." The button posts `/action {type:"clearAll"}` (Settings.tsx:14-15), which ui.rs:1496-1512 routes to `CoreState::clear_spans` only: every OTEL span is deleted, all session cards stay, no rescan runs. `POST /api/clear` (ui.rs:1487-1495, `clear_all` lib.rs:703-711) is the path that also clears cards and rescans transcripts from byte 0.
## Not touched by either path
Hook events, statusline store, account-state timeline, bodies (VERIFIED by reading the code, E7).
## Decide
Either make the text say what the button does (deletes OTEL spans; sessions stay), or route the button to /api/clear. Coordinate with TRDD-9VX3WTGU, whose cutover redefines clear semantics.
## Evidence
reports/DUCKPLAN/20261003_225413+0200-e7-usage-monotonic-and-clear.md (gitignored, local), CHECK 2.

## Approval log

- 2026-10-03T22:55:24+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
