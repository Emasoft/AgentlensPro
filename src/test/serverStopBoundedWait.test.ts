import * as assert from 'assert'
import { spawn, type ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { freePort, alcoreTestBin, alcoreArgsFromEnv } from './helpers/freePort'

// TRDD-N60JUWU3 — `server stop` used a bare `state.lock_timed()` (a plain blocking
// `Mutex::lock()`) to flush on the way out, so any long lock holder starved the stop
// indefinitely and forced an operator SIGKILL that skipped `pid_lock::release`. The fix bounds
// the wait with `AGENTLENS_STOP_LOCK_TIMEOUT_MS` (default 8_000 ms in bin/alcore.rs; the CLI waits 15 s, 60 x 250 ms, in
// serverControl.ts stopServer) and always releases the pid
// lock, flush-or-not.
//
// This suite has no production hook to hold `state`'s mutex for 120s from outside the process
// (the report's investigation found none, and inventing one would be a debug endpoint shipped in
// production code — out of scope here). So it exercises the MECHANISM added by the fix — the env
// knob is read, and stop still completes fast and releases the lock — rather than reproducing the
// full starvation scenario. A real 120s-holder acceptance test needs a test-only hook into
// `CoreState`'s mutex; see the card's STATE block for what that would take.

interface Started { proc: ChildProcess; stdout: string; stderr: string; exited: number | null }

function start(env: NodeJS.ProcessEnv): Promise<Started> {
  const alcore = alcoreTestBin()
  if (!alcore) throw new Error('no alcore binary found — build rust-core or set AGENTLENS_ALCORE')
  return new Promise((resolve) => {
    const proc = spawn(alcore, alcoreArgsFromEnv(env), { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    const rec: Started = { proc, stdout: '', stderr: '', exited: null }
    let settled = false
    const done = (): void => { if (!settled) { settled = true; resolve(rec) } }
    proc.stdout.on('data', d => { rec.stdout += String(d); if (/alcore: MCP listening/.test(rec.stdout)) done() })
    proc.stderr.on('data', d => { rec.stderr += String(d) })
    proc.on('exit', code => { rec.exited = code; done() })
    setTimeout(done, 25000)
  })
}

suite('server stop — bounded wait on the state lock (TRDD-N60JUWU3)', function () {
  this.timeout(60000)

  test('with AGENTLENS_STOP_LOCK_TIMEOUT_MS set very low, SIGTERM still stops the process quickly and releases the pid lock', async () => {
    assert.ok(alcoreTestBin(),
      'no alcore binary found — build rust-core (cargo build --release --manifest-path rust-core/Cargo.toml -p agentlens-core --bin alcore) or set AGENTLENS_ALCORE; this suite spawns it.')
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-stopwait-data-'))
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-stopwait-home-'))
    const s = await start({
      HOME: home, DATA_DIR: dataDir,
      MCP_PORT: String(await freePort()), UI_PORT: String(await freePort()), OTLP_PORT: String(await freePort()),
      AGENTLENS_STOP_LOCK_TIMEOUT_MS: '1',
    })
    try {
      assert.strictEqual(s.exited, null, `server should stay up; it exited ${s.exited}. stderr: ${s.stderr.slice(0, 400)}`)
      assert.ok(fs.existsSync(path.join(dataDir, 'server.pid')), 'the server did not claim the lock')

      const start_ = Date.now()
      s.proc.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        if (s.exited !== null) return resolve()
        s.proc.on('exit', () => resolve())
        setTimeout(resolve, 10000)
      })
      const elapsedMs = Date.now() - start_

      assert.notStrictEqual(s.exited, null, `server did not exit within 10s of SIGTERM. stderr: ${s.stderr.slice(0, 400)}`)
      assert.strictEqual(s.exited, 0, `server should exit(0) on a graceful SIGTERM stop; exited ${s.exited}. stderr: ${s.stderr.slice(0, 400)}`)
      assert.ok(elapsedMs <= 10000, `stop took ${elapsedMs} ms, expected <= 10000 ms`)
      assert.ok(!fs.existsSync(path.join(dataDir, 'server.pid')), 'pid_lock::release must remove server.pid on stop')
    } finally {
      if (s.exited === null && s.proc.pid) { s.proc.kill('SIGKILL'); await new Promise(r => setTimeout(r, 300)) }
    }
  })
})
