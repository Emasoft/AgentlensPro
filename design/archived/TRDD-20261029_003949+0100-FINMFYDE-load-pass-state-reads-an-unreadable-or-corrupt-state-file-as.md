---
trdd-id: FINMFYDE
title: load_pass_state reads an unreadable or corrupt state file as empty
column: complete
status: archived
created: 2026-10-29T00:39:49+0100
updated: 2026-10-29T01:49:49+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-29T00:39:49+0100
priority: high
labels: [store, durability]
implementation-commits: [0a7186a7, f50374fb]
---

# load_pass_state reads an unreadable or corrupt state file as empty

Found by the review of commit 79723010 (TRDD-ZR3OGSAV). rust-core/crates/agentlens-store/src/pass.rs load_pass_state (pass.rs:84) returns plain (skip, stranded) sets and treats an unreadable or corrupt .pass-state.json as empty, which means "nothing stranded, nothing skipped". Sharpest consequence: alstore unpark (pass.rs unpark_names, pass.rs:773) loads those empty sets and, if the save then succeeds, overwrites the real state file with almost-empty sets, silently destroying every persisted skip and stranded name. The alcore bodies pass (chores.rs:633 calls load_pass_state every tick) also reloads the file each tick, so a corrupt file resets its bookkeeping. Deletion stays safe: the delete gate re-verifies content against the store (pass.rs:562 and 585-587) and does not trust the name sets. Direction: load_pass_state returns io::Result and distinguishes absent (empty is correct) from present but unreadable or corrupt (an error). unpark refuses to save over a state it could not read. The bodies pass moves an unreadable file aside to .pass-state.json.corrupt-<unix_ms>, logs once, and rebuilds from empty sets; if the move fails it skips the tick (changed after the round-1 review rejected skip-the-tick: an unattended server must not halt the drain silently). Acceptance: tests for absent gives empty, corrupt gives Err, and unpark on a corrupt file leaves it byte-identical and exits non-zero; mutation-checked.

## Approval log

- 2026-10-29T00:39:49+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-29T01:49:49+0100 — COMPLETE by main-agent@agentlenspro. all acceptance items evidenced; two review rounds, no open blockers.

## Acceptance criteria

- [x] An absent .pass-state.json loads as empty sets (test).
- [x] A present but corrupt or unreadable .pass-state.json is an error, not empty sets (test).
- [x] alstore unpark on a corrupt state file exits non-zero and leaves the file byte-identical (test).
- [x] alcore bodies_pass moves an unreadable state file aside and rebuilds it; a failed move skips the tick (test for the move).
- [x] Each new test fails when its fix is reverted (mutation-checked).

## Evidence

- Item 1 (absent file loads as empty): pass::tests::load_pass_state_absent_file_is_empty passes on the unchanged tree (docs_dev/fin4-store-test-baseline.txt); code in commit 0a7186a7 and f50374fb (directory-sync exception for volumes that cannot sync a directory).
- Item 2 (corrupt or unreadable state is an error): pass::tests::load_pass_state_corrupt_file_is_an_error passes (docs_dev/fin4-store-test-baseline.txt); code in commit 0a7186a7 and f50374fb (directory-sync exception for volumes that cannot sync a directory).
- Item 3 (unpark on a corrupt file exits non-zero and leaves it byte-identical): pass::tests::unpark_names_refuses_a_corrupt_state_file_and_leaves_it_byte_identical, alstore_cli::unpark_exits_4_and_leaves_a_corrupt_state_file_untouched and alstore_cli::pass_exits_4_and_leaves_a_corrupt_state_file_untouched pass (docs_dev/fin4-store-test-baseline.txt); code in commit 0a7186a7 and f50374fb (directory-sync exception for volumes that cannot sync a directory).
- Item 4 (bodies pass moves the unreadable file aside and rebuilds it): chores_bodies_corrupt_state::bodies_pass_moves_an_unreadable_state_aside_and_rebuilds_it passes (docs_dev/fin4-chores-corrupt-baseline.txt); code in commit 0a7186a7 and f50374fb (directory-sync exception for volumes that cannot sync a directory).
- Item 5 (each new test fails when its fix is reverted): mutations M1-M4 in docs_dev/fin-mut-*.txt and docs_dev/fin2-mut-*.txt record failing tests for the reverted fixes (fin-mut-1, fin-mut-2, fin-mut-3, fin2-mut-1, fin2-mut-4).
- Not tested: the move-failure branch, the log lines, the directory-sync failure path; full agentlens-core suite not run (TRDD-T29F5MOZ, TRDD-AMSCZHF5).
- dir_sync_unsupported_classifies_the_errnos_a_directory_sync_refuses_with (pass.rs) tests the errno classification only (fails when the ENOTSUP arm is dropped, docs_dev/fin5-mut-enotsup-test2.txt); reviews: round 1 (BLOCKER skip-the-tick, resolved by move-aside), round 2 on 0a7186a7 (no blockers; directory-sync finding resolved by f50374fb).
