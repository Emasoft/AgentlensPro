// TRDD-1QFP73WA — freePort has a TOCTOU race that makes every real-server test flaky in CI.
//
// The classic helper (`listen(0) → read the port → close() → resolve`) only proves the port
// was free AT PROBE TIME. Between the close and the child process's own `listen()`, the OS is
// free to hand the same ephemeral port to anything else — including another test's server in
// the same mocha run. No amount of retrying the *assertion* helps: the child process already
// exited before the test body runs.
//
// Two independent mitigations, because neither alone closes the window:
//   1. An in-process claimed-set (`freePort`) — mocha runs the whole suite in one process, so
//      remember every port already handed out and re-probe until landing on one this process
//      has not already given to a server that may still be starting. This removes the only
//      collision source visible to us.
//   2. A bounded spawn-retry (`spawnServerWithRetry`) — the OS can still hand the port to
//      something OUTSIDE this process (another CI job, a leftover process). The retry catches
//      the specific "already in use" / early-exit failure, takes a FRESH port, and retries a
//      bounded number of times before failing loudly. A test must fail on the behaviour it is
//      testing, never on port allocation.
//
// Deliberately NOT hardcoding disjoint port ranges per file — that trades a rare race for a
// permanent collision with whatever else on the machine (or CI runner, which is not exclusive)
// owns those numbers.

import * as net from 'net'
import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import type { AddressInfo } from 'net'
import { spawn, type ChildProcess, type SpawnOptions } from 'child_process'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// Ports this process has already handed out via freePort(). Never re-handed out even if the
// OS's own probe-time free/in-use state would otherwise allow it — the whole point is to stop
// trusting a single point-in-time probe.
const claimedInProcess = new Set<number>()

