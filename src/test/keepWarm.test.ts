import * as assert from 'assert'
import { computeKeepWarm, CACHE_TTL_MS } from '../shared/keepWarm'
import type { TimelineEntry } from '../shared/summarizerTypes'

// ── Keep-warm / cache-gap diagnostic (P6) ──────────────────────────────────────
// Pure-engine tests: gap classification against the 5-min prompt-cache TTL, wasted
// cache-write attribution, worst-gap measurement, and the honest-absence contract.

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
    assert.deepStrictEqual(r, { warmTurns: 0, coldTurns: 0, wastedWriteTokens: 0, worstGapMin: 0 })
  })

  test('gaps under the TTL classify every following turn warm', () => {
    // Three requests 1 min apart: two gaps, both warm; no waste.
    const r = computeKeepWarm([apiReq(0, 0, 200_000), apiReq(60_000, 200_000, 500), apiReq(120_000, 200_500, 400)])
    assert.deepStrictEqual(r, { warmTurns: 2, coldTurns: 0, wastedWriteTokens: 0, worstGapMin: 1 })
  })

  test('a ≥TTL gap followed by a prefix re-write classifies cold and attributes the wasted write', () => {
    // 6-min gap, then cacheCreate (180k) >> cacheRead (0): the measured cold-resume signature.
    const r = computeKeepWarm([apiReq(0, 0, 180_000), apiReq(6 * 60_000, 0, 180_000)])
    assert.deepStrictEqual(r, { warmTurns: 0, coldTurns: 1, wastedWriteTokens: 180_000, worstGapMin: 6 })
  })

  test('a ≥TTL gap WITHOUT the re-write signature lands in neither bucket (no observed penalty)', () => {
    // The TTL passed but the call read more cache than it wrote — claiming waste would be invented.
    const r = computeKeepWarm([apiReq(0, 0, 180_000), apiReq(6 * 60_000, 180_000, 900)])
    assert.deepStrictEqual(r, { warmTurns: 0, coldTurns: 0, wastedWriteTokens: 0, worstGapMin: 6 })
  })

  test('a gap of exactly the TTL is cold (TTL means expired), just under it is warm', () => {
    const atTtl = computeKeepWarm([apiReq(0, 0, 100_000), apiReq(CACHE_TTL_MS, 0, 100_000)])
    assert.strictEqual(atTtl?.coldTurns, 1)
    const under = computeKeepWarm([apiReq(0, 0, 100_000), apiReq(CACHE_TTL_MS - 1, 0, 100_000)])
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
    assert.deepStrictEqual(r, { warmTurns: 2, coldTurns: 2, wastedWriteTokens: 303_000, worstGapMin: 9 })
  })

  test('out-of-order timelines are sorted before measuring (merged sessions can interleave)', () => {
    // Same data as the cold-turn test, entries reversed: identical result required.
    const r = computeKeepWarm([apiReq(6 * 60_000, 0, 180_000), apiReq(0, 0, 180_000)])
    assert.deepStrictEqual(r, { warmTurns: 0, coldTurns: 1, wastedWriteTokens: 180_000, worstGapMin: 6 })
  })

  test('worstGapMin rounds to one decimal', () => {
    // 90s = 1.5 min exactly; warm turn (under TTL).
    const r = computeKeepWarm([apiReq(0, 0, 1000), apiReq(90_000, 1000, 100)])
    assert.strictEqual(r?.worstGapMin, 1.5)
  })
})
