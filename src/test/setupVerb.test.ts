import * as assert from 'assert'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import { spawn } from 'child_process'
import type { AddressInfo } from 'net'
import { runSetup, runSetupCli, SetupOutcome } from '../cli/setup'
import { GATE_CMD, GATE_MATCHER, HOOK_CMD, HOOK_EVENTS } from '../cli/hookInstall'
import { ownedTelemetryKeys } from '../telemetryConfig'

// ── `agentlenspro setup` — real-fs converge/verify tests (TRDD-7284WCW7) ───────────────────
// Everything here is REAL: a temp HOME, ephemeral ports, the real safe_config_edit.py
// transaction, the real built standalone/server.js booted as a child, the real built
// standalone/cli.js executed through a PATH shim as `agentlenspro hook`/`gate`. No mocks of
// anything under test. The resident server (3000/4316/4318) and the real ~/.agentlens /
// ~/.claude are never touched.

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')

interface Fixture {
  home: string
  dataDir: string
  settingsPath: string
  skillsDir: string
  pathEnv: string
  cleanup: () => void
}

/** A temp HOME with an `agentlenspro` PATH shim that execs the REAL built CLI. */
function makeFixture(): Fixture {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'al-setup-'))
  const binDir = path.join(home, 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  const shim = path.join(binDir, 'agentlenspro')
  // The shim makes `agentlenspro …` resolve on PATH to THIS checkout's bundle — real PATH
  // resolution, real executable; only the install location is a fixture.
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${path.join(REPO_ROOT, 'standalone', 'cli.js')}" "$@"\n`)
  fs.chmodSync(shim, 0o755)
  return {
    home,
    dataDir: path.join(home, '.agentlens'),
    settingsPath: path.join(home, '.claude', 'settings.json'),
    skillsDir: path.join(home, '.claude', 'skills'),
    pathEnv: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
  }
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

function setupOpts(f: Fixture, ports: { ui: number; mcp: number; otlp: number }, extra: Record<string, unknown> = {}) {
  return {
    yes: true,
    home: f.home,
    dataDir: f.dataDir,
    settingsPath: f.settingsPath,
    skillsDir: f.skillsDir,
    repoRoot: REPO_ROOT,
    uiPort: ports.ui,
    mcpPort: ports.mcp,
    otlpPort: ports.otlp,
    pathEnv: f.pathEnv,
    log: () => { /* keep the suite output clean; the table is asserted structurally */ },
    ...extra,
  }
}

function readSettings(f: Fixture): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(f.settingsPath, 'utf8')) as Record<string, unknown>
}

function stepOf(o: SetupOutcome, name: string) {
  const s = o.steps.find(x => x.step === name)
  if (!s) assert.fail(`step ${name} missing from the result table`)
  return s
}

/** Structural snapshot of a tree: sorted relative paths + content sha256 (mtime-free). */
function treeSnapshot(root: string): string {
  const entries: string[] = []
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name)
      const st = fs.lstatSync(p)
      if (st.isDirectory()) { entries.push(`d ${path.relative(root, p)}`); walk(p) }
      else entries.push(`f ${path.relative(root, p)} ${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`)
    }
  }
  walk(root)
  return entries.join('\n')
}

function killPid(pid: number | null): void {
  if (!pid) return
  try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
}

