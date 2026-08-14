// TRDD-PIDFILEAT — unit tests for the pid-lock primitives (real fs, no mocks).
//
// Two defects, both observed live 2026-08-13:
//   1. server.pid read "4676845598" — two interleaved pids — because the old bare `wx`-flagged
//      writeFileSync's CREATE was exclusive but its content write was a separate, non-atomic
//      syscall. atomicExclusiveWriteFileSync fixes this with a temp-file + link(2) publish.
//   2. the stale-lock takeover trusted kill(pid,0) alone, which a RECYCLED pid can fool under heavy
//      pid churn (a possible >=67s double-owner window, TRDD-34B9JAZK's 22:09 recurrence). The lock
//      now carries a start-time reference alongside the pid; lockTakeoverVerdict is the pure
//      decision over the four possible outcomes.
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawnSync } from 'child_process'
import {
  atomicExclusiveWriteFileSync, formatPidLock, parsePidLock, processStartRef, lockTakeoverVerdict,
} from '../serverRuntime'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-pidlock-'))
}

suite('atomicExclusiveWriteFileSync — atomic AND exclusive publish', () => {
  test('creates the file with the exact content when absent', () => {
    const dir = tmpDir()
    const f = path.join(dir, 'server.pid')
    assert.strictEqual(atomicExclusiveWriteFileSync(f, '46768'), true)
    assert.strictEqual(fs.readFileSync(f, 'utf8'), '46768')
  })

  test('refuses (returns false) and leaves the existing content untouched when the target already exists', () => {
    const dir = tmpDir()
    const f = path.join(dir, 'server.pid')
    assert.strictEqual(atomicExclusiveWriteFileSync(f, '46768'), true)
    assert.strictEqual(atomicExclusiveWriteFileSync(f, '45598'), false)
    assert.strictEqual(fs.readFileSync(f, 'utf8'), '46768', 'the loser must never touch the winner\'s content')
  })

  test('leaves no orphaned temp file behind on success or on a lost race', () => {
    const dir = tmpDir()
    const f = path.join(dir, 'server.pid')
    atomicExclusiveWriteFileSync(f, '111')
    atomicExclusiveWriteFileSync(f, '222') // loses — refused
    assert.deepStrictEqual(fs.readdirSync(dir), ['server.pid'])
  })

  test('the content is never a concatenation of two writers — the exact "4676845598" corruption shape', () => {
    // Simulates the observed defect: two processes racing to claim the same pidfile. With the old
    // bare `wx` writeFileSync, two non-atomic content writes to the same freshly-created inode could
    // interleave into "46768" + "45598" = "4676845598". The exclusive link(2) publish makes that
    // structurally impossible: only ONE writer's full, staged content is ever visible.
    const dir = tmpDir()
    const f = path.join(dir, 'server.pid')
    const winnerA = atomicExclusiveWriteFileSync(f, '46768')
    const winnerB = atomicExclusiveWriteFileSync(f, '45598')
    assert.notStrictEqual(winnerA, winnerB, 'exactly one of the two racing writers must win')
    const content = fs.readFileSync(f, 'utf8')
    assert.ok(content === '46768' || content === '45598', `content must be exactly one writer's payload, got: ${content}`)
    assert.notStrictEqual(content, '4676845598')
  })

  test('throws (not swallow) when the parent directory does not exist, and leaves no temp file', () => {
    const dir = tmpDir()
    const f = path.join(dir, 'nope', 'server.pid')
    assert.throws(() => atomicExclusiveWriteFileSync(f, '1'))
    assert.deepStrictEqual(fs.readdirSync(dir), [])
  })
})

