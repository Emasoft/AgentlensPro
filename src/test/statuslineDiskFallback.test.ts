// src/test/statuslineDiskFallback.test.ts — TRDD-VS1FCUMU
//
// Owner order 2026-11-18: "status line hook must be digested at all times. disable must never disable the
// status line hook. just calling some fast binary to add the data to the duckdb. no need for the full server
// to be online."
//
// What is pinned here:
//   1. a sample the server did not take (no server, a non-2xx answer, or a POST still pending at the render
//      deadline) is ONE flattened line in the store's own write-ahead file, in every one of those cases and
//      with the kill switch armed; a sample the server took is not written locally;
//   2. the hook starts the sealer (`alcore statusline-seal`) rarely: when its append created today's file or
//      the file reached the byte threshold, at most once per SEAL_KICK_MIN_GAP_MS, never beside a live server
//      and never under AGENTLENS_NO_REVIVE=1.
//   3. the output of the sealer the hook started is appended to <dataDir>/statusline-seal.log (rotated over
//      1 MiB), not thrown away (TRDD-RTHA7EWK item 5).
// The sealer itself is tested in rust-core/crates/agentlens-core/tests/statusline_seal_cli.rs.

import * as assert from 'assert'
import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import { Readable } from 'stream'
import { pidfileOwnerAlive } from '../cli/hookHandlers'
import { agentlensDisabled, armKillSwitch } from '../cli/killSwitch'
import {
  captureStatusline, runStatuslineCommand, SEAL_KICK_MIN_GAP_MS, STATUSLINE_ENDPOINT, STATUSLINE_EV, SUBAGENT_STATUSLINE_EV,
} from '../cli/statuslineCapture'
import { dayKey } from '../statuslineStore'
import { freePort } from './helpers/freePort'

/** A payload shaped like the real thing (the same shape statuslineCapture.test.ts uses). */
const SAMPLE = {
  session_id: 'abc123',
  prompt_id: '550e8400-e29b-41d4-a716-446655440000',
  transcript_path: '/tmp/t.jsonl',
  version: '2.1.216',
  model: { id: 'claude-opus-5', display_name: 'Opus' },
  workspace: { current_dir: '/w', project_dir: '/w', added_dirs: [] },
  cost: { total_cost_usd: 1.5, total_duration_ms: 45000, total_api_duration_ms: 2300 },
  context_window: {
    total_input_tokens: 15500, total_output_tokens: 1200, context_window_size: 1000000,
    used_percentage: 8, remaining_percentage: 92,
    current_usage: { input_tokens: 8500, output_tokens: 1200, cache_creation_input_tokens: 5000, cache_read_input_tokens: 2000 },
  },
  rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 1738425600 }, seven_day: { used_percentage: 41.2, resets_at: 1738857600 } },
  effort: { level: 'high' },
  exceeds_200k_tokens: false,
  fast_mode: false,
}
const payload = (): Buffer => Buffer.from(JSON.stringify(SAMPLE))

/** Set or unset environment variables and put every one back exactly as it was. */
function envScope(): { set(k: string, v: string): void; unset(k: string): void; restore(): void } {
  const saved = new Map<string, string | undefined>()
  const remember = (k: string): void => { if (!saved.has(k)) saved.set(k, process.env[k]) }
  return {
    set(k: string, v: string): void { remember(k); process.env[k] = v },
    unset(k: string): void { remember(k); delete process.env[k] },
    restore(): void {
      for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
      saved.clear()
    },
  }
}

const rowsOf = (file: string): Array<Record<string, unknown>> =>
  fs.readFileSync(file, 'utf-8').split('\n').filter(l => l.length > 0).map(l => JSON.parse(l) as Record<string, unknown>)