async function waitDead(pid: number | null): Promise<void> {
  if (!pid) return
  for (let i = 0; i < 40; i++) {
    try { process.kill(pid, 0) } catch { return }
    await new Promise(r => setTimeout(r, 250))
  }
  try { process.kill(pid, 'SIGKILL') } catch { /* raced to death */ }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────

suite('setup — virgin HOME full converge (real server on ephemeral ports)', () => {
  let f: Fixture
  let ports: { ui: number; mcp: number; otlp: number }
  let first: SetupOutcome
  let second: SetupOutcome

  suiteSetup(async function () {
    this.timeout(120_000)
    f = makeFixture()
    ports = { ui: await freePort(), mcp: await freePort(), otlp: await freePort() }
    first = await runSetup(setupOpts(f, ports))
    second = await runSetup(setupOpts(f, ports)) // the idempotency probe — same converged HOME
  })

  suiteTeardown(async function () {
    this.timeout(30_000)
    killPid(first?.serverPid ?? null)
    await waitDead(first?.serverPid ?? null)
    f?.cleanup()
  })

  test('first run converges a virgin HOME: every step verifies PASS, exit 0', () => {
    // The full install path — data, hooks, skill, otel, server, self-test — green in one run.
    assert.strictEqual(first.exitCode, 0, JSON.stringify(first.steps, null, 2))
    for (const s of first.steps) assert.strictEqual(s.verify, 'PASS', `${s.step}: ${s.detail}`)
    assert.ok(first.actions >= 4, `expected >=4 acting steps on a virgin HOME, got ${first.actions}`)
  })

  test('hooks land exactly once per lifecycle event as v2 command strings (independent re-parse)', () => {
    // Verification through OUR OWN JSON.parse of the file — not the installer's report.
    const hooks = (readSettings(f).hooks ?? {}) as Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; async?: boolean }> }>>
    for (const ev of HOOK_EVENTS) {
      const cmds = (hooks[ev] ?? []).flatMap(m => m.hooks.map(h => h.command)).filter(c => c === HOOK_CMD)
      assert.strictEqual(cmds.length, 1, `${ev} must carry exactly one '${HOOK_CMD}'`)
    }
    const gates = (hooks.PreToolUse ?? []).filter(m => m.matcher === GATE_MATCHER)
    assert.strictEqual(gates.length, 1, 'exactly one gate matcher on PreToolUse')
    assert.strictEqual(gates[0].hooks[0].command, GATE_CMD)
    assert.ok(!('async' in gates[0].hooks[0]), 'the gate must be SYNC — an async hook cannot deny')
  })

  test('the skill is installed byte-identical to the shipped copy', () => {
    const shipped = fs.readFileSync(path.join(REPO_ROOT, 'skills', 'agentlenspro-diagnostics', 'SKILL.md'), 'utf8')
    const installed = fs.readFileSync(path.join(f.skillsDir, 'agentlenspro-diagnostics', 'SKILL.md'), 'utf8')
    assert.strictEqual(installed, shipped)
  })

  test('every owned telemetry env key holds exactly the expected value for the fixture ports', () => {
    const env = (readSettings(f).env ?? {}) as Record<string, string>
    // capture=false: setup must NOT wire raw-body capture by default (TRDD-BKF5NZD3 — it costs
    // ~35 GB/day, so a fresh install must never turn it on behind the user's back).
    const expected = ownedTelemetryKeys(path.join(f.dataDir, 'otel-bodies'), ports.otlp, false)
    for (const [k, v] of Object.entries(expected)) assert.strictEqual(env[k], v, k)
    assert.ok(!('OTEL_LOG_RAW_API_BODIES' in env), 'a default setup must not arm raw-body capture')
  })

  test('the final self-test verified the OTLP→get_recent_sessions round-trip and the hook/gate handlers', () => {
    const st = stepOf(first, 'final-test')
    assert.strictEqual(st.verify, 'PASS', st.detail)
    assert.ok((st.detail ?? '').includes('visible via get_recent_sessions'), st.detail)
  })

  test('idempotency: the second run over a converged HOME reports ZERO actions and all-PASS', () => {
    // Idempotency is a tested property, not a hope: every converge step must detect
    // "already current" and act on nothing, while VERIFY still re-proves the state.
    assert.strictEqual(second.exitCode, 0, JSON.stringify(second.steps, null, 2))
    assert.strictEqual(second.actions, 0, JSON.stringify(second.steps, null, 2))
    for (const s of second.steps) assert.strictEqual(s.verify, 'PASS', `${s.step}: ${s.detail}`)
    assert.strictEqual(stepOf(second, 'server').action, 'none', 'the healthy server must not be restarted')
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────

/** A maimed install: corrupt forensics.db, duplicated + stale hook registrations of BOTH
 *  legacy generations, wrong + truncated telemetry env — the detection-matrix fixture. */
function maimFixture(f: Fixture): { garbage: Buffer } {
  fs.mkdirSync(f.dataDir, { recursive: true })
  const garbage = Buffer.from(`NOT A SQLITE FILE ${'x'.repeat(200)}`)
  fs.writeFileSync(path.join(f.dataDir, 'forensics.db'), garbage)
  fs.mkdirSync(path.dirname(f.settingsPath), { recursive: true })
  fs.writeFileSync(f.settingsPath, JSON.stringify({
    env: {
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:9999', // wrong port
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      // …every other owned key missing (truncated wiring)
    },
    hooks: {
      Stop: [
        { hooks: [{ type: 'command', command: 'bash /old/prefix/spy-agentlens.sh', timeout: 2, async: true }] }, // v0
        { hooks: [{ type: 'command', command: 'agentlenspro-hook', timeout: 2, async: true }] },                  // v1
      ],
      PreToolUse: [
        // DUPLICATED v1 gate entries — converge must collapse to exactly one v2 entry.
        { matcher: '^(Task|Agent|Workflow|SendMessage)$', hooks: [{ type: 'command', command: 'agentlenspro-gate', timeout: 3 }] },
        { matcher: '^(Task|Agent|Workflow|SendMessage)$', hooks: [{ type: 'command', command: 'agentlenspro-gate', timeout: 3 }] },
      ],
      Notification: [
        { hooks: [{ type: 'command', command: 'bash /other/janitor-hook.sh', timeout: 5 }] }, // foreign — must survive
      ],
    },
  }, null, 2))
  return { garbage }
}

suite('setup — repair matrix (broken fixtures, real converge)', () => {
  let f: Fixture
  let ports: { ui: number; mcp: number; otlp: number }
  let garbage: Buffer
  let drySnapshot: { before: string; after: string; outcome: SetupOutcome }
  let repaired: SetupOutcome

  suiteSetup(async function () {
    this.timeout(120_000)
    f = makeFixture()
    ports = { ui: await freePort(), mcp: await freePort(), otlp: await freePort() }
    garbage = maimFixture(f).garbage

    // Dry-run FIRST, over the broken state: it must plan repairs and mutate NOTHING.
    const before = treeSnapshot(f.home)
    const outcome = await runSetup(setupOpts(f, ports, { dryRun: true }))
    drySnapshot = { before, after: treeSnapshot(f.home), outcome }

    // Then the real repair run.
    repaired = await runSetup(setupOpts(f, ports))
  })

  suiteTeardown(async function () {
    this.timeout(30_000)
    killPid(repaired?.serverPid ?? null)
    await waitDead(repaired?.serverPid ?? null)
    f?.cleanup()
  })

  test('dry-run over a maimed install exits 0, plans the repairs, and leaves the tree byte-identical', () => {
    assert.strictEqual(drySnapshot.outcome.exitCode, 0)
    assert.strictEqual(drySnapshot.outcome.actions, 0, 'dry-run must act on nothing')
    assert.strictEqual(drySnapshot.after, drySnapshot.before, 'dry-run must not change a single byte under HOME')
    assert.ok(stepOf(drySnapshot.outcome, 'hooks').action.startsWith('would:'), 'the plan must announce the hooks converge')
    assert.ok(stepOf(drySnapshot.outcome, 'otel-env').action.startsWith('would:'), 'the plan must announce the env repair')
  })

  test('corrupt forensics.db is backed up aside as .corrupt-<ts> with its bytes preserved — never wiped', () => {
    const st = stepOf(repaired, 'data-store')
    assert.strictEqual(st.verify, 'PASS', st.detail)
    const backups = fs.readdirSync(f.dataDir).filter(n => n.startsWith('forensics.db.corrupt-'))
    assert.strictEqual(backups.length, 1, `expected one .corrupt-<ts> backup, found: ${backups.join(', ')}`)
    assert.ok(fs.readFileSync(path.join(f.dataDir, backups[0])).equals(garbage), 'the corrupt bytes must be preserved verbatim')
  })

  test('duplicated + stale registrations (v0 spy path, v1 PATH bins, dup gate) converge to exactly one v2 entry each', () => {
    const hooks = (readSettings(f).hooks ?? {}) as Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>
    const stopCmds = (hooks.Stop ?? []).flatMap(m => m.hooks.map(h => h.command))
    assert.deepStrictEqual(stopCmds, [HOOK_CMD], 'Stop must carry ONLY the single v2 forwarder')
    const gateCmds = (hooks.PreToolUse ?? []).filter(m => m.matcher === GATE_MATCHER).flatMap(m => m.hooks.map(h => h.command))
    assert.deepStrictEqual(gateCmds.filter(c => c === GATE_CMD), [GATE_CMD], 'the duplicated gate entries must collapse to one')
    const foreign = (hooks.Notification ?? []).flatMap(m => m.hooks.map(h => h.command))
    assert.ok(foreign.includes('bash /other/janitor-hook.sh'), 'a foreign tool\'s hook must survive the repair untouched')
  })

  test('wrong + truncated telemetry env is repaired to the full expected key set', () => {
    const env = (readSettings(f).env ?? {}) as Record<string, string>
    const expected = ownedTelemetryKeys(path.join(f.dataDir, 'otel-bodies'), ports.otlp, false)
    for (const [k, v] of Object.entries(expected)) assert.strictEqual(env[k], v, k)
    assert.strictEqual(stepOf(repaired, 'otel-env').verify, 'PASS')
  })

  test('the repair run ends green: exit 0, final self-test PASS against the freshly started server', () => {
    assert.strictEqual(repaired.exitCode, 0, JSON.stringify(repaired.steps, null, 2))
    assert.strictEqual(stepOf(repaired, 'final-test').verify, 'PASS', stepOf(repaired, 'final-test').detail)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────

suite('setup — fail-fast refusals (no silent continue)', () => {
  test('a truncated settings.json is REFUSED: non-zero exit, file byte-identical, later steps not run', async function () {
    // Refuse-unparseable is the safeConfigEdit stance: never "start fresh" over user config.
    this.timeout(60_000)
    const f = makeFixture()
    try {
      fs.mkdirSync(path.dirname(f.settingsPath), { recursive: true })
      const truncated = '{"env": {"OTEL_METRICS_EXPORTER": "otlp", "hooks": {'  // cut mid-file
      fs.writeFileSync(f.settingsPath, truncated)
      const ports = { ui: await freePort(), mcp: await freePort(), otlp: await freePort() }
      const outcome = await runSetup(setupOpts(f, ports))
      assert.strictEqual(outcome.exitCode, 1, 'must exit non-zero')
      assert.strictEqual(stepOf(outcome, 'hooks').verify, 'FAIL')
      assert.strictEqual(fs.readFileSync(f.settingsPath, 'utf8'), truncated, 'the unparseable file must not be touched')
      for (const name of ['skill', 'otel-env', 'old-package', 'server', 'final-test']) {
        assert.strictEqual(stepOf(outcome, name).action, 'not run', `${name} must not run after the failure (fail-fast)`)
      }
      assert.strictEqual(outcome.serverPid, null, 'no server may be started after a failed step')
    } finally { f.cleanup() }
  })

  test('a package with the shipped skill missing FAILS the skill step and stops — no fallback install', async function () {
    // VERIFY/ACT failures must propagate: the run stops at the broken step, exit non-zero.
    this.timeout(60_000)
    const f = makeFixture()
    try {
      const bogusRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'al-bogus-root-'))
      // A manifest with a real engines.node, so the run reaches the SKILL step — which is what
      // this test is about. Without one the ENVIRONMENT step now fails first (the Node floor is
      // read from engines.node and is never guessed), and the skill step would never run.
      fs.writeFileSync(path.join(bogusRoot, 'package.json'), JSON.stringify({ engines: { node: '>=20.9.0' } }))
      try {
        const ports = { ui: await freePort(), mcp: await freePort(), otlp: await freePort() }
        const outcome = await runSetup(setupOpts(f, ports, { repoRoot: bogusRoot }))
        assert.strictEqual(outcome.exitCode, 1)
        assert.strictEqual(stepOf(outcome, 'skill').verify, 'FAIL')
        for (const name of ['otel-env', 'old-package', 'server', 'final-test']) {
          assert.strictEqual(stepOf(outcome, name).action, 'not run', `${name} must not run after the skill failure`)
        }
      } finally { fs.rmSync(bogusRoot, { recursive: true, force: true }) }
    } finally { f.cleanup() }
  })

  test('setup rejects unknown flags with a usage error instead of guessing', async () => {
    await assert.rejects(() => runSetupCli(['--frobnicate']), /setup does not understand: --frobnicate/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────

suite('setup — CLI wiring (spawned single executable)', () => {
  test('`agentlenspro setup --dry-run` through the real CLI honors env overrides, prints the table, exits 0', async function () {
    // The spawn-level proof that the verb is reachable through the ONE published bin.
    this.timeout(60_000)
    const f = makeFixture()
    try {
      const ports = { ui: await freePort(), mcp: await freePort(), otlp: await freePort() }
      const env = { ...process.env } as NodeJS.ProcessEnv
      for (const k of Object.keys(env)) if (k.startsWith('AGENTLENS_')) delete env[k]
      delete env.DATA_DIR
      Object.assign(env, {
        HOME: f.home, USERPROFILE: f.home, PATH: f.pathEnv,
        UI_PORT: String(ports.ui), MCP_PORT: String(ports.mcp), OTLP_PORT: String(ports.otlp),
      })
      const r = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, [path.join(REPO_ROOT, 'standalone', 'cli.js'), 'setup', '--dry-run'], { env })
        let stdout = ''; let stderr = ''
        child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
        child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
        child.on('close', (code) => resolve({ code, stdout, stderr }))
      })
      assert.strictEqual(r.code, 0, r.stderr)
      assert.ok(r.stdout.includes('┏'), 'the unicode result table must be printed')
      assert.ok(r.stdout.includes('nothing was changed'), r.stdout)
      assert.deepStrictEqual(fs.readdirSync(f.home), ['bin'], 'dry-run must create nothing under HOME')
    } finally { f.cleanup() }
  })
})

suite('setup — server probe distinguishes DOWN from UNRESPONSIVE (single-owner guard safety)', () => {
  // Measured live: `setup --dry-run` printed "not running" against a server that `server status`
  // showed RUNNING pid 55573 — its stats answer outran the 5s HTTP window while GC-thrashing at
  // 1.9GB rss. The real-run remedy for "not running" is SPAWNING, which slams into the
  // single-owner data-dir guard. An alive pid in <dataDir>/server.pid must therefore read as
  // "unresponsive → restart", never "absent → start".

  test('alive pidfile + no HTTP answer ⇒ unresponsive + would-restart (dry-run)', async function () {
    this.timeout(60_000)
    const f = makeFixture()
    try {
      fs.mkdirSync(f.dataDir, { recursive: true })
      // process.pid is alive by construction, and no server listens on the ephemeral port.
      fs.writeFileSync(path.join(f.dataDir, 'server.pid'), String(process.pid))
      const ports = { ui: await freePort(), mcp: await freePort(), otlp: await freePort() }
      const o = await runSetup(setupOpts(f, ports, { dryRun: true }))
      const s = stepOf(o, 'server')
      assert.match(s.found, /unresponsive \(pid \d+ alive/, `found was: ${s.found}`)
      assert.strictEqual(s.action, 'would: graceful restart from this install',
        'an alive owner must be restarted, never started-over (single-owner guard)')
    } finally { f.cleanup() }
  })

  test('no pidfile ⇒ genuinely not running + would-start (the regression guard)', async function () {
    this.timeout(60_000)
    const f = makeFixture()
    try {
      fs.mkdirSync(f.dataDir, { recursive: true })
      const ports = { ui: await freePort(), mcp: await freePort(), otlp: await freePort() }
      const o = await runSetup(setupOpts(f, ports, { dryRun: true }))
      const s = stepOf(o, 'server')
      assert.strictEqual(s.found, 'not running')
      assert.strictEqual(s.action, 'would: start server')
    } finally { f.cleanup() }
  })

  test('a DEAD pid in the pidfile is not an owner — still would-start', async function () {
    this.timeout(60_000)
    const f = makeFixture()
    try {
      fs.mkdirSync(f.dataDir, { recursive: true })
      // A pid that is certainly dead: spawn a child that exits, then use its pid.
      const child = spawn(process.execPath, ['-e', 'process.exit(0)'])
      await new Promise<void>(r => child.on('exit', () => r()))
      fs.writeFileSync(path.join(f.dataDir, 'server.pid'), String(child.pid))
      const ports = { ui: await freePort(), mcp: await freePort(), otlp: await freePort() }
      const o = await runSetup(setupOpts(f, ports, { dryRun: true }))
      const s = stepOf(o, 'server')
      assert.strictEqual(s.found, 'not running', 'a dead pidfile owner must not block a fresh start')
      assert.strictEqual(s.action, 'would: start server')
    } finally { f.cleanup() }
  })
})
