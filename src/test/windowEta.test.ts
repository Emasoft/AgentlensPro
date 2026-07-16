// get_window_eta (TRDD-8ZMZ4I6B) — the ETA is COST-based and PER-ACCOUNT; the tests pin both:
// the projection uses dollars against a cost cap (not tokens), and the rate is the target account's
// own $/min, so a concurrent session on another token never shortens this account's ETA.
import * as assert from 'assert'
import { segmentsFromRecords, resolveTargetAccount } from '../accountBurners'
import { buildWindowEtaReport, humanEta } from '../windowEta'
import type { ConsumptionEvent, ObservedAccountCapacity } from '../burnMonitor'

const H = 3600_000
const NOW = Date.UTC(2026, 6, 15, 12, 0, 0)
const RECORDS = [
  { ts: NOW - 40 * H, accountId: 'acct-aaaa', email: 'a@x.com', plan: 'Max 20x' },
  { ts: NOW - 6 * H, accountId: 'acct-bbbb', email: 'b@x.com', plan: 'Max 20x' },
]
const SEGS = segmentsFromRecords(RECORDS) // bbbb is current (open segment) since NOW-6h
const CURRENT = resolveTargetAccount(SEGS, 'current', NOW)! // acct-bbbb

function ev(p: Partial<ConsumptionEvent> & { ts: number; sessionId: string; costUsd: number }): ConsumptionEvent {
  return {
    tokens: p.tokens ?? 0, source: 'api_request',
    inputTokens: 0, outputTokens: 0, cacheReadTokens: p.cacheReadTokens ?? 0, cacheCreateTokens: 0,
    ...p,
  }
}
const cap = (o: Partial<ObservedAccountCapacity>): ObservedAccountCapacity => ({
  window5hTokens: null, window7dTokens: null, window5hCostUsd: null, window7dCostUsd: null, observedAt: null, ...o,
})

