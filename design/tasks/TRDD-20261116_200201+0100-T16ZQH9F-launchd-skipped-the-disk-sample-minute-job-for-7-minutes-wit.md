---
trdd-id: T16ZQH9F
title: launchd skipped the disk-sample minute job for 7 minutes with no event under heavy load
column: backburner
status: tasked
created: 2026-11-16T20:02:01+0100
updated: 2026-11-16T20:02:01+0100
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

# launchd skipped the disk-sample minute job for 7 minutes with no event under heavy load

Derived from TRDD-RU9A8H7A. On 2026-11-16 the minute job's last run before the gap ended 19:31:04 and the next ended 19:38:14 (rows 19:31:03.434 and 19:38:03.453, gap exactly 7:00.019). launchd's unified log (process == launchd, 'service inactive: com.agentlens.disk-sample') has NO event between them; pmset shows no sleep; load average 128–169. Under the same ProcessType Background, 19:38–19:49 at similar load ran clean every 61–70 s, so ProcessType alone does not explain it. Open question: what made launchd not fire the StartInterval timer for 7 intervals. Next: if it recurs, capture 'launchctl print gui/501/com.agentlens.disk-sample' and '/usr/bin/log show --predicate process == "launchd"' (note: in zsh 'log' is a builtin, use /usr/bin/log) across the gap. Evidence query: agentlenspro disk sql over disk_volume ts gaps.

## Approval log

- 2026-11-16T20:02:01+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
