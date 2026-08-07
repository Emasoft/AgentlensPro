---
trdd-id: 1QFP73WA
title: freePort has a TOCTOU race that makes every real-server test flaky in CI
column: todo
created: 2026-08-07T03:55:11+0200
updated: 2026-08-07T03:55:11+0200
current-owner: main
task-type: infra
---

# freePort has a TOCTOU race that makes every real-server test flaky in CI

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-08-07

Not started. Found while merging PR #17; queued rather than folded in, because it is a
test-infra change unrelated to that PR's subject and would have doubled its blast radius.

**NEXT ACTION:** write the shared helper `src/test/helpers/freePort.ts` described under
*Fix* below, then replace the four duplicated copies with an import.

## The defect

Every test that spawns a real `standalone/server.js` picks its ports like this:

```ts
async function freePort(): Promise<number> {
  const srv = net.createServer()
  srv.listen(0, '127.0.0.1', () => {
    const port = (srv.address() as net.AddressInfo).port
    srv.close(() => resolve(port))          // ← closed HERE
  })
}
// …later: spawn(server, { env: { OTLP_PORT: String(port) } })   ← bound THERE
```

The probe socket is closed before the number is used, so the port is only known to have been
free at probe time. Between the close and the child's `listen`, the OS is free to hand the
same ephemeral port to anything else — including another test's server in the same run. This
is a textbook time-of-check/time-of-use race, not load-related flakiness: no amount of
retrying the *assertion* helps, because the process already exited.

Observed on PR #17, run 31139375893, `build-and-test (20)`:

```
[AgentLens] Port 33097 (OTLP) already in use — stop the process using it or set OTLP_PORT=…
Error: server exited early (code=1)
  at Context.<anonymous> (out/test/test/hookSpool.test.js:168:23)
```

`build-and-test (22)` passed on the identical commit, which is what identifies it as a race
rather than a regression. Note the spool logic under test worked correctly right up to the
crash (`hook-spool: drained 2 event(s), quarantined 1 bad`) — the failure is purely the
harness.

The helper is **duplicated in at least four files**, so the race is repo-wide, and a fix
applied to one file just moves which test flakes:

- `src/test/serverSingleInstance.test.ts:22`
- `src/test/setupVerb.test.ts:51`
- `src/test/standaloneAttributionGraft.test.ts:50`
- `src/test/hookSpool.test.ts:89`

## Fix

One shared helper, two independent mitigations, because neither alone closes the window:

1. **An in-process claimed-set.** Mocha runs the whole suite in one process, so remember every
   port handed out and re-probe until the number is one this process has not already given to
   a server that may still be starting. This removes the only collision source we can see.
2. **Retry the SPAWN on `already in use`.** The OS can still hand the port to something outside
   this process, so the spawn helper should catch that specific early exit, take a fresh port,
   and retry a bounded number of times before failing. A test must fail on the behaviour it is
   testing, never on port allocation.

Do **not** "fix" this by hardcoding disjoint port ranges per file — that trades a rare race for
a permanent collision with whatever else on the machine owns those numbers, and CI runners are
not exclusive.

## Verification

Falsification is available and cheap: stub the port allocator to return a port that is already
bound, and assert the spawn helper retries and succeeds rather than propagating
`server exited early (code=1)`. That test fails against today's helper.

Then: the full suite green on both Node 20 and Node 22 across three consecutive CI runs. One
green run proves nothing about a race.

## Notes and lessons learned
