---
trdd-id: RSV3UEJ9
title: search --word in line mode reads a literal backslash before n r or t as a word edge
column: backburner
status: tasked
created: 2026-11-17T11:34:47+0100
updated: 2026-11-17T11:34:47+0100
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
---

# search --word in line mode reads a literal backslash before n r or t as a word edge

Found while reading commit 7fe63866 (TRDD-O3U0K4HY, increment 3). Status: INFERRED from the code, not reproduced.

## What the code does
In line mode the search runs on the raw JSON line, where a newline, a carriage return and a tab of the text are written as a backslash followed by n, r or t. So --word accepts that two-character escape as a word edge (src/cli/searchCli.ts line 272 at 7fe63866: the edge alternative added when rawLine is true). A LITERAL backslash followed by n, r or t in the text (a Windows path such as C:\\new, a regular expression, a LaTeX command) is written in the raw line as two backslashes and the letter, and the second backslash plus the letter reads as the same escape. Then --word ew would report the ew of new as a whole word, although in the text it is preceded by the letter n.

## Scope
Line mode only. Element mode searches the decoded text, where this cannot happen.

## Acceptance
- [ ] A fixture line whose text holds a literal backslash followed by new: --word ew in line mode finds nothing, and --word new still finds it. The test fails on 7fe63866 (this also settles whether the defect is real).
- [ ] The edge is taken only when the backslash is itself not escaped (an even number of backslashes before it), or the limit is stated in the help of --word.
- [ ] check-types and lint clean.

## Approval log

- 2026-11-17T11:34:47+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
