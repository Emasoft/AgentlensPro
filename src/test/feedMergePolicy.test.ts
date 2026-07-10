import * as assert from 'assert'
import { preferredDataSource, mergeOtelAndLogSessions } from '../feedMergePolicy'
import type { SessionSummaryCard } from '../summarizers/summarizerTypes'

// ── Phase B of the token-feed fix (reports/token-discrepancy/20260710_141134+0200-otel-vs-jsonl.md
// §4bis/§5.6): once OTEL Claude cards are keyed by the transcript UUID they collide with the log
// cards — and for Claude the LOG card must win (transcripts are durable + call-complete; OTEL is a
// measured lossy lower bound). Non-Claude sources keep the original "OTEL wins" rule.

function makeCard(id: string, overrides: Partial<SessionSummaryCard> = {}): SessionSummaryCard {
  return {
    sessionId: id, traceId: 'trace-' + id, source: 'claude_code', dataSource: 'otel', workspace: 'ws',
    userRequest: 'test', model: 'claude-opus-4-8', turns: 1,
    inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreateTokens: 0,
    cacheHitRate: 0, durationMs: 1000, startTime: '2026-07-10T10:00:00.000Z',
    filesRead: [], filesSearched: [], filesChanged: [], filesWritten: [],
    toolCounts: {}, totalToolCalls: 0, totalLlmCalls: 1, errors: 0,
    outcome: 'text_response', timeline: [], backgroundSpans: [], loopSignals: [],
    ...overrides,
  }
}

suite('feedMergePolicy', () => {
  test('preferredDataSource: log for claude_code, otel for everything else', () => {
    assert.strictEqual(preferredDataSource('claude_code'), 'log')
    assert.strictEqual(preferredDataSource('copilot'), 'otel')
    assert.strictEqual(preferredDataSource('codex'), 'otel')
    assert.strictEqual(preferredDataSource('opencode'), 'otel')
  })

  test('Claude log + OTEL cards for the same UUID serve as exactly ONE card carrying the log totals', () => {
    const uuid = '65c9218c-aaaa-bbbb-cccc-4af26a6bdfc0'
    // Real measured shape (report §2a): log card carries the transcript's call-complete totals;
    // the OTEL twin's differ (sub-agent calls merged in, eviction/downtime losses).
    const log = makeCard(uuid, { dataSource: 'log', inputTokens: 38359, outputTokens: 65262, cacheReadTokens: 11850042, cacheCreateTokens: 298222 })
    const otel = makeCard(uuid, { dataSource: 'otel', inputTokens: 39133, outputTokens: 65279, cacheReadTokens: 11850042, cacheCreateTokens: 298222 })
    const merged = mergeOtelAndLogSessions([otel], [log])
    assert.strictEqual(merged.length, 1)
    assert.strictEqual(merged[0].dataSource, 'log', 'the log card wins the collision for Claude')
    assert.strictEqual(merged[0].inputTokens, 38359, 'served totals are the transcript totals')
    assert.strictEqual(merged[0].outputTokens, 65262)
  })

  test('an OTEL-only Claude UUID (no transcript) still serves', () => {
    const log = makeCard('uuid-with-log', { dataSource: 'log' })
    const otelOnly = makeCard('uuid-otel-only', { dataSource: 'otel', inputTokens: 774 })
    const merged = mergeOtelAndLogSessions([otelOnly], [log])
    assert.strictEqual(merged.length, 2)
    const kept = merged.find(s => s.sessionId === 'uuid-otel-only')
    assert.ok(kept, 'OTEL-only sessions are never dropped')
    assert.strictEqual(kept!.dataSource, 'otel')
  })

  test('a log-only Claude session (no OTEL twin) still serves', () => {
    const log = makeCard('uuid-log-only', { dataSource: 'log' })
    const merged = mergeOtelAndLogSessions([], [log])
    assert.strictEqual(merged.length, 1)
    assert.strictEqual(merged[0].sessionId, 'uuid-log-only')
  })

  test('non-Claude sources keep the original rule: OTEL wins on ID collision', () => {
    const log = makeCard('copilot-1', { source: 'copilot', dataSource: 'log', inputTokens: 50 })
    const otel = makeCard('copilot-1', { source: 'copilot', dataSource: 'otel', inputTokens: 60 })
    const merged = mergeOtelAndLogSessions([otel], [log])
    assert.strictEqual(merged.length, 1)
    assert.strictEqual(merged[0].dataSource, 'otel')
    assert.strictEqual(merged[0].inputTokens, 60)
  })

  test('empty log list returns the OTEL list untouched', () => {
    const otel = [makeCard('a'), makeCard('b')]
    assert.deepStrictEqual(mergeOtelAndLogSessions(otel, []), otel)
  })
})
