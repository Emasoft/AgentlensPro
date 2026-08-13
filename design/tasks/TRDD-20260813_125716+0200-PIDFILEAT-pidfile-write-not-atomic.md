---
trdd-id: PIDFILEAT
title: server.pid can contain two interleaved pids under a respawn race
column: backburner
created: 2026-08-13T12:57:16+0200
updated: 2026-08-13T22:27:00+0200
current-owner: agentlenspro-session
task-type: bugfix
severity: high
---

Observed live 2026-08-13 during the respawn storm: server.pid read "4676845598" — two pids (46768, 45598) interleaved, so the pidfile write is not atomic/exclusive under concurrent starters. Consequences: status/stop can target a garbage pid. Route the pidfile write through atomicWriteFileSync (temp+rename) and re-read-after-write in the starter. Related observation, decide separately: the single-owner guard's stale-lock takeover cited long-dead pid 14576 while refusals looped — under heavy pid churn a recycled pid can make kill-0 lie; consider lock contents carrying start-time alongside pid so a recycled pid is detectable.

**ESCALATED 2026-08-13 22:27 (severity → high) by the third 34B9JAZK recurrence's evidence:** at
~22:08-22:12 spawn refusals again cited pids dead since midday (14576, 13448), and pid 77910
started 22:08:22 while 65252 still answered requests at 22:09:29 — a possible **double-owner
window of ≥67s**, i.e. two servers appending to the same store, the exact corruption the guard
exists to prevent. This is no longer cosmetic (wrong pid in status output); a stale/corrupt lock
that permits takeover from a LIVE owner is a store-integrity risk. Evidence recorded in
TRDD-34B9JAZK's 22:09 recurrence section.
