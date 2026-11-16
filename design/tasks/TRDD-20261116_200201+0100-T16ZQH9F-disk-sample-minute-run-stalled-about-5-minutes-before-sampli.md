---
trdd-id: T16ZQH9F
title: disk-sample minute run stalled about 5 minutes before sampling under heavy load (7-minute gap)
column: todo
status: tasked
created: 2026-11-16T20:02:01+0100
updated: 2026-11-16T20:05:46+0100
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
