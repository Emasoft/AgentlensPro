---
trdd-id: PGMMB2QG
title: The catch-up card save tombstones every file key the store lacks with no ceiling and three paths have no test
column: todo
status: tasked
created: 2026-11-17T17:56:24+0100
updated: 2026-11-17T18:32:18+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-17T17:56:24+0100
---

# The catch-up card save tombstones every file key the store lacks with no ceiling and three paths have no test

## Problem
From the read-only review of commit eef01b1d (reports_dev/YR6WX7VQ/20261117_175341+0100-review-eef01b1d.md, findings SHOULD-FIX-3, NIT-1 and the test gaps; save_from at delta_log.rs:832-896 and tick at log_reader.rs:1427-1482 also read by the main agent). After the file pass of TRDD-YR6WX7VQ the hashes in force are the FILE keys, so the next card save tombstones every key the files hold and the card store lacks (delta_log.rs:866-871), and a save that passes the compaction thresholds rewrites the snapshot from the store. That is the intended direction (the store is the truth, TRDD-WCG7I5D8 and TRDD-6B7VV2Z7), and on a copy of the live files the count was 0 (files_not_store 0). But nothing caps the count: if a reused store ever holds FEWER cards than the files (rows lost while the log lines survive), the catch-up removes the card log's copy of those cards, and at commit eef01b1d no stderr line and no counter names how many keys a card save tombstoned (grep of crates/agentlens-core/src for .deleted, cards_deleted and tombstoned, 27 hits, none a production reader of the card save's count; a log line is being added under TRDD-YR6WX7VQ). The copy of the live files does not test this direction: there the store was 30,813 keys AHEAD of the files, and the risk case is a store that holds FEWER.

## Not decided
Whether a ceiling is wanted at all (refuse and log when the files hold many more keys than the store), and at what ratio. The card log is described in delta_log.rs as the fallback when the store is lost; a ceiling protects that role, a store-is-truth design does not need it.
- 2026-11-17T18:23:25+0100 the question, reduced after a read-only trace (reports_dev/PGMMB2QG/20261117_181000+0100-store-subset-of-log.md, local only, read whole by the main agent) and the main agent's read of compact and commit_verified (delta_log.rs:539-640): compaction writes the snapshot from the store's records only and then removes the delta, so before eef01b1d a key the files held and a reused store lacked was already dropped, without a message, at the first save that compacted (delta over 256 KiB and over the snapshot size). eef01b1d moves that drop to the first card save after the file pass (about 60 s after a reused start) and 119f0716 prints the count. So a ceiling would be a NEW safeguard, not a repair of that change, and TRDD-YR6WX7VQ closes without it. Where a reused store can hold fewer keys than the files: (1) /api/clear followed by a process end before the next card save (up to cards_save, default 300 s): REACHABLE by code reading, not run; the tombstones there are what the clear asked for, so a ceiling MUST exempt a clear or it breaks one. (2) a card-store WAL lost or cut short from outside this code: cannot be ruled out by reading code; this is the only case a ceiling would protect, and what it protects is the interval in which the card log is still a fallback copy for those keys (one tick now, until the next compaction before). (3) a legacy log key that differs from its card sessionId: by save_from as read (tombstone the old key, append under sessionId) this is a re-key, not a loss, because the store holds the card; INFERRED, not run, old data not inspected. Also INFERRED and unverified, from the worker's report: in swap_in_rebuild the live WAL is deleted (card_store.rs:1350) before the rename; a crash between the two loses rows only if FORCE CHECKPOINT (card_store.rs:615) did not fold the WAL into the file.
- 2026-11-17T18:32:17+0100 CORRECTION to the closing entry of TRDD-YR6WX7VQ (archived and frozen, so it is written here) after the harness review. 'The change moves that drop earlier' understated the cost. Compaction needs a delta over 256 KiB AND over the snapshot size. The live card log (listing read at 18:31): snapshot 72,302,940 bytes dated Oct 3, delta 7,416,298 bytes last written Oct 21. So in 18 days the delta reached about a tenth of the size at which a save compacts; at that rate a compaction was months away (a rough reading: the delta's growth in that period was itself held back by the lag of TRDD-WCG7I5D8). Before eef01b1d a key the files held and a reused store lacked therefore stayed in the card log for months in practice, and a non-reused start in that time would have loaded it back (INFERRED, by the worker's report of load). After eef01b1d it is tombstoned about 60 s after a reused start. eef01b1d is in practice the FIRST code that removes such keys. What the fallback copy was worth: a reused start never serves a log-only key, and a non-reused start re-reads every transcript that still exists (by the worker's report, not re-read by the main agent), so the copy mattered for cards whose transcript files are gone, when a store lost rows from outside this code and the next start was not a reused one. Narrow, not nil. DECISION: the closure of TRDD-YR6WX7VQ stands; this card moves from backburner to todo and is added to the blockers of the release card TRDD-HSPUF5XH. ALSO from that review: the count line of 119f0716, on which that acceptance partly rests, has run only in one unit test with no assertion on it and never in a built server (new box below). The title says three paths have no test; the boxes now list four tests and the count-line check; the title is left as it is because a rename moves the file. The trace report's sentence 'no other file runs SQL on the card file' is unchanged in the file; the worker narrowed it to this crate only in its handback.

## Acceptance
- [ ] A decision with evidence: ceiling (with its ratio and what the refusal does) or none (with the reason written at the tombstone loop).
- [ ] A test of a stop that lands during the file pass (the forced save is skipped; the next start catches up).
- [ ] A test of a pass that returns Ok on a missing card log with a non-empty store (the early save appends the whole store).
- [ ] A test of a tick inside the timer window (the pass stays owed).
- [ ] The pass is retried, or its one-shot nature after an Err is stated at the flag (review NIT-1).
- [ ] A test of a process end between finish_clear and the first card save, then a reused start (the store is smaller than the card log and the reuse gate passes; the catch-up save tombstones the cleared keys and prints the count). The existing test a_database_with_a_clear_in_progress covers a kill BEFORE finish_clear only (tests/card_reuse.rs:122, by the worker's report).
- [ ] The count line of 119f0716 has an assertion (a test that fails when the line or its counts are wrong) and has been seen once in the log of a built server.

## Approval log

- 2026-11-17T17:56:24+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-17T18:32:17+0100 — column → todo by main-agent@agentlenspro. the missing ceiling is in practice a new deletion (live delta a tenth of the compaction size after 18 days); blocks the release
