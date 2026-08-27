---
trdd-id: BSDR4TRM
title: server stop from an isolated DATA_DIR stopped the LIVE server
column: todo
created: 2026-08-27T16:07:07+0200
updated: 2026-08-27T16:07:07+0200
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

1. `node standalone/cli.js server start` → exit 0, brake cleared (the C1 fix works). The child
   (pid 92016) logged `started-by=server start brake=PRESENT data=<scratch>` and then EXITED:
   "an already-running server won the single-instance race (pid 16838)". 16838 was the LIVE
   server on the DEFAULT data dir. CLAUDE.md says the guard is keyed on the data directory — a
   different data dir must not lose that race.
2. `node standalone/cli.js server stop` in the same env → "FAIL: server (pid 16838) did not stop
   within 10s". It targeted the LIVE server. The live server died shortly after and was auto-revived
   as pid 92105 (canonical, :3000/:4316/:4318, default data dir). One unplanned restart of the
   user's real server from a supposedly isolated shell.

Round-1 review of 8VGQK9L9 had already flagged `stopServer()` (`serverControl.ts:398-410`)
resolving its target by port/name rather than data dir, as pre-existing and out of that card's scope.

## Why it matters

The documented isolation recipe ("give it its own DATA_DIR and HOME") is what every test and every
scratch verification relies on. If `start` loses the race to a foreign data dir and `stop` kills a
foreign server, isolation is a claim, not a property — and a unit/live check can take down the
developer's real collector (it did).

## Acceptance

- [ ] Establish which process/lock `start`'s single-instance race actually consults, and why a
      distinct DATA_DIR lost it (env not forwarded to the child? guard keyed on ports after all?).
- [ ] `stopServer()` resolves its target from the SAME data dir it was invoked for; refuses to
      signal a pid whose data dir differs (verify via the boot-provenance line / lock file owner).
- [ ] A test: two data dirs, two servers, `stop` in one never touches the other.
- [ ] Re-run the exact recipe above; expect: child stays up on :39002, brake cleared, `stop` stops
      ONLY it, live server pid unchanged.

## Not in scope

The brake semantics (8VGQK9L9). The port-isolation caveat in CLAUDE.md is correct as far as it goes;
this card is about the guard/stop not honouring the data-dir key it documents.
