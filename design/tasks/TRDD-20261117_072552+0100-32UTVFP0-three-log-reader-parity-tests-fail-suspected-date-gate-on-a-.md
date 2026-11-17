---
trdd-id: 32UTVFP0
title: Three log_reader_parity tests fail, suspected date gate on a fixture
column: backburner
status: tasked
created: 2026-11-17T07:25:52+0100
updated: 2026-11-17T07:39:35+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-17T07:25:52+0100
---

# Three log_reader_parity tests fail, suspected date gate on a fixture

Seen 2026-11-17 in the checks of TRDD-JDQR0HDT (reports_dev/JDQR0HDT/G-log_reader_parity.txt, read by the main agent: 'test result: FAILED. 24 passed; 3 failed', exit 101). Failing tests of rust-core/crates/agentlens-core/tests/log_reader_parity.rs: restore_backfill_fills_the_correct_deduplicated_value_and_touches_nothing_else, run_1h_backfill_step_persists_before_returning_so_a_hard_exit_loses_nothing, run_1h_backfill_step_does_not_scan_the_whole_card_store. BY THE WORKER'S REPORT, not confirmed: the log says 'flagged 0 transcript(s) ... (1 skipped, older than 30 days)' (the phrase occurs 6 times in the output, counted by the main agent); queue_1h_candidate skips a transcript whose modification time is older than REPARSE_MAX_AGE (30 days), and the fixture transcript is dated 2026-09-25, 53 days before the run. If so the tests have failed since about 2026-10-25 whatever the code. Not done: a run of the same tests on a tree without the JDQR0HDT change (the worker ran no git), so that change is not excluded as the cause by measurement.

## Acceptance

- [ ] The three tests are run on a tree without commit e9782faf (a worktree at its parent) and the result is recorded: same three failures, or not.
- [ ] The cause is recorded with file:line (the age gate and where the fixture gets its date).
- [ ] The tests no longer depend on the calendar date (the fixture's time is set by the test, or the gate takes an injected clock), and pass.

## Notes and lessons learned
2026-11-17T07:34+0100 main agent, CAUSE MEASURED (one variable changed): the three failures come from the AGE OF THE FIXTURE FILE, not from commit e9782faf and not from the other task's uncommitted Rust changes. Read: REPARSE_MAX_AGE (log_reader.rs:875, 30 days) is compared with the transcript's file mtime (log_reader.rs:1156-1160, std::fs::metadata(path).modified()); the tests copy the fixture with std::fs::copy (log_reader_parity.rs:318-327). In the main tree all 4 fixture transcripts carry mtime 2026-09-25 (53 days); in a worktree checked out today they carry today's time. Experiment on the worktree of the PARENT of e9782faf (5010c55a, clean, same test binary both times), output reports_dev/JDQR0HDT/main-mtime-experiment-parent.txt: with the Claude fixture's mtime set to 2026-09-25 the file ends 23 passed, 4 failed (these three, each next to the log line '1 skipped, older than 30 days', plus watcher_advances_a_card_on_growth_without_waiting_for_the_backstop, which TRDD-WBYDQH8K lists as failing about one run in five; a build was running beside it); with the mtime reset to now, 27 passed, 0 failed. One run each. I had written 'the date gate is refuted' in a reply after the parent passed in the fresh worktree: that was wrong, a fresh checkout changes file times as well as code. Not done: the fix. Candidates, not chosen: the tests set the copied transcript's mtime to now, or the gate takes its clock and age from the caller. Until then these three tests fail on any checkout older than 30 days, and pass on a fresh clone, CI included.
2026-11-17T07:39+0100 main agent, CORRECTIONS to the note above. (a) Scope of the claim: the experiment shows the fixture's age is SUFFICIENT for the three failures on the parent of e9782faf, so they are explained by a cause present before that commit; it does not by itself show that the commit or the other task's uncommitted changes add nothing. For the commit that is shown separately: e9782faf alone, own target directory, fresh fixture time, log_reader_parity 27 passed 0 failed (reports_dev/JDQR0HDT/main-baseline-commit-own-target.txt, one run). For the other task's uncommitted changes nothing was measured. (b) The condition is the fixture FILE's mtime being older than 30 days, not the checkout's age. The CI clause is withdrawn as written: ci.yml:305 runs cargo test over the whole workspace, so this file runs in CI, on a fresh checkout whose files carry the checkout time; that it passes there was not read from a CI run. (c) The fourth failure: I read WBYDQH8K whole and the panic. The test name matches that card, and the panic ('re-read from byte 0 sees the grown file', left None, right Some(Number(4)), now at line 679) is the signature that card recorded on 2026-10-17. Its output holds no 'older than 30 days' line. Repeat of the old-mtime arm on the parent, 4 more runs with no cargo build beside (load average 32 to 52), reports_dev/JDQR0HDT/main-mtime-experiment-parent-repeat.txt: each run 24 passed, 3 failed, the same three names; the watcher test passed in all 4. Over the 5 old-mtime runs: the three fail 5 of 5, the watcher test 1 of 5. Five runs do not show whether the old mtime changes the watcher test's rate. (d) Lines read: of the first experiment file the whole failure section (lines 37 to 93) and the result lines; of the repeat file the names and result lines only.

## Approval log

- 2026-11-17T07:25:52+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
