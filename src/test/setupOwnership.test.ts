import * as assert from 'assert'
import * as fs from 'fs'
import * as http from 'http'
import * as net from 'net'
import * as os from 'os'
import * as path from 'path'
import { spawn, type ChildProcess } from 'child_process'
import type { AddressInfo } from 'net'
import { freePort } from './helpers/freePort'
import { assertNoSurvivingServer } from './helpers/noSurvivingServer'
import { startTrickleServer } from './helpers/trickleServer'
import { HTTP_TOTAL_DEADLINE_MS, httpJson, resolveCtx, runSetup, SetupOutcome, statsAreOurs } from '../cli/setup'
import { NO_REVIVE_FILE } from '../dataDir'

// ── setup adopts and signals only ITS OWN server (TRDD-V2HFI30L) ────────────────────────────────
// The bug: setup's port chooser treated ANY 200 JSON on the UI port as "our server", and the server
// step then SIGTERMed the pid that answer reported whenever its data dir differed. An isolated setup
// (a test, a second instance) on the default ports therefore killed the developer's live collector.
// Every test here is real: a real `runSetup` over a temp HOME, real HTTP servers on ephemeral ports,
// and a real decoy process (`sleep`) standing in for the server a buggy setup would SIGTERM. The
// decoy surviving is the assertion. The revive brake is set in the fixture's data dir, so no test can
// spawn a server; the default ports 3000/4316/4318 are never used.

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')

interface Fixture { home: string; dataDir: string; settingsPath: string; skillsDir: string; pathEnv: string }

/** A temp HOME with an `agentlenspro` PATH shim that execs THIS checkout's built CLI (as setupVerb.test.ts). */
function makeFixture(): Fixture {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'al-own-'))
  const binDir = path.join(home, 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  const shim = path.join(binDir, 'agentlenspro')
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${path.join(REPO_ROOT, 'standalone', 'cli.js')}" "$@"\n`)
  fs.chmodSync(shim, 0o755)
  return {
    home,
    dataDir: path.join(home, '.agentlens'),
    settingsPath: path.join(home, '.claude', 'settings.json'),
    skillsDir: path.join(home, '.claude', 'skills'),
    pathEnv: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
  }
}

function setupOpts(f: Fixture, ports: { ui: number; mcp: number; otlp: number }) {
  return {
    yes: true,
    home: f.home,
    dataDir: f.dataDir,
    settingsPath: f.settingsPath,
    skillsDir: f.skillsDir,
    repoRoot: REPO_ROOT,
    telemetryProbe: { managedSettingsPaths: [], processEnv: {} },
    uiPort: ports.ui,
    mcpPort: ports.mcp,
    otlpPort: ports.otlp,
    pathEnv: f.pathEnv,
    log: () => { /* the table is asserted structurally */ },
  }
}

/** The named step's row, which must have RUN: a step skipped because an earlier one failed means the fixture never
 *  reached the behaviour under test, and the whole table is printed so the earlier failure is visible. */
function stepOf(o: SetupOutcome, name: string) {
  const table = o.steps.map(x => `${x.step}=${x.verify} ${x.found} / ${x.detail ?? ''}`).join(' | ')
  const s = o.steps.find(x => x.step === name)
  if (!s) assert.fail(`step ${name} missing from the result table: ${table}`)
  if (s.action === 'not run') assert.fail(`step ${name} never ran (an earlier step failed): ${table}`)
  return s
}

/** An HTTP server answering GET /api/server-stats with `stats(port)` and 404 to everything else. */
async function startStatsServer(stats: (port: number) => unknown): Promise<{ port: number; close: () => Promise<void> }> {
  let port = 0
  const srv = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/server-stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(stats(port)))
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end('{}')
    }
  })
  await new Promise<void>((resolve, reject) => { srv.once('error', reject); srv.listen(0, '127.0.0.1', () => resolve()) })
  port = (srv.address() as AddressInfo).port
  return { port, close: () => new Promise<void>(done => { srv.closeAllConnections(); srv.close(() => done()) }) }
}

