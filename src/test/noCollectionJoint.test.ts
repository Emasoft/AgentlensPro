// TRDD-RBBEX59R c2 item 9 — the JOINT test: the owner requirement «keep the guards» made observable end to end, with
// the REAL alcore (c1, bin-native/) and the REAL bundled CLI (standalone/cli.js, run through node — never the
// `agentlenspro` on PATH, which is npm-linked to another tree). Opt-in: it boots several servers and waits out a hook
// revive, so it runs only with AGENTLENS_RBBEX59R_JOINT=1 and is skipped by a plain `pnpm run test:unit`.
//
// Isolation: every leg has its own HOME and DATA_DIR under ONE fixed temp-root prefix, three probed-free ports
// (never 4318 / 3000 / 4316 — the live collector holds 4318, which never moves, and a served MCP port makes
// runSupervise refuse), and an env built from scratch (no AGENTLENS_DISABLED unless the leg sets it, no
// AGENTLENS_GATE*, no OTEL_*, no AGENTLENS_NO_REVIVE, no AGENTLENS_*_URL, AGENTLENS_NO_AUTOSETUP=1 so no verb runs
// the first-run full setup). The enable/disable verbs are driven from THIS source, through node (src/cli/reviewLoop.ts
// denies them on a Bash command line).
import * as assert from 'assert'
import * as cp from 'child_process'
import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import { freePort } from './helpers/freePort'
import { captureStatusline } from '../cli/statuslineCapture'
import { queryStatusline } from '../statuslineStore'

const ENABLED = process.env.AGENTLENS_RBBEX59R_JOINT === '1'
const REPO = path.resolve(__dirname, '..', '..', '..')
const CLI = path.join(REPO, 'standalone', 'cli.js')
const ALCORE = path.join(REPO, 'bin-native', `${process.platform}-${process.arch}`, 'alcore')
/** The fixed temp-root prefix: absolute and separator-terminated, so `…/joint-1` can never match `…/joint-12`. */
const PREFIX = '/tmp/rbbex59r-c2-joint/'
// The REAL home, from the password database — os.homedir() reads $HOME, which src/test/setup.js overrides.
const REAL_HOME = os.userInfo().homedir
const LIVE_DATA_DIR = path.join(REAL_HOME, '.agentlens')

interface Leg { name: string; home: string; data: string; ports: { otlp: number; ui: number; mcp: number } }
interface Run { code: number | null; stdout: string; stderr: string }

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

async function makeLeg(name: string): Promise<Leg> {
  const root = path.join(PREFIX, `${process.pid}-${name}`)
  fs.rmSync(root, { recursive: true, force: true })
  const home = path.join(root, 'home')
  const data = path.join(root, 'data')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(data, { recursive: true })
  const pick = async (): Promise<number> => { for (;;) { const p = await freePort(); if (![4318, 3000, 4316].includes(p)) return p } }
  const ports = { otlp: await pick(), ui: await pick(), mcp: await pick() }
  // Three DISTINCT ports (round 2, H): freePort() de-duplicates within this process, but the leg must not rely on it.
  assert.strictEqual(new Set([ports.otlp, ports.ui, ports.mcp]).size, 3, `leg ${name}: ports must be distinct: ${JSON.stringify(ports)}`)
  return { name, home, data, ports }
}

function legEnv(leg: Leg, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    TMPDIR: os.tmpdir(),
    HOME: leg.home,
    AGENTLENS_DATA_DIR: leg.data,
    OTLP_PORT: String(leg.ports.otlp),
    UI_PORT: String(leg.ports.ui),
    MCP_PORT: String(leg.ports.mcp),
    AGENTLENS_ALCORE: ALCORE,
    AGENTLENS_NO_AUTOSETUP: '1',
    ...extra,
  }
}

function cli(leg: Leg, args: string[], opts: { input?: string; extra?: Record<string, string>; timeoutMs?: number } = {}): Run {
  const r = cp.spawnSync(process.execPath, [CLI, ...args], { env: legEnv(leg, opts.extra), input: opts.input ?? '', encoding: 'utf8', timeout: opts.timeoutMs ?? 240_000 })
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

function getJson(port: number, urlPath: string): Promise<Record<string, unknown> | null> {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: 3_000 }, res => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) } catch { resolve(null) } })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
  })
}

function postJson(port: number, urlPath: string, body: unknown): Promise<number> {
  return new Promise(resolve => {
    const payload = Buffer.from(JSON.stringify(body))
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length }, timeout: 5_000 }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode ?? 0))
    })
    req.on('error', () => resolve(0))
    req.on('timeout', () => { req.destroy(); resolve(0) })
    req.end(payload)
  })
}

const stats = (leg: Leg): Promise<Record<string, unknown> | null> => getJson(leg.ports.ui, '/api/server-stats')

async function waitStats(leg: Leg, pred: (s: Record<string, unknown>) => boolean, timeoutMs: number): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const s = await stats(leg)
    if (s !== null && pred(s)) return s
    await sleep(500)
  }
  return null
}

