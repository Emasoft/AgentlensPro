---
trdd-id: PIDFILEAT
title: server.pid can contain two interleaved pids under a respawn race
column: complete
created: 2026-08-13T12:57:16+0200
updated: 2026-08-14T03:10:00+0200
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

## Approval log

- 2026-08-14T03:10:00+0200 — COMPLETED (backburner → complete). Both halves implemented and
  verified (reports/trdd-review/20260814_022223+0200-PIDFILEAT-fix.md): (1) the pidfile is now
  published by `atomicExclusiveWriteFileSync` — full content staged + fsynced in a temp file, then
  `link(2)`-published, which is atomic AND fails EEXIST (the interleaved "4676845598" shape is
  structurally impossible; pinned by a two-racing-writers test) — with a re-read-after-write that
  hard-exits on mismatch; (2) the lock carries the owner's `ps -o lstart=` start reference, and
  `lockTakeoverVerdict` reclaims only on dead-takeover or recycled-takeover — an alive pid with a
  matching start ref is a live owner, never taken over, closing the ≥67s double-owner window.
  Legacy bare-numeric locks keep today's kill-0-only rule so running installs are not bricked. The
  861LC4VW-coupled refusal string is byte-identical (grep-verified; serverStartupVerdict suite
  green). 46 unit + 3 spawned-real-server integration tests green; deployed with the closing
  commit.
