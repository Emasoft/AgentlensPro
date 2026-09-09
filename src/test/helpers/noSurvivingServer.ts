import * as assert from 'assert'
import { execFileSync } from 'child_process'

/**
 * TRIPWIRE, not a regression test of the brake (TRDD-YGEV6QDD): fails only when the
 * revive-on-failed-POST race actually fires and leaks a real `alcore serve` child. Snapshot
 * `ps` to a string first (never grep the live table — a self-match hazard: the shell running
 * the pipeline has the search pattern in its own argv), then assert no
 * `alcore serve --data-dir <dir>` line survives. Kills any found before failing, so a red run
 * still doesn't leave the daemon running.
 */
export function assertNoSurvivingServer(dir: string): void {
  const snapshot = execFileSync('ps', ['-eo', 'pid,command'], { encoding: 'utf8' })
  const needle = `alcore serve --data-dir ${dir}`
  const survivors = snapshot.split('\n').filter(l => l.includes(needle))
  for (const line of survivors) {
    const pid = Number(line.trim().split(/\s+/)[0])
    if (Number.isFinite(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ } }
  }
  assert.deepStrictEqual(survivors, [], `leaked alcore server(s) for ${dir}:\n${survivors.join('\n')}`)
}
