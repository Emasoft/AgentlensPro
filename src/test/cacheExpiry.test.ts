import * as assert from 'assert'
import { TTL_5M_MS, TTL_1H_MS, type TtlContext } from '../shared/cacheTtl'
import { assessCacheExpiry, formatIdle } from '../cacheExpiry'

// ── Cache-expiry probe (TRDD-OCNHOHE9) ────────────────────────────────────────
// assessCacheExpiry composes the doc-verified TTL regime (cacheTtl.ts) with a
// session's last-LLM-request timestamp to answer "has the prompt cache expired?".
// It NEVER re-declares a TTL number — the regime supplies ttlMs — and it honours
// the same honesty contract: a missing last-request time yields 'unknown', not a guess.

const SUBSCRIPTION: TtlContext = { auth: 'subscription', force5m: false, enable1h: false }
const USAGE_CREDITS: TtlContext = { auth: 'usage-credits', force5m: false, enable1h: false }
const UNKNOWN_AUTH: TtlContext = { auth: 'unknown', force5m: false, enable1h: false }
const NOW = 1_800_000_000_000 // fixed clock so tests are deterministic

suite('formatIdle — compact human idle duration', () => {
  test('renders sub-minute idle as seconds', () => {
    assert.strictEqual(formatIdle(45_000), '45s')
  })
  test('renders minutes with trailing seconds', () => {
    assert.strictEqual(formatIdle(90_000), '1m 30s')
  })
  test('renders hours with trailing minutes (drops seconds)', () => {
    assert.strictEqual(formatIdle(62 * 60_000), '1h 2m')
  })
  test('clamps negative input to 0s (never renders a negative duration)', () => {
    assert.strictEqual(formatIdle(-5_000), '0s')
  })
})

suite('assessCacheExpiry — main conversation on a subscription (1h tier)', () => {
  test('reports fresh when idle is well within the 1h TTL', () => {
    const v = assessCacheExpiry({ lastRequestAtMs: NOW - 30 * 60_000, nowMs: NOW, kind: 'main', ctx: SUBSCRIPTION })
    assert.strictEqual(v.verdict, 'fresh')
    assert.strictEqual(v.ttlMs, TTL_1H_MS)
    assert.strictEqual(v.ttlSource, 'doc-matrix')
    assert.ok(v.marginMs !== null && v.marginMs > 0)
  })
  test('reports expired once idle exceeds the 1h TTL', () => {
    const v = assessCacheExpiry({ lastRequestAtMs: NOW - 90 * 60_000, nowMs: NOW, kind: 'main', ctx: SUBSCRIPTION })
    assert.strictEqual(v.verdict, 'expired')
    assert.ok(v.marginMs !== null && v.marginMs < 0)
    assert.match(v.reason, /evicted|cache-creation/)
  })
  test('treats exactly-at-TTL as still fresh (eviction is strictly after the TTL)', () => {
    const v = assessCacheExpiry({ lastRequestAtMs: NOW - TTL_1H_MS, nowMs: NOW, kind: 'main', ctx: SUBSCRIPTION })
    assert.strictEqual(v.verdict, 'fresh')
    assert.strictEqual(v.marginMs, 0)
  })
})

suite('assessCacheExpiry — subagent is 5-min ALWAYS (auth-independent)', () => {
  test('expires a subagent after 6 minutes even on a subscription', () => {
    const v = assessCacheExpiry({ lastRequestAtMs: NOW - 6 * 60_000, nowMs: NOW, kind: 'subagent', ctx: SUBSCRIPTION })
    assert.strictEqual(v.verdict, 'expired')
    assert.strictEqual(v.ttlMs, TTL_5M_MS)
    assert.strictEqual(v.ttlSource, 'doc-matrix')
  })
})

suite('assessCacheExpiry — subscription drawing usage credits drops to 5-min', () => {
  test('expires a usage-credits main session after 10 minutes', () => {
    const v = assessCacheExpiry({ lastRequestAtMs: NOW - 10 * 60_000, nowMs: NOW, kind: 'main', ctx: USAGE_CREDITS })
    assert.strictEqual(v.verdict, 'expired')
    assert.strictEqual(v.ttlMs, TTL_5M_MS)
  })
})

suite('assessCacheExpiry — honesty contract', () => {
  test('surfaces the assumed 5-min floor when auth is unknown (never a silent guess)', () => {
    const v = assessCacheExpiry({ lastRequestAtMs: NOW - 3 * 60_000, nowMs: NOW, kind: 'main', ctx: UNKNOWN_AUTH })
    assert.strictEqual(v.ttlMs, TTL_5M_MS)
    assert.strictEqual(v.ttlSource, 'assumed')
    assert.strictEqual(v.verdict, 'fresh') // 3m < 5m assumed floor
  })
  test("returns 'unknown' with a reason when no LLM request was recorded", () => {
    const v = assessCacheExpiry({ lastRequestAtMs: null, nowMs: NOW, kind: 'main', ctx: SUBSCRIPTION })
    assert.strictEqual(v.verdict, 'unknown')
    assert.strictEqual(v.idleMs, null)
    assert.strictEqual(v.idleHuman, null)
    assert.strictEqual(v.marginMs, null)
    assert.match(v.reason, /no LLM request/i)
  })
  test('clamps a future last-request timestamp (clock skew) to 0 idle, reporting fresh', () => {
    const v = assessCacheExpiry({ lastRequestAtMs: NOW + 5_000, nowMs: NOW, kind: 'main', ctx: SUBSCRIPTION })
    assert.strictEqual(v.idleMs, 0)
    assert.strictEqual(v.verdict, 'fresh')
  })
})

suite('assessCacheExpiry — explicit --threshold-minutes override', () => {
  test('uses the override TTL, flags it, and labels the source config', () => {
    // 30m idle: fresh under the 1h regime, but EXPIRED under an explicit 15-min threshold.
    const v = assessCacheExpiry({ lastRequestAtMs: NOW - 30 * 60_000, nowMs: NOW, kind: 'main', ctx: SUBSCRIPTION, thresholdMs: 15 * 60_000 })
    assert.strictEqual(v.usedThresholdOverride, true)
    assert.strictEqual(v.ttlMs, 15 * 60_000)
    assert.strictEqual(v.ttlSource, 'config')
    assert.strictEqual(v.verdict, 'expired')
  })
  test('ignores a non-positive override and falls back to the regime TTL', () => {
    const v = assessCacheExpiry({ lastRequestAtMs: NOW - 30 * 60_000, nowMs: NOW, kind: 'main', ctx: SUBSCRIPTION, thresholdMs: 0 })
    assert.strictEqual(v.usedThresholdOverride, false)
    assert.strictEqual(v.ttlMs, TTL_1H_MS)
  })
})
