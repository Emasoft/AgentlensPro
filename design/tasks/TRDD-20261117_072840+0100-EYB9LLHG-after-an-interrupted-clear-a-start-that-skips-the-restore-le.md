---
trdd-id: EYB9LLHG
title: After an interrupted clear a start that skips the restore leaves the store refused at every start
column: backburner
status: tasked
created: 2026-11-17T07:28:40+0100
updated: 2026-11-17T07:28:40+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-17T07:28:40+0100
---

# After an interrupted clear a start that skips the restore leaves the store refused at every start

Read in commit e9782faf (TRDD-JDQR0HDT), not run: after an interrupted /api/clear the rebuilt card store is written with clear_in_progress = 1, and the only code that clears it on that path is restore_from_snapshot (log_reader.rs, after the two tombstones). If a start does not run that restore (for example a start with the log scan off), the flag stays 1, so the next start refuses the store again and rebuilds it empty, at every start, until a start with the restore runs. Whether such a start exists in production paths was not read.

## Acceptance

- [ ] It is established by reading, with file:line, which start modes skip DurableState::restore.
- [ ] A test starts such a mode after an interrupted clear and shows what the store holds at the following start.
- [ ] If the store is refused forever in that mode, the flag is cleared on that path too, with a test that fails without the change.

## Notes and lessons learned

## Approval log

- 2026-11-17T07:28:40+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
