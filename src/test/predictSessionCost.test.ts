import * as assert from 'assert'
import { predictSessionCost } from '../mcpServer'
import type { SessionSummaryCard } from '../summarizers/summarizerTypes'

// ── predict_session_cost (TRDD-O981ZJKV item 9) ──────────────────────────────

function card(over: Partial<SessionSummaryCard>): SessionSummaryCard {
  return {
    sessionId: `s-${Math.random().toString(36).slice(2)}`,
    workspace: '/w/x',
    userRequest: 'review the code for bugs',
    model: 'claude-sonnet-5',
    turns: 10,
    inputTokens: 1_000, outputTokens: 4_000, cacheReadTokens: 200_000, cacheCreateTokens: 30_000,
    cacheHitRate: 0.9, durationMs: 60_000, startTime: new Date().toISOString(),
    filesRead: [], filesSearched: [], filesChanged: [], filesWritten: [],
    toolCounts: {}, totalToolCalls: 5, totalLlmCalls: 10, errors: 0,
    outcome: 'text_response', timeline: [], backgroundSpans: [], loopSignals: [],
    ...over,
  } as SessionSummaryCard
}

type Prediction = {
  matched: number
  prediction?: { costUsd: { p25: number; p50: number; p75: number }; turns: { p50: number } }
  precedents?: Array<{ subagentType: string | null; similarity: number }>
  note?: string
  error?: string
}

suite('predictSessionCost (TRDD-O981ZJKV item 9)', () => {
  test('matches by task keywords and returns a p25/p50/p75 distribution over precedents', () => {
    const sessions = [
      card({ userRequest: 'review the authentication code for bugs', turns: 8 }),
      card({ userRequest: 'code review of the parser module', turns: 12 }),
      card({ userRequest: 'bake a cake', turns: 2 }),  // no keyword overlap — excluded
    ]
    const r = predictSessionCost(sessions, { task: 'run a code review over the new module' }) as Prediction
    assert.strictEqual(r.matched, 2, 'only keyword-overlapping precedents count')
    assert.ok(r.prediction, 'a prediction exists')
    assert.ok((r.prediction?.costUsd.p50 ?? 0) > 0)
    assert.ok((r.prediction?.turns.p50 ?? 0) >= 8)
  })

  test('subagentType preference ranks same-type precedents first', () => {
    const sessions = [
      card({ userRequest: 'review code', spawnSubagentType: 'general-purpose' }),
      card({ userRequest: 'review code', spawnSubagentType: 'fork' }),
    ]
    const r = predictSessionCost(sessions, { task: 'review code', subagentType: 'fork' }) as Prediction
    assert.strictEqual(r.precedents?.[0].subagentType, 'fork')
    assert.ok((r.precedents?.[0].similarity ?? 0) > (r.precedents?.[1].similarity ?? 0))
  })

  test('no matching precedent → explicit no-prediction, never a fabricated guess', () => {
    const r = predictSessionCost([card({ userRequest: 'unrelated work entirely' })], { task: 'quantum blockchain synergy' }) as Prediction
    assert.strictEqual(r.matched, 0)
    assert.ok(r.note?.includes('no precedent, no prediction'), r.note)
    assert.strictEqual(r.prediction, undefined)
  })

  test('zero-traffic cards are excluded; junk task input errors out', () => {
    const dead = card({ userRequest: 'review code', totalLlmCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 })
    const live = card({ userRequest: 'review code' })
    const r = predictSessionCost([dead, live], { task: 'review code' }) as Prediction
    assert.strictEqual(r.matched, 1, 'the zero-traffic card must not drag percentiles to 0')
    assert.ok((predictSessionCost([live], { task: '' }) as Prediction).error)
  })
})
