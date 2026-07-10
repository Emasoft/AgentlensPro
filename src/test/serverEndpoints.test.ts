import * as assert from 'assert'
import * as http from 'http'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import { spawn, type ChildProcess } from 'child_process'
import type { AddressInfo } from 'net'

// ── AgentLens standalone server — hook/gate/burn endpoints (real boot) ─────────
// Boots the REAL built server (standalone/server.js) ONCE for the suite, on isolated ports
// and an isolated HOME + DATA_DIR, so it never touches ~/.claude or the real ~/.agentlens and
// never collides with the canonical instance on port 3000. Every endpoint is exercised over
// real HTTP; nothing is mocked. Teardown always kills the child and verifies it died.

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface HttpResult { status: number; text: string; json: unknown }
function httpReq(port: number, method: string, urlPath: string, body?: unknown): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
    const req = http.request(
      {
        host: '127.0.0.1', port, method, path: urlPath,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8')
          let json: unknown = null
          if (text) { try { json = JSON.parse(text) } catch { json = null } }
          resolve({ status: res.statusCode ?? 0, text, json })
        })
      },
    )
    req.on('error', reject)
    if (payload) req.write(payload)
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

suite('standalone server — hook/gate/burn endpoints (real boot)', () => {
  let child: ChildProcess | undefined
  let uiPort = 0
  let tmpDir = ''
  let logBuf = ''

  async function receivedCounter(): Promise<number> {
    const r = await httpReq(uiPort, 'GET', '/api/server-stats')
    const j = r.json as { hookEvents?: { receivedSinceBoot?: number } }
    return j.hookEvents?.receivedSinceBoot ?? 0
  }

  suiteSetup(async function () {
    this.timeout(45_000)
    const [otlp, ui, mcp] = [await freePort(), await freePort(), await freePort()]
    uiPort = ui
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-srv-'))
    const home = path.join(tmpDir, 'home')
    const data = path.join(tmpDir, 'data')
    fs.mkdirSync(home, { recursive: true })
    fs.mkdirSync(data, { recursive: true })

    const serverJs = path.resolve(__dirname, '..', '..', '..', 'standalone', 'server.js')
    const env = { ...process.env } as NodeJS.ProcessEnv
    // Full isolation: private HOME (log scan hits an empty tree; getCurrentAccount finds none) +
    // private DATA_DIR. Non-4318 OTLP port ⇒ non-canonical ⇒ no pidfile, no global config writes.
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
        const r = await httpReq(ui, 'GET', '/api/server-stats')
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
      // Verify the child actually died — a leaked collector would keep ports + timers alive.
      if (child) {
        assert.ok(child.exitCode !== null || child.signalCode !== null, 'server child must have exited')
      }
    } finally {
      try { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  })

  test('POST /api/hook-events is accepted (2xx) and increments the received-since-boot counter', async () => {
    // Capture is on by default → an accepted lifecycle event is persisted and counted.
    const before = await receivedCounter()
    const r = await httpReq(uiPort, 'POST', '/api/hook-events', { hook_event_name: 'SessionStart', session_id: 'ep-1' })
    assert.ok(r.status >= 200 && r.status < 300, `expected 2xx, got ${r.status}`)
    assert.strictEqual((r.json as { ok?: boolean }).ok, true)
    assert.strictEqual(await receivedCounter(), before + 1, 'the accepted event must be counted')
  })

  test('GET /api/hook-config returns the built-in defaults', async () => {
    // A fresh DATA_DIR has no hook-config.json, so the server reports the compiled defaults.
    const r = await httpReq(uiPort, 'GET', '/api/hook-config')
    assert.strictEqual(r.status, 200)
    const j = r.json as { config: unknown }
    assert.deepStrictEqual(j.config, { captureEnabled: true, gateEnabled: true, gateMode: 'enforce', advisorEnabled: true })
  })

  test('POST /api/hook-config captureEnabled=false round-trips through a subsequent GET', async () => {
    // A realtime switch flip must persist and be visible on the very next read.
    const post = await httpReq(uiPort, 'POST', '/api/hook-config', { captureEnabled: false })
    assert.strictEqual(post.status, 200)
    assert.strictEqual((post.json as { config: { captureEnabled: boolean } }).config.captureEnabled, false)
    const get = await httpReq(uiPort, 'GET', '/api/hook-config')
    assert.strictEqual((get.json as { config: { captureEnabled: boolean } }).config.captureEnabled, false)
  })

  test('with capture OFF, POST /api/hook-events is accepted (2xx) but dropped (counter unchanged)', async () => {
    // A disabled forwarder must still ACK 2xx (never look like an outage) yet store nothing.
    await httpReq(uiPort, 'POST', '/api/hook-config', { captureEnabled: false }) // explicit precondition
    const before = await receivedCounter()
    const r = await httpReq(uiPort, 'POST', '/api/hook-events', { hook_event_name: 'SessionStart', session_id: 'ep-drop' })
    assert.ok(r.status >= 200 && r.status < 300, `dropped events are still ACKed 2xx, got ${r.status}`)
    const j = r.json as { ok?: boolean; dropped?: string }
    assert.strictEqual(j.ok, true)
    assert.ok(typeof j.dropped === 'string', 'response notes the drop')
    assert.strictEqual(await receivedCounter(), before, 'a dropped event must not be counted')
  })

  test('POST /api/agent-gate returns 204 (allow) for a benign Task launch', async () => {
    // No transcript, no fan-out, no stall → the gate stays silent (204, empty body = allow).
    const r = await httpReq(uiPort, 'POST', '/api/agent-gate', {
      hook_event_name: 'PreToolUse', session_id: 'ep-benign', tool_input: { subagent_type: 'general-purpose' },
    })
    assert.strictEqual(r.status, 204)
    assert.strictEqual(r.text, '', 'allow = empty body')
  })

  test('POST /api/agent-gate DENIES on RUNAWAY_FANOUT after >8 SubagentStart events in 60s', async () => {
    // Nine SubagentStart events in the ring push startsLast60s past the runaway threshold (8).
    await httpReq(uiPort, 'POST', '/api/hook-config', { captureEnabled: true }) // ring must be fed
    for (let i = 0; i < 9; i++) {
      await httpReq(uiPort, 'POST', '/api/hook-events', {
        hook_event_name: 'SubagentStart', session_id: 'ep-burst', cwd: '/tmp/ep', agent_type: 'general-purpose',
      })
    }
    const r = await httpReq(uiPort, 'POST', '/api/agent-gate', {
      hook_event_name: 'PreToolUse', session_id: 'ep-burst', tool_input: { subagent_type: 'general-purpose' },
    })
    assert.strictEqual(r.status, 200)
    const j = r.json as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }
    assert.strictEqual(j.hookSpecificOutput?.permissionDecision, 'deny')
    assert.ok((j.hookSpecificOutput?.permissionDecisionReason ?? '').toLowerCase().includes('runaway'), 'reason names the runaway fan-out')
  })

  test('gate=off via /api/hook-config makes the SAME runaway state return 204 (allow)', async () => {
    // Disabling the gate short-circuits every launch to allow, even the runaway state above.
    await httpReq(uiPort, 'POST', '/api/hook-config', { gateEnabled: false })
    const r = await httpReq(uiPort, 'POST', '/api/agent-gate', {
      hook_event_name: 'PreToolUse', session_id: 'ep-burst', tool_input: { subagent_type: 'general-purpose' },
    })
    assert.strictEqual(r.status, 204)
    assert.strictEqual(r.text, '')
  })

  test('GET /api/burn-risk returns 200 with a risks array', async () => {
    // The REST fast path always yields a full BurnRiskReport carrying a risks array.
    const r = await httpReq(uiPort, 'GET', '/api/burn-risk')
    assert.strictEqual(r.status, 200)
    assert.ok(Array.isArray((r.json as { risks?: unknown }).risks), 'report must carry a risks array')
  })
})
