import * as assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { parsePidLock } from '../../serverRuntime'

/**
 * TRIPWIRE, not a regression test of the brake (TRDD-YGEV6QDD): fails only when the
 * revive-on-failed-POST race actually fires and leaks a real `alcore serve` child. Snapshot
 * `ps` to a string first (never grep the live table — a self-match hazard: the shell running
 * the pipeline has the search pattern in its own argv), then assert no
 * `alcore serve --data-dir <dir>` line survives. Kills any found before failing, so a red run
 * still doesn't leave the daemon running.
 *
 * `dir` is the server's DATA dir (where it writes `server.pid`), not the fixture HOME.
 *
 * Two phases, ONE assertion (TRDD-YGEV6QDD box A2):
 *   1. the pidfile stop — read `<dir>/server.pid` and SIGKILL the pid it names. This finds the
 *      server whatever spawned it (revive, setup self-test, a future recipe), because every alcore
 *      claims that file at boot; the argv sweep alone only finds what its needle happens to match.
 *      The pid is killed ONLY if the snapshot shows that same pid running with `--data-dir <dir>`:
 *      a pidfile can outlive its server, and the OS may have handed the number to an unrelated
 *      process since — killing on the file's word alone could take down anything.
 *   2. the argv sweep — the original tripwire, kept: it catches a survivor that never wrote (or
 *      already removed) its pidfile.
 * Both phases feed the SAME failure: stopping the pidfile's server must not turn the tripwire
 * into a silent cleanup, or the leak it exists to report would pass unseen (R2 in the card).
 */
export function assertNoSurvivingServer(dir: string): void {
  const snapshot = execFileSync('ps', ['-eo', 'pid,command'], { encoding: 'utf8' })
  const lines = snapshot.split('\n')
  const needle = `alcore serve --data-dir ${dir}`
  const pidOf = (line: string): number => Number(line.trim().split(/\s+/)[0])

  const found = new Map<number, string>()
  let pidfileNote = ''
  const pidfile = path.join(dir, 'server.pid')
  if (fs.existsSync(pidfile)) {
    const lock = parsePidLock(fs.readFileSync(pidfile, 'utf8'))
    if (lock) {
      const line = lines.find(l => pidOf(l) === lock.pid)
      if (line && line.includes(`--data-dir ${dir}`)) found.set(lock.pid, line.trim())
      else if (line) pidfileNote = `\n(server.pid names pid ${lock.pid}, now running something else — NOT killed: ${line.trim()})`
    }
  }
  for (const line of lines) {
    if (line.includes(needle)) found.set(pidOf(line), line.trim())
  }
  for (const pid of found.keys()) {
    if (Number.isFinite(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ } }
  }
  const survivors = [...found.values()]
  assert.deepStrictEqual(survivors, [], `leaked alcore server(s) for ${dir}:\n${survivors.join('\n')}${pidfileNote}`)
}
