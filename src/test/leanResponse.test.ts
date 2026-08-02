import * as assert from 'assert'
import { leanify } from '../leanResponse'

// Regression suite for the response shaper every MCP tool passes through.
//
// It shipped with no tests and with `shapeRow` dropping every nested object, which deleted the ANSWER
// of any tool whose result is structured. The payload shapes below are transcribed from real
// responses captured off the live server on 2026-07-26 (get_window_budget, get_account_status,
// check_burn_risk) — not invented, so a future shape change breaks these tests rather than silently
// slipping past them.

/** One rolling-window budget, exactly as burnMonitor's windowConsumption() returns it. */
function windowBudget(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    window: '5h',
    windowMs: 18000000,
    consumedTokens: 312290928,
    consumedCostUsd: 214.9353,
    consumedBillableWeighted: 41875214,
    breakdown: { input: 1194, output: 88214, cacheRead: 310006707, cacheCreation: 2194813, other: 0 },
    capacityTokens: 662430177,
    pctConsumed: 47.67,
    capacityCostUsd: 1307.3608,
    pctConsumedCost: 16.58,
    tokensPerMin: 1072271,
    minutesToExhaustion: 337.8,
    ...overrides,
  }
}

/** FOUR accounts, as the live machine actually reports. The count is load-bearing: with a single
 *  element every index is 0, so a `.map(shapeRow)` that leaks the array INDEX into the `depth`
 *  parameter looks correct. That exact bug shipped past a one-element fixture and was only caught
 *  against the live server — element N was shaped as if it sat N levels deep and its answer elided
 *  at the depth guard. Assertions below therefore target the LAST account, not the first. */
function windowBudgetPayload(): Record<string, unknown> {
  const account = (i: number): Record<string, unknown> => ({
    accountUuid: `account-uuid-${i}`,
    accountLabel: `account${i}@example.com`,
    fiveMinTokensPerMin: 1072271 - i,
    events: 14592 - i,
    budget: {
      fiveHour: windowBudget(),
      sevenDay: windowBudget({ window: '7d' }),
      capacitySource: 'none',
      capacityConfigured: false,
      capacityObservedAt: null,
    },
  })
  return {
    capacitySource: 'observed',
    capacityObservedAt: '2026-07-13T22:13:33.635Z',
    accounts: [account(0), account(1), account(2), account(3)],
    machineWide: {
      fiveHour: windowBudget(),
      sevenDay: windowBudget({ window: '7d' }),
      capacitySource: 'observed',
      capacityConfigured: true,
      capacityObservedAt: '2026-07-13T22:13:33.635Z',
    },
  }
}

/** Every leaf path in a value, arrays collapsed to [*] — the metric the live blast-radius scan used. */
function leafPaths(v: unknown, prefix = '', out = new Set<string>()): Set<string> {
  if (v === null || typeof v !== 'object') { if (prefix) out.add(prefix); return out }
  if (Array.isArray(v)) { for (const x of v) leafPaths(x, `${prefix}[*]`, out); return out }
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    leafPaths(x, prefix ? `${prefix}.${k}` : k, out)
  }
  return out
}

