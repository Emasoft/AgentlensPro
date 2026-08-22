// src/test/alcoreCutover.test.ts — the D1 cutover seam (TRDD-DMWOBWFH): which engine
// `ensureServer` spawns, and on what ports.
//
// These two functions are the whole safety argument for the cutover, so they are tested
// directly rather than through a spawned server: `alcoreBin` decides whether a machine runs the
// Rust core at all, and `alcoreServeArgs` decides whether the thing it starts is reachable by
// the rest of the product. Both fail SILENTLY when wrong — a missed opt-in just keeps running
// the TS server, and a bad port binds successfully and then answers nothing.

import * as assert from 'assert'
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { alcoreBin, alcoreServeArgs } from '../cli/serverControl'
import { parsePidLock } from '../serverRuntime'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-cutover-'))
const ALCORE = path.join(__dirname, '..', '..', '..', 'rust-core', 'target', 'release', 'alcore')

/** The argv value that follows `flag`, so a test asserts the pairing rather than an index — the
 *  arg order is not the contract, the flag/value association is. */
function valueOf(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

suite('alcore cutover seam', () => {
  test('alcoreBin: env wins, else the durable install location, else off — never auto-detection', () => {
    const missing = path.join(tmpDir, 'no-such-alcore')
    assert.strictEqual(alcoreBin({}, missing), null, 'no env and no installed file means the Rust core is OFF')
    assert.strictEqual(alcoreBin({ AGENTLENS_ALCORE: '   ' }, missing), null, 'whitespace is not a path')
    assert.strictEqual(alcoreBin({ AGENTLENS_ALCORE: '/x/alcore' }, missing), '/x/alcore', 'env names the binary and wins')
    const installed = path.join(tmpDir, 'alcore')
    fs.writeFileSync(installed, '#!/bin/sh\n')
    assert.strictEqual(alcoreBin({}, installed), installed, 'the installed file IS the opt-in')
    assert.strictEqual(alcoreBin({ AGENTLENS_ALCORE: '/x/alcore' }, installed), '/x/alcore', 'env still wins over an install')
  })

  test('alcoreBin: a DIRECTORY at the install path is not an opt-in', () => {
    // `<dataDir>/bin/alcore` existing as a directory is a botched install, not a binary. statSync
    // succeeds on it, so only the isFile() check tells them apart — without it the cutover would
    // fire and spawn EISDIR.
    const asDir = path.join(tmpDir, 'alcore-dir')
    fs.mkdirSync(asDir, { recursive: true })
    assert.strictEqual(alcoreBin({}, asDir), null)
  })

  test('alcoreServeArgs: binds the ports the rest of the product already assumes', () => {
    const argv = alcoreServeArgs({}, '/data')
    assert.strictEqual(argv[0], 'serve')
    assert.strictEqual(valueOf(argv, '--data-dir'), '/data')
    // Canonical, NOT alcore's own 4319/3001/4317 side-by-side defaults: cliCore.mcpEndpoint
    // defaults to :4316, the dashboard to :3000, every telemetry writer to :4318.
    assert.strictEqual(valueOf(argv, '--otlp-port'), '4318')
    assert.strictEqual(valueOf(argv, '--ui-port'), '3000')
    assert.strictEqual(valueOf(argv, '--mcp-port'), '4316')
  })

  test('alcoreServeArgs: env overrides each port independently', () => {
    const argv = alcoreServeArgs({ OTLP_PORT: '5318', UI_PORT: '5000', MCP_PORT: '5316' }, '/data')
    assert.strictEqual(valueOf(argv, '--otlp-port'), '5318')
    assert.strictEqual(valueOf(argv, '--ui-port'), '5000')
    assert.strictEqual(valueOf(argv, '--mcp-port'), '5316')
  })

  test('alcoreServeArgs: an empty or unusable port env falls back — never binds 0', () => {
    // The trap this exists to prevent: `Number('') === 0`, so the `?? default` spelling used in
    // setup.ts reads an exported-but-empty UI_PORT as port 0 — which binds SUCCESSFULLY to a
    // kernel-assigned port and then answers nothing on the port the CLI probes. Empty means unset.
    for (const bad of ['', '   ', 'abc', '0', '-1', '65536', '80.5']) {
      const argv = alcoreServeArgs({ OTLP_PORT: bad, UI_PORT: bad, MCP_PORT: bad }, '/data')
      assert.strictEqual(valueOf(argv, '--otlp-port'), '4318', `OTLP_PORT=${JSON.stringify(bad)} must fall back`)
      assert.strictEqual(valueOf(argv, '--ui-port'), '3000', `UI_PORT=${JSON.stringify(bad)} must fall back`)
      assert.strictEqual(valueOf(argv, '--mcp-port'), '4316', `MCP_PORT=${JSON.stringify(bad)} must fall back`)
    }
  })

  // The seam that actually decides whether `agentlenspro server stop|status` keeps working after
  // the cutover, and the one that can rot silently: the pidfile is WRITTEN by Rust
  // (pid_lock::format_pid_lock) and READ by TypeScript (parsePidLock). Two independent
  // implementations of one on-disk format, in two languages, with no compiler between them.
  //
  // Asserted against the REAL binary writing a REAL file — a TS-side test using a hand-typed
  // sample would only prove that my transcription of the Rust format parses, which is exactly
  // the thing that goes stale when the Rust side changes.
  const crossEngine = fs.existsSync(ALCORE) ? test : test.skip
  crossEngine('🐌 cross-engine: the pidfile alcore writes is the one the TS CLI reads', async function () {
    this.timeout(30_000)
    // Its own DATA_DIR — per the single-owner rule, the data dir (not the ports) is what isolates
    // an instance, so a shared one here would race the developer's live server.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-cutover-data-'))
    // Ports well away from both the canonical set and alcore's side-by-side defaults, so this
    // test cannot collide with either a real server or a second copy of itself.
    const child = spawn(ALCORE, ['serve', '--data-dir', dir, '--otlp-port', '44318', '--ui-port', '43000', '--mcp-port', '44316', '--no-log-scan'],
      { stdio: ['ignore', 'ignore', 'ignore'] })
    try {
      const pidfile = path.join(dir, 'server.pid')
      const deadline = Date.now() + 20_000
      let raw = ''
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100))
        try { raw = fs.readFileSync(pidfile, 'utf8') } catch { continue }
        if (raw.trim() !== '') break
      }
      assert.notStrictEqual(raw.trim(), '', `alcore wrote no ${pidfile} — the cutover would leave server stop/status blind`)

      const lock = parsePidLock(raw)
      assert.ok(lock, `the TS parser rejected what alcore wrote: ${JSON.stringify(raw)}`)
      assert.strictEqual(lock.pid, child.pid, 'the pidfile must name the process that claimed the dir')
      // `start` is what tells a live-but-RECYCLED pid apart from the real owner. A null here is
      // the legacy shape: parseable, but it silently downgrades `server stop` to kill-0-only,
      // which is the ≥67s double-owner window TRDD-PIDFILEAT was written to close.
      assert.strictEqual(typeof lock.start, 'string', 'alcore must record its process-start reference, not the legacy bare-pid shape')
      assert.notStrictEqual((lock.start as string).trim(), '')
    } finally {
      child.kill('SIGTERM')
    }
  })
})
