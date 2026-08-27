// TRDD-X2E6OSWK — the event-loop watchdog self-heal, tested END-TO-END on a REAL child process:
// the child starts the watchdog, genuinely starves its own event loop (a synchronous busy-loop —
// the exact wedge shape), and the assertions are that (1) the child gets SIGKILLed by the detached
// restarter and (2) the "respawn" fires (injected as a marker-writing argv, standing in for the
// real server respawn). No mocks anywhere — a mocked watchdog would prove nothing about the one
// mechanism that matters: a worker thread surviving a starved main loop.
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawn } from 'child_process'
import { startLoopWatchdog } from '../loopWatchdog'

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

suite('loopWatchdog — worker-thread self-heal (TRDD-X2E6OSWK)', () => {
  test('a starved main loop is SIGKILLed and the respawn argv fires (real child process)', async function () {
    this.timeout(40_000)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-watchdog-'))
    const marker = path.join(dir, 'respawned.marker')
    // The child: beat normally for ~1.5s, then starve the loop HARD for 30s (far past the 2s stall).
    // Its watchdog respawn argv writes the marker file instead of booting a server.
    const childSrc = `
      const { startLoopWatchdog } = require(${JSON.stringify(path.resolve(__dirname, '..', 'loopWatchdog.js'))})
      startLoopWatchdog({
        stallSeconds: 2, minUptimeSeconds: 0, checkMs: 500,
        respawn: { execPath: process.execPath, argv: ['-e', 'require("fs").writeFileSync(' + ${JSON.stringify(JSON.stringify(marker))} + ', "healed")'], cwd: process.cwd() },
        log: () => {},
      })
      setTimeout(() => {
        const until = Date.now() + 30_000
        while (Date.now() < until) { /* the wedge: synchronous starvation */ }
      }, 1500)
      setInterval(() => {}, 1000) // keep alive if never starved (test failure mode)
    `
    const child = spawn(process.execPath, ['-e', childSrc], { stdio: 'ignore' })
    const exited = new Promise<NodeJS.Signals | null>(resolve => child.on('close', (_c, sig) => resolve(sig)))

    // The restarter SIGKILLs ~2s stall + ~2s spawn margin after starvation begins (~1.5s in).
    const signal = await Promise.race([exited, sleep(25_000).then(() => 'TIMEOUT' as const)])
    assert.notStrictEqual(signal, 'TIMEOUT', 'the starved child must be killed by the watchdog, not run out its 30s busy-loop')
    assert.strictEqual(signal, 'SIGKILL', 'the self-heal must SIGKILL (SIGTERM is ignored by a starved loop)')

    // The detached respawn fires ~2s after the kill.
    const deadline = Date.now() + 10_000
    while (!fs.existsSync(marker) && Date.now() < deadline) await sleep(250)
    assert.ok(fs.existsSync(marker), 'the detached restarter must respawn the configured argv')
    assert.strictEqual(fs.readFileSync(marker, 'utf-8'), 'healed')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('with the NO_REVIVE brake present the starved loop is still KILLED but NOT respawned (TRDD-8VGQK9L9)', async function () {
    this.timeout(40_000)
    // Same wedge as above, plus a brake file. The respawn is a resurrection path like the hook
    // reviver and the supervisor; without this check it was the one spawner that ignored the brake.
    // The kill must still happen (a starved server is useless either way) — only the spawn is
    // withheld, so the discriminator is "SIGKILL observed AND no marker".
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-watchdog-brake-'))
    const marker = path.join(dir, 'respawned.marker')
    const brake = path.join(dir, 'NO_REVIVE')
    fs.writeFileSync(brake, 'test\n')
    const childSrc = `
      const { startLoopWatchdog } = require(${JSON.stringify(path.resolve(__dirname, '..', 'loopWatchdog.js'))})
      startLoopWatchdog({
        stallSeconds: 2, minUptimeSeconds: 0, checkMs: 500,
        brakePath: ${JSON.stringify(brake)},
        respawn: { execPath: process.execPath, argv: ['-e', 'require("fs").writeFileSync(' + ${JSON.stringify(JSON.stringify(marker))} + ', "healed")'], cwd: process.cwd() },
        log: () => {},
      })
      setTimeout(() => {
        const until = Date.now() + 30_000
        while (Date.now() < until) { /* the wedge: synchronous starvation */ }
      }, 1500)
      setInterval(() => {}, 1000)
    `
    const child = spawn(process.execPath, ['-e', childSrc], { stdio: 'ignore' })
    const exited = new Promise<NodeJS.Signals | null>(resolve => child.on('close', (_c, sig) => resolve(sig)))
    const signal = await Promise.race([exited, sleep(25_000).then(() => 'TIMEOUT' as const)])
    assert.strictEqual(signal, 'SIGKILL', 'the brake withholds the RESPAWN, not the kill')
    // Wait past the restarter's 2s respawn delay + its 4s self-exit: a marker appearing in this
    // window would mean the brake was ignored.
    await sleep(5_000)
    assert.ok(!fs.existsSync(marker), 'no respawn while NO_REVIVE exists')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('a healthy loop is never killed, and stop() tears the watchdog down cleanly', async function () {
    this.timeout(15_000)
    // In-process this time: beats flow normally, so nothing may happen within several check cycles.
    const logs: string[] = []
    const handle = startLoopWatchdog({
      stallSeconds: 1, minUptimeSeconds: 0, checkMs: 200,
      respawn: { execPath: process.execPath, argv: ['-e', 'process.exit(0)'], cwd: process.cwd() },
      log: m => logs.push(m),
    })
    assert.ok(handle, 'watchdog must start on a platform with worker_threads + SAB')
    await sleep(2_000)   // ~10 check cycles with live beats
    assert.strictEqual(logs.filter(l => /self-healing/.test(l)).length, 0, 'no self-heal on a healthy loop')
    await handle!.stop() // must resolve — worker terminates, interval cleared
  })

  test('min-uptime guard: starvation inside the grace window does not self-heal (no boot crash-loop)', async function () {
    this.timeout(20_000)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-watchdog-grace-'))
    const marker = path.join(dir, 'respawned.marker')
    const childSrc = `
      const { startLoopWatchdog } = require(${JSON.stringify(path.resolve(__dirname, '..', 'loopWatchdog.js'))})
      startLoopWatchdog({
        stallSeconds: 1, minUptimeSeconds: 3600, checkMs: 300,
        respawn: { execPath: process.execPath, argv: ['-e', 'require("fs").writeFileSync(' + ${JSON.stringify(JSON.stringify(marker))} + ', "x")'], cwd: process.cwd() },
        log: () => {},
      })
      setTimeout(() => {
        const until = Date.now() + 5_000
        while (Date.now() < until) { /* starve during the grace window */ }
        process.exit(0)  // survived the wedge un-killed → clean exit proves the guard held
      }, 500)
    `
    const child = spawn(process.execPath, ['-e', childSrc], { stdio: 'ignore' })
    const outcome = await new Promise<{ code: number | null; sig: NodeJS.Signals | null }>(resolve =>
      child.on('close', (code, sig) => resolve({ code, sig })))
    assert.strictEqual(outcome.sig, null, 'must NOT be killed inside the min-uptime grace window')
    assert.strictEqual(outcome.code, 0, 'child runs its wedge to completion and exits cleanly')
    assert.ok(!fs.existsSync(marker), 'no respawn fired')
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
