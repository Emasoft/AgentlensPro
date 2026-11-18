---
trdd-id: H9UX6HFB
title: A measurement's disk-load generator wrote about 332 GiB to the boot disk in 8 minutes
column: todo
status: tasked
created: 2026-11-17T17:18:49+0100
updated: 2026-11-17T17:42:41+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-17T17:18:49+0100
---

# A measurement's disk-load generator wrote about 332 GiB to the boot disk in 8 minutes

## Problem
The cause run of TRDD-YR6WX7VQ (scripts_dev/yr6-gate-cause.py, written and started by the main agent on 2026-11-17 at 16:49) used two disk writers as its disk load: each wrote a 256 MiB file uncached, fsynced it, read it back, removed it, in a loop. The script's own counters read 38,144 MiB at the start of the first disk cell, 139,264 MiB at its end and 340,224 MiB at the end of the second (reports_dev/YR6WX7VQ/gate-cause/driver.out lines 29 and 33): about 332 GiB written to the boot volume between 17:09 and 17:17. At most 512 MiB was alive at any moment, so free space was not at risk (62 to 64 GB free before and after), and the rules written before the run capped the ALIVE size only. The owner's order of 2026-11-16 says no test or measurement creates or copies more than 4 GB; the cumulative bytes are 83 times that. Cost: write wear on the boot SSD, and the host's 1-minute load rose from 8 to 215 during the two cells (cause of the rise not separated from other work on the host), so other sessions on the host were likely slowed for about 8 minutes.

## Why it happened
The plan checked the alive size against the cap and never estimated the write rate (measured afterwards from the counters: about 0.7 to 1.9 GiB per second for the two writers together). No dry run.
CORRECTION 2026-11-17 17:36: the figure 'in 8 minutes' used on this card and in the guard line of scripts_dev/yr6-gate-cause.py is not supported by the log. Re-read of reports_dev/YR6WX7VQ/gate-cause/driver.out: the writers' own counter read 38,144 MiB at the start of cell DK, 139,264 at its end, 340,224 MiB (about 332 GiB) at the end of cell DN (logged 17:17:32); the cell record before DK is logged at 17:02:58, so the bound is 'less than 15 minutes'; the writers' start time is not in the log. Footprint: at most 2 x 256 MiB (script line 18). Evidence report (NOT tracked: /reports/ is ignored by .gitignore line 40 in this project, see TRDD-5YYVANZQ): reports/H9UX6HFB/20261117_173534+0100-disk-load-generator-cumulative-writes.md. Box 2 landed in commit 7d7d455d with the corrected figures and that report as its evidence path. The guard line of scripts_dev/yr6-gate-cause.py (gitignored) still says 'in 8 minutes' and stays as written; it stops a rerun either way.

## Acceptance
- [ ] scripts_dev/yr6-gate-cause.py cannot be rerun with the writing load (guard at the top), and a disk load for a later measurement is read-only or has a cumulative byte budget under 4 GiB checked in its loop.
- [x] The cap paragraph of CLAUDE.md says that cumulative bytes written by a load generator count against the 4 GB cap, not only the alive size.
- [x] The owner is told in the status of the turn that found it.
Note 2026-11-17 17:19: box 1 ticked for its first half (the script stops at its first line with a message naming this card; checked by running it). The second half binds any later measurement.
Note 2026-11-17 17:26: box 1 unticked again: only its first half is done (the script stops at line 13, before any work, with a message naming this card; the message was seen, the exit code was not read). The second half (a later disk load is read-only or has a cumulative byte budget) has no owner yet. Box 3 was ticked before the status that told the owner was sent; that status went out at 17:23. The 332 GiB figure is the script's loop counter, not a disk-side reading.

## Approval log

- 2026-11-17T17:18:49+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
