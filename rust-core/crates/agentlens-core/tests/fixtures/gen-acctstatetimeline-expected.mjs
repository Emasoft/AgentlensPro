// Regenerates acctstatetimeline-expected.json from the COMPILED TS buildAccountStateRecord (the
// parity oracle for build_account_state_record) and from AccountStateTimeline.record()'s return
// value (the observable proxy for the module-private discreteKey, which is never re-implemented
// here). 14 cases from ./c3-account-state-timeline-case-matrix.md Part 1 (records, ids
// 1-8) and Part 2 (keys, ids 9-14) — same ids, same order, in all three authors (this generator,
// the Rust port, and acctstatetimeline_parity.rs). now is ALWAYS explicit — no Date.now().
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-acctstatetimeline-expected.mjs
import { createRequire } from 'module'
import { writeFileSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
const require = createRequire(import.meta.url)
const { buildAccountStateRecord, AccountStateTimeline } = require('../../../../../out/test/accountStateTimeline.js')
const dir = new URL('.', import.meta.url).pathname

const J = (v) => JSON.parse(JSON.stringify(v))

// A full AccountInfo — every field the type requires, nulled out except what a case overrides.
const baseAccount = (overrides) => ({
  accountUuid: 'acct-uuid-1',
  email: 'user@example.com',
  organizationName: 'Acme',
  organizationUuid: 'org-1',
  billingType: 'stripe_subscription',
  hasExtraUsageEnabled: false,
  organizationRateLimitTier: null,
  userRateLimitTier: 'default_claude_max_5x',
  displayName: 'User',
  planType: 'max',
  rateLimitTier: 'default_claude_max_5x',
  label: 'work acct',
  source: 'claude.json',
  ...overrides,
})

const baseTtlCtx = (overrides) => ({
  auth: 'subscription',
  force5m: false,
  enable1h: false,
  ...overrides,
})

const NOW = 1700000000000

// ---- Part 1: buildAccountStateRecord (records 1-8) ----
const records = [
  { id: 'full-subscription', account: baseAccount({}), ttlCtx: baseTtlCtx({}), now: NOW },
  { id: 'no-account', account: null, ttlCtx: null, now: NOW },
  { id: 'source-none', account: baseAccount({ planType: 'max', source: 'none' }), ttlCtx: baseTtlCtx({}), now: NOW },
  { id: 'email-falls-back-to-label', account: baseAccount({ email: null, label: 'work acct' }), ttlCtx: baseTtlCtx({}), now: NOW },
  { id: 'email-empty-string-kept', account: baseAccount({ email: '', label: 'work acct' }), ttlCtx: baseTtlCtx({}), now: NOW },
  { id: 'ttlctx-wins-over-billing', account: baseAccount({ billingType: 'stripe_subscription' }), ttlCtx: baseTtlCtx({ auth: 'usage-credits' }), now: NOW },
  { id: 'no-ttlctx-api-billing', account: baseAccount({ billingType: 'api' }), ttlCtx: null, now: NOW },
  { id: 'unknown-plan-type-echoed', account: baseAccount({ planType: 'some-future-plan', rateLimitTier: 'default_claude_max_20x' }), ttlCtx: baseTtlCtx({}), now: NOW },
]

const recordsOut = records.map((c) => ({
  id: c.id,
  account: J(c.account),
  ttlCtx: J(c.ttlCtx),
  now: c.now,
  expected: J(buildAccountStateRecord(c.account, c.ttlCtx, c.now)),
}))

// ---- Part 2: discreteKey, driven THROUGH AccountStateTimeline.record() (never re-implemented) ----
// `same` = the SECOND record() call returned false (no new discrete key => same key).
const scratchDir = mkdtempSync(join(tmpdir(), 'acctstatetimeline-gen-'))
function sameKey(a, b) {
  const filePath = join(scratchDir, `${Math.random().toString(36).slice(2)}.ndjson`)
  const t = new AccountStateTimeline({ filePath, autoTimer: false })
  const first = t.record(a)
  if (!first) throw new Error('first record() must enqueue')
  const second = t.record(b)
  return !second
}

const baseRecord = () => ({
  ts: NOW,
  accountId: 'acct-1',
  email: 'user@example.com',
  mode: 'subscription (within plan)',
  plan: 'Max 5x',
  authRegime: 'subscription',
  ttlMinutes: 60,
  ttlSource: 'doc-matrix',
})

const keyCases = [
  { id: 'key-ignores-email', a: baseRecord(), b: { ...baseRecord(), email: 'other@example.com' } },
  { id: 'key-ignores-ttlsource', a: baseRecord(), b: { ...baseRecord(), ttlSource: 'measured' } },
  { id: 'key-ignores-ts', a: baseRecord(), b: { ...baseRecord(), ts: NOW + 60_000 } },
  { id: 'key-null-account-is-sentinel', a: { ...baseRecord(), accountId: null }, b: { ...baseRecord(), accountId: '∅' } },
  { id: 'key-mode-differs', a: baseRecord(), b: { ...baseRecord(), mode: 'API key (pay-per-token)' } },
  { id: 'key-ttlminutes-differs', a: baseRecord(), b: { ...baseRecord(), ttlMinutes: 5 } },
]

const keysOut = keyCases.map((c) => ({
  id: c.id,
  a: J(c.a),
  b: J(c.b),
  same: sameKey(c.a, c.b),
}))

rmSync(scratchDir, { recursive: true, force: true })

writeFileSync(join(dir, 'acctstatetimeline-expected.json'), JSON.stringify({ records: recordsOut, keys: keysOut }, null, 1))
console.log(`acctstatetimeline-expected.json: ${recordsOut.length} records: ${JSON.stringify(recordsOut.map((c) => c.id))}`)
console.log(`acctstatetimeline-expected.json: ${keysOut.length} keys: ${JSON.stringify(keysOut.map((c) => c.id))}`)
