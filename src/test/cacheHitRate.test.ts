import * as assert from 'assert'
import { cacheHitRate } from '../shared/tokenBuckets'

// Regression cover for the six-digit percentage the Agents tab rendered (2026-09-03): the hit rate
// had been computed as (cacheRead + cacheWrite) / freshInput, which compares two unrelated
// quantities and is unbounded above. These cases pin the shape of the derivation, not just one
// number: whatever the inputs, a hit RATE is a fraction of cache traffic.
suite('cacheHitRate', () => {
  test('returns the read share of cache traffic', () => {
    assert.strictEqual(cacheHitRate(90, 10), 0.9)
    assert.strictEqual(cacheHitRate(1, 1), 0.5)
  })

  test('never exceeds 1 even when cache traffic dwarfs fresh input — the 164662% bug', () => {
    // The live totals that produced "164662%": fresh input 211,420,856 is NOT a term here, so the
    // enormous cache traffic cannot inflate the result past 1.
    const rate = cacheHitRate(341_090_538_959, 7_039_629_182)
    assert.ok(rate <= 1, `rate must be a fraction, got ${rate}`)
    assert.strictEqual(Math.round(rate * 1000) / 10, 98)
  })

  test('a cold session with only writes scores 0, not NaN', () => {
    assert.strictEqual(cacheHitRate(0, 640_000), 0)
  })

  test('no cache traffic at all scores 0 rather than dividing by zero', () => {
    assert.strictEqual(cacheHitRate(0, 0), 0)
  })

  test('negative or non-finite inputs are clamped instead of propagating', () => {
    assert.strictEqual(cacheHitRate(-5, 100), 0)
    assert.ok(Number.isFinite(cacheHitRate(Number.NaN, 100)))
  })
})
