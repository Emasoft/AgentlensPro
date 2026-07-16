// TRDD-5GFSFX0Q — the per-cause attribution feed survives the Phase B log-wins merge (real boot).
//
// The regression: for a Claude session covered by BOTH a transcript and OTEL rich events, the
// merge dropped the OTEL card wholesale — and with it the `api_request` timeline entries that are
// the ONLY carrier of per-call attribution (exact cost_usd + skill/agent/plugin causes). Every
// drill consumer (get_cost_by_cause, /api/timeline, the webview per-cause toggle) then saw a
// transcript-only timeline and reported ZERO api_request calls machine-wide.
//
// This boots the REAL built server (standalone/server.js), gives it a transcript fixture AND an
// OTLP rich api_request log record for the SAME session, and asserts the served timeline carries
// BOTH: a transcript-only entry type (user_input — an OTEL card never has it) and the attributed
// api_request entry (a log card never had it before the graft). Full isolation (private HOME +
// DATA_DIR, ephemeral ports); teardown kills the child.
import * as assert from 'assert'
import * as http from 'http'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import { spawn, type ChildProcess } from 'child_process'
import type { AddressInfo } from 'net'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface HttpResult { status: number; json: unknown }
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
          let json: unknown = null
          const text = Buffer.concat(chunks).toString('utf-8')
          if (text) { try { json = JSON.parse(text) } catch { json = null } }
          resolve({ status: res.statusCode ?? 0, json })
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

const SID = 'aaaaaaaa-1111-2222-3333-444444444444'
const NOW_NANO = (): string => String(BigInt(Date.now()) * 1_000_000n)

// A minimal Claude transcript: one user prompt + one assistant turn (message.id required or the
// usage record is deduped away). This makes the LOG card exist and win the Phase B collision.
function transcriptBody(cwd: string): string {
  return JSON.stringify({ type: 'user', timestamp: '2026-07-16T10:00:00.000Z', cwd, sessionId: SID, message: { content: 'graft me' } }) + '\n' +
    JSON.stringify({
      type: 'assistant', timestamp: '2026-07-16T10:00:01.000Z', cwd, sessionId: SID,
      message: {
        id: 'msg-graft-1', model: 'claude-sonnet-4-5',
        usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [{ type: 'text', text: 'ok' }],
      },
    }) + '\n'
}

// One rich api_request LOG record as CC 2.1.206 delivers it (BARE event name, session.id attr,
// attribution attrs). processLogs stores it as a claude_code.api_request span keyed by session.id;
// the summarizer turns it into the OTEL card's api_request timeline entry.
function apiRequestLog(): Record<string, unknown> {
  return {
    resourceLogs: [{
      scopeLogs: [{
        logRecords: [{
          timeUnixNano: NOW_NANO(),
          attributes: [
            { key: 'event.name', value: { stringValue: 'api_request' } },
            { key: 'session.id', value: { stringValue: SID } },
            { key: 'model', value: { stringValue: 'claude-sonnet-4-5' } },
            { key: 'cost_usd', value: { stringValue: '0.1234' } },
            { key: 'input_tokens', value: { stringValue: '500' } },
            { key: 'output_tokens', value: { stringValue: '50' } },
            { key: 'query_source', value: { stringValue: 'repl_main_thread' } },
            { key: 'skill.name', value: { stringValue: 'commit-skill' } },
          ],
        }],
      }],
    }],
  }
}

interface Entry { type: string; skillName?: string; costUsd?: number }

suite('standalone server — OTEL api_request attribution grafts onto the served log card (real boot)', () => {
  let child: ChildProcess | undefined
  let uiPort = 0
  let otlpPort = 0
  let tmpDir = ''
  let logBuf = ''

  suiteSetup(async function () {
    this.timeout(45_000)
    const [otlp, ui, mcp] = [await freePort(), await freePort(), await freePort()]
    uiPort = ui
    otlpPort = otlp
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-graft-'))
    const home = path.join(tmpDir, 'home')
    const data = path.join(tmpDir, 'data')
    const projects = path.join(home, '.claude', 'projects', 'proj')
    fs.mkdirSync(projects, { recursive: true })
    fs.mkdirSync(data, { recursive: true })
    // Fixture BEFORE spawn — the boot scan ingests it deterministically (no watch-latency race).
    fs.writeFileSync(path.join(projects, `${SID}.jsonl`), transcriptBody(path.join(home, 'ws')))

    const serverJs = path.resolve(__dirname, '..', '..', '..', 'standalone', 'server.js')
    const env = { ...process.env } as NodeJS.ProcessEnv
    delete env.AGENTLENS_GATE
    delete env.AGENTLENS_GATE_MODE
    delete env.CLAUDE_CONFIG_DIR // the fixture lives under the private HOME, never the dev machine's
    delete env.CODEX_HOME
    delete env.OPENCODE_DATA_DIR
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

  test('the served timeline carries BOTH transcript entries and the grafted attributed api_request', async function () {
    this.timeout(30_000)
    const posted = await httpReq(otlpPort, 'POST', '/v1/logs', apiRequestLog())
    assert.ok(posted.status >= 200 && posted.status < 300, `OTLP logs POST must succeed (got ${posted.status})`)

    // Poll the drill route until the ingested rich event surfaces in the merged card's timeline
    // (dataVersion bump → summary rebuild → side-map refresh happen on the server's own cadence).
    const deadline = Date.now() + 20_000
    let timeline: Entry[] = []
    for (;;) {
      const r = await httpReq(uiPort, 'GET', `/api/timeline/${SID}`)
      timeline = ((r.json as { timeline?: Entry[] })?.timeline ?? [])
      if (timeline.some(e => e.type === 'api_request')) break
      if (Date.now() > deadline) break
      await sleep(500)
    }

    const types = new Set(timeline.map(e => e.type))
    assert.ok(types.has('api_request'),
      `the OTEL api_request attribution entry must be grafted onto the served card ` +
      `(got types: ${JSON.stringify([...types])}) — its absence is the exact machine-wide ` +
      `get_cost_by_cause=0 regression\n${logBuf.slice(-1500)}`)
    assert.ok(types.has('user_input') || types.has('llm'),
      `transcript-derived entries must STILL be present (got types: ${JSON.stringify([...types])}) — ` +
      'the graft must compose, not replace: the log card stays the totals/timeline winner')

    const api = timeline.find(e => e.type === 'api_request')
    assert.strictEqual(api?.skillName, 'commit-skill', 'the skill attribution must survive the graft')
    assert.strictEqual(api?.costUsd, 0.1234, 'the exact per-call cost must survive the graft')
  })
})
