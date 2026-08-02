// get_account_burners (TRDD-1XM0YSWQ) — the attribution rule is the contract under test: an event
// burns the account whose token was active AT ITS TIMESTAMP (machine-wide timeline), so sessions
// alive across a rotation split between accounts instead of pooling onto their card's account.
import * as assert from 'assert'
import {
  buildAccountBurnersReport, resolveTargetAccount, resolveWindowUntil, segmentsFromRecords, type AccountSegment,
} from '../accountBurners'
import type { ConsumptionEvent } from '../burnMonitor'

const H = 3600_000
const NOW = Date.UTC(2026, 6, 15, 12, 0, 0)
// A realistic rotation history: A → B → A(current). B's stint = [NOW-8h, NOW-2h).
const RECORDS = [
  { ts: NOW - 20 * H, accountId: 'acct-aaaa', email: 'a@example.com', plan: 'Max 20x' },
  { ts: NOW - 8 * H, accountId: 'acct-bbbb', email: 'b@example.com', plan: 'Max 20x' },
  { ts: NOW - 2 * H, accountId: 'acct-aaaa', email: 'a@example.com', plan: 'Max 20x' },
]
const SEGS = segmentsFromRecords(RECORDS)

function ev(p: Partial<ConsumptionEvent> & { ts: number; sessionId: string }): ConsumptionEvent {
  const inputTokens = p.inputTokens ?? 0, outputTokens = p.outputTokens ?? 0
  const cacheReadTokens = p.cacheReadTokens ?? 0, cacheCreateTokens = p.cacheCreateTokens ?? 0
  return {
    costUsd: p.costUsd ?? 0,
    tokens: p.tokens ?? inputTokens + outputTokens + cacheReadTokens + cacheCreateTokens,
    source: 'api_request',
    ...p,
    inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens,
  }
}

suite('segmentsFromRecords — the rotation timeline becomes per-account segments', () => {
  test('consecutive change-records open and close contiguous segments; the last stays open', () => {
    assert.strictEqual(SEGS.length, 3)
    assert.deepStrictEqual(
      SEGS.map(s => [s.accountId, s.endMs]),
      [['acct-aaaa', NOW - 8 * H], ['acct-bbbb', NOW - 2 * H], ['acct-aaaa', null]],
    )
  })

  test('a same-account re-record (plan/mode change) does not split its segment', () => {
    const segs = segmentsFromRecords([
      { ts: 1000, accountId: 'x', email: null, plan: 'Max 5x' },
      { ts: 2000, accountId: 'x', email: null, plan: 'Max 20x' },
    ])
    assert.strictEqual(segs.length, 1)
    assert.strictEqual(segs[0].endMs, null)
  })

  test('a null-account record CLOSES the open segment — unresolved stretches attribute to nobody', () => {
    const segs = segmentsFromRecords([
      { ts: 1000, accountId: 'x', email: null, plan: null },
      { ts: 2000, accountId: null, email: null, plan: null },
    ])
    assert.strictEqual(segs.length, 1)
    assert.strictEqual(segs[0].endMs, 2000)
  })
})

suite('resolveTargetAccount — previous / current / prefix / email', () => {
  test('previous = the account rotated away from, skipping the current account\'s earlier stints', () => {
    const t = resolveTargetAccount(SEGS, 'previous', NOW)!
    assert.strictEqual(t.accountId, 'acct-bbbb')
    assert.strictEqual(t.isCurrent, false)
    assert.strictEqual(t.lastActiveMs, NOW - 2 * H) // the rotation-out moment
  })

  test('current resolves the open segment, lastActive = now', () => {
    const t = resolveTargetAccount(SEGS, 'current', NOW)!
    assert.strictEqual(t.accountId, 'acct-aaaa')
    assert.strictEqual(t.isCurrent, true)
    assert.strictEqual(t.lastActiveMs, NOW)
    assert.strictEqual(t.segments.length, 2) // both stints belong to it
  })

  test('uuid prefix and email both resolve; an unknown spec returns null', () => {
    assert.strictEqual(resolveTargetAccount(SEGS, 'acct-b', NOW)!.accountId, 'acct-bbbb')
    assert.strictEqual(resolveTargetAccount(SEGS, 'b@example.com', NOW)!.accountId, 'acct-bbbb')
    assert.strictEqual(resolveTargetAccount(SEGS, 'nope@example.com', NOW), null)
  })
})

