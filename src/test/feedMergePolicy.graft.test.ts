// TRDD-5GFSFX0Q — the timeline attribution graft: the Phase B log-wins merge drops the OTEL card,
// but its `api_request` entries are the ONLY per-call attribution feed (exact cost + skill/agent/
// plugin causes). graftOtelAttribution moves that one timeline dimension onto the served log card.
import * as assert from 'assert'
import { graftOtelAttribution } from '../feedMergePolicy'
import type { TimelineEntry } from '../shared/summarizerTypes'

const entry = (over: Partial<TimelineEntry>): TimelineEntry => ({
  type: 'llm', spanId: 's', label: 'l', durationMs: 0, isError: false, timestamp: '2026-07-16T10:00:00.000Z',
  ...over,
} as TimelineEntry)

const logTimeline = (): TimelineEntry[] => [
  entry({ type: 'user_input', spanId: 'u1', timestamp: '2026-07-16T10:00:00.000Z' }),
  entry({ type: 'llm', spanId: 'l1', timestamp: '2026-07-16T10:00:05.000Z' }),
  entry({ type: 'tool', spanId: 't1', timestamp: '2026-07-16T10:00:07.000Z' }),
]

suite('feedMergePolicy — graftOtelAttribution (TRDD-5GFSFX0Q)', () => {
  test('grafts ONLY api_request entries, chronologically interleaved by timestamp', () => {
    const otel = [
      entry({ type: 'api_request', spanId: 'a1', skillName: 'commit', timestamp: '2026-07-16T10:00:06.000Z' }),
      entry({ type: 'llm', spanId: 'ol1', timestamp: '2026-07-16T10:00:06.500Z' }), // OTEL llm must NOT graft (would double the call)
      entry({ type: 'api_request', spanId: 'a2', agentName: 'spark', timestamp: '2026-07-16T10:00:09.000Z' }),
    ]
    const out = graftOtelAttribution(logTimeline(), otel)
    assert.deepStrictEqual(out.map(e => e.spanId), ['u1', 'l1', 'a1', 't1', 'a2'], 'sorted by timestamp, api_request only')
    const grafted = out.filter(e => e.type === 'api_request')
    assert.strictEqual(grafted.length, 2)
    assert.strictEqual(grafted[0].skillName, 'commit', 'attribution fields survive the graft')
  })

  test('pure: neither input array is mutated', () => {
    const log = logTimeline()
    const otel = [entry({ type: 'api_request', spanId: 'a1' })]
    const logSnapshot = [...log]
    const otelSnapshot = [...otel]
    graftOtelAttribution(log, otel)
    assert.deepStrictEqual(log, logSnapshot)
    assert.deepStrictEqual(otel, otelSnapshot)
  })

  test('empty or absent OTEL side returns the log timeline unchanged (same reference)', () => {
    const log = logTimeline()
    assert.strictEqual(graftOtelAttribution(log, []), log)
    assert.strictEqual(graftOtelAttribution(log, undefined), log)
    assert.strictEqual(graftOtelAttribution(log, [entry({ type: 'llm', spanId: 'x' })]), log, 'no api_request entries → identity')
  })

  test('dedupes by spanId against api_request entries already present (idempotent re-graft)', () => {
    const otel = [entry({ type: 'api_request', spanId: 'a1', timestamp: '2026-07-16T10:00:06.000Z' })]
    const once = graftOtelAttribution(logTimeline(), otel)
    const twice = graftOtelAttribution(once, otel)
    assert.strictEqual(twice, once, 'second graft of the same entries is identity')
    assert.strictEqual(twice.filter(e => e.type === 'api_request').length, 1)
  })
})
