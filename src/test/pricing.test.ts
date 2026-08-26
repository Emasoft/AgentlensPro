import * as assert from 'assert'
import { lookupRates, calcTokenCostUsd } from '../shared/pricing'

suite('pricing', () => {
  test('lookupRates returns rates for known model', () => {
    const rates = lookupRates('claude-sonnet-4-6')
    assert.ok(rates !== null, 'Should find rates for claude-sonnet-4-6')
    assert.ok(rates!.inputPerMTok > 0)
    assert.ok(rates!.outputPerMTok > 0)
  })

  test('lookupRates returns null for unknown model', () => {
    const rates = lookupRates('totally-unknown-model-xyz')
    assert.strictEqual(rates, null)
  })

  test('lookupRates strips date suffix', () => {
    const rates = lookupRates('claude-sonnet-4-6-20260101')
    assert.ok(rates !== null, 'Should match after stripping date suffix')
  })

  test('lookupRates does not map a bare id onto a longer key (silent $0 pricing bug)', () => {
    // `gpt-5` has no exact entry; the old bidirectional prefix match (`key.startsWith(normalized)`)
    // returned the first-inserted `gpt-5-mini` (input $0), silently pricing a real gpt-5 session at $0.
    // It must now be unpriced (null) so the `unpriced` flag surfaces an unknown model instead.
    assert.strictEqual(lookupRates('gpt-5'), null)
  })

  test('lookupRates prefers the longest (most specific) family prefix', () => {
    // `gpt-4o-mini-preview` is prefixed by BOTH `gpt-4o` and `gpt-4o-mini`. The old first-match
    // returned the broader `gpt-4o`; the fix must pick the most specific `gpt-4o-mini`.
    const broad = lookupRates('gpt-4o')
    const specific = lookupRates('gpt-4o-mini')
    const resolved = lookupRates('gpt-4o-mini-preview')
    assert.ok(broad && specific && resolved, 'all three resolve')
    assert.strictEqual(resolved!.inputPerMTok, specific!.inputPerMTok, 'resolves to the specific mini rate')
    assert.notStrictEqual(resolved!.inputPerMTok, broad!.inputPerMTok, 'not the broad gpt-4o rate')
  })

  test('calcTokenCostUsd returns 0 for unknown model', () => {
    const cost = calcTokenCostUsd(10000, 0, 0, 2000, 'nonexistent-model')
    assert.strictEqual(cost, 0)
  })

  test('calcTokenCostUsd computes correct value for claude-sonnet-4-6', () => {
    // inputPerMTok: 3.00, outputPerMTok: 15.00
    // 1M input = $3.00, 1M output = $15.00
    const cost = calcTokenCostUsd(1_000_000, 0, 0, 1_000_000, 'claude-sonnet-4-6')
    assert.ok(Math.abs(cost - 18.00) < 0.001, `Expected ~$18, got $${cost}`)
  })

  test('calcTokenCostUsd includes cache read tokens', () => {
    // cacheReadPerMTok: 0.30 for claude-sonnet-4-6
    const costNoCache = calcTokenCostUsd(1_000_000, 0, 0, 0, 'claude-sonnet-4-6')
    const costWithCache = calcTokenCostUsd(1_000_000, 1_000_000, 0, 0, 'claude-sonnet-4-6')
    assert.ok(costWithCache > costNoCache, 'Cache read tokens should add to cost')
    assert.ok(Math.abs(costWithCache - (3.00 + 0.30)) < 0.001)
  })

  test('calcTokenCostUsd returns 0 for included (free) model', () => {
    // gpt-4.1 has all-zero rates
    const cost = calcTokenCostUsd(100_000, 0, 0, 10_000, 'gpt-4.1')
    assert.strictEqual(cost, 0)
  })

  test('calcTokenCostUsd uses flat rate for claude-sonnet-4 under threshold', () => {
    // 100K input + 50K output — all below 200K, so same as flat rate
    const cost = calcTokenCostUsd(100_000, 0, 0, 50_000, 'claude-sonnet-4')
    const expected = (100_000 / 1_000_000) * 3.00 + (50_000 / 1_000_000) * 15.00
    assert.ok(Math.abs(cost - expected) < 0.0001, `Expected $${expected}, got $${cost}`)
  })

  // The surcharge is a WHOLE-REQUEST STEP on total input size (input + cacheRead + cacheWrite),
  // never per-bucket marginal tiering — settled from the live provider rate pages (TRDD-R4DHDK7L).
  test('calcTokenCostUsd whole-request step for claude-sonnet-4 above 200K input', () => {
    // 300K input, 50K output: total input > 200K, so EVERYTHING at premium ($6 in / $22.50 out)
    const cost = calcTokenCostUsd(300_000, 0, 0, 50_000, 'claude-sonnet-4')
    const expected = (300_000 / 1_000_000) * 6.00 + (50_000 / 1_000_000) * 22.50
    assert.ok(Math.abs(cost - expected) < 0.0001, `Expected $${expected}, got $${cost}`)
  })

  test('calcTokenCostUsd step trips on COMBINED buckets even when each is under 200K', () => {
    // 150K input + 150K cacheRead = 300K total: the exact case where marginal per-bucket tiering
    // (the old, wrong model) would have billed everything flat.
    const cost = calcTokenCostUsd(150_000, 150_000, 0, 0, 'claude-sonnet-4')
    const expected = (150_000 / 1_000_000) * 6.00 + (150_000 / 1_000_000) * 0.60
    assert.ok(Math.abs(cost - expected) < 0.0001, `Expected $${expected}, got $${cost}`)
  })

  test('calcTokenCostUsd output alone never trips the step for claude-sonnet-4', () => {
    // 0 input, 250K output: output does not count toward the threshold — all flat $15
    const cost = calcTokenCostUsd(0, 0, 0, 250_000, 'claude-sonnet-4')
    const expected = (250_000 / 1_000_000) * 15.00
    assert.ok(Math.abs(cost - expected) < 0.0001, `Expected $${expected}, got $${cost}`)
  })

  test('calcTokenCostUsd gpt-5.4 uses its own 272K threshold', () => {
    // 250K input is above 200K but BELOW gpt-5.4's 272K threshold — flat $2.50
    const under = calcTokenCostUsd(250_000, 0, 0, 10_000, 'gpt-5.4')
    const expectedUnder = (250_000 / 1_000_000) * 2.50 + (10_000 / 1_000_000) * 15.00
    assert.ok(Math.abs(under - expectedUnder) < 0.0001, `Expected $${expectedUnder}, got $${under}`)
    // 300K input crosses 272K — whole request at $5 in / $22.50 out
    const over = calcTokenCostUsd(300_000, 0, 0, 10_000, 'gpt-5.4')
    const expectedOver = (300_000 / 1_000_000) * 5.00 + (10_000 / 1_000_000) * 22.50
    assert.ok(Math.abs(over - expectedOver) < 0.0001, `Expected $${expectedOver}, got $${over}`)
  })

  test('calcTokenCostUsd gpt-5.5 below and above its 272K threshold', () => {
    const under = calcTokenCostUsd(100_000, 0, 0, 20_000, 'gpt-5.5')
    const expectedUnder = (100_000 / 1_000_000) * 5.00 + (20_000 / 1_000_000) * 30.00
    assert.ok(Math.abs(under - expectedUnder) < 0.0001, `Expected $${expectedUnder}, got $${under}`)
    const over = calcTokenCostUsd(200_000, 100_000, 0, 20_000, 'gpt-5.5')
    const expectedOver = (200_000 / 1_000_000) * 10.00 + (100_000 / 1_000_000) * 1.00 + (20_000 / 1_000_000) * 45.00
    assert.ok(Math.abs(over - expectedOver) < 0.0001, `Expected $${expectedOver}, got $${over}`)
  })

  test('calcTokenCostUsd gemini-2.5-pro below and above 200K', () => {
    const under = calcTokenCostUsd(150_000, 0, 0, 5_000, 'gemini-2.5-pro')
    const expectedUnder = (150_000 / 1_000_000) * 1.25 + (5_000 / 1_000_000) * 10.00
    assert.ok(Math.abs(under - expectedUnder) < 0.0001, `Expected $${expectedUnder}, got $${under}`)
    const over = calcTokenCostUsd(250_000, 0, 0, 5_000, 'gemini-2.5-pro')
    const expectedOver = (250_000 / 1_000_000) * 2.50 + (5_000 / 1_000_000) * 15.00
    assert.ok(Math.abs(over - expectedOver) < 0.0001, `Expected $${expectedOver}, got $${over}`)
  })

  test('calcTokenCostUsd gemini-3.1-pro below and above 200K', () => {
    const under = calcTokenCostUsd(100_000, 50_000, 0, 8_000, 'gemini-3.1-pro')
    const expectedUnder = (100_000 / 1_000_000) * 2.00 + (50_000 / 1_000_000) * 0.20 + (8_000 / 1_000_000) * 12.00
    assert.ok(Math.abs(under - expectedUnder) < 0.0001, `Expected $${expectedUnder}, got $${under}`)
    const over = calcTokenCostUsd(150_000, 100_000, 0, 8_000, 'gemini-3.1-pro')
    const expectedOver = (150_000 / 1_000_000) * 4.00 + (100_000 / 1_000_000) * 0.40 + (8_000 / 1_000_000) * 18.00
    assert.ok(Math.abs(over - expectedOver) < 0.0001, `Expected $${expectedOver}, got $${over}`)
  })

  test('calcTokenCostUsd flat rate for claude-sonnet-4-5 (no tiered rates)', () => {
    // claude-sonnet-4-5 has no above-200K rates; 300K input uses flat $3/MTok
    const cost = calcTokenCostUsd(300_000, 0, 0, 0, 'claude-sonnet-4-5')
    const expected = (300_000 / 1_000_000) * 3.00
    assert.ok(Math.abs(cost - expected) < 0.0001, `Expected $${expected}, got $${cost}`)
  })

  // ── Announced rate changes (sonnet-5 introductory pricing ends 2026-08-31) ──────────────────
  // Before this gate existed the table carried a COMMENT telling a future human to hand-edit four
  // numbers on the right morning. Nothing fires on a date, so from 2026-09-01 every sonnet-5 call
  // would have billed at $2/$10 against a real $3/$15 — a silent 50% under-report, with no error,
  // no unpriced flag, and no way to notice from the output.

  test('a call DURING the promo bills at the introductory rate', () => {
    const rates = lookupRates('claude-sonnet-5', '2026-08-15T12:00:00Z')
    assert.strictEqual(rates!.inputPerMTok, 2.00)
    assert.strictEqual(rates!.outputPerMTok, 10.00)
  })

  test('a call ON OR AFTER the end date bills at the sticker rate', () => {
    const rates = lookupRates('claude-sonnet-5', '2026-09-01T00:00:00Z')
    assert.strictEqual(rates!.inputPerMTok, 3.00, 'input must revert to $3/MTok')
    assert.strictEqual(rates!.cacheReadPerMTok, 0.30)
    assert.strictEqual(rates!.cacheWritePerMTok, 3.75)
    assert.strictEqual(rates!.outputPerMTok, 15.00, 'output must revert to $15/MTok')
  })

  test('calcTokenCostUsd applies the scheduled change via the call timestamp', () => {
    const during = calcTokenCostUsd(1_000_000, 0, 0, 0, 'claude-sonnet-5', 0, '2026-08-15T12:00:00Z')
    const after  = calcTokenCostUsd(1_000_000, 0, 0, 0, 'claude-sonnet-5', 0, '2026-09-01T00:00:00Z')
    assert.ok(Math.abs(during - 2.00) < 1e-9, `promo: expected $2.00, got $${during}`)
    assert.ok(Math.abs(after  - 3.00) < 1e-9, `post-promo: expected $3.00, got $${after}`)
  })

  test('a historical call keeps its ORIGINAL rate no matter when it is read', () => {
    // The whole point of gating on the CALL's timestamp rather than on today's date. A session
    // recorded during the promo cost $2/MTok and must report $2/MTok forever — the same reason
    // `claude-opus-4-7-fast` is retained at its old premium rates. A table that only knows
    // "the current rate" rewrites history on every rate change.
    const asRecorded = calcTokenCostUsd(1_000_000, 0, 0, 0, 'claude-sonnet-5', 0, '2026-07-01T00:00:00Z')
    assert.ok(Math.abs(asRecorded - 2.00) < 1e-9, `Expected the promo rate $2.00, got $${asRecorded}`)
  })

  test('an unparseable timestamp falls back to today, never to the pre-change rate', () => {
    // Date.parse() returns NaN, and every NaN comparison is false — so a naive `when >= effective`
    // would pin a garbage timestamp to the OLD rate permanently, which is precisely the silent
    // wrong number this mechanism exists to prevent. It must resolve like an absent timestamp.
    const garbage = lookupRates('claude-sonnet-5', 'not-a-date')
    const absent  = lookupRates('claude-sonnet-5')
    assert.strictEqual(garbage!.inputPerMTok, absent!.inputPerMTok)
  })

  test('a model with no scheduled change is unaffected by a timestamp', () => {
    const a = lookupRates('claude-sonnet-4-5', '2026-01-01T00:00:00Z')
    const b = lookupRates('claude-sonnet-4-5', '2027-01-01T00:00:00Z')
    assert.strictEqual(a!.inputPerMTok, b!.inputPerMTok)
    assert.strictEqual(a!.outputPerMTok, b!.outputPerMTok)
  })
})
