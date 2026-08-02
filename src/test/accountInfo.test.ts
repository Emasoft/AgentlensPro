import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  parseOauthAccount, parseSubscriptionType, accountLabelFor, getCurrentAccount,
} from '../accountInfo'

// TRDD-BURNWDGT — REAL tests for live-only account/plan resolution. The pure parsers run on real JSON
// shapes (no mocks); getCurrentAccount is driven with an injected homeDir + injected keychain reader so
// the real macOS keychain is NEVER touched under test. A SECURITY test asserts no token ever leaks out.

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-info-'))
suiteTeardown(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best effort */ } })

// The real ~/.claude.json oauthAccount shape (values are synthetic — no real account here).
const REAL_OAUTH = {
  oauthAccount: {
    accountUuid: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
    emailAddress: 'dev@example.com',
    organizationUuid: 'org-123',
    organizationName: 'Acme Co',
    billingType: 'subscription',
    hasExtraUsageEnabled: true,
    organizationRateLimitTier: 'tier-4',
    userRateLimitTier: 'tier-2',
    displayName: 'Dev Example',
  },
}
// The keychain credential blob shape — carries TOKENS plus subscriptionType.
const KEYCHAIN_BLOB = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'sk-ant-oat01-SECRET-TOKEN-VALUE',
    refreshToken: 'sk-ant-ort01-SECRET-REFRESH',
    expiresAt: 9999999999999,
    scopes: ['user:inference'],
    subscriptionType: 'max',
  },
})

suite('accountInfo — oauthAccount parsing', () => {
  test('parseOauthAccount lifts identity fields from the real oauthAccount shape', () => {
    const id = parseOauthAccount(JSON.stringify(REAL_OAUTH))
    assert.ok(id)
    assert.strictEqual(id?.accountUuid, 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa')
    assert.strictEqual(id?.email, 'dev@example.com')
    assert.strictEqual(id?.organizationName, 'Acme Co')
    assert.strictEqual(id?.billingType, 'subscription')
    assert.strictEqual(id?.hasExtraUsageEnabled, true)
    assert.strictEqual(id?.organizationRateLimitTier, 'tier-4')
  })

  test('parseOauthAccount is fail-soft (null) on malformed or account-less config', () => {
    assert.strictEqual(parseOauthAccount('not json'), null)
    assert.strictEqual(parseOauthAccount('{}'), null)
    assert.strictEqual(parseOauthAccount(JSON.stringify({ oauthAccount: 'nope' })), null)
  })
})

suite('accountInfo — plan type extraction (SECURITY: no token leak)', () => {
  test('parseSubscriptionType returns only the plan, never a token', () => {
    const plan = parseSubscriptionType(KEYCHAIN_BLOB)
    assert.strictEqual(plan, 'max')
    // The returned value must not contain any secret substring.
    assert.ok(!String(plan).includes('SECRET'))
    assert.ok(!String(plan).toLowerCase().includes('token'))
  })

  test('parseSubscriptionType supports the top-level (older) shape and is fail-soft', () => {
    assert.strictEqual(parseSubscriptionType(JSON.stringify({ subscriptionType: 'pro' })), 'pro')
    assert.strictEqual(parseSubscriptionType('garbage'), null)
    assert.strictEqual(parseSubscriptionType('{}'), null)
  })
})

suite('accountInfo — label resolution', () => {
  test('the current account resolves to its email; a rotated-away account resolves to a short id', () => {
    const id = parseOauthAccount(JSON.stringify(REAL_OAUTH))
    // Same account → rich label.
    assert.strictEqual(accountLabelFor(id, id?.accountUuid), 'dev@example.com')
    // Different (rotated-away) account → short id only (email not resolvable).
    assert.strictEqual(accountLabelFor(id, 'ffffffff-0000-0000-0000-000000000000'), 'ffffffff')
    // No identity at all → the id short form, else 'unknown'.
    assert.strictEqual(accountLabelFor(null, 'abcd1234-....'), 'abcd1234')
    assert.strictEqual(accountLabelFor(null, null), 'unknown')
  })
})

suite('accountInfo — getCurrentAccount (injected sources, real keychain untouched)', () => {
  test('combines claude.json identity + injected plan into one live view', () => {
    const home = path.join(tmpDir, 'home-ok')
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify(REAL_OAUTH))
    const info = getCurrentAccount({ homeDir: home, readKeychain: () => parseSubscriptionType(KEYCHAIN_BLOB) })
    assert.strictEqual(info.source, 'claude.json')
    assert.strictEqual(info.email, 'dev@example.com')
    assert.strictEqual(info.planType, 'max')
    assert.strictEqual(info.rateLimitTier, 'tier-4')   // org tier wins over user tier
    assert.strictEqual(info.label, 'dev@example.com')
  })

  test('is fail-soft when ~/.claude.json is absent (source none, plan may still resolve)', () => {
    const home = path.join(tmpDir, 'home-empty')
    fs.mkdirSync(home, { recursive: true })
    const info = getCurrentAccount({ homeDir: home, readKeychain: () => 'pro' })
    assert.strictEqual(info.source, 'none')
    assert.strictEqual(info.accountUuid, null)
    assert.strictEqual(info.planType, 'pro')
    assert.strictEqual(info.label, 'unknown')
  })
})
