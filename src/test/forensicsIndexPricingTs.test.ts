import * as assert from 'assert'
import { apiCallParams, type ApiCallEvent, type ResolvedSpawn } from '../forensicsIndex'
import { calcTokenCostUsd } from '../shared/pricing'

// Every api_calls.cost_usd row is priced HERE, and two independent ways of getting it wrong have
// now both been shipped:
//
//  1. The call omitted `atIso` entirely, so a historical row was priced at INDEX time — the same
//     call cost a different amount depending on the day the indexer ran, and a reindex silently
//     rewrote history. That is precisely the failure `scheduledChange` exists to prevent, unwired
//     at the one site that writes every cost row.
//  2. The fix for (1) passed `new Date(ev.ts).toISOString()` unguarded. That THROWS RangeError on
//     a non-finite ts, inside the indexing loop — turning one corrupt row into a dead ingest run,
//     strictly worse than the mispricing it repaired. `ts` really can arrive non-finite:
//     `resolveTs` returns `Number(r.ts_ms)` and only a literal `null` is filtered downstream
//     (`NaN < tsFromMs` is false, so the window check does not drop it either).
//
// Neither was caught by tsc — the first is a missing argument on an optional parameter, the second
// a runtime throw on a value the types call `number`.
//
// WHAT THIS FILE DOES AND DOES NOT PIN. It pins (2) — the no-throw behaviour — completely. It does
// NOT pin (1): with no live `scheduledChange` anywhere, every rate is constant in time, so
// `calcTokenCostUsd(…, isoString)` and `calcTokenCostUsd(…, undefined)` return the same number and
// the first test below passes with `atIso` deleted from production. That is a real gap, stated
// rather than papered over — it is the THIRD time in this change set that an assertion built on a
// rate which no longer varies turned out to assert nothing, and a comment claiming otherwise is the
// specific defect this thread has been closing. The Rust side pins its half by testing the guard
// function directly (`forensics_scan::pricing_ts_tests`); the equivalent here would need a
// synthetic entry injected into RATES, which is not worth a production seam. Restore a real
// end-to-end assertion at the next announced rate change.

const SPAWN: ResolvedSpawn = {
  spawnKind: null, spawnModelOverride: null, spawnIsolation: null, subagentType: null,
  isSidechain: 0, parentSession: null, spawnResolution: 'unresolved',
}

function ev(ts: number, model = 'claude-sonnet-5'): ApiCallEvent {
  return {
    callId: 'c1', responseRef: 'r1', ts, model, effort: 'none',
    inputTokens: 1_000_000, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 0,
    tier5mTokens: 0, tier1hTokens: 0,
  } as ApiCallEvent
}

suite('forensicsIndex — cost_usd is priced at the CALL\'s timestamp, and survives a bad one', () => {
  test('a finite ts is threaded through to calcTokenCostUsd as the call timestamp', () => {
    const ts = Date.parse('2026-09-01T00:00:00Z')
    const got = apiCallParams(ev(ts), SPAWN, Date.now())[':cost_usd'] as number
    const expected = calcTokenCostUsd(1_000_000, 0, 0, 0, 'claude-sonnet-5', 0, new Date(ts).toISOString())
    assert.strictEqual(got, expected)
    // sonnet-5 is $2/MTok at every timestamp since the withdrawn reversion was removed.
    assert.ok(Math.abs(got - 2.00) < 1e-9, `expected $2.00, got $${got}`)
  })

  // The regression guard. Before the Number.isFinite gate these threw RangeError rather than
  // returning a row, and the throw escaped into the indexer's per-event loop.
  for (const [label, ts] of [['NaN', NaN], ['Infinity', Infinity], ['beyond the Date range', 9e15]] as const) {
    test(`a ts that is ${label} degrades to today's rate instead of throwing`, () => {
      let params: Record<string, unknown> | undefined
      assert.doesNotThrow(() => { params = apiCallParams(ev(ts), SPAWN, Date.now()) })
      const got = params![':cost_usd'] as number
      assert.ok(Number.isFinite(got), `cost must stay a real number, got ${got}`)
      assert.strictEqual(got, calcTokenCostUsd(1_000_000, 0, 0, 0, 'claude-sonnet-5', 0, undefined))
    })
  }

  test('an unknown model still prices at 0 without consulting the timestamp', () => {
    assert.strictEqual(apiCallParams({ ...ev(NaN), model: undefined }, SPAWN, Date.now())[':cost_usd'], 0)
  })

  // TRDD-K4XQ7M2B: cost_usd must price the measured 5m/1h split, same as billable_weight. Hard-coding
  // the 1h argument to 0 priced 1h writes at the 5m rate (37.5% low).
  test('a 1h-tier cache write is priced at the 1h rate, above the all-5m price', () => {
    const ts = Date.parse('2026-09-01T00:00:00Z')
    const e = { ...ev(ts, 'claude-opus-5'), inputTokens: 0, cacheCreationTokens: 1_000_000, tier1hTokens: 1_000_000 }
    const got = apiCallParams(e, SPAWN, Date.now())[':cost_usd'] as number
    const iso = new Date(ts).toISOString()
    assert.strictEqual(got, calcTokenCostUsd(0, 0, 1_000_000, 0, 'claude-opus-5', 1_000_000, iso))
    assert.ok(Math.abs(got - 10.0) < 1e-9, `expected $10.00, got $${got}`)
    assert.ok(got > calcTokenCostUsd(0, 0, 1_000_000, 0, 'claude-opus-5', 0, iso), '1h price must exceed all-5m price')
  })

  // Regression guard for TRDD-K4XQ7M2B acceptance item 2 (flat-total rows keep today's number); NOT mutation
  // evidence for the fix — it passes with or without the 1h argument.
  test('a flat cache_creation total with both tiers 0 is unchanged (priced all-5m)', () => {
    const ts = Date.parse('2026-09-01T00:00:00Z')
    const e = { ...ev(ts, 'claude-opus-5'), inputTokens: 0, cacheCreationTokens: 1_000_000 }
    const got = apiCallParams(e, SPAWN, Date.now())[':cost_usd'] as number
    assert.ok(Math.abs(got - 6.25) < 1e-9, `expected $6.25, got $${got}`)
  })
})
