import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { logTail, logSizeNow } from '../cli/serverControl'

/** server.log is ONE append-only file shared by every process that ever started a server for a data
 *  dir, and it carries no timestamps. So a tail taken at the end of a failed start quotes other
 *  processes' history as though it were this command's diagnosis.
 *
 *  These tests use the exact shape measured on a real machine (29 accumulated refusal blocks naming
 *  four different owner pids), because the generic "old lines leak" version of this test passes on
 *  content that would never have misled anyone. The dangerous line is the one that names the pid
 *  which WON — "another server (pid N) already owns this data directory" — since a reader scanning
 *  the tail after a restart concludes N failed, when N is the healthy server they are protected by. */
suite('server log tail: scoped to THIS attempt, never to other processes history', () => {
  const withDataDir = (fn: (dir: string) => void): void => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-logscope-'))
    const prev = process.env.DATA_DIR
    process.env.DATA_DIR = dir
    try { fn(dir) } finally {
      if (prev === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = prev
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  /** One refusal is THREE lines, which is why a default 8-line tail straddles ~2.7 unrelated eras. */
  const refusal = (ownerPid: number): string => [
    `[AgentlensPro] Refusing to start: another AgentlensPro server (pid ${ownerPid}) already owns this data directory (/tmp/x).`,
    '[AgentlensPro] Only ONE server may run per data directory — two processes appending to the same span store, offsets and cards corrupt each other.',
    '[AgentlensPro] Use `agentlenspro server status` / `agentlenspro server restart`, or for a genuinely isolated instance set DATA_DIR (and HOME) as well as the ports.',
  ].join('\n') + '\n'

  test('a foreign refusal naming the pid that WON is not quoted as this attempt\'s failure', () => {
    withDataDir(dir => {
      const log = path.join(dir, 'server.log')
      // History written by OTHER processes, ending with a refusal that names the winner (40460).
      fs.writeFileSync(log, refusal(37104) + refusal(80877) + refusal(57553) + refusal(40460))
      const offset = logSizeNow()          // what ensureServer captures before it spawns
      fs.appendFileSync(log, 'listening on 3000\n')   // what OUR child then writes

      const tail = logTail(8, offset)
      assert.ok(!/Refusing to start/.test(tail),
        `a refusal by another process must not appear in this attempt's tail, got:\n${tail}`)
      assert.ok(!/40460/.test(tail),
        'the pid that WON the race must never be quoted back as a failure — that inversion is the whole bug')
      assert.ok(tail.includes('listening on 3000'), 'what our own child wrote must still be shown')
      assert.ok(/this attempt only/.test(tail),
        'the scope must be stated: "last N lines" and "last N lines we wrote" are different claims')
    })
  })

  test('an attempt that wrote nothing says so, instead of showing someone else\'s last 8 lines', () => {
    withDataDir(dir => {
      const log = path.join(dir, 'server.log')
      fs.writeFileSync(log, refusal(37104) + refusal(80877))
      const offset = logSizeNow()
      // Our child never got far enough to write a byte — silence is the honest answer here, and it
      // is itself diagnostic (it means the failure happened before the server produced output).
      const tail = logTail(8, offset)
      assert.ok(/wrote nothing/.test(tail), `expected an explicit "wrote nothing", got:\n${tail}`)
      assert.ok(!/Refusing to start/.test(tail), 'and certainly not a foreign refusal')
    })
  })

  test('a log rotated under us is reported as such, not quoted from a stale offset', () => {
    withDataDir(dir => {
      const log = path.join(dir, 'server.log')
      fs.writeFileSync(log, refusal(37104) + refusal(80877))
      const offset = logSizeNow()
      fs.writeFileSync(log, 'fresh short log\n')   // rotated/truncated: now shorter than our offset
      const tail = logTail(8, offset)
      assert.ok(/rotated or truncated/.test(tail), `expected a stated reason, got:\n${tail}`)
    })
  })

  test('the unscoped call is unchanged, so existing callers and the operator CLI keep working', () => {
    withDataDir(dir => {
      fs.writeFileSync(path.join(dir, 'server.log'),
        Array.from({ length: 20 }, (_, i) => `line-${i}`).join('\n') + '\n')
      const tail = logTail(8)
      assert.ok(tail.includes('line-19') && tail.includes('line-12'), 'exactly the last 8')
      assert.ok(!tail.includes('line-11'), 'and no more')
      assert.ok(!/this attempt only/.test(tail), 'an unscoped tail must not claim a scope it does not have')
    })
  })

  test('logSizeNow on a missing log is 0, so the first-ever start attributes everything to itself', () => {
    withDataDir(() => {
      assert.strictEqual(logSizeNow(), 0)
    })
  })
})
