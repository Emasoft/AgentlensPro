---
trdd-id: 6DRB39PR
title: search --mask excerpt is anchored on the first literal segment and can lie outside the match
column: ai_review
status: tasked
created: 2026-11-17T11:34:46+0100
updated: 2026-11-17T11:57:12+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-17T11:34:46+0100
implementation-commits: [e343ec69]
---

# search --mask excerpt is anchored on the first literal segment and can lie outside the match

Found while reading commit 7fe63866 (TRDD-O3U0K4HY, increment 3). Status: read from the code, no failing case built yet.

## What the code does
For `--mask`, the excerpt of a hit is positioned with strpos on the FIRST literal segment of the mask (src/cli/searchCli.ts, the Matcher built for a mask, excerpt: around(col, width, strpos(fold(col), fold(anchor)))). The match itself is decided by LIKE over the whole mask. When the first literal segment also occurs earlier in the text than the place where the whole mask matches, the excerpt shows the earlier occurrence, which may not contain the match. With no literal segment the excerpt is the start of the text.

## Why it matters
The excerpt is what an agent reads to decide whether to open the entry with --show. An excerpt outside the match sends it to read an entry for the wrong reason or to skip the right one. The hit, its line and its count are not affected.

## Acceptance
- [x] A test with a text where the first literal segment of the mask occurs before, and outside, the match: the excerpt holds the match. The test fails on 7fe63866.
- [x] The excerpt is positioned on the match (for example with a regular expression built from the mask and regexp_extract or a position function), or the help of --mask says what the excerpt shows. Decision recorded here with its measured cost on the frozen list.
- [x] check-types and lint clean.

## Approval log

- 2026-11-17T11:34:46+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-17T11:36:42+0100 — column → todo by main-agent@agentlenspro. dispatched to one worker with the other two search follow-ups, same two files
- 2026-11-17T11:36:42+0100 — column → dev by main-agent@agentlenspro. dispatched to one worker with the other two search follow-ups, same two files
- 2026-11-17T11:57:11+0100 — column → testing by main-agent@agentlenspro. code e343ec69; three of three boxes ticked
- 2026-11-17T11:57:12+0100 — column → ai_review by main-agent@agentlenspro. main agent's runs done before the move; awaiting the harness review of this turn

## Notes and lessons learned

- 2026-11-17 11:56+0100. DONE in e343ec69. REPRODUCED: on the module of 7fe63866 the excerpt of mask p?rt is the start of the line and does not hold the match, main agent's run. DECISION: code fix, not a help sentence. The mask is also spelled as an RE2 expression (lazy for the star, one character for the question mark, leading and trailing stars dropped) and the window is placed on strpos of regexp_extract; LIKE still decides the hit. COST, worker's measurement on this project's transcripts, mask perm*denied, 20 shown, 918 hits, 1.5GB limit, 9 alternated before and after pairs (c3-ab.txt, c3-ab2.txt): 6 pairs at load 7 to 10 give wall mean 5.97 s before and 6.26 s after (about +5 percent, inside the 4.7 to 7.1 s spread of single runs), user CPU 16.7 against 18.0 s, peak RSS mean 1.552 GB before and 1.484 GB after; the first 3 pairs at load 15 to 23 had RSS up about 5 percent. So no consistent change is shown, on one mask. NOT measured: the excerpt expression alone on a fixed row set; a mask with many stars on very long lines. UNTESTED: the fallback to the start of the text when LIKE matches and the expression finds nothing (case folding differences between ILIKE and RE2); multi-byte characters. Tests cover p?rt, star-wrapped p?rt, --case and a mask holding a quote, in line and prompt mode. Main agent on the final files of commit e343ec69: both diffs read whole, compile-tests 0, the one mocha file 73 passing, check-types 0, eslint --quiet 0; the compiled new tests run against the module of 7fe63866 (builds_dev/o3u-out-7fe63866) give 70 passing and 3 failing, the three new tests (reports_dev/search-followups/main-gate/mocha-unfixed.txt). Worker report: reports_dev/search-followups/20261117_114915+0100-followups-report.md. Harness review of the worker: PASS twice, third round not reviewed (cap). No scanner ran (TRDD-W4RMYOCG). Full suite waits for the push. Column moves testing and ai_review made in one command after these runs.
