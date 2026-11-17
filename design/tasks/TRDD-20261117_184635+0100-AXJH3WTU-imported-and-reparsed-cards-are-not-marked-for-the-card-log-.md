---
trdd-id: AXJH3WTU
title: Imported and reparsed cards are not marked for the card log save, so a start that refuses the store can lose them
column: backburner
status: tasked
created: 2026-11-17T18:46:35+0100
updated: 2026-11-17T18:46:35+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-17T18:46:35+0100
---

# Imported and reparsed cards are not marked for the card log save, so a start that refuses the store can lose them

## Problem
Read by the main agent on 2026-11-17 at HEAD 57de4499 (crate rust-core/crates/agentlens-core).
1. Two writers put a card in the store without telling the saver of the card log: `import_card.rs:89` and `ui.rs:1124` (`stamp_and_store_reparsed`) call `CoreState::put_log_session` and nothing else. `mark_dirty` and `cards_dirty` occur only in `src/log_reader.rs` (grep of `src/`, 0 hits elsewhere). So such a card reaches the card log only when another change marks the cards dirty, or at a graceful stop (forced tick, `log_reader.rs:1437`).
2. An imported card has no transcript file. The store holds it at once (`card_store.rs:839`, one committed statement), so a start that REUSES the store keeps it. A start that REFUSES the store takes its cards from the card log and re-reads the transcripts (`log_reader.rs:1053`); an imported card that never reached the card log is then gone.
3. The same refused start loses any card that changed after the last card save (timer of 300 s, `log_reader.rs:897` and `:1483`; longer while the 1h backfill runs, `:1415`) when its transcript no longer exists.
Found while deciding the acceptance box of TRDD-WCG7I5D8. Size of the loss: not measured.

## Acceptance
- [ ] An imported card is in the card log after the next timed tick, shown by a test that fails on the code of today.
- [ ] The same for a card stored by the on-demand reparse.
- [ ] Item 3 is either accepted in writing with its size measured on a copy, or closed by a keyed card append.

## Approval log

- 2026-11-17T18:46:35+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
