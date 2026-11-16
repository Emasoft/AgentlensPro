---
trdd-id: T16ZQH9F
title: disk-sample minute run stalled about 5 minutes before sampling under heavy load (7-minute gap)
column: todo
status: tasked
created: 2026-11-16T20:02:01+0100
updated: 2026-11-16T20:47:54+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-16T20:02:01+0100
---

# disk-sample minute run stalled about 5 minutes before sampling under heavy load (7-minute gap)

Derived from TRDD-RU9A8H7A. On 2026-11-16 the minute job's last run before the gap ended 19:31:04 and the next ended 19:38:14 (rows 19:31:03.434 and 19:38:03.453, gap exactly 7:00.019). launchd's unified log (process == launchd, 'service inactive: com.agentlens.disk-sample') has NO event between them; pmset shows no sleep; load average 128–169. Under the same ProcessType Background, 19:38–19:49 at similar load ran clean every 61–70 s, so ProcessType alone does not explain it. Open question: what made launchd not fire the StartInterval timer for 7 intervals. Next: if it recurs, capture 'launchctl print gui/501/com.agentlens.disk-sample' and '/usr/bin/log show --predicate process == "launchd"' (note: in zsh 'log' is a builtin, use /usr/bin/log) across the gap. Evidence query: agentlenspro disk sql over disk_volume ts gaps.

## Approval log

- 2026-11-16T20:02:01+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-16T20:05:46+0100 — column → todo by main-agent@agentlenspro. measured: a stalled run inside RU9A8H7A scope

## Measurements

2026-11-16 20:10 — CORRECTS the card body and the closed TRDD-RU9A8H7A. /var/log/com.apple.xpc.launchd/launchd.log: launchd DID spawn the minute job at 19:32:51.106 (pid 54588, because interval); it exited 0 at 19:38:14.015 after 369618 ms. Its row ts is 19:38:03.453, so the run stalled about 5 min before taking its sample. No walk job ran 19:30:44–19:37:18 (walk pids 16465, 97339), so it was not the DuckDB writer lock. Load at the time 128–169; ProcessType Background + Nice 10. The unified-log 'service inactive' lines are exit events only, which is why the earlier reading ('launchd never fired') was wrong. Also corrects RU9A8H7A's 'load ~100–170 for 19:38–19:49': measured 84.8 at 19:39 falling to 27.2 at 19:49:59 (15-min avg 53.8). So RU9A8H7A's fix is INCOMPLETE: ProcessType Standard (c05b537a) is the candidate fix and is untested at load above 100. Acceptance: under Standard, at a 1-min load average above 100, no volume-job run longer than 30 s (launchd.log 'ran for') across 10+ runs.
Passive check for any later high-load window (no need to create load): grep -h 'agentlens.disk-sample' /var/log/com.apple.xpc.launchd/launchd.log* | grep 'ran for' — any run above 30000 ms under ProcessType Standard (installed 2026-11-16 19:49:47) at a 1-min load above 100 fails acceptance; pair each with the load from 'agentlenspro statusline-history' or sysctl vm.loadavg samples.
Correction to the passive check above: 'agentlenspro statusline-history' reports session cost and context, not host load — pair each launchd 'ran for' line with sysctl vm.loadavg samples only.
2026-11-16 20:32–20:42 — owner-approved synthetic load test (owner answer: "Yes, 10 min of load"): 120 nice-19 busy loops on 14 cores, 1-min load 130–271 from 20:33:36. ProcessType Standard, Nice 10. ACCEPTANCE FAILED: 7 runs took 3585 / 32944 / 19264 / 53561 / 58750 / 19031 / 12766 ms (launchd.log 'ran for'); max gap between volume rows 1:53.7. In every loaded run all 4 'diskutil info' calls and the osascript important-usage call timed out (5 s each, run in parallel), so used-by-volume and purgeable fields were NULL with the error recorded. The rest of the time is before t0 (process start + CLI init), e.g. the 20:33 run spawned ~20:33:31 and took its sample timestamp at 20:33:55. At load 129 after the loops ended, 'node cli.js disk-sample --help' took 0.14 s and a real run 0.8 s, so the cost is CPU starvation, not a slow bundle. Limit of this test: loops at nice 19 vs the job at Nice 10, no Background comparison run. Conclusion: Standard does not hold 60 s under heavy load; a per-minute fresh node process is the weak point.
Correction to the 20:42 entry: 'the rest of the time is before t0' was wrong. launchd.log spawn times against row ts (t0) and exit give, per loaded run, startup (spawn→t0) / sampler (t0→exit): 25/8, 5/14, 40/14, 36/23, 10/9, 3/10 s. So both halves are slow under load; a resident process would remove only the startup half. Before building any fix: write the pass bar here, then measure in ONE load window (needs owner yes) side by side: (a) a scratch resident loop logging timer lateness and write time into a scratch DuckDB; (b) a one-shot run without Nice and LowPriorityIO. Open design points for a resident sampler: DuckDB single writer (open/insert/close each minute), never derive purgeable_b from an important-usage value older than avail_b.
