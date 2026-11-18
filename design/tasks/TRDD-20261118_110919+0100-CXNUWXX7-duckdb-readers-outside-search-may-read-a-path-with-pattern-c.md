---
trdd-id: CXNUWXX7
title: DuckDB readers outside search may read a path with pattern characters as a file pattern
column: todo
status: tasked
created: 2026-11-18T11:09:19+0100
updated: 2026-11-18T11:09:19+0100
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
---

# DuckDB readers outside search may read a path with pattern characters as a file pattern

## Problem
Opened 2026-11-18 by the main agent when TRDD-E3Y37BU8 closed. That card fixed src/cli/searchCli.ts only: read_ndjson_objects expands star, question mark and open bracket in a path as a file pattern (measured there, DuckDB 1.5.4, macOS), and every read site of that file now goes through the helper sqPath. A grep of src for read_ndjson_objects and read_json names four more modules that were NOT examined: src/ndjsonDuck.ts, src/statuslineStore.ts, src/causingToolCall.ts, src/store/db.ts. src/statuslineStore.ts also calls read_parquet. Their paths sit under the data dir or the Claude config folder, which can hold such characters in a folder name.

NOT known: whether read_json_auto and read_parquet expand a path the same way; which helper quotes the path at each site; whether any of these paths can hold the characters in practice; the Rust readers.

## Acceptance
- [ ] Every DuckDB file read site in the four modules is listed with the helper that quotes its path.
- [ ] It is measured whether read_json_auto and read_parquet read a path with star, question mark or bracket as a pattern (the three folder pairs of TRDD-E3Y37BU8).
- [ ] Either one shared helper is used at every site with a committed test, or it is written here why a site cannot receive such a path.

## Approval log

- 2026-11-18T11:09:19+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
