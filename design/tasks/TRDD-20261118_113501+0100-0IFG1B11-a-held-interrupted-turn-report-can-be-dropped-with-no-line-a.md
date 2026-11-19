---
trdd-id: 0IFG1B11
title: A held interrupted-turn report can be dropped with no line after a module reload, a failed drop or a stale display file
column: human_review
status: tasked
created: 2026-11-18T11:35:01+0100
updated: 2026-11-19T01:08:28+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-18T11:35:01+0100
implementation-commits: [1266d508]
---

# A held interrupted-turn report can be dropped with no line after a module reload, a failed drop or a stale display file

## Problem
Review mod 0.7.12 (agentlenspro-review-mod). TRDD-ISEF8YO7 made a held interrupted-turn report survive a compaction and print one row when /clear, /resume or /branch drops it. Three cases are left where the user gets neither the box nor a line.

## Cases (by code, from reports_dev/mods-expert-developer-agent/20261118_isef8yo7-boxes.md, Box 3, cases a, c, e; not read by the main agent)
- a. A module reload, then /clear, /resume or /branch before the next Stop: heldCount is 0 after the reload and the command resets the state, so register.js:471 prints nothing.
- c. dropHeld fails (register.js:464-468): only a status line.
- e. hooks/show.py:166: a display file older than 120 s when the hook runs is dropped with no line.
Not in scope, stated limits: b (the session ends before its next Stop) and d (a review still running when the command is given holds its box in the conversation that follows).

## Lead (not a decision)
Keep the count of held boxes where a module reload does not reset it (finding F2 of the report).

## Owner directive
Mod work is designed, written and tested by the agent mods-expert-developer-plugin:mods-expert-developer-agent (owner, 2026-11-18). The main agent writes no mod code.

## Acceptance
- [x] Case a prints the dropped row, or the README states the limit.
- [x] Case c prints a row in the conversation, not only a status line.
- [x] Case e prints one line that says a display was dropped and why.
- [x] Tests cover the three cases and the mod version is bumped.

## Approval log

- 2026-11-18T11:35:01+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-19T00:12:33+0100 — column → dev by main-agent@agentlenspro. dispatched 2026-11-19 to the mods-expert-developer agent with M62ZBT7E (owner directive 2026-11-18)
- 2026-11-19T01:08:28+0100 — column → human_review by main-agent@agentlenspro. built and tested in review mod 0.7.13 (1266d508); the live display check needs the owner

## Result 2026-11-19

2026-11-19T01:08+0100 main agent: landed in review mod 0.7.13, 1266d508. Case a: session.start re-counts held boxes after a reload (relies on the type docs that session.start fires after a reload and that $.state survives it, not checked live; README states the limit). Case c: a row in the conversation. Case e: one line for a stale non-empty display. Evidence (run by the main agent on 1266d508's tree): claude plugin test 23 pass 0 fail; python3 -I tests/test_show.py 10 OK; tsc -p rc 0. Mutations M1-M15 red by the mods agent report (reports/mods-expert-developer-agent/20261119_four-cards.md, read whole; that file is gitignored). NOT run: a live session (Esc + compaction + Stop with a held box over the limit; a reload then /clear; a round-cap deferral then a prompt); the installed mod is still 0.7.10.
