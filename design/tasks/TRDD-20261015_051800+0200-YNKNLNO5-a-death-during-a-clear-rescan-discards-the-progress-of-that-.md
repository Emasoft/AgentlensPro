---
trdd-id: YNKNLNO5
title: A death during a clear rescan discards the progress of that rescan
column: backburner
status: tasked
created: 2026-10-15T05:18:00+0200
updated: 2026-10-15T05:18:00+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-15T05:18:00+0200
---

# A death during a clear rescan discards the progress of that rescan

## Problem
`/api/clear` sets clear_in_progress; a death during its in-session full rescan makes the next start refuse reuse and rebuild from the card snapshot, discarding that rescan's appended read positions.

## Impact
Once TRDD-6B7VV2Z7 commit 2 lands, that start's cold scan keeps its own progress, so the cost is one discarded rescan and no card loss. The clear/tick race (reports_dev/6b7vv2z7-optionC-measure.md item 4b) is harmless under TRDD-6B7VV2Z7's design. Low severity.

## Approval log

- 2026-10-15T05:18:00+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
