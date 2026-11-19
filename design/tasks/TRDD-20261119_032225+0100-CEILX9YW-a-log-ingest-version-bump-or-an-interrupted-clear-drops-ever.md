---
trdd-id: CEILX9YW
title: A log-ingest version bump or an interrupted clear drops every card whose transcript is gone
column: backburner
status: tasked
created: 2026-11-19T03:22:25+0100
updated: 2026-11-19T03:22:25+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-19T03:22:25+0100
---

# A log-ingest version bump or an interrupted clear drops every card whose transcript is gone

## Problem
Read by the main agent on 2026-11-19 (W92 report reports_dev/W92/20261119_031613+0100-box3-exposure.md, card_store.rs and log_reader.rs restore_from_snapshot ~942-1070 as cited there). When log-delta-version.json does not match LOG_INGEST_VERSION, or the card store meta says clear_in_progress=1, restore_from_snapshot tombstones BOTH the card log and the offsets log and restores no card; cards come back only from transcripts still on disk. On this machine at rest, 65,072 of 110,619 cards (58.8%) have no transcript on disk (upper bound: the transcript matcher was spot-checked on 5 ids), so a future bump of LOG_INGEST_VERSION would erase most of the card history on upgrade. The interrupted clear is a user-requested wipe, so only the version-bump path is in question.
Not a 2.34.0 risk: LOG_INGEST_VERSION is 7 at v2.33.1 (log_reader.rs:603 at the tag) and at HEAD (:751), and the live stamp is {"v":7}.

## Acceptance
- [ ] Decide in writing whether a version bump may drop cards that have no transcript, or must migrate them (for example keep card-log entries whose transcript is gone, re-stamped).
- [ ] If they must be kept: a test that bumps the version on a store holding a card with no transcript and shows the card survives.

## Approval log

- 2026-11-19T03:22:25+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
