---
trdd-id: 2D3D2V9F
title: Dashboard per-turn context views hide a re-sent identical block since the dedup change
column: todo
status: tasked
created: 2026-09-25T00:08:56+0200
updated: 2026-09-25T00:09:00+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-09-25T00:08:56+0200
---

# Dashboard per-turn context views hide a re-sent identical block since the dedup change

Since commit e02bb80a (TRDD-ZQQYRYBO I9b), build_context_composition's per-turn `sources` holds only the FIRST occurrence of a (kind, label, content-hash) since the last compaction boundary. media/src/tabs/Traces.tsx:1475 (hostSourcesByTurn), media/src/tabs/ContextTab.tsx:436 (hostByTurn) and Traces.tsx mergeSources read those arrays per turn. A later turn that re-sent, and was billed for, an identical CLAUDE.md or system-prompt block now shows NO row for it.

Evidence: reports/cc-alignment/20260924_194753+0200-I9b2.md ("Coordinator's follow-up").

## Approval log

- 2026-09-25T00:08:56+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## STATE

Next action: decide per consumer (Traces.tsx hostSourcesByTurn, ContextTab.tsx hostByTurn, Traces.tsx mergeSources) whether it needs "resident this turn" or "first occurrence since last boundary", then carry both values, or a per-row re-sent flag, from build_context_composition through to the dashboard. — 2026-09-25
