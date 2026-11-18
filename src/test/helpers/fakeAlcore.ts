// A FAKE alcore for the TRDD-RBBEX59R c2 spawn tests: a shell script that appends its argv (one line per spawn) to a
// file and exits 3 at once. It proves WHAT a spawner passed (e.g. --no-collection) without booting a real server: a
// real alcore here would open a store, bind ports and outlive a failed test. alcoreBin() returns AGENTLENS_ALCORE
// verbatim, so pointing that env at this script is enough to intercept every spawn path.
import * as cp from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

export interface FakeAlcore {
  /** Absolute path of the executable script — set it as AGENTLENS_ALCORE. */
  bin: string
  /** One argv per spawn, oldest first. */
  calls(): string[][]
}

/** `exitCode` (default 3) and `stderr` (default none) shape how each spawn ends — e.g. the supervisor exit-64 wiring
 *  test makes it print what an old alcore's usage() prints and exit 64. */
export function makeFakeAlcore(dir: string, opts: { exitCode?: number; stderr?: string } = {}): FakeAlcore {
  fs.mkdirSync(dir, { recursive: true })
  const argsFile = path.join(dir, 'fake-alcore-args.txt')
  const bin = path.join(dir, 'fake-alcore.sh')
  const exitCode = opts.exitCode ?? 3
  // The stderr text goes through printf %s with a single-quoted shell literal (embedded quotes escaped), so it is
  // printed verbatim, never interpreted.
  const stderrLine = opts.stderr === undefined ? '' : `printf '%s\\n' '${opts.stderr.replace(/'/g, `'\\''`)}' >&2\n`
  // Arguments are joined with a TAB, which none of them contains, so each line splits back exactly.
  fs.writeFileSync(bin, `#!/bin/sh\nIFS="$(printf '\\t')"\nprintf '%s\\n' "$*" >> ${JSON.stringify(argsFile)}\n${stderrLine}exit ${exitCode}\n`, { mode: 0o755 })
  return {
    bin,
    calls: () => {
      let text = ''
      try { text = fs.readFileSync(argsFile, 'utf8') } catch { return [] }
      return text.split('\n').filter((l) => l.length > 0).map((l) => l.split('\t'))
    },
  }
}

/** Run `fn(...args)` of a compiled CLI module in a CHILD node process, for code that must not run inside mocha
 *  (runSupervise installs SIGINT/SIGTERM handlers and never returns). `moduleRel` is relative to out/test/cli/. */
export function spawnCliModule(moduleRel: string, fn: string, args: unknown[], env: NodeJS.ProcessEnv): cp.ChildProcess {
  const modulePath = path.resolve(__dirname, '..', '..', 'cli', moduleRel)
  const code = `Promise.resolve(require(${JSON.stringify(modulePath)})[${JSON.stringify(fn)}](...${JSON.stringify(args)})).catch((e) => { process.stderr.write(String(e && e.message) + '\\n'); process.exit(1) })`
  return cp.spawn(process.execPath, ['-e', code], { env, stdio: ['ignore', 'pipe', 'pipe'] })
}

/** Poll until `cond` holds or `timeoutMs` passes; returns whether it held. */
export async function waitFor(cond: () => boolean, timeoutMs: number, stepMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, stepMs))
  }
  return cond()
}

/** SIGTERM a child and wait for it to exit (SIGKILL after `graceMs`). */
export async function stopChild(child: cp.ChildProcess, graceMs = 5_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((r) => child.once('exit', () => r()))
  child.kill('SIGTERM')
  const graceful = await Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), graceMs))])
  if (!graceful) { child.kill('SIGKILL'); await exited }
}
