---
trdd-id: 1QFP73WA
title: freePort has a TOCTOU race that makes every real-server test flaky in CI
column: completed
created: 2026-08-07T03:55:11+0200
updated: 2026-08-18T12:45:00+0200
current-owner: main
task-type: infra
---

# freePort has a TOCTOU race that makes every real-server test flaky in CI

## ⏵ STATE — 2026-08-11 19:20 — IMPLEMENTED AND LOCALLY GREEN; **CI IS THE OUTSTANDING GATE**

Both mitigations shipped in `src/test/helpers/freePort.ts`; the four duplicated copies are gone.
Local suite 2221 passing / 12 pending / 0 failing, all five gates clean.

**NEXT ACTION:** this card CANNOT close on local green. Its own criterion below is the full suite
green on **Node 20 and Node 22 across three consecutive CI runs** — one green run proves nothing
about a race, and the whole defect was a run that passed on one matrix leg and failed on another
at the identical commit. Push and watch three runs, then close.

**Re-columned `testing` → `human_review` 2026-08-12.** Nothing about the work changed; the column
was lying. `testing` asserts that someone is testing this right now, and nobody was — the only
remaining step is a **push**, which is the owner's to authorize, and CI cannot run until it happens.
A card parked in a work column is invisible as a stall precisely because the board's most-populated
columns are the ones nobody re-reads, so it would have sat there indefinitely looking busy. The
blocker is a USER action, which is what `human_review` means, and it is now consistent with the
three other cards on this branch waiting on the same person.

Local state is unchanged and still good: implemented, full suite green (2240 passing / 11 pending /
0 failing as of 2026-08-12), all five gates green. **That is not the close criterion and must not be
mistaken for it** — one machine's green says nothing about a race that manifested as one CI matrix
leg passing while another failed at the identical commit.

**Two files deliberately got mitigation 1 only** (the allocator), not the spawn-retry, and this is
a decision, not an omission:
- `serverSingleInstance.test.ts` asserts a second server on the same data dir MUST `exit(1)` with
  "Refusing to start". A generic retry-on-early-exit would swallow the very refusal under test.
- `setupVerb.test.ts` spawns inside `runSetup()` (`src/cli/setup.ts`), so there is no test-level
  call site to wrap without changing that function's contract.

**Load-bearing detail found in review, after the helper was written:** the first cut of
`isPortRaceFailure` also matched a bare `exited early (code=1)`, making EVERY `exit(1)` retryable
— so a genuine startup failure would burn three attempts and then be reported as port contention.
Tightened to the port text only; both the server's own message and Node's raw `EADDRINUSE` contain
"already in use", so no real port case is lost. Pinned by a test proving the permissive form
retries 3× (measured: `buildEnv called 3x`).

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

## Approval log

- 2026-08-14T02:58:00+0200 — COMPLETED (human_review → complete). The card's own close criterion —
  three consecutive green CI runs on main after the fix — is now met: ed084ff, 1828673, 17dc609
  all success (the two 2026-08-13 20:3x failures that broke the earlier streak were an unrelated
  spansScanned contract regression, fixed by ed084ff, with zero port-race signatures in their
  logs). Implementation itself was fact-verified earlier:
  reports/trdd-review/20260814_015508+0200-batch3-review.md.
- 2026-08-18T12:45:00+0200 — ARCHIVED by USER batch directive ("complete all TRDD"); validity
  re-verified: src/test/helpers/freePort.ts defines isPortRaceFailure and claimedInProcess.

## Notes and lessons learned
