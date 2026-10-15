---
trdd-id: 7EZE3AIZ
title: shutdown test times_out_and_names_the_holder fails intermittently under parallel test load
column: todo
status: tasked
created: 2026-10-15T13:28:34+0200
updated: 2026-10-15T13:39:04+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-15T13:28:34+0200
blocked-by: []
---

# shutdown test times_out_and_names_the_holder fails intermittently under parallel test load

## Approval log

- 2026-10-15T13:28:34+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Problem

shutdown::tests::times_out_and_names_the_holder_when_the_lock_is_held_past_the_deadline (rust-core/crates/agentlens-core/src/shutdown.rs, added in 420e6bb9 on 2026-09-03) has failed three times in local full lib runs, with two different symptoms. CI has never run it: ci.yml runs only on push or pull request to main, and the newest ci.yml run is 2026-09-02, before the test existed. CI runs cargo test --workspace without --no-fail-fast or retry, so one occurrence fails the job.
Occurrence 1, copied verbatim from TRDD-RVKQDLRD (an uncommitted note there): 2026-10-03: shutdown::tests::times_out_and_names_the_holder_when_the_lock_is_held_past_the_deadline fails intermittently in the full lib run (1 of 4); UNVERIFIED whether it predates 0a9efdf7 (lib files chores.rs/lib.rs changed) — clean-tree run at 24094e57 pending. Also cosmetic: 'let boot =tokio' in chores.rs needs a space.
Occurrence 2, copied verbatim from TRDD-RVKQDLRD (an uncommitted note there): 2026-10-15: second intermittent failure of the same test. During a full cargo test -p agentlens-core run (A2KNXCNH work, reports_dev/a2knxcnh-impl-report.md) shutdown::tests::times_out_and_names_the_holder_when_the_lock_is_held_past_the_deadline failed once: it reported the lock holder as ui.rs:371 instead of its own site, because the HOLDER_SITE static is shared with concurrently running lib tests. It passed when re-run alone and in the next full run; not seen in earlier 799/0 runs. Classified as an intermittent cross-test race in the test, not a product failure (INFERRED from the reported holder; not reproduced on purpose). Fix direction: make HOLDER_SITE per-test or serialize the tests that set it.
Occurrence 3, 2026-10-15, first plain full run of the 6afa002b work (reports_dev/demote-c2b-full-run1.txt): panicked at shutdown.rs:86, should return close to the deadline, not wait for the holder; 110 passed, 1 failed in the lib binary; passed when re-run alone and in the --no-fail-fast rerun (811 passed, 0 failed).
Mechanism A, timing (read in shutdown.rs, margin INFERRED from the code, not measured): the clock starts before the holder thread is spawned, then the test sleeps 50 ms, then flush_with_deadline polls with a 200 ms deadline and 20 ms sleeps, so a normal return is about 250-270 ms against the 300 ms bound, roughly 30 ms of slack that thread-spawn and sleep overshoot under parallel test load can use up.
Mechanism B, shared holder statics (read in shutdown.rs and its own comment): HOLDER_SITE and HOLDER_SINCE_NS in lib.rs are process-wide and shared by every Mutex<CoreState> in the test binary. The test tolerates None but asserts that a named holder contains shutdown.rs, so a concurrently running test that holds another state lock can make it name that site instead (occurrence 2 named ui.rs:371).
2026-10-15 — Correction to the first line above: three local failures with at least two different symptoms (occurrence 1 recorded no symptom). The CI claim is VERIFIED: ci.yml:299 runs cargo test --manifest-path rust-core/Cargo.toml --workspace, with no --no-fail-fast and no retry (read 2026-10-15).
Mechanism C, inferred from the code, never observed: the test sleeps 50 ms to let the holder thread take the lock. If that thread is not scheduled in time, flush_with_deadline takes the lock first, returns Flushed, and the test panics with expected TimedOut.

## Fix direction

Start the clock immediately before flush_with_deadline and bound the elapsed time well below the 2000 ms holder (for example at most 1000 ms), which still tells returned-at-the-deadline from waited-for-the-holder. For the holder name, either serialize the tests that take a state lock in this binary, or assert only that a named holder is a well-formed site, and keep the exact-site check in a single-threaded test. Do not add a retry.
Also replace the 50 ms sleep with a handshake (a channel the holder thread signals once it holds the lock), so the test never starts polling before the lock is held.

## Acceptance

- [ ] The timing assertion no longer depends on sub-50 ms slack: the bound is measured from just before flush_with_deadline and still fails if the call waits for the 2000 ms holder (verified by a mutation that makes flush wait for the lock).
- [ ] The holder-site assertion cannot be failed by another test holding a different state lock, and the exact-site check still runs somewhere deterministic.
- [ ] 20 consecutive cargo test -p agentlens-core --lib runs under parallel load show zero failures of this test (runs recorded).
