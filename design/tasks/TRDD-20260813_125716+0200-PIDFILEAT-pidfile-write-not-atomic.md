---
trdd-id: PIDFILEAT
title: server.pid can contain two interleaved pids under a respawn race
column: backburner
created: 2026-08-13T12:57:16+0200
updated: 2026-08-13T12:57:16+0200
current-owner: agentlenspro-session
task-type: bugfix
---

Observed live 2026-08-13 during the respawn storm: server.pid read "4676845598" — two pids (46768, 45598) interleaved, so the pidfile write is not atomic/exclusive under concurrent starters. Consequences: status/stop can target a garbage pid. Route the pidfile write through atomicWriteFileSync (temp+rename) and re-read-after-write in the starter. Related observation, decide separately: the single-owner guard's stale-lock takeover cited long-dead pid 14576 while refusals looped — under heavy pid churn a recycled pid can make kill-0 lie; consider lock contents carrying start-time alongside pid so a recycled pid is detectable.
