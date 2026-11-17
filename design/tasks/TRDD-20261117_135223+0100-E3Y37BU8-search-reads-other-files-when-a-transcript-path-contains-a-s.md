---
trdd-id: E3Y37BU8
title: search reads other files when a transcript path contains a star, a question mark or a bracket
column: todo
status: tasked
created: 2026-11-17T13:52:23+0100
updated: 2026-11-17T13:58:47+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-17T13:52:23+0100
---

# search reads other files when a transcript path contains a star, a question mark or a bracket

## Problem
Found 2026-11-17 13:52+0100 by the main agent while checking the scanner's two archive-entry warnings on src/cli/searchCli.ts (TRDD-W4RMYOCG). Every DuckDB read in that file passes a transcript path as a quoted SQL string: read_ndjson_objects with a list at lines 851 and 1342, with one path at lines 557, 944, 990, 1021 and 1108 (line numbers of commit 8590184d). The helper sq (line 175) doubles single quotes and nothing else. DuckDB treats star, question mark and bracket in such a path as a file pattern.

MEASURED (DuckDB v1.5.4 through @duckdb/node-api, one-line scratch files, scripts scripts_dev/W4RMYOCG/duckdb-glob-in-path-1.cjs and -2.cjs, output reports_dev/W4RMYOCG/duckdb-glob-in-path-output.txt), single path and list alike:
- a folder named star*dir beside starXdir: the read of the first returns the rows of BOTH files;
- a folder named q?dir beside qZdir: the same, both files;
- a folder named br[ac]ket beside braket: the read returns ONLY the file under braket, not the one asked for; with no braket folder the file asked for is returned.
So with such a path the search reports hits from files outside the scope, or misses the file, with no error.

REACH, read not measured: the transcript folder is the Claude config folder plus projects plus a slug; whether the slug can hold these characters was not checked, and the home or config folder itself can (a volume or folder name with brackets). The search test file has no case for it.
PRECISION added 2026-11-17 13:58+0100: the experiment called read_ndjson_objects directly, with one path and with a list. The search function and its seven read sites were NOT run with such a path; they use that same reader call with the path quoted by sq, and five of the seven line numbers come from a worker's report (557, 944, 990, 1021, 1108), two were seen by the main agent in the source (851, 1342). One run of each script, DuckDB v1.5.4 only.

## Fix direction
Escape pattern characters in every path handed to DuckDB, in ONE helper used by all seven sites, or pass paths in a way that is not pattern-expanded. Which escape DuckDB 1.5.4 honours is to be measured first (a bracket class around the character, or a backslash), with the three folder pairs above as the test.

## Acceptance
- [ ] It is measured which escape makes DuckDB read exactly the named file for star, question mark, and both brackets.
- [ ] All seven read sites go through one helper; a committed test with the three folder pairs fails on the old code and passes on the new.
- [ ] It is read whether the project slug or the sub-agent file names can contain these characters, and the result is written here.

## Approval log

- 2026-11-17T13:52:23+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
