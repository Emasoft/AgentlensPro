import * as assert from 'assert'
import {
  pickWindow, officialBuckets, officialBinding, applyOfficial, officialLine, decideBudget,
  emitRiskTransitions, type EtaPayload, type BudgetDecision,
} from '../cli/budgetCli'
import type { SubscriptionUsage } from '../subscriptionUsage'

// TRDD-M8SV6LK5 — `budget` could run its projection on one window and its cross-check on another.
//
// bindingWindow has THREE documented values (src/windowEta.ts types it '5h' | '7d' | 'none'), and
// 'none' — "neither window is projected to exhaust" — is truthy, so it sailed past the `|| '5h'`
// fallback and became the window KEY. Two consumers then resolved that same key by different rules:
// pickWindow's `key === '7d' ? sevenDay : fiveHour` gave the 5h window to the projection, while
// officialBuckets' `key === '5h' ? session : startsWith('weekly')` gave the 7d buckets to the
// account cross-check. One verdict, two windows, and "none" printed as if it were a window name.
//
// This is the same failure the file's officialBuckets comment was written about, one layer down:
// several numbers, no agreement, and the verdict riding the one nobody had checked.

const win = (over: Partial<{ willExhaustAtCurrentRate: boolean; etaMinutes: number | null }> = {}):
Record<string, unknown> => ({ willExhaustAtCurrentRate: false, etaMinutes: null, ...over })

/** A usage payload the downgrade will actually act on: live and account-verified. */
function usage(fiveHourPct: number, sevenDayPct: number): SubscriptionUsage {
  return {
    limits: [
      { kind: 'session', percent: fiveHourPct, scopeLabel: null },
      { kind: 'weekly_all', percent: sevenDayPct, scopeLabel: null },
    ],
    stale: false,
    accountVerified: 'yes',
    ageSeconds: 5,
    reason: 'live',
    accountLabel: 'test-account',
  } as unknown as SubscriptionUsage
}

suite("budget: the key pickWindow returns must name a REAL window", () => {
  test("bindingWindow 'none' resolves to 5h and SAYS it chose", () => {
    const p = { fiveHour: win(), sevenDay: win(), bindingWindow: 'none' } as unknown as EtaPayload
    const r = pickWindow(p, 'binding')
    assert.strictEqual(r.key, '5h', 'before the fix this was the string "none"')
    assert.strictEqual(r.win, p.fiveHour)
    assert.ok(r.note && /no window is projected to exhaust/.test(r.note),
      'the default is ours, not the payload\'s — say so rather than presenting it as the binding window')
  })

  test('the projection and the official cross-check now read the SAME window', () => {
    const p = { fiveHour: win(), sevenDay: win(), bindingWindow: 'none' } as unknown as EtaPayload
    const { key, win: chosen } = pickWindow(p, 'binding')
    assert.strictEqual(chosen, p.fiveHour, 'projection reads 5h')
    assert.deepStrictEqual(officialBuckets(usage(81, 31), key).map(b => b.label), ['5h'],
      'and the cross-check must read 5h too — it read 7d while the projection read 5h')
  })

  test('THE CONSEQUENCE: a full 5h window no longer hides behind an empty 7d one', () => {
    // MEASURED on this machine: 5h 81%, 7d 31%. applyOfficial downgrades GO to TIGHT at >= 80, but
    // it was handed the 7d figure and so never fired — budget answered GO with the 5h window at 81%.
    const p = { fiveHour: win(), sevenDay: win(), bindingWindow: 'none' } as unknown as EtaPayload
    const u = usage(81, 31)
    const { key, win: chosen } = pickWindow(p, 'binding')
    const bind = officialBinding(u, key)
    const d: BudgetDecision = applyOfficial(decideBudget(chosen, 60, 2), u, bind?.pct ?? null, bind?.label)
    assert.strictEqual(d.verdict, 'TIGHT', `expected the 81% 5h window to downgrade the verdict, got ${d.verdict}`)
    assert.ok(/81% full/.test(d.reason), `the reason must cite the number that caused it: ${d.reason}`)
  })

  test('an explicit --window is untouched, and a real bindingWindow still wins', () => {
    const p = { fiveHour: win(), sevenDay: win(), bindingWindow: '7d' } as unknown as EtaPayload
    assert.strictEqual(pickWindow(p, 'binding').key, '7d')
    assert.strictEqual(pickWindow(p, '5h').key, '5h')
    assert.strictEqual(pickWindow(p, '5h').win, p.fiveHour)
    assert.strictEqual(pickWindow(p, '7d').win, p.sevenDay)
    assert.strictEqual(pickWindow(p, 'binding').note, undefined, 'no note when the payload did choose')
  })

  test('an absent bindingWindow still defaults to 5h, as it always did', () => {
    const p = { fiveHour: win() } as unknown as EtaPayload
    assert.strictEqual(pickWindow(p, 'binding').key, '5h')
  })
})

suite('budget: the arm line must not name a binding window it has not resolved', () => {
  test('no windowKey → every bucket is still listed, but nothing claims to bind', () => {
    const line = officialLine(usage(81, 31))
    assert.ok(line.includes('5h 81%') && line.includes('7d 31%'), `buckets must still be shown: ${line}`)
    assert.ok(!/binding for/.test(line),
      'at arm time the binding window comes from a payload not yet fetched — asserting one contradicted the verdict lines that followed')
  })

  test('with a windowKey the note comes back', () => {
    assert.ok(/binding for 5h: 5h 81%/.test(officialLine(usage(81, 31), '5h')))
  })
})

suite('budget --with-risks: "cannot see" must not render as "nothing to see"', () => {
  test('a dead risk feed is reported ONCE, not swallowed', async function () {
    this.timeout(30_000)
    const prevUi = process.env.AGENTLENS_UI_URL
    const prevMcp = process.env.AGENTLENS_MCP_URL
    // Both transports dead: the REST fast path AND the MCP fallback.
    process.env.AGENTLENS_UI_URL = 'http://127.0.0.1:1'
    process.env.AGENTLENS_MCP_URL = 'http://127.0.0.1:1/mcp'
    const said: string[] = []
    try {
      const st = { down: false }
      const active = new Set<string>()
      await emitRiskTransitions(active, l => said.push(l), st)
      assert.strictEqual(said.length, 1, `expected exactly one outage line, got ${JSON.stringify(said)}`)
      assert.ok(/risk feed unavailable/.test(said[0]), said[0])
      assert.strictEqual(st.down, true)

      // ...and ONCE means once: a line per poll would flood a Monitor, which is why the old code
      // swallowed it. Reporting the transition keeps both properties.
      await emitRiskTransitions(active, l => said.push(l), st)
      assert.strictEqual(said.length, 1, `the outage must not repeat every poll: ${JSON.stringify(said)}`)
    } finally {
      if (prevUi === undefined) delete process.env.AGENTLENS_UI_URL; else process.env.AGENTLENS_UI_URL = prevUi
      if (prevMcp === undefined) delete process.env.AGENTLENS_MCP_URL; else process.env.AGENTLENS_MCP_URL = prevMcp
    }
  })
})