suite('leanResponse — the answer survives shaping', () => {
  test('get_window_budget keeps the per-account window numbers that ARE the answer', () => {
    const lean = leanify(windowBudgetPayload()) as Record<string, unknown>
    const paths = leafPaths(lean)
    for (const p of [
      'accounts[*].budget.fiveHour.pctConsumed',
      'accounts[*].budget.fiveHour.consumedTokens',
      'accounts[*].budget.fiveHour.minutesToExhaustion',
      'accounts[*].budget.sevenDay.pctConsumedCost',
      'accounts[*].budget.capacitySource',
      'machineWide.fiveHour.capacityTokens',
    ]) {
      assert.ok(paths.has(p), `lost "${p}" — the shaper deleted part of the answer. Kept: ${[...paths].join(', ')}`)
    }
    // leafPaths collapses arrays, so the check above passes if ANY account kept the path. Assert the
    // LAST account explicitly — that is the one an index-as-depth leak silently guts.
    const accounts = lean.accounts as Record<string, unknown>[]
    assert.strictEqual(accounts.length, 4, 'expected all four accounts')
    const last = accounts[accounts.length - 1]
    const lastFiveHour = ((last.budget as Record<string, unknown>).fiveHour) as Record<string, unknown>
    assert.ok(lastFiveHour, 'the LAST account lost its budget.fiveHour entirely')
    assert.strictEqual(lastFiveHour.pctConsumed, 47.67, 'the LAST account lost budget.fiveHour.pctConsumed')
  })

  test('get_account_status keeps the authoritative usageWindows percentages', () => {
    const lean = leanify({
      summary: 'owner@example.com · Max 20x · subscription (within plan)',
      usageWindows: { fiveHourPct: 5, sevenDayPct: 96, windowSource: 'cc-rate-limits' },
      cacheTtl: { minutes: 60, regime: 'subscription', ttlSource: 'doc-matrix', basis: 'main' },
    }) as Record<string, unknown>
    const uw = lean.usageWindows as Record<string, unknown>
    assert.ok(uw, 'usageWindows was dropped entirely')
    assert.strictEqual(uw.fiveHourPct, 5)
    assert.strictEqual(uw.sevenDayPct, 96)
    assert.strictEqual((lean.cacheTtl as Record<string, unknown>).minutes, 60)
  })

  test('check_burn_risk keeps EVERY risk’s evidence, not just the first', () => {
    // Five risks: with the index leaking into `depth`, risks[4].evidence elides at the guard while
    // risks[0].evidence survives — so this must assert across all of them, never just [0].
    const codes = ['BURN_SPIKE', 'FORK_STORM', 'HUGE_REQUEST_BURST', 'COLD_REWRITE', 'STOP_FAILURES']
    const lean = leanify({
      activeCount: 5,
      risks: codes.map((code, i) => ({
        code, active: true, detail: `${code} detail`,
        evidence: { fiveMinTokensPerMin: 1072271 + i, threshold: 400000 },
      })),
    }) as Record<string, unknown>
    const risks = lean.risks as Record<string, unknown>[]
    risks.forEach((risk, i) => {
      const ev = risk.evidence as Record<string, unknown>
      assert.ok(ev, `risks[${i}].evidence was dropped — that risk becomes unauditable`)
      assert.strictEqual(ev.threshold, 400000, `risks[${i}].evidence.threshold lost`)
    })
  })

  test('array position never changes how deeply a row is shaped', () => {
    // The regression that shipped: `.map(shapeRow)` handed the INDEX to `depth`, so the deeper a row
    // sat in the array the more of its answer was elided. Every row must shape identically.
    const row = () => ({ a: { b: { c: { leaf: 1 } } } })
    const lean = leanify({ rows: [row(), row(), row(), row(), row()] }) as Record<string, unknown>
    const shaped = (lean.rows as unknown[]).map(r => JSON.stringify(r))
    for (let i = 1; i < shaped.length; i++) {
      assert.strictEqual(shaped[i], shaped[0], `row ${i} shaped differently from row 0 — index leaked into depth`)
    }
  })

  test('declared derivation (breakdown) is still removed', () => {
    const paths = leafPaths(leanify(windowBudgetPayload()))
    for (const p of [...paths]) {
      assert.ok(!p.includes('breakdown'), `breakdown survived at "${p}" — it is declared derivation`)
    }
  })

  test('remediation survives — four tool descriptions advertise it as the answer', () => {
    const lean = leanify({
      verdict: 'cold rewrites dominate',
      offenders: [{ cause: 'MODEL_SWITCH', wastedTokens: 412000, remediation: 'pin the model for the session' }],
    }) as Record<string, unknown>
    const first = (lean.offenders as Record<string, unknown>[])[0]
    assert.strictEqual(first.remediation, 'pin the model for the session')
  })
})

