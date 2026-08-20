// Regenerates ttlaccount-expected.json from the COMPILED TS ttlContext + accountInfo (the
// parity oracle). Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-ttlaccount-expected.mjs
import { createRequire } from 'module'
import { writeFileSync } from 'fs'
const require = createRequire(import.meta.url)
const { detectTtlEnvOverrides, resolveAuthRegime, getTtlContext } = require('../../../../../out/test/ttlContext.js')
const { parseOauthAccount, parseSubscriptionType, accountLabelFor, getCurrentAccount } = require('../../../../../out/test/accountInfo.js')
const dir = new URL('.', import.meta.url).pathname

const authCases = [
  { name: 'null account', account: null, pct: 50 },
  { name: 'billingType null', account: { billingType: null, hasExtraUsageEnabled: false }, pct: null },
  { name: 'stripe_subscription within plan', account: { billingType: 'stripe_subscription', hasExtraUsageEnabled: true }, pct: 99 },
  { name: 'stripe_subscription drawing credits', account: { billingType: 'stripe_subscription', hasExtraUsageEnabled: true }, pct: 100 },
  { name: 'over plan without the opt-in stays subscription', account: { billingType: 'SUBSCRIPTION', hasExtraUsageEnabled: false }, pct: 150 },
  { name: 'over plan with a null pct stays subscription', account: { billingType: 'subscription', hasExtraUsageEnabled: true }, pct: null },
  { name: 'api billing', account: { billingType: 'api', hasExtraUsageEnabled: false }, pct: null },
]
const overrideCases = [
  { name: 'nothing set', processEnv: {}, settingsEnv: null },
  { name: 'process 1 / true', processEnv: { FORCE_PROMPT_CACHING_5M: '1', ENABLE_PROMPT_CACHING_1H: 'true' }, settingsEnv: null },
  { name: 'process 0 / false stay off', processEnv: { FORCE_PROMPT_CACHING_5M: '0', ENABLE_PROMPT_CACHING_1H: 'false' }, settingsEnv: null },
  { name: 'settings string, number and bool shapes', processEnv: {}, settingsEnv: { FORCE_PROMPT_CACHING_5M: 1, ENABLE_PROMPT_CACHING_1H: true } },
  { name: 'settings junk shapes stay off', processEnv: {}, settingsEnv: { FORCE_PROMPT_CACHING_5M: 'yes', ENABLE_PROMPT_CACHING_1H: 0 } },
]
const idFull = { accountUuid: 'acct-aaaa', email: 'fixture-user@example.com', organizationName: 'Fixture Org', organizationUuid: 'org-bbbb', billingType: 'stripe_subscription', hasExtraUsageEnabled: true, organizationRateLimitTier: 'tier_alpha', userRateLimitTier: 'tier_beta', displayName: 'Fixture User' }
const idNoEmail = { ...idFull, email: null }
const idBare = { ...idFull, email: null, displayName: null }
const labelCases = [
  { name: 'own label from email', id: idFull, uuid: 'OMIT' },
  { name: 'null uuid takes the own label too (loose ==)', id: idFull, uuid: null },
  { name: 'matching uuid', id: idFull, uuid: 'acct-aaaa' },
  { name: 'rotated-away uuid gets only its short id', id: idFull, uuid: 'other-uuid-9999' },
  { name: 'display name fallback', id: idNoEmail, uuid: 'OMIT' },
  { name: 'short-uuid fallback', id: idBare, uuid: 'OMIT' },
  { name: 'no id, uuid only', id: null, uuid: 'zzzz-uuid-1234' },
  { name: 'nothing at all', id: null, uuid: null },
]
const oauthTexts = [
  JSON.stringify({ oauthAccount: idFull0() }),
  JSON.stringify({ oauthAccount: { accountUuid: '', emailAddress: 'a@example.com' } }),
  JSON.stringify({ noAccount: true }),
  '{broken',
]
function idFull0() {
  return { accountUuid: 'acct-aaaa', emailAddress: 'fixture-user@example.com', organizationName: 'Fixture Org', organizationUuid: 'org-bbbb', billingType: 'stripe_subscription', hasExtraUsageEnabled: true, organizationRateLimitTier: 'tier_alpha', userRateLimitTier: 'tier_beta', displayName: 'Fixture User' }
}
const subTexts = [
  JSON.stringify({ claudeAiOauth: { subscriptionType: 'max', accessToken: 'never-surfaced' } }),
  JSON.stringify({ subscriptionType: 'pro' }),
  JSON.stringify({ claudeAiOauth: { other: 1 } }),
  'nope',
]
const currentAccountCases = [
  { name: 'full fixture home + injected plan', home: 'ttl-home-a', keychain: 'max' },
  { name: 'full fixture home, no plan', home: 'ttl-home-a', keychain: null },
  { name: 'malformed claude.json → none shape', home: 'ttl-home-bad', keychain: 'max' },
  { name: 'missing claude.json → none shape', home: 'ttl-home-none', keychain: null },
]
const ttlContextCases = [
  { name: 'settings env 1h + subscription account', home: 'ttl-home-set', account: idFull0(), processEnv: {}, pct: null },
  { name: 'process force5m + api account', home: 'ttl-home-none', account: { ...idFull0(), billingType: 'api' }, processEnv: { FORCE_PROMPT_CACHING_5M: '1' }, pct: null },
  { name: 'null account → unknown auth', home: 'ttl-home-none', account: null, processEnv: {}, pct: 120 },
]

const expected = {
  auth: authCases.map(c => ({ name: c.name, regime: resolveAuthRegime(c.account, c.pct) })),
  overrides: overrideCases.map(c => ({ name: c.name, out: detectTtlEnvOverrides(c.processEnv, c.settingsEnv) })),
  labels: labelCases.map(c => ({ name: c.name, label: c.uuid === 'OMIT' ? accountLabelFor(c.id) : accountLabelFor(c.id, c.uuid) })),
  oauth: oauthTexts.map(t => parseOauthAccount(t)),
  subs: subTexts.map(t => parseSubscriptionType(t)),
  currentAccounts: currentAccountCases.map(c => ({
    name: c.name,
    account: getCurrentAccount({ homeDir: dir + c.home, readKeychain: () => c.keychain, now: 0 }),
  })),
  ttlContexts: ttlContextCases.map(c => ({
    name: c.name,
    ctx: getTtlContext(c.pct, { homeDir: dir + c.home, account: c.account, processEnv: c.processEnv, now: 0 }),
  })),
}
writeFileSync(dir + 'ttlaccount-expected.json', JSON.stringify(JSON.parse(JSON.stringify(expected)), null, 1) + '\n')
console.log('wrote', Object.values(expected).map(a => a.length).join('/'), 'case groups')
