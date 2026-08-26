---
trdd-id: 1FSPKQ6C
title: The revive-log test cannot exercise a live child, and CI is where that matters
column: complete
created: 2026-08-23T01:39:56+0200
updated: 2026-08-26T05:36:57+0200
current-owner: main
task-type: infra
severity: MEDIUM
priority: 3
labels: [tests, hooks, ci, leak]
min-approval-requirement: none
relevant-files: [src/test/hookSpool.test.ts, src/test/helpers/freePort.ts, src/test/helpers/reviveHarness.ts, src/cli/hookHandlers.ts]
created-by: TRDD-4FMHW124
---

# The revive-log test proves the redirect, and nothing about reaping a live child

Split out after **three rounds** of trying to close this inside the test itself, each round
introducing a new defect. Filing it is the retreat, and the retreat is the right call — the
attempts were costing more than the gap.

## What the test DOES prove (and it is worth keeping)

`reviveDaemonDetached` redirects its child's stdout/stderr to `server.log` instead of `/dev/null`.
Falsified by mutation: restoring `stdio: 'ignore'` yields 0 bytes and a red test. That is the
whole claim of the fix it guards, and it is fully carried.

## The gap

On a machine already running the canonical server, the revived child binds the DEFAULT ports
(4316/3000/4318), loses, and dies — writing ~309 bytes of `Port 4316 already in use`. So:

- the byte assertion passes **on error output**;
- no pidfile is written, so the teardown's `waitForPid` returns null and **kills nothing**;
- a `ps` snapshot shows no orphan — because the child crashed, not because cleanup worked.

**On CI those ports are free.** The child boots, survives, and the same green test leaves a live
server behind — inside `publish.yml`'s pre-publish gate (`.mocharc` spec includes this file).

## Three attempts, and why each failed — so the next one does not repeat them

1. **`45000 + pid % 2000`, ports at base..base+2.** Adjacent pids overlap. Exhaustive check over
   pids 1–99,999: **297,898 clashes**.
2. **Stride of 4** (`+ (pid % 500) * 4`). Arithmetic fixed — 0 clashes — but the RANGE was the
   real bug: **45000–46996 sits inside Linux's default ephemeral range (32768–60999)**, on
   `ubuntu-latest`, the platform the fix exists for. macOS starts at 49152, which is why both
   hand-rolled schemes looked clean locally.
3. **`freePort()`** — the helper this file already imports (line 8) and uses at :249. It worked,
   and cost more than it bought: a real server binding three ports inside the SHARED mocha process
   destabilised unrelated suites. **Measured 2 failures in 8 runs (~25%)** — `OtlpCollector`
   ("socket hang up") and an HTTP body test, neither touched by this file. A suite-wide 25% flake
   rate is a worse defect than the one being chased.

Reverted to no port override; 6/6 runs clean, 0 failing, no orphans.

## The sharper half — `AGENTLENS_WATCHDOG=off` is NOT optional

Found while reading `src/test/helpers/freePort.ts`, which sets it at its own choke point and
records why, from a real incident:

> the watchdog's self-heal respawns the server `detached: true` + `unref()` (loopWatchdog.ts:85) —
> which reparents to PID 1 — and the respawned pid is created INSIDE the server, so no
> `stop()`/`finally` in test code has a handle on it. […] Verified: one such orphan was found
> alive 54 minutes after a run, PPID 1, on that run's ephemeral ports.

**A pidfile-based teardown provably cannot reap that.** So even a perfectly-ported test would leak
on the watchdog path. The test now sets `AGENTLENS_WATCHDOG=off` (the revive inherits our env —
the only channel into a child we do not spawn), but any future attempt to exercise a live child
must keep it.

This is very likely also the origin of the **9-hour orphaned `alcore serve`** recorded on
TRDD-ZFX0MPYZ, whose provenance was left unestablished there.

## Acceptance

- [x] A live revived child is reaped, PROVEN on every run rather than inferred from a mutation —
      the one-line form is `assert.ok(pid !== null)` before the kill, which turns "did a live child
      exist?" into a checked fact instead of something re-derived by hand. Implemented as an
      ISOLATED SUBPROCESS (`src/test/helpers/reviveHarness.ts`, spawned by a new suite in
      `src/test/hookSpool.test.ts`): a separate node process gets its own `DATA_DIR`+`HOME`+fresh
      ports, calls `forwardHookEvent` for real, waits for the pidfile, SIGKILLs the child, verifies
      death via a snapshotted `ps -eo pid` (never `pgrep`-by-name), and reports
      `{revivedPid, reaped}` as one JSON line. The mocha test asserts `revivedPid !== null` before
      asserting `reaped`, plus a belt-and-braces `finally` that re-reads the SAME pidfile straight
      off disk and SIGKILLs it again, independent of the harness's own exit status or JSON.
- [x] Whatever achieves that does NOT destabilise the shared mocha process — no port is bound
      inside mocha's own process; the harness is a wholly separate node process. Measured: ≥8
      consecutive runs of `out/test/test/hookSpool.test.js` alone (the file, not the whole suite),
      6/6 tests passing every time, 0 failing, and a `ps -eo pid,ppid,etime,command` snapshot after
      EVERY run showing no orphaned `standalone/server.js` or `reviveHarness.js` process. Report:
      `reports/fix-1FSPKQ6C/20260826_053700+0200-build.md`.
      One real (pre-existing) orphan was found and fixed along the way: the OLDER
      "a hook-revived server LOGS" test's teardown used bare `process.kill(pid)` (SIGTERM) — on a
      machine with the default ports genuinely FREE (the exact CI condition this card is about) the
      revived child boots instead of crashing on a port conflict, and a graceful SIGTERM was
      measured to leave it alive over a minute past the test's own exit. Changed to `SIGKILL`; 0
      orphans across all 8 runs afterward.
- [x] `AGENTLENS_WATCHDOG=off` stays set wherever a real server can be spawned — set in
      `reviveHarness.ts` (the new isolated child) same as it already was in the older in-process test
      and in `spawnServerWithRetry`.
- [x] The gap did NOT need a product change — `reviveDaemonDetached` itself needed nothing new;
      the fix was purely in test isolation + the SIGKILL teardown above. No product code was
      touched.

## Notes and lessons learned

[^1]: [id: fix-that-destabilises-its-neighbours status: active keywords: "flaky test" "unrelated
    suite failing" "socket hang up" shared process ports spawned server test isolation, ocd:
    2026-08-23 lmd: 2026-08-23] DO NOT make a test spawn a real port-binding server inside a
    SHARED runner process to close a coverage gap, BECAUSE the isolation you gain for that test is
    paid for by every other suite in the process — measured here as 2 failures in 8 runs in two
    suites the change never touched, where the original gap cost nothing on the happy path. DO
    measure the SUITE, not the test, before and after: if unrelated tests start failing, the fix
    is worse than the hole. Tell: the failures land in files your diff does not mention.

[^2]: [id: three-rounds-is-the-signal status: active keywords: "fix introduced a defect" "third
    attempt" circling over-correction retreat, ocd: 2026-08-23 lmd: 2026-08-23] DO NOT keep
    fixing when each round's fix introduces the next round's defect, BECAUSE that pattern says the
    APPROACH is wrong, not the implementation — here three rounds (collision → ephemeral range →
    suite destabilisation) all served one mental model, "make the child boot so teardown can kill
    it", which a shared test process cannot afford. DO retreat to the claim the test actually
    carries, state in the test what it does NOT prove, and file the gap. A documented hole is
    cheaper than a fix that breaks its neighbours.
