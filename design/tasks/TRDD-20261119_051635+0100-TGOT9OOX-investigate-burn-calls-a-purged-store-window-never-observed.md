---
trdd-id: TGOT9OOX
title: investigate_burn calls a purged store window never observed
column: todo
status: tasked
created: 2026-11-19T05:16:35+0100
updated: 2026-11-19T05:16:35+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-19T05:16:35+0100
---

# investigate_burn calls a purged store window never observed

A window whose api_call store rows were all removed by the retention purge is read from the store with 0 rows, and investigate_burn then sets coverage.blind to no-bodies-dir and its verdict says that no raw-body directory exists, so this window was never observed (investigator_scan.rs:620-625 and :641-646, read 2026-11-19). The note of the same reply starts with store-first:, which only the store_ok branch writes (:713). Measured 2026-11-19 on the 2.34.0 build in the isolated readers run reports_dev/iso-run/20261119_051117+0100: window ending 2026-10-04T00:16:24Z read 64765 rows before the purge and 0 after, blind no-bodies-dir. The verdict sends the user to agentlenspro setup for data that expired by retention. Related: TRDD-RWDUGF12 (an invalid part also ends in the no-bodies-dir verdict). Not a release blocker: the counts are right, only the label and the advice are wrong.

## Approval log

- 2026-11-19T05:16:35+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
