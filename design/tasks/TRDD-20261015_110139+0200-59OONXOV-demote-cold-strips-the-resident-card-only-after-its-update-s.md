---
trdd-id: 59OONXOV
title: demote_cold strips the resident card only after its UPDATE succeeds and no test pins that order
column: todo
status: tasked
created: 2026-10-15T11:01:39+0200
updated: 2026-10-15T13:38:52+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-15T11:01:39+0200
implementation-commits: [3f152419]
---

# demote_cold strips the resident card only after its UPDATE succeeds and no test pins that order

## Problem
Derived from the review of f9e0742e (TRDD-KMF02UEX). demote_cold writes each card to DuckDB first and strips the resident copy only after the UPDATE returned Ok, so an error part-way leaves every card stripped in both or in neither. That order is verified by reading only: the error-path test drops the table, which fails before the loop starts, so a refactor that strips first would pass every test.

## Fix direction
A test on the in-module recipe of demote_cold_succeeds_where_the_old_one_shot_query_runs_out_of_memory (spilling off before any put, 50 cards x 20 entries x 1 KB) at 6 MiB, where the worker measured demote_cold(1) returning Err inside its per-card UPDATEs in 5 of 5 runs: after the Err, table timeline_len and the resident timeline agree card by card. Precondition asserted: the Err comes from the UPDATE ("store the demoted card"). Mutation: strip the resident entry before the UPDATE; the test must fail.

## Acceptance
- [x] A test fails when demote_cold strips a resident card before that card has been UPDATEd successfully.

## Approval log

- 2026-10-15T11:01:39+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
2026-10-15 — Acceptance met by 3f152419: demote_cold_strips_a_resident_card_only_after_its_update uses a UNIQUE index on timeline_len so the second UPDATE fails on every platform with no memory limit; mutation (strip before the UPDATE) fails it; 5 of 5 probe runs passed; still green at 6afa002b (card_store module 11 passed).

## Results

2026-10-15 — Correction to the Approval-log line of 2026-10-15: the UNIQUE-index failure was measured on macOS and in a linux/amd64 container (b4cdf24c tree 5 of 5 module runs, 6afa002b tree 5 of 5), not on every platform; the module run reported green at 6afa002b ran on the bytes later committed as 6afa002b. 650fa0c2 adds a fetch-count assertion to this test for TRDD-MEPIRHI4.
