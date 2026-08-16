import * as assert from 'assert'
import { spawn, type ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { freePort } from './helpers/freePort'
import { parsePidLock } from '../serverRuntime'

// EXACTLY ONE server may own a data directory. Real processes, real ports, real filesystem — no
// mocks: the thing under test is what a second `node standalone/server.js` actually does.
//
// The guard used to key on `OTLP_PORT === 4318`, so overriding the ports opted OUT of it entirely.
// That is not isolation: the ports isolate the LISTENERS while both processes keep appending to one
// span store, offsets file and card set. On 2026-07-28 a dev instance started that way ran ~4 minutes
// against the live ~/.agentlens beside the real server, and the next restart found 182 log-tail
// offsets invalid where 95 of 107 prior restarts had found zero.
//
// The lock is now keyed on the DATA DIR, so these tests assert both halves of the contract: same data
// dir is refused however different the ports, and a different data dir still starts freely.

const SERVER = path.resolve(__dirname, '../../../standalone/server.js')

interface Started { proc: ChildProcess; stdout: string; stderr: string; exited: number | null }

/**
 * Spawn a server and watch it until it either reports listening or EXITS.
 *
 * Deliberately does NOT settle on seeing the refusal text: the refusal is printed a beat before
 * `process.exit(1)`, so resolving on the message returns while `exited` is still null and a test
 * asserting the exit code reads a false failure. Only the real `exit` event proves the refusal took
 * effect — which is the property under test.
 */
function start(env: NodeJS.ProcessEnv): Promise<Started> {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    const rec: Started = { proc, stdout: '', stderr: '', exited: null }
    let settled = false
    const done = (): void => { if (!settled) { settled = true; resolve(rec) } }
    proc.stdout.on('data', d => { rec.stdout += String(d); if (/MCP server\s+→/.test(rec.stdout)) done() })
    proc.stderr.on('data', d => { rec.stderr += String(d) })
    proc.on('exit', code => { rec.exited = code; done() })
    setTimeout(done, 25000)
  })
}

async function stop(s: Started | null): Promise<void> {
  if (!s || s.exited !== null || !s.proc.pid) return
  s.proc.kill('SIGKILL')
  await new Promise(r => setTimeout(r, 300))
}

suite('standalone server — exactly one instance per data directory', function () {
  this.timeout(90000)   // real process spawns: the server restores session cards on boot

  let dataDir = ''
  let home = ''
  let first: Started | null = null

  suiteSetup(() => {
    // These tests exercise the BUNDLE, not src/ — `pnpm run test:unit` compiles tests but does not
    // run esbuild, so a stale or absent bundle would silently test the wrong code. Say so plainly.
    assert.ok(fs.existsSync(SERVER),
      `${SERVER} is missing — run \`node esbuild.js\` first; this suite spawns the built server.`)
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-singleton-data-'))
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-singleton-home-'))
  })

  suiteTeardown(async () => { await stop(first) })

  test('a SECOND server on the same data dir is refused, even on completely different ports', async () => {
    const envFor = async (): Promise<NodeJS.ProcessEnv> => ({
      HOME: home, DATA_DIR: dataDir,
      MCP_PORT: String(await freePort()), UI_PORT: String(await freePort()), OTLP_PORT: String(await freePort()),
    })

    first = await start(await envFor())
    assert.strictEqual(first.exited, null, `the FIRST server should stay up; it exited ${first.exited}. stderr: ${first.stderr.slice(0, 400)}`)
    assert.ok(fs.existsSync(path.join(dataDir, 'server.pid')), 'the first server did not claim the lock')

    // Different ports entirely — the old guard would have let this through.
    const second = await start(await envFor())
    // try/finally, matching this file's other two tests: a bare `stop()` after the asserts leaks
    // the process for the rest of the mocha run whenever an assert throws, and suiteTeardown only
    // knows about `first`.
    try {
      assert.strictEqual(second.exited, 1, `the SECOND server must exit(1); it exited ${second.exited}. stdout: ${second.stdout.slice(0, 300)}`)
      assert.ok(/Refusing to start/.test(second.stderr), `expected a refusal, got: ${second.stderr.slice(0, 400)}`)
      assert.ok(/only ONE server may run per data directory/i.test(second.stderr),
        'the refusal must say WHY — a bare exit teaches the next person nothing')
    } finally {
      await stop(second)
    }

    // The refusal must not have stolen the running server's lock.
    const holder = parsePidLock(fs.readFileSync(path.join(dataDir, 'server.pid'), 'utf-8'))?.pid
    assert.strictEqual(holder, first.proc.pid, 'the rejected server overwrote the live server’s lock')
  })

  test('a different data dir starts freely — isolation is by DATA_DIR, not by port', async () => {
    const otherData = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-singleton-other-'))
    const otherHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-singleton-otherhome-'))
    const other = await start({
      HOME: otherHome, DATA_DIR: otherData,
      MCP_PORT: String(await freePort()), UI_PORT: String(await freePort()), OTLP_PORT: String(await freePort()),
    })
    try {
      assert.strictEqual(other.exited, null,
        `an instance with its OWN data dir must start; it exited ${other.exited}. stderr: ${other.stderr.slice(0, 400)}`)
      assert.ok(fs.existsSync(path.join(otherData, 'server.pid')), 'the isolated instance did not claim its own lock')
    } finally { await stop(other) }
  })

  test('a STALE lock (holder gone) is taken over rather than blocking forever', async () => {
    const staleData = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-singleton-stale-'))
    const staleHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-singleton-stalehome-'))
    // A pid that cannot be alive: process 2^22 is above every real pid_max.
    fs.writeFileSync(path.join(staleData, 'server.pid'), '4194303')
    const s = await start({
      HOME: staleHome, DATA_DIR: staleData,
      MCP_PORT: String(await freePort()), UI_PORT: String(await freePort()), OTLP_PORT: String(await freePort()),
    })
    try {
      assert.strictEqual(s.exited, null, `a stale lock must not block startup; exited ${s.exited}. stderr: ${s.stderr.slice(0, 400)}`)
      const holder = parsePidLock(fs.readFileSync(path.join(staleData, 'server.pid'), 'utf-8'))?.pid
      assert.strictEqual(holder, s.proc.pid, 'the stale lock was not taken over')
    } finally { await stop(s) }
  })
})
