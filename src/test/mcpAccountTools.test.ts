import * as assert from 'assert'
import {
  handleGetAccountStatus, handleGetWindowBudget, labelBurnStatusAccounts,
} from '../mcpServer'
import {
  computeBurnStatus, DEFAULT_THRESHOLDS,
  type ConsumptionEvent, type BurnConfig,
} from '../burnMonitor'
import type { AccountInfo } from '../accountInfo'

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
