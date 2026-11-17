---
trdd-id: RSV3UEJ9
title: search --word in line mode reads a literal backslash before n r or t as a word edge
column: ai_review
status: tasked
created: 2026-11-17T11:34:47+0100
updated: 2026-11-17T11:57:08+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-17T11:34:47+0100
implementation-commits: [e343ec69]
---

# search --word in line mode reads a literal backslash before n r or t as a word edge

Found while reading commit 7fe63866 (TRDD-O3U0K4HY, increment 3). Status: INFERRED from the code, not reproduced.

## What the code does
In line mode the search runs on the raw JSON line, where a newline, a carriage return and a tab of the text are written as a backslash followed by n, r or t. So --word accepts that two-character escape as a word edge (src/cli/searchCli.ts line 272 at 7fe63866: the edge alternative added when rawLine is true). A LITERAL backslash followed by n, r or t in the text (a Windows path, a regular expression, a LaTeX command: one backslash, then the letter) is written in the raw line as two backslashes and the letter, and the second backslash plus the letter reads as the same escape. Then --word ew would report the ew of new as a whole word, although in the text it is preceded by the letter n.

## Scope
Line mode only. Element mode searches the decoded text, where this cannot happen.

## Acceptance
- [x] A fixture line whose text holds a literal backslash followed by new: --word ew in line mode finds nothing, and --word new still finds it. The test fails on 7fe63866 (this also settles whether the defect is real).
- [x] The edge is taken only when the backslash is itself not escaped (an even number of backslashes before it), or the limit is stated in the help of --word.
- [x] check-types and lint clean.

## Approval log

- 2026-11-17T11:34:47+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-17T11:36:41+0100 — column → todo by main-agent@agentlenspro. dispatched to one worker with the other two search follow-ups, same two files
- 2026-11-17T11:36:41+0100 — column → dev by main-agent@agentlenspro. dispatched to one worker with the other two search follow-ups, same two files
- 2026-11-17T11:57:07+0100 — column → testing by main-agent@agentlenspro. code e343ec69; three of three boxes ticked
- 2026-11-17T11:57:08+0100 — column → ai_review by main-agent@agentlenspro. main agent's runs done before the move; awaiting the harness review of this turn

## Notes and lessons learned

- 2026-11-17 11:56+0100. DONE in e343ec69. REPRODUCED: on the module of 7fe63866 --word ew in line mode returns line 1 of the fixture (text C, colon, backslash, new), main agent's run. Fix: the raw-line escape counts as an edge only after an even run of backslashes (RE2 has no lookbehind, so the run is spelled out). The test runs line mode and prompt-element mode and also keeps real newline, tab and carriage return as edges. NOT run: the element-mode half against the unfixed module on its own (the test stops at the first failing assert, which is line mode), so 'element mode was never affected' rests on reading. Main agent on the final files of commit e343ec69: both diffs read whole, compile-tests 0, the one mocha file 73 passing, check-types 0, eslint --quiet 0; the compiled new tests run against the module of 7fe63866 (builds_dev/o3u-out-7fe63866) give 70 passing and 3 failing, the three new tests (reports_dev/search-followups/main-gate/mocha-unfixed.txt). Worker report: reports_dev/search-followups/20261117_114915+0100-followups-report.md. Harness review of the worker: PASS twice, third round not reviewed (cap). No scanner ran (TRDD-W4RMYOCG). Full suite waits for the push. Column moves testing and ai_review made in one command after these runs.
