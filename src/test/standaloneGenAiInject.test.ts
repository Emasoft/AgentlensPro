import * as assert from 'assert'
import * as http from 'http'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import type { ChildProcess } from 'child_process'
import { freePort, spawnServerWithRetry } from './helpers/freePort'

// ── S3-F3b — the SHIPPED standalone injects gen_ai response content into its LLM span ────────────
// gen_ai_latest_experimental (Codex/OpenAI) emits the assistant's RESPONSE TEXT as a SEPARATE log
// event (gen_ai.choice), correlated to the LLM span by traceId:spanId and arriving on a different
// HTTP request — before OR after the span. The shipped processLogs used to DROP that event (the
// rich-event gate), so the dashboard showed no assistant text for gen_ai agents. This boots the
// REAL built server (standalone/server.js — the npx/Docker path), POSTs an LLM span + its
// gen_ai.choice log in BOTH orderings, and asserts the span carries gen_ai.output.messages when
// read back through a fresh spanStore.loadRange (the read-time overlay), via /api/debug/span-attr.
// Full isolation (private HOME + DATA_DIR, non-4318 OTLP port); teardown kills the child.

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

const NOW_NANO = (): string => String(BigInt(Date.now()) * 1_000_000n)

// One OTLP LLM span (as /v1/traces delivers it): traceId:spanId is the correlation key gen_ai logs
// reference. The name is a gen_ai operation name; the standalone stores it verbatim.
function llmSpan(traceId: string, spanId: string): Record<string, unknown> {
  return {
    resourceSpans: [{
      scopeSpans: [{
        spans: [{
          traceId, spanId, name: 'chat gpt-x',
          startTimeUnixNano: NOW_NANO(), endTimeUnixNano: NOW_NANO(),
          attributes: [{ key: 'gen_ai.system', value: { stringValue: 'openai' } }],
        }],
      }],
    }],
  }
}

// One gen_ai.choice log record (as /v1/logs delivers it): traceId/spanId are TOP-LEVEL fields, and
// the response text rides gen_ai.event.content in the gen_ai.choice wrapper shape.
function genAiChoiceLog(traceId: string, spanId: string, text: string): Record<string, unknown> {
  return {
    resourceLogs: [{
      scopeLogs: [{
        logRecords: [{
          traceId, spanId,
          timeUnixNano: NOW_NANO(),
          attributes: [
            { key: 'event.name', value: { stringValue: 'gen_ai.choice' } },
            { key: 'gen_ai.event.content', value: { stringValue: JSON.stringify({ message: { role: 'assistant', content: text } }) } },
          ],
        }],
      }],
    }],
  }
}

// The gen_ai.output.messages shape formatGenAiEventContent produces for the wrapper above.
function expectedMessages(text: string): string {
  return JSON.stringify([{ role: 'assistant', content: [{ type: 'text', text }] }])
}

suite('standalone server — gen_ai response content injected into the LLM span (real boot)', () => {
  let child: ChildProcess | undefined
  let uiPort = 0
  let otlpPort = 0
  const tmpDirs: string[] = [] // one per boot ATTEMPT — a retried attempt still left a dir behind

  suiteSetup(async function () {
    this.timeout(45_000)

    const serverJs = path.resolve(__dirname, '..', '..', '..', 'standalone', 'server.js')
    const spawned = await spawnServerWithRetry({
      serverJs,
      readyPort: (env) => Number(env.UI_PORT),
      buildEnv: async () => {
        const [otlp, ui, mcp] = [await freePort(), await freePort(), await freePort()]
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-genai-'))
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
        otlpPort = otlp
        uiPort = ui
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

  async function assertInjected(traceId: string, spanId: string, text: string): Promise<void> {
    const got = await httpReq(uiPort, 'GET', `/api/debug/span-attr?traceId=${traceId}&spanId=${spanId}&key=gen_ai.output.messages`)
    assert.strictEqual(got.status, 200)
    const body = got.json as { found?: boolean; value?: string | null }
    assert.strictEqual(body.found, true, `span ${traceId}:${spanId} must be stored`)
    assert.strictEqual(
      body.value, expectedMessages(text),
      `the gen_ai.choice response text must be merged into the span as gen_ai.output.messages ` +
      `(the shipped path used to DROP the gen_ai.choice event, leaving no assistant text)`,
    )
  }

  test('gen_ai.choice arriving AFTER its span injects the response text into the span', async () => {
    const traceId = 'trace-after'
    const spanId = 'span-after'
    assert.strictEqual((await httpReq(otlpPort, 'POST', '/v1/traces', llmSpan(traceId, spanId))).status, 200)
    assert.strictEqual((await httpReq(otlpPort, 'POST', '/v1/logs', genAiChoiceLog(traceId, spanId, 'Hi from after'))).status, 200)
    await assertInjected(traceId, spanId, 'Hi from after')
  })

  test('gen_ai.choice arriving BEFORE its span injects the response text once the span is stored (order-independent overlay)', async () => {
    const traceId = 'trace-before'
    const spanId = 'span-before'
    assert.strictEqual((await httpReq(otlpPort, 'POST', '/v1/logs', genAiChoiceLog(traceId, spanId, 'Hi from before'))).status, 200)
    assert.strictEqual((await httpReq(otlpPort, 'POST', '/v1/traces', llmSpan(traceId, spanId))).status, 200)
    await assertInjected(traceId, spanId, 'Hi from before')
  })
})
