---
trdd-id: 6B7VV2Z7
title: A current-version card store refusal imports offsets ahead of a stale snapshot and loses idle cards
column: todo
status: tasked
created: 2026-10-15T04:28:04+0200
updated: 2026-10-15T04:36:12+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-15T04:28:04+0200
project-id: agentlenspro
---

# A current-version card store refusal imports offsets ahead of a stale snapshot and loses idle cards

## Problem
When the card store refuses to reuse cards.duckdb with a CURRENT ingest version (out-of-memory, a card-schema version mismatch, missing meta, restore_complete != 1, clear_in_progress, open or configure failure, unreadable count or scan, invalid JSON or row), `restore_from_snapshot` restores cards from the NDJSON snapshot and then imports the offsets unconditionally (log_reader.rs:940). Offsets are newer than the snapshot, and the sweep skips every file whose offset record matches (`unchanged()`), so a card missing from or staler in the snapshot is never rebuilt until its file changes. A LOG_INGEST_VERSION bump is NOT affected (a CARD_SCHEMA_VERSION bump IS: it refuses with the log-delta version current): a version-stale restore returns before importing offsets and cold-rescans (log_reader.rs:873-882, verified by MEASURE 2026-10-15). Evidence: reports_dev/0bdov3wc-facts.md Q4, reports_dev/0bdov3wc-measure2.md section 6.

## Fix direction
On a current-version refusal, drop the offsets of files whose card is absent from the snapshot (or re-read them), so the sweep rebuilds them.

## Acceptance
- [ ] A test: cards in the store, offsets saved, snapshot stale; force a current-version refusal; after restore plus one sweep every card is present.

## Approval log

- 2026-10-15T04:28:04+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Notes and lessons learned

2026-10-15: once TRDD-0BDOV3WC revision 3 lands, an out-of-memory error no longer refuses (it stops the server), so it leaves this card's list; the hole stays for every other current-version refusal reason, including a CARD_SCHEMA_VERSION bump.
