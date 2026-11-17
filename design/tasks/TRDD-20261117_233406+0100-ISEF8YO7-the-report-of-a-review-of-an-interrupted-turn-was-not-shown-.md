---
trdd-id: ISEF8YO7
title: The report of a review of an interrupted turn was not shown in the four Stop displays that followed
column: todo
status: tasked
created: 2026-11-17T23:34:06+0100
updated: 2026-11-17T23:52:21+0100
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
- [x] The cause of the missing box for the 23:07 row is named, or the limit of what the transcript can show is stated.
- [ ] A held report is shown at the next Stop, or the user gets one line that says it was dropped and why.
- [ ] A probe shows it, and the mod version is bumped.

## Approval log

- 2026-11-17T23:34:06+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Notes

2026-11-17T23:43:23+0100 CAUSE FOUND BY READING (main agent; not reproduced in a probe). The copy that printed the row is 0.7.10 (enabled at user scope per installed_plugins.json; file plugins/cache/emasoft-plugins/agentlenspro-review-mod/0.7.10/hooks/register.js). In it: reviewInterrupted pushes the box to the in-memory list heldInterrupted (line 818); the Stop handler takes the list and prints it (line 1320); the classic.SessionStart handler empties the list (line 1250, comment: a held box belongs to the session that produced it). The transcript shows a compaction at 23:11:10 local with three SessionStart hook entries, after the row (23:07:27) and before the next Stop (23:20:03). So the box was dropped at the session start that follows a compaction. The session id is the same before and after that compaction (one value in the entries on each side), and the same transcript file continues. WHAT WAS NOT LOST: the report reached the model. The prompt context of 23:14:44 local holds one report tagged 'run by the harness, interrupted turn' with VERDICT PASS; the earlier row (22:56:02) has its own at 22:59:19. Two rows, two reports delivered. So the review finished; only the user-facing box and report were dropped, while the row had promised 'box after next reply'. NOT READ: whether the mod event classic.SessionStart carries a source field that says compact; the fix below does not need it. FIX DIRECTION: keep the session id with each held box and at session start drop only the boxes of another session. Source 0.7.11 against installed 0.7.10: 11 diff hunks at lines 54 to 88 and 1033 to 1238, none inside logUsage, reviewInterrupted, defer, reviewAtStop or the three handlers named here; the handler lines are the same text, 10 lines lower in the source (reports_dev/M62ZBT7E/20261117_2345-installed-0710-vs-source-0711.diff, hunk headers read, bodies not read).
2026-11-17T23:52:20+0100 AFTER THE HARNESS REVIEW (main agent): the cause above is a CANDIDATE, not established; box 1 is unticked. CHECKED: the output cap of hooks/show.py cannot explain the missing heading. fit() (installed 0.7.10, lines 71 to 103) keeps the lines before the last box from the START and drops them from the END, and the mod puts a held box at the TOP of the display; the Stop display of 23:20:03 kept its first lines (33 lines, it holds the marker 'report truncated') and its first line is the measure report of that Stop, not a heading 'interrupted turn'. So no held box was in the list at that Stop. NOT SEPARATED: (a) the session start handler emptied the list (code read; that the mod event classic.SessionStart fires after a compaction is inferred from the command-hook entries of the transcript); (b) the in-memory list was lost because the mod module was loaded again around the compaction (not checked at all). Both fall on the same event. What survived that event is known: the pending record, which is an atom, kept the report and delivered it at 23:14:44. FIX DIRECTION REVISED: keep the held boxes in an atom of the plugin store with the session id of each, not in a module variable; this holds under (a) and under (b). Write both session ids to the debug log at session start, so the first live run shows whether they match.
