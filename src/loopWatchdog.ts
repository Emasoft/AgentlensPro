/**
 * Event-loop watchdog + self-heal (TRDD-X2E6OSWK deliverable 1).
 *
 * Why this exists: twice now (2026-07-13, 2026-07-16) a drill handler starved the event loop into a
 * permanent 100%-CPU wedge where EVERY request hung and even SIGTERM was ignored — the process had
 * to be SIGKILLed by hand hours later. A wedged observability server is worse than a restarted one:
 * the whole machine loses burn/budget visibility, and the ai-maestro guardian integration depends
 * on this CLI answering. Per-handler bounding (the yield+budget pattern) is the primary defense;
 * this watchdog is the BACKSTOP for the handler nobody bounded yet.
 *
 * Mechanism — the main thread cannot police itself, so a WORKER thread does:
 *   - main: a 1s interval writes Date.now() into a SharedArrayBuffer (Atomics). When the loop is
 *     starved the interval cannot run, so the beat freezes — that silence IS the signal. (A
 *     postMessage-based beat would be useless: a starved main thread cannot post.)
 *   - worker: every checkMs it Atomics-loads the beat. Beat older than stallSeconds → the main
 *     loop has been starved that long → self-heal: spawn a DETACHED restarter (a tiny `node -e`
 *     that SIGKILLs this pid, waits, then respawns the same execPath+argv+env, detached), because
 *     the worker itself cannot kill the main thread from inside the process.
 *
 * Guards, each deliberate:
 *   - SYSTEM-SLEEP guard: after a laptop sleep the beat is stale but so is the worker's own last
 *     tick. If the worker's own timer gapped comparably, it was suspension, not starvation — skip
 *     that round and let the next beat re-arm. Without this, every lid-close would restart the
 *     server on wake.
 *   - MIN-UPTIME guard: no self-heal inside the first minUptimeSeconds. A server that wedges
 *     DURING boot needs human eyes, not a kill/respawn crash-loop.
 *   - unref() on the worker and the beat interval: the watchdog must never hold an otherwise-done
 *     process open or interfere with graceful shutdown.
 *   - FAIL-SOFT start: if worker_threads/SAB are unavailable the server runs without a watchdog
 *     (warn once) — the backstop must not be able to brick the thing it protects.
 */

import { Worker } from 'worker_threads'

export interface LoopWatchdogOptions {
  /** Beat silence that counts as a starved loop. Default 60 (drills are budget-bounded at 20s). */
  stallSeconds?: number
  /** No self-heal before this uptime — a boot wedge must not crash-loop. Default 120. */
  minUptimeSeconds?: number
  /** How the restarter respawns the server. Defaults to this process's own execPath/argv/cwd. */
  respawn?: { execPath: string; argv: string[]; cwd: string }
  /** Diagnostic sink (default console.warn). */
  log?: (msg: string) => void
  /** Test hook: worker check cadence in ms. Default 5000. */
  checkMs?: number
}

export interface LoopWatchdogHandle {
  stop(): Promise<void>
}

// The worker source is an eval-string so the bundled single-file server ships it with no sidecar
// asset. It only uses worker_threads globals + child_process — both available in eval workers.
function workerSource(): string {
  return `
    const { workerData, parentPort } = require('worker_threads')
    const { spawn } = require('child_process')
    const beat = new BigInt64Array(workerData.sab)
    const { stallMs, checkMs, minUptimeMs, pid, execPath, argv, cwd, startedAt } = workerData
    let lastWorkerTick = Date.now()
    let healed = false
    const timer = setInterval(() => {
      const now = Date.now()
      const workerGap = now - lastWorkerTick
      lastWorkerTick = now
      // System-sleep guard: if OUR OWN timer gapped too, the host was suspended — not starvation.
      if (workerGap > checkMs + stallMs / 2) return
      if (now - startedAt < minUptimeMs) return
      const lastBeat = Number(Atomics.load(beat, 0))
      if (lastBeat === 0 || now - lastBeat < stallMs) return
      if (healed) return
      healed = true
      // Self-heal: the worker cannot kill the main thread in-process, so a detached helper does —
      // SIGKILL (SIGTERM is provably ignored when the loop is starved), wait, respawn same config.
      try { parentPort && parentPort.postMessage({ starvedMs: now - lastBeat }) } catch {}
      const restarter =
        'try { process.kill(' + pid + ', "SIGKILL") } catch {}\\n' +
        'setTimeout(() => {\\n' +
        '  const { spawn } = require("child_process")\\n' +
        '  const c = spawn(' + JSON.stringify(execPath) + ', ' + JSON.stringify(argv) + ',\\n' +
        '    { detached: true, stdio: "ignore", env: process.env, cwd: ' + JSON.stringify(cwd) + ' })\\n' +
        '  c.unref()\\n' +
        '}, 2000)\\n' +
        'setTimeout(() => process.exit(0), 4000)'
      const helper = spawn(execPath, ['-e', restarter], { detached: true, stdio: 'ignore', env: process.env })
      helper.unref()
    }, checkMs)
    // Never keep the process alive on our account (mirror of the main-side unref discipline).
    if (typeof timer.unref === 'function') timer.unref()
    // Stay alive until terminated: an eval worker with only an unref'd timer would exit instantly.
    parentPort.on('message', () => {})
  `
}

/**
 * Start the watchdog. Returns a handle whose stop() terminates the worker (used by tests and by a
 * graceful shutdown path); in production the unref'd worker simply dies with the process.
 */
export function startLoopWatchdog(opts: LoopWatchdogOptions = {}): LoopWatchdogHandle | null {
  const stallMs = Math.max(1, opts.stallSeconds ?? 60) * 1000
  const minUptimeMs = Math.max(0, opts.minUptimeSeconds ?? 120) * 1000
  const checkMs = opts.checkMs ?? 5000
  const log = opts.log ?? ((m: string) => console.warn(m))
  const respawn = opts.respawn ?? { execPath: process.execPath, argv: process.argv.slice(1), cwd: process.cwd() }
  try {
    const sab = new SharedArrayBuffer(8)
    const beat = new BigInt64Array(sab)
    Atomics.store(beat, 0, BigInt(Date.now()))
    const worker = new Worker(workerSource(), {
      eval: true,
      workerData: {
        sab, stallMs, checkMs, minUptimeMs,
        pid: process.pid,
        execPath: respawn.execPath,
        argv: respawn.argv,
        cwd: respawn.cwd,
        startedAt: Date.now(),
      },
    })
    worker.on('message', (m: { starvedMs?: number }) => {
      log(`[AgentLens] loop watchdog: event loop starved for ${Math.round((m.starvedMs ?? 0) / 1000)}s — self-healing (SIGKILL + detached respawn)`)
    })
    worker.on('error', (e) => log(`[AgentLens] loop watchdog worker error (watchdog disabled): ${String(e)}`))
    worker.unref()
    const interval = setInterval(() => { Atomics.store(beat, 0, BigInt(Date.now())) }, 1000)
    interval.unref()
    return {
      stop: async () => { clearInterval(interval); await worker.terminate() },
    }
  } catch (e) {
    // Fail-soft: a watchdog that cannot start must not take the server down with it.
    log(`[AgentLens] loop watchdog unavailable (continuing without): ${String(e)}`)
    return null
  }
}
