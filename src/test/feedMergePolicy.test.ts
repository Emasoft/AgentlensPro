import * as assert from 'assert'
import { preferredDataSource, mergeOtelAndLogSessions, OTEL_DISPLACED_NOTE, stampIdentityMerge } from '../feedMergePolicy'
import type { SessionSummaryCard } from '../shared/summarizerTypes'

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
    // P7 provenance — the log-wins outcome stamps 'log' + the displacement note.
    assert.strictEqual(merged[0].tokensSource, 'log')
    assert.strictEqual(merged[0].coverageNote, OTEL_DISPLACED_NOTE, 'the displaced OTEL twin is disclosed')
  })

  test('an OTEL-only Claude UUID (no transcript) still serves', () => {
    const log = makeCard('uuid-with-log', { dataSource: 'log' })
    const otelOnly = makeCard('uuid-otel-only', { dataSource: 'otel', inputTokens: 774 })
    const merged = mergeOtelAndLogSessions([otelOnly], [log])
    assert.strictEqual(merged.length, 2)
    const kept = merged.find(s => s.sessionId === 'uuid-otel-only')
    assert.ok(kept, 'OTEL-only sessions are never dropped')
    assert.strictEqual(kept!.dataSource, 'otel')
    // P7 provenance — the OTEL-only outcome stamps 'otel', no displacement to disclose.
    assert.strictEqual(kept!.tokensSource, 'otel')
    assert.strictEqual(kept!.coverageNote, undefined)
  })

  test('a log-only Claude session (no OTEL twin) still serves', () => {
    const log = makeCard('uuid-log-only', { dataSource: 'log' })
    const merged = mergeOtelAndLogSessions([], [log])
    assert.strictEqual(merged.length, 1)
    assert.strictEqual(merged[0].sessionId, 'uuid-log-only')
    // P7 provenance — log-only through the merge: plain 'log', nothing displaced.
    assert.strictEqual(merged[0].tokensSource, 'log')
    assert.strictEqual(merged[0].coverageNote, undefined)
  })

  test('non-Claude sources keep the original rule: OTEL wins on ID collision', () => {
    const log = makeCard('copilot-1', { source: 'copilot', dataSource: 'log', inputTokens: 50 })
    const otel = makeCard('copilot-1', { source: 'copilot', dataSource: 'otel', inputTokens: 60 })
    const merged = mergeOtelAndLogSessions([otel], [log])
    assert.strictEqual(merged.length, 1)
    assert.strictEqual(merged[0].dataSource, 'otel')
    assert.strictEqual(merged[0].inputTokens, 60)
    // P7 provenance — OTEL won, so the served numbers are OTEL-backed.
    assert.strictEqual(merged[0].tokensSource, 'otel')
  })

  test('empty log list returns the OTEL list, each card stamped as OTEL-backed', () => {
    const otel = [makeCard('a'), makeCard('b')]
    const merged = mergeOtelAndLogSessions(otel, [])
    assert.deepStrictEqual(merged, otel)
    assert.ok(merged.every(s => s.tokensSource === 'otel'), 'OTEL-only serving stamps every card')
  })

  test('a stale displacement note self-corrects once the OTEL twin ages out of the window', () => {
    // Rebuild N: collision → note. Rebuild N+1: the OTEL twin is gone (window aged out) but the
    // long-lived log card still carries the old note — the re-stamp must clear it, or the card
    // would keep claiming a displacement that no longer happened.
    const log = makeCard('uuid-stale', { dataSource: 'log', tokensSource: 'log', coverageNote: OTEL_DISPLACED_NOTE })
    const merged = mergeOtelAndLogSessions([], [log])
    assert.strictEqual(merged[0].tokensSource, 'log')
    assert.strictEqual(merged[0].coverageNote, undefined, 'the stale note is cleared on the next pass')
  })

  test('stampIdentityMerge: cross-feed absorption stamps merged; same-feed keeps the stamp', () => {
    const winner = makeCard('w', { dataSource: 'log', tokensSource: 'log' })
    const loser = makeCard('l', { dataSource: 'otel' })
    stampIdentityMerge(winner, loser)
    assert.strictEqual(winner.tokensSource, 'merged')
    assert.ok(winner.coverageNote && winner.coverageNote.includes('Identity-merged'), 'the cross-feed merge is disclosed')

    const sameFeedWinner = makeCard('w2', { dataSource: 'log', tokensSource: 'log' })
    stampIdentityMerge(sameFeedWinner, makeCard('l2', { dataSource: 'log' }))
    assert.strictEqual(sameFeedWinner.tokensSource, 'log', 'same-feed absorption is not a cross-feed merge')
    assert.strictEqual(sameFeedWinner.coverageNote, undefined)
  })
})
