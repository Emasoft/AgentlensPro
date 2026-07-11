import * as assert from 'assert'
import {
  handleGetAccountStatus, handleGetWindowBudget, labelBurnStatusAccounts,
} from '../mcpServer'
import {
  computeBurnStatus, DEFAULT_THRESHOLDS,
  type ConsumptionEvent, type BurnConfig,
} from '../burnMonitor'
import type { AccountInfo } from '../accountInfo'
import type { TtlContext } from '../shared/cacheTtl'
import type { RateLimitsSnapshot } from '../statuslineUsage'

// TRDD-BURNWDGT — REAL tests for the per-account MCP handlers. The burn status is built by the actual
// computeBurnStatus over tagged events (no mock); the account view is a plain AccountInfo literal.

const NOW = 1_700_000_000_000
function cfg(over: Partial<BurnConfig> = {}): BurnConfig {
  return { window5hTokens: null, window7dTokens: null, window5hCostUsd: null, window7dCostUsd: null, capacitySource: 'none', observed: {}, notify: false, thresholds: { ...DEFAULT_THRESHOLDS }, ...over }
}
function account(over: Partial<AccountInfo> = {}): AccountInfo {
  return {
    accountUuid: 'acct-A', email: 'dev@example.com', organizationName: 'Acme', organizationUuid: 'org-1',
    billingType: 'subscription', hasExtraUsageEnabled: true,
    organizationRateLimitTier: 'tier-4', userRateLimitTier: 'tier-2', displayName: 'Dev',
    planType: 'max', rateLimitTier: 'tier-4', label: 'dev@example.com', source: 'claude.json', ...over,
  }
}
// Events across two accounts; A is the current account, B a rotated-away one.
const EVENTS: ConsumptionEvent[] = [
  { ts: NOW - 1000, sessionId: 'a1', accountUuid: 'acct-A', costUsd: 3, tokens: 3000, source: 'statusline' },
  { ts: NOW - 2000, sessionId: 'b1', accountUuid: 'acct-B', costUsd: 9, tokens: 900, source: 'statusline' },
]

suite('mcpServer — get_account_status', () => {
  test('reports the current account (plan/billing) + its own window (not the other account\'s)', () => {
    const burn = computeBurnStatus(EVENTS, [], cfg({ window5hTokens: 30_000 }), NOW)
    const res = handleGetAccountStatus(account(), burn) as {
      account: { label: string; planType: string; billingType: string; hasExtraUsageEnabled: boolean }
      window: { consumedTokens5h: number; fiveHourPctConsumed: number | null }
    }
    assert.strictEqual(res.account.label, 'dev@example.com')
    assert.strictEqual(res.account.planType, 'max')
    assert.strictEqual(res.account.billingType, 'subscription')
    assert.strictEqual(res.account.hasExtraUsageEnabled, true)
    // Only account A's consumption (3000), not pooled with B's 900.
    assert.strictEqual(res.window.consumedTokens5h, 3000)
    assert.strictEqual(res.window.fiveHourPctConsumed, 10)   // 3000 / 30000 = 10%
  })

  test('is graceful when no account is resolved (source none)', () => {
    const burn = computeBurnStatus(EVENTS, [], cfg(), NOW)
    const res = handleGetAccountStatus(null, burn) as { account: { note?: string }; window: unknown }
    assert.ok(res.account.note)
    assert.strictEqual(res.window, null)
  })
})

// TRDD-VY1IUVUM Part-5 — the account/plan/window/cache-TTL command enrichment. The extra ttlCtx +
// rateLimits params are OPTIONAL (the two-arg suite above proves the pre-Part-5 callers still work).
type AccountStatusRes = {
  summary: string
  plan: string
  mode: string
  cacheTtl: { minutes: number; regime: string; ttlSource: string; basis: string }
  usageWindows: { fiveHourPct: number | null; sevenDayPct: number | null; windowSource: 'cc-rate-limits' | 'calibrated' | 'none' }
}
const ttl = (auth: TtlContext['auth']): TtlContext => ({ auth, force5m: false, enable1h: false })

