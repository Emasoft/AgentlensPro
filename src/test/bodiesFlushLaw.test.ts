// Bodies flush law (TRDD-K3WDPR7M P1) — falsifies the exact three clauses the plan names: the pass
// must fire on a byte threshold, on a max-latency backstop regardless of bytes, and immediately
// under spool pressure regardless of both — and must NOT fire when none of the three hold. Pure
// function, no real filesystem/spool/timer touched (mirrors spoolBackpressure.test.ts's style for
// the sibling `applySpoolBackpressure` decision).
import * as assert from 'assert'
import { shouldFlushBodies, BODIES_FLUSH_BYTES_THRESHOLD_BYTES } from '../spoolBackpressure'

const BACKSTOP_MS = 60_000

suite('shouldFlushBodies — the flush law (bytes OR backstop OR pressure)', () => {
  test('does NOT fire when staged bytes are below threshold, time is fresh, and no pressure', () => {
    const fires = shouldFlushBodies({
      stagedBytes: BODIES_FLUSH_BYTES_THRESHOLD_BYTES - 1,
      msSinceLastPass: BACKSTOP_MS - 1,
      backstopMs: BACKSTOP_MS,
      underPressure: false,
    })
    assert.strictEqual(fires, false)
  })

  test('fires when staged bytes reach the threshold, even with fresh time and no pressure', () => {
    const fires = shouldFlushBodies({
      stagedBytes: BODIES_FLUSH_BYTES_THRESHOLD_BYTES,
      msSinceLastPass: 0,
      backstopMs: BACKSTOP_MS,
      underPressure: false,
    })
    assert.strictEqual(fires, true)
  })

  test('fires on the max-latency backstop regardless of bytes (an idle machine must still settle)', () => {
    const fires = shouldFlushBodies({
      stagedBytes: 0,
      msSinceLastPass: BACKSTOP_MS,
      backstopMs: BACKSTOP_MS,
      underPressure: false,
    })
    assert.strictEqual(fires, true)
  })

  test('fires immediately under spool pressure regardless of bytes or elapsed time', () => {
    const fires = shouldFlushBodies({
      stagedBytes: 0,
      msSinceLastPass: 0,
      backstopMs: BACKSTOP_MS,
      underPressure: true,
    })
    assert.strictEqual(fires, true)
  })

  test('the threshold constant sits in the plan\'s named 8-16MB band', () => {
    assert.ok(BODIES_FLUSH_BYTES_THRESHOLD_BYTES >= 8 * 1024 * 1024)
    assert.ok(BODIES_FLUSH_BYTES_THRESHOLD_BYTES <= 16 * 1024 * 1024)
  })
})
