import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
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
const execFileP = promisify(execFile)
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }

async function getJson(port: string, p: string): Promise<Record<string, unknown>> {
  const r = await fetch(`http://127.0.0.1:${port}${p}`)
  assert.strictEqual(r.status, 200, `GET ${p} -> ${r.status}`)
  return await r.json() as Record<string, unknown>
}

/** Start via the CLI path under `extra` env, run `body`, then stop via the CLI path and prove the child is gone. */
/** Start via the CLI path under `extra` env, run `body`, then stop via the CLI path and prove the child is gone. */
async function withServer(extra: NodeJS.ProcessEnv, body: (c: { ui: string; data: string }) => Promise<void>, afterStop?: (c: { data: string }) => void): Promise<{ pid: number; data: string }> {
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
    // WHY: stopServer returns once the data dir's pidfile is released, and alcore releases it as the last
    // statement of main, so the process can still be running its exit path. In this test mocha is alcore's
    // parent: once it exits it stays a zombie until the event loop reaps it, and kill(pid, 0) succeeds on a
    // zombie. Each sleep yields to the event loop, so poll (bounded: 10 s) before asserting that it is gone.
    for (let i = 0; i < 40 && alive(pid); i++) {
      await sleep(250)
    }
    assert.strictEqual(alive(pid), false, `server pid ${pid} still alive after stopServer()`)
    afterStop?.({ data })
  } finally {
    // Only our own child is ever signalled: the pid owning OUR temp data dir. When ensureServer threw
    // after the child started, pid is still 0, so read the pidfile the child wrote in OUR data dir.
    if (pid === 0) {
      try { pid = Number(fs.readFileSync(path.join(data, 'server.pid'), 'utf8').trim()) || 0 } catch { /* no child started */ }
    }
    if (pid > 0 && alive(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
    // The two temp dirs this helper created above (never anything else).
    fs.rmSync(data, { recursive: true, force: true })
    fs.rmSync(home, { recursive: true, force: true })
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
      assert.ok('doneLedgerQueries' in st, `/api/ingest-status lacks doneLedgerQueries: the debug alcore is stale, rebuild it (cargo build -p agentlens-core -p agentlens-digest): ${JSON.stringify(st)}`)
      const sources = st.sources as string[]
      assert.ok(Array.isArray(sources) && sources.includes('hooks'), `default sources must list hooks: ${JSON.stringify(sources)}`)
      assert.ok(!sources.includes('bodies'), `bodies must be opt-in, not default: ${JSON.stringify(sources)}`)

      // The spool tap rejects a hook item that lacks a field its schema requires (validator d8de334d; this test
      // predates it). SessionStart requires cwd, transcript_path and source, so the payload must carry all three.
      const post = await fetch(`http://127.0.0.1:${ui}/api/hook-events`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', cwd: '/tmp/synthetic', transcript_path: '/tmp/synthetic/t.jsonl', source: 'startup' }),
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

  test('a real collect and views run: the ledger, the hook and statusline views hold exactly what was posted; done/ keeps the loaded files', async function () {
    this.timeout(300_000)
    // Waits for the tap's own periodic tick (60 s: the CLI does not pass --ingest-interval-secs). WHY 240 s: the
    // seal+collect tick runs on the background-QoS runtime (chores.rs, TRDD-RVKQDLRD), which was starved past 150 s
    // under a load spike, so this waits for at least three ticks plus margin.
    const ids = { start: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', end: 'cccccccc-cccc-cccc-cccc-cccccccccccc', sl: 'dddddddd-dddd-dddd-dddd-dddddddddddd' }
    const query = async (db: string, sql: string): Promise<Record<string, unknown>[]> => {
      // The collect/views children hold the database read-write while they run; a read-only open then
      // fails, so retry until that tick has finished. Never opened read-write here.
      let err = ''
      for (let i = 0; i < 120; i++) {
        try {
          const { stdout } = await execFileP(ALDIGEST, ['query', '--db', db, '--sql', sql])
          return stdout.split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as Record<string, unknown>)
        } catch (e) { err = String((e as { stderr?: string }).stderr ?? e); await sleep(500) }
      }
      throw new Error(`aldigest query never succeeded for ${sql}: ${err}`)
    }
    let loadedFiles: string[] = []
    await withServer({ AGENTLENS_INGEST: 'on', AGENTLENS_ALDIGEST_BIN: ALDIGEST, AGENTLENS_INGEST_MANIFEST: MANIFEST }, async ({ ui, data }) => {
      const db = path.join(data, 'ingest', 'events.duckdb')
      const post = async (p: string, payload: object): Promise<void> => {
        const r = await fetch(`http://127.0.0.1:${ui}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
        assert.ok(r.status >= 200 && r.status < 300, `POST ${p} -> ${r.status}`)
      }
      // cwd, transcript_path and source/reason are REQUIRED by the hook schemas (a real event always has them);
      // without cwd the collect fails the whole file with a NOT NULL constraint.
      await post('/api/hook-events', { hook_event_name: 'SessionStart', session_id: ids.start, cwd: '/tmp/synthetic', transcript_path: '/tmp/synthetic/t.jsonl', source: 'startup' })
      await post('/api/hook-events', { hook_event_name: 'SessionEnd', session_id: ids.end, cwd: '/tmp/synthetic', transcript_path: '/tmp/synthetic/t.jsonl', reason: 'other' })
      await post('/api/statusline-samples', { session_id: ids.sl, model: { id: 'claude-opus-5' } })

      let st = await getJson(ui, '/api/ingest-status')
      for (let i = 0; i < 360 && Number(st.linesWritten) < 3; i++) { await sleep(250); st = await getJson(ui, '/api/ingest-status') }
      assert.ok(Number(st.linesWritten) >= 3, `fewer than 3 spooled lines within 90 s: ${JSON.stringify(st)}`)
      // A tick may seal only part of what was posted, so every distinct collect record seen is summed
      // (a record is keyed by its atMs). Done when at least the hook spool and the statusline spool loaded.
      const seen = new Map<number, { exit?: number; timedOut?: boolean; summary?: string }>()
      let loaded = 0, failed = 0
      for (let i = 0; i < 960 && !(loaded >= 2 && st.views); i++) {   // bounded: 240 s, the tick period is 60 s
        st = await getJson(ui, '/api/ingest-status')
        const rec = st.lastCollect as { atMs?: number; exit?: number; timedOut?: boolean; summary?: string } | null
        if (rec && !seen.has(Number(rec.atMs))) {
          seen.set(Number(rec.atMs), rec)
          assert.ok(rec.exit === 0 && rec.timedOut === false, `a collect child must exit 0: ${JSON.stringify(rec)}`)
          const m = /loaded files=(\d+) rows=(\d+) failed=(\d+)/.exec(rec.summary ?? '')
          assert.ok(m, `collect summary unreadable: ${JSON.stringify(rec)}`)
          loaded += Number(m[1]); failed += Number(m[3])
        }
        await sleep(250)
      }
      const ledger = failed === 0 ? [] : await query(db, 'SELECT spool, source_name, status, error_message FROM _ingest.files')
      assert.ok(loaded >= 2 && failed === 0, `collect must have loaded files and failed none: loaded=${loaded} failed=${failed} records=${JSON.stringify([...seen.values()])} ledger: ${JSON.stringify(ledger)}`)
      const vw = st.views as { exit?: number } | null
      assert.ok(vw && vw.exit === 0, `views must have exited 0: ${JSON.stringify(st.views)}`)
      assert.strictEqual(st.writeErrors, 0)
      assert.strictEqual(st.droppedQueueFull, 0)
      assert.strictEqual(st.writerDead, false)

      const files = await query(db, 'SELECT spool, source_name, status FROM _ingest.files')
      assert.ok(files.some(f => f.status === 'complete'), `no complete ledger row: ${JSON.stringify(files)}`)
      assert.ok(files.every(f => f.status !== 'failed'), `a ledger row failed: ${JSON.stringify(files)}`)
      loadedFiles = files.filter(f => f.status === 'complete').map(f => `${f.spool}/${f.source_name}`)

      const views = (await query(db, "SELECT table_name FROM information_schema.tables WHERE table_schema = 'u'")).map(r => String(r.table_name))
      for (const v of ['hook__session_start', 'hook__session_end', 'statusline_main__core']) assert.ok(views.includes(v), `view u.${v} missing: ${JSON.stringify(views)}`)
      assert.deepStrictEqual((await query(db, 'SELECT session_id FROM u."hook__session_start"')).map(r => r.session_id), [ids.start])
      assert.deepStrictEqual((await query(db, 'SELECT session_id FROM u."hook__session_end"')).map(r => r.session_id), [ids.end])
      assert.deepStrictEqual((await query(db, 'SELECT session_id FROM u."statusline_main__core"')).map(r => r.session_id), [ids.sl])
    }, ({ data }) => {
      // Retention is off by default: every loaded file must still be in done/<spool>/.
      assert.ok(loadedFiles.length >= 1)
      for (const f of loadedFiles) assert.ok(fs.existsSync(path.join(data, 'ingest', 'done', f)), `loaded file missing from done/: ${f}`)
    })
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
