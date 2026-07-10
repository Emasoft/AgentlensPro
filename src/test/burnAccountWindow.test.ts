import * as assert from 'assert'
import {
  gatherConsumptionEvents, computeAccountWindowBudgets, computeWindowBudget,
  observeCapacityFromPrematureEnd, computeBurnStatus, DEFAULT_THRESHOLDS,
  type ConsumptionEvent, type StatuslineBillingEvent, type BurnConfig,
} from '../burnMonitor'
import { calcTokenCostUsd } from '../shared/pricing'
import type { SessionSummaryCard } from '../shared/summarizerTypes'

// TRDD-BURNWDGT — REAL tests for per-account window budgeting + the statusline burn-rate cost fix.
// No mocks: everything runs the actual burnMonitor functions + the real pricing table.

const NOW = 1_700_000_000_000
const MODEL = 'claude-opus-4-8'   // a priced model (input 5, cacheRead 0.5, cacheWrite 6.25, output 25 /MTok)

function card(over: Partial<SessionSummaryCard> = {}): SessionSummaryCard {
  return {
    sessionId: 'sess-1', traceId: 't1', source: 'claude_code', dataSource: 'log',
    workspace: '/ws/proj', userRequest: 'do a thing', model: MODEL,
    turns: 1, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheCreateTokens: 0,
    cacheHitRate: 0, durationMs: 1000, startTime: new Date(NOW - 1000).toISOString(),
    filesRead: [], filesSearched: [], filesChanged: [], filesWritten: [],
    toolCounts: {}, totalToolCalls: 0, totalLlmCalls: 1, errors: 0, outcome: 'text_response',
    timeline: [], backgroundSpans: [], loopSignals: [], ...over,
  }
}
function statusline(over: Partial<StatuslineBillingEvent> = {}): StatuslineBillingEvent {
  return { ts: NOW, sessionId: 'sess-1', workspace: '/ws/proj', deltaCostUsd: 0.4, deltaTokens: 106200, ...over }
}
function baseConfig(over: Partial<BurnConfig> = {}): BurnConfig {
  return { window5hTokens: null, window7dTokens: null, window5hCostUsd: null, window7dCostUsd: null, capacitySource: 'none', observed: {}, notify: false, thresholds: { ...DEFAULT_THRESHOLDS }, ...over }
}

suite('burnMonitor — statusline burn-rate cost fix (TRDD-BURNWDGT)', () => {
  test('a statusline turn is priced from its own buckets, NOT the sparse cumulative deltaCostUsd', () => {
    // Buckets summing to deltaTokens; deltaCostUsd is the INFLATED cumulative-delta artifact (~4x).
    const be = statusline({
      deltaInput: 1000, deltaOutput: 200, deltaCacheRead: 100_000, deltaCacheCreate: 5000,
      deltaTokens: 106_200, deltaCostUsd: 0.4,
    })
    const events = gatherConsumptionEvents([card()], [be], NOW)
    assert.strictEqual(events.length, 1)
    const expected = calcTokenCostUsd(1000, 100_000, 5000, 200, MODEL)  // 0.09125
    assert.ok(Math.abs(events[0].costUsd - expected) < 1e-9, `expected ${expected}, got ${events[0].costUsd}`)
    // The corrected cost is well below the inflated cumulative delta — the ~4x artifact is gone.
    assert.ok(events[0].costUsd < be.deltaCostUsd)
    assert.strictEqual(events[0].tokens, 106_200)   // token total is unchanged by the cost fix
  })

  test('falls back to deltaCostUsd when no per-turn buckets are present (never loses cost)', () => {
    const be = statusline({ deltaTokens: 5000, deltaCostUsd: 0.12 })   // no delta* buckets
    const events = gatherConsumptionEvents([card()], [be], NOW)
    assert.strictEqual(events[0].costUsd, 0.12)
  })

  test('falls back to deltaCostUsd when the model is unpriced (derived cost 0)', () => {
    const be = statusline({ deltaInput: 100, deltaOutput: 50, deltaCacheRead: 0, deltaCacheCreate: 0, deltaTokens: 150, deltaCostUsd: 0.02 })
    const events = gatherConsumptionEvents([card({ model: 'some-unpriced-model' })], [be], NOW)
    assert.strictEqual(events[0].costUsd, 0.02)
  })
})

