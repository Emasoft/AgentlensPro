---
trdd-id: RNXE06LE
title: Deployed alcore exited with no logged cause in the same second a hook revive booted a second server
column: todo
status: tasked
created: 2026-10-22T06:23:32+0200
updated: 2026-10-22T06:28:26+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-22T06:23:32+0200
---

# Deployed alcore exited with no logged cause in the same second a hook revive booted a second server

2026-10-22 06:12: after `agentlenspro server restart`, alcore pid 26189 logged its last line at 06:12:38 (memory pressure stage 2 to 3) and no exit cause: no RSS HARD CAP block whose uptime matches it in rss-hard-cap.log (the blocks carry no pid), no alcore .ips crash report, no shutdown line. In the same second (06:12:38) a hook revive booted pid 27810 ('boot provenance: started-by=hook-revive'). Unknown: whether 26189 was still alive when the revive fired (a revive against a live but slow server would be its own bug, and two servers would contend for the data-dir pid lock), or died first from an unlogged path (a signal, the pid lock, a crash without a report). Evidence: docs_dev/20261022-091Z1FU0-deploy.md sections 7-8; ~/.agentlens/server.log lines around 06:12:38. Next: read the revive trigger in the hook revive path and the pid_lock claim/takeover rules (rust-core/crates/agentlens-core/src/pid_lock.rs) to decide whether revive can fire while the server is alive; reproduce on an isolated data dir.

## Approval log

- 2026-10-22T06:23:32+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Context

Later revives the same morning died on the guard at 16.9 s and 105.4 s and backed off after 4 quick crashes, so revive does fire after a real death; the open question is only whether it can fire before one.
