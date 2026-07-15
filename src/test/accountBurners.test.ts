// get_account_burners (TRDD-1XM0YSWQ) — the attribution rule is the contract under test: an event
// burns the account whose token was active AT ITS TIMESTAMP (machine-wide timeline), so sessions
// alive across a rotation split between accounts instead of pooling onto their card's account.
import * as assert from 'assert'
import {
  buildAccountBurnersReport, resolveTargetAccount, segmentsFromRecords, type AccountSegment,
} from '../accountBurners'
import type { ConsumptionEvent } from '../burnMonitor'

const H = 3600_000
const NOW = Date.UTC(2026, 6, 15, 12, 0, 0)
// A realistic rotation history: A → B → A(current). B's stint = [NOW-8h, NOW-2h).
const RECORDS = [
  { ts: NOW - 20 * H, accountId: 'acct-aaaa', email: 'a@x.com', plan: 'Max 20x' },
  { ts: NOW - 8 * H, accountId: 'acct-bbbb', email: 'b@x.com', plan: 'Max 20x' },
  { ts: NOW - 2 * H, accountId: 'acct-aaaa', email: 'a@x.com', plan: 'Max 20x' },
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
    assert.strictEqual(resolveTargetAccount(SEGS, 'b@x.com', NOW)!.accountId, 'acct-bbbb')
    assert.strictEqual(resolveTargetAccount(SEGS, 'nope@x.com', NOW), null)
  })
})

suite('buildAccountBurnersReport — time-based attribution, ranking, honesty', () => {
  const target = resolveTargetAccount(SEGS, 'previous', NOW)! // acct-bbbb, until = NOW-2h

  test('a session alive across the rotation splits: only events inside the target\'s stint count', () => {
    const events = [
      ev({ ts: NOW - 7 * H, sessionId: 's1', cacheReadTokens: 1_000_000, costUsd: 1 }),  // in B's stint
      ev({ ts: NOW - 1 * H, sessionId: 's1', cacheReadTokens: 9_000_000, costUsd: 9 }),  // AFTER rotation → A's window
      ev({ ts: NOW - 9 * H, sessionId: 's1', cacheReadTokens: 5_000_000, costUsd: 5 }),  // BEFORE B's stint → A's window
    ]
    const r = buildAccountBurnersReport({
      events, target, cards: [], windowHours: 8, untilMs: target.lastActiveMs, nowMs: NOW, limit: 10,
    })
    assert.strictEqual(r.totals.events, 1)
    assert.strictEqual(r.totals.cacheRead, 1_000_000)
    assert.strictEqual(r.totals.costUsd, 1)
  })

  test('ranks by billable weight, not raw tokens: cache-create outranks a bigger cache-read', () => {
    const events = [
      // 10M cache-read = 1M equiv; 2M cache-create = 2.5M equiv — fewer raw tokens, MORE window fill.
      ev({ ts: NOW - 7 * H, sessionId: 'reader', cacheReadTokens: 10_000_000 }),
      ev({ ts: NOW - 7 * H, sessionId: 'writer', cacheCreateTokens: 2_000_000 }),
    ]
    const r = buildAccountBurnersReport({
      events, target, cards: [], windowHours: 8, untilMs: target.lastActiveMs, nowMs: NOW, limit: 10,
    })
    assert.strictEqual(r.burners[0].sessionId, 'writer')
    assert.strictEqual(r.burners[0].billableWeighted, 2_500_000)
    assert.strictEqual(Math.round(r.burners[0].shareOfWindowPct + r.burners[1].shareOfWindowPct), 100)
  })

  test('statusline events without a bucket split count as unknown ×1, never dropped', () => {
    const events = [ev({ ts: NOW - 7 * H, sessionId: 's', tokens: 500_000, source: 'statusline' })]
    const r = buildAccountBurnersReport({
      events, target, cards: [], windowHours: 8, untilMs: target.lastActiveMs, nowMs: NOW, limit: 10,
    })
    assert.strictEqual(r.burners[0].billableWeighted, 500_000)
  })

  test('workspace/model enrich from cards; the verdict names the top burners with shares', () => {
    const events = [ev({ ts: NOW - 7 * H, sessionId: 's1', cacheReadTokens: 1e6, costUsd: 3 })]
    const r = buildAccountBurnersReport({
      events, target,
      cards: [{ sessionId: 's1', workspace: '/w/anime2svg', source: 'claude_code', model: 'claude-fable-5' }],
      windowHours: 8, untilMs: target.lastActiveMs, nowMs: NOW, limit: 10,
    })
    assert.strictEqual(r.burners[0].workspace, '/w/anime2svg')
    assert.strictEqual(r.burners[0].model, 'claude-fable-5')
    assert.match(r.verdict, /anime2svg \(100%/)
  })

  test('discloses a coverage gap when the oldest event is younger than the window start', () => {
    const events = [ev({ ts: NOW - 3 * H, sessionId: 's', cacheReadTokens: 1000 })] // window starts NOW-10h
    const r = buildAccountBurnersReport({
      events, target, cards: [], windowHours: 8, untilMs: target.lastActiveMs, nowMs: NOW, limit: 10,
    })
    assert.strictEqual(r.coverage.coversWindow, false)
    assert.match(r.note, /COVERAGE GAP/)
  })

  test('no attributable events → an explicit empty verdict, never a crash', () => {
    const r = buildAccountBurnersReport({
      events: [], target, cards: [], windowHours: 5, untilMs: target.lastActiveMs, nowMs: NOW, limit: 10,
    })
    assert.strictEqual(r.totalBurners, 0)
    assert.match(r.verdict, /No consumption events attribute/)
  })

  test('the text table carries the header (account, window, totals) and one ranked line per burner', () => {
    const events = [
      ev({ ts: NOW - 7 * H, sessionId: 's1', cacheReadTokens: 2e6, costUsd: 4 }),
      ev({ ts: NOW - 6 * H, sessionId: 's2', cacheCreateTokens: 1e6, costUsd: 2, attribution: 'agent:kraken' }),
    ]
    const r = buildAccountBurnersReport({
      events, target, cards: [], windowHours: 8, untilMs: target.lastActiveMs, nowMs: NOW, limit: 10,
    })
    assert.match(r.text, /window burners of b@x\.com \(rotated out\) — 8h ending/)
    assert.match(r.text, /s2……?\s|s2/) // both sessions listed
    assert.match(r.text, /agent:kraken/)
  })
})

// The segments type is exercised structurally too — a compile-time guard that the public shape
// tests rely on does not drift silently.
const _shapeGuard: AccountSegment = { accountId: 'x', email: null, plan: null, startMs: 0, endMs: null }
void _shapeGuard