/** A port held by a stranger that drops every connection without answering HTTP. Not an HTTP server on purpose:
 *  setup's environment step queries the UI port only when the OTLP port answers HTTP, and keeping that probe out
 *  of this test keeps the case about the chooser's per-port question alone. */
async function startStranger(port: number): Promise<{ close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>()
  const srv = net.createServer(sock => { sockets.add(sock); sock.on('close', () => sockets.delete(sock)); sock.destroy() })
  await new Promise<void>((resolve, reject) => { srv.once('error', reject); srv.listen(port, '127.0.0.1', () => resolve()) })
  return { close: () => new Promise<void>(done => { for (const s of sockets) s.destroy(); srv.close(() => done()) }) }
}

/** A decoy process: the pid a buggy setup would SIGTERM. */
function spawnDecoy(): ChildProcess {
  return spawn('sleep', ['60'], { stdio: 'ignore' })
}

function decoyAlive(d: ChildProcess): boolean {
  if (d.exitCode !== null || d.signalCode !== null) return false
  try { process.kill(d.pid as number, 0); return true } catch { return false }
}

/** Runs `fn` with the revive brake set in the fixture's own data dir. reviveBraked() resolves its data dir from
 *  the process env, so AGENTLENS_DATA_DIR points it at the fixture for the duration, then is restored. */
async function withBrakedFixture(fn: (f: Fixture) => Promise<void>): Promise<void> {
  const f = makeFixture()
  fs.mkdirSync(f.dataDir, { recursive: true })
  fs.writeFileSync(path.join(f.dataDir, NO_REVIVE_FILE), 'setupOwnership: setup must not start a server\n')
  const saved = process.env.AGENTLENS_DATA_DIR
  process.env.AGENTLENS_DATA_DIR = f.dataDir
  try {
    await fn(f)
    assertNoSurvivingServer(f.dataDir)
  } finally {
    if (saved === undefined) delete process.env.AGENTLENS_DATA_DIR
    else process.env.AGENTLENS_DATA_DIR = saved
    fs.rmSync(f.home, { recursive: true, force: true })
  }
}

