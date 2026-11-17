---
trdd-id: WC4VBIMX
title: search - the empty working directory test passes with the temp_directory setting removed
column: dev
status: tasked
created: 2026-11-17T11:36:06+0100
updated: 2026-11-17T11:36:40+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-17T11:36:06+0100
---

# search - the empty working directory test passes with the temp_directory setting removed

Recorded as limit (c) on TRDD-O3U0K4HY; given its own card because that card is closed.

## The test
src/test/searchCli.test.ts, test 'a search run from an empty working directory leaves that directory empty (no .tmp spill folder)' (added in 7fe63866). It runs three searches from an empty folder and asserts the folder is still empty. It guards src/cli/searchCli.ts line 572, SET temp_directory to the empty string, which stops DuckDB from creating a .tmp folder in the working directory of whoever runs the search.

## Why it cannot fail
The fixture is a few kilobytes. DuckDB creates its temp folder only when it spills, and nothing this small spills, so the folder stays empty with or without line 572. Status: INFERRED from reading; the mutation (remove line 572, run the test) has not been run.

## Acceptance
- [ ] The mutation is run and its result recorded: line 572 removed, this one test file, pass or fail.
- [ ] If it passes: the test is changed so that it fails without line 572 (for example a fixture and an AGENTLENS_DUCKDB_MEMORY_LIMIT small enough to force a spill, within the 4 GB test data cap and well under it), or it is replaced by a check that reads the setting back from the connection. No test that cannot fail is kept.
- [ ] check-types and lint clean.

## Approval log

- 2026-11-17T11:36:06+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-17T11:36:40+0100 — column → todo by main-agent@agentlenspro. dispatched to one worker with the other two search follow-ups, same two files
- 2026-11-17T11:36:40+0100 — column → dev by main-agent@agentlenspro. dispatched to one worker with the other two search follow-ups, same two files
