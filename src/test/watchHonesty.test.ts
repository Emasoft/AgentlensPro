import * as assert from 'assert'
import { findMetric, DEFAULT_INTERVAL_SEC } from '../cli/watchCli'
// nextSleepMs moved to cliCore once `budget` needed the identical arithmetic — one copy, two loops.
import { nextSleepMs } from '../cli/cliCore'

// TRDD-M8SV6LK5 — two claims watchCli made that it had not established.
//
// The file states its own contract at the top ("null, not 0: a feed that has no number must not be
// reported as having measured zero") and holds it everywhere except one metric; and `--for` is
// documented as "stop after this long" while the loop could only stop on an interval boundary.
// Neither shows up as a crash — the first shows up as SILENCE from a burn alarm.

suite('tokens-per-min: a blind feed must not read as a quiet machine', () => {
  const read = (p: unknown): number | null =>
    findMetric('tokens-per-min').read(p as Parameters<ReturnType<typeof findMetric>['read']>[0])

  test('windows that carry NO rate field answer null, not a measured 0', () => {
    // MEASURED before the fix: 0. For a burn watcher 0/min reads as "nothing is burning", so the
    // alarm stays silent — and the watch loop's `blind` line, which exists to announce exactly this
    // state, can only fire on null.
    assert.strictEqual(read({ accountWindows: [{}, {}] }), null)
  })

  test('a NaN rate is absence too, not zero', () => {
    // `NaN || 0` is 0 — the old expression turned a corrupt reading into a confident quiet one.
    assert.strictEqual(read({ accountWindows: [{ fiveMinTokensPerMin: NaN }] }), null)
    assert.strictEqual(read({ accountWindows: [{ fiveMinTokensPerMin: Infinity }] }), null)
  })

  test('the cases that already worked still work', () => {
    assert.strictEqual(read({}), null, 'no windows at all')
    assert.strictEqual(read({ accountWindows: [] }), null, 'an empty window list')
    assert.strictEqual(read({ accountWindows: [{ fiveMinTokensPerMin: 100 }, { fiveMinTokensPerMin: 50 }] }), 150)
  })

  test('a partially-reporting feed sums what it HAS rather than going blind', () => {
    // One account reporting and one silent is a real machine state, and the reporting one is a real
    // measurement — refusing to answer there would be its own kind of dishonesty.
    assert.strictEqual(read({ accountWindows: [{ fiveMinTokensPerMin: 100 }, {}] }), 100)
  })

  test('zero really is zero when the feed says so', () => {
    // The fix must not turn a genuine idle reading into "cannot see".
    assert.strictEqual(read({ accountWindows: [{ fiveMinTokensPerMin: 0 }] }), 0)
  })
})

suite('--for is a deadline, not a suggestion', () => {
  const MIN = 60_000

  test('the last sleep is trimmed to the deadline instead of overshooting a full interval', () => {
    // `--for 1 --interval 900`: the old loop slept 15 minutes, sampled once more (alerts included),
    // and only then noticed the 1-minute window had closed.
    const now = 0, deadline = 1 * MIN, interval = 900_000
    assert.strictEqual(nextSleepMs(now, deadline, interval), MIN)
  })

  test('a full interval is used while the deadline is far away', () => {
    assert.strictEqual(nextSleepMs(0, 60 * MIN, DEFAULT_INTERVAL_SEC * 1000), DEFAULT_INTERVAL_SEC * 1000)
  })

  test('no --for (Infinity deadline) means the plain interval — the Monitor/daemon case', () => {
    assert.strictEqual(nextSleepMs(Date.now(), Infinity, 30_000), 30_000)
  })

  test('a deadline already passed sleeps zero rather than a negative duration', () => {
    // setTimeout treats a negative delay as 0, but relying on that hides the case; the loop's own
    // deadline check runs first, so this is the belt to that braces.
    assert.strictEqual(nextSleepMs(10 * MIN, 1 * MIN, 30_000), 0)
  })

  test('the interval still wins when it is the shorter of the two', () => {
    assert.strictEqual(nextSleepMs(0, 10 * MIN, 30_000), 30_000)
  })
})
