import * as assert from 'assert'
import * as http from 'http'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import { type ChildProcess } from 'child_process'
import { freePort, spawnServerWithRetry } from './helpers/freePort'

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
  let home = ''
  let getLog: () => string = () => ''
  const tmpDirs: string[] = []   // one per boot ATTEMPT — a retried attempt still left a dir behind

  const configPath = (): string => path.join(home, '.agentlens', 'burn-config.json')
  const readConfig = (): Record<string, unknown> => JSON.parse(fs.readFileSync(configPath(), 'utf8')) as Record<string, unknown>
  // Raw bytes of burn-config.json, or null when alcore has not created it: the file is created only
  // on the calibrated path, so "unchanged" must keep null as null (TRDD-A77UKLVI).
  const configSnapshot = (): string | null => fs.existsSync(configPath()) ? fs.readFileSync(configPath(), 'utf8') : null
  // undefined when the file does not exist yet — a stand-alone negative test may run before any calibration.
  const observedOf = (account: string): Record<string, unknown> | undefined =>
    fs.existsSync(configPath())
      ? ((readConfig().observed ?? {}) as Record<string, Record<string, unknown>>)[account]
      : undefined
  // getLog() is append-only (freePort.ts: log += chunk), so an offset mark is sound: logSince(mark)
  // holds only what the server printed after the mark.
  const logMark = (): number => getLog().length
  const logSince = (mark: number): string => getLog().slice(mark)
  // Bounded poll: stdout and the HTTP socket are separate pipes, so the line may land just after the
  // response; still fails after 2 s (TRDD-A77UKLVI).
  const logLineSince = async (mark: number, needle: string, ms = 2_000): Promise<boolean> => {
    const deadline = Date.now() + ms
    for (;;) {
      if (logSince(mark).includes(needle)) return true
      if (Date.now() >= deadline) return false
      await sleep(100)
    }
  }

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
    // Poll briefly instead of one shot: since TRDD-2R36W8Q1 a reader that lands while the
    // background summary rebuilder holds the gate is served the last CACHED summary (stale by
    // design — read-your-writes is bounded, not guaranteed). Right after the OTLP POST that
    // stale value is the empty boot summary, so the account window can legitimately lag one
    // rebuild behind; a bounded poll asserts the behaviour, not the timing.
    const deadline = Date.now() + 5_000
    for (;;) {
      const r = await httpReq(uiPort, 'GET', '/api/burn-status')
      assert.strictEqual(r.status, 200)
      const j = r.json as { accountWindows?: AccountWindow[] }
      const win = (j.accountWindows ?? []).find(w => w.accountUuid === accountUuid)
      if (win || Date.now() >= deadline) return win
      await sleep(100)
    }
  }

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
        otlpPort = otlp
        uiPort = ui
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-cal-srv-'))
        tmpDirs.push(dir)
        home = path.join(dir, 'home')
        const data = path.join(dir, 'data')
        fs.mkdirSync(home, { recursive: true })
        fs.mkdirSync(data, { recursive: true })

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
        return env
      },
    })
    child = spawned.child
    getLog = spawned.getLog
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
    assert.ok(before, `account window must exist before the stall. accounts: ${getLog().slice(-500)}`)
    assert.strictEqual(before?.budget.fiveHour.consumedTokens, 300_000)
    assert.strictEqual(before?.budget.capacitySource, 'none', 'unconfigured machine starts at none')

    const r = await httpReq(uiPort, 'POST', '/api/hook-events', stopFailureFixture('sess-cal-a'))
    assert.ok(r.status >= 200 && r.status < 300, `hook ingest must be accepted: ${r.text}`)

    // The calibration ran before the response was written — the file is already there.
    const obs = observedOf('acct-cal-a')
    assert.ok(obs, `observed entry for acct-cal-a must exist. Config: ${fs.existsSync(configPath()) ? fs.readFileSync(configPath(), 'utf8') : '<missing>'}\nLog: ${getLog().slice(-800)}`)
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
    // Stand-alone (TRDD-A77UKLVI): own account + a real observation written by alcore itself, so
    // this test no longer depends on test 1 having run first.
    const now = Date.now()
    await ingestAccountConsumption('sess-cal-f', 'acct-cal-f', [
      { ts: now - 2 * HOUR, tokens: 120_000, costUsd: 0.36 },
      { ts: now - 1 * HOUR, tokens: 100_000, costUsd: 0.3 },
      { ts: now - 1 * MIN, tokens: 80_000, costUsd: 0.24 },
    ])
    // Wait for alcore to see the consumption before stalling: the calibration consumption lookup can read the same lagging summary /api/burn-status serves, so a stall posted straight after ingest could take the empty-consumption skip (TRDD-A77UKLVI).
    const win = await burnStatusAccount('acct-cal-f')
    assert.ok(win, 'precondition: acct-cal-f window visible before the stall')
    assert.strictEqual(win?.budget.fiveHour.consumedTokens, 300_000)
    const first = await httpReq(uiPort, 'POST', '/api/hook-events', stopFailureFixture('sess-cal-f'))
    assert.ok(first.status >= 200 && first.status < 300, `hook ingest must be accepted: ${first.text}`)
    const seeded = observedOf('acct-cal-f')
    assert.ok(seeded, 'precondition: alcore must have written a real observation for acct-cal-f')
    assert.strictEqual(seeded?.window5hTokens, 300_000)

    // Simulate a prior HIGHER observation (e.g. from an earlier week) by raising ONLY
    // window5hTokens of the real entry; every other field stays as alcore wrote it. The account's
    // current window (300k) is far below it.
    const raw = readConfig()
    const observed = raw.observed as Record<string, Record<string, unknown>>
    observed['acct-cal-f'] = { ...observed['acct-cal-f'], window5hTokens: 9_999_999_999 }
    fs.writeFileSync(configPath(), JSON.stringify(raw))
    const observedAtBefore = observedOf('acct-cal-f')?.observedAt

    const r = await httpReq(uiPort, 'POST', '/api/hook-events', stopFailureFixture('sess-cal-f'))
    assert.ok(r.status >= 200 && r.status < 300)
    const after = observedOf('acct-cal-f')
    assert.strictEqual(after?.window5hTokens, 9_999_999_999, 'the higher prior observation must survive')
    // observedAt unchanged proves the skip path ran and nothing was rewritten.
    assert.strictEqual(after?.observedAt, observedAtBefore, 'the skip path must not rewrite the entry')
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
    // Wait for alcore to see the consumption before stalling: the calibration consumption lookup can read the same lagging summary /api/burn-status serves, so a stall posted straight after ingest could take the empty-consumption skip (TRDD-A77UKLVI).
    assert.ok(await burnStatusAccount('acct-cal-b'), 'precondition: acct-cal-b window visible before the stall')
    // Mark the log BEFORE the stall: only lines this stall produced may satisfy the "rolled"
    // assertion, so an earlier test's output can never make it pass (TRDD-A77UKLVI).
    const mark = logMark()
    const r = await httpReq(uiPort, 'POST', '/api/hook-events', stopFailureFixture('sess-cal-b'))
    assert.ok(r.status >= 200 && r.status < 300)
    assert.strictEqual(observedOf('acct-cal-b'), undefined, 'a rolled window must not calibrate')
    assert.ok(await logLineSince(mark, 'rolled'), `server log must name the rollover guard. Log tail: ${getLog().slice(-600)}`)
  })

  test('a non-rate-limit StopFailure does not calibrate', async function () {
    this.timeout(20_000)
    // Stand-alone (TRDD-A77UKLVI): own account with a clean window that WOULD calibrate if the
    // error were rate-limit class, so the negative result is attributable to the error text alone.
    const now = Date.now()
    await ingestAccountConsumption('sess-cal-d', 'acct-cal-d', [
      { ts: now - 2 * HOUR, tokens: 120_000, costUsd: 0.36 },
      { ts: now - 1 * HOUR, tokens: 100_000, costUsd: 0.3 },
      { ts: now - 1 * MIN, tokens: 80_000, costUsd: 0.24 },
    ])
    // Wait for alcore to see the consumption before stalling: the calibration consumption lookup can read the same lagging summary /api/burn-status serves, so a stall posted straight after ingest could take the empty-consumption skip (TRDD-A77UKLVI).
    const win = await burnStatusAccount('acct-cal-d')
    assert.ok(win, 'precondition: acct-cal-d window visible before the stall')
    assert.strictEqual(win?.budget.fiveHour.consumedTokens, 300_000)
    const before = configSnapshot()
    const r = await httpReq(uiPort, 'POST', '/api/hook-events', stopFailureFixture('sess-cal-d', 'connection reset by peer'))
    assert.ok(r.status >= 200 && r.status < 300)
    assert.strictEqual(observedOf('acct-cal-d'), undefined, 'a non-rate-limit turn death must not calibrate')
    assert.strictEqual(configSnapshot(), before, 'a non-rate-limit turn death must not touch the config (null stays null)')
  })

  test('user-configured capacity is never overwritten by a later stall', async function () {
    this.timeout(20_000)
    // Stand-alone (TRDD-A77UKLVI): own account with a clean window that WOULD calibrate absent the veto.
    const now = Date.now()
    await ingestAccountConsumption('sess-cal-e', 'acct-cal-e', [
      { ts: now - 2 * HOUR, tokens: 120_000, costUsd: 0.36 },
      { ts: now - 1 * HOUR, tokens: 100_000, costUsd: 0.3 },
      { ts: now - 1 * MIN, tokens: 80_000, costUsd: 0.24 },
    ])
    // Wait for alcore to see the consumption before stalling: the calibration consumption lookup can read the same lagging summary /api/burn-status serves, so a stall posted straight after ingest could take the empty-consumption skip (TRDD-A77UKLVI).
    const win = await burnStatusAccount('acct-cal-e')
    assert.ok(win, 'precondition: acct-cal-e window visible before the stall')
    assert.strictEqual(win?.budget.fiveHour.consumedTokens, 300_000)
    const prior = configSnapshot()
    try {
      // The user sets a manual cap while the server is running — the calibration must re-read the
      // file and stand down, leaving the file byte-identical.
      const raw = (prior ? JSON.parse(prior) : {}) as Record<string, unknown>
      raw.window5hTokens = 424_242
      fs.mkdirSync(path.dirname(configPath()), { recursive: true })
      fs.writeFileSync(configPath(), JSON.stringify(raw))
      const before = configSnapshot()
      const mark = logMark()

      const r = await httpReq(uiPort, 'POST', '/api/hook-events', stopFailureFixture('sess-cal-e'))
      assert.ok(r.status >= 200 && r.status < 300)
      assert.strictEqual(configSnapshot(), before, 'a user-configured config must be byte-identical after the stall')
      assert.ok(await logLineSince(mark, 'user-configured'), `server log must name the veto. Log tail: ${getLog().slice(-600)}`)
    } finally {
      // The server re-reads the file on each stall, so the cap must not outlive this test and
      // veto a later one: restore the prior bytes, or remove the file if there was none.
      if (prior === null) fs.rmSync(configPath(), { force: true })
      else fs.writeFileSync(configPath(), prior)
    }
  })
})
