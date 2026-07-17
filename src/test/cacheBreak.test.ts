import * as assert from 'assert'
import { analyzeCacheBreaks, diffTurnSources, type CacheTurnInput } from '../shared/cacheBreak'
import type { ContextSource } from '../shared/summarizerTypes'

const src = (kind: string, label: string, tokens: number, excerpt?: string): ContextSource =>
  ({ kind, label, tokens, bytes: tokens * 4, count: 1, excerpt })

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

suite('cacheBreak diffTurnSources (#92, TRDD-CB9POPUP — before/after prefix diff)', () => {
  test('classifies added / removed / resized / unchanged and flags the first divergence', () => {
    const prev = [src('file', 'CLAUDE.md', 100, 'v1'), src('hook', 'memory', 50, 'old'), src('file', 'gone.md', 20)]
    const cur  = [src('file', 'CLAUDE.md', 100, 'v1'), src('hook', 'memory', 80, 'new'), src('toolCatalog', 'skills', 30)]
    const d = diffTurnSources(prev, cur)
    const by = (k: string, l: string) => d.find(e => e.key === `${k}::${l}`)!
    assert.strictEqual(by('file', 'CLAUDE.md').status, 'unchanged')
    assert.strictEqual(by('hook', 'memory').status, 'resized')
    assert.strictEqual(by('hook', 'memory').prevTokens, 50)
    assert.strictEqual(by('hook', 'memory').curTokens, 80)
    assert.strictEqual(by('hook', 'memory').prevExcerpt, 'old')
    assert.strictEqual(by('hook', 'memory').curExcerpt, 'new')
    assert.strictEqual(by('toolCatalog', 'skills').status, 'added')
    assert.strictEqual(by('file', 'gone.md').status, 'removed')
    // First divergence = first added/resized in cur order → the resized memory hook (skills comes after it).
    const first = d.filter(e => e.isFirstDivergence)
    assert.strictEqual(first.length, 1)
    assert.strictEqual(first[0].key, 'hook::memory')
  })

  test('no changes → every entry unchanged, no divergence flagged', () => {
    const same = [src('file', 'a', 10), src('file', 'b', 20)]
    const d = diffTurnSources(same, same.map(s => ({ ...s })))
    assert.ok(d.every(e => e.status === 'unchanged'))
    assert.ok(d.every(e => !e.isFirstDivergence))
  })

  test('a dropped block is the divergence when nothing in cur diverges', () => {
    const prev = [src('file', 'a', 10), src('file', 'dropped', 5)]
    const cur  = [src('file', 'a', 10)]
    const d = diffTurnSources(prev, cur)
    const first = d.find(e => e.isFirstDivergence)!
    assert.strictEqual(first.key, 'file::dropped')
    assert.strictEqual(first.status, 'removed')
  })
})
