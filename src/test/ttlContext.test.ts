import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { detectTtlEnvOverrides, resolveAuthRegime, getTtlContext } from '../ttlContext'
import type { AccountInfo } from '../accountInfo'

// ── Machine-level TTL-signal resolution (TRDD-VY1IUVUM) ───────────────────────
// The Node-side half feeding the pure classifier: auth regime from account signals + the
// prompt-caching env overrides. Every fs test runs against a TEMP home — never ~/.claude.

function account(over: Partial<AccountInfo> = {}): AccountInfo {
  return {
    accountUuid: 'u1', email: 'x@example.com', organizationName: null, organizationUuid: null,
    billingType: 'subscription', hasExtraUsageEnabled: false,
    organizationRateLimitTier: null, userRateLimitTier: null, displayName: null,
    planType: 'max', rateLimitTier: null, label: 'x@example.com', source: 'claude.json',
    ...over,
  }
}

suite('ttlContext — detectTtlEnvOverrides (env + settings.json env block)', () => {
  test('flags resolve from EITHER the process env or the settings env block', () => {
    assert.deepStrictEqual(detectTtlEnvOverrides({}, null), { force5m: false, enable1h: false })
    assert.deepStrictEqual(detectTtlEnvOverrides({ FORCE_PROMPT_CACHING_5M: '1' }, null), { force5m: true, enable1h: false })
    assert.deepStrictEqual(detectTtlEnvOverrides({}, { ENABLE_PROMPT_CACHING_1H: '1' }), { force5m: false, enable1h: true })
    assert.deepStrictEqual(detectTtlEnvOverrides({ ENABLE_PROMPT_CACHING_1H: 'true' }, { FORCE_PROMPT_CACHING_5M: 'true' }), { force5m: true, enable1h: true })
  })

  test('off-values are off: "0"/"false"/"" never count as an override', () => {
    const r = detectTtlEnvOverrides({ FORCE_PROMPT_CACHING_5M: '0', ENABLE_PROMPT_CACHING_1H: 'false' }, { FORCE_PROMPT_CACHING_5M: '' })
    assert.deepStrictEqual(r, { force5m: false, enable1h: false })
  })
})

suite('ttlContext — resolveAuthRegime (account signals → auth row)', () => {
  test('billingType subscription → subscription (the within-plan row is the normal state)', () => {
    assert.strictEqual(resolveAuthRegime(account(), null), 'subscription')
    assert.strictEqual(resolveAuthRegime(account(), 50), 'subscription')
  })

  test('usage-credits needs BOTH the extra-usage opt-in AND ≥100% window fill — either absent stays subscription', () => {
    assert.strictEqual(resolveAuthRegime(account({ hasExtraUsageEnabled: true }), 100), 'usage-credits')
    assert.strictEqual(resolveAuthRegime(account({ hasExtraUsageEnabled: true }), 99), 'subscription')
    assert.strictEqual(resolveAuthRegime(account({ hasExtraUsageEnabled: true }), null), 'subscription', 'no capacity signal → never claim overflow')
    assert.strictEqual(resolveAuthRegime(account({ hasExtraUsageEnabled: false }), 150), 'subscription', 'no opt-in → the account hits the wall, it cannot draw credits')
  })

  test('billingType api → api-key; absent billingType → unknown (never a guess)', () => {
    assert.strictEqual(resolveAuthRegime(account({ billingType: 'api' }), null), 'api-key')
    assert.strictEqual(resolveAuthRegime(account({ billingType: null }), null), 'unknown')
    assert.strictEqual(resolveAuthRegime(null, null), 'unknown')
  })
})

suite('ttlContext — getTtlContext (temp-home fs integration)', () => {
  let seq = 0
  function tempHome(settings?: unknown): { home: string; cleanup: () => void } {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `al-ttl-${process.pid}-${seq++}-`))
    if (settings !== undefined) {
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
      fs.writeFileSync(path.join(home, '.claude', 'settings.json'),
        typeof settings === 'string' ? settings : JSON.stringify(settings))
    }
    return { home, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) }
  }

  test('reads the settings.json env block from the injected home (never the real one)', () => {
    const { home, cleanup } = tempHome({ env: { FORCE_PROMPT_CACHING_5M: '1' } })
    try {
      const ctx = getTtlContext(null, { homeDir: home, account: account(), processEnv: {} })
      assert.deepStrictEqual(ctx, { auth: 'subscription', force5m: true, enable1h: false })
    } finally { cleanup() }
  })

  test('missing/unparseable settings.json degrades to no overrides, never a throw', () => {
    const missing = tempHome()
    const corrupt = tempHome('{not json')
    try {
      for (const h of [missing.home, corrupt.home]) {
        const ctx = getTtlContext(120, { homeDir: h, account: account({ hasExtraUsageEnabled: true }), processEnv: {} })
        assert.deepStrictEqual(ctx, { auth: 'usage-credits', force5m: false, enable1h: false })
      }
    } finally { missing.cleanup(); corrupt.cleanup() }
  })

  test('a null account resolves auth unknown with overrides still detected from process env', () => {
    const { home, cleanup } = tempHome()
    try {
      const ctx = getTtlContext(null, { homeDir: home, account: null, processEnv: { ENABLE_PROMPT_CACHING_1H: '1' } })
      assert.deepStrictEqual(ctx, { auth: 'unknown', force5m: false, enable1h: true })
    } finally { cleanup() }
  })
})
