---
trdd-id: 6DRB39PR
title: search --mask excerpt is anchored on the first literal segment and can lie outside the match
column: dev
status: tasked
created: 2026-11-17T11:34:46+0100
updated: 2026-11-17T11:36:42+0100
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
---

# search --mask excerpt is anchored on the first literal segment and can lie outside the match

Found while reading commit 7fe63866 (TRDD-O3U0K4HY, increment 3). Status: read from the code, no failing case built yet.

## What the code does
For `--mask`, the excerpt of a hit is positioned with strpos on the FIRST literal segment of the mask (src/cli/searchCli.ts, the Matcher built for a mask, excerpt: around(col, width, strpos(fold(col), fold(anchor)))). The match itself is decided by LIKE over the whole mask. When the first literal segment also occurs earlier in the text than the place where the whole mask matches, the excerpt shows the earlier occurrence, which may not contain the match. With no literal segment the excerpt is the start of the text.

## Why it matters
The excerpt is what an agent reads to decide whether to open the entry with --show. An excerpt outside the match sends it to read an entry for the wrong reason or to skip the right one. The hit, its line and its count are not affected.

## Acceptance
- [ ] A test with a text where the first literal segment of the mask occurs before, and outside, the match: the excerpt holds the match. The test fails on 7fe63866.
- [ ] The excerpt is positioned on the match (for example with a regular expression built from the mask and regexp_extract or a position function), or the help of --mask says what the excerpt shows. Decision recorded here with its measured cost on the frozen list.
- [ ] check-types and lint clean.

## Approval log

- 2026-11-17T11:34:46+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-17T11:36:42+0100 — column → todo by main-agent@agentlenspro. dispatched to one worker with the other two search follow-ups, same two files
- 2026-11-17T11:36:42+0100 — column → dev by main-agent@agentlenspro. dispatched to one worker with the other two search follow-ups, same two files
