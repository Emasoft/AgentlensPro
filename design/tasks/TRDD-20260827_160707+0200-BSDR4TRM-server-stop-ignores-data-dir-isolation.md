---
trdd-id: BSDR4TRM
title: server stop from an isolated DATA_DIR stopped the LIVE server
column: testing
created: 2026-08-27T16:07:07+0200
updated: 2026-08-27T18:07:49+0200
current-owner: main
task-type: bugfix
severity: HIGH
priority: 2
labels: [server, lifecycle, isolation]
relevant-rules: []
created-by: TRDD-8VGQK9L9 ai_review live verification
---

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-08-27

**Reproduced first-hand at 17:57 on `113d24a` and the CAUSE is now VERIFIED — it is not what the
Observation below says.** Scratch env exactly as the recipe (`AGENTLENS_DATA_DIR=DATA_DIR=HOME=
<scratch>`, ports 39001–3, `AGENTLENS_MCP_URL=:39002`, brake armed): `server start` spawned child
61378, which bound :39002 and logged `started-by=server start brake=PRESENT data=<scratch>`, and the
brake was cleared — yet the CLI printed `pid 92105 — an already-running server won the
single-instance race`, and `server status` in the same env printed the live server. Live pidfile
unchanged before/after; the child was ended with a direct `kill -TERM`. `stop` was NOT run.

**Mechanism (`file:line`):** `findServerPid()` (`src/cli/serverControl.ts:378`) asks
`/api/server-stats` FIRST, and `apiRequest` resolves that REST route through `uiBaseUrl()` =
`AGENTLENS_UI_URL || http://localhost:3000` (`src/cli/cliCore.ts:30`). The isolation recipe sets the
server-side `UI_PORT` but nothing sets the client-side `AGENTLENS_UI_URL`, so the first lookup hits
the LIVE server on :3000, which reports its own `process.pid`, and the data-dir-keyed pidfile is
never consulted. Not "a data-dir-blind port lookup" — an env split between what the server binds
(`UI_PORT`) and what the CLI dials (`AGENTLENS_UI_URL`). `stopServer()` (`:406`) inherits it.

**IMPLEMENTED 18:07 (fable-advisor consulted; its four file:line claims re-read before acting):**

| component | state |
|---|---|
| `cliCore.ts::mcpEndpoint/uiBaseUrl/dashboardUrl` | defaults derive from `MCP_PORT`/`UI_PORT` — the SAME vars the server binds; explicit `AGENTLENS_*_URL` still wins. Fixes every REST caller, not just the pid lookup |
| `serverControl.ts::findServerPid()` | lock FIRST, judged by the server's own `lockTakeoverVerdict` (a recycled pid is not the server); REST fallback accepted only when `stats.dataDir` resolves equal to `dataDir()`; `lsof` rung deleted (a port never says whose data dir) |
| `stopServer()` | unchanged — inherits the resolver |
| `src/test/serverSingleInstance.test.ts` | 4th test: two real servers, CLI in-process with UI/MCP pointed at A while asking about B → B's pid; B's lock removed → null (never A); `stopServer()` ends B, A alive. Mutation-verified: disabling the lock rung fails exactly this test |
| bare command | `agentlenspro server start/status/stop` in the isolated recipe: child pid reported, child stopped, live pidfile identical before/after |

**NEXT ACTION:** full suite result (running) → `ai_review`.

**Known limit, accepted:** a server predating both the pidfile and the `dataDir` stats field is
invisible to the CLI (`stop` prints "already stopped"); `server status` already has an "older
build?" line for that case.

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

- [x] `findServerPid()` resolves the server of the data dir it is invoked for (the `server.pid`
      lock the guard writes is already keyed on DATA_DIR — read it FIRST, never fall through to a
      port/name lookup that can return a foreign server). — lock first; lsof rung removed.
- [x] `stopServer()` resolves its target from the SAME data dir it was invoked for; refuses to
      signal a pid whose data dir differs (verify via the boot-provenance line / lock file owner).
      — via the resolver: a REST pid is accepted only on a `dataDir` match.
- [x] A test: two data dirs, two servers, `stop` in one never touches the other.
      — `serverSingleInstance.test.ts`, mutation-verified.
- [x] Re-run the exact recipe above; expect: child stays up on :39002, brake cleared, `stop` stops
      ONLY it, live server pid unchanged. — measured 18:07 through the bare `agentlenspro`.

## Not in scope

The brake semantics (8VGQK9L9). The port-isolation caveat in CLAUDE.md is correct as far as it goes;
this card is about the guard/stop not honouring the data-dir key it documents.
