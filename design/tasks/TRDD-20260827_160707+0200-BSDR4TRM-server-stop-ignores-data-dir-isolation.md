---
trdd-id: BSDR4TRM
title: server stop from an isolated DATA_DIR stopped the LIVE server
column: todo
created: 2026-08-27T16:07:07+0200
updated: 2026-08-27T16:08:50+0200
current-owner: main
task-type: bugfix
severity: HIGH
priority: 2
labels: [server, lifecycle, isolation]
relevant-rules: []
created-by: TRDD-8VGQK9L9 ai_review live verification
---

## Observation (measured 2026-08-27, during TRDD-8VGQK9L9 round-2 verification)

Env: `AGENTLENS_DATA_DIR=DATA_DIR=HOME=<scratch>`, `UI_PORT=39001 MCP_PORT=39002 OTLP_PORT=39003`,
`AGENTLENS_MCP_URL=http://127.0.0.1:39002/mcp`, NO_REVIVE armed in the scratch dir.

1. `node standalone/cli.js server start` → exit 0, brake cleared (the C1 fix works). The CLI
   printed "an already-running server won the single-instance race (pid 16838)" — the LIVE server on
   the DEFAULT data dir. **That verdict was FALSE**: the child (pid 92016) was still running 2 min
   later, bound to :39001/:39002/:39003 with `data=<scratch>` (its own server.log shows it
   ingesting). The guard did its job; the PARENT misreported, because `findServerPid()`
   (`serverControl.ts:377`) resolves a server by process/port lookup that is data-dir-blind and so
   found the live pid instead of the child it had just spawned. Its `raceWinnerPid()`/`startupVerdict`
   logic then declared a lost race that never happened.
2. `node standalone/cli.js server stop` in the same env → "FAIL: server (pid 16838) did not stop
   within 10s". `stopServer()` (`:398`) uses the same `findServerPid()`, so it SIGTERMed the LIVE
   server (established: the message names the pid). Inferred, not read from an exit reason: the
   graceful flush of a 1.8 GB process exceeded the CLI's 10 s wait, 16838 exited, and a hook revived
   it as 92105 (`started-by=hook-revive` in ~/.agentlens/server.log, born ≈ the stop). Other spawns
   that day (a killSwitch test at 15:58, the round-1 reviewer's `server start`) predate 16838's
   successor by ~20 min and are ruled out on timing only.
3. The scratch child was stopped by `kill -TERM 92016` directly — the CLI could not have.

Round-1 review of 8VGQK9L9 had already flagged `stopServer()` (`serverControl.ts:398-410`)
resolving its target by port/name rather than data dir, as pre-existing and out of that card's scope.

## Why it matters

The documented isolation recipe ("give it its own DATA_DIR and HOME") is what every test and every
scratch verification relies on. If `start` loses the race to a foreign data dir and `stop` kills a
foreign server, isolation is a claim, not a property — and a unit/live check can take down the
developer's real collector (it did).

## Acceptance

- [ ] `findServerPid()` resolves the server of the data dir it is invoked for (the `server.pid`
      lock the guard writes is already keyed on DATA_DIR — read it FIRST, never fall through to a
      port/name lookup that can return a foreign server).
- [ ] `stopServer()` resolves its target from the SAME data dir it was invoked for; refuses to
      signal a pid whose data dir differs (verify via the boot-provenance line / lock file owner).
- [ ] A test: two data dirs, two servers, `stop` in one never touches the other.
- [ ] Re-run the exact recipe above; expect: child stays up on :39002, brake cleared, `stop` stops
      ONLY it, live server pid unchanged.

## Not in scope

The brake semantics (8VGQK9L9). The port-isolation caveat in CLAUDE.md is correct as far as it goes;
this card is about the guard/stop not honouring the data-dir key it documents.