suite('setup — adopts and signals only its own server (TRDD-V2HFI30L)', () => {
  test('a server on the UI port that owns ANOTHER data dir is never signalled, and the refusal names it', async function () {
    this.timeout(120_000)
    await withBrakedFixture(async f => {
      const decoy = spawnDecoy()
      const fake = await startStatsServer(port => ({ pid: decoy.pid, dataDir: '/elsewhere/agentlens', ports: { ui: port, mcp: 1, otlp: 2 } }))
      // Pinned, so the chooser REFUSES the port rather than moving off it: the refusal is what must name the other
      // instance. (An unpinned UI port moves to a free one instead, and the step never sees the stranger.)
      const savedUi = process.env.UI_PORT
      process.env.UI_PORT = String(fake.port)
      try {
        const o = await runSetup(setupOpts(f, { ui: fake.port, mcp: await freePort(), otlp: await freePort() }))
        const s = stepOf(o, 'server')
        assert.strictEqual(s.verify, 'FAIL', `${s.found}: ${s.detail}`)
        assert.match(s.detail ?? '', /does not own/, 'the refusal must say the answering server is another instance')
        assert.match(s.detail ?? '', /AGENTLENS_DATA_DIR='\/elsewhere\/agentlens' agentlenspro server stop/, 'and how to stop it')
        assert.ok(decoyAlive(decoy), 'setup sent a signal to a server that owns another data dir')
      } finally {
        if (savedUi === undefined) delete process.env.UI_PORT
        else process.env.UI_PORT = savedUi
        decoy.kill('SIGKILL')
        await fake.close()
      }
    })
  })

  test('a server reporting OUR data dir but a pid that is not provably ours is never signalled', async function () {
    this.timeout(120_000)
    await withBrakedFixture(async f => {
      const decoy = spawnDecoy()
      const ports = { mcp: await freePort(), otlp: await freePort() }
      const otherMcp = await freePort()
      // Ours by data dir and by its UI port, so the chooser keeps the port; its MCP port differs from setup's, so
      // the step wants a restart. The pid is a decoy: not in the pidfile, not `alcore serve --data-dir <ours>`.
      const fake = await startStatsServer(port => ({ pid: decoy.pid, dataDir: f.dataDir, ports: { ui: port, mcp: otherMcp, otlp: ports.otlp } }))
      try {
        const o = await runSetup(setupOpts(f, { ui: fake.port, ...ports }))
        const s = stepOf(o, 'server')
        assert.strictEqual(s.verify, 'FAIL', `${s.found}: ${s.detail}`)
        assert.match(s.detail ?? '', /not provably ours/)
        assert.ok(decoyAlive(decoy), 'setup sent a signal to a pid only the stats answer vouched for')
      } finally { decoy.kill('SIGKILL'); await fake.close() }
    })
  })

  test('ownership is per port: our server on the UI port does not make a stranger on the OTLP port ours', async function () {
    this.timeout(120_000)
    await withBrakedFixture(async f => {
      const decoy = spawnDecoy()
      const ports = { mcp: await freePort(), otlp: await freePort() }
      const reportedOtlp = await freePort()
      const stranger = await startStranger(ports.otlp)
      const fake = await startStatsServer(port => ({ pid: decoy.pid, dataDir: f.dataDir, ports: { ui: port, mcp: ports.mcp, otlp: reportedOtlp } }))
      try {
        const o = await runSetup(setupOpts(f, { ui: fake.port, ...ports }))
        const s = stepOf(o, 'server')
        assert.strictEqual(s.verify, 'FAIL', `${s.found}: ${s.detail}`)
        assert.match(s.detail ?? '', new RegExp(`OTLP port ${ports.otlp} is in use`), 'the OTLP port held by a stranger must be refused')
        assert.ok(decoyAlive(decoy), 'setup signalled a pid after adopting a stranger\'s OTLP port')
      } finally { decoy.kill('SIGKILL'); await fake.close(); await stranger.close() }
    })
  })

  test('httpJson gives up on a server that trickles bytes forever, at its overall deadline', async function () {
    this.timeout(30_000)
    const t = await startTrickleServer(2_000)
    try {
      const t0 = Date.now()
      await assert.rejects(httpJson(t.port, 'GET', '/api/server-stats'), /timeout/)
      const ms = Date.now() - t0
      assert.ok(ms >= HTTP_TOTAL_DEADLINE_MS - 500 && ms < HTTP_TOTAL_DEADLINE_MS + 3_000, `gave up after ${ms} ms`)
    } finally { await t.close() }
  })

  test('control: our data dir reached through a symlink is ours; another dir, or none, is foreign unless the pidfile names the pid', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'al-own-ctl-'))
    try {
      const real = path.join(root, 'data')
      fs.mkdirSync(real)
      const link = path.join(root, 'link')
      fs.symlinkSync(real, link)
      const ctx = resolveCtx({ home: root, dataDir: real, repoRoot: REPO_ROOT, uiPort: 1, mcpPort: 2, otlpPort: 3 })
      assert.strictEqual(statsAreOurs(ctx, { pid: 1, dataDir: link }), true, 'a symlinked spelling of our dir is ours')
      assert.strictEqual(statsAreOurs(ctx, { pid: 1, dataDir: path.join(root, 'other') }), false)
      assert.strictEqual(statsAreOurs(ctx, { pid: 1 }), false, 'no data dir and no pidfile match is foreign')
      // A legacy bare-numeric pidfile naming a live pid: identity, not spelling, decides.
      fs.writeFileSync(path.join(real, 'server.pid'), String(process.pid))
      assert.strictEqual(statsAreOurs(ctx, { pid: process.pid }), true, 'the pidfile owner is ours even with no data dir reported')
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
})