/** The process table, snapshotted to a FILE first and then searched (never pgrep / ps | grep: they match themselves). */
function psLines(): string[] {
  const snap = path.join(PREFIX, `ps-${process.pid}-${Date.now()}.txt`)
  cp.execFileSync('/bin/sh', ['-c', `ps -eo pid,ppid,command > ${JSON.stringify(snap)}`])
  const lines = fs.readFileSync(snap, 'utf8').split('\n').slice(1).filter(l => l.trim().length > 0)
  fs.rmSync(snap, { force: true })
  return lines
}
const pidOf = (line: string): number => Number(line.trim().split(/\s+/)[0])
/** The --data-dir VALUE of an `alcore serve` argv line, or null. */
function alcoreDataDir(line: string): string | null {
  const argv = line.trim().split(/\s+/).slice(2)
  if (!argv.some(a => a.endsWith('/alcore')) || !argv.includes('serve')) return null
  const i = argv.indexOf('--data-dir')
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null
}
const alcoresFor = (dir: string): number[] => psLines().filter(l => alcoreDataDir(l) === dir).map(pidOf)
const supervisorShape = (line: string): boolean => line.includes(`${CLI} server start --supervise`)

/** Only leftovers of THIS test may be signalled: the argument prefix must not cover the live data dir. */
function assertSafePrefix(): void {
  for (const p of prefixes()) {
    assert.ok(p.length > 1 && path.isAbsolute(p) && p.endsWith(path.sep), `prefix must be non-empty, absolute and separator-terminated: ${p}`)
    assert.ok(!(LIVE_DATA_DIR + path.sep).startsWith(p), `the SIGTERM prefix ${p} must not be a prefix of the live data dir ${LIVE_DATA_DIR}`)
    assert.ok(!(REAL_HOME + path.sep).startsWith(p), `the SIGTERM prefix ${p} must not cover the real home ${REAL_HOME}`)
  }
}
/** PREFIX and its realpath: /tmp is a symlink to /private/tmp on macOS, and alcore may report or be passed either form. */
function prefixes(): string[] {
  let real = PREFIX
  try { real = fs.realpathSync(PREFIX) } catch { /* not created yet: the literal form only */ }
  if (!real.endsWith(path.sep)) real += path.sep
  return real === PREFIX ? [PREFIX] : [PREFIX, real]
}
const underPrefix = (dir: string | null): boolean => dir !== null && prefixes().some(p => dir.startsWith(p))

/** SIGTERM leftovers of an earlier hard-killed run: a supervisor of this worktree's cli.js, or an alcore whose
 *  --data-dir VALUE starts with the prefix (a path-prefix match on the value, not an argv substring). */
function sigtermLeftovers(): number[] {
  assertSafePrefix()
  const victims = psLines().filter(l => pidOf(l) !== process.pid && (supervisorShape(l) || underPrefix(alcoreDataDir(l)))).map(pidOf)
  for (const pid of victims) { try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ } }
  return victims
}

const span = (marker: string): unknown => ({
  resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: `${marker}-trace`, spanId: marker, name: 'invoke_agent joint', startTimeUnixNano: `${Date.now()}000000`, endTimeUnixNano: `${Date.now()}000000`, attributes: [], status: { code: 0 } }] }] }],
})
/** <data>/hook-events/ holds append-only DAILY buckets `YYYY-MM-DD.ndjsonl` (UTC day), one JSON line per event,
 *  newline-terminated (hook_events.rs bucket_path / append_bucket_raw). So EVENTS are counted, not files: the number of
 *  newline-terminated lines across every file under hook-events (a second event on the same day adds no file). */
const hookEventLines = (leg: Leg): number => {
  const dir = path.join(leg.data, 'hook-events')
  let n = 0
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else for (const b of fs.readFileSync(p)) if (b === 0x0a) n++
    }
  }
  try { walk(dir) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
  return n
}
const spansInMemory = (s: Record<string, unknown> | null): number => Number((s?.spans as { inMemory?: unknown } | undefined)?.inMemory ?? NaN)
/** How long the positive controls poll for a present span / hook event — and so the MINIMUM an absence read must hold. */
const CONTROL_WINDOW_MS = 15_000
/** The absence read: sampled every 500 ms through the whole control window, so a store that lands late (the hook-events
 *  write and the span ingest are asynchronous to the POST) still fails it. Any rise above the baseline fails at once. */
async function assertNothingStored(leg: Leg, events0: number, spans0: number, when: string): Promise<void> {
  const deadline = Date.now() + CONTROL_WINDOW_MS
  for (;;) {
    assert.strictEqual(hookEventLines(leg), events0, `no new hook event ${when}`)
    assert.strictEqual(spansInMemory(await stats(leg)), spans0, `no new span ${when}`)
    if (Date.now() >= deadline) return
    await sleep(500)
  }
}

