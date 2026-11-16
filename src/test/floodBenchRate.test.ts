// src/test/floodBenchRate.test.ts — TRDD-C19SUVPH Part 2: the ingest-flood bench's REPORTED
// counts agree with what a real alcore actually received, at a paced rate.
//
// What it proves: run against a real alcore, `scripts/bench/alcore-ingest-flood.mjs` sends the
// number of requests its pacing promises (2N-2 <= ok2xx <= 2N at --rate 2 for N seconds), and every
// request it counts as ok is one the server counted too — statusline samples for `--mix statusline`,
// 20 spans per POST for `--mix otlp --spans-per-request 20` — with no cross-mode leak. The bench's
// own reported deltas are checked against counters this test reads itself, so a bench that
// miscounts its own requests cannot pass by agreeing with itself.
//
// Isolation: free ports from freePort(), a temp HOME and data dir, `--no-log-scan` (so the sweeper
// never reads a real corpus whatever CLAUDE_CONFIG_DIR / CODEX_HOME / XDG_* say), and an env with
// every variable that could steer either process at the live install deleted.
//
// Why alcore is spawned directly rather than through spawnServerWithRetry: that helper builds argv
// from alcoreArgsFromEnv, which cannot pass `--no-log-scan`. The same bounded port-retry is
// reproduced below.
//
// Two timing facts the assertions are built on (reports_dev/c19/20261017_171914+0200-part2-measure.md
// section 5, and reports_dev/c19/20261017_172321+0200-part2-measure-r2.md sections 3 and 5):
//   - spans.store.totalSpans counts FLUSHED segments only, and the live OTLP handler does not flush;
//     the flush chore runs every 5 s. So span deltas are read 6 s or more after the bench exits.
//   - admission.admittedTotal counts every non-exempt UI request. The bench makes exactly two
//     (the /api/debug/log-scan-stats read in its before and final snapshots; --progress-sec 100000
//     keeps the progress tick from adding a racy third), and this test reads only the exempt
//     /api/server-stats. So the admitted delta is ok2xx + 2 for statusline, and 2 for OTLP (the
//     OTLP port has no admission).
//
// CI flake budget: 2N is a hard ceiling because of the bench's shared send budget plus its
// deadline break (TRDD-C19SUVPH deadline-edge fix: a timer can wake 1 ms early, and before the fix
// that let an unscheduled send through; Case T below holds it with early-firing timers). The 2N-2
// floor tolerates two requests lost to timer lateness of 500 ms or more past the deadline. A red
// floor on a loaded runner is load, not a bench bug — re-run before filing one.

import * as assert from 'assert'
import * as http from 'http'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import { spawn, type ChildProcess } from 'child_process'
import { freePort, alcoreTestBin } from './helpers/freePort'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const REPO = path.resolve(__dirname, '..', '..', '..')
const BENCH = path.join(REPO, 'scripts', 'bench', 'alcore-ingest-flood.mjs')

function benchSeconds(): number {
  const raw = process.env.FLOOD_RATE_SECONDS || '10'
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`FLOOD_RATE_SECONDS must be a positive integer, got ${JSON.stringify(raw)}`)
  return n
}
const N = benchSeconds()

// Every variable that could point either process at the live install, or change its limits.
const SCRUBBED_ENV = [
  'DATA_DIR', 'UI_PORT', 'OTLP_PORT', 'MCP_PORT', 'AGENTLENS_GATE', 'AGENTLENS_GATE_MODE',
  'AGENTLENS_NO_REVIVE', 'AGENTLENS_MAX_RSS_MB', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'OPENCODE_DATA_DIR',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'APPDATA', 'LOCALAPPDATA',
]

interface Stats { totalSpans: number; statuslineReceived: number; admittedTotal: number }
interface BenchResult {
  ok2xx: number; nonOk: number; revived: boolean; deltaBasis: string; statuslineReceivedDelta: number | null
}
interface BenchRun { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; result: BenchResult }

