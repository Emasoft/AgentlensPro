---
trdd-id: JDQR0HDT
title: The snapshot restore path can bring back cards that a schema bump or an interrupted clear meant to drop
column: todo
status: tasked
created: 2026-10-16T09:40:36+0200
updated: 2026-10-16T09:40:50+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-16T09:40:36+0200
project-id: agentlenspro
---

# The snapshot restore path can bring back cards that a schema bump or an interrupted clear meant to drop

Found in the review of the TRDD-6B7VV2Z7 proposal (2026-10-16); pre-existing, not changed by that fix. (1) A CARD_SCHEMA_VERSION bump refuses the card store with the log-delta version current, so restore_from_snapshot puts the snapshot cards (log_reader.rs about 896-954): files that still exist get rebuilt by the rescan, but cards of gone files stay in the old schema, while a LOG_INGEST_VERSION bump drops them as invalid. One policy, argued two ways. (2) An interrupted clear (clear_in_progress refusal) also restores the snapshot cards the clear meant to remove, unless the clear tombstones log-sessions first (unchecked). First step: read the clear path and the schema-bump path and decide whether either should tombstone log-sessions, with a test.

## Approval log

- 2026-10-16T09:40:36+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Acceptance

- [ ] Both paths are read and each has a recorded decision with file:line.
- [ ] Each path that should drop the snapshot cards does, with a test that fails without the change.

## Notes and lessons learned

2026-10-16: created from the review of the 6B7VV2Z7 B' proposal.
