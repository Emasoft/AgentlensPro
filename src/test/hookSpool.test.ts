import * as assert from 'assert'
import * as http from 'http'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import type { ChildProcess } from 'child_process'
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
    // SURVIVE, inside publish.yml's pre-publish test gate. Unique high ports make the child
    // bootable here and killable everywhere — the port env is the isolation the data dir is not.
    // ASK THE OS, do not compute. Two hand-rolled schemes died here before this line settled on
    // the helper this very file already imports for its integration suite (`freePort`, line 8;
    // used at :203). First `45000 + pid % 2000` with ports at base..base+2 — adjacent pids OVERLAP
    // (pid 100 takes 45100-45102, pid 101 takes 45101-45103; exhaustively: 297,898 clashes across
    // pids 1..99,999). Then a stride of 4 fixed the arithmetic and left the real problem:
    // **45000-46996 sits inside Linux's default ephemeral range (32768-60999)**, so on
    // `ubuntu-latest` — the platform this whole fix exists for — an unrelated process can already
    // hold the port. macOS starts ephemeral at 49152, which is why both schemes looked clean here.
    // `freePort()` binds :0 and asks the kernel, so there is no range to be wrong about.
    const [mcp, ui, otlp] = [await freePort(), await freePort(), await freePort()]
    const prevPorts = { MCP_PORT: process.env.MCP_PORT, UI_PORT: process.env.UI_PORT, OTLP_PORT: process.env.OTLP_PORT }
    process.env.MCP_PORT = String(mcp)
    process.env.UI_PORT = String(ui)
    process.env.OTLP_PORT = String(otlp)
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
      // from a crashed one, and a crashed child means the teardown below never runs and the
      // "no leak" result is luck. That is the exact failure this suite was fixing, and leaving it
      // un-discriminated would have nested it inside its own fix. A port conflict is now a hard
      // failure rather than a silent pass: `freePort()` makes it a real defect if it ever happens.
      const logText = fs.readFileSync(logPath, 'utf-8')
      assert.ok(!/already in use/i.test(logText),
        `the revived child hit a port conflict, so this test proved only that errors are captured `
        + `— not that a LIVE child is killed. freePort() should make this impossible: ${logText.slice(0, 300)}`)
    } finally {
      // Poll (bounded, never a bare sleep-then-assume) for the pidfile the real spawned server
      // writes on boot, and kill it — otherwise this test leaks a live standalone/server.js process.
      pid ??= await waitForPid(pidPath, 5000)
      if (pid !== null) {
        try { process.kill(pid) } catch { /* already gone */ }
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
