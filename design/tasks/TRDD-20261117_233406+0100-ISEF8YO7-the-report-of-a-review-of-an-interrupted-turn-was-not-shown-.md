---
trdd-id: ISEF8YO7
title: The report of a review of an interrupted turn was not shown in the four Stop displays that followed
column: dev
status: tasked
created: 2026-11-17T23:34:06+0100
updated: 2026-11-18T05:42:00+0100
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
implementation-commits: [44f31935]
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
- 2026-11-18T00:07:03+0100 — column → dev by main-agent@agentlenspro. the mods-expert-developer agent is working on it (owner directive 2026-11-18)

## Notes

2026-11-17T23:43:23+0100 CAUSE FOUND BY READING (main agent; not reproduced in a probe). The copy that printed the row is 0.7.10 (enabled at user scope per installed_plugins.json; file plugins/cache/emasoft-plugins/agentlenspro-review-mod/0.7.10/hooks/register.js). In it: reviewInterrupted pushes the box to the in-memory list heldInterrupted (line 818); the Stop handler takes the list and prints it (line 1320); the classic.SessionStart handler empties the list (line 1250, comment: a held box belongs to the session that produced it). The transcript shows a compaction at 23:11:10 local with three SessionStart hook entries, after the row (23:07:27) and before the next Stop (23:20:03). So the box was dropped at the session start that follows a compaction. The session id is the same before and after that compaction (one value in the entries on each side), and the same transcript file continues. WHAT WAS NOT LOST: the report reached the model. The prompt context of 23:14:44 local holds one report tagged 'run by the harness, interrupted turn' with VERDICT PASS; the earlier row (22:56:02) has its own at 22:59:19. Two rows, two reports delivered. So the review finished; only the user-facing box and report were dropped, while the row had promised 'box after next reply'. NOT READ: whether the mod event classic.SessionStart carries a source field that says compact; the fix below does not need it. FIX DIRECTION: keep the session id with each held box and at session start drop only the boxes of another session. Source 0.7.11 against installed 0.7.10: 11 diff hunks at lines 54 to 88 and 1033 to 1238, none inside logUsage, reviewInterrupted, defer, reviewAtStop or the three handlers named here; the handler lines are the same text, 10 lines lower in the source (reports_dev/M62ZBT7E/20261117_2345-installed-0710-vs-source-0711.diff, hunk headers read, bodies not read).
2026-11-17T23:52:20+0100 AFTER THE HARNESS REVIEW (main agent): the cause above is a CANDIDATE, not established; box 1 is unticked. CHECKED: the output cap of hooks/show.py cannot explain the missing heading. fit() (installed 0.7.10, lines 71 to 103) keeps the lines before the last box from the START and drops them from the END, and the mod puts a held box at the TOP of the display; the Stop display of 23:20:03 kept its first lines (33 lines, it holds the marker 'report truncated') and its first line is the measure report of that Stop, not a heading 'interrupted turn'. So no held box was in the list at that Stop. NOT SEPARATED: (a) the session start handler emptied the list (code read; that the mod event classic.SessionStart fires after a compaction is inferred from the command-hook entries of the transcript); (b) the in-memory list was lost because the mod module was loaded again around the compaction (not checked at all). Both fall on the same event. What survived that event is known: the pending record, which is an atom, kept the report and delivered it at 23:14:44. FIX DIRECTION REVISED: keep the held boxes in an atom of the plugin store with the session id of each, not in a module variable; this holds under (a) and under (b). Write both session ids to the debug log at session start, so the first live run shows whether they match.
OWNER DIRECTIVE 2026-11-18 00:00 (verbatim): «mods are too complex. only the mods-expert-developer agent can be consulted on them, and developing must be delegated to it.» From here the mod work of this card is designed, written and tested by the agent mods-expert-developer-plugin:mods-expert-developer-agent. The main agent writes no mod code and takes mod questions to that agent.
FACTS READ 2026-11-17 23:50 to 23:57 by the main agent, before the directive above (mods documentation on disk: mods-expert-developer-plugin 0.6.2, skill mods-doc-mods-interfaces, references/chapter.md lines 734 to 874; source agentlenspro-review-mod/hooks/register.js 0.7.11). (1) An atom is $.state: it lasts until the session ends or the user runs /clear, /resume or /branch, and it survives a module reload; a module-level variable lasts only until the module reloads. (2) Chapter line 824: classic.SessionStart also fires at startup and after compaction, and compaction does not reset $.state. (3) The handler of classic.SessionStart in the mod (register.js:1258) has no filter on source and runs heldInterrupted.length = 0 (:1260). CAUSE WORDING: candidate (a) is sufficient by code plus documentation (unfiltered handler; the event fires after compaction; the compaction of 22:11:10 UTC sat between the hold of 22:07:27 UTC and the next Stop). It was not observed running, and candidate (b), the module loaded again, is not excluded. FIX DIRECTION, SUPERSEDES the earlier note that asked for a session id per item and a debug log of both ids: both are dropped, since state is already per session. LEADS for the mods agent, not decisions: hold the boxes in a $.state atom declared in types/index.d.ts; remove the clear at :1260; store rendered lines, not the table object (what $.state accepts beyond JSON was not read); a test run with «claude plugin test» (Claude Code 2.1.326 has the command; help text saved at reports_dev/M62ZBT7E/20261117_2356-plugin-test-help.txt) that is red on 0.7.11 and green on the fix would separate cause (a). After /clear, /resume or a fork the state is already at its default when SessionStart fires, so the mod cannot count dropped boxes from the atom: the «dropped line» branch of box 3 needs a decision (a stated limit in the README, or a count kept elsewhere). NOT FOLDED IN, not checked: stepUsage.clear() sits in the same unfiltered handler; whether a compaction in the middle of a turn drops the usage of the turn under review is unknown.
- 2026-11-18: mod 0.7.12 committed as 44f31935 (plugin.json, README.md, hooks/register.js, types/index.d.ts, tests/held-interrupted.test.ts; tsconfig.json left out, owner file). The five files are sha256-equal to the last tested set (reports_dev/ISEF8YO7/raw/76-FINAL3-sha256.txt); 12 pass, 0 fail; validate exit 0; validate --strict exit 1 as on 0.7.11, with one more warning for an untracked .DS_Store. NOT installed, so the seen-live boxes stay open.
