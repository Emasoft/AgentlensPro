---
trdd-id: PGMMB2QG
title: The catch-up card save tombstones every file key the store lacks with no ceiling and three paths have no test
column: backburner
status: tasked
created: 2026-11-17T17:56:24+0100
updated: 2026-11-17T17:58:15+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-17T17:56:24+0100
---

# The catch-up card save tombstones every file key the store lacks with no ceiling and three paths have no test

## Problem
From the read-only review of commit eef01b1d (reports_dev/YR6WX7VQ/20261117_175341+0100-review-eef01b1d.md, findings SHOULD-FIX-3, NIT-1 and the test gaps; save_from at delta_log.rs:832-896 and tick at log_reader.rs:1427-1482 also read by the main agent). After the file pass of TRDD-YR6WX7VQ the hashes in force are the FILE keys, so the next card save tombstones every key the files hold and the card store lacks (delta_log.rs:866-871), and a save that passes the compaction thresholds rewrites the snapshot from the store. That is the intended direction (the store is the truth, TRDD-WCG7I5D8 and TRDD-6B7VV2Z7), and on a copy of the live files the count was 0 (files_not_store 0). But nothing caps the count: if a reused store ever holds FEWER cards than the files (rows lost while the log lines survive), the catch-up removes the card log's copy of those cards, and at commit eef01b1d no stderr line and no counter names how many keys a card save tombstoned (grep of crates/agentlens-core/src for .deleted, cards_deleted and tombstoned, 27 hits, none a production reader of the card save's count; a log line is being added under TRDD-YR6WX7VQ). The copy of the live files does not test this direction: there the store was 30,813 keys AHEAD of the files, and the risk case is a store that holds FEWER.

## Not decided
Whether a ceiling is wanted at all (refuse and log when the files hold many more keys than the store), and at what ratio. The card log is described in delta_log.rs as the fallback when the store is lost; a ceiling protects that role, a store-is-truth design does not need it.

## Acceptance
- [ ] A decision with evidence: ceiling (with its ratio and what the refusal does) or none (with the reason written at the tombstone loop).
- [ ] A test of a stop that lands during the file pass (the forced save is skipped; the next start catches up).
- [ ] A test of a pass that returns Ok on a missing card log with a non-empty store (the early save appends the whole store).
- [ ] A test of a tick inside the timer window (the pass stays owed).
- [ ] The pass is retried, or its one-shot nature after an Err is stated at the flag (review NIT-1).

## Approval log

- 2026-11-17T17:56:24+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