suite('mcpServer — get_account_status Part-5 (plan/mode/cacheTtl/usageWindows)', () => {
  test('Max-5x subscription: plan "Max 5x", within-plan mode, 1h doc-matrix cache TTL', () => {
    const burn = computeBurnStatus(EVENTS, [], cfg({ window5hTokens: 30_000 }), NOW)
    const acct = account({ billingType: 'stripe_subscription', planType: 'max', rateLimitTier: 'default_claude_max_5x' })
    const res = handleGetAccountStatus(acct, burn, ttl('subscription')) as AccountStatusRes
    assert.strictEqual(res.plan, 'Max 5x')                       // planType max + tier _5x → "Max 5x"
    assert.strictEqual(res.mode, 'subscription (within plan)')
    assert.strictEqual(res.cacheTtl.minutes, 60)                 // subscription main → 1-hour tier
    assert.strictEqual(res.cacheTtl.ttlSource, 'doc-matrix')
    assert.strictEqual(res.cacheTtl.regime, 'subscription')
    assert.ok(res.summary.includes('Max 5x') && res.summary.includes('cache TTL 60min'), res.summary)
  })

  test('Max-20x tier parses to "Max 20x"; usage-credits mode → 5-min cache TTL', () => {
    const burn = computeBurnStatus(EVENTS, [], cfg(), NOW)
    const acct = account({ billingType: 'stripe_subscription', planType: 'max', rateLimitTier: 'default_claude_max_20x' })
    const res = handleGetAccountStatus(acct, burn, ttl('usage-credits')) as AccountStatusRes
    assert.strictEqual(res.plan, 'Max 20x')
    assert.strictEqual(res.mode, 'subscription drawing usage credits (over plan limit)')
    assert.strictEqual(res.cacheTtl.minutes, 5)                  // usage-credits main → dropped to 5 min
    assert.strictEqual(res.cacheTtl.ttlSource, 'doc-matrix')
  })

  test('API-key account: plan "Pro", pay-per-token mode, 5-min cache TTL', () => {
    const burn = computeBurnStatus(EVENTS, [], cfg(), NOW)
    const acct = account({ billingType: 'api', planType: 'pro', rateLimitTier: null })
    const res = handleGetAccountStatus(acct, burn, ttl('api-key')) as AccountStatusRes
    assert.strictEqual(res.plan, 'Pro')
    assert.strictEqual(res.mode, 'API key (pay-per-token)')
    assert.strictEqual(res.cacheTtl.minutes, 5)
  })

  test('usageWindows prefers Claude Code rate_limits when present (windowSource cc-rate-limits)', () => {
    const burn = computeBurnStatus(EVENTS, [], cfg({ window5hTokens: 30_000 }), NOW)
    const rl: RateLimitsSnapshot = { ts: NOW / 1000, fiveHourUtilization: 42, sevenDayUtilization: 8 }
    const res = handleGetAccountStatus(account(), burn, ttl('subscription'), rl) as AccountStatusRes
    assert.strictEqual(res.usageWindows.windowSource, 'cc-rate-limits')
    assert.strictEqual(res.usageWindows.fiveHourPct, 42)         // authoritative, NOT the calibrated 10%
    assert.strictEqual(res.usageWindows.sevenDayPct, 8)
  })

  test('usageWindows falls back to the calibrated pct when rate_limits absent (windowSource calibrated)', () => {
    const burn = computeBurnStatus(EVENTS, [], cfg({ window5hTokens: 30_000 }), NOW)
    const res = handleGetAccountStatus(account(), burn, ttl('subscription'), null) as AccountStatusRes
    assert.strictEqual(res.usageWindows.windowSource, 'calibrated')
    assert.strictEqual(res.usageWindows.fiveHourPct, 10)         // 3000 / 30000 = 10%
  })

  test('usageWindows never presents a null as 0: no rate_limits AND no capacity → windowSource none, nulls', () => {
    const burn = computeBurnStatus(EVENTS, [], cfg(), NOW)   // no capacity configured
    const res = handleGetAccountStatus(account(), burn, ttl('subscription'), null) as AccountStatusRes
    assert.strictEqual(res.usageWindows.windowSource, 'none')
    assert.strictEqual(res.usageWindows.fiveHourPct, null)       // null, NEVER 0
    assert.strictEqual(res.usageWindows.sevenDayPct, null)
  })
})

suite('mcpServer — get_window_budget', () => {
  test('returns every account labeled + the pooled machine-wide total', () => {
    const burn = computeBurnStatus(EVENTS, [], cfg(), NOW)
    const res = handleGetWindowBudget(burn, account(), {}) as {
      accounts: Array<{ accountUuid: string | null; accountLabel?: string; budget: { fiveHour: { consumedTokens: number } } }>
      machineWide: { fiveHour: { consumedTokens: number } }
    }
    assert.strictEqual(res.accounts.length, 2)
    // Current account A → email label; rotated-away B → short id label.
    const a = res.accounts.find(w => w.accountUuid === 'acct-A')
    const b = res.accounts.find(w => w.accountUuid === 'acct-B')
    assert.strictEqual(a?.accountLabel, 'dev@example.com')
    assert.strictEqual(b?.accountLabel, 'acct-B')   // slice(0,8) of 'acct-B' is the whole short string
    // Machine-wide pools both (3000 + 900).
    assert.strictEqual(res.machineWide.fiveHour.consumedTokens, 3900)
  })

  test('filters to a single account when accountId is given', () => {
    const burn = computeBurnStatus(EVENTS, [], cfg(), NOW)
    const res = handleGetWindowBudget(burn, account(), { accountId: 'acct-B' }) as { accounts: unknown[] }
    assert.strictEqual(res.accounts.length, 1)
  })

  test('returns a message when the requested account has no consumption', () => {
    const burn = computeBurnStatus(EVENTS, [], cfg(), NOW)
    const res = handleGetWindowBudget(burn, account(), { accountId: 'acct-ZZZ' }) as { accounts: unknown[]; message?: string }
    assert.strictEqual(res.accounts.length, 0)
    assert.ok(res.message)
  })
})

suite('mcpServer — labelBurnStatusAccounts', () => {
  test('labels every per-account window on a burn status', () => {
    const burn = computeBurnStatus(EVENTS, [], cfg(), NOW)
    const labeled = labelBurnStatusAccounts(burn, account())
    assert.ok(labeled.accountWindows.every(w => typeof w.accountLabel === 'string'))
    assert.strictEqual(labeled.accountWindows.find(w => w.accountUuid === 'acct-A')?.accountLabel, 'dev@example.com')
  })
})
