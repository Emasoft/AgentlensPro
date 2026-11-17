---
trdd-id: O4LU9SYJ
title: The first card save comes about 60 s after start whatever the boot sweep took
column: dev
status: tasked
created: 2026-11-17T13:18:58+0100
updated: 2026-11-17T13:33:05+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-17T13:18:58+0100
---

# The first card save comes about 60 s after start whatever the boot sweep took

## Problem
The periodic save is durable.tick(&tailer, &state, false) at the end of each sweeper-loop pass (log_reader.rs:1873 in the worktree builds_dev/wt-jdq-commit), and the pass after the boot sweep is the 60 s backstop sweep. In every real-server run of TRDD-WCG7I5D8's gates the first card save came 61.7 to 68.7 s after start although the boot sweep ended within seconds (reports_dev/WCG7I5D8/gate4b/gate4b-results.json, field card_log_first_changed_at_s). TRDD-WCG7I5D8 counts 492 of 2,114 hard-cap exits under 60 s: those runs save no cards. This is the unmet acceptance box of TRDD-WCG7I5D8.

## Fix direction
Run the first card save right after the boot sweep (one tick there), not at the next backstop pass.

## Acceptance
- [ ] On a real server the card log changes within 5 s of the end of the boot sweep when the sweep ingested cards.
- [ ] A run killed 30 s after start, after its sweep, leaves the ingested cards in the card log.

## Approval log

- 2026-11-17T13:18:58+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-17T13:30:12+0100 — column → dev by main-agent@agentlenspro. cause read, plan on the card, work starts

## STATE

- 2026-11-17 13:30+0100 (clock read), main agent. CAUSE READ in rust-core/crates/agentlens-core/src/log_reader.rs at HEAD 2de80b5c: DurableState::tick (line 1405) returns early until offsets_save (AGENTLENS_OFFSETS_SAVE_MS, default 60,000 ms, line 893) has passed since the state was opened (last_timer, line 1415). The sweeper calls tick only at the end of a loop pass (line 1842), and nothing saves cards between the boot sweep (ends at line 1653) and that first allowed tick. So the first card save cannot come before 60 s, whatever the sweep took. PLAN (one change, two places in that file): (1) a new method on DurableState, save_cards_after_boot_sweep(&mut self, state): when cards_dirty, clear it and call save_cards(state); it does NOT set first_cards_saved, so the first timed tick at about 60 s still makes its early save for cards that arrived in between (an unchanged save writes 0 bytes). (2) start_sweeper calls it once, right AFTER boot_tx.send(Ok(BootReport…)) (lines 1660 to 1667), so the listeners, which wait on that report, are not delayed by the save. Offsets need nothing: ingest_chunk already appends each chunk's read positions after its card puts, so the order contract of save_offsets (cards durable before offsets) is untouched. NOT changed: tick, the 300 s cadence, change 2 of TRDD-WCG7I5D8. KNOWN LIMITS, stated before the work: (a) on a reused start whose store is ahead of the card log the hashes are seeded from the store, so this save writes nothing for those cards; that gap is TRDD-YR6WX7VQ, not this card. (b) The save moves up to 60 s earlier, to the moment right after a cold sweep when memory is highest; its own text peak is bounded by 2de80b5c, the rest of its cost at the live folder's size is not measured. TEST PLAN: one integration test beside the card-log tests (dirty state, call the new method, the card log holds the record with no tick and no wait; a second call writes 0 bytes; a later tick still saves a newly dirty card before the 300 s cadence). Server gate after it: on a scratch copy, a start whose sweep ingests cards shows the card log changed within 5 s of sweeper_boot_sweep_done, and a run killed 30 s after start leaves those cards in the card log (the kill run of gate 4c left the log untouched with the old binary).
- 2026-11-17 13:33+0100 (clock read), main agent, after the harness review of the plan. ADDED LIMIT (c): the window DURING the boot sweep stays open. ingest_chunk appends each chunk's read positions as the sweep goes, and the planned card save comes only after the sweep ends, so a hard-cap kill partway through a long cold sweep still leaves offsets ahead of a card log without those cards. How many of the 492 exits under 60 s died before their sweep ended is NOT known; count it from the exit records before calling the WCG7I5D8 box met. ADDED TO THE SERVER GATE: peak RSS of the new binary against the old one on the same start (the save lands when memory is highest and this card is about hard-cap exits); the sample holds 1,157 cards, so the cost at the live folder's size stays unmeasured and must be stated before any deploy.
