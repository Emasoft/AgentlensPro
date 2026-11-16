---
trdd-id: ZR3OGSAV
title: save_pass_state silently ignores write and rename failures
column: complete
status: archived
created: 2026-10-22T21:31:33+0200
updated: 2026-10-29T00:41:40+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-22T21:31:33+0200
implementation-commits: [79723010, a9d63615]
---

# save_pass_state silently ignores write and rename failures

pass.rs save_pass_state (rust-core/crates/agentlens-store/src/pass.rs:101-111) discards both the fs::write error and the fs::rename result. A full disk or a permission error leaves the previous .pass-state.json in place with no log line. Skip names are pruned against the directory listing at every pass start (TRDD-2HRA270Y step 1), so a lost prune heals on the next good save; what is lost for real is a stranded name or a skip name added at ingest. A lost skip name means one extra re-read, which dedup makes a no-op. A lost stranded name means a parked file is gated again. The triggers (full disk, permissions) are hypothetical: no incident has been observed. Fix: return a Result, and surface it at every caller (four production callers as of 2026-10-22: chores.rs bodies_pass, server_stats.rs, alstore.rs pass, pass.rs unpark_names; plus one unit test in pass.rs; re-list with tldr references save_pass_state, as line numbers drift), logged every time or rate-limited, never swallowed. State whether a failed save should stop that pass's deletions. Keep the temp-and-rename atomicity. A stale .json.tmp left after a failed rename must also be removed or reported. Found while reviewing TRDD-2HRA270Y step 3 (docs_dev/20261022-step3-predesign.md). Tests inject each failure separately, without relying on a read-only directory, which is unreliable on macOS and under root. For the write branch, use a state path whose parent is a regular file (ENOTDIR). For the rename branch, make the target an existing non-empty directory, so the write succeeds and the rename fails.

## Approval log

- 2026-10-22T21:31:33+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-29T00:41:40+0100 — COMPLETE by main-agent@agentlenspro. acceptance met; commits 79723010 and a9d63615 each reviewed with no blockers, review findings applied in a9d63615.

## Acceptance evidence

Requirement 1, returns a Result: save_pass_state returns std::io::Result<()> at rust-core/crates/agentlens-store/src/pass.rs:102; the temp write error propagates through the ? at pass.rs:112, and the rename error is returned at pass.rs:117. Verified by reading the code this session.
Requirement 2, surfaced at every caller: production callers are chores.rs:782 (bodies pass), alstore.rs:238 (pass, prints the result then exits 3) and alstore.rs:105 (unpark, which calls unpark_names at pass.rs:773, exits 3 with stderr alstore: cannot save and prints no counts). server_stats.rs:735 is inside a unit test and uses unwrap, so the card premise that it is a production caller is wrong. Verified by grep and reading this session.
Requirement 2, logged or rate-limited and never swallowed: chores.rs:782-793 is the rate-limited branch. The first failure logs FAILED to persist (chores.rs:785); repeats only increment the STATE_SAVE_FAILS static (chores.rs:350, 784); the next success logs one recovered-after-N line (chores.rs:789-791). NOT VERIFIED: no test references STATE_SAVE_FAILS or these log lines (grep of rust-core/crates/agentlens-core), so this log path has no test.
Requirement 3, states whether a failed save stops that pass deletions: stated in code at chores.rs:772-781. The bodies pass does not stop: this tick deletions already ran and cannot be rolled back, and the tick returns no error. The delete gate re-verifies content (pass.rs:562, 585-587, 625) and never trusts the name sets. In alstore.rs:238-243 the save runs after ingest_pass, so a failed save cannot undo deletions either; it prints the result and exits 3.
Requirement 4, temp and rename atomicity kept: the temp path is set at pass.rs:108, written at pass.rs:112 and renamed onto the state path at pass.rs:113.
Requirement 5, stale .json.tmp removed after a failed rename: pass.rs:116 removes it, and the removal result is discarded with let underscore, so a removal failure is silent by design (comment at pass.rs:115). Test save_pass_state_reports_a_rename_failure_and_removes_the_temp_file (pass.rs:881) asserts no temp file remains. NOT COVERED: a temp file left by a failed write is not removed (pass.rs:112 uses ?); the card names only the rename case.
Requirement 6, write and rename failures injected separately without a read-only directory: test save_pass_state_reports_a_write_failure (pass.rs:866) makes the temp path an existing directory, so the temp write fails with EISDIR (21). DEVIATION from the card: the card prescribed ENOTDIR (a parent that is a regular file), but the round-2 report found an ENOTDIR write is still caught at the rename, so it could not isolate the write. Test save_pass_state_reports_a_rename_failure_and_removes_the_temp_file (pass.rs:881) makes the state path a non-empty directory.
Requirement 6, mutation results, as reported and NOT re-run by me: the impl report (docs_dev/20261029_000354+0100-ZR3OGSAV-impl-report.md, earlier ENOTDIR design) says a swallowed write error and a rename error turned into Ok each make the new tests fail; the follow-up report (docs_dev/20261029_001350+0100-ZR3OGSAV-review-followups.md, current tests) says the let-underscore write mutation and the removed remove_file each turn their test red.
Requirement 6, CLI and TS exit-3 paths: rust-core/crates/agentlens-store/tests/alstore_cli.rs:11 runs the real alstore binary and asserts exit 3 and stderr alstore: cannot save (line 32). src/test/rustStorePass.test.ts:60 covers pass exit 3 resolving with stateNotSaved and unpark exit 3 rejecting; that test is an xTest and runs only when the alstore binary exists (helper at line 39). The round-2 report says it passed; I did not re-run it.
NOT VERIFIED this session: no test covers the chores.rs failure or recovery log lines; the mutation results above were taken from the reports and not re-run; the round-2 report lists four pre-existing agentlens-core failures that the report says it did not touch and that were not re-run here.
Known gaps, outside the card's stated requirements: the bodies_pass recovery log line has no test; the temp-file removal error after a failed rename is discarded (pass.rs:116); a temp file left by a failed WRITE is not removed (pass.rs:112). Follow-ups filed: TRDD-FINMFYDE (unreadable state read as empty), TRDD-5K0YLLEF (failed-save counter in server stats).

## Acceptance criteria

- [x] (transcribed 2026-10-29 from this card's Fix paragraph, which had no checklist) save_pass_state returns a Result.
- [x] The error is surfaced at every caller, logged or rate-limited, never swallowed.
- [x] Each caller states whether a failed save stops that pass's deletions.
- [x] The temp-plus-rename atomicity is kept.
- [x] A stale .json.tmp is removed or reported after a failed rename.
- [x] Write and rename failures are injected separately in tests, without a read-only-directory trick.
