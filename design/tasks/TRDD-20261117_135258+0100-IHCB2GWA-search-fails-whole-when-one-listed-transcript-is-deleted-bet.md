---
trdd-id: IHCB2GWA
title: search fails whole when one listed transcript is deleted between the listing and the scan
column: todo
status: tasked
created: 2026-11-17T13:52:58+0100
updated: 2026-11-17T13:52:58+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-17T13:52:58+0100
---

# search fails whole when one listed transcript is deleted between the listing and the scan

## Problem
Found 2026-11-17 13:52+0100 by the main agent while checking a worker's hypothesis in the scanner triage of TRDD-W4RMYOCG. The search lists the transcript files, stats each (src/cli/searchCli.ts line 447 at commit 8590184d; a file gone at that moment is skipped, line 448), and later hands the paths to DuckDB. MEASURED (DuckDB v1.5.4, scratch files, reports_dev/W4RMYOCG/duckdb-glob-in-path-output.txt, lines 'missing in list' and 'missing single'): a path that does not exist makes read_ndjson_objects fail with IO Error: No files found that match the pattern, also when it is one element of a list beside files that exist. So a transcript deleted after the stat and before its scan group runs makes the whole search fail. NOT measured: how the command reports that error to the user, and how often it can happen (a search of this project takes seconds; transcripts are rarely deleted).

## Fix direction
Decide between failing with a message that names the file and says to rerun, and dropping the vanished file from its group and counting it on stderr. The first is the smaller change and hides nothing.

## Acceptance
- [ ] It is read what the command prints today when a listed file is gone at scan time (one run on a scratch folder, the file removed between listing and scan by a test hook or a two-step call).
- [ ] The chosen behaviour is implemented and a committed test covers it.

## Approval log

- 2026-11-17T13:52:58+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
