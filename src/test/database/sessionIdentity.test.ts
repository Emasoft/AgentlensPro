import * as assert from 'assert'
import { dedupeSessionIdentities, flagUnpricedSessions } from '../../sessionRepository'
import { lookupRates, calcTokenCostUsd } from '../../shared/pricing'
import type { SessionSummaryCard } from '../../shared/summarizerTypes'

// TRDD-ZK37VG4X — cost + identity integrity: sonnet-5 pricing, unpriced fail-loud, session dedup.

function makeCard(id: string, startTime: string, overrides: Partial<SessionSummaryCard> = {}): SessionSummaryCard {
  return {
    sessionId: id, traceId: 'trace-' + id, source: 'claude_code', dataSource: 'log', workspace: 'ws',
    userRequest: 'test', model: 'claude-opus-4-8', turns: 1,
    inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreateTokens: 0,
    cacheHitRate: 0, durationMs: 1000, startTime,
    filesRead: [], filesSearched: [], filesChanged: [], filesWritten: [],
    toolCounts: {}, totalToolCalls: 0, totalLlmCalls: 1, errors: 0,
    outcome: 'text_response', timeline: [], backgroundSpans: [], loopSignals: [],
    ...overrides,
  }
}

suite('pricing — claude-sonnet-5 (TRDD-ZK37VG4X spec 1)', () => {
  test('claude-sonnet-5 has a rate-table entry (was missing → silent $0 sessions)', () => {
    // Pinned to a promo-era timestamp: from 2026-09-01 the scheduled change bills $3/$15, so an
    // undated lookup (= today) would correctly return sticker rates and fail these intro asserts.
    const rates = lookupRates('claude-sonnet-5', '2026-08-15T12:00:00Z')
    assert.ok(rates, 'claude-sonnet-5 must resolve to rates')
    // Introductory pricing through 2026-08-31: $2/$10 per MTok, cache 0.1x/1.25x of input.
    assert.strictEqual(rates!.inputPerMTok, 2.00)
    assert.strictEqual(rates!.cacheReadPerMTok, 0.20)
    assert.strictEqual(rates!.cacheWritePerMTok, 2.50)
    assert.strictEqual(rates!.outputPerMTok, 10.00)
    assert.strictEqual(rates!.contextWindowTokens, 1_000_000)
  })

  test('claude-sonnet-5 session cost is non-zero and matches the intro rates', () => {
    // 1M tokens in each bucket → 2 + 0.2 + 2.5 + 10 = 14.7 USD at intro pricing.
    const cost = calcTokenCostUsd(1_000_000, 1_000_000, 1_000_000, 1_000_000, 'claude-sonnet-5', 0, '2026-08-15T12:00:00Z')
    assert.ok(Math.abs(cost - 14.7) < 1e-9, `expected 14.7, got ${cost}`)
  })

  test('claude-mythos-5 (Fable-5 twin) has a rate-table entry', () => {
    const rates = lookupRates('claude-mythos-5')
    assert.ok(rates)
    assert.strictEqual(rates!.inputPerMTok, 10.00)
    assert.strictEqual(rates!.outputPerMTok, 50.00)
  })

  test('a dated claude-sonnet-5 model id normalizes onto the same entry', () => {
    assert.ok(lookupRates('claude-sonnet-5-20260601'))
  })

  test('an unknown model returns null rates and $0 raw cost (the flag, not the table, carries the alarm)', () => {
    assert.strictEqual(lookupRates('totally-unknown-model-xyz'), null)
    assert.strictEqual(calcTokenCostUsd(1_000_000, 0, 0, 1_000_000, 'totally-unknown-model-xyz'), 0)
  })
})

suite('flagUnpricedSessions — unknown-model fail-loud (TRDD-ZK37VG4X spec 1)', () => {
  test('a session with token traffic and an unknown model is flagged unpriced', () => {
    const s = makeCard('a', '2026-07-01T00:00:00.000Z', { model: 'mystery-model-9' })
    flagUnpricedSessions([s])
    assert.strictEqual(s.unpriced, true)
  })

  test('a session with a priced model is NOT flagged', () => {
    const s = makeCard('b', '2026-07-01T00:00:00.000Z', { model: 'claude-sonnet-5' })
    flagUnpricedSessions([s])
    assert.strictEqual(s.unpriced, undefined)
  })

  test('a zero-traffic session is never flagged even with an unknown model (no cost to misstate)', () => {
    const s = makeCard('c', '2026-07-01T00:00:00.000Z', {
      model: 'mystery-model-9', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0,
    })
    flagUnpricedSessions([s])
    assert.strictEqual(s.unpriced, undefined)
  })

  test('an empty model id with traffic is flagged (junk rows must not price at $0 silently)', () => {
    const s = makeCard('d', '2026-07-01T00:00:00.000Z', { model: '' })
    flagUnpricedSessions([s])
    assert.strictEqual(s.unpriced, true)
  })
})

