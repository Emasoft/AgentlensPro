import * as assert from 'assert'
import * as http from 'http'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import { type ChildProcess } from 'child_process'
import { freePort, spawnServerWithRetry } from './helpers/freePort'

// ── CORS read-scope hardening (TRDD-F6BM1BDI) ───────────────────────────────────────────────────
// Boots the REAL built server and checks the UI server's Access-Control-Allow-Origin behaviour: it
// must ECHO an allowed (loopback) origin, and send NO ACAO for a disallowed cross-origin (evil.com)
// — never the wildcard `*` that let any browsed page read the user's local session data cross-origin.
// A same-origin/no-Origin request needs no ACAO. Full isolation (private HOME + DATA_DIR, ephemeral
// ports); teardown kills the child.
// The MCP endpoint gets the SAME policy (src/httpOrigin.ts is the one source of truth): scoped ACAO,
// a 403 CSRF gate on cross-origin POST (POST /mcp EXECUTES a tool), and a hard 4 MB body cap that
// destroys the socket on overflow — while origin-less (CLI) POSTs keep working.

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface HttpResult { status: number; headers: http.IncomingHttpHeaders }
function httpReqHeaders(port: number, method: string, urlPath: string, origin?: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {}
    if (origin) headers.Origin = origin
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      res.on('data', () => { /* drain */ })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }))
    })
    req.on('error', reject)
    req.end()
  })
}

