import * as assert from 'assert'
import * as http from 'http'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import { spawn, type ChildProcess } from 'child_process'
import type { AddressInfo } from 'net'

// ── D3K7QM2P/1c — admission control wired into the real server (real boot) ────────────────────────
// Proves the WIRING deterministically: booted with a 1 MiB hard RSS ceiling, EVERY non-exempt request
// sheds (503 + Retry-After, reason 'rss'), while the EXEMPT /api/server-stats keeps answering and
// reports the live admission counters. This is timing-free (unlike a concurrency race): a hard wall
// sheds regardless of overlap. The ADMIT path is covered by every other real-boot POST test (Codex,
// gen_ai, hook-spool all get 200 through the same gate). The shed/queue/promote LOGIC is covered
// deterministically by admissionControl.test.ts. A concurrent burst here also proves the server does
// not crash while shedding.

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface HttpResult { status: number; json: unknown; headers: http.IncomingHttpHeaders }
function httpReq(port: number, method: string, urlPath: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => { const t = Buffer.concat(chunks).toString('utf-8'); let j: unknown = null; if (t) { try { j = JSON.parse(t) } catch { j = null } } resolve({ status: res.statusCode ?? 0, json: j, headers: res.headers }) })
    })
    req.on('error', reject)
    req.end()
  })
}
function freePort(): Promise<number> {
  return new Promise((resolve) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => resolve(p)) }) })
}

suite('admission control — wired into the real server, sheds at a hard wall (real boot)', () => {
  let child: ChildProcess | undefined
  let uiPort = 0
  let tmpDir = ''
  let logBuf = ''

  suiteSetup(async function () {
    this.timeout(45_000)
    const [otlp, ui, mcp] = [await freePort(), await freePort(), await freePort()]
    uiPort = ui
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-admit-'))
    const home = path.join(tmpDir, 'home'); const data = path.join(tmpDir, 'data')
    fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(data, { recursive: true })
    const serverJs = path.resolve(__dirname, '..', '..', '..', 'standalone', 'server.js')
    const env = { ...process.env } as NodeJS.ProcessEnv
    delete env.AGENTLENS_GATE; delete env.AGENTLENS_GATE_MODE; delete env.AGENTLENS_NO_REVIVE; delete env.DATA_DIR
    Object.assign(env, {
      HOME: home, DATA_DIR: data, OTLP_PORT: String(otlp), UI_PORT: String(ui), MCP_PORT: String(mcp),
      BIND_HOST: '127.0.0.1', AGENTLENS_NO_TELEMETRY_CONFIG: '1', AGENTLENS_OPEN_BROWSER: '0',
      // A 1 MiB RSS ceiling is always exceeded → every NON-EXEMPT request sheds deterministically.
      AGENTLENS_MAX_RSS_MB: '1',
    })
    child = spawn(process.execPath, [serverJs], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout?.on('data', (d: Buffer) => { logBuf += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { logBuf += d.toString() })
    const deadline = Date.now() + 30_000
    for (;;) {
      if (child.exitCode !== null) throw new Error(`server exited early (code=${child.exitCode})\n${logBuf.slice(-2000)}`)
      // Readiness is probed via the EXEMPT /api/server-stats — which must answer even though every
      // other endpoint sheds. If it didn't, the exemption would be broken and boot would time out.
      try { const r = await httpReq(ui, 'GET', '/api/server-stats'); if (r.status === 200) break } catch { /* not up yet */ }
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
        const ok = await Promise.race([closed.then(() => true), sleep(5_000).then(() => false)])
        if (!ok) { child.kill('SIGKILL'); await closed }
      }
    } finally { try { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best effort */ } }
  })

  test('a non-exempt request is shed with 503 + Retry-After (reason rss) at the hard wall', async () => {
    const r = await httpReq(uiPort, 'GET', '/api/summary')
    assert.strictEqual(r.status, 503, 'the hard RSS wall sheds the request')
    assert.ok(r.headers['retry-after'], 'a Retry-After header tells the client when to retry')
    assert.strictEqual((r.json as { reason?: string }).reason, 'rss', 'the shed reason is reported')
  })

  test('the exempt /api/server-stats keeps answering and reports admission + resource counters', async () => {
    const r = await httpReq(uiPort, 'GET', '/api/server-stats')
    assert.strictEqual(r.status, 200, 'server-stats is exempt from shedding')
    const j = r.json as { admission?: { shedTotal?: number }; resources?: { rssMb?: number; cpuCount?: number } }
    assert.ok(j.admission && (j.admission.shedTotal ?? 0) > 0, `sheds are counted (shedTotal=${j.admission?.shedTotal})`)
    assert.ok(j.resources && (j.resources.rssMb ?? 0) > 1 && (j.resources.cpuCount ?? 0) >= 1, 'the live resource sample is present')
  })

  test('a concurrent burst is shed cleanly without crashing the server', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => httpReq(uiPort, 'GET', '/api/summary')))
    assert.ok(results.every((r) => r.status === 503), 'every non-exempt request in the burst sheds (no crash, no 5xx-other)')
    const after = await httpReq(uiPort, 'GET', '/api/server-stats')
    assert.strictEqual(after.status, 200, 'the server is still up and serving the exempt endpoint after the burst')
  })
})
