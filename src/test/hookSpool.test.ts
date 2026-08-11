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
