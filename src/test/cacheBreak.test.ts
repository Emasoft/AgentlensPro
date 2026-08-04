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

suite('cacheBreak PLUGINS_RELOADED (TRDD-EYA3X5MQ — /reload-plugins multi-catalog co-churn)', () => {
  // Turn 1 = the cached prefix; turn 2 = the first turn carrying the reloaded catalogs. The reload cost
  // lands here as cache_creation, exactly where a /reload-plugins re-registration would.
  const reloadTurns = (cur: ContextSource[]): CacheTurnInput[] => [
    { turn: 1, sources: [src('toolCatalog', 'tools', 100), src('skill', 'skills', 200), src('agentCatalog', 'agents', 50)],
      inputTokens: 0, cacheReadTokens: 1000, cacheCreateTokens: 0 },
    { turn: 2, sources: cur, inputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 500_000 },
  ]

  test('all 3 catalogs churn in one turn → PLUGINS_RELOADED, confidence high', () => {
    const r = analyzeCacheBreaks('s', reloadTurns(
      [src('toolCatalog', 'tools', 120), src('skill', 'skills', 250), src('agentCatalog', 'agents', 60)]))
    const t2 = r.turns[1]
    assert.strictEqual(t2.cause, 'PLUGINS_RELOADED')
    assert.strictEqual(t2.confidence, 'high')
    assert.strictEqual(t2.wastedTokens, 500_000)
    assert.ok(t2.broke)
  })

  test('exactly 2 catalogs churn → PLUGINS_RELOADED, confidence medium', () => {
    // agentCatalog unchanged (50→50); tool + skill catalogs resized.
    const r = analyzeCacheBreaks('s', reloadTurns(
      [src('toolCatalog', 'tools', 120), src('skill', 'skills', 250), src('agentCatalog', 'agents', 50)]))
    assert.strictEqual(r.turns[1].cause, 'PLUGINS_RELOADED')
    assert.strictEqual(r.turns[1].confidence, 'medium')
  })

  test('only 1 catalog changes → NOT a reload (stays the single-block cause)', () => {
    // Only the skill catalog resized; tools + agents identical → single-catalog change, not a reload.
    const r = analyzeCacheBreaks('s', reloadTurns(
      [src('toolCatalog', 'tools', 100), src('skill', 'skills', 250), src('agentCatalog', 'agents', 50)]))
    assert.notStrictEqual(r.turns[1].cause, 'PLUGINS_RELOADED')
    // This used to assert `confidence === undefined` as a PROXY for "not a reload". That proxy died
    // when TRDD-V8YOWHVT gave every set-diff attribution `confidence: 'low'`. Assert the intent
    // directly instead — and more strictly than before: it is a low-confidence, set-diff-derived
    // single-block attribution, NOT a reload verdict (which alone carries 'high'/'medium').
    assert.strictEqual(r.turns[1].attribution, 'block-diff-only')
    assert.strictEqual(r.turns[1].confidence, 'low')
    assert.ok(!['high', 'medium'].includes(String(r.turns[1].confidence)), 'reload confidences must not appear here')
  })

  test('catalogs appearing for the FIRST time (session warmup) is NOT a reload', () => {
    // Turn 1 has no catalog sources; turn 2 injects all 3. That is initial establishment, not a
    // /reload-plugins RE-registration — the prevKinds guard must not mislabel it (the turn-2 false positive).
    const turns: CacheTurnInput[] = [
      { turn: 1, sources: [src('file', 'CLAUDE.md', 100)], inputTokens: 0, cacheReadTokens: 1000, cacheCreateTokens: 0 },
      { turn: 2, sources: [src('file', 'CLAUDE.md', 100), src('toolCatalog', 'tools', 120), src('skill', 'skills', 250), src('agentCatalog', 'agents', 60)],
        inputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 500_000 },
    ]
    assert.notStrictEqual(analyzeCacheBreaks('s', turns).turns[1].cause, 'PLUGINS_RELOADED')
  })
})

