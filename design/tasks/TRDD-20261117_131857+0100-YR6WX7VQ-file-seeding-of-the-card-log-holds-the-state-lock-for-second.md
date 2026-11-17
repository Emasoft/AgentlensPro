---
trdd-id: YR6WX7VQ
title: File seeding of the card log holds the state lock for seconds to minutes at a reused start
column: dev
status: tasked
created: 2026-11-17T13:18:57+0100
updated: 2026-11-17T15:15:01+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-17T13:18:57+0100
---

# File seeding of the card log holds the state lock for seconds to minutes at a reused start

## Problem
Change 2 of TRDD-WCG7I5D8 seeds the card-log hashes from the card-log files at a reused start (DeltaLog::seed_written_from_disk, called from restore_reused in log_reader.rs). Measured with real servers on an 82 MB card log (reports_dev/WCG7I5D8/gate4b, gate4c, gate4d): the restore holds the state lock 1,954 to 4,859 ms on a lightly loaded host against 0.00 to 0.02 s unpatched; 10,530 ms under 28 busy processes; 55,630 ms once after a kill while a release compile ran; and after a kill under the busy processes (run D4, 1-minute load 129.3 at start, 257.8 at the end, part of it from other work on the host) it did not finish inside the run: D4.log, read whole, ends at sweeper_restore_start (up 2.19 s), the driver stopped the process 97.2 s after start by its idle rule (under 0.7 s CPU in 30 s), and the process had used 6.2 CPU-seconds by then, more than the 3.83 CPU-seconds of the whole D3-patched run whose restore did finish. That the state lock was held in D4 is inferred (the lock line prints only at release; the lock is taken at log_reader.rs:1650). There is NO unpatched run after a kill under that load: the unpatched kill run K4 needed 23,482 ms for a sweep that takes about 1,000 ms on a quiet host, so the host starved the unpatched server too, and how much of D4's stall belongs to change 2 is not known. No listener is up during the restore. The first card save moves later by the same time. Cause of the slow cases NOT established; untested candidates: the sweeper thread's background priority (the log prints 'qos self-check: bg-runtime worker=background'), disk contention, the post-kill store state.

## Fix direction
Take the file pass off the state lock and off the path that delays the listeners, and make it cheaper (the test seed_hash_equality.rs shows the raw payload bytes of a line hash like the re-serialized parse, which spares the parse and re-serialize). Find the cause of the slow cases first.

## Acceptance
- [ ] The cause of the 55.6 s and of the unfinished restore is established by a run that separates CPU load, disk load and the post-kill state.
- [ ] A patched reused start holds the state lock under 1 s for the file seeding on an 82 MB card log, on a host under a real release compile, after a kill.
- [ ] Gates 4b, 4c and 4d of TRDD-WCG7I5D8 are rerun on the new code and pass; then change 2 may be applied.
- [ ] Control arm added to the rerun of gate 4d: the UNPATCHED binary started after a kill under the same load as the patched one, so the patch's share of a slow start can be read (added 2026-11-17 13:24+0100 after reading D4.log and K4.log whole).

## Approval log

- 2026-11-17T13:18:57+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-17T15:14:39+0100 — column → dev by main-agent@agentlenspro. plan on the card, proposal under review

## STATE

- 2026-11-17 15:15+0100 (clock read), main agent. NOTE: commit e1058992 says this plan is on the card, but the append had failed (no STATE section yet); it is written now. PLAN, second version (the first, 'file pass at the top of save_cards', was refused by the harness review: it assumed save_cards is the only card-log writer, and it put a 2 to 55 s pass in front of the first save that 30af4548 had just moved to the sweep end). READ BY ME at HEAD in log_reader.rs: three card-log write sites: save_cards (:1339, save_from at :1353), save_cards_for (:1382, append_changed at :1387, called only by the 1 h backfill step at :1251), and restore_from_snapshot's tombstone save (:972, the refused-reuse branch). save_cards locks the state twice, briefly (:1347 the Arc snapshot, :1359 two counters) and takes the mutex itself, so no caller can hold it; tick (:1418) holds no lock around it. The DurableState is created and used only inside the sweeper thread's closure (:1626 on), so nothing else writes the card log while that thread runs a file pass. DESIGN: (1) restore_reused is unchanged (store seed under the lock as today) except that its success path sets a new flag seed_from_files_pending. (2) The boot-sweep save of 30af4548 is unchanged: it runs at once with the store-derived hashes. (3) In tick, non-forced path only, after the timer gate and the offsets save and before the card-save condition: when the flag is set, clear it and run DeltaLog::seed_written_from_disk() (ported from builds_dev/wt-jdq-commit, delta_log.rs :500 there); Ok: the file-derived hashes replace the store-derived ones and cards_dirty is set, so the early timed save that follows appends what the files lack and tombstones what the store dropped; Err: the existing 'card log unreadable' line, hashes stay store-derived, cards NOT marked dirty (the earlier ruling, unchanged). (4) A forced tick (stop) does not run the pass. WHY THE OTHER WRITE SITES ARE SAFE with store-derived hashes: save_cards_for only appends records whose hash differs, and the later file pass re-reads the files including those lines; the :972 save is on the refused-reuse path, which never sets the flag. COSTS: the catch-up comes at the first timed tick (about 60 s) plus the pass, so a run that dies before that does not catch up (a later run that lives a minute does); the pass runs on the sweeper thread and delays that one loop pass (live ingestion) by its duration, once per reused start (measured so far 2 to 5 s quiet, 10.5 s under 28 busy processes, 55.6 s once under a compile); no lock is held; boot, listeners and the first save are untouched. BASELINE for the gate: unpatched restore 0.02 s with no lock line (D3-base, gate 4d, about 1,160 cards); the store seed's lock hold at the live folder's card count has never been measured. NOT in this step: hashing raw line bytes (cheaper pass); the cause of the 55.6 s. FILES: src/delta_log.rs (that one function and its two unit tests; ReplayIndex, index_files, visit_winners are already at HEAD), src/log_reader.rs (flag, its set, the tick block, a unit test), tests/card_reuse.rs (reuse tests adapted to 'catch-up at the first timed tick'). The untracked seed_hash_equality.rs and seed_hash_real_probe.rs are not ported. GATE PLAN: scratch folder name must contain wcg-gate4 under /private/tmp; refuse to start under 30 GB free on the boot disk; one run at a time. STATUS: proposal sent for the harness review; NOTHING written to source. RESUME: if the review passes, brief ONE sonnet worker with this plan in a new worktree at HEAD (not wt-jdq-commit, which is on a1664052), tests by name only, mutation run on the tick block, then the gate; if it blocks twice, take it to the owner.
