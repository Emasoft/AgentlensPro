import * as assert from 'assert'
import { computeKeepWarm } from '../shared/keepWarm'
import { ASSUMED_TTL_REGIME, TTL_5M_MS, classifyTtlRegime, type TtlContext } from '../shared/cacheTtl'
import type { TimelineEntry } from '../shared/summarizerTypes'

// ── Keep-warm / cache-gap diagnostic (P6 + TRDD-VY1IUVUM) ─────────────────────
// Pure-engine tests: gap classification against the SESSION's TTL regime (not a global 5-min
// constant), wasted cache-write attribution, worst-gap measurement, the honest-absence contract,
// and the measured falsifier (a cache hit after the assumed expiry contradicts the assumption).

const T0 = Date.parse('2026-07-10T10:00:00.000Z')

function apiReq(offsetMs: number, cacheRead: number, cacheCreate: number): TimelineEntry {
  return {
    type: 'api_request', spanId: `s-${offsetMs}`, label: 'api_request', durationMs: 1000,
    isError: false, timestamp: new Date(T0 + offsetMs).toISOString(),
    cacheReadTokens: cacheRead, cacheCreateTokens: cacheCreate,
  }
}

function llmEntry(offsetMs: number): TimelineEntry {
  return {
    type: 'llm', spanId: `l-${offsetMs}`, label: 'llm_request', durationMs: 1000,
    isError: false, timestamp: new Date(T0 + offsetMs).toISOString(),
  }
}

// Every legacy expectation ran on the (implicit) 5-min TTL; that is now the ASSUMED regime, and
// the report must SAY so — these are the TTL fields every uncontradicted assumed-regime report
// carries. Kept as one object so a report-shape change breaks exactly one place.
const ASSUMED_FIELDS = {
  ttlAssumedMin: 5,
  ttlSource: 'assumed' as const,
  ttlContradicted: false,
  measuredWarmGapMin: null,
  ttlBasis: ASSUMED_TTL_REGIME.ttlBasis,
}

const machineCtx = (auth: TtlContext['auth'], over: Partial<TtlContext> = {}): TtlContext =>
  ({ auth, force5m: false, enable1h: false, ...over })

