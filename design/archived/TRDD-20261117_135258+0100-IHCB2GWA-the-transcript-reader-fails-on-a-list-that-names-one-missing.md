---
trdd-id: IHCB2GWA
title: The transcript reader fails on a list that names one missing file, so a transcript deleted between listing and scan may fail a search
column: complete
status: archived
created: 2026-11-17T13:52:58+0100
updated: 2026-11-18T11:02:59+0100
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

# The transcript reader fails on a list that names one missing file, so a transcript deleted between listing and scan may fail a search

## Problem
Found 2026-11-17 13:52+0100 by the main agent while checking a worker's hypothesis in the scanner triage of TRDD-W4RMYOCG. The search lists the transcript files, stats each (src/cli/searchCli.ts line 447 at commit 8590184d; a file gone at that moment is skipped, line 448), and later hands the paths to DuckDB. MEASURED (DuckDB v1.5.4, scratch files, reports_dev/W4RMYOCG/duckdb-glob-in-path-output.txt, lines 'missing in list' and 'missing single'): a path that does not exist makes read_ndjson_objects fail with IO Error: No files found that match the pattern, also when it is one element of a list beside files that exist. So a transcript deleted after the stat and before its scan group runs makes the whole search fail. NOT measured: how the command reports that error to the user, and how often it can happen (a search of this project takes seconds; transcripts are rarely deleted).

## Fix direction
Decide between failing with a message that names the file and says to rerun, and dropping the vanished file from its group and counting it on stderr. The first is the smaller change and hides nothing.

## Acceptance
- [x] It is read what the command prints today when a listed file is gone at scan time (one run on a scratch folder, the file removed between listing and scan by a test hook or a two-step call).
- [x] The chosen behaviour is implemented and a committed test covers it.

## Approval log

- 2026-11-17T13:52:58+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-18T11:02:59+0100 — COMPLETE by main-agent@agentlenspro. both acceptance boxes met by commit a6ea815a, evidence and the uncovered --show case on the card.

## Outcome

2026-11-18, commit a6ea815a. Behaviour before, RUN by a worker at function level (two-step call on a scratch folder, not through the command line; report reports_dev/sonnet-worker/20261118_search-fixes.md): searchTranscripts threw IO Error: No files found that match the pattern, and runSearchCli had no catch, so the error left the command uncaught. CHOSEN by the main agent: fail, with one message that names every vanished file and says to rerun; no skip and no retry, so printed totals always cover every listed transcript. Implemented as vanishedOr in searchTranscripts and searchElements plus a catch in runSearchCli (exit 2). Test in src/test/searchCli.test.ts: one gone file, one gone beside a live one, two gone, in line, count and element modes. NOT covered: search --show on a transcript deleted while it runs (not wrapped, not run); a run through the real command with a file removed between listing and scan.
