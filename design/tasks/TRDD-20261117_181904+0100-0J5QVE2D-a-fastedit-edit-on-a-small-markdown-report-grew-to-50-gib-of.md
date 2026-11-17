---
trdd-id: 0J5QVE2D
title: A fastedit edit on a small Markdown report grew to 50 GiB of memory and filled 41 swap files
column: backburner
status: tasked
created: 2026-11-17T18:19:04+0100
updated: 2026-11-17T18:19:04+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-17T18:19:04+0100
---

# A fastedit edit on a small Markdown report grew to 50 GiB of memory and filled 41 swap files

## What happened

On 2026-11-17 a background worker ran `fastedit edit <report.md> --replace "<heading text>" --snippet "<about 700 characters>"` on a 63-line Markdown report under `reports_dev/WCG7I5D8/`. The process (pid 42290, started 18:02:52) did not end. Measured:

- 18:15:35: memory footprint 49.97 GiB (`proc_pid_rusage`, field `phys_footprint`); resident size about 2 GB, so nearly all of it was compressed or swapped.
- Swap files 15 to 55 in `/System/Volumes/VM` were created between 18:03 and 18:15 (41 files of 1 GiB). Swap total 56,320 MB at 18:14:37 and 58,368 MB at 18:16:07.
- Boot volume free space: 272 GB at 18:03:43, 230.4 GB at 18:16:07. The project volume did not change (203 GB free).
- In a 20 s window all readable processes (601) wrote 12 MiB to disk in total, so no process was writing files; the drop was swap.
- TERM sent at 18:16:49, process gone by 18:16:55. At 18:17:10: swap total 38,912 MB, 38 swap files, boot free 249.5 GB.

Evidence: `reports_dev/fastedit-runaway/20261117_181649+0100-pid42290-ps.txt` (the full command line, local only).

## Not known

- Why the process grew. Not investigated: which fastedit path ran (model path or anchor path), and whether the same command repeats it.
- Whether the report file it was editing is intact. Its modification time is 18:16, the minute of the stop. Treat `reports_dev/WCG7I5D8/20261117_175752+0100-card-gate-state.md` as unchecked.
- The fastedit version.
- The second largest process at that time was the local decision-model server (23.25 GiB), which belongs to the owner and was not touched.

## To do

- [ ] Worker prompts: run every `fastedit edit` under a time limit (`timeout 120 fastedit edit ...`) and report a timeout as a failed edit.
- [ ] Reproduce on a scratch copy of the report with the saved command line, under `timeout 60`, and watch the footprint. If it repeats, report it to the fastedit project (owner decides where).
- [ ] Check the report file with `fastedit diff` before anyone relies on it.
- [ ] The 5-minute disk monitor did not name the cause; a swap-size line next to the free-space line would have (swap total grew 41 GiB in 13 minutes).

## Approval log

- 2026-11-17T18:19:04+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