function getJson(port: number, urlPath: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: urlPath }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const t = Buffer.concat(chunks).toString('utf-8')
        if (res.statusCode !== 200) { reject(new Error(`GET ${urlPath} -> ${res.statusCode}: ${t.slice(0, 200)}`)); return }
        try { resolve(JSON.parse(t)) } catch (e) { reject(e as Error) }
      })
    })
    req.setTimeout(5_000, () => req.destroy(new Error(`GET ${urlPath} timed out`)))
    req.on('error', reject)
    req.end()
  })
}

function num(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`server-stats ${name} is not a number: ${JSON.stringify(v)}`)
  return v
}

suite('ingest-flood bench — reported counts match a real alcore at a paced rate (real boot)', () => {
  let child: ChildProcess | undefined
  let bench: ChildProcess | undefined
  let tmp = ''
  let env: NodeJS.ProcessEnv = {}
  let otlpPort = 0
  let uiPort = 0
  let serverLog = ''
  let earlyTimers = ''

  // /api/server-stats is admission-EXEMPT, so these reads never move admittedTotal.
  async function stats(): Promise<Stats> {
    const j = await getJson(uiPort, '/api/server-stats') as {
      spans?: { store?: { totalSpans?: unknown } }; statusline?: { receivedSinceBoot?: unknown }; admission?: { admittedTotal?: unknown }
    }
    return {
      totalSpans: num(j.spans?.store?.totalSpans, 'spans.store.totalSpans'),
      statuslineReceived: num(j.statusline?.receivedSinceBoot, 'statusline.receivedSinceBoot'),
      admittedTotal: num(j.admission?.admittedTotal, 'admission.admittedTotal'),
    }
  }

  function runBench(args: string[], seconds = N, extraEnv: NodeJS.ProcessEnv = {}): Promise<BenchRun> {
    return new Promise((resolve, reject) => {
      const p = spawn(process.execPath, [BENCH, ...args, '--ui-port', String(uiPort), '--otlp-port', String(otlpPort),
        '--concurrency', '4', '--rate', '2', '--seconds', String(seconds), '--progress-sec', '100000'],
      { env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] })
      bench = p
      let stdout = ''; let stderr = ''
      p.stdout?.on('data', (c: Buffer) => { stdout += c.toString('utf-8') })
      p.stderr?.on('data', (c: Buffer) => { stderr += c.toString('utf-8') })
      const killer = setTimeout(() => p.kill('SIGKILL'), (seconds + 30) * 1000)
      p.on('error', (e) => { clearTimeout(killer); reject(e) })
      p.on('close', (status, signal) => {
        clearTimeout(killer)
        bench = undefined
        const last = stdout.trim().split('\n').pop() ?? ''
        let result: BenchResult
        try { result = JSON.parse(last) as BenchResult } catch {
          reject(new Error(`bench printed no JSON result (status ${status}, signal ${signal})\nstdout: ${stdout}\nstderr: ${stderr}`)); return
        }
        resolve({ status, signal, stdout, stderr, result })
      })
    })
  }

  // Guards, not claims: they only establish that the run was a clean, complete one against the
  // same server, so the counting assertions after them mean what they say.
  function assertCleanRun(run: BenchRun): void {
    const r = run.result
    assert.strictEqual(run.status, 0, `bench exited ${run.status} (signal ${run.signal})\nstderr: ${run.stderr}`)
    assert.strictEqual(r.deltaBasis, 'final', 'the deltas rest on the final snapshot')
    assert.strictEqual(r.revived, false, 'the server was not restarted mid-run')
    assert.strictEqual(r.nonOk, 0, 'no request failed or was shed')
  }

  function assertRate(r: BenchResult): void {
    // 2N is the exact ceiling, held by the bench's send budget plus its deadline break (not by
    // timers being punctual — they can wake 1 ms early); the floor allows two late-timer drops.
    assert.ok(r.ok2xx >= 2 * N - 2 && r.ok2xx <= 2 * N, `ok2xx=${r.ok2xx} outside [${2 * N - 2}, ${2 * N}]`)
  }

  suiteSetup(async function () {
    this.timeout(90_000)
    const bin = alcoreTestBin()
    if (bin === null) throw new Error('no alcore binary found (set AGENTLENS_ALCORE or build rust-core/target/release/alcore)')
    if (!fs.existsSync(BENCH)) throw new Error(`bench not found at ${BENCH}`)
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'al-floodrate-'))
    const home = path.join(tmp, 'home'); const data = path.join(tmp, 'data')
    fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(data, { recursive: true })
    // Case T's preload: every setTimeout above 5 ms fires 5 ms early, an exaggerated form of the
    // measured 1 ms early wake, so the bench's ceiling is tested against early timers on purpose.
    earlyTimers = path.join(tmp, 'early-timers.cjs')
    fs.writeFileSync(earlyTimers, "const orig = globalThis.setTimeout; globalThis.setTimeout = (fn, d, ...a) => orig(fn, typeof d === 'number' && d > 5 ? d - 5 : d, ...a);\n")
    env = { ...process.env, HOME: home, AGENTLENS_WATCHDOG: 'off' }
    for (const k of SCRUBBED_ENV) delete env[k]

    const maxAttempts = 3
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const [otlp, ui, mcp] = [await freePort(), await freePort(), await freePort()]
      otlpPort = otlp; uiPort = ui
      serverLog = ''
      const c = spawn(bin, ['serve', '--data-dir', data, '--media-dir', path.join(REPO, 'media'),
        '--otlp-port', String(otlp), '--ui-port', String(ui), '--mcp-port', String(mcp), '--bind', '127.0.0.1', '--no-log-scan'],
      { env, stdio: ['ignore', 'pipe', 'pipe'] })
      child = c
      c.stdout?.on('data', (b: Buffer) => { serverLog += b.toString('utf-8') })
      c.stderr?.on('data', (b: Buffer) => { serverLog += b.toString('utf-8') })
      let exited = false
      c.on('exit', () => { exited = true })
      const deadline = Date.now() + 30_000
      let ready = false
      while (!exited && Date.now() < deadline) {
        try { await getJson(ui, '/api/server-stats'); ready = true; break } catch { await sleep(200) }
      }
      if (ready) {
        // The counters must come from THIS isolated server, not from something else that answered on
        // the port: the server names its own data dir, and it must be the temp one.
        const sj = await getJson(ui, '/api/server-stats') as { dataDir?: unknown }
        assert.strictEqual(typeof sj.dataDir, 'string', `server-stats has no dataDir: ${JSON.stringify(sj.dataDir)}`)
        assert.strictEqual(fs.realpathSync(sj.dataDir as string), fs.realpathSync(data), 'the server on the test port owns the temp data dir')
        return
      }
      if (!exited) { c.kill('SIGKILL'); await new Promise<void>((r) => { if (c.exitCode !== null || c.signalCode !== null) r(); else c.on('close', () => r()) }) }
      child = undefined
      // An early exit is most likely a port another process grabbed between probe and bind: re-pick.
      if (attempt === maxAttempts || !exited) throw new Error(`alcore never became ready (attempt ${attempt}, exited=${exited})\n${serverLog}`)
    }
  })

  suiteTeardown(async function () {
    this.timeout(15_000)
    try {
      if (bench && bench.exitCode === null && bench.signalCode === null) bench.kill('SIGKILL')
      const c = child
      if (c && c.exitCode === null && c.signalCode === null) {
        const closed = new Promise<void>((res) => c.on('close', () => res()))
        c.kill('SIGTERM')
        const ok = await Promise.race([closed.then(() => true), sleep(5_000).then(() => false)])
        if (!ok) { c.kill('SIGKILL'); await closed }
      }
    } finally { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }) }
  })

  test('statusline mix: every ok2xx is one statusline sample the server received, and nothing else moves', async function () {
    this.timeout((2 * N + 60) * 1000)
    const before = await stats()
    const run = await runBench(['--mix', 'statusline'])
    const exitAt = Date.now()
    const after1 = await stats()
    await sleep(1_000)
    const after2 = await stats()
    assertCleanRun(run)
    const r = run.result
    // Measured values, one line, so a CI log shows the numbers a pass rests on.
    console.log(`    measured: ok2xx=${r.ok2xx} statusline=${after1.statuslineReceived - before.statuslineReceived} admitted=${after2.admittedTotal - before.admittedTotal}`)
    assertRate(r)
    assert.strictEqual(after1.statuslineReceived - before.statuslineReceived, r.ok2xx, 'server statusline delta equals ok2xx')
    assert.strictEqual(after2.statuslineReceived, after1.statuslineReceived, 'the statusline count is stable after the run')
    assert.strictEqual(r.statuslineReceivedDelta, r.ok2xx, 'the bench reports the same statusline delta')
    assert.strictEqual(after2.admittedTotal - before.admittedTotal, r.ok2xx + 2, 'admitted = statusline POSTs + the two snapshot reads')
    // Spans are counted only once flushed (every 5 s): read 6 s past the bench exit.
    await sleep(Math.max(0, exitAt + 6_000 - Date.now()))
    const after3 = await stats()
    console.log(`    measured: spans=${after3.totalSpans - before.totalSpans}`)
    assert.strictEqual(after3.totalSpans - before.totalSpans, 0, 'a statusline-only run appends no spans')
  })

  test('otlp mix: every ok2xx is 20 spans the server stored, and no statusline sample moves', async function () {
    this.timeout((2 * N + 60) * 1000)
    // Settle the baseline: a failed Case S stops before its own 6 s span wait, so its unflushed
    // spans could land in this window. Wait until two reads >= 6 s apart agree (15 s cap).
    {
      const settleBy = Date.now() + 15_000
      let ref = await stats()
      let refAt = Date.now()
      while (Date.now() < settleBy) {
        await sleep(1_000)
        const cur = await stats()
        if (cur.totalSpans !== ref.totalSpans) { ref = cur; refAt = Date.now() } else if (Date.now() - refAt >= 6_000) break
      }
    }
    const before = await stats()
    const run = await runBench(['--mix', 'otlp', '--spans-per-request', '20'])
    assertCleanRun(run)
    const r = run.result
    assertRate(r)
    const expected = 20 * r.ok2xx
    // Poll past the 5 s flush: stop on the expected value, or on two equal reads >= 6 s apart.
    const deadline = Date.now() + 15_000
    let last = await stats()
    let stableFrom = { at: Date.now(), spans: last.totalSpans }
    while (last.totalSpans - before.totalSpans !== expected && Date.now() < deadline) {
      await sleep(1_000)
      last = await stats()
      if (last.totalSpans !== stableFrom.spans) stableFrom = { at: Date.now(), spans: last.totalSpans }
      else if (Date.now() - stableFrom.at >= 6_000) break
    }
    console.log(`    measured: ok2xx=${r.ok2xx} spans=${last.totalSpans - before.totalSpans} statusline=${last.statuslineReceived - before.statuslineReceived} admitted=${last.admittedTotal - before.admittedTotal}`)
    assert.strictEqual(last.totalSpans - before.totalSpans, expected, `spans delta equals 20 x ok2xx (${r.ok2xx})`)
    assert.strictEqual(last.statuslineReceived - before.statuslineReceived, 0, 'an OTLP-only run sends no statusline sample')
    assert.strictEqual(last.admittedTotal - before.admittedTotal, 2, 'admitted = the two snapshot reads only (OTLP has no admission)')
  })

  // A fixed 7 s, not N: odd, so worker 2's stagger lands on a slot edge and the early-waking
  // stagger path is exercised too (deadline-fix measure, section 2 residual). 2 x 7 = 14 is the ceiling.
  test('early-firing timers cannot exceed the ceiling', async function () {
    const T = 7
    this.timeout((T * 2 + 60) * 1000)
    const before = await stats()
    const run = await runBench(['--mix', 'statusline'], T, { NODE_OPTIONS: `--require ${earlyTimers}` })
    const after = await stats()
    assertCleanRun(run)
    const r = run.result
    console.log(`    measured: ok2xx=${r.ok2xx} statusline=${after.statuslineReceived - before.statuslineReceived}`)
    assert.ok(r.ok2xx <= 2 * T, `ok2xx=${r.ok2xx} exceeds the ceiling ${2 * T} with early-firing timers`)
    assert.ok(r.ok2xx >= 1, 'the run sent at least one request')
    assert.strictEqual(after.statuslineReceived - before.statuslineReceived, r.ok2xx, 'server statusline delta equals ok2xx')
  })
})
