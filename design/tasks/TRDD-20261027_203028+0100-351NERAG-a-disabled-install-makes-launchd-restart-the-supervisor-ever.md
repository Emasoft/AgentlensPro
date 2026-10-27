---
trdd-id: 351NERAG
title: A disabled install makes launchd restart the supervisor every 10 s
column: backburner
status: tasked
created: 2026-10-27T20:30:28+0100
updated: 2026-10-27T20:30:28+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-27T20:30:28+0100
---

# A disabled install makes launchd restart the supervisor every 10 s

Found while closing TRDD-NZ9Z9ALO. The LaunchAgent plist (src/cli/serverControl.ts, template near line 1180) runs 'agentlenspro daemon start --supervise' with KeepAlive true and ThrottleInterval 10. Under <data_dir>/DISABLED the supervisor refuses and exits, so launchd relaunches it about every 10 s indefinitely, writing a refusal line to ~/.agentlens/launchd.*.log each time. Not caused by the NZ9Z9ALO fix and not cured by it. Options: KeepAlive with SuccessfulExit false and the supervisor exiting 0 under DISABLED; or agentlenspro disable unloading the LaunchAgent and enable reloading it. Not yet measured: how the supervisor exits under DISABLED, and the actual log growth.

## Approval log

- 2026-10-27T20:30:28+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
