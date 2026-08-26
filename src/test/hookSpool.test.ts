import * as assert from 'assert'
import * as http from 'http'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import { spawn, type ChildProcess } from 'child_process'
import { forwardHookEvent } from '../cli/hookHandlers'
import { freePort, spawnServerWithRetry } from './helpers/freePort'

// ── D3K7QM2P/1a — hook durability: spool-on-failure + boot/periodic drain ────────────────────────
// forwardHookEvent must NEVER lose a hook event a live Claude instance emitted. When the server is
// unreachable (or sheds under load), it durably spools the payload to DATA_DIR/hook-spool/ and fires
// a stampede-locked detached revive; the server reingests + deletes the spool on boot (and on a slow
// tick). AGENTLENS_NO_REVIVE=1 keeps the unit tests from spawning a real server while still exercising
// the spool + stampede-lock logic.

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

suite('hook spool — forwardHookEvent durability (unit)', () => {
  let tmp = ''
  const saved: Record<string, string | undefined> = {}
  const setEnv = (k: string, v: string) => { saved[k] = process.env[k]; process.env[k] = v }

  suiteSetup(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'al-spool-'))
    setEnv('DATA_DIR', tmp)
    setEnv('AGENTLENS_NO_REVIVE', '1') // spool + lock, but don't spawn a server from a unit test
  })
  suiteTeardown(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ }
  })

  const spoolDir = () => path.join(tmp, 'hook-spool')
  const spoolFiles = () => { try { return fs.readdirSync(spoolDir()).filter((n) => n.endsWith('.json')).sort() } catch { return [] } }
  const DEAD = 'http://127.0.0.1:1' // port 1 → connection refused immediately

  test('a hook that cannot be delivered is spooled to disk with its exact payload', async () => {
    const payload = Buffer.from(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', x: 1 }))
    await forwardHookEvent(payload, { baseUrl: DEAD, timeoutMs: 300 })
    const files = spoolFiles()
    assert.strictEqual(files.length, 1, 'exactly one spool file was written')
    assert.strictEqual(fs.readFileSync(path.join(spoolDir(), files[0]), 'utf-8'), payload.toString('utf-8'), 'spooled bytes equal the payload')
  })

  test('the revive is stampede-locked: a fresh lock suppresses re-spawn, a stale lock re-arms it', async () => {
    const lock = path.join(tmp, '.daemon-revive.lock')
    fs.writeFileSync(lock, 'SENTINEL') // fresh mtime = now
    await forwardHookEvent(Buffer.from(JSON.stringify({ hook_event_name: 'PreToolUse' })), { baseUrl: DEAD, timeoutMs: 300 })
    assert.strictEqual(fs.readFileSync(lock, 'utf-8'), 'SENTINEL', 'a fresh lock is NOT rewritten — the burst collapses to one revive')

    const old = Date.now() / 1000 - 3600 // 1h ago → older than any TTL
    fs.utimesSync(lock, old, old)
    await forwardHookEvent(Buffer.from(JSON.stringify({ hook_event_name: 'PreToolUse' })), { baseUrl: DEAD, timeoutMs: 300 })
    assert.notStrictEqual(fs.readFileSync(lock, 'utf-8'), 'SENTINEL', 'a stale lock re-arms the revive (lock is refreshed)')
  })

  /** The pid the freshly-spawned server wrote, or null if it never wrote one inside `budgetMs`.
   *  Bounded polling, never a bare sleep-then-assume — and shared by the assertion and the
   *  teardown so they cannot disagree about whether a child exists. */
  async function waitForPid(pidPath: string, budgetMs: number): Promise<number | null> {
    const deadline = Date.now() + budgetMs
    while (Date.now() < deadline) {
      try {
        const raw = fs.readFileSync(pidPath, 'utf-8').trim()
        const parsed = /^\d+$/.test(raw) ? Number(raw) : Number((JSON.parse(raw) as { pid?: unknown }).pid)
        if (Number.isFinite(parsed) && parsed > 0) return parsed
      } catch { /* not written yet */ }
      await sleep(100)
    }
    return null
  }

  test('a hook-revived server LOGS — its output lands in server.log, not /dev/null', async function () {
    // Real spawn + real boot: the default 10s mocharc timeout is not enough for a cold server.
    this.timeout(60_000)
    // Every other test in this suite runs under AGENTLENS_NO_REVIVE=1, so reviveDaemonDetached()
    // returns before ever reaching the fs.openSync/spawn code this test exists to prove. This one
    // test needs the real thing, so it lifts the guard for its own duration only.
    const prevNoRevive = process.env.AGENTLENS_NO_REVIVE
    delete process.env.AGENTLENS_NO_REVIVE
    // THE CHILD MUST BE ABLE TO BOOT, and giving it a scratch DATA_DIR is not enough to arrange
    // that. The revive spawns with no port overrides, so the child inherits OUR env and otherwise
    // binds the DEFAULTS (MCP 4316 / UI 3000 / OTLP 4318). On this machine the canonical server
    // already holds those, so the child died on "Port 4316 already in use" — it wrote 309 bytes
    // of error and NEVER a pidfile, so the teardown below found nothing to kill and the suite's
    // "no leak" was luck, not cleanup. On CI those ports are FREE: the child would boot and
    // SURVIVE, inside publish.yml's pre-publish test gate — the gap TRDD-1FSPKQ6C now carries.
    //
    // NO PORT OVERRIDE — and this is a RETREAT, recorded as one. Three rounds of fixes tried to
    // make the revived child BOOT so the teardown could kill a live process: hand-rolled ports
    // (collided), a stride fix (still inside Linux's ephemeral range), then `freePort()`. The
    // third worked and cost more than it bought: a real server binding three ports inside the
    // SHARED mocha process destabilised unrelated suites — measured 2 failures in 8 runs, in
    // `OtlpCollector` ("socket hang up") and an HTTP body test, neither of which this file touches.
    // A 25% flake rate across the suite is a worse defect than the one being chased.
    //
    // So the child once again binds the DEFAULTS and dies fast when they are taken. What this test
    // proves is therefore exactly one thing, stated so nobody re-derives more from it: THE REVIVE
    // REDIRECTS ITS CHILD'S OUTPUT TO server.log INSTEAD OF /dev/null. That claim is fully carried
    // by the bytes assertion and was falsified by mutation (`stdio: 'ignore'` → 0 bytes → red).
    //
    // What it does NOT prove — and the teardown below is defence-in-depth, not evidence:
    //   * that a LIVE child is reaped. On this machine the canonical server holds 4316, so the
    //     child dies on a port conflict and there is nothing to reap.
    //   * anything about CI, where those ports are free and the child WOULD survive. TRDD-1FSPKQ6C
    //     carries that gap and the `AGENTLENS_WATCHDOG=off` finding, which is the sharper half.
    const prevPorts = { AGENTLENS_WATCHDOG: process.env.AGENTLENS_WATCHDOG }
    // AGENTLENS_WATCHDOG=off IS NOT OPTIONAL, and this test had missed it. `spawnServerWithRetry`
    // (helpers/freePort.ts) sets it at its choke point and records why, from a real incident: the
    // watchdog's self-heal respawns the server `detached: true` + `unref()` (loopWatchdog.ts:85),
    // which reparents to PID 1, and the respawned pid is created INSIDE the server — so the
    // pidfile this test's teardown reads names the ORIGINAL child, and no test code ever holds a
    // handle on the replacement. Their note: "one such orphan was found alive 54 minutes after a
    // run, PPID 1, on that run's ephemeral ports (it inherits the test env, so it re-binds them)."
    //
    // That is a leak my teardown provably CANNOT reap, so killing the pid it knows would have gone
    // on looking clean. The revive inherits our env, which is the only channel we have into a
    // child we do not spawn ourselves.
    process.env.AGENTLENS_WATCHDOG = 'off'
    try { fs.rmSync(path.join(tmp, '.daemon-revive.lock')) } catch { /* none yet */ }
    const logPath = path.join(tmp, 'server.log')
    const pidPath = path.join(tmp, 'server.pid')
    let pid: number | null = null
    try {
      await forwardHookEvent(Buffer.from(JSON.stringify({ hook_event_name: 'PreToolUse' })), { baseUrl: DEAD, timeoutMs: 300 })
      // EXISTENCE IS NOT THE ASSERTION, and the first version of this test made that mistake.
      // `fs.openSync(<dataDir>/server.log, 'a')` runs synchronously inside reviveDaemonDetached()
      // BEFORE spawn, so the file appears whatever `stdio` then does with the descriptor. Proven
      // by mutation: with the fd still opened but `stdio: 'ignore'` restored, an existence-only
      // assertion PASSED — i.e. it could not fail on the exact regression it names. The claim in
      // this test's title is that output LANDS there, so the assertion has to be bytes.
      //
      // Waiting for bytes is safe here precisely because the teardown below already has to wait
      // for the pidfile: a server that got far enough to write its pid has printed its boot line.
      // DO NOT gate this on the child booting SUCCESSFULLY — an earlier version did, waiting for
      // a pidfile first, and it skipped every run: the child never wrote one within 30s. That gate
      // was the wrong precondition anyway. The claim under test is "output lands in server.log",
      // and a child that CRASHES proves it just as well as one that boots — its stderr is exactly
      // the output that used to vanish into /dev/null, and it is the output an operator most needs
      // after an unexplained death. Requiring a healthy boot to believe the redirect works confuses
      // "the server started" with "the server's output was captured", which are different claims.
      let logged = 0
      const deadline = Date.now() + 20_000
      while (Date.now() < deadline) {
        try { logged = fs.statSync(logPath).size } catch { /* not created yet */ }
        if (logged > 0) break
        await sleep(100)
      }
      assert.ok(logged > 0,
        'the revived child wrote to server.log — boot banner or crash output, either proves the '
        + `stdio redirect. Got ${logged} bytes; with the pre-fix \`stdio: 'ignore'\` this is always 0.`)

      // WHICH BRANCH DID WE TAKE? The byte assertion above is satisfied identically by a boot
      // banner and by "Port 4316 already in use" — so on its own it cannot tell a healthy child
      // from a crashed one, and a crashed child means the teardown below never runs.
      const logText = fs.readFileSync(logPath, 'utf-8')
      // Report WHICH branch produced the bytes, without asserting on it. A port conflict is the
      // EXPECTED path on a machine already running the canonical server, so asserting against it
      // would fail for the wrong reason; but leaving it unsaid is how "a crashed child" got read
      // as "cleanup worked" in the first place. Printing it keeps the distinction visible to
      // whoever reads the run.
      const crashed = /already in use/i.test(logText)
      console.log(`         ↳ redirect proven via ${crashed ? 'the child\'s PORT-CONFLICT error' : 'the child\'s boot output'}`
        + ` (${logged} bytes). ${crashed ? 'No live child existed, so the teardown below did not run — see TRDD-1FSPKQ6C.' : ''}`)
    } finally {
      // Poll (bounded, never a bare sleep-then-assume) for the pidfile the real spawned server
      // writes on boot, and kill it — otherwise this test leaks a live standalone/server.js process.
      pid ??= await waitForPid(pidPath, 5000)
      if (pid !== null) {
        // SIGKILL, not the default SIGTERM: on a machine with the default ports genuinely free
        // (the exact CI condition this file is about) the revived child BOOTS instead of crashing
        // on a port conflict, and a graceful SIGTERM was measured to leave it alive for well over a
        // minute (server shutdown draining timers/sockets) — long enough to show up as a live
        // orphan in the very next ps snapshot this suite's acceptance criteria check for.
        try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
        try { fs.unlinkSync(pidPath) } catch { /* best effort */ }
      }
      // If no pidfile ever showed up, we have nothing to kill by pid — but note this WOULD be a
      // leaked process if the server did start without ever writing its pidfile in time.
      if (prevNoRevive === undefined) delete process.env.AGENTLENS_NO_REVIVE
      else process.env.AGENTLENS_NO_REVIVE = prevNoRevive
      for (const [k, v] of Object.entries(prevPorts)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  test('the spool is bounded — over the cap, the oldest events are dropped, never unbounded', async () => {
    setEnv('AGENTLENS_HOOK_SPOOL_MAX', '3')
    fs.rmSync(spoolDir(), { recursive: true, force: true })
    fs.mkdirSync(spoolDir(), { recursive: true })
    // Seed 3 pre-existing spool files with sortable (time-ordered) names; the oldest is 100-*.
    for (const t of ['100', '200', '300']) fs.writeFileSync(path.join(spoolDir(), `${t}-old.json`), `{"hook_event_name":"old-${t}"}`)
    await forwardHookEvent(Buffer.from(JSON.stringify({ hook_event_name: 'PreToolUse', newest: true })), { baseUrl: DEAD, timeoutMs: 300 })
    const files = spoolFiles()
    assert.strictEqual(files.length, 3, 'file count stays at the cap (dropped one oldest, wrote one new)')
    assert.ok(!files.includes('100-old.json'), 'the oldest spooled event was dropped')
    assert.ok(files.includes('200-old.json') && files.includes('300-old.json'), 'the newer pre-existing events survive')
    delete process.env.AGENTLENS_HOOK_SPOOL_MAX
  })
})

// ── TRDD-1FSPKQ6C — a live revived child is reaped, proven from an ISOLATED subprocess ────────────
// The test above only proves the redirect (see its own comment for why). This suite closes the
// real gap it leaves — "does a LIVE revived child actually get reaped?" — without repeating any of
// the card's three failed attempts to answer that INSIDE the shared mocha process. `reviveHarness.ts`
// is a separate node process this test spawns: it binds real ports, revives a real detached server,
// kills it, and reports the outcome as JSON. Nothing here binds a port inside mocha's own process,
// so the isolation that destabilised the suite in attempt 3 never happens.
suite('hook spool — a live revived child is reaped (isolated subprocess)', () => {
  test('reviveDaemonDetached spawns a real child that gets killed — proven as a checked fact, not inferred', async function () {
    this.timeout(60_000)
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'al-revive-harness-'))
    const home = path.join(tmp, 'home')
    const data = path.join(tmp, 'data')
    fs.mkdirSync(home, { recursive: true })
    fs.mkdirSync(data, { recursive: true })
    const pidPath = path.join(data, 'server.pid')
    const harnessJs = path.resolve(__dirname, 'helpers', 'reviveHarness.js')

    const env = { ...process.env, DATA_DIR: data, HOME: home, AGENTLENS_WATCHDOG: 'off' } as NodeJS.ProcessEnv
    delete env.AGENTLENS_NO_REVIVE // the harness must be free to actually spawn the revive

    try {
      const child = spawn(process.execPath, [harnessJs], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      child.stdout?.on('data', (d: Buffer) => { out += d.toString() })
      child.stderr?.on('data', (d: Buffer) => { err += d.toString() })
      const exitCode = await new Promise<number>((resolve) => child.on('close', (code) => resolve(code ?? -1)))

      assert.strictEqual(exitCode, 0, `harness exited ${exitCode} — stderr: ${err.slice(-2000)}\nstdout: ${out.slice(-2000)}`)
      const lines = out.trim().split('\n').filter(Boolean)
      const last = lines[lines.length - 1] ?? ''
      const result = JSON.parse(last) as { revivedPid: number | null; reaped: boolean }

      // THE ONE-LINE FORM THE CARD NAMES: proving a live child existed is a checked fact, not
      // re-derived by hand from a mutation or inferred from "no orphan showed up".
      assert.ok(result.revivedPid !== null, `no live child was ever revived (harness result: ${last})`)
      assert.ok(result.reaped, `the harness's own kill did not reap pid ${result.revivedPid}`)
    } finally {
      // BELT-AND-BRACES: re-read the pidfile straight off disk and kill on it directly — independent
      // of whether the harness process crashed, hung, or lied in its own JSON. The revived child is
      // detached + reparented to PID 1, so if this doesn't reap it, nothing else will.
      try {
        if (fs.existsSync(pidPath)) {
          const raw = fs.readFileSync(pidPath, 'utf-8').trim()
          const pid = /^\d+$/.test(raw) ? Number(raw) : Number((JSON.parse(raw) as { pid?: unknown }).pid)
          if (Number.isFinite(pid) && pid > 0) { try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ } }
        }
      } catch { /* best effort */ }
      try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  })
})

// ── Integration: the real built server drains the spool on boot ──────────────────────────────────
interface HttpResult { status: number; json: unknown }
function httpReq(port: number, method: string, urlPath: string, body?: unknown): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {} }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => { const t = Buffer.concat(chunks).toString('utf-8'); let j: unknown = null; if (t) { try { j = JSON.parse(t) } catch { j = null } } resolve({ status: res.statusCode ?? 0, json: j }) })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}
suite('hook spool — real server drains it on boot (integration)', () => {
  let child: ChildProcess | undefined
  let uiPort = 0
  let tmpDir = ''

  suiteSetup(async function () {
    this.timeout(45_000)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-spool-boot-'))
    const home = path.join(tmpDir, 'home'); const data = path.join(tmpDir, 'data')
    fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(data, { recursive: true })
    // Pre-populate the spool BEFORE boot: two valid events + one unparseable file (must be dropped).
    const spool = path.join(data, 'hook-spool'); fs.mkdirSync(spool, { recursive: true })
    fs.writeFileSync(path.join(spool, '1000-a.json'), JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'spooltest', tool_name: 'Bash' }))
    fs.writeFileSync(path.join(spool, '2000-b.json'), JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'spooltest', tool_name: 'Read' }))
    fs.writeFileSync(path.join(spool, '3000-bad.json'), '{ this is not valid json')

    const serverJs = path.resolve(__dirname, '..', '..', '..', 'standalone', 'server.js')
    // TRDD-1QFP73WA: spawnServerWithRetry re-probes fresh ports and retries when the OS hands the
    // ephemeral port to something else between our probe and the child's own listen().
    const spawned = await spawnServerWithRetry({
      serverJs,
      buildEnv: async () => {
        const [otlp, ui, mcp] = [await freePort(), await freePort(), await freePort()]
        const env = { ...process.env } as NodeJS.ProcessEnv
        delete env.AGENTLENS_GATE; delete env.AGENTLENS_GATE_MODE; delete env.AGENTLENS_NO_REVIVE; delete env.DATA_DIR
        Object.assign(env, { HOME: home, DATA_DIR: data, OTLP_PORT: String(otlp), UI_PORT: String(ui), MCP_PORT: String(mcp), BIND_HOST: '127.0.0.1', AGENTLENS_NO_TELEMETRY_CONFIG: '1', AGENTLENS_OPEN_BROWSER: '0' })
        return env
      },
      readyPort: (env) => Number(env.UI_PORT),
    })
    child = spawned.child
    uiPort = Number(spawned.env.UI_PORT)
    // The drain runs at boot; give the (synchronous) drain + the first read a beat.
    await sleep(500)
  })

  suiteTeardown(async function () {
    this.timeout(15_000)
    try {
      if (child && child.exitCode === null && child.signalCode === null) {
        const closed = new Promise<void>((res) => child?.on('close', () => res()))
        child.kill('SIGTERM')
        const ok = await Promise.race([closed.then(() => true), sleep(5_000).then(() => false)])
        if (!ok) { child.kill('SIGKILL'); await closed }
      }
    } finally { try { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best effort */ } }
  })

  test('spooled events are reingested and the spool is emptied (bad payloads dropped, not wedged)', async () => {
    const got = await httpReq(uiPort, 'GET', '/api/hook-events?session=spooltest')
    assert.strictEqual(got.status, 200)
    const evs = (got.json as { events?: Array<{ ev?: string }> }).events ?? []
    const names = evs.map((e) => e.ev).sort()
    assert.deepStrictEqual(names, ['PostToolUse', 'PreToolUse'], `both spooled events were reingested (got ${JSON.stringify(names)})`)
    // The spool dir is emptied by the drain — both valid files ingested+deleted, the bad one dropped.
    const remaining = fs.readdirSync(path.join(tmpDir, 'data', 'hook-spool')).filter((n) => n.endsWith('.json'))
    assert.strictEqual(remaining.length, 0, `spool dir is drained (remaining: ${JSON.stringify(remaining)})`)
  })
})
