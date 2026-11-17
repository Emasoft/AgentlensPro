---
trdd-id: YR6WX7VQ
title: File seeding of the card log holds the state lock for seconds to minutes at a reused start
column: todo
status: tasked
created: 2026-11-17T13:18:57+0100
updated: 2026-11-17T13:18:57+0100
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
Change 2 of TRDD-WCG7I5D8 seeds the card-log hashes from the card-log files at a reused start (DeltaLog::seed_written_from_disk, called from restore_reused in log_reader.rs). Measured with real servers on an 82 MB card log (reports_dev/WCG7I5D8/gate4b, gate4c, gate4d): the restore holds the state lock 1,954 to 4,859 ms on a lightly loaded host against 0.00 to 0.02 s unpatched; 10,530 ms under 28 busy processes; 55,630 ms once after a kill while a release compile ran; and after a kill under the busy processes it did not finish inside the run at all (no sweeper_restore_done line, almost no CPU used). No listener is up during the restore. The first card save moves later by the same time. Cause of the slow cases NOT established; untested candidates: the sweeper thread's background priority (the log prints 'qos self-check: bg-runtime worker=background'), disk contention, the post-kill store state.

## Fix direction
Take the file pass off the state lock and off the path that delays the listeners, and make it cheaper (the test seed_hash_equality.rs shows the raw payload bytes of a line hash like the re-serialized parse, which spares the parse and re-serialize). Find the cause of the slow cases first.

## Acceptance
- [ ] The cause of the 55.6 s and of the unfinished restore is established by a run that separates CPU load, disk load and the post-kill state.
- [ ] A patched reused start holds the state lock under 1 s for the file seeding on an 82 MB card log, on a host under a real release compile, after a kill.
- [ ] Gates 4b, 4c and 4d of TRDD-WCG7I5D8 are rerun on the new code and pass; then change 2 may be applied.

## Approval log

- 2026-11-17T13:18:57+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
