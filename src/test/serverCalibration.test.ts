import * as assert from 'assert'
import * as http from 'http'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import { spawn, type ChildProcess } from 'child_process'
import type { AddressInfo } from 'net'

// ── P5 window auto-calibration — REAL end-to-end through the ingest path ───────
// Boots the REAL built server (standalone/server.js) ONCE on isolated ports + an isolated
// HOME/DATA_DIR (never ~/.agentlens, never the canonical instance — see the resident-server
// guardrail), ingests consumption through the REAL OTLP endpoint (api_request log events +
// the body-pointer account registration), then replays synthetic StopFailure fixtures through
// POST /api/hook-events and asserts on the burn-config.json the calibration wrote and on the
// live /api/burn-status budgets. Nothing under test is mocked.
//
// Determinism note: the server runs ingest AND calibration synchronously inside each request
// handler (the 200 response is written after calibrateFromStopFailure returned), so once a
// POST resolves the file/GETs below reflect it — no sleeps beyond the boot wait.

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const HOUR = 3_600_000
const MIN = 60_000

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

const nano = (ms: number): string => (BigInt(ms) * 1_000_000n).toString()
const attr = (key: string, value: { stringValue?: string; intValue?: number }) => ({ key, value })

/** One claude_code.api_request OTLP log record — the real per-call consumption event shape. */
function apiRequestRecord(sessionId: string, ts: number, tokens: number, costUsd: number) {
  return {
    timeUnixNano: nano(ts),
    attributes: [
      attr('event.name', { stringValue: 'claude_code.api_request' }),
      attr('session.id', { stringValue: sessionId }),
      attr('model', { stringValue: 'claude-sonnet-4-5' }),
      attr('input_tokens', { intValue: tokens }),
      attr('output_tokens', { intValue: 0 }),
      attr('cache_read_tokens', { intValue: 0 }),
      attr('cache_creation_tokens', { intValue: 0 }),
      attr('cost_usd', { stringValue: String(costUsd) }),
      attr('duration_ms', { stringValue: '1200' }),
    ],
  }
}

/** The body-pointer event that attributes a session to an OAuth account at ingest
 *  (callBodyRegistry.recordAccount — the standalone's real account-attribution path). */
function accountRecord(sessionId: string, accountUuid: string, ts: number) {
  return {
    timeUnixNano: nano(ts),
    attributes: [
      attr('event.name', { stringValue: 'claude_code.api_request_body' }),
      attr('session.id', { stringValue: sessionId }),
      attr('user.account_uuid', { stringValue: accountUuid }),
    ],
  }
}

function stopFailureFixture(sessionId: string, error = '429 rate_limit_error: exceeded') {
  return { hook_event_name: 'StopFailure', session_id: sessionId, cwd: '/tmp/ws', error }
}

