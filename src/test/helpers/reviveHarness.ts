// TRDD-1FSPKQ6C — proves a hook-revived child is actually REAPED, in a process the shared mocha
// suite never touches. The card's three prior attempts all tried to make this happen INSIDE
// hookSpool.test.ts and each one cost more than the gap: hand-rolled port math collided, the
// fixed range sat inside Linux's ephemeral range, and a real freePort()-bound server measured 2
// failures in 8 runs in suites this file never touches (OtlpCollector "socket hang up" + an
// unrelated HTTP test). This file is the retreat from "fix it in-process" to "isolate the
// process" — it is spawned by hookSpool.test.ts as a SEPARATE node process, binds real ports,
// revives a real detached server, and reports the outcome as one JSON line on stdout. Nothing
// here runs inside the shared mocha runner.
import * as fs from 'fs'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { freePort } from './freePort'
import { forwardHookEvent } from '../../cli/hookHandlers'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Same tolerant parse as hookSpool.test.ts's waitForPid — bare digits or the JSON `{pid,...}` shape
 *  the server actually writes (TRDD-PIDFILEAT, standalone/server.ts). */
function parsePid(raw: string): number | null {
  const trimmed = raw.trim()
  const parsed = /^\d+$/.test(trimmed) ? Number(trimmed) : Number((JSON.parse(trimmed) as { pid?: unknown }).pid)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

async function waitForPid(pidPath: string, budgetMs: number): Promise<number | null> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    try {
      const pid = parsePid(fs.readFileSync(pidPath, 'utf-8'))
      if (pid !== null) return pid
    } catch { /* not written yet */ }
    await sleep(100)
  }
  return null
}

/** Snapshot the process table to a string FIRST, then check membership — never a live `pgrep -f`
 *  by name, which can match the querying shell's own argv. Checking a numeric pid against a
 *  snapshot has no such self-match hazard, but the snapshot-then-grep shape is kept anyway so this
 *  reads the same way everywhere else in this codebase does it. `ps` failing outright (sandboxed
 *  env) is treated as "cannot confirm alive" so a flaky `ps` never reports a false "still alive". */
function isAlivePsSnapshot(pid: number): boolean {
  try {
    const snap = execFileSync('ps', ['-eo', 'pid'], { encoding: 'utf-8' })
    return snap.split('\n').map((l) => l.trim()).includes(String(pid))
  } catch { return false }
}

async function waitForDeath(pid: number, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (!isAlivePsSnapshot(pid)) return true
    await sleep(100)
  }
  return !isAlivePsSnapshot(pid)
}

async function main(): Promise<void> {
  const dataDir = process.env.DATA_DIR
  if (!dataDir) throw new Error('reviveHarness requires DATA_DIR set by the caller')
  const pidPath = path.join(dataDir, 'server.pid')

  // Fresh ports for THIS process only — a lone one-shot process, not the shared mocha runner, so
  // no in-suite retry logic is needed the way spawnServerWithRetry needs it for parallel suites.
  const [mcp, ui, otlp] = [await freePort(), await freePort(), await freePort()]
  process.env.MCP_PORT = String(mcp)
  process.env.UI_PORT = String(ui)
  process.env.OTLP_PORT = String(otlp)
  // The card's sharper half: without this, the watchdog's self-heal respawns the server detached +
  // unref()'d INSIDE the server on a stall, and that replacement's pid is one no pidfile-based
  // teardown ever holds a handle on. NOT optional wherever a real server can be spawned.
  process.env.AGENTLENS_WATCHDOG = 'off'
  delete process.env.AGENTLENS_NO_REVIVE // let reviveDaemonDetached() actually spawn

  // A guaranteed-dead endpoint so forwardHookEvent's delivery fails and falls through to the revive.
  await forwardHookEvent(Buffer.from(JSON.stringify({ hook_event_name: 'PreToolUse' })), { baseUrl: 'http://127.0.0.1:1', timeoutMs: 300 })

  const pid = await waitForPid(pidPath, 30_000)
  // BELT-AND-BRACES (1 of 2): print the pid the MOMENT it is known, before attempting the kill. If
  // this process dies mid-run, its own stdout already recorded a live pid worth reaping. (2 of 2
  // lives in the mocha test itself — its `finally` re-reads pidPath directly off disk, independent
  // of anything this process printed or whether it exited cleanly.)
  if (pid !== null) console.log(JSON.stringify({ phase: 'found', revivedPid: pid }))

  let reaped = false
  if (pid !== null) {
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    reaped = await waitForDeath(pid, 10_000)
  }
  console.log(JSON.stringify({ phase: 'done', revivedPid: pid, reaped, dataDir, ports: { mcp, ui, otlp } }))
}

main().then(() => process.exit(0)).catch((err: unknown) => {
  console.log(JSON.stringify({ phase: 'error', revivedPid: null, reaped: false, error: String(err) }))
  process.exit(1)
})
