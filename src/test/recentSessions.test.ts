import * as assert from 'assert'
import { handleGetRecentSessions } from '../mcpServer'
import type { SessionSummaryCard } from '../shared/summarizerTypes'

// TRDD-RS3NGN53 — get_recent_sessions must rank by LAST ACTIVITY (start + duration), not start
// date: a long-running session started days ago but emitting spans NOW is the most "recent" thing
// on the machine, yet start-date ranking buried it below fresh idle sessions (live-confirmed:
// 4 actively-emitting sessions absent from the default top-10).

function card(sessionId: string, startIso: string, durationMs: number, over: Partial<SessionSummaryCard> = {}): SessionSummaryCard {
  return {
    sessionId, traceId: sessionId, source: 'claude_code', dataSource: 'log',
    workspace: 'ws', userRequest: `prompt ${sessionId}`, model: 'claude-opus-4-8',
    turns: 3, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreateTokens: 0,
    cacheHitRate: 0, durationMs, startTime: startIso,
    filesRead: [], filesSearched: [], filesChanged: [], toolCounts: {},
    totalToolCalls: 0, totalLlmCalls: 3, errors: 0, outcome: 'text_response',
    timeline: [], backgroundSpans: [], loopSignals: [],
    ...over,
  } as SessionSummaryCard
}

suite('get_recent_sessions last-activity ranking (TRDD-RS3NGN53)', () => {
  test('ranks by last activity, not start date — an old-but-active session outranks a fresh idle one', () => {
    // Tests that start+duration ordering wins over pure start-date ordering.
    const now = Date.now()
    const oldButActive = card('old-active', new Date(now - 3 * 86_400_000).toISOString(), 3 * 86_400_000 - 60_000) // started 3d ago, active 1min ago
    const freshButIdle = card('fresh-idle', new Date(now - 2 * 3_600_000).toISOString(), 5 * 60_000)              // started 2h ago, idle since
    // Caller order deliberately start-date-descending (the OLD behavior's input).
    const rows = handleGetRecentSessions([freshButIdle, oldButActive], {})
    assert.strictEqual(rows[0].sessionId, 'old-active', 'the actively-emitting session must rank first')
    assert.strictEqual(rows[1].sessionId, 'fresh-idle')
  })

  test('rows carry lastActive, and active:true only within the 5-minute liveness window', () => {
    // Tests the liveness marker: active rides only on sessions whose last activity is <5min old.
    const now = Date.now()
    const live = card('live', new Date(now - 3_600_000).toISOString(), 3_600_000 - 30_000)  // last active 30s ago
    const stale = card('stale', new Date(now - 3_600_000).toISOString(), 10 * 60_000)       // last active 50min ago
    const rows = handleGetRecentSessions([stale, live], {})
    const liveRow = rows.find(r => r.sessionId === 'live')!
    const staleRow = rows.find(r => r.sessionId === 'stale')!
    assert.strictEqual(liveRow.active, true, 'session active 30s ago must be marked active')
    assert.ok(typeof liveRow.lastActive === 'string' && liveRow.lastActive.length > 0, 'lastActive present')
    assert.strictEqual('active' in staleRow, false, 'idle session carries NO active field (absent, not false)')
  })

  test('title/entrypoint ride the row when the card carries them, absent otherwise', () => {
    // Tests the transcript-signal passthrough: the orient-yourself listing shows session titles.
    const now = Date.now()
    const titled = card('titled', new Date(now - 60_000).toISOString(), 30_000, { title: 'my-session', entrypoint: 'cli' })
    const plain = card('plain', new Date(now - 120_000).toISOString(), 30_000)
    const rows = handleGetRecentSessions([titled, plain], {})
    const t = rows.find(r => r.sessionId === 'titled')!
    const p = rows.find(r => r.sessionId === 'plain')!
    assert.strictEqual(t.title, 'my-session')
    assert.strictEqual(t.entrypoint, 'cli')
    assert.strictEqual('title' in p, false, 'no fabricated title field')
  })

  test('filters and limit still apply after the re-sort', () => {
    // Tests that agent filtering happens on the re-sorted list and limit caps it.
    const now = Date.now()
    const cards = [
      card('c1', new Date(now - 60_000).toISOString(), 30_000),
      card('c2', new Date(now - 120_000).toISOString(), 110_000), // lastActive 10s ago — most recent
      card('x1', new Date(now - 30_000).toISOString(), 1_000, { source: 'codex' }),
    ]
    const rows = handleGetRecentSessions(cards, { agent: 'claude_code', limit: 1 })
    assert.strictEqual(rows.length, 1)
    assert.strictEqual(rows[0].sessionId, 'c2', 'most recently ACTIVE claude session wins the single slot')
  })
})