async function probeOnce(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

/**
 * Probe the OS for a free ephemeral port, re-probing until it lands on a number this process
 * has not already handed out. Mitigation 1 of 2 — see the module header. Does NOT (cannot)
 * close the window against a claimant OUTSIDE this process; `spawnServerWithRetry` covers that.
 */
export async function freePort(): Promise<number> {
  for (;;) {
    const port = await probeOnce()
    if (!claimedInProcess.has(port)) {
      claimedInProcess.add(port)
      return port
    }
  }
}

/** The signal that a spawn attempt failed because of ephemeral-port contention, not the code under test.
 *
 *  Matched on the port message ONLY — deliberately NOT on a bare `exited early (code=1)`. Both the
 *  server's own text (`Port 33097 (OTLP) already in use`) and Node's raw EADDRINUSE (`listen
 *  EADDRINUSE: address already in use 127.0.0.1:…`) contain "already in use", so the port cases are
 *  covered; an exit(1) WITHOUT that text is by definition not a port race, and retrying it would
 *  spend three attempts masking a genuine startup failure and then report it as contention.
 *  serverSingleInstance.test.ts is the live proof this matters — it asserts a second server on the
 *  same data dir MUST exit(1) with "Refusing to start", which a code=1 retry would swallow. That
 *  file is not wrapped today, but a matcher that is only safe while nobody wraps the wrong spawn is
 *  a trap set for the next caller, not a guard. */
function isPortRaceFailure(log: string, errMessage: string): boolean {
  const portRace = /already in use|EADDRINUSE/i
  return portRace.test(log) || portRace.test(errMessage)
}

async function waitUntilReady(child: ChildProcess, port: number, urlPath: string, timeoutMs: number, getLog: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (code=${child.exitCode})\n${getLog().slice(-2000)}`)
    const ok = await new Promise<boolean>((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: 2000 }, (res) => {
        res.resume()
        resolve(res.statusCode === 200)
      })
      req.on('error', () => resolve(false))
      req.on('timeout', () => { req.destroy(); resolve(false) })
    })
    if (ok) return
    if (Date.now() > deadline) throw new Error(`server not ready within ${timeoutMs}ms\n${getLog().slice(-2000)}`)
    await sleep(250)
  }
}

export interface SpawnServerRetryOptions {
  /** Absolute path to the child script to spawn (`node <serverJs>`). */
  serverJs: string
  /**
   * Build a FRESH env for one attempt — call `freePort()` again inside this on every invocation
   * so a retry never reuses the port that just lost the race.
   */
  buildEnv: () => Promise<NodeJS.ProcessEnv>
  /** Read the readiness-probe port out of the env this attempt built. */
  readyPort: (env: NodeJS.ProcessEnv) => number
  /** HTTP path polled for a 200 to decide the child is up. Defaults to `/api/server-stats`. */
  readyPath?: string
  /** How long to wait for readiness before treating the attempt as failed. Defaults to 30s. */
  readyTimeoutMs?: number
  /** How many attempts before giving up. Defaults to 3. */
  maxAttempts?: number
  spawnOptions?: SpawnOptions
}

export interface SpawnedServer {
  child: ChildProcess
  env: NodeJS.ProcessEnv
  /** The accumulated stdout+stderr across EVERY attempt (failed retries included). */
  getLog: () => string
}

/**
 * Spawn a real server process, retrying with a FRESH port when the failure looks like ephemeral-
 * port contention (mitigation 2 of 2 — see the module header). Any other failure (a real bug in
 * the server) propagates immediately on the first attempt — this must never mask the behaviour
 * under test, only the port-allocation race around it.
 */
/** The alcore binary the suite should boot, or null to keep booting `node server.js`.
 *
 *  Opt-in via `AGENTLENS_TEST_ENGINE=alcore`, resolved in the order a developer would expect:
 *  an explicit `AGENTLENS_ALCORE` override, then the release build a `cargo build --release`
 *  produces, then the packaged binary. Returns null — not a throw — when the engine is requested
 *  but no binary exists, because a suite that cannot find a Rust build must fall back and say so
 *  rather than fail 15 files with a spawn error that looks like a product bug.
 */
/** The repo's built `media/` — same two-layout candidate walk as `alcoreTestBin`, for the same
 *  reason (this file runs from `src/test/helpers/` and from `out/test/test/helpers/`). */
function repoMediaDir(): string {
  for (const up of [['..', '..', '..'], ['..', '..', '..', '..']]) {
    const c = path.resolve(__dirname, ...up, 'media')
    if (fs.existsSync(path.join(c, 'index.html'))) return c
  }
  // Return the likelier path rather than throwing: alcore's own "--media-dir is required" /
  // missing-dir error names the problem better than a helper's guess would.
  return path.resolve(__dirname, '..', '..', '..', 'media')
}

export function alcoreTestBin(): string | null {
  // DEFAULT engine since 2026-09-01 (TRDD-1B98LCVR box 3): the full suite ran green against alcore
  // (2529 passing; the only 2 failures were date-pinned pricing tests unrelated to any server).
  // `AGENTLENS_TEST_ENGINE=ts` opts back into the TypeScript bundle until box 4 deletes it.
  if ((process.env.AGENTLENS_TEST_ENGINE ?? 'alcore').trim() !== 'alcore') return null
  // A LIST of repo roots, not one guess. This file runs from TWO layouts — `src/test/helpers/`
  // (3 up) and the compiled `out/test/test/helpers/` (4 up) — and a single `'..','..','..'`
  // resolved to `out/` under mocha, so this returned null with the engine explicitly requested and
  // the whole suite quietly ran on server.js instead. It looked like a clean parity result: 2527
  // passing against an engine that was never started. Same failure shape `findServerJs` already
  // guards against a few files over, which is why it enumerates candidates too.
  const roots = [
    path.resolve(__dirname, '..', '..', '..'),
    path.resolve(__dirname, '..', '..', '..', '..'),
  ]
  const candidates = [
    process.env.AGENTLENS_ALCORE?.trim(),
    ...roots.flatMap((r) => [
      path.join(r, 'rust-core', 'target', 'release', 'alcore'),
      path.join(r, 'bin-native', `${process.platform}-${process.arch}`, 'alcore'),
    ]),
  ].filter((p): p is string => Boolean(p))
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK)
      return c
    } catch { /* try the next candidate */ }
  }
  return null
}

/** Translate the env contract every test already builds (DATA_DIR / *_PORT / BIND_HOST) into
 *  alcore's flags. alcore reads NO env vars for these — it is flags-only — so without this the
 *  child would silently bind its defaults (3000/4316/4318) and stomp the developer's live server
 *  instead of the ephemeral ports the test allocated. That failure would not look like a
 *  misconfiguration; it would look like passing tests plus a corrupted live data dir.
 */
export function alcoreArgsFromEnv(env: NodeJS.ProcessEnv): string[] {
  const args = ['serve']
  const push = (flag: string, v: string | undefined): void => { if (v) args.push(flag, v) }
  push('--data-dir', env.DATA_DIR)
  // `--media-dir` is REQUIRED by alcore (it exits 64 without it) and the TS server defaults it, so
  // no existing test sets MEDIA_DIR. Defaulting it here rather than editing 15 test files is the
  // point of routing every boot through this helper — and it is a test-harness default, not a
  // product one: alcore keeps requiring the flag explicitly, which is the safer contract for a
  // server that otherwise serves whatever happens to be next to it.
  push('--media-dir', env.MEDIA_DIR ?? repoMediaDir())
  push('--otlp-port', env.OTLP_PORT)
  push('--ui-port', env.UI_PORT)
  push('--mcp-port', env.MCP_PORT)
  push('--bind', env.BIND_HOST)
  return args
}

export async function spawnServerWithRetry(opts: SpawnServerRetryOptions): Promise<SpawnedServer> {
  const maxAttempts = opts.maxAttempts ?? 3
  const readyTimeoutMs = opts.readyTimeoutMs ?? 30_000
  const readyPath = opts.readyPath ?? '/api/server-stats'
  let lastErr: Error = new Error('spawnServerWithRetry: no attempts were made')
  let combinedLog = '' // spans every attempt, not just the last one, so a caller can see WHY a retry happened

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // AGENTLENS_WATCHDOG=off is NOT optional here, and it is set at the one choke point every
    // spawned test server routes through rather than in each caller. The watchdog's self-heal
    // respawns the server `detached: true` + `unref()` (loopWatchdog.ts:85) — which reparents to
    // PID 1 — and the respawned pid is created INSIDE the server, so no `stop()`/`finally` in test
    // code has a handle on it. A suite that boots many real servers in parallel is exactly the
    // CPU contention that starves an event loop past the 60s stall threshold, so the suite triggers
    // the orphan it then cannot reap. Verified: one such orphan was found alive 54 minutes after a
    // run, PPID 1, on that run's ephemeral ports (it inherits the test env, so it re-binds them).
    const env = { ...(await opts.buildEnv()), AGENTLENS_WATCHDOG: 'off' }
    // WHICH ENGINE THE SUITE BOOTS (TRDD-1B98LCVR box 3). Every test that starts a real server
    // routes through this ONE line, so the whole suite migrates from the TypeScript bundle to
    // alcore here rather than in 15 separate files — and, more importantly, it can only ever be
    // one of the two, which is the property box 4 (deleting standalone/server.ts) depends on.
    //
    // alcore is the DEFAULT since 2026-09-01: all 14 measured parity gaps were closed and the full
    // suite ran green under it (2529 passing). `AGENTLENS_TEST_ENGINE=ts` opts out, and the
    // no-binary case still falls back to server.js rather than failing 15 files with spawn errors.
    // Substitute ONLY for the real bundle. `spawnServerWithRetry` is also used to launch
    // deliberately fake server scripts (freePortRetry.test.ts spawns a stub to prove the port-race
    // retry), and swapping alcore in there replaced the subject of the test with a different
    // program — it failed with "alcore: --data-dir is required", which reads like a parity gap and
    // is not one.
    const useAlcore = /(^|[\\/])standalone[\\/]server\.js$/.test(opts.serverJs) ? alcoreTestBin() : null
    const child = useAlcore
      ? spawn(useAlcore, alcoreArgsFromEnv(env), { env, stdio: ['ignore', 'pipe', 'pipe'], ...opts.spawnOptions })
      : spawn(process.execPath, [opts.serverJs], { env, stdio: ['ignore', 'pipe', 'pipe'], ...opts.spawnOptions })
    let log = ''
    child.stdout?.on('data', (d: Buffer) => { log += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { log += d.toString() })

    const port = opts.readyPort(env)
    try {
      await waitUntilReady(child, port, readyPath, readyTimeoutMs, () => log)
      // getLog() must stay LIVE. Callers assert on lines the server prints LONG AFTER readiness
      // — serverCalibration's rollover-guard assertions are the live proof — so concatenating
      // into a frozen string here would hand back a boot-only snapshot and those assertions
      // would fail against a log that never stopped growing. Capture the FAILED attempts'
      // text, then append the running buffer on every call.
      const priorAttempts = combinedLog
      return { child, env, getLog: () => priorAttempts + log }
    } catch (err) {
      combinedLog += log
      lastErr = err instanceof Error ? err : new Error(String(err))
      try { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') } catch { /* best effort */ }
      const retryable = isPortRaceFailure(log, lastErr.message)
      if (!retryable || attempt === maxAttempts) throw lastErr
      // else: fresh ports next loop iteration — this is exactly what closes the outside-process window.
    }
  }
  throw lastErr
}
