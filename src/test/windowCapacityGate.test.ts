import * as assert from 'assert'
import {
  computeWindowBudget, DEFAULT_THRESHOLDS,
  type ConsumptionEvent, type BurnConfig, type ObservedAccountCapacity,
} from '../burnMonitor'

// When may an auto-calibrated capacity be applied, and what does exceeding one mean?
//
// Both questions had shipped answers that produced a self-falsifying number: the live machine
// reported 171.51% of its 7d window consumed. A percentage above 100 on an OPEN window is proof the
// denominator is not a cap, and nothing downstream treated it as such — get_window_budget printed it,
// and the derived minutesToExhaustion said 0 ("rotate now") on the strength of it.
//
// Cause: rate limits are per OAuth account, and this machine had ONE calibrated account but FOUR
// active ones. The pooled budget divided four accounts' consumption by one account's cap. The guard
// counted CALIBRATED accounts, which is the wrong question — it is who BURNED that decides whether a
// per-account cap describes the pool.

const NOW = 1_700_000_000_000
const HOUR = 60 * 60 * 1000

function ev(accountUuid: string | null, tokens: number, costUsd: number, agoMs = HOUR): ConsumptionEvent {
  return { ts: NOW - agoMs, sessionId: `s-${accountUuid ?? 'none'}`, accountUuid: accountUuid ?? undefined, costUsd, tokens, source: 'statusline' } as ConsumptionEvent
}

function observed(over: Partial<ObservedAccountCapacity> = {}): ObservedAccountCapacity {
  return {
    window5hTokens: 1_000_000, window7dTokens: 10_000_000,
    window5hCostUsd: 100, window7dCostUsd: 1000,
    observedAt: new Date(NOW - 24 * HOUR).toISOString(), ...over,
  }
}

function config(over: Partial<BurnConfig> = {}): BurnConfig {
  return {
    window5hTokens: null, window7dTokens: null, window5hCostUsd: null, window7dCostUsd: null,
    capacitySource: 'none', observed: {}, notify: false, thresholds: { ...DEFAULT_THRESHOLDS }, ...over,
  }
}

suite('window capacity — when a per-account cap may describe the POOL', () => {
  test('one calibrated account but SEVERAL active: the pool gets no capacity (the 171% regression)', () => {
    const events = [
      ev('acct-A', 400_000, 40), ev('acct-B', 400_000, 40),
      ev('acct-C', 400_000, 40), ev('acct-D', 400_000, 40),
    ]
    const budget = computeWindowBudget(events, config({ observed: { 'acct-A': observed() } }), 0, NOW)
    assert.strictEqual(budget.capacitySource, 'none',
      'applied one account’s cap to four accounts’ pooled burn')
    assert.strictEqual(budget.fiveHour.pctConsumed, null, 'invented a pooled % from a per-account cap')
    assert.strictEqual(budget.fiveHour.minutesToExhaustion, null)
  })

  test('one calibrated account and only THAT account active: the cap applies', () => {
    const events = [ev('acct-A', 400_000, 40), ev('acct-A', 100_000, 10)]
    const budget = computeWindowBudget(events, config({ observed: { 'acct-A': observed() } }), 0, NOW)
    assert.strictEqual(budget.capacitySource, 'observed')
    assert.strictEqual(budget.fiveHour.capacityTokens, 1_000_000)
    assert.strictEqual(budget.fiveHour.pctConsumed, 50)
  })

  test('a DIFFERENT account is the active one: its burn is not measured against a stranger’s cap', () => {
    const events = [ev('acct-B', 400_000, 40)]
    const budget = computeWindowBudget(events, config({ observed: { 'acct-A': observed() } }), 0, NOW)
    assert.strictEqual(budget.capacitySource, 'none')
    assert.strictEqual(budget.fiveHour.pctConsumed, null)
  })

  test('unattributed consumption counts as its own account — we cannot claim a cap for it', () => {
    const events = [ev('acct-A', 400_000, 40), ev(null, 300_000, 30)]
    const budget = computeWindowBudget(events, config({ observed: { 'acct-A': observed() } }), 0, NOW)
    assert.strictEqual(budget.capacitySource, 'none',
      'attributed one account’s cap to a pool containing unattributable burn')
  })

  test('a per-ACCOUNT budget still gets that account’s own cap regardless of who else is active', () => {
    const events = [ev('acct-A', 400_000, 40)]
    const budget = computeWindowBudget(events, config({ observed: { 'acct-A': observed() } }), 0, NOW, 'acct-A')
    assert.strictEqual(budget.capacitySource, 'observed')
    assert.strictEqual(budget.fiveHour.pctConsumed, 40)
  })
})

suite('window capacity — exceeding an observed LOWER BOUND is a falsification, not a reading', () => {
  test('past an observed cap: flagged, and no ETA is invented', () => {
    const events = [ev('acct-A', 2_000_000, 200)]   // 2x the observed 5h token bound
    const budget = computeWindowBudget(events, config({ observed: { 'acct-A': observed() } }), 1000, NOW, 'acct-A')
    assert.strictEqual(budget.fiveHour.capacityExceeded, true,
      'consumption passed the observed bound without the bound being marked stale')
    assert.strictEqual(budget.fiveHour.minutesToExhaustion, null,
      'reported a time-to-exhaustion from a denominator already proven wrong')
  })

  test('a user-CONFIGURED cap that is spent still means 0 minutes — that answer is real', () => {
    const events = [ev('acct-A', 2_000_000, 200)]
    const cfg = config({ window5hTokens: 1_000_000, capacitySource: 'config' })
    const budget = computeWindowBudget(events, cfg, 1000, NOW, 'acct-A')
    assert.strictEqual(budget.fiveHour.capacityExceeded, false,
      'a configured cap is the real ceiling — being past it is not a falsification')
    assert.strictEqual(budget.fiveHour.minutesToExhaustion, 0)
  })

  test('within an observed cap: not flagged, and the ETA is projected normally', () => {
    const events = [ev('acct-A', 400_000, 40)]
    const budget = computeWindowBudget(events, config({ observed: { 'acct-A': observed() } }), 1000, NOW, 'acct-A')
    assert.strictEqual(budget.fiveHour.capacityExceeded, false)
    assert.strictEqual(budget.fiveHour.minutesToExhaustion, 600)   // (1_000_000-400_000)/1000
  })
})
