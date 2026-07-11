import * as assert from 'assert'
import { analyzeCacheBreaks, type CacheTurnInput } from '../shared/cacheBreak'

suite('cacheBreak priceWaste (S2-F5 — model cache-read rate, not hardcoded 0.1x)', () => {
  // Two turns; turn 2 flips fast mode on → a FAST_MODE break whose wasted tokens = cacheCreateTokens.
  const turns: CacheTurnInput[] = [
    { turn: 1, sources: [], inputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
    { turn: 2, sources: [], inputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 1_000_000, hasFastMode: true },
  ]

  test('default credits 0.1x input when no cache-read rate is provided (backward compatible)', () => {
    // write=10, input=2 → credit 0.1*2 = 0.2 → (10 - 0.2) per MTok, 1M wasted tokens = $9.80.
    const r = analyzeCacheBreaks('s', turns, { writeRateUsdPerMTok: 10, inputRateUsdPerMTok: 2 })
    assert.ok(Math.abs(r.totalWastedCostUsd - 9.8) < 1e-6, `expected 9.8, got ${r.totalWastedCostUsd}`)
  })

  test('uses the provided model cache-read rate instead of 0.1x input', () => {
    // A 0.25x-style model: cacheReadRate 2.5 → (10 - 2.5) per MTok, 1M wasted = $7.50, not $9.80.
    const r = analyzeCacheBreaks('s', turns, {
      writeRateUsdPerMTok: 10, inputRateUsdPerMTok: 2, cacheReadRateUsdPerMTok: 2.5,
    })
    assert.ok(Math.abs(r.totalWastedCostUsd - 7.5) < 1e-6, `expected 7.5, got ${r.totalWastedCostUsd}`)
  })
})
