import * as assert from 'assert'
import { buildCostRollup } from '../mcpServer'
import type { SessionSummaryCard } from '../shared/summarizerTypes'

// ── get_cost_rollup (TRDD-O981ZJKV items 4/5/6/7) ────────────────────────────
// Pure aggregation over synthetic session cards.

const NOW = Date.parse('2026-07-10T12:00:00Z')
const H = 3600e3

function card(over: Partial<SessionSummaryCard>): SessionSummaryCard {
  return {
    sessionId: `s-${Math.random().toString(36).slice(2)}`,
    agent: 'claude-code',
    workspace: '/Users/x/Code/agentlens',
    userRequest: 'do things',
    model: 'claude-sonnet-5',
    turns: 3,
    inputTokens: 1_000,
    outputTokens: 2_000,
    cacheReadTokens: 100_000,
    cacheCreateTokens: 10_000,
    cacheHitRate: 0.9,
    durationMs: 10 * 60_000,
    startTime: new Date(NOW - 2 * H).toISOString(),
    filesRead: [], filesSearched: [], filesChanged: [],
    toolCounts: {}, totalToolCalls: 0, totalLlmCalls: 3, errors: 0,
    outcome: 'text_response', timeline: [], backgroundSpans: [], loopSignals: [],
    filesWritten: [],
    ...over,
  } as SessionSummaryCard
}

type Rollup = {
  totals: { sessions: number; input: number; output: number; cacheRead: number; cacheCreation: number; costUsd: number; unpricedSessions: number; totalTokens: number; tokensPerHour: number; costUsdPerHour: number }
  groups: Array<Record<string, unknown> & { key: string; sessions: number; costUsd: number }>
  coverage: { sessionsInWindow: number; groupsTotal: number }
  window: { hours: number }
  error?: string
}

suite('costRollup — buildCostRollup (TRDD-O981ZJKV)', () => {
  test('groups by project with the 5-value breakdown, totals, and per-hour rate', () => {
    const sessions = [
      card({ workspace: '/w/alpha' }),
      card({ workspace: '/w/alpha' }),
      card({ workspace: '/w/beta', inputTokens: 5_000 }),
    ]
    const r = buildCostRollup(sessions, { groupBy: 'project', windowHours: 24 }, NOW) as Rollup
    assert.strictEqual(r.coverage.sessionsInWindow, 3)
    assert.strictEqual(r.groups.length, 2)
    const alpha = r.groups.find(g => g.key === '/w/alpha')
    if (!alpha) throw new Error('alpha group missing')
    assert.strictEqual(alpha.sessions, 2)
    assert.strictEqual(alpha.input, 2_000)
    assert.strictEqual(alpha.cacheRead, 200_000)
    assert.strictEqual(alpha.cacheCreation, 20_000)
    assert.strictEqual(r.totals.sessions, 3)
    assert.strictEqual(r.totals.totalTokens, r.totals.input + r.totals.output + r.totals.cacheRead + r.totals.cacheCreation)
    assert.strictEqual(r.totals.tokensPerHour, Math.round(r.totals.totalTokens / 24))
    assert.ok(r.totals.costUsd > 0, 'priced sessions must produce a nonzero cost')
  })

  test('groupBy all returns one combined row (item 5)', () => {
    const r = buildCostRollup([card({}), card({ workspace: '/w/beta' })], { groupBy: 'all' }, NOW) as Rollup
    assert.strictEqual(r.groups.length, 1)
    assert.strictEqual(r.groups[0].key, 'all')
    assert.strictEqual(r.groups[0].sessions, 2)
  })

  test('window filter: sessions outside the interval are excluded, overlap counts', () => {
    const sessions = [
      card({ startTime: new Date(NOW - 30 * 24 * H).toISOString() }),          // ancient
      card({ startTime: new Date(NOW - 25 * H).toISOString(), durationMs: 2 * H }), // overlaps the 24h edge
      card({}),                                                                 // inside
    ]
    const r = buildCostRollup(sessions, { windowHours: 24 }, NOW) as Rollup
    assert.strictEqual(r.coverage.sessionsInWindow, 2, 'ancient out; edge-overlap in')
  })

  test('subagent view: implicit parent filter, labels, spawn-time interval, ranking by a bucket (item 7)', () => {
    const sessions = [
      card({ sessionId: 'main-1' }), // parent — must be excluded by groupBy:subagent
      card({ sessionId: 'agent-a', parentSessionId: 'main-1', spawnKind: 'fork', spawnSubagentType: 'fork', cacheCreateTokens: 900_000 }),
      card({ sessionId: 'agent-b', parentSessionId: 'main-1', spawnKind: 'fresh', spawnSubagentType: 'scout', cacheCreateTokens: 50_000 }),
      card({ sessionId: 'agent-old', parentSessionId: 'main-1', startTime: new Date(NOW - 50 * H).toISOString() }),
    ]
    const r = buildCostRollup(sessions, { groupBy: 'subagent', windowHours: 24, sortBy: 'cacheCreation' }, NOW) as Rollup
    assert.strictEqual(r.groups.length, 2, 'parent and out-of-window child excluded')
    assert.strictEqual(r.groups[0].key, 'agent-a', 'ranked by cacheCreation')
    assert.strictEqual(r.groups[0].spawnKind, 'fork')
    assert.strictEqual(r.groups[0].subagentType, 'fork')
    assert.strictEqual(r.groups[0].parentSessionId, 'main-1')
  })

  test('liveOnly keeps only sessions still receiving turns (item 6)', () => {
    const sessions = [
      card({ sessionId: 'live', parentSessionId: 'main-1', startTime: new Date(NOW - 10 * 60_000).toISOString(), durationMs: 9 * 60_000 }),
      card({ sessionId: 'done', parentSessionId: 'main-1', startTime: new Date(NOW - 2 * H).toISOString(), durationMs: 10 * 60_000 }),
    ]
    const r = buildCostRollup(sessions, { subagentsOnly: true, liveOnly: true, groupBy: 'session' }, NOW) as Rollup
    assert.strictEqual(r.coverage.sessionsInWindow, 1)
    assert.strictEqual(r.groups[0].key, 'live')
  })

  test('unpriced sessions are counted and excluded from $, never silent $0', () => {
    const sessions = [card({}), card({ unpriced: true, model: 'mystery-model' })]
    const r = buildCostRollup(sessions, { groupBy: 'all' }, NOW) as Rollup
    assert.strictEqual(r.totals.unpricedSessions, 1)
    const priced = buildCostRollup([card({})], { groupBy: 'all' }, NOW) as Rollup
    assert.ok(Math.abs(r.totals.costUsd - priced.totals.costUsd) < 1e-9, 'the unpriced session must not change $')
  })

  test('parentSessionId scopes to one main agent; bad window errors out', () => {
    const sessions = [
      card({ sessionId: 'a1', parentSessionId: 'main-1' }),
      card({ sessionId: 'b1', parentSessionId: 'main-2' }),
    ]
    const r = buildCostRollup(sessions, { parentSessionId: 'main-1', groupBy: 'session' }, NOW) as Rollup
    assert.strictEqual(r.coverage.sessionsInWindow, 1)
    const bad = buildCostRollup(sessions, { sinceIso: '2026-07-11T00:00:00Z', untilIso: '2026-07-10T00:00:00Z' }, NOW) as Rollup
    assert.ok(bad.error, 'inverted window must be an explicit error')
  })
})
