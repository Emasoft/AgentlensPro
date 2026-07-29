import * as assert from 'assert'
import {
  computeWindowBudget, DEFAULT_THRESHOLDS,
  type ConsumptionEvent, type BurnConfig, type ObservedAccountCapacity,
} from '../burnMonitor'
import { windowFillPct } from '../mcpServer'

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

  test('past the TOKEN bound but well under the COST bound is NOT exceeded — cost is the meter', () => {
    // The whole reason windowFillPct prefers cost: raw tokens overstate fill because a cache read
    // bills at 0.1x and is ~96% of volume. So a cache-read-heavy window routinely passes its observed
    // TOKEN bound while sitting at 40% by cost. Treating that as a falsification nulled the one honest
    // number — the same "no answer" failure this suite exists to prevent, pointing the other way.
    // Asserted end-to-end through computeWindowBudget: the sibling windowFillPct tests below pass
    // `capacityExceeded` by hand, so they cannot see what the pipeline actually produces.
    const events = [ev('acct-A', 2_000_000, 40)]   // 2x the token bound, 40% of the $100 cost bound
    const budget = computeWindowBudget(events, config({ observed: { 'acct-A': observed() } }), 1000, NOW, 'acct-A')
    assert.strictEqual(budget.fiveHour.pctConsumed, 200, 'raw-token pct should still be reported as-is')
    assert.strictEqual(budget.fiveHour.pctConsumedCost, 40)
    assert.strictEqual(budget.fiveHour.capacityExceeded, false,
      'the token bound alone must not falsify a cap that the COST figure says is 40% full')
    assert.strictEqual(windowFillPct(budget.fiveHour), 40, 'threw away the honest cost percentage')
  })

  test('past the COST bound IS exceeded, even when raw tokens sit under the token bound', () => {
    // The converse: an output-heavy window can cost more than the bound on fewer tokens. Cost decides.
    const events = [ev('acct-A', 500_000, 150)]    // half the token bound, 1.5x the $100 cost bound
    const budget = computeWindowBudget(events, config({ observed: { 'acct-A': observed() } }), 1000, NOW, 'acct-A')
    assert.strictEqual(budget.fiveHour.capacityExceeded, true)
    assert.strictEqual(budget.fiveHour.minutesToExhaustion, null)
    assert.strictEqual(windowFillPct(budget.fiveHour), null)
  })
})

suite('window capacity — the "who burned" test is scoped to the window being reported', () => {
  test('a second account active only 6 days ago must not strip the 5h capacity', () => {
    // `events` is the whole retained stream, so testing pooled eligibility across all of it let one
    // rotated-away account suppress the 5h window — a window it never touched — until retention aged
    // its last event out. Each window answers "who burned HERE" for itself.
    const events = [ev('acct-A', 400_000, 40, HOUR), ev('acct-B', 900_000, 90, 6 * 24 * HOUR)]
    const budget = computeWindowBudget(events, config({ observed: { 'acct-A': observed() } }), 0, NOW)
    assert.strictEqual(budget.fiveHour.capacityTokens, 1_000_000,
      'only acct-A burned in the last 5h, so its cap describes the pooled 5h window')
    assert.strictEqual(budget.fiveHour.pctConsumed, 40)
    assert.strictEqual(budget.sevenDay.capacityTokens, null,
      'TWO accounts burned inside 7d, so no per-account cap describes that pool')
    assert.strictEqual(budget.sevenDay.pctConsumed, null)
  })
})

suite('windowFillPct — one honest utilisation number', () => {
  test('prefers the COST percentage: windows are metered by cost, not raw tokens', () => {
    // The real divergence measured on this machine: the same 7d window read 171.51% by tokens and
    // 64.49% by cost, because ~96% of the volume is cache reads billed at 0.1x.
    assert.strictEqual(windowFillPct({ pctConsumed: 171.51, pctConsumedCost: 64.49, capacityExceeded: false }), 64.49)
  })

  test('falls back to raw tokens only when no cost cap exists', () => {
    assert.strictEqual(windowFillPct({ pctConsumed: 47.67, pctConsumedCost: null, capacityExceeded: false }), 47.67)
  })

  test('an exceeded lower bound has no percentage at all — null, never a number off a wrong divisor', () => {
    assert.strictEqual(windowFillPct({ pctConsumed: 171.51, pctConsumedCost: 120, capacityExceeded: true }), null)
  })

  test('no capacity anywhere → null, never 0 (absence is not emptiness)', () => {
    assert.strictEqual(windowFillPct({ pctConsumed: null, pctConsumedCost: null, capacityExceeded: false }), null)
  })
})
