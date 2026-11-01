---
trdd-id: HFS3SSLY
title: spill.rs heavy-slot recovery test fails when a sibling test holds the process-wide slot past its 5 s wait
column: backburner
status: tasked
created: 2026-11-01T09:23:32+0100
updated: 2026-11-01T09:23:32+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-01T09:23:32+0100
---

# spill.rs heavy-slot recovery test fails when a sibling test holds the process-wide slot past its 5 s wait

## Symptom

`a_panic_while_holding_the_heavy_slot_does_not_wedge_it` (rust-core/crates/agentlens-store/tests/spill.rs) failed at spill.rs:101 with `busy: another heavy transcript/seismic query is running; retry shortly`, in a full `cargo test -p agentlens-store` run on 2026-11-01 (load average 40 to 130). The deliberate panic at spill.rs:97 ran, so the first acquire succeeded; the second acquire, with its 5 s budget, timed out. The other 6 tests in spill.rs passed. Seen once; not yet reproduced.

## Cause (INFERRED, not yet traced)

`HEAVY` is one process-wide `static Mutex` (agentlens-store/src/transcript_sql.rs:427), and the spill.rs tests run in parallel in one process. `a_forced_chore_wins_against_a_zero_gap_holder` and `a_chore_is_not_starved_by_a_stream_of_heavy_queries` take the slot over and over, so under load the recovery test can wait past its 5 s budget. Which sibling held the slot was not determined. This is a test-isolation race, not a product defect: the test asserts poison recovery but also, by accident, that no sibling holds the slot for 5 s.

Unrelated to TRDD-7YPQWKPG step 2: that change does not touch the store crate, and agentlens-store does not depend on agentlens-core.

## Fix direction

Serialize the spill.rs tests that take `HEAVY` behind one test-local mutex, or move the recovery test into its own test binary, so the assertion measures poison recovery only. Raising the 5 s wait would not remove the race.

## Acceptance

- [ ] The recovery test passes in 20 consecutive full `--test spill` runs under load.
- [ ] It still fails when the poison recovery in `acquire_heavy_within` is removed (mutant).

## Approval log

- 2026-11-01T09:23:32+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