suite('buildWindowEtaReport — cost-based, per-account time-to-exhaustion', () => {
  test('projects ETA from remaining $ cap ÷ the account\'s own $/min', () => {
    // 30 events of $2 across [NOW-30m, NOW-1m] = $60 consumed, rate = $60/30 = $2/min.
    // (ts must be strictly < NOW — the window end is exclusive.) 5h cap $200 → remaining $140 → 70 min.
    const events = Array.from({ length: 30 }, (_, i) => ev({ ts: NOW - (30 - i) * 60_000, sessionId: 's', costUsd: 2 }))
    const observed = { 'acct-bbbb': cap({ window5hCostUsd: 200, window7dCostUsd: 100_000 }) }
    const r = buildWindowEtaReport({ events, target: CURRENT, allSegments: SEGS, nowMs: NOW, rateWindowMs: 30 * 60_000, observed })
    assert.strictEqual(r.fiveHour.costPerMin, 2)
    assert.strictEqual(Math.round(r.fiveHour.consumedCostUsd), 60)
    assert.strictEqual(Math.round(r.fiveHour.remainingCostUsd!), 140)
    assert.strictEqual(Math.round(r.fiveHour.etaMinutes!), 70)
    assert.strictEqual(r.bindingWindow, '5h')
    assert.match(r.text, /◀ EXHAUSTS FIRST/)
  })

  test('a concurrent session on a DIFFERENT account does not inflate this account\'s rate', () => {
    const events = [
      ev({ ts: NOW - 5 * 60_000, sessionId: 'mine', costUsd: 10 }),   // acct-bbbb (current) — counts
      ev({ ts: NOW - 45 * H, sessionId: 'theirs', costUsd: 999 }),    // acct-aaaa era — excluded by time
    ]
    const observed = { 'acct-bbbb': cap({ window5hCostUsd: 100 }) }
    const r = buildWindowEtaReport({ events, target: CURRENT, allSegments: SEGS, nowMs: NOW, rateWindowMs: 30 * 60_000, observed })
    assert.strictEqual(r.fiveHour.consumedCostUsd, 10)          // only mine
    assert.strictEqual(+r.fiveHour.costPerMin.toFixed(4), +(10 / 30).toFixed(4))
  })

  test('the binding window is the one that runs out FIRST, even if it is the 7d', () => {
    const events = [ev({ ts: NOW - 1 * 60_000, sessionId: 's', costUsd: 30 })] // rate $1/min
    // 5h: $30 of $10000 (miles away). 7d: $30 of $60 → remaining $30 → 30 min.
    const observed = { 'acct-bbbb': cap({ window5hCostUsd: 10_000, window7dCostUsd: 60 }) }
    const r = buildWindowEtaReport({ events, target: CURRENT, allSegments: SEGS, nowMs: NOW, rateWindowMs: 30 * 60_000, observed })
    assert.strictEqual(r.bindingWindow, '7d')
    assert.strictEqual(Math.round(r.sevenDay.etaMinutes!), 30)
  })

  test('already over the cap → ETA 0 and a rotation-imminent verdict', () => {
    const events = [ev({ ts: NOW - 60_000, sessionId: 's', costUsd: 500 })]
    const observed = { 'acct-bbbb': cap({ window5hCostUsd: 100 }) }
    const r = buildWindowEtaReport({ events, target: CURRENT, allSegments: SEGS, nowMs: NOW, rateWindowMs: 30 * 60_000, observed })
    assert.strictEqual(r.fiveHour.etaMinutes, 0)
    assert.strictEqual(r.bindingWindow, '5h')
    assert.match(r.verdict, /ALREADY at\/over/)
  })

  test('falls back to a SAME-PLAN account\'s cost cap as a labeled proxy', () => {
    // $12 over 30m = $0.4/min. 5h steady = 0.4×300 = $120 ≥ $100 cap → it DOES exhaust, so the
    // verdict names the proxy. (A rate that plateaus below cap would say "won't exhaust" instead.)
    const events = [ev({ ts: NOW - 60_000, sessionId: 's', costUsd: 12 })]
    const observed = { 'acct-aaaa': cap({ window5hCostUsd: 100 }) }
    const r = buildWindowEtaReport({ events, target: CURRENT, allSegments: SEGS, nowMs: NOW, rateWindowMs: 30 * 60_000, observed })
    assert.strictEqual(r.fiveHour.capacity.source, 'same-plan-proxy')
    assert.strictEqual(r.fiveHour.capacity.proxyAccountId, 'acct-aaaa')
    assert.strictEqual(r.bindingWindow, '5h')
    assert.match(r.verdict, /same-plan proxy acct-aaa/)
  })

  test('a rolling window whose steady-state fill is below the cap NEVER exhausts (no fictional ETA)', () => {
    // $6 over 30m = $0.2/min. 5h steady = 0.2×300 = $60 < $100 cap → plateaus, never exhausts.
    const events = [ev({ ts: NOW - 60_000, sessionId: 's', costUsd: 6 })]
    const observed = { 'acct-bbbb': cap({ window5hCostUsd: 100, window7dCostUsd: 100_000 }) }
    const r = buildWindowEtaReport({ events, target: CURRENT, allSegments: SEGS, nowMs: NOW, rateWindowMs: 30 * 60_000, observed })
    assert.strictEqual(r.fiveHour.willExhaustAtCurrentRate, false)
    assert.strictEqual(r.fiveHour.etaMinutes, null)
    assert.strictEqual(r.fiveHour.etaReason, 'plateau')
    assert.strictEqual(r.bindingWindow, 'none')
    assert.match(r.verdict, /NEITHER window exhausts/)
  })

  test('no cost capacity anywhere → no ETA projected, never a guessed number', () => {
    const events = [ev({ ts: NOW - 60_000, sessionId: 's', costUsd: 5 })]
    const r = buildWindowEtaReport({ events, target: CURRENT, allSegments: SEGS, nowMs: NOW, rateWindowMs: 30 * 60_000, observed: {} })
    assert.strictEqual(r.fiveHour.etaMinutes, null)
    assert.strictEqual(r.bindingWindow, 'none')
    assert.match(r.verdict, /No cost capacity is calibrated/)
  })

  test('capacity known but zero recent burn → "not draining", not a divide-by-zero', () => {
    const events = [ev({ ts: NOW - 3 * H, sessionId: 's', costUsd: 40 })] // inside the 5h window but OUTSIDE the 30m rate window
    const observed = { 'acct-bbbb': cap({ window5hCostUsd: 100 }) }
    const r = buildWindowEtaReport({ events, target: CURRENT, allSegments: SEGS, nowMs: NOW, rateWindowMs: 30 * 60_000, observed })
    assert.strictEqual(r.fiveHour.costPerMin, 0)
    assert.strictEqual(r.fiveHour.consumedCostUsd, 40)   // still counted as consumed
    assert.strictEqual(r.fiveHour.etaMinutes, null)      // headroom left but not draining
    assert.match(r.verdict, /not draining/)
  })
})

suite('humanEta — the readable ETA string, by reason', () => {
  test('formats hours+minutes, sub-hour minutes, over-limit, no-capacity, idle, plateau', () => {
    assert.strictEqual(humanEta(222, 'projected'), '3h 42m')
    assert.strictEqual(humanEta(18, 'projected'), '18m')
    assert.strictEqual(humanEta(0, 'over-limit'), 'already at/over the limit')
    assert.match(humanEta(100, 'no-capacity'), /no cost capacity/)
    assert.match(humanEta(null, 'idle'), /not draining/)
    assert.match(humanEta(null, 'plateau'), /won't exhaust at the current rate/)
  })
})