suite('standalone server — P5 window auto-calibration (real boot, real ingest path)', () => {
  let child: ChildProcess | undefined
  let otlpPort = 0
  let uiPort = 0
  let tmpDir = ''
  let home = ''
  let logBuf = ''

  const configPath = (): string => path.join(home, '.agentlens', 'burn-config.json')
  const readConfig = (): Record<string, unknown> => JSON.parse(fs.readFileSync(configPath(), 'utf8')) as Record<string, unknown>
  const observedOf = (account: string): Record<string, unknown> | undefined =>
    ((readConfig().observed ?? {}) as Record<string, Record<string, unknown>>)[account]

  async function ingestAccountConsumption(sessionId: string, accountUuid: string, events: Array<{ ts: number; tokens: number; costUsd: number }>): Promise<void> {
    const logRecords = [
      accountRecord(sessionId, accountUuid, events[0].ts),
      ...events.map(e => apiRequestRecord(sessionId, e.ts, e.tokens, e.costUsd)),
    ]
    const r = await httpReq(otlpPort, 'POST', '/v1/logs', { resourceLogs: [{ scopeLogs: [{ logRecords }] }] })
    assert.strictEqual(r.status, 200, `OTLP ingest must be accepted: ${r.text}`)
  }

  interface AccountWindow {
    accountUuid: string | null
    budget: {
      capacitySource: string
      capacityObservedAt: string | null
      fiveHour: { consumedTokens: number; capacityTokens: number | null; pctConsumed: number | null; minutesToExhaustion: number | null }
    }
  }
  async function burnStatusAccount(accountUuid: string): Promise<AccountWindow | undefined> {
    const r = await httpReq(uiPort, 'GET', '/api/burn-status')
    assert.strictEqual(r.status, 200)
    const j = r.json as { accountWindows?: AccountWindow[] }
    return (j.accountWindows ?? []).find(w => w.accountUuid === accountUuid)
  }

  suiteSetup(async function () {
    this.timeout(45_000)
    const [otlp, ui, mcp] = [await freePort(), await freePort(), await freePort()]
    otlpPort = otlp
    uiPort = ui
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-cal-srv-'))
    home = path.join(tmpDir, 'home')
    const data = path.join(tmpDir, 'data')
    fs.mkdirSync(home, { recursive: true })
    fs.mkdirSync(data, { recursive: true })

    const serverJs = path.resolve(__dirname, '..', '..', '..', 'standalone', 'server.js')
    const env = { ...process.env } as NodeJS.ProcessEnv
    // Full isolation (the resident-server guardrail): private HOME + DATA_DIR, ephemeral ports.
    // ALSO strip every manual-capacity env var — a cap inherited from the developer's shell would
    // make the calibration (correctly) refuse to run and turn every test below into a false fail.
    delete env.AGENTLENS_GATE
    delete env.AGENTLENS_GATE_MODE
    delete env.AGENTLENS_WINDOW_5H_TOKENS
    delete env.AGENTLENS_WINDOW_7D_TOKENS
    delete env.AGENTLENS_WINDOW_5H_COST_USD
    delete env.AGENTLENS_WINDOW_7D_COST_USD
    delete env.AGENTLENS_BURN_CONFIG
    delete env.AGENTLENS_STATUSLINE_LOG
    delete env.CLAUDE_CONFIG_DIR
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
      if (child) {
        assert.ok(child.exitCode !== null || child.signalCode !== null, 'server child must have exited')
      }
    } finally {
      try { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  })

  test('a rate-limit StopFailure through the ingest path writes observed capacity to burn-config.json', async function () {
    this.timeout(20_000)
    const now = Date.now()
    // A clean 2h window for account A: 3 real api_request events, 300k tokens total.
    await ingestAccountConsumption('sess-cal-a', 'acct-cal-a', [
      { ts: now - 2 * HOUR, tokens: 120_000, costUsd: 0.36 },
      { ts: now - 1 * HOUR, tokens: 100_000, costUsd: 0.3 },
      { ts: now - 1 * MIN, tokens: 80_000, costUsd: 0.24 },
    ])
    // Ingest is synchronous, but verify the budget sees the attributed consumption BEFORE the
    // stall — a failure here means the fixture broke, not the calibration.
    const before = await burnStatusAccount('acct-cal-a')
    assert.ok(before, `account window must exist before the stall. accounts: ${logBuf.slice(-500)}`)
    assert.strictEqual(before?.budget.fiveHour.consumedTokens, 300_000)
    assert.strictEqual(before?.budget.capacitySource, 'none', 'unconfigured machine starts at none')

    const r = await httpReq(uiPort, 'POST', '/api/hook-events', stopFailureFixture('sess-cal-a'))
    assert.ok(r.status >= 200 && r.status < 300, `hook ingest must be accepted: ${r.text}`)

    // The calibration ran before the response was written — the file is already there.
    const obs = observedOf('acct-cal-a')
    assert.ok(obs, `observed entry for acct-cal-a must exist. Config: ${fs.existsSync(configPath()) ? fs.readFileSync(configPath(), 'utf8') : '<missing>'}\nLog: ${logBuf.slice(-800)}`)
    assert.strictEqual(obs?.window5hTokens, 300_000)
    assert.strictEqual(obs?.window7dTokens, 300_000)
    assert.strictEqual(typeof obs?.observedAt, 'string')

    // The server reloaded its burn config: projections are ALIVE with zero manual config.
    const after = await burnStatusAccount('acct-cal-a')
    assert.strictEqual(after?.budget.capacitySource, 'observed')
    assert.strictEqual(after?.budget.fiveHour.capacityTokens, 300_000)
    assert.strictEqual(after?.budget.fiveHour.pctConsumed, 100)
    assert.strictEqual(after?.budget.fiveHour.minutesToExhaustion, 0)
    assert.strictEqual(after?.budget.capacityObservedAt, obs?.observedAt)
  })

  test('a second replay with LOWER consumption does not lower the observed capacity', async function () {
    this.timeout(20_000)
    // Simulate a prior HIGHER observation (e.g. from an earlier week) by raising the persisted
    // figure; the account's current window (300k) is far below it.
    const raw = readConfig()
    const observed = raw.observed as Record<string, Record<string, unknown>>
    observed['acct-cal-a'] = { ...observed['acct-cal-a'], window5hTokens: 9_999_999_999 }
    fs.writeFileSync(configPath(), JSON.stringify(raw))

    const r = await httpReq(uiPort, 'POST', '/api/hook-events', stopFailureFixture('sess-cal-a'))
    assert.ok(r.status >= 200 && r.status < 300)
    assert.strictEqual(observedOf('acct-cal-a')?.window5hTokens, 9_999_999_999, 'the higher prior observation must survive')
  })

  test('a natural 5h window rollover does not calibrate', async function () {
    this.timeout(20_000)
    const now = Date.now()
    // Account B was already burning BEFORE (stall − 5h): its window rolled naturally somewhere
    // inside the rolling sum — that measures elapsed time, not the cap.
    await ingestAccountConsumption('sess-cal-b', 'acct-cal-b', [
      { ts: now - 5 * HOUR - 15 * MIN, tokens: 50_000, costUsd: 0.15 },
      { ts: now - 4 * HOUR, tokens: 200_000, costUsd: 0.6 },
      { ts: now - 30 * MIN, tokens: 100_000, costUsd: 0.3 },
    ])
    const r = await httpReq(uiPort, 'POST', '/api/hook-events', stopFailureFixture('sess-cal-b'))
    assert.ok(r.status >= 200 && r.status < 300)
    assert.strictEqual(observedOf('acct-cal-b'), undefined, 'a rolled window must not calibrate')
    assert.ok(logBuf.includes('rolled'), `server log must name the rollover guard. Log tail: ${logBuf.slice(-600)}`)
  })

  test('a non-rate-limit StopFailure does not calibrate', async function () {
    this.timeout(20_000)
    const before = JSON.stringify(readConfig())
    const r = await httpReq(uiPort, 'POST', '/api/hook-events', stopFailureFixture('sess-cal-a', 'connection reset by peer'))
    assert.ok(r.status >= 200 && r.status < 300)
    assert.strictEqual(JSON.stringify(readConfig()), before, 'a non-rate-limit turn death must not touch the config')
  })

  test('user-configured capacity is never overwritten by a later stall', async function () {
    this.timeout(20_000)
    // The user sets a manual cap while the server is running — the calibration must re-read the
    // file and stand down, leaving BOTH the cap and the observed section untouched.
    const raw = readConfig()
    raw.window5hTokens = 424_242
    fs.writeFileSync(configPath(), JSON.stringify(raw))
    const before = JSON.stringify(readConfig())

    const r = await httpReq(uiPort, 'POST', '/api/hook-events', stopFailureFixture('sess-cal-a'))
    assert.ok(r.status >= 200 && r.status < 300)
    assert.strictEqual(JSON.stringify(readConfig()), before, 'a user-configured config must be byte-identical after the stall')
    assert.ok(logBuf.includes('user-configured'), `server log must name the veto. Log tail: ${logBuf.slice(-600)}`)
  })
})
