import * as assert from 'assert'
import * as http from 'http'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import { spawn, type ChildProcess } from 'child_process'
import type { AddressInfo } from 'net'

// ── S3-F3a — the SHIPPED standalone log-ingest groups Codex per PROMPT ──────────────────────────
// Boots the REAL built server (standalone/server.js) — the same npx/Docker path that runs on user
// machines — POSTs a two-prompt Codex conversation to its OTLP /v1/logs endpoint, and asserts the
// spans land in the STORE keyed `codex:<conv>:prompt-1` / `codex:<conv>:prompt-2`, NOT collapsed
// into one `<conversation-id>` group. Before S3-F3a the shipped processLogs keyed the traceId on
// the conversation id alone (importing OtlpCollector would prove nothing — the collector already
// grouped per prompt; the BUG was that the standalone server did not). The store-level view comes
// from /api/debug/codex-store-groups because the summarizer re-splits by prompt downstream and would
// mask the store grouping at /api/summary. Full isolation (private HOME + DATA_DIR, non-4318 OTLP
// port) so it never touches the real ~/.claude or the canonical instance; teardown kills the child.

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

// One codex.* log record with the given event name + attributes, timestamped "now" so the rolling
// summary window never prunes it before the assertion.
function codexRecord(eventName: string, convId: string): Record<string, unknown> {
  return {
    timeUnixNano: String(BigInt(Date.now()) * 1_000_000n),
    attributes: [
      { key: 'event.name', value: { stringValue: eventName } },
      { key: 'conversation.id', value: { stringValue: convId } },
    ],
  }
}

suite('standalone server — Codex log-ingest groups per prompt (real boot)', () => {
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-codex-'))
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

  test('two prompts of one conversation land in TWO prompt-N store groups, not one conversation-id group', async () => {
    const conv = 'conv-s3f3a'
    // One conversation, two user prompts, each followed by a response event — all carrying the SAME
    // conversation.id and NO per-record traceId, so a conversation-id-only keying would collapse
    // them into ONE group. The shipped path must instead open a fresh prompt cycle per user_prompt.
    const payload = {
      resourceLogs: [{
        scopeLogs: [{
          logRecords: [
            codexRecord('codex.user_prompt', conv),
            codexRecord('codex.token_count', conv),
            codexRecord('codex.user_prompt', conv),
            codexRecord('codex.token_count', conv),
          ],
        }],
      }],
    }

    const ingest = await httpReq(otlpPort, 'POST', '/v1/logs', payload)
    assert.strictEqual(ingest.status, 200, 'OTLP /v1/logs must accept the batch (200)')

    const groups = await httpReq(uiPort, 'GET', '/api/debug/codex-store-groups')
    assert.strictEqual(groups.status, 200)
    const codexTraceIds = (groups.json as { codexTraceIds?: string[] }).codexTraceIds ?? []

    assert.deepStrictEqual(
      codexTraceIds,
      [`codex:${conv}:prompt-1`, `codex:${conv}:prompt-2`],
      `expected two per-prompt store groups, got ${JSON.stringify(codexTraceIds)} ` +
      `(a single "${conv}" group means the shipped path still keys Codex by conversation id alone)`,
    )
  })
})