suite('shared/keepWarm — computeKeepWarm (P6 cache-gap diagnostic)', () => {
  test('honest absence: no api_request entries → null, never zeros presented as measurements', () => {
    // A timeline of only llm/tool entries has no per-call cache ground truth to measure.
    assert.strictEqual(computeKeepWarm([]), null)
    assert.strictEqual(computeKeepWarm([llmEntry(0), llmEntry(60_000)]), null)
  })

  test('an api_request with an unparseable timestamp is dropped, not defaulted', () => {
    // A fabricated ts would fabricate a gap — one bad entry must not poison the measurement.
    const bad: TimelineEntry = { ...apiReq(0, 0, 100), timestamp: 'not-a-date' }
    assert.strictEqual(computeKeepWarm([bad]), null)
  })

  test('a single api_request measures (report, not null) but classifies no turns', () => {
    // The first request of a session follows no gap — its cache write is the unavoidable warm-up.
    const r = computeKeepWarm([apiReq(0, 0, 50_000)])
    assert.deepStrictEqual(r, { warmTurns: 0, coldTurns: 0, wastedWriteTokens: 0, worstGapMin: 0, ...ASSUMED_FIELDS })
  })

  test('no regime passed → the report says ttlSource assumed (never a silent guess)', () => {
    const r = computeKeepWarm([apiReq(0, 0, 50_000)])
    assert.strictEqual(r?.ttlSource, 'assumed')
    assert.strictEqual(r?.ttlAssumedMin, 5)
  })

  test('gaps under the TTL classify every following turn warm', () => {
    // Three requests 1 min apart: two gaps, both warm; no waste.
    const r = computeKeepWarm([apiReq(0, 0, 200_000), apiReq(60_000, 200_000, 500), apiReq(120_000, 200_500, 400)])
    assert.deepStrictEqual(r, { warmTurns: 2, coldTurns: 0, wastedWriteTokens: 0, worstGapMin: 1, ...ASSUMED_FIELDS })
  })

  test('a ≥TTL gap followed by a prefix re-write classifies cold and attributes the wasted write', () => {
    // 6-min gap, then cacheCreate (180k) >> cacheRead (0): the measured cold-resume signature.
    const r = computeKeepWarm([apiReq(0, 0, 180_000), apiReq(6 * 60_000, 0, 180_000)])
    assert.deepStrictEqual(r, { warmTurns: 0, coldTurns: 1, wastedWriteTokens: 180_000, worstGapMin: 6, ...ASSUMED_FIELDS })
  })

  test('a ≥TTL gap with neither the re-write nor the warm-hit signature lands in neither bucket', () => {
    // cr=900 (below the 1k warm floor), cc=700 (< cr, no re-write): the TTL passed but no penalty
    // was observed AND nothing proves survival — claiming either would be invented.
    const r = computeKeepWarm([apiReq(0, 0, 180_000), apiReq(6 * 60_000, 900, 700)])
    assert.deepStrictEqual(r, { warmTurns: 0, coldTurns: 0, wastedWriteTokens: 0, worstGapMin: 6, ...ASSUMED_FIELDS })
  })

  test('a gap of exactly the TTL is cold (TTL means expired), just under it is warm', () => {
    const atTtl = computeKeepWarm([apiReq(0, 0, 100_000), apiReq(TTL_5M_MS, 0, 100_000)])
    assert.strictEqual(atTtl?.coldTurns, 1)
    const under = computeKeepWarm([apiReq(0, 0, 100_000), apiReq(TTL_5M_MS - 1, 0, 100_000)])
    assert.strictEqual(under?.warmTurns, 1)
    assert.strictEqual(under?.coldTurns, 0)
  })

  test('mixed cadence: warm and cold turns accumulate independently; worstGapMin is the max', () => {
    // warm (1min) → cold (9min, re-write) → warm (30s) → cold (7min, re-write).
    const r = computeKeepWarm([
      apiReq(0, 0, 150_000),
      apiReq(60_000, 150_000, 800),                    // warm
      apiReq(60_000 + 9 * 60_000, 0, 151_000),         // cold: 151k wasted
      apiReq(60_000 + 9 * 60_000 + 30_000, 151_000, 600), // warm
      apiReq(60_000 + 9 * 60_000 + 30_000 + 7 * 60_000, 0, 152_000), // cold: 152k wasted
    ])
    assert.deepStrictEqual(r, { warmTurns: 2, coldTurns: 2, wastedWriteTokens: 303_000, worstGapMin: 9, ...ASSUMED_FIELDS })
  })

  test('out-of-order timelines are sorted before measuring (merged sessions can interleave)', () => {
    // Same data as the cold-turn test, entries reversed: identical result required.
    const r = computeKeepWarm([apiReq(6 * 60_000, 0, 180_000), apiReq(0, 0, 180_000)])
    assert.deepStrictEqual(r, { warmTurns: 0, coldTurns: 1, wastedWriteTokens: 180_000, worstGapMin: 6, ...ASSUMED_FIELDS })
  })

  test('worstGapMin rounds to one decimal', () => {
    // 90s = 1.5 min exactly; warm turn (under TTL).
    const r = computeKeepWarm([apiReq(0, 0, 1000), apiReq(90_000, 1000, 100)])
    assert.strictEqual(r?.worstGapMin, 1.5)
  })
})

suite('shared/keepWarm — TTL-regime awareness (TRDD-VY1IUVUM acceptance matrix)', () => {
  // THE acceptance fixture: the SAME 20-min-gap session (full-prefix re-write after the gap) must
  // classify by regime — warm on a subscription MAIN session (1h tier), cold on a subagent
  // (5-min always), cold under usage-credits (dropped to 5-min), and FORCE_PROMPT_CACHING_5M wins.
  const twentyMinGap = [apiReq(0, 0, 220_000), apiReq(20 * 60_000, 0, 220_000)]

  test('main + subscription (1h tier): the 20-min gap is WARM, doc-matrix provenance', () => {
    const r = computeKeepWarm(twentyMinGap, classifyTtlRegime('main', machineCtx('subscription')))
    assert.strictEqual(r?.warmTurns, 1)
    assert.strictEqual(r?.coldTurns, 0)
    assert.strictEqual(r?.wastedWriteTokens, 0)
    assert.strictEqual(r?.ttlAssumedMin, 60)
    assert.strictEqual(r?.ttlSource, 'doc-matrix')
  })

  test('subagent (any auth): the SAME 20-min gap is COLD — subagents ride the 5-min tier always', () => {
    const r = computeKeepWarm(twentyMinGap, classifyTtlRegime('subagent', machineCtx('subscription')))
    assert.strictEqual(r?.coldTurns, 1)
    assert.strictEqual(r?.wastedWriteTokens, 220_000)
    assert.strictEqual(r?.ttlAssumedMin, 5)
    assert.strictEqual(r?.ttlSource, 'doc-matrix')
  })

  test('main + usage-credits (over plan limit): the SAME 20-min gap is COLD (5-min tier)', () => {
    const r = computeKeepWarm(twentyMinGap, classifyTtlRegime('main', machineCtx('usage-credits')))
    assert.strictEqual(r?.coldTurns, 1)
    assert.strictEqual(r?.ttlAssumedMin, 5)
    assert.strictEqual(r?.ttlSource, 'doc-matrix')
  })

  test('FORCE_PROMPT_CACHING_5M wins over the subscription 1h tier: 20-min gap COLD, config provenance', () => {
    const r = computeKeepWarm(twentyMinGap, classifyTtlRegime('main', machineCtx('subscription', { force5m: true })))
    assert.strictEqual(r?.coldTurns, 1)
    assert.strictEqual(r?.ttlAssumedMin, 5)
    assert.strictEqual(r?.ttlSource, 'config')
  })

  test('fork reads the PARENT entry: rides the main-conversation regime (warm at 20min on subscription)', () => {
    const r = computeKeepWarm(twentyMinGap, classifyTtlRegime('fork', machineCtx('subscription')))
    assert.strictEqual(r?.warmTurns, 1)
    assert.strictEqual(r?.ttlAssumedMin, 60)
  })
})

