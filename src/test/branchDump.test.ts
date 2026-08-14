import * as assert from 'assert'
import * as http from 'http'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import type { ChildProcess } from 'child_process'
import { freePort, spawnServerWithRetry } from './helpers/freePort'

// ── Phase 3b (TRDD-4CH9QLAH) — POST /api/branch-dump writes big-output dumps under the Claude ──────
// projects tree, ONLY. Boots the REAL built server (standalone/server.js — the npx/Docker path),
// points CLAUDE_CONFIG_DIR at a private config dir with one real project slug, and asserts:
//   (1) a dump is written under <cfg>/projects/<slug>/agentlens-branch-dumps/ with the exact content,
//   (2) an invalid slug (contains '/'/'..') is refused 400,
//   (3) an unknown slug (no matching project dir) is refused 400 — never an arbitrary mkdir,
//   (4) a traversal-shaped filename cannot escape the dump root (file stays directly inside it).
// Full isolation (private HOME + DATA_DIR + CLAUDE_CONFIG_DIR, non-4318 OTLP port); teardown kills
// the child + rms the tmp tree, so it never touches the real ~/.claude.

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

const SLUG = '-Users-test-my-proj'

suite('standalone server — POST /api/branch-dump writes under the Claude projects tree only (real boot)', () => {
  let child: ChildProcess | undefined
  let uiPort = 0
  let tmpDir = ''
  let projectsDir = ''
  const tmpDirs: string[] = []   // one per boot ATTEMPT — a retried attempt still left a dir behind

  suiteSetup(async function () {
    // Ports + retry come from the SHARED helper, not a local probe: it carries the in-process
    // claimed-set and re-picks fresh ports on the "already in use" early-exit. (TRDD-1QFP73WA.)
    this.timeout(120_000)
    const serverJs = path.resolve(__dirname, '..', '..', '..', 'standalone', 'server.js')
    const spawned = await spawnServerWithRetry({
      serverJs,
      readyPort: (env) => Number(env.UI_PORT),
      buildEnv: async () => {
        const [otlp, ui, mcp] = [await freePort(), await freePort(), await freePort()]
        uiPort = ui
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-bdump-'))
        tmpDirs.push(tmpDir)
        const home = path.join(tmpDir, 'home')
        const data = path.join(tmpDir, 'data')
        const cfg = path.join(tmpDir, 'cfg')
        projectsDir = path.join(cfg, 'projects')
        fs.mkdirSync(home, { recursive: true })
        fs.mkdirSync(data, { recursive: true })
        // The one real project dir the endpoint will accept as a slug.
        fs.mkdirSync(path.join(projectsDir, SLUG), { recursive: true })

        const env = { ...process.env } as NodeJS.ProcessEnv
        delete env.AGENTLENS_GATE
        delete env.AGENTLENS_GATE_MODE
        Object.assign(env, {
          HOME: home,
          DATA_DIR: data,
          CLAUDE_CONFIG_DIR: cfg,
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
    } finally {
      for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ } }
    }
  })

  test('writes a dump under <projects>/<slug>/agentlens-branch-dumps/ with the exact content', async () => {
    const content = 'BIG-OUTPUT-' + 'x'.repeat(20000)
    const r = await httpReq(uiPort, 'POST', '/api/branch-dump', {
      slug: SLUG, sessionId: 'sess-abc', dumps: [{ id: 'd1', name: 'result', content }],
    })
    assert.strictEqual(r.status, 200, `expected 200, got ${r.status}: ${r.text}`)
    const j = r.json as { dir: string; paths: Record<string, string> }
    const dumpDir = path.join(projectsDir, SLUG, 'agentlens-branch-dumps')
    assert.strictEqual(j.dir, dumpDir, 'dump dir is under the project slug')
    const written = j.paths.d1
    assert.ok(written && written.startsWith(dumpDir + path.sep), `path ${written} must be inside the dump dir`)
    assert.strictEqual(fs.readFileSync(written, 'utf-8'), content, 'file content round-trips exactly')
    assert.ok(/sess-abc-.*-result-d1\.txt$/.test(path.basename(written)), 'filename carries session + name + id')
  })

  test('a slug containing a separator or .. is refused (400) — no traversal', async () => {
    for (const slug of ['../evil', 'a/b', '..']) {
      const r = await httpReq(uiPort, 'POST', '/api/branch-dump', { slug, sessionId: 's', dumps: [{ id: 'd1', name: 'x', content: 'y' }] })
      assert.strictEqual(r.status, 400, `slug "${slug}" must be refused`)
    }
  })

  test('an unknown slug (no matching project dir) is refused (400) — never an arbitrary mkdir', async () => {
    const r = await httpReq(uiPort, 'POST', '/api/branch-dump', { slug: 'ghost-project', sessionId: 's', dumps: [{ id: 'd1', name: 'x', content: 'y' }] })
    assert.strictEqual(r.status, 400)
    assert.ok(!fs.existsSync(path.join(projectsDir, 'ghost-project')), 'no dir created for an unknown slug')
  })

  test('a traversal-shaped filename cannot escape the dump root', async () => {
    const r = await httpReq(uiPort, 'POST', '/api/branch-dump', {
      slug: SLUG, sessionId: '../../../../etc', dumps: [{ id: 'd1', name: '../../pwn', content: 'z' }],
    })
    assert.strictEqual(r.status, 200)
    const j = r.json as { dir: string; paths: Record<string, string> }
    const dumpDir = path.join(projectsDir, SLUG, 'agentlens-branch-dumps')
    // The sanitized name has no separators, so the file sits DIRECTLY in the dump dir.
    assert.strictEqual(path.dirname(j.paths.d1), dumpDir, 'file stays directly in the dump dir')
    assert.ok(!fs.existsSync(path.join(tmpDir, 'cfg', 'pwn')), 'nothing written outside the dump dir')
  })
})