suite('resolveWindowUntil — last / current / by-date interval selector', () => {
  const target = resolveTargetAccount(SEGS, 'previous', NOW)! // acct-bbbb, lastActive = NOW-2h

  test('`last` ends the window at the account\'s last-active (rotation-out) instant', () => {
    assert.strictEqual(resolveWindowUntil('last', target, NOW).untilMs, NOW - 2 * H)
  })

  test('`current` ends the window at now', () => {
    assert.strictEqual(resolveWindowUntil('current', target, NOW).untilMs, NOW)
  })

  test('an ISO date ends the window at that instant (the window that includes it)', () => {
    const iso = new Date(NOW - 5 * H).toISOString()
    assert.strictEqual(resolveWindowUntil(iso, target, NOW).untilMs, NOW - 5 * H)
  })

  test('an unparseable interval returns a named error, not a silent fallback to now', () => {
    const r = resolveWindowUntil('yesterdayish', target, NOW)
    assert.match(r.error!, /Unparseable interval/)
  })
})

suite('buildAccountBurnersReport — dual windows, project rollup, exhaustion marker, honesty', () => {
  const target = resolveTargetAccount(SEGS, 'previous', NOW)! // acct-bbbb, until = NOW-2h
  const base = { target, allSegments: SEGS, untilMs: target.lastActiveMs, nowMs: NOW, limit: 10, observed: {} }

  test('a session alive across the rotation splits: only events inside the target\'s stint count (both windows)', () => {
    const events = [
      ev({ ts: NOW - 4 * H, sessionId: 's1', cacheReadTokens: 1_000_000, costUsd: 1 }),  // in B's stint
      ev({ ts: NOW - 1 * H, sessionId: 's1', cacheReadTokens: 9_000_000, costUsd: 9 }),  // AFTER rotation → A's window
      ev({ ts: NOW - 9 * H, sessionId: 's1', cacheReadTokens: 5_000_000, costUsd: 5 }),  // BEFORE B's stint → A's window
    ]
    const r = buildAccountBurnersReport({ ...base, events, cards: [] })
    assert.strictEqual(r.fiveHour.totals.events, 1)
    assert.strictEqual(r.fiveHour.totals.cacheRead, 1_000_000)
    // The 7d window reaches NOW-9h in TIME, but that instant belonged to acct-aaaa — still excluded.
    assert.strictEqual(r.sevenDay.totals.events, 1)
    assert.strictEqual(r.sevenDay.totals.costUsd, 1)
  })

  test('ranks by billable weight, not raw tokens: cache-create outranks a bigger cache-read', () => {
    const events = [
      // 10M cache-read = 1M equiv; 2M cache-create = 2.5M equiv — fewer raw tokens, MORE window fill.
      ev({ ts: NOW - 4 * H, sessionId: 'reader', cacheReadTokens: 10_000_000 }),
      ev({ ts: NOW - 4 * H, sessionId: 'writer', cacheCreateTokens: 2_000_000 }),
    ]
    const r = buildAccountBurnersReport({ ...base, events, cards: [] })
    assert.strictEqual(r.fiveHour.burners[0].sessionId, 'writer')
    assert.strictEqual(r.fiveHour.burners[0].billableWeighted, 2_500_000)
    assert.strictEqual(Math.round(r.fiveHour.burners[0].shareOfWindowPct + r.fiveHour.burners[1].shareOfWindowPct), 100)
  })

  test('PROJECT rollup pools sessions of the same workspace: one row, summed cache columns', () => {
    const events = [
      ev({ ts: NOW - 4 * H, sessionId: 's1', cacheReadTokens: 3_000_000, cacheCreateTokens: 100_000, costUsd: 2 }),
      ev({ ts: NOW - 3 * H, sessionId: 's2', cacheReadTokens: 5_000_000, cacheCreateTokens: 400_000, costUsd: 3 }),
      ev({ ts: NOW - 3 * H, sessionId: 's3', cacheReadTokens: 1_000_000, costUsd: 1 }),
    ]
    const cards = [
      { sessionId: 's1', workspace: '/w/anime2svg', source: 'claude_code', model: 'claude-fable-5' },
      { sessionId: 's2', workspace: '/w/anime2svg', source: 'claude_code', model: 'claude-fable-5' },
      { sessionId: 's3', workspace: '/w/other', source: 'claude_code', model: 'claude-opus-4-8' },
    ]
    const r = buildAccountBurnersReport({ ...base, events, cards })
    assert.strictEqual(r.fiveHour.projects.length, 2)
    const top = r.fiveHour.projects[0]
    assert.strictEqual(top.workspace, '/w/anime2svg')
    assert.strictEqual(top.sessions, 2)
    assert.strictEqual(top.cacheRead, 8_000_000)
    assert.strictEqual(top.cacheCreate, 500_000)
    assert.strictEqual(top.topModel, 'claude-fable-5')
  })

  test('statusline events without a bucket split count as unknown ×1, never dropped', () => {
    const events = [ev({ ts: NOW - 4 * H, sessionId: 's', tokens: 500_000, source: 'statusline' })]
    const r = buildAccountBurnersReport({ ...base, events, cards: [] })
    assert.strictEqual(r.fiveHour.burners[0].billableWeighted, 500_000)
  })

  test('fill% + MOST LIKELY EXHAUSTED from the account\'s OWN observed capacity', () => {
    const events = [
      ev({ ts: NOW - 4 * H, sessionId: 's', cacheReadTokens: 900_000 }),   // 5h: 900k of 1M cap = 90%
      ev({ ts: NOW - 30 * H, sessionId: 's', cacheReadTokens: 100_000 }),  // 7d-only... but outside B's stints → excluded
    ]
    const observed = {
      'acct-bbbb': { window5hTokens: 1_000_000, window7dTokens: 10_000_000, window5hCostUsd: null, window7dCostUsd: null, observedAt: '2026-07-13T00:00:00Z' },
    }
    const r = buildAccountBurnersReport({ ...base, events, cards: [], observed })
    assert.strictEqual(Math.round(r.fiveHour.fillPct!), 90)
    assert.strictEqual(r.fiveHour.capacity.source, 'observed')
    assert.strictEqual(r.mostLikelyExhausted, '5h')
    assert.match(r.text, /◀ MOST LIKELY EXHAUSTED/)
  })

  test('falls back to a SAME-PLAN account\'s capacity as a labeled proxy', () => {
    const events = [ev({ ts: NOW - 4 * H, sessionId: 's', cacheReadTokens: 500_000 })]
    // acct-aaaa shares plan 'Max 20x' with acct-bbbb and has a calibration; acct-bbbb has none.
    const observed = {
      'acct-aaaa': { window5hTokens: 1_000_000, window7dTokens: null, window5hCostUsd: null, window7dCostUsd: null, observedAt: null },
    }
    const r = buildAccountBurnersReport({ ...base, events, cards: [], observed })
    assert.strictEqual(r.fiveHour.capacity.source, 'same-plan-proxy')
    assert.strictEqual(r.fiveHour.capacity.proxyAccountId, 'acct-aaaa')
    assert.strictEqual(Math.round(r.fiveHour.fillPct!), 50)
  })

  test('no calibrated capacity anywhere → exhaustion UNDETERMINED, never guessed', () => {
    const events = [ev({ ts: NOW - 4 * H, sessionId: 's', cacheReadTokens: 1000 })]
    const r = buildAccountBurnersReport({ ...base, events, cards: [] })
    assert.strictEqual(r.mostLikelyExhausted, 'undetermined')
    assert.match(r.exhaustionReason, /No calibrated capacity/)
    assert.strictEqual(r.fiveHour.fillPct, null)
  })

  test('workspace/model enrich from cards; the verdict names top projects per window', () => {
    const events = [ev({ ts: NOW - 4 * H, sessionId: 's1', cacheReadTokens: 1e6, costUsd: 3 })]
    const r = buildAccountBurnersReport({
      ...base, events,
      cards: [{ sessionId: 's1', workspace: '/w/anime2svg', source: 'claude_code', model: 'claude-fable-5' }],
    })
    assert.strictEqual(r.fiveHour.burners[0].workspace, '/w/anime2svg')
    assert.strictEqual(r.fiveHour.projects[0].topModel, 'claude-fable-5')
    assert.match(r.verdict, /Top 5h projects: anime2svg \(100%/)
  })

  test('discloses a coverage gap when the oldest event is younger than the 7d window start', () => {
    const events = [ev({ ts: NOW - 3 * H, sessionId: 's', cacheReadTokens: 1000 })]
    const r = buildAccountBurnersReport({ ...base, events, cards: [] })
    assert.strictEqual(r.coverage.coversWindow, false)
    assert.match(r.note, /COVERAGE GAP/)
  })

  test('no attributable events → an explicit empty verdict, never a crash', () => {
    const r = buildAccountBurnersReport({ ...base, events: [], cards: [] })
    assert.strictEqual(r.fiveHour.totalBurners, 0)
    assert.strictEqual(r.sevenDay.totalBurners, 0)
    assert.match(r.verdict, /No consumption events attribute/)
  })

  test('the text carries BOTH window tables with explicit cache-created / cache-read columns', () => {
    const events = [
      ev({ ts: NOW - 4 * H, sessionId: 's1', cacheReadTokens: 2e6, cacheCreateTokens: 5e5, costUsd: 4 }),
    ]
    const r = buildAccountBurnersReport({ ...base, events, cards: [] })
    assert.match(r.text, /━━ 5h window of b@example\.com \(rotated out\) ending/)
    assert.match(r.text, /━━ 7d window of b@example\.com \(rotated out\) ending/)
    assert.match(r.text, /cache-created\s+cache-read/)
  })
})

// The segments type is exercised structurally too — a compile-time guard that the public shape
// tests rely on does not drift silently.
const _shapeGuard: AccountSegment = { accountId: 'x', email: null, plan: null, startMs: 0, endMs: null }
void _shapeGuard