function subagentStarts(leg: Leg, session: string, n: number): void {
  for (let i = 0; i < n; i++) {
    const r = cli(leg, ['hook'], { input: JSON.stringify({ hook_event_name: 'SubagentStart', session_id: session, agent_type: 'general-purpose', cwd: leg.home }) })
    assert.strictEqual(r.code, 0, `hook ${i}: ${r.stderr}`)
  }
}
function agentGate(leg: Leg, session: string): { out: Record<string, unknown> | null; run: Run } {
  const run = cli(leg, ['gate'], { input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: session, cwd: leg.home, tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose', prompt: 'summarize the module layout' } }) })
  let out: Record<string, unknown> | null = null
  try { out = JSON.parse(run.stdout) as Record<string, unknown> } catch { out = null }
  return { out, run }
}
function assertRunawayDeny(g: { out: Record<string, unknown> | null; run: Run }): void {
  assert.strictEqual(g.run.code, 0, 'the gate always exits 0')
  const hso = g.out?.hookSpecificOutput as { permissionDecision?: unknown } | undefined
  assert.strictEqual(hso?.permissionDecision, 'deny', `deny expected, got: ${g.run.stdout}`)
  assert.ok(String(g.out?.systemMessage ?? '').includes('(RUNAWAY_FANOUT)'), String(g.out?.systemMessage))
}

suite('TRDD-RBBEX59R c2 joint test — the guards keep running in no-collection mode (opt-in, real alcore)', function () {
  this.timeout(20 * 60_000)
  let holder: cp.ChildProcess | null = null
  const legs: Leg[] = []
  let supervisor: cp.ChildProcess | null = null

  suiteSetup(async function () {
    if (!ENABLED) { this.skip(); return }
    assertSafePrefix()
    assert.ok(fs.existsSync(CLI), `bundle missing: ${CLI} (run node esbuild.js)`)
    assert.ok(fs.readFileSync(CLI, 'utf8').includes('restartIntoCollection'), 'the bundle predates c2 — a failed esbuild leaves the stale bundle')
    assert.strictEqual(cp.spawnSync(ALCORE, ['--version']).status !== 137, true, 'alcore is SIGKILLed at exec (unsigned?) — codesign -s - --force it')
    fs.mkdirSync(PREFIX, { recursive: true })
    // An OS advisory lock (flock) held by a child for the whole run: the kernel drops it when the holder dies, so a
    // hard-killed run leaves no stale lock; a second concurrent run refuses here instead of signalling the first.
    holder = cp.spawn('/usr/bin/perl', ['-e', 'use Fcntl qw(:flock); open(my $f, ">>", $ARGV[0]) or exit 2; flock($f, LOCK_EX|LOCK_NB) or exit 75; $|=1; print "locked\\n"; <STDIN>;', path.join(PREFIX, 'joint.lock')], { stdio: ['pipe', 'pipe', 'inherit'] })
    const locked = await new Promise<boolean>(resolve => {
      holder!.stdout!.once('data', () => resolve(true))
      holder!.once('exit', () => resolve(false))
    })
    assert.ok(locked, 'another joint run holds the lock — refusing to run concurrently')
    const killed = sigtermLeftovers()
    if (killed.length > 0) await sleep(3_000)
  })

  suiteTeardown(async function () {
    if (!ENABLED) return
    try {
      for (const leg of legs) cli(leg, ['server', 'stop'], { timeoutMs: 60_000 })
      if (supervisor && supervisor.exitCode === null) {
        supervisor.kill('SIGTERM')
        await new Promise<void>(r => { const t = setTimeout(() => r(), 10_000); supervisor!.once('exit', () => { clearTimeout(t); r() }) })
      }
      sigtermLeftovers()
      await sleep(3_000)
      const left = psLines().filter(l => supervisorShape(l) || underPrefix(alcoreDataDir(l)))
      assert.deepStrictEqual(left, [], 'cleanup must leave no alcore on a test data dir and no test supervisor')
    } finally {
      holder?.stdin?.end()
      holder?.kill('SIGTERM')
    }
  })

  // Shared across legs 1, 1b, 4 and 5 (leg 4 starts from the leg-1 file-only state).
  let main: Leg

  test('leg 1 — DISABLED file, explicit server start: collection off; 8 SubagentStart then an Agent launch is DENIED (RUNAWAY_FANOUT); nothing stored', async () => {
    main = await makeLeg('main'); legs.push(main)
    fs.writeFileSync(path.join(main.data, 'DISABLED'), 'joint test\n')
    const start = cli(main, ['server', 'start'])
    assert.strictEqual(start.code, 0, start.stderr + start.stdout)
    const s = await waitStats(main, () => true, 60_000)
    assert.strictEqual(s?.collection, 'off')
    assert.strictEqual(s?.startedBy, 'server start')
    assert.strictEqual(await postJson(main.ports.otlp, '/v1/traces', span('joint-leg1')), 200, 'OTLP is answered (and dropped)')
    subagentStarts(main, 'joint-main', 8)
    assertRunawayDeny(agentGate(main, 'joint-main'))
    await assertNothingStored(main, 0, 0, 'in no-collection mode')
  })

  test('leg 1b — the image cache-guard warns under the switch', async () => {
    const transcript = path.join(main.home, 'transcript.jsonl')
    fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { usage: { input_tokens: 10, cache_read_input_tokens: 120_000, cache_creation_input_tokens: 0 } } }) + '\n')
    const run = cli(main, ['gate'], { input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'joint-img', transcript_path: transcript, cwd: main.home, tool_name: 'Read', tool_input: { file_path: path.join(main.home, 'shot.png') } }) })
    assert.strictEqual(run.code, 0)
    assert.ok(run.stdout.includes('[agentlens cache-guard]') && run.stdout.includes('shot.png'), `cache-guard warn expected: ${run.stdout}`)
  })

  test('leg 2 — env half only (AGENTLENS_DISABLED=1, no file): collection off, which only the CLI flag can cause', async () => {
    const leg = await makeLeg('env'); legs.push(leg)
    const start = cli(leg, ['server', 'start'], { extra: { AGENTLENS_DISABLED: '1' } })
    assert.strictEqual(start.code, 0, start.stderr + start.stdout)
    const s = await waitStats(leg, () => true, 60_000)
    assert.ok(!fs.existsSync(path.join(leg.data, 'DISABLED')))
    assert.strictEqual(s?.collection, 'off', 'alcore never reads AGENTLENS_DISABLED: only --no-collection can put it in the mode')
    const stop = cli(leg, ['server', 'stop'], { extra: { AGENTLENS_DISABLED: '1' } })
    assert.strictEqual(stop.code, 0, stop.stderr)
  })

  test('leg 3 — revive-driven: arm with the disable verb, start nothing, one hook event revives a no-collection server; 8 starts then DENY', async () => {
    const leg = await makeLeg('revive'); legs.push(leg)
    const off = cli(leg, ['disable', 'joint test'])
    assert.ok(off.code === 0 || off.code === 1, `disable: ${off.code} ${off.stderr}${off.stdout}`)
    assert.ok(fs.existsSync(path.join(leg.data, 'DISABLED')))
    assert.strictEqual(await stats(leg), null, 'nothing runs before the hook')
    subagentStarts(leg, 'joint-revive', 1)
    // The failed POST fires a detached `server revive`; the crash-loop backoff could delay it, hence minutes.
    const s = await waitStats(leg, () => true, 4 * 60_000)
    assert.ok(s !== null, 'the hook revived a server')
    assert.strictEqual(s?.collection, 'off')
    assert.strictEqual(s?.startedBy, 'hook-revive')
    subagentStarts(leg, 'joint-revive', 8)
    assertRunawayDeny(agentGate(leg, 'joint-revive'))
    const stop = cli(leg, ['server', 'stop'])
    assert.strictEqual(stop.code, 0, stop.stderr)
  })

  test('leg 4 — enable from the leg-1 file-only state: the server restarts collecting, and the leg-1 absence reads now see a hook event and a span', async () => {
    const before = await stats(main)
    assert.strictEqual(before?.collection, 'off')
    const on = cli(main, ['enable'])
    assert.strictEqual(on.code, 0, on.stdout + on.stderr)
    const s = await waitStats(main, x => x.collection === 'on', 60_000)
    assert.ok(s !== null, `collection on expected after enable: ${on.stdout}`)
    assert.notStrictEqual(s?.pid, before?.pid, 'a new server process')
    subagentStarts(main, 'joint-main-on', 1)
    assert.strictEqual(await postJson(main.ports.otlp, '/v1/traces', span('joint-leg4')), 200)
    const seen = await waitStats(main, x => spansInMemory(x) >= 1, CONTROL_WINDOW_MS)
    assert.ok(seen !== null, 'the span read sees a present span (positive control)')
    // Wait-looped like the span read: the server writes the hook-events file asynchronously after the POST.
    const deadline = Date.now() + CONTROL_WINDOW_MS
    while (hookEventLines(main) < 1 && Date.now() < deadline) await sleep(250)
    assert.ok(hookEventLines(main) >= 1, 'the hook-events read sees a present event (positive control)')
  })

  test('leg 5 — supervisor-owned enable: the child restarts collecting, still under the same live supervisor, one alcore only', async () => {
    const stop = cli(main, ['server', 'stop'])
    assert.strictEqual(stop.code, 0, stop.stderr)
    assert.deepStrictEqual(alcoresFor(main.data), [], 'no alcore names the test data dir before the supervisor starts')
    fs.writeFileSync(path.join(main.data, 'DISABLED'), 'joint test leg 5\n')
    supervisor = cp.spawn(process.execPath, [CLI, 'server', 'start', '--supervise'], { env: legEnv(main), stdio: ['ignore', 'ignore', 'ignore'] })
    const supPid = supervisor.pid!
    const s = await waitStats(main, x => x.collection === 'off', 60_000)
    assert.strictEqual(s?.startedBy, 'supervisor')
    const t0 = Date.now()
    const on = cli(main, ['enable'], { timeoutMs: 120_000 })
    assert.strictEqual(on.code, 0, on.stdout + on.stderr)
    const after = await waitStats(main, x => x.collection === 'on', Math.max(1_000, 35_000 - (Date.now() - t0)))
    assert.ok(after !== null, `collection on within 35 s expected: ${on.stdout}`)
    assert.strictEqual(after?.startedBy, 'supervisor')
    assert.strictEqual(supervisor.exitCode, null, 'the supervisor is alive')
    assert.doesNotThrow(() => process.kill(supPid, 0))
    assert.strictEqual(alcoresFor(main.data).length, 1, 'exactly one alcore names the test data dir')
  })

  test('leg 6 — the owner main path: a COLLECTING server, then the disable verb stops it, one hook revives it in no-collection mode, nothing new stored', async () => {
    const leg = await makeLeg('collect'); legs.push(leg)
    const start = cli(leg, ['server', 'start'])
    assert.strictEqual(start.code, 0, start.stderr + start.stdout)
    const s = await waitStats(leg, () => true, 60_000)
    assert.strictEqual(s?.collection, 'on', 'no DISABLED file and no env half: the server collects')
    // Control: the same two reads leg 1 relies on DO see a span and a hook event when collecting.
    subagentStarts(leg, 'joint-collect-on', 1)
    assert.strictEqual(await postJson(leg.ports.otlp, '/v1/traces', span('joint-leg6-on')), 200)
    assert.ok(await waitStats(leg, x => spansInMemory(x) >= 1, CONTROL_WINDOW_MS) !== null, 'control: a span is stored while collecting')
    const deadline = Date.now() + CONTROL_WINDOW_MS
    while (hookEventLines(leg) < 1 && Date.now() < deadline) await sleep(250)
    assert.ok(hookEventLines(leg) >= 1, 'control: a hook event is stored while collecting')
    const off = cli(leg, ['disable', 'joint test leg 6'])
    // Exactly 0: in a throwaway home the raw-body key is absent, so a 1 (EXIT.ABORT) could only be a WARNING.
    assert.strictEqual(off.code, 0, `disable: ${off.code} ${off.stderr}${off.stdout}`)
    assert.ok(off.stdout.includes('running server stopped'), `disable must stop the collecting server: ${off.stdout}`)
    assert.strictEqual(await stats(leg), null, 'the collecting server is gone after disable')
    assert.deepStrictEqual(alcoresFor(leg.data), [], 'no alcore names the leg data dir after disable')
    subagentStarts(leg, 'joint-collect-off', 1)
    const revived = await waitStats(leg, () => true, 4 * 60_000)
    assert.ok(revived !== null, 'one hook event revived a server')
    assert.strictEqual(revived?.collection, 'off')
    assert.strictEqual(revived?.startedBy, 'hook-revive')
    // The leg-1 absence reads, measured against the state right after the revive.
    const events0 = hookEventLines(leg)
    const spans0 = spansInMemory(revived)
    subagentStarts(leg, 'joint-collect-off', 1)
    assert.strictEqual(await postJson(leg.ports.otlp, '/v1/traces', span('joint-leg6-off')), 200, 'OTLP is answered (and dropped)')
    await assertNothingStored(leg, events0, spans0, 'after disable')
    const stop = cli(leg, ['server', 'stop'])
    assert.strictEqual(stop.code, 0, stop.stderr)
  })

  test('leg 7 — the dashboard right-panel burn-gate switch works under the switch: OFF allows the launch, ON denies it (RUNAWAY_FANOUT)', async () => {
    const leg = await makeLeg('panel'); legs.push(leg)
    fs.writeFileSync(path.join(leg.data, 'DISABLED'), 'joint test leg 7\n')
    const start = cli(leg, ['server', 'start'])
    assert.strictEqual(start.code, 0, start.stderr + start.stdout)
    const s = await waitStats(leg, () => true, 60_000)
    assert.strictEqual(s?.collection, 'off')
    // The exact request the right panel sends (media/src/tabs/Alerts.tsx patch(): POST /api/hook-config, one key).
    assert.strictEqual(await postJson(leg.ports.ui, '/api/hook-config', { gateEnabled: false }), 200, 'panel: burn gate OFF')
    // B8: Burn gate OFF must NOT silence the image cache-guard (its own switch, cacheGuardEnabled, is still on).
    // Same `gate` CLI path as leg 1b, against the real alcore, under the switch.
    const imgTranscript = path.join(leg.home, 'transcript.jsonl')
    fs.writeFileSync(imgTranscript, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { usage: { input_tokens: 10, cache_read_input_tokens: 120_000, cache_creation_input_tokens: 0 } } }) + '\n')
    const img = cli(leg, ['gate'], { input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'joint-panel-img', transcript_path: imgTranscript, cwd: leg.home, tool_name: 'Read', tool_input: { file_path: path.join(leg.home, 'shot.png') } }) })
    assert.strictEqual(img.code, 0)
    assert.ok(img.stdout.includes('[agentlens cache-guard]') && img.stdout.includes('shot.png'), `gate OFF from the panel: the image guard must still warn (IMG_RESIDENT), got: ${img.stdout}`)
    subagentStarts(leg, 'joint-panel', 8)
    const allowed = agentGate(leg, 'joint-panel')
    assert.strictEqual(allowed.run.code, 0, 'the gate always exits 0')
    const hso = allowed.out?.hookSpecificOutput as { permissionDecision?: unknown } | undefined
    assert.notStrictEqual(hso?.permissionDecision, 'deny', `gate OFF from the panel: the launch must be allowed, got: ${allowed.run.stdout}`)
    assert.strictEqual(await postJson(leg.ports.ui, '/api/hook-config', { gateEnabled: true }), 200, 'panel: burn gate ON')
    assertRunawayDeny(agentGate(leg, 'joint-panel'))
    const stop = cli(leg, ['server', 'stop'])
    assert.strictEqual(stop.code, 0, stop.stderr)
  })

  test('leg 8 — the FRESH-INSTALL setup path (empty HOME, no server): under a DISABLED file `setup --yes` exits 0 with its self-test PASS, the server reports collection off, nothing stored', async function () {
    // What this covers: a first install into an EMPTY throwaway HOME with no server running. It is NOT this machine's
    // deploy path, which starts from an existing settings.json, a populated data dir and an older bin-native alcore.
    // Every write setup makes lands in the leg's HOME (settings.json, skills, rules, agents) or its data dir, EXCEPT
    // three conditional actions outside it. Their safety must not rest on this machine's state, so each condition is
    // checked here with setup's OWN predicate, and the leg skips (naming it) if any holds:
    //  - spool migration (setup.ts detectLegacySpoolWith / realSpoolDeps): /Volumes/AgentLensSpool/otel-bodies is a
    //    directory, OR <HOME>/Library/LaunchAgents/com.agentlens.spool.plist exists, OR <HOME>/.claude/settings.json
    //    env.OTEL_LOG_RAW_API_BODIES is the spool value — then it runs hdiutil detach and launchctl bootout;
    //  - old-package (setup.ts 'old-package' step): resolveOnPath('agentlens-dashboard', PATH) finds an executable
    //    file — then it runs `npm rm -g agentlens-dashboard` on the GLOBAL npm tree;
    //  - otel-env managed overwrite (telemetryConfig.ts managedSettingsPaths + managed-settings.d drop-ins): a foreign
    //    value in one of those files — checked here as the directory being present at all. legEnv() does not inherit
    //    the process env, so no foreign OTEL_* key reaches setup; the loop below also strips any OTEL_* key that
    //    `extra` passes.
    // The registered hooks run `agentlenspro` from PATH, so a shim in the leg dir puts THIS tree's bundle first —
    // otherwise the hook verify would exercise whatever agentlenspro the machine has installed.
    const leg = await makeLeg('setup'); legs.push(leg)
    fs.writeFileSync(path.join(leg.data, 'DISABLED'), 'joint test leg 8\n')
    const shimDir = path.join(path.dirname(leg.home), 'bin')
    fs.mkdirSync(shimDir, { recursive: true })
    fs.writeFileSync(path.join(shimDir, 'agentlenspro'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} "$@"\n`, { mode: 0o755 })
    const env = legEnv(leg, { PATH: `${shimDir}:${process.env.PATH ?? '/usr/bin:/bin'}` })
    for (const k of Object.keys(env)) if (k.startsWith('OTEL_')) delete env[k]
    const isDir = (p: string): boolean => { try { return fs.statSync(p).isDirectory() } catch { return false } }
    const onPath = (name: string): string | null => {
      for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
        const p = path.join(dir, name)
        try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p } catch { /* keep scanning */ }
      }
      return null
    }
    // Preconditions the hazards rely on: setup resolves os.homedir() (the spool plist path) and its settings path from
    // HOME, so setup must run with the leg HOME and that HOME must be empty. A spool plist or a pre-written settings.json
    // there would trigger the spool migration. These replace two hazard entries that read a just-created HOME, which
    // could never fire.
    assert.strictEqual(env.HOME, leg.home, 'setup must run with the leg HOME')
    assert.deepStrictEqual(fs.readdirSync(leg.home), [], `leg HOME ${leg.home} must be empty before setup`)
    const hazards = [
      isDir('/Volumes/AgentLensSpool/otel-bodies') && '/Volumes/AgentLensSpool/otel-bodies is mounted (spool migration would hdiutil detach it)',
      onPath('agentlens-dashboard') && `agentlens-dashboard resolves on PATH at ${onPath('agentlens-dashboard')} (npm rm -g)`,
      isDir('/Library/Application Support/ClaudeCode') && '/Library/Application Support/ClaudeCode exists (managed-settings overwrite)',
      isDir('/etc/claude-code') && '/etc/claude-code exists (managed-settings overwrite)',
    ].filter((h): h is string => typeof h === 'string')
    // mocha's this.skip() takes no message (and throws its own Pending), so the reason is printed first.
    if (hazards.length > 0) { console.log(`    leg 8 SKIPPED — setup would act outside the throwaway HOME: ${hazards.join('; ')}`); this.skip() }
    const r = cp.spawnSync(process.execPath, [CLI, 'setup', '--yes', '--json'], { env, input: '', encoding: 'utf8', timeout: 240_000 })
    const run: Run = { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
    const at = run.stdout.lastIndexOf('{\n  "dryRun"')
    const out = at >= 0 ? JSON.parse(run.stdout.slice(at)) as { exitCode: number; steps: { step: string; verify: string; detail?: string }[] } : null
    assert.ok(out !== null, `setup --json printed no outcome: ${run.stdout}${run.stderr}`)
    const failed = out.steps.filter(s => s.verify === 'FAIL')
    assert.strictEqual(run.code, 0, `setup exit ${run.code}; failed steps: ${JSON.stringify(failed)}`)
    assert.strictEqual(out.exitCode, 0)
    assert.strictEqual(out.steps.find(s => s.step === 'final-test')?.verify, 'PASS', `self-test: ${JSON.stringify(out.steps.find(s => s.step === 'final-test'))}`)
    const s = await stats(leg)
    assert.strictEqual(s?.collection, 'off', 'setup started the server in no-collection mode')
    // Setup's own self-test already posted a span and hook events; none may be stored, nor any sent after it.
    subagentStarts(leg, 'joint-setup', 1)
    assert.strictEqual(await postJson(leg.ports.otlp, '/v1/traces', span('joint-leg8')), 200, 'OTLP is answered (and dropped)')
    await assertNothingStored(leg, 0, 0, 'after setup under the switch')
    const stop = cli(leg, ['server', 'stop'])
    assert.strictEqual(stop.code, 0, stop.stderr)
  })

  test('leg 9 — TRDD-RBBEX59R d3: under the armed switch the status line POSTs and the real no-collection server STORES the sample', async () => {
    const leg = await makeLeg('statusline'); legs.push(leg)
    fs.writeFileSync(path.join(leg.data, 'DISABLED'), 'joint test leg 9\n')
    const start = cli(leg, ['server', 'start'])
    assert.strictEqual(start.code, 0, start.stderr + start.stdout)
    const s = await waitStats(leg, () => true, 60_000)
    assert.strictEqual(s?.collection, 'off')
    assert.strictEqual((s?.statusline as { receivedSinceBoot?: unknown } | undefined)?.receivedSinceBoot, 0, 'nothing received before the sample')
    // captureStatusline runs IN this process (current source, not the bundle) against the leg's UI port; the env is
    // restored in the finally. setup.js pins AGENTLENS_NO_REVIVE=1, so a failed POST could not spawn a server.
    const savedUrl = process.env.AGENTLENS_UI_URL
    process.env.AGENTLENS_UI_URL = `http://127.0.0.1:${leg.ports.ui}`
    try {
      await captureStatusline(Buffer.from(JSON.stringify({ session_id: 'joint-statusline', cost: { total_cost_usd: 1 } })))
    } finally {
      if (savedUrl === undefined) delete process.env.AGENTLENS_UI_URL; else process.env.AGENTLENS_UI_URL = savedUrl
    }
    const after = await waitStats(leg, x => (x.statusline as { receivedSinceBoot?: unknown } | undefined)?.receivedSinceBoot === 1, CONTROL_WINDOW_MS)
    assert.ok(after !== null, 'the no-collection server stored the status-line sample (statusline.receivedSinceBoot == 1)')
    const stop = cli(leg, ['server', 'stop'])
    assert.strictEqual(stop.code, 0, stop.stderr)
    // Storage read-back: the counter alone only proves the handler ran. A graceful stop flushes the buffered sample to the
    // statusline WAL (alcore.rs, st.statusline.flush) and every read unions the WALs, so the row is read after the stop.
    const rows = await queryStatusline(path.join(leg.data, 'statusline'), 'main', 'SELECT session_id FROM samples')
    assert.ok(rows !== null, 'the store holds a statusline WAL for the sample')
    assert.deepStrictEqual(rows.map(r => r.session_id), ['joint-statusline'], 'the stored sample is the one POSTed')
  })

  test('leg 10 — TRDD-VS1FCUMU: with NO server the bundled status-line hook stores the sample on disk, statusline-history reads it, and the real alcore statusline-seal turns it into a part', async () => {
    assert.ok(fs.readFileSync(CLI, 'utf8').includes('wal-cli.ndjson'), 'the bundle predates TRDD-VS1FCUMU — a failed esbuild leaves the stale bundle')
    const leg = await makeLeg('sl-noserver'); legs.push(leg)
    fs.writeFileSync(path.join(leg.data, 'DISABLED'), 'joint test leg 10\n')
    // No server is started, and AGENTLENS_NO_REVIVE=1 keeps the hook from starting one (or the sealer).
    const hook = cli(leg, ['statusline'], { input: JSON.stringify({ session_id: 'joint-noserver', cost: { total_cost_usd: 2 } }), extra: { AGENTLENS_NO_REVIVE: '1' }, timeoutMs: 60_000 })
    assert.strictEqual(hook.code, 0, hook.stderr + hook.stdout)
    assert.deepStrictEqual(alcoresFor(leg.data), [], 'no alcore runs on this data dir: the sample was stored by the hook alone')
    // The day directory is read back, not computed: the hook stamps its own clock and a run can cross UTC midnight.
    const mainDir = path.join(leg.data, 'statusline', 'main')
    const days = fs.readdirSync(mainDir)
    assert.strictEqual(days.length, 1, `one day partition, got ${JSON.stringify(days)}`)
    const dayDir = path.join(mainDir, days[0])
    assert.deepStrictEqual(fs.readdirSync(dayDir), ['wal-cli.ndjson'], 'the hook wrote the write-ahead file and nothing else')
    assert.strictEqual(fs.readFileSync(path.join(dayDir, 'wal-cli.ndjson'), 'utf8').trim().split('\n').length, 1, 'one line for one sample')
    // The CLI reads the store off disk, still with no server. The table prints the first 8 characters of the session id.
    const hist = cli(leg, ['statusline-history', 'sessions'], { extra: { AGENTLENS_NO_REVIVE: '1' }, timeoutMs: 120_000 })
    assert.strictEqual(hist.code, 0, hist.stderr + hist.stdout)
    assert.ok(hist.stdout.includes('joint-no'), `statusline-history shows the session with no server: ${hist.stdout}${hist.stderr}`)
    // The real binary compacts it. The byte threshold is lowered because today's file is a few hundred bytes.
    const seal = cp.spawnSync(ALCORE, ['statusline-seal', '--data-dir', leg.data], { env: { ...legEnv(leg), AGENTLENS_STATUSLINE_CLI_SEAL_BYTES: '1' }, encoding: 'utf8', timeout: 120_000 })
    assert.strictEqual(seal.status, 0, seal.stderr)
    assert.ok(seal.stdout.includes('sealed 1 WAL'), seal.stdout + seal.stderr)
    const after = fs.readdirSync(dayDir)
    assert.strictEqual(after.filter(f => f.startsWith('part-') && f.endsWith('.parquet')).length, 1, `one part, got ${JSON.stringify(after)}`)
    assert.strictEqual(after.filter(f => f.startsWith('wal-')).length, 0, `no write-ahead file left, got ${JSON.stringify(after)}`)
    assert.deepStrictEqual(alcoresFor(leg.data), [], 'the sealer exited and no server was started')
    const rows = await queryStatusline(path.join(leg.data, 'statusline'), 'main', 'SELECT session_id, cost_total_cost_usd AS cost FROM samples')
    assert.ok(rows !== null, 'the part is readable')
    assert.deepStrictEqual(rows.map(r => [r.session_id, Number(r.cost)]), [['joint-noserver', 2]], 'the sealed row is the sample the hook stored')
  })

  test('leg 11 — TRDD-RBBEX59R box 2: a BARE launch (no verb) under a DISABLED file runs the foreground server in no-collection mode', async () => {
    const leg = await makeLeg('bare'); legs.push(leg)
    fs.writeFileSync(path.join(leg.data, 'DISABLED'), 'joint test leg 11\n')
    // No verb: standalone/cli.ts runServerForeground spawns alcore with alcoreServeArgs() and stays in the foreground.
    const bare = cp.spawn(process.execPath, [CLI], { env: legEnv(leg), stdio: 'ignore' })
    let stop: Run = { code: null, stdout: '', stderr: 'server stop never ran' }
    try {
      const s = await waitStats(leg, () => true, 60_000)
      assert.ok(s !== null, 'the bare launch answers /api/server-stats within 60 s')
      assert.strictEqual(s.collection, 'off', 'the bare launch runs in no-collection mode under the DISABLED file')
      // Box 2 is a claim about the argv: alcoreServeArgs pushed --no-collection for this data dir.
      const lines = psLines().filter(l => alcoreDataDir(l) === leg.data)
      assert.strictEqual(lines.length, 1, `one alcore on the leg data dir, got ${JSON.stringify(lines)}`)
      assert.ok(lines[0].trim().split(/\s+/).includes('--no-collection'), `--no-collection is in the argv: ${lines[0]}`)
      assert.strictEqual(await postJson(leg.ports.otlp, '/v1/traces', span('joint-leg11')), 200, 'OTLP is answered (and dropped)')
      await assertNothingStored(leg, 0, 0, 'after a bare launch in no-collection mode')
    } finally {
      stop = cli(leg, ['server', 'stop'], { timeoutMs: 60_000 })
      if (bare.exitCode === null) {
        await new Promise<void>(r => { const t = setTimeout(() => { bare.kill('SIGTERM'); r() }, 15_000); bare.once('exit', () => { clearTimeout(t); r() }) })
      }
    }
    assert.strictEqual(stop.code, 0, stop.stderr + stop.stdout)
    assert.deepStrictEqual(alcoresFor(leg.data), [], 'the stop left no alcore on the leg data dir')
  })
})
