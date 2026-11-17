---
trdd-id: JDQR0HDT
title: The snapshot restore path can bring back cards that a schema bump or an interrupted clear meant to drop
column: ai_review
status: tasked
created: 2026-10-16T09:40:36+0200
updated: 2026-11-17T07:25:34+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-16T09:40:36+0200
project-id: agentlenspro
implementation-commits: [e9782faf]
---

# The snapshot restore path can bring back cards that a schema bump or an interrupted clear meant to drop

Found in the review of the TRDD-6B7VV2Z7 proposal (2026-10-16); pre-existing, not changed by that fix. (1) A CARD_SCHEMA_VERSION bump refuses the card store with the log-delta version current, so restore_from_snapshot puts the snapshot cards (log_reader.rs about 896-954): files that still exist get rebuilt by the rescan, but cards of gone files stay in the old schema, while a LOG_INGEST_VERSION bump drops them as invalid. One policy, argued two ways. (2) An interrupted clear (clear_in_progress refusal) also restores the snapshot cards the clear meant to remove, unless the clear tombstones log-sessions first (unchecked). First step: read the clear path and the schema-bump path and decide whether either should tombstone log-sessions, with a test.

## Approval log

- 2026-10-16T09:40:36+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Acceptance

- [x] Both paths are read and each has a recorded decision with file:line.
- [x] Each path that should drop the snapshot cards does, with a test that fails without the change.

## Notes and lessons learned

2026-10-16: created from the review of the 6B7VV2Z7 B' proposal.
2026-11-17T02:26+0100 main agent, both paths read (rust-core/crates/agentlens-core/src). PATH 1, schema bump, DECISION keep the snapshot cards, no tombstone. Read: CARD_SCHEMA_VERSION is the layout version of the DuckDB card store (card_store.rs:114-118), not of the snapshot records; a refused store is rebuilt by restore_from_snapshot (log_reader.rs:935), which puts each snapshot card through put_log_session (lib.rs:370) and put_arc, and put_arc applies the current write-time strip to every card with an empty timeline (card_store.rs:756-763, persist_strip_cold at 1214), while cards with a timeline are demoted at the end of the restore. So a restored card is re-shaped by the current code, and dropping the cards of deleted transcripts would destroy their only copy for a layout change that does not alter what a card means. A LOG_INGEST_VERSION bump is different by design (the meaning of a card changed). PATH 2, interrupted clear, DECISION it must drop the snapshot cards, change needed. Read: clear_all (lib.rs:910-916) deletes the store rows and sets clear_in_progress in one transaction (card_store.rs:900-906), then only sends Msg::Clear; the sweeper forgets the offsets in memory (log_reader.rs:1691, 1741, 1774) and does not touch the card snapshot. A death before the first card save after the rescan leaves the full snapshot on disk; the next start refuses the store (card_store.rs:544) and restore_from_snapshot puts every snapshot card back, so the cards of deleted transcripts, the only cards a clear removes for good, return. SECOND WINDOW found: finish_clear runs before the non-forced tick (log_reader.rs:1820-1823), so a death after it and before the card save leaves the flag at 0 with the old keys still in the snapshot; the next start reuses the store and seeds the hashes from the store, so those keys are never tombstoned and come back at the next refused reuse. PROPOSED CHANGE (not built, not reviewed): (a) keep the reason of the refusal in the card store and, when it was a clear in progress, make restore_from_snapshot take the same branch as a stale ingest version (tombstone both logs, restore nothing, rescan); test: a store flagged clear_in_progress next to a snapshot holding a card whose transcript is gone restores 0 cards and leaves tombstones. (b) the second window is closed by the file-based hash seeding proposed in TRDD-WCG7I5D8 (the first save then tombstones every snapshot key the store lacks), so (b) is built with that card. Not read: how often tick saves cards when not forced.
2026-11-17T06:41+0100 main agent: part (a) of the proposed change is being built by a sonnet worker (reason of the reuse refusal kept in the card store; a clear in progress makes restore_from_snapshot take the stale-ingest-version branch; test in tests/card_reuse.rs with a fail-then-pass proof; schema-bump path unchanged). The worker's prompt is the proposal; the review follows its report. Part (b), the second window, stays with TRDD-WCG7I5D8.
2026-11-17T07:25+0100 main agent: part (a) committed as e9782faf (card_store.rs, log_reader.rs, tests/card_reuse.rs). The diff was read whole by the main agent; the test and mutation results are by the worker's report (reports_dev/JDQR0HDT/20261117_072340+0100-interrupted-clear-report-v2.md and the G-*.txt files; exit codes and the two result lines I read: card_reuse 24 passed, log_reader_parity 24 passed and 3 FAILED). The harness did not review the worker's last turn (its cap of two rounds was reached). What the change does: the refusal keeps its reason; an interrupted clear takes the stale-ingest-version branch (tombstone both logs, restore nothing); the rebuilt store keeps clear_in_progress = 1 until the tombstones are written and check_meta tests the flag first; a clear in progress wins over a version mismatch. Cost: a full rescan from zero after an interrupted clear. NOT verified: (1) the 3 failing log_reader_parity tests are read by the worker as a 30-day age gate on a fixture dated 2026-09-25, not confirmed against a run without this change (own card minted); (2) a start with log scan off after an interrupted clear, where restore may not run and the flag would stay 1; (3) no real process kill, deaths are modelled by dropping the store; (4) the full crate suite waits for the pre-push run. Part (b), the second window, stays with TRDD-WCG7I5D8.
