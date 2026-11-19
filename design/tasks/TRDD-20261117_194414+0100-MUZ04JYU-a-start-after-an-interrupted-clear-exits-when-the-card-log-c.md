---
trdd-id: MUZ04JYU
title: A start after an interrupted clear exits when the card log cannot be read although that branch discards the log
column: todo
status: tasked
created: 2026-11-17T19:44:14+0100
updated: 2026-11-19T01:25:08+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-17T19:44:14+0100
---

# A start after an interrupted clear exits when the card log cannot be read although that branch discards the log

## Problem
Found by reading on 2026-11-17 while working TRDD-PGMMB2QG; not run. A store whose clear_in_progress flag is 1 is refused reuse and DurableState::restore goes to restore_from_snapshot (log_reader.rs:939). Its first two statements are self.cards.load()? and self.offsets.load()? (:940-941), BEFORE the test of clear_was_interrupted (:949). The interrupted-clear branch restores nothing and tombstones both logs, so it does not need the records, only the keys to tombstone. When the card log has a corrupt line in the middle, load() returns Err, the Err goes to boot_tx (:1733-1736), start_sweeper returns it and alcore prints it and calls exit(1) (bin/alcore.rs:464-467). The restore of a reused start next to the same corrupt card log succeeds (a unit test of DurableState::restore and tick, not a server start: a_corrupt_card_log_makes_the_first_timed_tick_append_nothing_and_not_fail_the_start). So a process end during the rescan of an /api/clear, next to a card log that cannot be read, leaves a server that exits at every start until someone repairs or removes the card log by hand. The stale-version branch shares the code and the same outcome.

## Not known
Whether this has ever happened on a real folder. Whether the same holds for an unreadable offsets log. What the dashboard or the CLI shows the operator in that state.

## Acceptance
- [ ] A test that fails first: clear flag 1 next to a card log with a corrupt middle line; the start returns Err today.
- [ ] The interrupted-clear branch (and, decided in writing, the stale-version branch) does not need a readable card log: it replaces both logs with empty ones without loading them, then stamps the version and resets the flag in the order the comment at :971-977 requires.
- [ ] The normal non-reused branch keeps failing the start on an unreadable card log, or the reason to change that is written here.

## Approval log

- 2026-11-17T19:44:14+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-19T01:25:08+0100 — column → todo by main-agent@agentlenspro. release blocker of TRDD-HSPUF5XH (Release list decision 2026-11-19)