suite('burnMonitor — per-account attribution + window budget', () => {
  test('gatherConsumptionEvents tags statusline events with the card account', () => {
    const be = statusline({ deltaInput: 10, deltaOutput: 5, deltaCacheRead: 0, deltaCacheCreate: 0, deltaTokens: 15 })
    const events = gatherConsumptionEvents([card({ accountId: 'acct-A' })], [be], NOW)
    assert.strictEqual(events[0].accountUuid, 'acct-A')
  })

  test('computeAccountWindowBudgets keeps each account\'s consumption separate (no pooling)', () => {
    const events: ConsumptionEvent[] = [
      { ts: NOW - 1000, sessionId: 'a1', accountUuid: 'acct-A', costUsd: 1, tokens: 1000, source: 'statusline' },
      { ts: NOW - 2000, sessionId: 'a2', accountUuid: 'acct-A', costUsd: 2, tokens: 2000, source: 'statusline' },
      { ts: NOW - 3000, sessionId: 'b1', accountUuid: 'acct-B', costUsd: 5, tokens: 500,  source: 'statusline' },
    ]
    const budgets = computeAccountWindowBudgets(events, baseConfig(), NOW)
    assert.strictEqual(budgets.length, 2)
    const a = budgets.find(x => x.accountUuid === 'acct-A')
    const b = budgets.find(x => x.accountUuid === 'acct-B')
    assert.ok(a && b)
    assert.strictEqual(a?.budget.fiveHour.consumedTokens, 3000)   // A's two events only
    assert.strictEqual(b?.budget.fiveHour.consumedTokens, 500)    // B's one event only — not pooled
  })

  test('events with no account fall into the null bucket, pinned last', () => {
    const events: ConsumptionEvent[] = [
      { ts: NOW - 1000, sessionId: 'x', accountUuid: 'acct-A', costUsd: 1, tokens: 9999, source: 'statusline' },
      { ts: NOW - 2000, sessionId: 'y', costUsd: 1, tokens: 10, source: 'statusline' },
    ]
    const budgets = computeAccountWindowBudgets(events, baseConfig(), NOW)
    assert.strictEqual(budgets[budgets.length - 1].accountUuid, null)
  })
})

suite('burnMonitor — cost-based window capacity', () => {
  test('a cost cap yields a cost-based pctConsumed (raw-token pct stays null)', () => {
    const events: ConsumptionEvent[] = [
      { ts: NOW - 1000, sessionId: 's', accountUuid: 'acct-A', costUsd: 25, tokens: 1_000_000, source: 'statusline' },
    ]
    const budget = computeWindowBudget(events, baseConfig({ window5hCostUsd: 100 }), 0, NOW)
    assert.strictEqual(budget.fiveHour.pctConsumed, null)          // no token cap → no token pct
    assert.strictEqual(budget.fiveHour.pctConsumedCost, 25)        // $25 of a $100 cap = 25%
    assert.strictEqual(budget.fiveHour.capacityCostUsd, 100)
    assert.strictEqual(budget.capacityConfigured, true)
  })
})

suite('burnMonitor — empirical capacity calibration', () => {
  test('observeCapacityFromPrematureEnd snapshots an account\'s consumption in [start, end]', () => {
    const events: ConsumptionEvent[] = [
      { ts: 1000, sessionId: 's', accountUuid: 'acct-A', costUsd: 1, tokens: 100, source: 'statusline', inputTokens: 100 },
      { ts: 2000, sessionId: 's', accountUuid: 'acct-A', costUsd: 2, tokens: 200, source: 'statusline', cacheReadTokens: 200 },
      { ts: 3000, sessionId: 's', accountUuid: 'acct-B', costUsd: 9, tokens: 900, source: 'statusline' },   // other account
      { ts: 9999, sessionId: 's', accountUuid: 'acct-A', costUsd: 5, tokens: 500, source: 'statusline' },   // after the end
    ]
    const cap = observeCapacityFromPrematureEnd(events, 'acct-A', 1000, 2500)
    assert.strictEqual(cap.tokens, 300)          // the two acct-A events in window (100 + 200)
    assert.strictEqual(cap.costUsd, 3)
    assert.strictEqual(cap.events, 2)
    assert.strictEqual(cap.breakdown.input, 100)
    assert.strictEqual(cap.breakdown.cacheRead, 200)
  })
})

suite('burnMonitor — computeBurnStatus carries per-account windows', () => {
  test('BurnStatus.accountWindows is populated from the tagged events', () => {
    const be = statusline({ deltaInput: 10, deltaOutput: 5, deltaCacheRead: 0, deltaCacheCreate: 0, deltaTokens: 15 })
    const events = gatherConsumptionEvents([card({ accountId: 'acct-A' })], [be], NOW)
    const status = computeBurnStatus(events, [card({ accountId: 'acct-A' })], baseConfig(), NOW)
    assert.ok(Array.isArray(status.accountWindows))
    assert.strictEqual(status.accountWindows[0].accountUuid, 'acct-A')
  })
})