// ATTRIBUTION PROVENANCE (TRDD-V8YOWHVT).
//
// This analyzer set-diffs injected context blocks and names the first one that changed. That is NOT
// the API's criterion: it caches the prefix ending at a `cache_control` breakpoint and looks back at
// most 20 blocks, so a block changing after the governing breakpoint cannot have caused the miss and
// a break can happen with no block changed at all. Measured 2026-08-04 on live bodies: `system[0]`
// changes on EVERY request while those same turns bill 0.3-0.7% write — which alone disproves
// "first changed block wins". This path cannot do better (ContextSource has no positions and no
// cache_control), so it must not present its guess as a verdict. These tests pin that honesty.
suite('cacheBreak attribution provenance (TRDD-V8YOWHVT)', () => {
  const src = (label: string, tokens: number, kind = 'hook'): ContextSource =>
    ({ label, kind, tokens, bytes: tokens * 4, count: 1 })

  const pair = (a: ContextSource[], b: ContextSource[], read: number, write: number): CacheTurnInput[] => [
    { turn: 1, sources: a, cacheReadTokens: 0, cacheCreateTokens: 1000, inputTokens: 0, model: 'claude-opus-5' },
    { turn: 2, sources: b, cacheReadTokens: read, cacheCreateTokens: write, inputTokens: 0, model: 'claude-opus-5' },
  ]

  test('a set-diff culprit is labelled block-diff-only at LOW confidence, never as a verdict', () => {
    const t = analyzeCacheBreaks('s', pair([src('hook: x', 100)], [src('hook: x', 900)], 50_000, 2_000)).turns[1]
    assert.strictEqual(t.broke, true)
    assert.strictEqual(t.breakSourceLabel, 'hook: x', 'it may still NAME a suspect')
    assert.strictEqual(t.attribution, 'block-diff-only', 'but it must disclose how it got there')
    assert.strictEqual(t.confidence, 'low', 'and must not imply the answer is verified')
  })

  test('a DOMINANT write with nothing to blame is UNATTRIBUTABLE, not silently "no break"', () => {
    // Identical sources: the diff has nothing to point at. But 400k written against 40k read is a
    // real cold rewrite — reporting it as broke:false would hide the costliest event there is.
    const same = [src('hook: x', 100)]
    const t = analyzeCacheBreaks('s', pair(same, [src('hook: x', 100)], 40_000, 400_000)).turns[1]
    assert.strictEqual(t.cause, 'UNATTRIBUTABLE')
    assert.strictEqual(t.broke, true, 'an expensive event must be visible')
    assert.strictEqual(t.wastedTokens, 400_000, 'and must carry its real cost')
    assert.ok(!t.breakSourceLabel, 'but must NOT name a culprit it cannot justify')
    assert.match(String(t.remediation), /get_cache_break_timeline/, 'it should route to the breakpoint-aware tool')
  })

  test('a MODEST write with nothing to blame stays silent — this must not become a false-positive generator', () => {
    // The guard on the rule above: ordinary suffix writing (2k written, 400k re-read warm) is what
    // every healthy turn looks like. If UNATTRIBUTABLE fired here it would flag every turn as a break.
    const same = [src('hook: x', 100)]
    const t = analyzeCacheBreaks('s', pair(same, [src('hook: x', 100)], 400_000, 2_000)).turns[1]
    assert.strictEqual(t.broke, false)
    assert.strictEqual(t.cause, 'UNKNOWN')
    assert.strictEqual(t.wastedTokens, 0)
  })

  test('UNATTRIBUTABLE turns still rank as offenders so the cost is not lost from the leaderboard', () => {
    const same = [src('hook: x', 100)]
    const r = analyzeCacheBreaks('s', pair(same, [src('hook: x', 100)], 40_000, 400_000))
    assert.strictEqual(r.totalWastedTokens, 400_000)
    assert.strictEqual(r.offenders[0].cause, 'UNATTRIBUTABLE')
  })
})