suite('dedupeSessionIdentities — synth/real twins (TRDD-ZK37VG4X spec 2)', () => {
  const T0 = '2026-07-01T10:00:00.000Z'
  const T0_PLUS_2M = '2026-07-01T10:02:00.000Z'
  const T0_PLUS_20M = '2026-07-01T10:20:00.000Z'
  const usage = { inputTokens: 12345, outputTokens: 678, cacheReadTokens: 90000, cacheCreateTokens: 4321 }

  test('a synth-* OTEL placeholder merges with its real log twin and takes the REAL id', () => {
    const synth = makeCard('synth-abc123def456', T0, { ...usage, dataSource: 'otel', userRequest: '' })
    const real = makeCard('0ca3718286b47699', T0_PLUS_2M, { ...usage, dataSource: 'log', userRequest: 'do the thing' })
    const out = dedupeSessionIdentities([synth, real])
    assert.strictEqual(out.length, 1)
    // Claude cards: the LOG twin wins the data (token-feed Phase B doctrine — transcripts are
    // durable + call-complete, OTEL is a lossy lower bound) and it already carries the real id.
    assert.strictEqual(out[0].sessionId, '0ca3718286b47699')
    assert.strictEqual(out[0].dataSource, 'log')
    assert.ok(out[0].mergedFrom!.includes('synth-abc123def456'), 'merge must be auditable via mergedFrom')
    assert.strictEqual(out[0].userRequest, 'do the thing')
    // P7 provenance — absorbing the OTHER feed's twin is the one genuinely MERGED outcome.
    assert.strictEqual(out[0].tokensSource, 'merged')
    assert.ok(out[0].coverageNote && out[0].coverageNote.includes('Identity-merged'), 'the cross-feed merge is disclosed')
  })

  test('non-Claude twins keep the original preference: the OTEL card wins the data', () => {
    const log = makeCard('copilot-log', T0, { ...usage, source: 'copilot', dataSource: 'log', timeline: [] })
    const otel = makeCard('copilot-otel', T0_PLUS_2M, { ...usage, source: 'copilot', dataSource: 'otel', timeline: [] })
    const out = dedupeSessionIdentities([log, otel])
    assert.strictEqual(out.length, 1)
    assert.strictEqual(out[0].dataSource, 'otel')
    assert.ok(out[0].mergedFrom!.includes('copilot-log'))
    // P7 provenance — cross-feed absorption stamps 'merged' regardless of which feed won.
    assert.strictEqual(out[0].tokensSource, 'merged')
  })

  test('two ids with byte-identical usage within the window collapse to one card', () => {
    const a = makeCard('55f9679cc5bea882', T0, { ...usage, timeline: [] })
    const b = makeCard('0ca3718286b47699', T0_PLUS_2M, { ...usage })
    const out = dedupeSessionIdentities([a, b])
    assert.strictEqual(out.length, 1)
    assert.ok(out[0].mergedFrom!.length === 1)
    // P7 provenance — a SAME-feed (log+log) absorption is not a cross-feed merge: no fabricated
    // 'merged' stamp; these fixture cards were never stamped, so they stay undefined ("unknown").
    assert.strictEqual(out[0].tokensSource, undefined)
  })

  test('identical usage but >10 minutes apart stays separate (window guards false merges)', () => {
    const a = makeCard('x1', T0, { ...usage })
    const b = makeCard('x2', T0_PLUS_20M, { ...usage })
    assert.strictEqual(dedupeSessionIdentities([a, b]).length, 2)
  })

  test('different usage fingerprints never merge', () => {
    const a = makeCard('y1', T0, { ...usage })
    const b = makeCard('y2', T0, { ...usage, outputTokens: usage.outputTokens + 1 })
    assert.strictEqual(dedupeSessionIdentities([a, b]).length, 2)
  })

  test('zero-traffic cards are never merged (all-zero fingerprints collide constantly)', () => {
    const a = makeCard('z1', T0, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 })
    const b = makeCard('z2', T0, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 })
    assert.strictEqual(dedupeSessionIdentities([a, b]).length, 2)
  })

  test('different models with identical token buckets never merge (model is part of the fingerprint)', () => {
    const a = makeCard('m1', T0, { ...usage, model: 'claude-opus-4-8' })
    const b = makeCard('m2', T0, { ...usage, model: 'claude-sonnet-5' })
    assert.strictEqual(dedupeSessionIdentities([a, b]).length, 2)
  })
})
