import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { freePort } from './helpers/freePort'
import { ensureServer, findServerPid, stopServer } from '../cli/serverControl'

// End to end: the CLI's own start path (ensureServer -> alcoreServeArgs) starting a REAL alcore,
// with and without the AGENTLENS_INGEST opt-in. Real process, real ports, temp data dir and HOME —
// never the live ~/.agentlens. ensureServer reads process.env, so each case sets its own env and
// restores it afterwards. Needs the DEBUG binaries; without them the suite is pending (see suiteSetup).

const REPO = [path.resolve(__dirname, '..', '..', '..'), path.resolve(__dirname, '..', '..', '..', '..')]
  .find(r => fs.existsSync(path.join(r, 'rust-core', 'Cargo.toml'))) as string
const DEBUG = path.join(REPO, 'rust-core', 'target', 'debug')
const ALCORE = path.join(DEBUG, 'alcore')
const ALDIGEST = path.join(DEBUG, 'aldigest')
const MANIFEST = path.join(REPO, 'rust-core', 'crates', 'agentlens-digest', 'schemas', 'manifest.json')

const KEYS = ['HOME', 'DATA_DIR', 'AGENTLENS_DATA_DIR', 'MCP_PORT', 'UI_PORT', 'OTLP_PORT', 'AGENTLENS_UI_URL', 'AGENTLENS_MCP_URL',
  'AGENTLENS_ALCORE', 'AGENTLENS_INGEST', 'AGENTLENS_INGEST_SOURCES', 'AGENTLENS_ALDIGEST_BIN', 'AGENTLENS_INGEST_MANIFEST'] as const
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }

async function getJson(port: string, p: string): Promise<Record<string, unknown>> {
  const r = await fetch(`http://127.0.0.1:${port}${p}`)
  assert.strictEqual(r.status, 200, `GET ${p} -> ${r.status}`)
  return await r.json() as Record<string, unknown>
}

/** Start via the CLI path under `extra` env, run `body`, then stop via the CLI path and prove the child is gone. */
async function withServer(extra: NodeJS.ProcessEnv, body: (c: { ui: string; data: string }) => Promise<void>): Promise<{ pid: number; data: string }> {
  const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]))
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-e2e-data-'))
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-e2e-home-'))
  const ui = String(await freePort())
  let pid = 0
  try {
    for (const k of KEYS) delete process.env[k]
    Object.assign(process.env, { HOME: home, DATA_DIR: data, MCP_PORT: String(await freePort()), UI_PORT: ui, OTLP_PORT: String(await freePort()), AGENTLENS_ALCORE: ALCORE }, extra)
    await ensureServer('ingestEndToEnd.test', { overrideBrake: true })
    pid = (await findServerPid()) ?? 0
    assert.ok(pid > 0, 'ensureServer returned but no server owns the data dir')
    await body({ ui, data })
    await stopServer()
    assert.strictEqual(alive(pid), false, `server pid ${pid} still alive after stopServer()`)
  } finally {
    // Only our own child (the pid owning OUR temp data dir) is ever signalled.
    if (pid > 0 && alive(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  }
  return { pid, data }
}

suite('ingest end to end — the CLI start path with a real alcore', function () {
  this.timeout(240000)

  // The debug binaries exist only after a local `cargo build` / `cargo test` (CI's unit job builds no
  // Rust), so a missing one marks the suite PENDING — visible in the report — like the other suites
  // that need local artifacts. No mtime check against the source: a checkout rewrites mtimes.
  suiteSetup(function () {
    const missing = [ALCORE, ALDIGEST, MANIFEST].filter(p => !fs.existsSync(p))
    if (missing.length) {
      console.log(`ingest end to end: PENDING, missing ${missing.map(p => path.relative(REPO, p)).join(', ')} (cargo build -p agentlens-core -p agentlens-digest)`)
      this.skip()
    }
  })

  test('AGENTLENS_INGEST=on: tap is ON, default sources, a hook event is spooled, ingest/ exists; stop reaps the child', async () => {
    const r = await withServer({ AGENTLENS_INGEST: 'on', AGENTLENS_ALDIGEST_BIN: ALDIGEST, AGENTLENS_INGEST_MANIFEST: MANIFEST }, async ({ ui, data }) => {
      const st = await getJson(ui, '/api/ingest-status')
      assert.strictEqual(st.enabled, true, `tap must be ON: ${JSON.stringify(st)}`)
      const sources = st.sources as string[]
      assert.ok(Array.isArray(sources) && sources.includes('hooks'), `default sources must list hooks: ${JSON.stringify(sources)}`)
      assert.ok(!sources.includes('bodies'), `bodies must be opt-in, not default: ${JSON.stringify(sources)}`)

      const post = await fetch(`http://127.0.0.1:${ui}/api/hook-events`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }),
      })
      assert.ok(post.status >= 200 && post.status < 300, `hook POST -> ${post.status}`)

      let last: Record<string, unknown> = st
      for (let i = 0; i < 360; i++) {   // bounded: 90 s
        last = await getJson(ui, '/api/ingest-status')
        if (Number(last.linesWritten) >= 1) break
        await sleep(250)
      }
      assert.ok(Number(last.linesWritten) >= 1, `no spooled line within 90 s: ${JSON.stringify(last)}`)
      const bySpool = last.linesBySpool as Record<string, number>
      assert.ok(Object.keys(bySpool).some(k => /hook/i.test(k) && bySpool[k] >= 1), `no hook spool line count: ${JSON.stringify(bySpool)}`)
      assert.strictEqual(last.writeErrors, 0)
      assert.strictEqual(last.droppedQueueFull, 0)
      assert.strictEqual(last.writerDead, false)
      assert.ok(fs.existsSync(path.join(data, 'ingest')), 'ingest/ must exist in the data dir when the tap is ON')
    })
    assert.ok(r.pid > 0)
  })

  test('without AGENTLENS_INGEST: tap is off, with its reason, and no ingest/ dir', async () => {
    await withServer({}, async ({ ui, data }) => {
      const st = await getJson(ui, '/api/ingest-status')
      assert.strictEqual(st.enabled, false, JSON.stringify(st))
      assert.ok(typeof st.reason === 'string' && /not configured/.test(st.reason as string), `reason: ${JSON.stringify(st)}`)
      assert.ok(!fs.existsSync(path.join(data, 'ingest')), 'ingest/ must NOT exist when the tap is off')
    })
  })
})
