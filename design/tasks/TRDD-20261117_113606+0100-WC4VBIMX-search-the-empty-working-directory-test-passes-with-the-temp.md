---
trdd-id: WC4VBIMX
title: search - the empty working directory test passes with the temp_directory setting removed
column: ai_review
status: tasked
created: 2026-11-17T11:36:06+0100
updated: 2026-11-17T11:57:06+0100
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
implementation-commits: [e343ec69]
---

# search - the empty working directory test passes with the temp_directory setting removed

Recorded as limit (c) on TRDD-O3U0K4HY; given its own card because that card is closed.

## The test
src/test/searchCli.test.ts, test 'a search run from an empty working directory leaves that directory empty (no .tmp spill folder)' (added in 7fe63866). It runs three searches from an empty folder and asserts the folder is still empty. It guards src/cli/searchCli.ts line 572, SET temp_directory to the empty string, which stops DuckDB from creating a .tmp folder in the working directory of whoever runs the search.

## Why it cannot fail
The fixture is a few kilobytes. DuckDB creates its temp folder only when it spills, and nothing this small spills, so the folder stays empty with or without line 572. Status: INFERRED from reading; the mutation (remove line 572, run the test) has not been run.

## Acceptance
- [x] The mutation is run and its result recorded: line 572 removed, this one test file, pass or fail.
- [x] If it passes: the test is changed so that it fails without line 572 (for example a fixture and an AGENTLENS_DUCKDB_MEMORY_LIMIT small enough to force a spill, within the 4 GB test data cap and well under it), or it is replaced by a check that reads the setting back from the connection. No test that cannot fail is kept.
- [x] check-types and lint clean.

## Approval log

- 2026-11-17T11:36:06+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-17T11:36:40+0100 — column → todo by main-agent@agentlenspro. dispatched to one worker with the other two search follow-ups, same two files
- 2026-11-17T11:36:40+0100 — column → dev by main-agent@agentlenspro. dispatched to one worker with the other two search follow-ups, same two files
- 2026-11-17T11:57:04+0100 — column → testing by main-agent@agentlenspro. code e343ec69; three of three boxes ticked
- 2026-11-17T11:57:06+0100 — column → ai_review by main-agent@agentlenspro. main agent's runs done before the move; awaiting the harness review of this turn

## Notes and lessons learned

- 2026-11-17 11:56+0100. DONE in e343ec69. Box 1: the worker removed the SET line from the compiled module and the old test PASSED (reports_dev/search-followups/c1-mutation-run.txt), so it could not fail. Box 2: replaced by a readback of current_setting('temp_directory') on the connection openDuck returns; on the mutated module it fails with '.tmp' (worker, c1-new-test-on-mutated.txt). On the main agent's run against the module of 7fe63866 it fails because openDuck is not exported there, a different reason, so the '.tmp' failure is the worker's evidence only. WHY NOT a behavioural test: the worker's scratch experiment (spill-exp/output.txt, not rerun by the main agent) shows that DuckDB removes its temp folder when the instance closes, so an empty folder after the run proves nothing even when a spill is forced. LIMIT: the test pins the setting on the one opener; a second opener added later would escape it (today searchCli.ts has one DuckDBInstance.create, read in the diff context and by the worker's grep). The export of openDuck carries no comment saying it is for the test. Main agent on the final files of commit e343ec69: both diffs read whole, compile-tests 0, the one mocha file 73 passing, check-types 0, eslint --quiet 0; the compiled new tests run against the module of 7fe63866 (builds_dev/o3u-out-7fe63866) give 70 passing and 3 failing, the three new tests (reports_dev/search-followups/main-gate/mocha-unfixed.txt). Worker report: reports_dev/search-followups/20261117_114915+0100-followups-report.md. Harness review of the worker: PASS twice, third round not reviewed (cap). No scanner ran (TRDD-W4RMYOCG). Full suite waits for the push. Column moves testing and ai_review made in one command after these runs.