suite('shared/keepWarm — the measured falsifier (cache hit after assumed expiry)', () => {
  test('gap 20min + warm cache hit under an assumed 5m regime → flagged, ttlSource flips to measured', () => {
    // The TRDD acceptance fixture: cacheRead 240k with a 3k suffix write, 20 minutes after the
    // previous call, while the regime says the entry died at 5 — the entry PROVABLY survived.
    const r = computeKeepWarm([apiReq(0, 0, 240_000), apiReq(20 * 60_000, 240_000, 3_000)])
    assert.strictEqual(r?.ttlContradicted, true)
    assert.strictEqual(r?.ttlSource, 'measured')
    assert.strictEqual(r?.measuredWarmGapMin, 20)
    // The measured floor snaps to the only other tier that exists (1h) — the contradicting turn
    // itself classifies WARM, not "neither bucket".
    assert.strictEqual(r?.ttlAssumedMin, 60)
    assert.strictEqual(r?.warmTurns, 1)
    assert.ok(r?.ttlBasis.includes('CONTRADICTED'), r?.ttlBasis)
  })

  test('the measured floor re-classifies OTHER gaps of the same session too (no half-applied TTL)', () => {
    // 20-min survival proves the 1h tier → the separate 30-min-gap re-write is judged against 1h
    // (warm), not against the falsified 5m assumption.
    const r = computeKeepWarm([
      apiReq(0, 0, 240_000),
      apiReq(20 * 60_000, 240_000, 3_000),              // the falsifying warm hit
      apiReq(20 * 60_000 + 30 * 60_000, 241_000, 2_000), // 30-min gap, still warm under 1h
    ])
    assert.strictEqual(r?.warmTurns, 2)
    assert.strictEqual(r?.coldTurns, 0)
  })

  test('a contradiction also falsifies a CONFIG regime — physical evidence beats env detection', () => {
    // FORCE_PROMPT_CACHING_5M detected on THIS machine does not prove the observed session ran
    // with it (env detection is process-scoped, sessions are not). A measured survival wins.
    const regime = classifyTtlRegime('main', machineCtx('api-key', { force5m: true }))
    const r = computeKeepWarm([apiReq(0, 0, 240_000), apiReq(20 * 60_000, 240_000, 3_000)], regime)
    assert.strictEqual(r?.ttlSource, 'measured')
    assert.strictEqual(r?.ttlContradicted, true)
  })

  test('no contradiction under a 1h regime: a 20-min warm hit is EXPECTED there, not evidence', () => {
    const regime = classifyTtlRegime('main', machineCtx('subscription'))
    const r = computeKeepWarm([apiReq(0, 0, 240_000), apiReq(20 * 60_000, 240_000, 3_000)], regime)
    assert.strictEqual(r?.ttlContradicted, false)
    assert.strictEqual(r?.ttlSource, 'doc-matrix')
    assert.strictEqual(r?.measuredWarmGapMin, null)
  })

  test('an off-matrix >1h survival classifies against the observation itself, never a smaller tier', () => {
    // 75-min warm hit under an assumed 5m regime: no doc tier explains it (timer-reset semantics
    // or a doc change) — the effective TTL follows the measurement, ttlAssumedMin ≥ 75.
    const r = computeKeepWarm([apiReq(0, 0, 240_000), apiReq(75 * 60_000, 240_000, 3_000)])
    assert.strictEqual(r?.ttlContradicted, true)
    assert.strictEqual(r?.measuredWarmGapMin, 75)
    assert.ok((r?.ttlAssumedMin ?? 0) >= 75, String(r?.ttlAssumedMin))
    assert.strictEqual(r?.warmTurns, 1)
  })

  test('a small read after the gap is NOT a warm hit (1k floor): no false contradiction', () => {
    // cr=800 < 1k floor — a trivial prefix "hit" proves nothing about the big entry's survival.
    const r = computeKeepWarm([apiReq(0, 0, 240_000), apiReq(20 * 60_000, 800, 100)])
    assert.strictEqual(r?.ttlContradicted, false)
    assert.strictEqual(r?.ttlSource, 'assumed')
  })
})
