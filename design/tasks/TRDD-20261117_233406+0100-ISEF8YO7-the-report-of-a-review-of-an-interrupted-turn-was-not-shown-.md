---
trdd-id: ISEF8YO7
title: The report of a review of an interrupted turn was not shown in the four Stop displays that followed
column: todo
status: tasked
created: 2026-11-17T23:34:06+0100
updated: 2026-11-17T23:34:06+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-17T23:34:06+0100
---

# The report of a review of an interrupted turn was not shown in the four Stop displays that followed

## Problem
Found while checking TRDD-M62ZBT7E against a harness review. In another session on this machine the review mod printed the row "review-mod: interrupted review $0.1587 ... box after next reply" at 23:07:27 local on 2026-11-17. The row promises the report box after the next reply. No heading "interrupted turn 23:07" is in any entry of that transcript from the row to its last entry at 23:31:58 local, across four later Stop displays (23:20:03, 23:25:35, 23:30:38, 23:31:58) and four prompt contexts. No row REVIEW DEFERRED or REVIEW FAILED is there either. The earlier row of the same session (22:56:02) did get its box: heading "interrupted turn 22:56", VERDICT PASS, in the next Stop display.

## Evidence
- Listing of every prompt, queue, hook and flagged entry after the row: reports_dev/M62ZBT7E/20261117_2335-janitor-after-2307.txt (105 lines, read whole by the main agent). A context compaction is at 23:11:10 local (compact_boundary, three SessionStart hooks), between the row and the first later Stop.
- By the 0.7.11 source (agentlenspro-review-mod/hooks/register.js) the held report of an interrupted turn is kept in memory (heldInterrupted) and the row is printed from a finally block for any model call, also when the review did not produce a report. The copy that printed the row was not read: the newest installed copy in the plugin cache is 0.7.10 and the two were not compared.

## Not established
- Whether the review produced a report at all (the row prints either way).
- Whether the compaction or the session start that follows it empties the held reports.
- Whether the report was shown under another heading. The search was for the text "interrupted turn " followed by a time.

## Acceptance
- [ ] The path of a held report from reviewInterrupted to the Stop display is traced in the INSTALLED copy, with file and line, including what a compaction and a session start do to it.
- [ ] The cause of the missing box for the 23:07 row is named, or the limit of what the transcript can show is stated.
- [ ] A held report is shown at the next Stop, or the user gets one line that says it was dropped and why.
- [ ] A probe shows it, and the mod version is bumped.

## Approval log

- 2026-11-17T23:34:06+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
