---
trdd-id: 5K0YLLEF
title: Count failed pass-state saves in server stats so a full disk stays visible
column: complete
status: archived
created: 2026-10-29T00:39:58+0100
updated: 2026-10-29T02:04:01+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: feature
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-29T00:39:58+0100
priority: medium
labels: [store, observability]
implementation-commits: [805eea34]
---

# Count failed pass-state saves in server stats so a full disk stays visible

Found by the review of commit 79723010 (TRDD-ZR3OGSAV). After TRDD-ZR3OGSAV, a failed .pass-state.json save in the alcore bodies pass (chores.rs bodies_pass, runs every 60s) is logged once to server.log on the first failure only (state-change-only), with repeats counted in the static STATE_SAVE_FAILS (rust-core/crates/agentlens-core/src/chores.rs:350). On a full disk, the likeliest cause, the log line itself may be lost. Expose the consecutive-failure count and the time of the last failure through /api/server-stats, next to the existing bodies-pass figures from bodies_pass_stats() (chores.rs:366), so the condition is visible without writing to disk. Acceptance: the counter appears in /api/server-stats; a test forces a save failure through the pass and reads it back (resetting the per-process static first); mutation-checked.

## Approval log

- 2026-10-29T00:39:58+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-29T02:04:01+0100 — COMPLETE by main-agent@agentlenspro. acceptance evidenced; review of 805eea34 found no blockers.

## Acceptance criteria

- [x] /api/server-stats reports the consecutive failed pass-state saves and the time of the last failure, next to the bodies-pass figures.
- [x] A test forces a save failure through the pass (resetting the per-process STATE_SAVE_FAILS first) and reads the figures back.
- [x] The test fails when the counter is not exposed (mutation-checked).

## Evidence

Item 1: commit 805eea34; /api/server-stats bodies.stateSaveFails and bodies.lastStateSaveFailAt (server_stats.rs), frozen key-order test tests/server_stats.rs updated; 4 passed (docs_dev/5k-server-stats-target.txt).
Item 2: tests/chores_bodies_state_save_fails.rs pass_state_save_failures_reach_server_stats forces EISDIR on the temp path through bodies_pass, resets the statics first, reads both figures back through server_stats, then recovers (count 0, timestamp kept, state file saved); 1 passed (docs_dev/5k-new-test.txt).
Item 3: mutation stateSaveFails reported as 0 makes the test FAIL at the count assertion (docs_dev/5k-mutation-count-zero.txt); restored, passes (docs_dev/5k-new-test-after-undo.txt). The timestamp mutation was not run.
Not tested: a real ENOSPC, the HTTP route, the full agentlens-core suite (TRDD-T29F5MOZ, TRDD-AMSCZHF5). Review of 805eea34: no blockers; follow-ups filed as LDWBRV9B and IAUBGHZQ.