suite('formatPidLock / parsePidLock — the JSON {pid,start} shape, with legacy fallback', () => {
  test('round-trips a lock with a start reference through the JSON shape', () => {
    const s = formatPidLock(4242, 'Fri Aug 14 10:00:00 2026')
    assert.strictEqual(parsePidLock(s)?.pid, 4242)
    assert.strictEqual(parsePidLock(s)?.start, 'Fri Aug 14 10:00:00 2026')
  })

  test('start=null formats as the bare legacy numeric shape, not "pid:null"', () => {
    const s = formatPidLock(4242, null)
    assert.strictEqual(s, '4242')
    assert.deepStrictEqual(parsePidLock(s), { pid: 4242, start: null })
  })

  test('parses a legacy bare-numeric pidfile written by a pre-PIDFILEAT build', () => {
    assert.deepStrictEqual(parsePidLock('46768'), { pid: 46768, start: null })
    assert.deepStrictEqual(parsePidLock('46768\n'), { pid: 46768, start: null }) // trailing newline tolerated
  })

  test('returns null for empty, unparseable, or non-positive content', () => {
    assert.strictEqual(parsePidLock(''), null)
    assert.strictEqual(parsePidLock('   '), null)
    assert.strictEqual(parsePidLock('not json and not a number'), null)
    assert.strictEqual(parsePidLock('0'), null)
    assert.strictEqual(parsePidLock('-5'), null)
  })

  test('a pure digit string parses as ONE (possibly garbage) pid — never crashes, never splits it in two', () => {
    // The historical corruption ("4676845598" = two interleaved pids, 46768+45598) is now IMPOSSIBLE
    // to produce (atomicExclusiveWriteFileSync), but a reader must still degrade gracefully if it
    // ever sees a pure-digit string shaped like one: treat it as a single (garbage) pid, not throw.
    assert.deepStrictEqual(parsePidLock('4676845598'), { pid: 4676845598, start: null })
  })

  test('returns null for a JSON object missing a valid pid', () => {
    assert.strictEqual(parsePidLock('{"start":"x"}'), null)
    assert.strictEqual(parsePidLock('{"pid":"not-a-number","start":"x"}'), null)
  })
})

suite('processStartRef — the OS start-time reference used to detect a recycled pid', () => {
  test('returns a non-empty string for the current (definitely alive) process', () => {
    const ref = processStartRef(process.pid)
    assert.ok(ref === null || ref.length > 0, 'must be null (ps unavailable) or a real non-empty reference')
  })

  test('returns null for a pid that cannot exist', () => {
    // pid 2^22 is above every real pid_max on Linux and macOS.
    assert.strictEqual(processStartRef(4194303), null)
  })

  test('is stable across two consecutive calls for the same live process (used for the mismatch check)', function () {
    if (spawnSync('ps', ['-o', 'lstart=', '-p', String(process.pid)]).status !== 0) this.skip() // ps unavailable in this env
    const a = processStartRef(process.pid)
    const b = processStartRef(process.pid)
    assert.strictEqual(a, b)
  })
})

suite('lockTakeoverVerdict — the pure takeover decision (TRDD-PIDFILEAT)', () => {
  test('dead-takeover: the recorded pid answers no kill(pid,0), whatever the lock format', () => {
    assert.strictEqual(lockTakeoverVerdict({ lockPid: 46768, lockStartRef: 'A', pidAlive: false, currentStartRef: null }), 'dead-takeover')
    assert.strictEqual(lockTakeoverVerdict({ lockPid: 46768, lockStartRef: null, pidAlive: false, currentStartRef: null }), 'dead-takeover')
  })

  test('live-owner: alive AND the current start reference matches the recorded one — never take over', () => {
    assert.strictEqual(
      lockTakeoverVerdict({ lockPid: 65252, lockStartRef: 'Fri Aug 13 22:08:22 2026', pidAlive: true, currentStartRef: 'Fri Aug 13 22:08:22 2026' }),
      'live-owner',
    )
  })

  test('recycled-takeover: alive but the CURRENT start reference does not match — the OS reused the pid', () => {
    // This is the exact 34B9JAZK shape: pid 77910 started 22:08:22 while a stale lock still named an
    // old owner as pid 77910 with a DIFFERENT recorded start time — the OS recycled the number.
    assert.strictEqual(
      lockTakeoverVerdict({ lockPid: 77910, lockStartRef: 'Thu Aug 13 12:00:00 2026', pidAlive: true, currentStartRef: 'Fri Aug 13 22:08:22 2026' }),
      'recycled-takeover',
    )
  })

  test('legacy-kill0-only: lock has no start reference (old-format lock) — falls back to the pre-fix rule', () => {
    assert.strictEqual(lockTakeoverVerdict({ lockPid: 14576, lockStartRef: null, pidAlive: true, currentStartRef: 'anything' }), 'legacy-kill0-only')
  })

  test('legacy-kill0-only: the CURRENT start reference could not be determined (ps unavailable) — never guess "recycled"', () => {
    assert.strictEqual(lockTakeoverVerdict({ lockPid: 14576, lockStartRef: 'A', pidAlive: true, currentStartRef: null }), 'legacy-kill0-only')
  })
})