suite('leanResponse — bounded and honest', () => {
  test('verbosity:"full" returns the payload untouched', () => {
    const payload = windowBudgetPayload()
    assert.strictEqual(leanify(payload, { verbosity: 'full' }), payload)
  })

  test('a deep object-heavy payload is still forced under the ceiling, with disclosure', () => {
    // No arrays to shrink and no long strings: depth pruning is the ONLY stage that can save this.
    const deep: Record<string, unknown> = {}
    for (let i = 0; i < 60; i++) {
      deep[`account${i}`] = { budget: { fiveHour: windowBudget(), sevenDay: windowBudget({ window: '7d' }) } }
    }
    const maxTokens = 300
    const lean = leanify(deep, { maxTokens }) as Record<string, unknown>
    const approx = Math.ceil(JSON.stringify(lean).length / 4)
    assert.ok(approx <= maxTokens, `payload ${approx} tokens exceeded the ${maxTokens} ceiling`)
    assert.ok(Array.isArray(lean._truncated) && (lean._truncated as string[]).length > 0,
      'degraded the payload without disclosing it')
  })

  test('the ceiling holds INCLUDING the disclosure text it adds to say so', () => {
    // The regression this pins: `stage()` used to compare a candidate against the current payload
    // BEFORE attaching the ~110-char note it was about to add, so every stage looked cheaper than it
    // was. Up to ~15 stages can run, and their accumulated `_truncated` text could push the payload
    // back over the ceiling — the one thing this function promises cannot happen.
    //
    // A SMALL ceiling is the only place it shows: the notes are a rounding error against 1200 tokens
    // and decisive against 60. The payload below needs arrays, depth AND width degraded, so several
    // stages fire and several notes accumulate.
    const wide: Record<string, unknown> = {}
    for (let i = 0; i < 40; i++) {
      wide[`field${i}`] = { nested: { deeper: { rows: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] } } }
    }
    for (const maxTokens of [60, 120, 300]) {
      const lean = leanify(wide, { maxTokens }) as Record<string, unknown>
      const approx = Math.ceil(JSON.stringify(lean).length / 4)
      const notes = Array.isArray(lean._truncated) ? (lean._truncated as string[]).length : 0
      assert.ok(approx <= maxTokens,
        `ceiling ${maxTokens} breached: ${approx} tokens with ${notes} disclosure note(s) — ` +
        'the notes are part of the payload and must be counted against the ceiling that added them')
    }
  })

  test('a nested array cut is disclosed, never silent', () => {
    const lean = leanify({ row: { items: [1, 2, 3, 4, 5, 6, 7] } }) as Record<string, unknown>
    const items = (lean.row as Record<string, unknown>).items as unknown[]
    assert.ok(items.length <= 4, `kept ${items.length} elements — expected the head plus a marker`)
    assert.ok(typeof items[items.length - 1] === 'string' && (items[items.length - 1] as string).includes('more'),
      `nested array truncated silently: ${JSON.stringify(items)}`)
  })

  test('depth guard elides — with disclosure — rather than recursing forever', () => {
    // Self-referential: proves the guard terminates on a cycle instead of blowing the stack.
    const cyclic: Record<string, unknown> = { name: 'root' }
    cyclic.self = cyclic
    const lean = leanify(cyclic) as Record<string, unknown>
    const json = JSON.stringify(lean)
    assert.ok(json.includes('elided'), `expected a disclosed elision marker, got ${json}`)
  })

  test('a pre-rendered {format,text} table passes through, capped and disclosed', () => {
    const short = { format: 'table', text: 'a compact rendering' }
    assert.strictEqual(leanify(short), short)
    const long = { format: 'table', text: 'x'.repeat(20000) }
    const lean = leanify(long, { maxTokens: 100 }) as { text: string }
    assert.ok(lean.text.length < 20000)
    assert.ok(lean.text.includes('truncated'), 'clipped the table without saying so')
  })
})
