import * as assert from 'assert'
import * as http from 'http'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import { spawn, type ChildProcess } from 'child_process'
import type { AddressInfo } from 'net'

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

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = http.createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port
      s.close(() => resolve(port))
    })
  })
}

suite('standalone server — ACAO is scoped to allowed origins, never wildcard (real boot)', () => {
  let child: ChildProcess | undefined
  let uiPort = 0
  let mcpPort = 0
  let tmpDir = ''
  let logBuf = ''

  suiteSetup(async function () {
    this.timeout(45_000)
    const [otlp, ui, mcp] = [await freePort(), await freePort(), await freePort()]
    uiPort = ui
    mcpPort = mcp
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-cors-'))
    const home = path.join(tmpDir, 'home')
    const data = path.join(tmpDir, 'data')
    fs.mkdirSync(home, { recursive: true })
    fs.mkdirSync(data, { recursive: true })

    const serverJs = path.resolve(__dirname, '..', '..', '..', 'standalone', 'server.js')
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

    child = spawn(process.execPath, [serverJs], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout?.on('data', (d: Buffer) => { logBuf += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { logBuf += d.toString() })

    const deadline = Date.now() + 30_000
    for (;;) {
      if (child.exitCode !== null) throw new Error(`server exited early (code=${child.exitCode})\n${logBuf.slice(-2000)}`)
      try {
        const r = await httpReqHeaders(ui, 'GET', '/api/server-stats')
        if (r.status === 200) break
      } catch { /* not listening yet */ }
      if (Date.now() > deadline) throw new Error(`server not ready within 30s\n${logBuf.slice(-2000)}`)
      await sleep(250)
    }
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
      try { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best effort */ }
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