suite('standalone server — ACAO is scoped to allowed origins, never wildcard (real boot)', () => {
  let child: ChildProcess | undefined
  let uiPort = 0
  let mcpPort = 0
  const tmpDirs: string[] = []   // one per boot ATTEMPT — a retried attempt still left a dir behind

  suiteSetup(async function () {
    // Ports come from the SHARED helper, not a local probe: it carries the in-process claimed-set
    // and `spawnServerWithRetry` re-picks fresh ports on the "already in use" early-exit. That
    // TOCTOU race (probe → close → the OS re-hands the port before the child binds) shed a CI run
    // on 2026-08-14. Retries are bounded and any NON-port failure still throws on attempt 1, so a
    // real server bug can never be masked as contention. (TRDD-1QFP73WA owns the helper.)
    this.timeout(120_000)
    const serverJs = path.resolve(__dirname, '..', '..', '..', 'standalone', 'server.js')
    const spawned = await spawnServerWithRetry({
      serverJs,
      readyPort: (env) => Number(env.UI_PORT),
      buildEnv: async () => {
        const [otlp, ui, mcp] = [await freePort(), await freePort(), await freePort()]
        uiPort = ui
        mcpPort = mcp
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-cors-'))
        tmpDirs.push(dir)
        const home = path.join(dir, 'home')
        const data = path.join(dir, 'data')
        fs.mkdirSync(home, { recursive: true })
        fs.mkdirSync(data, { recursive: true })
        const env = { ...process.env } as NodeJS.ProcessEnv
        delete env.AGENTLENS_GATE
        delete env.AGENTLENS_GATE_MODE
        Object.assign(env, {
          HOME: home,
          DATA_DIR: data,
          OTLP_PORT: String(otlp),
          UI_PORT: String(ui),
          MCP_PORT: String(mcp),
          BIND_HOST: '127.0.0.1',
          AGENTLENS_NO_TELEMETRY_CONFIG: '1',
          AGENTLENS_OPEN_BROWSER: '0',
        })
        return env
      },
    })
    child = spawned.child
  })

  suiteTeardown(async function () {
    this.timeout(15_000)
    try {
      if (child && child.exitCode === null && child.signalCode === null) {
        const closed = new Promise<void>((res) => child?.on('close', () => res()))
        child.kill('SIGTERM')
        const graceful = await Promise.race([closed.then(() => true), sleep(5_000).then(() => false)])
        if (!graceful) { child.kill('SIGKILL'); await closed }
      }
      if (child) {
        assert.ok(child.exitCode !== null || child.signalCode !== null, 'server child must have exited')
      }
    } finally {
      for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ } }
    }
  })

  test('a disallowed cross-origin GET (evil.com) gets NO Access-Control-Allow-Origin header', async () => {
    const r = await httpReqHeaders(uiPort, 'GET', '/api/server-stats', 'https://evil.com')
    assert.strictEqual(r.status, 200, 'read endpoint still responds')
    assert.strictEqual(
      r.headers['access-control-allow-origin'], undefined,
      `evil.com must not get an ACAO header (got "${r.headers['access-control-allow-origin']}") — ` +
      `a present header (esp. "*") would let the page read the local session data cross-origin`,
    )
  })

  test('an allowed loopback origin gets its own origin echoed as ACAO (not wildcard)', async () => {
    const loopback = `http://localhost:${uiPort + 1}`
    const r = await httpReqHeaders(uiPort, 'GET', '/api/server-stats', loopback)
    assert.strictEqual(r.status, 200)
    assert.strictEqual(r.headers['access-control-allow-origin'], loopback, 'loopback origin echoed exactly')
    assert.notStrictEqual(r.headers['access-control-allow-origin'], '*', 'never the wildcard')
  })

  test('a same-origin / no-Origin GET succeeds with no ACAO needed', async () => {
    const r = await httpReqHeaders(uiPort, 'GET', '/api/server-stats')
    assert.strictEqual(r.status, 200)
    assert.strictEqual(r.headers['access-control-allow-origin'], undefined, 'no Origin → no ACAO required')
  })

  // ── MCP endpoint — same policy, plus the CSRF gate and the body cap ──────────────────────────

  /** POST a body to the MCP port; resolves the status, rejects on a destroyed socket. */
  function mcpPost(body: Buffer | string, origin?: string): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (origin) headers.Origin = origin
      const req = http.request({ host: '127.0.0.1', port: mcpPort, method: 'POST', path: '/mcp', headers }, (res) => {
        res.on('data', () => { /* drain */ })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }))
      })
      req.on('error', reject)
      req.end(body)
    })
  }

  test('MCP: a disallowed cross-origin GET (evil.com) gets NO ACAO header', async () => {
    const r = await httpReqHeaders(mcpPort, 'GET', '/mcp', 'https://evil.com')
    assert.strictEqual(r.status, 200, 'health check still responds')
    assert.strictEqual(
      r.headers['access-control-allow-origin'], undefined,
      `evil.com must not get an ACAO header on the MCP endpoint (got "${r.headers['access-control-allow-origin']}") — ` +
      'MCP responses carry session data (prompts, costs, project paths)',
    )
  })

  test('MCP: an allowed loopback origin gets its own origin echoed as ACAO (not wildcard)', async () => {
    const loopback = `http://localhost:${mcpPort + 1}`
    const r = await httpReqHeaders(mcpPort, 'GET', '/mcp', loopback)
    assert.strictEqual(r.status, 200)
    assert.strictEqual(r.headers['access-control-allow-origin'], loopback, 'loopback origin echoed exactly')
    assert.notStrictEqual(r.headers['access-control-allow-origin'], '*', 'never the wildcard')
  })

  test('MCP: a cross-origin POST is refused with 403 before any tool executes (CSRF gate)', async () => {
    const r = await mcpPost(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), 'https://evil.com')
    assert.strictEqual(r.status, 403, 'a "simple" cross-origin POST must be refused — POST /mcp executes tools')
  })

  test('MCP: an origin-less (CLI-style) POST is NOT blocked by the origin gate', async () => {
    // Not a full MCP handshake — the point is the guard layer: no Origin ⇒ never 403, never destroyed.
    const r = await mcpPost(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
    assert.notStrictEqual(r.status, 403, 'origin-less clients (the CLI) must pass the origin gate')
  })

  test('MCP: a body over the 4 MB cap destroys the socket instead of buffering it', async function () {
    this.timeout(20_000)
    const fiveMb = Buffer.alloc(5 * 1024 * 1024, 0x61)
    await assert.rejects(
      mcpPost(fiveMb),
      (err: NodeJS.ErrnoException) => err.code === 'ECONNRESET' || err.code === 'EPIPE',
      'an oversized body must be dropped at the socket (uncapped buffering was an OOM vector)',
    )
  })
})
