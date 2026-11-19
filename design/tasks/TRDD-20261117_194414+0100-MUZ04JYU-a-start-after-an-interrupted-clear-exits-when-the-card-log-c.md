---
trdd-id: MUZ04JYU
title: A start after an interrupted clear exits when the card log cannot be read although that branch discards the log
column: human_review
status: tasked
created: 2026-11-17T19:44:14+0100
updated: 2026-11-19T02:33:07+0100
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
- [x] A test that fails first: clear flag 1 next to a card log with a corrupt middle line; the start returns Err today.
- [x] The interrupted-clear branch (and, decided in writing, the stale-version branch) does not need a readable card log: it replaces both logs with empty ones without loading them, then stamps the version and resets the flag in the order the comment at :971-977 requires.
- [x] The normal non-reused branch keeps failing the start on an unreadable card log, or the reason to change that is written here.

## Approval log

- 2026-11-17T19:44:14+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-19T01:25:08+0100 — column → todo by main-agent@agentlenspro. release blocker of TRDD-HSPUF5XH (Release list decision 2026-11-19)
- 2026-11-19T01:38:19+0100 — column → ai_review by main-agent@agentlenspro. code and tests committed; the harness review of this turn is the AI review
2026-11-19 main-agent@agentlenspro: the move todo to ai_review was direct; dev was worker W73 and testing was the main-agent run of sweeper_backstop_tests (23 passed), with no stop in the dev or testing column.
- 2026-11-19T02:33:07+0100 — column → human_review by main-agent@agentlenspro. harness review of the ai_review turn: VERDICT PASS, no blocker (session 2cae0ae7 transcript lines 66493-66494, 2026-11-19T00:40Z); owner moves to complete

## Notes

2026-11-19T01:38:13+0100 main agent: implemented by W73 (report reports_dev/sonnet-worker/20261119_w73-muz04jyu/report.md, read by the main agent). restore_from_snapshot no longer loads either log when a clear was interrupted (log_reader.rs:964-967 read by the main agent); that branch replaces both logs with rewrite_from, which reads neither old file. Box 1: the new test failed before the fix with the corrupt-line Err (worker run, exit 101) and passes after. Box 2: met for the interrupted-clear branch; a second test corrupts the card snapshot and the offsets log too. DECISION in writing on the stale-version branch: it keeps loading both logs, because it tombstones with save(&IndexMap::new()), which diffs against the keys the load seeds (W73 report line 16); so a corrupt card log fails the start there exactly as in the normal branch. Box 3: new test a_normal_start_next_to_a_corrupt_card_log_still_fails_the_start. Behaviour change named: the 'an /api/clear was interrupted' line now prints on every interrupted-clear start, even with empty logs. Main-agent run 2026-11-19: cargo test -p agentlens-core --lib sweeper_backstop_tests, 23 passed, exit 0 (load 18 at start); clippy -D warnings exit 0 by the worker. Not covered: rewrite_from returns Err when a delta cannot be removed, where save did not (decided 2026-11-19: accepted, see Notes and lessons learned).

## Notes and lessons learned

2026-11-19 main-agent review answer: box 2 checked against the whole 58614f10 diff and log_reader.rs 996-1009, read by the main agent: on the interrupted-clear path both rewrite_from calls run, then stamp_version, then finish_clear, the order the JDQR0HDT comment requires. The stale-version branch keeps load+save: delta_log.rs 460 (load seeds written) and 879 (save tombstones only unseen written keys) confirm that save needs the load.
2026-11-19 decision: the new Err path is accepted. rewrite_from returns Err when the old delta cannot be removed (pinned by the delta_log test a_rewrite_from_whose_delta_cannot_be_removed_is_an_err_and_leaves_written_as_it_was), because that delta would replay stale records under the new empty snapshot. At start the ? exits alcore with the error in server.log, the clear flag stays 1, and the next start repeats the branch, so no cleared card is restored. This is the fail-fast the branch comment already states for disk errors.
2026-11-19 scope of the evidence: the restore path returns Ok in unit tests only; no real alcore start against a corrupt card log was run.
