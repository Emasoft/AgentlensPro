---
trdd-id: YR6WX7VQ
title: File seeding of the card log holds the state lock for seconds to minutes at a reused start
column: todo
status: tasked
created: 2026-11-17T13:18:57+0100
updated: 2026-11-17T13:24:54+0100
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