suite('statusline disk fallback — a sample the server did not take is stored locally (TRDD-VS1FCUMU)', () => {
  let dir: string
  let server: http.Server | undefined
  const env = envScope()
  const walFile = (stream = 'main'): string => path.join(dir, 'statusline', stream, dayKey(Date.now()), 'wal-cli.ndjson')
  const listen = async (handler: http.RequestListener): Promise<void> => {
    const port = await freePort()
    const s = http.createServer(handler)
    server = s
    await new Promise<void>(resolve => s.listen(port, '127.0.0.1', resolve))
    env.set('AGENTLENS_UI_URL', `http://127.0.0.1:${port}`)
  }
  const closeServer = async (): Promise<void> => {
    const s = server
    if (!s) return
    server = undefined
    s.closeAllConnections()
    await new Promise<void>(resolve => s.close(() => resolve()))
  }

  setup(() => {
    // Isolation: HOME and the data dir are a fixture. setup.js already pins AGENTLENS_NO_REVIVE=1, so a failed
    // POST starts neither a server nor a sealer in this suite.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-disk-'))
    env.set('HOME', dir)
    env.set('AGENTLENS_DATA_DIR', dir)
    env.set('AGENTLENS_STATUSLINE_TIMEOUT_MS', '500')
  })
  teardown(async () => {
    await closeServer()
    env.restore()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('(a) no server: the sample is one flattened line in the write-ahead file, and nothing is spooled', async () => {
    env.set('AGENTLENS_UI_URL', `http://127.0.0.1:${await freePort()}`)
    await captureStatusline(payload())
    const rows = rowsOf(walFile())
    assert.strictEqual(rows.length, 1, 'exactly one line')
    const row = rows[0]
    assert.strictEqual(row.session_id, SAMPLE.session_id)
    assert.strictEqual(row.rate_limits_five_hour_used_percentage, 23.5, 'nested keys are flattened, as the server stores them')
    assert.strictEqual(row.context_window_current_usage_cache_read_input_tokens, 2000)
    assert.strictEqual(row.statusline_stream, 'main')
    assert.strictEqual(row.hook_event_name, STATUSLINE_EV)
    assert.strictEqual(typeof row.ts, 'number', 'the store orders and windows by ts')
    assert.strictEqual(row.model, undefined, 'no nested object survives the flattening')
    assert.ok(!fs.existsSync(path.join(dir, 'hook-spool')), 'a status-line sample never enters the hook spool')
  })

  test('(b) a server that answers 200 takes the sample: nothing is written locally', async () => {
    const received: string[] = []
    await listen((req, res) => {
      req.on('data', () => { /* drain */ })
      req.on('end', () => { received.push(req.url ?? ''); res.writeHead(200); res.end('{}') })
    })
    await captureStatusline(payload())
    assert.deepStrictEqual(received, [STATUSLINE_ENDPOINT])
    assert.ok(!fs.existsSync(path.join(dir, 'statusline')), 'a delivered sample is stored by the server, not here')
  })

  test('(c) a server that answers 503 did not take the sample: it is stored locally', async () => {
    await listen((req, res) => {
      req.on('data', () => { /* drain */ })
      req.on('end', () => { res.writeHead(503); res.end('{}') })
    })
    await captureStatusline(payload())
    assert.strictEqual(rowsOf(walFile()).length, 1)
  })

  test('(d) a subagent sample goes to the subagent stream', async () => {
    env.set('AGENTLENS_UI_URL', `http://127.0.0.1:${await freePort()}`)
    await captureStatusline(payload(), SUBAGENT_STATUSLINE_EV)
    const rows = rowsOf(walFile('subagent'))
    assert.strictEqual(rows.length, 1)
    assert.strictEqual(rows[0].statusline_stream, 'subagent')
    assert.ok(!fs.existsSync(walFile('main')), 'nothing lands in the main stream')
  })

  test('(e) the kill switch is armed and no server answers: the sample is still stored', async () => {
    armKillSwitch('statusline disk fallback test')
    assert.strictEqual(agentlensDisabled(), true, 'precondition: the switch is armed where captureStatusline reads it')
    env.set('AGENTLENS_UI_URL', `http://127.0.0.1:${await freePort()}`)
    await captureStatusline(payload())
    assert.strictEqual(rowsOf(walFile()).length, 1, 'disable never disables the status line')
  })

  test('(f) a server that accepts and never answers: the sample is stored at the render deadline, once', async () => {
    env.set('AGENTLENS_STATUSLINE_TIMEOUT_MS', '5000')
    env.set('AGENTLENS_STATUSLINE_RESIDUAL_MS', '50')
    await listen(() => { /* accept the request and never answer it */ })
    const t0 = Date.now()
    const code = await runStatuslineCommand(['--inner', 'true'], Readable.from([payload()]))
    const elapsedMs = Date.now() - t0
    assert.strictEqual(code, 0)
    assert.ok(elapsedMs < 3000, `the render is not held for the POST timeout: ${elapsedMs} ms`)
    assert.strictEqual(rowsOf(walFile()).length, 1, 'stored at the deadline')
    // The abandoned POST fails when the server goes away. That late failure must not store a second line.
    await closeServer()
    await new Promise<void>(resolve => setTimeout(resolve, 300))
    assert.strictEqual(rowsOf(walFile()).length, 1, 'still one line after the abandoned POST failed')
  })
})

// The spawn is observed at its seam, as in statuslineCapture.test.ts (A12): the code calls child_process.spawn
// through the module object, so the test replaces that one property with a recorder. No real child is started.
// AGENTLENS_ALCORE=/usr/bin/false makes alcoreBin resolve without touching any installed binary.
suite('statusline disk fallback — the sealer is started rarely, and never beside a live server (TRDD-VS1FCUMU)', () => {
  const cp = require('child_process') as { spawn: unknown }
  const realSpawn = cp.spawn
  let dir: string
  let spawns: string[][] = []
  const env = envScope()
  const kicks = (): string[][] => spawns.filter(s => s.includes('statusline-seal'))
  const stamp = (): string => path.join(dir, 'statusline', '.seal-kick')
  const ageStamp = (): void => {
    const old = new Date(Date.now() - SEAL_KICK_MIN_GAP_MS - 1000)
    fs.utimesSync(stamp(), old, old)
  }

  setup(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-kick-'))
    spawns = []
    env.set('HOME', dir)
    env.set('AGENTLENS_DATA_DIR', dir)
    env.set('AGENTLENS_STATUSLINE_TIMEOUT_MS', '100')
    env.set('AGENTLENS_ALCORE', '/usr/bin/false')
    // A port that was free a moment ago and has no listener: every POST is refused at once.
    env.set('AGENTLENS_UI_URL', `http://127.0.0.1:${await freePort()}`)
    // setup.js pins NO_REVIVE=1 for the whole run and fails a test that leaves it unset: restored in teardown.
    env.unset('AGENTLENS_NO_REVIVE')
    cp.spawn = (file: string, args: string[]): { unref(): void } => { spawns.push([file, ...args]); return { unref() { /* stub child */ } } }
  })
  teardown(() => {
    cp.spawn = realSpawn
    env.restore()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('(k1) the append that creates today\'s file starts the sealer once, on this data dir', async () => {
    await captureStatusline(payload())
    const k = kicks()
    assert.strictEqual(k.length, 1, `one sealer start, got ${JSON.stringify(spawns)}`)
    assert.deepStrictEqual(k[0].slice(0, 3), ['/usr/bin/false', 'statusline-seal', '--data-dir'])
    assert.strictEqual(fs.realpathSync(k[0][3]), fs.realpathSync(dir), 'the sealer is pointed at this data dir')
    assert.ok(fs.existsSync(stamp()), 'the start is stamped')
  })

  test('(k2) further appends to a small file start nothing, even after the stamp window has passed', async () => {
    for (let i = 0; i < 20; i++) await captureStatusline(payload())
    assert.strictEqual(kicks().length, 1, 'only the append that created the file started the sealer')
    ageStamp()
    await captureStatusline(payload())
    assert.strictEqual(kicks().length, 1, 'a small existing file is not a reason to start the sealer')
  })

  test('(k3) a file over the byte threshold starts the sealer at most once per stamp window', async () => {
    env.set('AGENTLENS_STATUSLINE_CLI_SEAL_BYTES', '1')
    for (let i = 0; i < 3; i++) await captureStatusline(payload())
    assert.strictEqual(kicks().length, 1, 'the stamp holds the second and third start back')
    ageStamp()
    await captureStatusline(payload())
    assert.strictEqual(kicks().length, 2, 'once the window has passed, the file over the threshold starts the sealer again')
  })

  test('(k4) AGENTLENS_NO_REVIVE=1 starts no sealer', async () => {
    env.set('AGENTLENS_NO_REVIVE', '1')
    await captureStatusline(payload())
    assert.strictEqual(spawns.length, 0, `no detached process at all, got ${JSON.stringify(spawns)}`)
    assert.ok(fs.existsSync(path.join(dir, 'statusline')), 'the sample is still stored')
  })

  test('(k5) a live server owns the data dir: its own chore seals, the hook starts nothing', async () => {
    // The legacy pidfile shape (a bare pid) naming this test process, which is alive.
    fs.writeFileSync(path.join(dir, 'server.pid'), String(process.pid))
    assert.strictEqual(pidfileOwnerAlive(), true, 'precondition: the pidfile reads as a live owner')
    await captureStatusline(payload())
    assert.strictEqual(kicks().length, 0, `no sealer beside a live server, got ${JSON.stringify(spawns)}`)
    assert.ok(fs.existsSync(path.join(dir, 'statusline')), 'the sample is still stored')
  })
})

// A real child, not the recorder of the suite above: what is pinned is where the detached sealer's output
// goes. The stub is a shell script that prints one known line on each stream, passed through AGENTLENS_ALCORE.
suite('statusline disk fallback — the output of the hook-started sealer is kept in a log (TRDD-RTHA7EWK item 5)', () => {
  let dir: string
  const env = envScope()
  const log = (): string => path.join(dir, 'statusline-seal.log')
  const logHas = (text: string): boolean => {
    try { return fs.readFileSync(log(), 'utf-8').includes(text) } catch { return false }
  }
  // The sealer is detached, so the test waits for its output (bounded) instead of for the child.
  const waitFor = async (cond: () => boolean): Promise<void> => {
    const deadline = Date.now() + 8000
    while (!cond() && Date.now() < deadline) await new Promise(r => setTimeout(r, 50))
  }

  setup(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-seallog-'))
    const stub = path.join(dir, 'stub-alcore.sh')
    fs.writeFileSync(stub, '#!/bin/sh\necho "stub sealer stdout line"\necho "stub sealer stderr line" >&2\n', { mode: 0o755 })
    env.set('HOME', dir)
    env.set('AGENTLENS_DATA_DIR', dir)
    env.set('AGENTLENS_STATUSLINE_TIMEOUT_MS', '100')
    env.set('AGENTLENS_ALCORE', stub)
    env.set('AGENTLENS_UI_URL', `http://127.0.0.1:${await freePort()}`)
    env.unset('AGENTLENS_NO_REVIVE')
  })
  teardown(() => {
    env.restore()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('(l1) the stdout and the stderr of the started sealer both land in statusline-seal.log', async () => {
    await captureStatusline(payload())
    await waitFor(() => logHas('stub sealer stdout line') && logHas('stub sealer stderr line'))
    assert.ok(logHas('stub sealer stdout line'), 'the sealer stdout line is in the log')
    assert.ok(logHas('stub sealer stderr line'), 'the sealer stderr line is in the log')
  })

  test('(l2) a log over 1 MiB is moved to statusline-seal.log.1 before the next start appends to a fresh one', async () => {
    fs.writeFileSync(log(), Buffer.alloc(1024 * 1024 + 1, 0x61))
    await captureStatusline(payload())
    await waitFor(() => logHas('stub sealer stdout line'))
    assert.ok(logHas('stub sealer stdout line'), 'the new line is in the fresh log')
    assert.ok(fs.statSync(log()).size < 1024, 'the live log was started over')
    assert.strictEqual(fs.statSync(`${log()}.1`).size, 1024 * 1024 + 1, 'the old log is kept whole as .1')
  })
})
