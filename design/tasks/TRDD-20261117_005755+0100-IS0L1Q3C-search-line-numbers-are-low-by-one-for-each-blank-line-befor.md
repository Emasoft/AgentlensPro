---
trdd-id: IS0L1Q3C
title: search line numbers are low by one for each blank line before the hit
column: backburner
status: tasked
created: 2026-11-17T00:57:55+0100
updated: 2026-11-17T00:57:55+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-17T00:57:55+0100
---

# search line numbers are low by one for each blank line before the hit

Found while tuning TRDD-UIQS9RXZ (2026-11-17). read_ndjson_objects returns no row for a blank line, so the search command's row_number() is not the physical line number after a blank line: each blank line lowers every later number by one (worker probe, 4 physical lines with 2 blank lines, last line numbered 2; main agent probe, 3 lines with 1 blank line, 2 rows). The help text of agentlenspro search states the limit. Measured exposure on this project: 0 of 3,251 transcripts hold a blank line (grep -c on every .jsonl of the project folder, main agent, 2026-11-17). Decide: fix the numbering, or keep the documented limit and add a test that pins it. When fixed, delete the sentence from SEARCH_USAGE in src/cli/searchCli.ts.

## Acceptance
- [ ] A fixture with a blank line between two matching lines has a test, and either the reported numbers are physical or the test pins the documented limit.

## Approval log

- 2026-11-17T00:57:55+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
