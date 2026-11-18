---
trdd-id: CXNUWXX7
title: DuckDB readers outside search may read a path with pattern characters as a file pattern
column: complete
status: archived
created: 2026-11-18T11:09:19+0100
updated: 2026-11-18T12:19:09+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-18T11:09:19+0100
implementation-commits: [f2374de6]
---

# DuckDB readers outside search may read a path with pattern characters as a file pattern

## Problem
Opened 2026-11-18 by the main agent when TRDD-E3Y37BU8 closed. That card fixed src/cli/searchCli.ts only: read_ndjson_objects expands star, question mark and open bracket in a path as a file pattern (measured there, DuckDB 1.5.4, macOS), and every read site of that file now goes through the helper sqPath. A grep of src for read_ndjson_objects and read_json names four more modules that were NOT examined: src/ndjsonDuck.ts, src/statuslineStore.ts, src/causingToolCall.ts, src/store/db.ts. src/statuslineStore.ts also calls read_parquet. Their paths sit under the data dir or the Claude config folder, which can hold such characters in a folder name.

NOT known: whether read_json_auto and read_parquet expand a path the same way; which helper quotes the path at each site; whether any of these paths can hold the characters in practice; the Rust readers.

## Acceptance
- [x] Every DuckDB file read site in the four modules is listed with the helper that quotes its path.
- [x] It is measured whether read_json_auto and read_parquet read a path with star, question mark or bracket as a pattern (the three folder pairs of TRDD-E3Y37BU8).
- [x] Either one shared helper is used at every site with a committed test, or it is written here why a site cannot receive such a path.

## Approval log

- 2026-11-18T11:09:19+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-18T12:19:09+0100 — COMPLETE by main-agent@agentlenspro. The three boxes are ticked: sites listed, expansion measured, one shared helper at every read site of the four modules with a committed test (f2374de6). Open limits are written on the card; the Rust readers are TRDD-C6W0SWUT..

## Evidence 2026-11-18

- READ SITES (grep by the main agent over the four modules for read_json, read_json_auto, read_ndjson, read_ndjson_objects, read_parquet, read_csv, parquet_scan, COPY, glob and ATTACH; the worker table is in reports_dev/sonnet-worker/20261118_cxnu/report.md): src/ndjsonDuck.ts line 23, read_json over a list, paths quoted by sqlStr (line 13). src/causingToolCall.ts has no read site of its own; it uses the spec of ndjsonDuck. src/statuslineStore.ts lines 284, 536 and 554 read_parquet; lines 287, 518 and 533 read_json_auto; the COPY of line 533 writes its part with COPY TO; all quoted by q (line 96). src/store/db.ts line 130 read_parquet over a list, line 267 COPY TO; quoted by q (line 109). The three helpers double the single quote and do nothing else. No glob, ATTACH, read_csv or parquet_scan call in the four modules.
- MEASURED (probe scripts_dev/cxnu-glob-probe.cjs; its output of 47 lines read whole by the main agent; DuckDB v1.5.4, node-api 1.5.4-r.1, macOS): with quote-doubling only, read_ndjson_objects, read_json_auto, read_json, read_ndjson and read_parquet, and the list forms of read_json and read_parquet, read a path holding star or question mark as a pattern (the rows of the sibling folder came back too) and a path holding an open bracket as a class (only the sibling folder was read). With the bracket-class escaping of sqPath every cell read exactly its own folder. COPY TO with quote-doubling wrote the literal file in the three folders, tested with no sibling present.
- LIMITS: the probe used a hand copy of sqPath, not the function of the repo. No function of the four modules was run on such a path, so their exposure is inferred from their quoting plus the probe. sqPath passes a path holding a backslash unchanged, so a Windows path is not fixed. A path can hold these characters only through its prefix (the data dir, the Claude config folder, an explicit transcript path); day folders and part names are generated, by the worker reading. The Rust readers were not examined: TRDD-C6W0SWUT.
- DECISION for box 3 (main agent): one shared helper. sq and sqPath move from src/cli/searchCli.ts to a new module src/duckPath.ts; every read site of the four modules and of searchCli.ts uses sqPath; the COPY TO targets keep plain quoting, because COPY TO takes its path literally and a bracket class there would name a different file. Test: each case also reads through the plain quoting and asserts that the sibling rows come back, so the fixture is shown to tell the two apart in every run.
- CORRECTIONS after review (main agent): (1) the folder pairs of the probe were a*b with axb, a?b with azb and a[x]b with axb; they hold the same three characters as the pairs of TRDD-E3Y37BU8 but are not those pairs. (2) The COPY TO target of src/statuslineStore.ts was not in the grep output of the main agent; it was read afterwards: the line after the COPY source reads TO q(out). (3) That COPY TO takes its path literally was measured with plain quoting and no sibling folder (the file landed in the folder with the special name, for all three characters). A COPY TO with an escaped target was NOT run, so the statement that a bracket class there would name a different file is inferred.
- BOX 3 DONE, commit f2374de6: sq and sqPath live in src/duckPath.ts; the read sites of src/ndjsonDuck.ts, src/statuslineStore.ts (reader and the four reads of the seal) and src/store/db.ts use sqPath; the two COPY TO targets keep plain quoting. Test src/test/duckPathPattern.test.ts, 22 tests: before the change 10 fix tests failed and 12 others (9 canaries, 3 unit tests) passed, after it 22 pass (worker runs; counts read by the main agent in red.txt and green.txt, and the test file read whole). After the change 22 existing test files that import the touched modules, and autoSetup.test.ts, were run one file at a time by the main agent: each ended with rc 0 and a passing count (outputs under reports_dev/main-agent/20261118-box3-existing-tests/). NOT covered: Windows backslash paths; the seal for the question mark and bracket pairs; four other local quoting helpers outside the four modules (burnSeismic.ts, causingToolCall.ts, statuslineHistoryCli.ts, bodiesEvidence.ts, named by the worker, not read by the main agent); six test files that import the modules (noCollectionJoint, rustStore, rustStorePass, ingestPass, ingestPassSkipSet, cliUsageContract), excluded by name and not read; the full suite; the Rust readers (TRDD-C6W0SWUT). The bundle was not rebuilt at this commit.
