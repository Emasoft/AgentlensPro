// src/longOAuthKeys.ts — the owner's long-lived OAuth keys, read from the environment by --all.
//
// WHAT THESE GUARD. Each key is a real credential. The tests below prove the two guarantees that make
// it safe to ship the feature: the keys never reach a test process, and no test can reach the real
// API. Every other test in this file runs against a fake fetch, so none of them can spend a message.

import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { AccountRosterEntry, AccountStateRecord } from '../accountStateTimeline'
import { runAllAccountsCli, type AllAccountsDeps } from '../cli/allAccountsCli'
import {
  loadLongOAuthKeys, matchKey, probeRateLimits, redact, refreshLongKeys, usageFromHeaders, type FetchLike, type KeyIdentity,
} from '../longOAuthKeys'
import { archiveAccountUsage, listObservedAccountUsage, TTL_MS, usageRefreshCapability, type SubscriptionUsage } from '../subscriptionUsage'
import { KEYCHAIN_ENV } from '../keychainConsent'

const SLOTS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10']

const NOW = Date.parse('2026-10-29T12:00:00Z')
const HOUR = 3_600_000
const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const LEAK = 'sk-ant-oat01-FAKELEAK'
const ID: KeyIdentity = {
  accountUuid: A, accountLabel: 'x@example.com', accountTier: 'default_claude_max_20x',
  localClaimedLabel: 'x@example.com', accountLabelSuspect: false,
}
const KEY_01 = { CLAUDE_CODE_LONG_OAUTH_KEY_01: 'x@example.com|sk-ant-oat01-FAKE1111' }

/** The measured 200 reply (slot 01, 2026-10-29), with the decoy headers the parser must not read as windows. */
const H200: Partial<Record<string, string>> = {
  'anthropic-ratelimit-unified-5h-reset': '1793286000', 'anthropic-ratelimit-unified-5h-status': 'allowed',
  'anthropic-ratelimit-unified-5h-utilization': '0.01',
  'anthropic-ratelimit-unified-7d-reset': '1793718000', 'anthropic-ratelimit-unified-7d-status': 'allowed',
  'anthropic-ratelimit-unified-7d-utilization': '0.0',
  'anthropic-ratelimit-unified-7d_oi-reset': '1793718000', 'anthropic-ratelimit-unified-7d_oi-status': 'allowed',
  'anthropic-ratelimit-unified-7d_oi-utilization': '0.0',
  'anthropic-ratelimit-unified-fallback-percentage': '0.5',
  'anthropic-ratelimit-unified-overage-disabled-reason': 'org_level_disabled',
  'anthropic-ratelimit-unified-overage-status': 'rejected',
  'anthropic-ratelimit-unified-representative-claim': 'five_hour',
  'anthropic-ratelimit-unified-reset': '1793286000', 'anthropic-ratelimit-unified-status': 'allowed',
}
/** The measured 429 reply (slot 02): the 7-day window is full, so the 429 itself is the reading. */
const H429: Partial<Record<string, string>> = {
  'anthropic-ratelimit-unified-5h-reset': '1793281200', 'anthropic-ratelimit-unified-5h-status': 'allowed',
  'anthropic-ratelimit-unified-5h-utilization': '0.05',
  'anthropic-ratelimit-unified-7d-reset': '1793692800', 'anthropic-ratelimit-unified-7d-status': 'rejected',
  'anthropic-ratelimit-unified-7d-surpassed-threshold': '1.0', 'anthropic-ratelimit-unified-7d-utilization': '1.0',
  'anthropic-ratelimit-unified-7d_oi-reset': '1793692800', 'anthropic-ratelimit-unified-7d_oi-status': 'allowed',
  'anthropic-ratelimit-unified-7d_oi-utilization': '0.0',
  'anthropic-ratelimit-unified-fallback-percentage': '0.5',
  'anthropic-ratelimit-unified-overage-disabled-reason': 'out_of_credits',
  'anthropic-ratelimit-unified-overage-status': 'rejected',
  'anthropic-ratelimit-unified-representative-claim': 'seven_day',
  'anthropic-ratelimit-unified-reset': '1793692800', 'anthropic-ratelimit-unified-status': 'rejected',
  'anthropic-ratelimit-unified-upgrade-paths': 'overage', 'retry-after': '423148',
}
const FORBIDDEN_403 = {
  type: 'error',
  error: {
    type: 'permission_error', message: 'OAuth authentication is currently not allowed for this organization.',
    details: { error_code: 'oauth_not_allowed_for_organization' },
  },
}

function reply(status: number, headers: Partial<Record<string, string>>, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: headers as Record<string, string> })
}

/** A fetch that answers with the given reply and counts its calls. Nothing reaches the network. */
function fakeFetch(answer: () => Response): { impl: FetchLike; probes: { count: number } } {
  const probes = { count: 0 }
  const impl = (async () => { probes.count++; return answer() }) as unknown as FetchLike
  return { impl, probes }
}

/** Run the --all CLI with its console output captured. The keys and the clock are passed in, never read from the shell. */
async function runCli(argv: string[], deps: AllAccountsDeps): Promise<{ code: number; out: string; err: string }> {
  const outs: string[] = []
  const errs: string[] = []
  const realLog = console.log
  const realErr = console.error
  console.log = (...a: unknown[]): void => { outs.push(a.join(' ')) }
  console.error = (...a: unknown[]): void => { errs.push(a.join(' ')) }
  try {
    const code = await runAllAccountsCli(argv, deps)
    return { code, out: outs.join('\n'), err: errs.join('\n') }
  } finally {
    console.log = realLog
    console.error = realErr
  }
}

/** A fresh data directory holding the account-state timeline. The archive, the roster and the stamps all resolve from
 *  AGENTLENS_DATA_DIR, so one sandbox holds everything a run reads and writes. The directory is removed afterwards. */
async function sandboxed<R>(roster: AccountStateRecord[], fn: (dir: string) => Promise<R>): Promise<R> {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'long-keys-'))
  const dir = path.join(sandbox, 'data')
  fs.mkdirSync(dir)
  const tl = path.join(dir, 'account-state.ndjson')
  fs.writeFileSync(tl, roster.map(r => JSON.stringify(r) + '\n').join(''))
  const prevData = process.env.AGENTLENS_DATA_DIR
  const prevLog = process.env.AGENTLENS_ACCOUNT_STATE_LOG
  process.env.AGENTLENS_DATA_DIR = dir
  process.env.AGENTLENS_ACCOUNT_STATE_LOG = tl
  try {
    return await fn(dir)
  } finally {
    if (prevData === undefined) delete process.env.AGENTLENS_DATA_DIR; else process.env.AGENTLENS_DATA_DIR = prevData
    if (prevLog === undefined) delete process.env.AGENTLENS_ACCOUNT_STATE_LOG; else process.env.AGENTLENS_ACCOUNT_STATE_LOG = prevLog
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
}

/** Every file under dir, as text, for the leak scan. */
function allText(dir: string): string {
  const parts: string[] = []
  for (const name of fs.readdirSync(dir, { recursive: true }) as string[]) {
    const full = path.join(dir, name)
    if (fs.statSync(full).isFile()) parts.push(fs.readFileSync(full, 'utf8'))
  }
  return parts.join('\n')
}

function rosterRec(uuid: string, email: string, ts: number): AccountStateRecord {
  return {
    ts, accountId: uuid, email, mode: 'subscription (within plan)', plan: 'Max 20x',
    authRegime: 'subscription', ttlMinutes: 60, ttlSource: 'doc-matrix',
  }
}

/** An archived reading for one account whose 7-day window resets at sevenDayReset (null means no 7-day window). */
function archived(uuid: string, email: string, fetchedAt: number, sevenDayReset: string | null): SubscriptionUsage {
  return {
    fetchedAt, ageSeconds: 0, stale: false, accountFp: 'fixture-fp', accountUuid: uuid, accountLabel: email,
    accountTier: 'default_claude_max_20x', localClaimedLabel: email, accountLabelSuspect: false,
    accountVerified: 'yes', reason: 'ok',
    limits: sevenDayReset === null ? [] : [{
      kind: 'weekly_all', group: 'weekly', percent: 40, severity: 'normal', resetsAt: sevenDayReset,
      isActive: true, scopeLabel: null, resetsInSeconds: null,
    }],
    fiveHourPercent: 10, sevenDayPercent: sevenDayReset === null ? null : 40,
    usageCreditsEnabled: null, spendPercent: null, note: 'fixture',
  }
}
suite('loadLongOAuthKeys — the slots, the first pipe, and the duplicate rule', () => {
  test('slots _01 to _10 are read, a value splits on the first pipe, and both sides are trimmed', () => {
    const { keys, invalid } = loadLongOAuthKeys({
      CLAUDE_CODE_LONG_OAUTH_KEY_01: ' a@example.com | sk-ant-oat01-FAKE1111 ',
      CLAUDE_CODE_LONG_OAUTH_KEY_10: 'b@example.com|sk-ant-oat01-FAKE2222',
    })
    assert.deepStrictEqual(keys.map(k => k.slot), ['01', '10'])
    assert.deepStrictEqual(keys[0], { slot: '01', email: 'a@example.com', token: 'sk-ant-oat01-FAKE1111' })
    assert.deepStrictEqual(invalid, [])
  })

  test('_1 and _11 are never read, and an empty value is skipped without an error', () => {
    const { keys, invalid } = loadLongOAuthKeys({
      CLAUDE_CODE_LONG_OAUTH_KEY_1: 'a@example.com|sk-ant-oat01-FAKE3',
      CLAUDE_CODE_LONG_OAUTH_KEY_11: 'c@example.com|sk-ant-oat01-FAKE4',
      CLAUDE_CODE_LONG_OAUTH_KEY_02: '   ',
    })
    assert.deepStrictEqual(keys, [])
    assert.deepStrictEqual(invalid, [])
  })

  test('a value with no pipe is invalid, and its reason names no part of the value', () => {
    const { keys, invalid } = loadLongOAuthKeys({ CLAUDE_CODE_LONG_OAUTH_KEY_03: 'nopipe-FAKE3' })
    assert.deepStrictEqual(keys, [])
    assert.strictEqual(invalid.length, 1)
    assert.strictEqual(invalid[0].slot, '03')
    assert.ok(!invalid[0].reason.includes('FAKE3'), invalid[0].reason)
  })

  test('a token outside A-Z a-z 0-9 _ - is invalid, and the first pipe leaves a second pipe inside the token', () => {
    const { keys, invalid } = loadLongOAuthKeys({ CLAUDE_CODE_LONG_OAUTH_KEY_04: 'd@example.com|sk-ant-oat01-FAKE4 x|y' })
    assert.deepStrictEqual(keys, [])
    assert.strictEqual(invalid[0].slot, '04')
    assert.ok(!invalid[0].reason.includes('FAKE4'), invalid[0].reason)
  })

  test('two slots for one email in any letter case are both invalid, and neither is loaded', () => {
    const { keys, invalid } = loadLongOAuthKeys({
      CLAUDE_CODE_LONG_OAUTH_KEY_05: 'e@example.com|sk-ant-oat01-FAKE7',
      CLAUDE_CODE_LONG_OAUTH_KEY_06: 'E@Example.com|sk-ant-oat01-FAKE8',
    })
    assert.deepStrictEqual(keys, [])
    assert.deepStrictEqual(invalid.map(i => i.slot), ['05', '06'])
    assert.strictEqual(invalid[0].reason, 'duplicate email in slots 05 and 06')
  })

  test('no invalid entry carries an email or a token, whichever rule failed', () => {
    const { invalid } = loadLongOAuthKeys({
      CLAUDE_CODE_LONG_OAUTH_KEY_01: 'bad-email-FAKE9|sk-ant-oat01-FAKE9',
      CLAUDE_CODE_LONG_OAUTH_KEY_02: 'f@example.com|sk-ant-oat01-FAKE10 spaced',
      CLAUDE_CODE_LONG_OAUTH_KEY_03: 'no-separator-FAKE11',
    })
    assert.strictEqual(invalid.length, 3)
    const text = JSON.stringify(invalid)
    assert.ok(!text.includes('FAKE9') && !text.includes('FAKE10') && !text.includes('FAKE11') && !text.includes('f@example.com'), text)
  })
})

suite('redact — the token by value, then any sk-ant key shape', () => {
  test('the token is masked wherever it appears, and another key of the same family is masked too', () => {
    assert.strictEqual(
      redact('Bearer sk-ant-oat01-FAKE1111 and sk-ant-oat01-OTHER', 'sk-ant-oat01-FAKE1111'),
      'Bearer [redacted] and [redacted]',
    )
  })
})

suite('redact — a token outside the key shape is masked by value', () => {
  test('a token with no sk-ant prefix is still removed wherever it appears', () => {
    assert.strictEqual(redact('a FAKE-PLAIN b FAKE-PLAIN', 'FAKE-PLAIN'), 'a [redacted] b [redacted]')
  })
})
suite('usageFromHeaders — the reply headers become the reading', () => {
  test('the 200 set reads 5h 1%, 7d 0%, Fable 0%, with ISO resets and no decoy taken as a window', () => {
    const u = usageFromHeaders(H200, { fetchedAt: NOW, now: NOW, identity: ID })
    assert.strictEqual(u.fiveHourPercent, 1)
    assert.strictEqual(u.sevenDayPercent, 0)
    assert.deepStrictEqual(u.limits.map(l => l.kind), ['session', 'weekly_all', 'weekly_scoped'])
    assert.strictEqual(u.limits.find(l => l.kind === 'weekly_scoped')?.scopeLabel, 'Fable')
    assert.strictEqual(u.limits[0].resetsAt, new Date(1793286000 * 1000).toISOString())
    assert.deepStrictEqual(u.overage, { status: 'rejected', disabledReason: 'org_level_disabled' })
    assert.strictEqual(u.limits[0].isActive, true, 'representative-claim five_hour makes the 5h window the active one')
    assert.strictEqual(u.limits[1].isActive, false)
    assert.strictEqual(u.source, 'ratelimit-headers')
    assert.strictEqual(u.accountVerified, 'unknown')
  })

  test('the 429 set reads 7d 100 and critical, Fable 0, and the 7-day window is the active one', () => {
    const u = usageFromHeaders(H429, { fetchedAt: NOW, now: NOW, identity: ID })
    const week = u.limits.find(l => l.kind === 'weekly_all')
    assert.strictEqual(week?.percent, 100)
    assert.strictEqual(week?.severity, 'critical')
    assert.strictEqual(week?.isActive, true)
    assert.strictEqual(u.limits.find(l => l.scopeLabel === 'Fable')?.percent, 0)
    assert.strictEqual(u.limits.find(l => l.kind === 'session')?.percent, 5)
    assert.deepStrictEqual(u.overage, { status: 'rejected', disabledReason: 'out_of_credits' })
  })

  test('a missing utilization is null, never 0', () => {
    const u = usageFromHeaders({
      'anthropic-ratelimit-unified-5h-status': 'allowed', 'anthropic-ratelimit-unified-5h-reset': '1793286000',
    }, { fetchedAt: NOW, now: NOW, identity: ID })
    assert.strictEqual(u.fiveHourPercent, null)
    assert.strictEqual(u.limits[0].percent, null)
  })

  test('an unknown window suffix keeps its raw name as the scope label', () => {
    const u = usageFromHeaders({
      'anthropic-ratelimit-unified-7d_xq-utilization': '0.2', 'anthropic-ratelimit-unified-7d_xq-status': 'allowed',
      'anthropic-ratelimit-unified-7d_xq-reset': '1793718000',
    }, { fetchedAt: NOW, now: NOW, identity: ID })
    assert.strictEqual(u.limits[0].scopeLabel, '7d_xq')
    assert.strictEqual(u.limits[0].percent, 20)
  })

  test('a utilization just under 1 that rounds up to 100 is held at 99.9', () => {
    const u = usageFromHeaders({ 'anthropic-ratelimit-unified-7d-utilization': '0.9995' }, { fetchedAt: NOW, now: NOW, identity: ID })
    assert.strictEqual(u.sevenDayPercent, 99.9)
  })

  test('a utilization of 1.2 is reported as 120, because an over-limit window is above 100', () => {
    const u = usageFromHeaders({ 'anthropic-ratelimit-unified-7d-utilization': '1.2' }, { fetchedAt: NOW, now: NOW, identity: ID })
    assert.strictEqual(u.sevenDayPercent, 120)
  })
})

suite('probeRateLimits — what comes back, scrubbed', () => {
  test('a 200 and a 429 both return their unified headers, so the 429 is a reading', async () => {
    const sentBodies: string[] = []
    const okImpl = (async (_url: string, init: { body: string }) => { sentBodies.push(init.body); return reply(200, H200) }) as unknown as FetchLike
    const r200 = await probeRateLimits('sk-ant-oat01-FAKE1111', okImpl, 'claude-code/test')
    assert.strictEqual(r200.httpStatus, 200)
    assert.strictEqual(JSON.parse(sentBodies[0]).max_tokens, 0)
    assert.strictEqual(r200.headers['anthropic-ratelimit-unified-5h-utilization'], '0.01')
    const limited = fakeFetch(() => reply(429, H429, { type: 'error' }))
    const r429 = await probeRateLimits('sk-ant-oat01-FAKE1111', limited.impl, 'claude-code/test')
    assert.strictEqual(r429.httpStatus, 429)
    assert.strictEqual(r429.headers['anthropic-ratelimit-unified-7d-status'], 'rejected')
    assert.strictEqual(r429.headers['retry-after'], '423148')
  })

  test('a 403 returns its error type and error code, and no rate-limit headers', async () => {
    const forbidden = fakeFetch(() => reply(403, {}, FORBIDDEN_403))
    const r = await probeRateLimits('sk-ant-oat01-FAKE1111', forbidden.impl, 'claude-code/test')
    assert.strictEqual(r.httpStatus, 403)
    assert.strictEqual(r.errorType, 'permission_error')
    assert.strictEqual(r.errorCode, 'oauth_not_allowed_for_organization')
    assert.deepStrictEqual(r.headers, {})
  })

  test('a fetch that never answers is cut by the timeout and reads as no reply', async () => {
    const hanging = ((_url: string, init: { signal?: AbortSignal | null }) => new Promise<Response>((_resolve, reject) => {
      // WHY once: the signal belongs to this one call, so the listener must not outlive it.
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    })) as unknown as FetchLike
    const r = await probeRateLimits('sk-ant-oat01-FAKE1111', hanging, 'claude-code/test', 50)
    assert.strictEqual(r.httpStatus, null)
    assert.ok(r.message !== null && r.message.includes('TimeoutError'), String(r.message))
  })

  test('a token that makes the platform reject its Authorization header is scrubbed out of the error', async () => {
    const never = fakeFetch(() => reply(200, H200))
    const r = await probeRateLimits('sk-ant-oat01-FAKECTRL\nx', never.impl, 'claude-code/test')
    assert.strictEqual(r.httpStatus, null)
    assert.strictEqual(never.probes.count, 0, 'Headers is built before the fetch, so nothing is sent')
    assert.ok(r.message !== null && !r.message.includes('FAKECTRL'), String(r.message))
  })
})

suite('matchKey — one account by email, the archive and the roster agreeing', () => {
  test('an archive record and a roster row with one uuid match, the email compared without case', () => {
    const roster: AccountRosterEntry[] = [{
      accountId: A, email: 'x@example.com', plan: 'Max 20x', mode: 'subscription', authRegime: 'subscription',
      firstSeen: NOW, lastStateChange: NOW, leftAt: null,
    }]
    const m = matchKey('X@Example.com', [archived(A, 'x@example.com', NOW, null)], roster)
    assert.strictEqual(m.kind, 'matched')
    if (m.kind === 'matched') {
      assert.strictEqual(m.accountId, A)
      assert.strictEqual(m.identity.accountTier, 'default_claude_max_20x', 'the identity comes from the archive record')
    }
  })

  test('an email in neither the archive nor the roster is unmatched', () => {
    assert.strictEqual(matchKey('z@example.com', [], []).kind, 'unmatched')
  })
})
suite('the --all CLI — the reading, its identity, and the refusals', () => {
  test('a matched key files its reading under the account, keeps the identity, and reports the row fresh and cross-checked', async () => {
    await sandboxed([rosterRec(A, 'x@example.com', NOW - 2 * HOUR)], async () => {
      archiveAccountUsage(archived(A, 'x@example.com', NOW - HOUR, '2026-11-03T15:00:00.000Z'))
      const probe = fakeFetch(() => reply(200, H200))
      const res = await runCli(['--json'], { env: KEY_01, fetchImpl: probe.impl, now: NOW })
      assert.strictEqual(res.code, 0, res.err)
      assert.strictEqual(probe.probes.count, 1)
      const payload = JSON.parse(res.out)
      assert.strictEqual(payload.longKeys[0].outcome, 'refreshed')
      assert.strictEqual(payload.longKeys[0].identity, 'cross-checked')
      assert.strictEqual(payload.longKeys[0].accountId, A)
      const row = payload.accounts.find((a: { accountId: string }) => a.accountId === A)
      assert.strictEqual(row.fiveHour.freshness, 'fresh')
      const filed = listObservedAccountUsage().find(u => u.accountUuid === A)
      assert.strictEqual(filed?.fetchedAt, NOW)
      assert.strictEqual(filed?.accountTier, 'default_claude_max_20x', 'the identity fields are kept from the archive')
      assert.strictEqual(filed?.accountLabel, 'x@example.com')
      assert.strictEqual(filed?.source, 'ratelimit-headers')
    })
  })

  test('a 7-day reset that differs from the archived account refuses the key and leaves the archive untouched', async () => {
    await sandboxed([rosterRec(A, 'x@example.com', NOW - 2 * HOUR)], async () => {
      archiveAccountUsage(archived(A, 'x@example.com', NOW - HOUR, '2026-11-10T15:00:00.000Z'))
      const probe = fakeFetch(() => reply(200, H200))
      const res = await runCli(['--json'], { env: KEY_01, fetchImpl: probe.impl, now: NOW })
      const payload = JSON.parse(res.out)
      assert.strictEqual(payload.longKeys[0].outcome, 'refused')
      assert.ok(String(payload.longKeys[0].reason).includes('7-day reset differs'), res.out)
      assert.strictEqual(listObservedAccountUsage().find(u => u.accountUuid === A)?.fetchedAt, NOW - HOUR)
    })
  })

  test('a 429 that carries the unified headers is a reading, and it is filed: the 429 is the measurement', async () => {
    await sandboxed([rosterRec(A, 'x@example.com', NOW - 2 * HOUR)], async () => {
      const probe = fakeFetch(() => reply(429, H429, { type: 'error' }))
      const res = await runCli(['--json'], { env: KEY_01, fetchImpl: probe.impl, now: NOW })
      const row = JSON.parse(res.out).longKeys[0]
      assert.strictEqual(row.outcome, 'refreshed')
      assert.strictEqual(row.httpStatus, 429)
      assert.strictEqual(listObservedAccountUsage().find(u => u.accountUuid === A)?.sevenDayPercent, 100)
    })
  })
  test('an archive record and a roster row that name different accounts refuse the key before any message is sent', async () => {
    await sandboxed([rosterRec(A, 'x@example.com', NOW - 2 * HOUR)], async () => {
      archiveAccountUsage(archived(B, 'x@example.com', NOW - HOUR, '2026-11-03T15:00:00.000Z'))
      const probe = fakeFetch(() => reply(200, H200))
      const res = await runCli(['--json'], { env: KEY_01, fetchImpl: probe.impl, now: NOW })
      assert.strictEqual(JSON.parse(res.out).longKeys[0].outcome, 'refused')
      assert.strictEqual(probe.probes.count, 0)
      assert.strictEqual(listObservedAccountUsage().find(u => u.accountUuid === B)?.fetchedAt, NOW - HOUR)
    })
  })

  test('two archived accounts with one email refuse the key before any message is sent', async () => {
    await sandboxed([rosterRec(B, 'other@example.com', NOW - HOUR)], async () => {
      archiveAccountUsage(archived(A, 'x@example.com', NOW - HOUR, '2026-11-03T15:00:00.000Z'))
      archiveAccountUsage(archived(B, 'x@example.com', NOW - HOUR, '2026-11-03T15:00:00.000Z'))
      const probe = fakeFetch(() => reply(200, H200))
      const res = await runCli(['--json'], { env: KEY_01, fetchImpl: probe.impl, now: NOW })
      assert.strictEqual(JSON.parse(res.out).longKeys[0].outcome, 'refused')
      assert.strictEqual(probe.probes.count, 0)
    })
  })

  test('a rolled archived 7-day window makes the identity claimed, not cross-checked', async () => {
    await sandboxed([rosterRec(A, 'x@example.com', NOW - 2 * HOUR)], async () => {
      archiveAccountUsage(archived(A, 'x@example.com', NOW - HOUR, '2026-10-29T10:00:00.000Z'))
      const probe = fakeFetch(() => reply(200, H200))
      const res = await runCli(['--json'], { env: KEY_01, fetchImpl: probe.impl, now: NOW })
      assert.strictEqual(JSON.parse(res.out).longKeys[0].identity, 'claimed')
      assert.strictEqual(probe.probes.count, 1)
    })
  })

  test('an empty roster with a key that reads exits 0 and prints the long-lived key section', async () => {
    await sandboxed([], async () => {
      archiveAccountUsage(archived(A, 'x@example.com', NOW - HOUR, '2026-11-03T15:00:00.000Z'))
      const probe = fakeFetch(() => reply(200, H200))
      const res = await runCli([], { env: KEY_01, fetchImpl: probe.impl, now: NOW })
      assert.strictEqual(res.code, 0, res.err)
      assert.ok(res.out.includes('Long-lived keys'), res.out)
      assert.ok(res.out.includes('key 01  x@example.com  refreshed  5h 1%  7d 0%  Fable 0%  credits off (org)'), res.out)
    })
  })
})
/** The rows refreshLongKeys settles for the slot-01 key, so a test can read a row's reading and checkedAt directly. */
function settleKey(dir: string, fetchImpl: FetchLike, now: number) {
  return refreshLongKeys(loadLongOAuthKeys(KEY_01).keys, { fetchImpl, now, stampDir: path.join(dir, 'long-key-probes'), userAgentValue: 'test' })
}
suite('the --all CLI — the TTL, the flags, the unmatched and BLIND cases', () => {
  test('a 403 files nothing and is stamped, and the next run inside the TTL sends nothing and shows the same reason', async () => {
    await sandboxed([rosterRec(B, 'other@example.com', NOW - HOUR)], async dir => {
      const probe = fakeFetch(() => reply(403, {}, FORBIDDEN_403))
      const first = JSON.parse((await runCli(['--json'], { env: KEY_01, fetchImpl: probe.impl, now: NOW })).out)
      assert.strictEqual(first.longKeys[0].outcome, 'failed')
      assert.strictEqual(first.longKeys[0].reason, 'HTTP 403 oauth_not_allowed_for_organization')
      assert.strictEqual(probe.probes.count, 1)
      assert.strictEqual(fs.readdirSync(path.join(dir, 'long-key-probes')).length, 1, 'one stamp per key')
      assert.strictEqual(listObservedAccountUsage().length, 0, 'a failed probe files nothing')
      const second = JSON.parse((await runCli(['--json'], { env: KEY_01, fetchImpl: probe.impl, now: NOW })).out)
      assert.strictEqual(probe.probes.count, 1, 'inside the TTL nothing is sent')
      assert.strictEqual(second.longKeys[0].outcome, 'failed')
      assert.strictEqual(second.longKeys[0].reason, 'HTTP 403 oauth_not_allowed_for_organization')
      assert.strictEqual(second.longKeys[0].checkedAt, new Date(NOW).toISOString())
    })
  })

  test('a cached run keeps the original instant, so the TTL really runs out and the key is probed again', async () => {
    await sandboxed([], async () => {
      const probe = fakeFetch(() => reply(403, {}, FORBIDDEN_403))
      await runCli(['--json'], { env: KEY_01, fetchImpl: probe.impl, now: NOW })
      await runCli(['--json'], { env: KEY_01, fetchImpl: probe.impl, now: NOW + TTL_MS - 1 })
      assert.strictEqual(probe.probes.count, 1, 'a second run one millisecond inside the TTL is cached')
      await runCli(['--json'], { env: KEY_01, fetchImpl: probe.impl, now: NOW + TTL_MS + 1 })
      assert.strictEqual(probe.probes.count, 2, 'past the TTL from the first probe the key is probed again')
    })
  })

  test('an archived reading inside the TTL is served as cached with no message sent', async () => {
    await sandboxed([rosterRec(A, 'x@example.com', NOW - 2 * HOUR)], async () => {
      archiveAccountUsage(archived(A, 'x@example.com', NOW - 60_000, '2026-11-03T15:00:00.000Z'))
      const probe = fakeFetch(() => reply(200, H200))
      const res = await runCli(['--json'], { env: KEY_01, fetchImpl: probe.impl, now: NOW })
      assert.strictEqual(probe.probes.count, 0)
      assert.strictEqual(JSON.parse(res.out).longKeys[0].outcome, 'cached')
    })
  })

  test('a 403 stamped inside the TTL shows its failure with dashes, never the archived reading from 26 days earlier', async () => {
    await sandboxed([rosterRec(A, 'x@example.com', NOW - 2 * HOUR)], async dir => {
      archiveAccountUsage(archived(A, 'x@example.com', NOW - 26 * 24 * HOUR, '2026-11-03T15:00:00.000Z'))
      const probe = fakeFetch(() => reply(403, {}, FORBIDDEN_403))
      await runCli([], { env: KEY_01, fetchImpl: probe.impl, now: NOW })
      const text = await runCli([], { env: KEY_01, fetchImpl: probe.impl, now: NOW + 2 * 60_000 })
      assert.strictEqual(probe.probes.count, 1, 'inside the TTL nothing is sent')
      assert.ok(text.out.includes('key 01  x@example.com  failed  5h -  7d -  Fable -  credits ?  identity not-checked  [HTTP 403 oauth_not_allowed_for_organization]  (checked 2m ago; next check allowed in 8m)'), text.out)
      const json = JSON.parse((await runCli(['--json'], { env: KEY_01, fetchImpl: probe.impl, now: NOW + 2 * 60_000 })).out).longKeys[0]
      assert.strictEqual(json.outcome, 'failed')
      assert.strictEqual(json.windows, undefined, 'a replayed failure carries no windows, so it has no reading')
      const [row] = await settleKey(dir, probe.impl, NOW + 2 * 60_000)
      assert.strictEqual(row.reading, null)
    })
  })

  test('a failed 403 stamped inside the TTL beats a fresh archived record: the next run replays it with no reading and sends nothing', async () => {
    await sandboxed([rosterRec(A, 'x@example.com', NOW - 2 * HOUR)], async dir => {
      const probe = fakeFetch(() => reply(403, {}, FORBIDDEN_403))
      await runCli(['--json'], { env: KEY_01, fetchImpl: probe.impl, now: NOW })
      archiveAccountUsage(archived(A, 'x@example.com', NOW + 30_000, '2026-11-03T15:00:00.000Z'))
      const [row] = await settleKey(dir, probe.impl, NOW + 60_000)
      assert.strictEqual(probe.probes.count, 1, 'inside the TTL nothing is sent')
      assert.strictEqual(row.outcome, 'failed')
      assert.strictEqual(row.reading, null)
    })
  })

  test('a refusal stamped inside the TTL is replayed as refused with the instant of its check, and sends nothing', async () => {
    await sandboxed([rosterRec(A, 'x@example.com', NOW - 2 * HOUR)], async dir => {
      archiveAccountUsage(archived(A, 'x@example.com', NOW - HOUR, '2026-11-10T15:00:00.000Z'))
      const probe = fakeFetch(() => reply(200, H200))
      await runCli(['--json'], { env: KEY_01, fetchImpl: probe.impl, now: NOW })
      const [row] = await settleKey(dir, probe.impl, NOW + 60_000)
      assert.strictEqual(probe.probes.count, 1, 'inside the TTL nothing is sent')
      assert.strictEqual(row.outcome, 'refused')
      assert.strictEqual(row.checkedAt, new Date(NOW).toISOString())
    })
  })

  test('an out-of-TTL refusal beside a fresh archive is shown as cached, dated to its own check, and its next probe is dated by the archive', async () => {
    await sandboxed([rosterRec(A, 'x@example.com', NOW - 2 * HOUR)], async () => {
      archiveAccountUsage(archived(A, 'x@example.com', NOW - HOUR, '2026-11-10T15:00:00.000Z'))
      const probe = fakeFetch(() => reply(200, H200))
      const refusal = JSON.parse((await runCli(['--json'], { env: KEY_01, fetchImpl: probe.impl, now: NOW })).out).longKeys[0]
      assert.strictEqual(refusal.outcome, 'refused')
      const later = NOW + TTL_MS + 60_000
      const freshAt = later - 30_000
      archiveAccountUsage(archived(A, 'x@example.com', freshAt, '2026-11-03T15:00:00.000Z'))
      const json = JSON.parse((await runCli(['--json'], { env: KEY_01, fetchImpl: probe.impl, now: later })).out).longKeys[0]
      assert.strictEqual(probe.probes.count, 1, 'inside the archive TTL nothing is sent')
      assert.strictEqual(json.outcome, 'cached')
      assert.strictEqual(json.identity, 'refused')
      assert.strictEqual(json.reason, refusal.reason)
      assert.strictEqual(json.checkedAt, new Date(NOW).toISOString())
      assert.strictEqual(json.nextCheckAt, new Date(freshAt + TTL_MS).toISOString())
      const text = await runCli([], { env: KEY_01, fetchImpl: probe.impl, now: later })
      assert.ok(text.out.includes('key 01  x@example.com  cached  5h -  7d 40%'), text.out)
      assert.ok(text.out.includes('(checked '), text.out)
      assert.ok(!text.out.includes('next check allowed in 0m'), text.out)
    })
  })

  test('an unmatched stamp inside the TTL does not lend its identity to the account that matches it later', async () => {
    await sandboxed([], async dir => {
      const probe = fakeFetch(() => reply(200, H200))
      const first = JSON.parse((await runCli(['--json'], { env: KEY_01, fetchImpl: probe.impl, now: NOW })).out).longKeys[0]
      assert.strictEqual(first.outcome, 'unmatched')
      fs.appendFileSync(path.join(dir, 'account-state.ndjson'), JSON.stringify(rosterRec(A, 'x@example.com', NOW - HOUR)) + '\n')
      const later = NOW + 60_000
      archiveAccountUsage(archived(A, 'x@example.com', later - 30_000, '2026-11-03T15:00:00.000Z'))
      const json = JSON.parse((await runCli(['--json'], { env: KEY_01, fetchImpl: probe.impl, now: later })).out).longKeys[0]
      assert.strictEqual(probe.probes.count, 1, 'inside the TTL nothing is sent')
      assert.strictEqual(json.outcome, 'cached')
      assert.strictEqual(json.identity, 'not-checked')
      assert.strictEqual(json.checkedAt, undefined)
      // WHY: the unmatched stamp lends the matched row neither its verdict nor its reason, so both read as absent.
      assert.strictEqual(json.httpStatus, null)
      assert.strictEqual(json.reason, null)
    })
  })

  test('a corrupt stamp fails the run, the error names the stamp file, and nothing is sent', async () => {
    await sandboxed([], async dir => {
      const probe = fakeFetch(() => reply(403, {}, FORBIDDEN_403))
      await runCli([], { env: KEY_01, fetchImpl: probe.impl, now: NOW })
      const stampDir = path.join(dir, 'long-key-probes')
      const [stampName] = fs.readdirSync(stampDir)
      fs.writeFileSync(path.join(stampDir, stampName), 'not json')
      await assert.rejects(runCli([], { env: KEY_01, fetchImpl: probe.impl, now: NOW + 60_000 }), /cannot read the long-lived key stamp .*long-key-probes/)
      assert.strictEqual(probe.probes.count, 1, 'a corrupt stamp sends nothing')
    })
  })

  test('a refreshed stamp inside the TTL does not replay an archive record older than the TTL: the key is probed again', async () => {
    await sandboxed([rosterRec(A, 'x@example.com', NOW - 2 * HOUR)], async dir => {
      const probe = fakeFetch(() => reply(200, H200))
      const [first] = await settleKey(dir, probe.impl, NOW)
      assert.strictEqual(first.outcome, 'refreshed')
      archiveAccountUsage(archived(A, 'x@example.com', NOW - HOUR, '2026-11-03T15:00:00.000Z'))
      await settleKey(dir, probe.impl, NOW + 60_000)
      assert.strictEqual(probe.probes.count, 2, 'the stamp holds no reading, and the archive record is outside the TTL')
    })
  })

  test('--no-refresh reads the files only: no message is sent and the key is listed as skipped', async () => {
    await sandboxed([rosterRec(A, 'x@example.com', NOW - HOUR)], async () => {
      const probe = fakeFetch(() => reply(200, H200))
      const res = await runCli(['--json', '--no-refresh'], { env: KEY_01, fetchImpl: probe.impl, now: NOW })
      assert.strictEqual(res.code, 0, res.err)
      assert.strictEqual(probe.probes.count, 0)
      assert.strictEqual(JSON.parse(res.out).longKeys[0].outcome, 'skipped')
    })
  })

  test('a bad flag value exits 64 before any key is read, so it sends nothing', async () => {
    await sandboxed([], async () => {
      const probe = fakeFetch(() => reply(200, H200))
      const res = await runCli(['--threshold', 'zesty'], { env: KEY_01, fetchImpl: probe.impl, now: NOW })
      assert.strictEqual(res.code, 64)
      assert.strictEqual(probe.probes.count, 0)
    })
  })

  test('--help prints the help and sends nothing', async () => {
    await sandboxed([], async () => {
      const probe = fakeFetch(() => reply(200, H200))
      const res = await runCli(['--help'], { env: KEY_01, fetchImpl: probe.impl, now: NOW })
      assert.strictEqual(res.code, 0)
      assert.strictEqual(probe.probes.count, 0)
      assert.ok(res.out.includes('CLAUDE_CODE_LONG_OAUTH_KEY_01'), 'the help documents the env format')
    })
  })

  test('an unmatched key is listed in --json with its windows, and in the text, and its reading is kept in the stamp only', async () => {
    await sandboxed([], async dir => {
      const probe = fakeFetch(() => reply(200, H200))
      const json = await runCli(['--json'], { env: KEY_01, fetchImpl: probe.impl, now: NOW })
      const row = JSON.parse(json.out).longKeys[0]
      assert.strictEqual(row.outcome, 'unmatched')
      assert.strictEqual(row.identity, 'unmatched')
      assert.strictEqual(row.accountId, null)
      assert.strictEqual(row.windows.fiveHour.percent, 1)
      const text = await runCli([], { env: KEY_01, fetchImpl: probe.impl, now: NOW })
      assert.ok(text.out.includes('unmatched'), text.out)
      assert.strictEqual(listObservedAccountUsage().length, 0, 'an unmatched reading is never filed in the archive')
      assert.ok(allText(path.join(dir, 'long-key-probes')).includes('"reading"'), 'the reading is kept in the stamp')
    })
  })

  test('with no keys and an empty roster the verb is still BLIND and exits 2', async () => {
    await sandboxed([], async () => {
      const probe = fakeFetch(() => reply(200, H200))
      const res = await runCli([], { env: {}, fetchImpl: probe.impl, now: NOW })
      assert.strictEqual(res.code, 2)
      assert.ok(res.err.includes('cannot see'), res.err)
      assert.strictEqual(probe.probes.count, 0)
    })
  })
})
/** Run fn with no credentials file reachable and no keychain consent in the environment. The archive then reports itself
 *  as not maintained on every machine, and usageRefreshCapability() supplies the reason the tests compare against. */
async function withoutCredentials<R>(fn: () => Promise<R>): Promise<R> {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'long-keys-cfg-'))
  const prevConfig = process.env.CLAUDE_CONFIG_DIR
  const prevKeychain = process.env[KEYCHAIN_ENV]
  process.env.CLAUDE_CONFIG_DIR = cfg
  delete process.env[KEYCHAIN_ENV]
  try {
    return await fn()
  } finally {
    if (prevConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = prevConfig
    if (prevKeychain === undefined) delete process.env[KEYCHAIN_ENV]
    else process.env[KEYCHAIN_ENV] = prevKeychain
    fs.rmSync(cfg, { recursive: true, force: true })
  }
}
suite('the text output — the archive warning and the exception sentence follow what the keys read', () => {
  test('a refreshed key replaces the archive warning with the keyed-rows line, which carries the archive reason', async () => {
    await withoutCredentials(() => sandboxed([rosterRec(A, 'x@example.com', NOW - HOUR)], async () => {
      const reason = usageRefreshCapability().reason
      assert.ok(reason !== null, 'with no credentials the archive is not maintained, so there is a reason to carry')
      const probe = fakeFetch(() => reply(200, H200))
      const res = await runCli([], { env: KEY_01, fetchImpl: probe.impl, now: NOW })
      assert.strictEqual(res.code, 0, res.err)
      assert.strictEqual(probe.probes.count, 1)
      assert.ok(!res.out.includes('⚠ these rows are NOT being refreshed'), res.out)
      assert.ok(res.out.includes('⚠ rows without a long-lived key are NOT being refreshed — ' + reason), res.out)
      assert.ok(res.out.includes('Exception: the readings shown for key 01 were taken with the owner-supplied CLAUDE_CODE_LONG_OAUTH_KEY_* keys.'), res.out)
    }))
  })

  test('with no key the archive warning is the original line alone, and no exception sentence is added', async () => {
    await withoutCredentials(() => sandboxed([rosterRec(A, 'x@example.com', NOW - HOUR)], async () => {
      const reason = usageRefreshCapability().reason
      assert.ok(reason !== null, 'with no credentials the archive is not maintained, so there is a reason to carry')
      const probe = fakeFetch(() => reply(200, H200))
      const res = await runCli([], { env: {}, fetchImpl: probe.impl, now: NOW })
      assert.strictEqual(res.code, 0, res.err)
      assert.strictEqual(probe.probes.count, 0)
      assert.ok(res.out.includes('⚠ these rows are NOT being refreshed — ' + reason), res.out)
      assert.ok(!res.out.includes('rows without a long-lived key'), res.out)
      assert.ok(!res.out.includes('Exception:'), res.out)
    }))
  })

  test('a cached row whose reading came from the usage endpoint names no key, and adds no exception sentence', async () => {
    await sandboxed([rosterRec(A, 'x@example.com', NOW - 2 * HOUR)], async () => {
      archiveAccountUsage(archived(A, 'x@example.com', NOW - 60_000, '2026-11-03T15:00:00.000Z'))
      const probe = fakeFetch(() => reply(200, H200))
      const res = await runCli([], { env: KEY_01, fetchImpl: probe.impl, now: NOW })
      assert.strictEqual(probe.probes.count, 0)
      assert.ok(res.out.includes('key 01  x@example.com  cached'), res.out)
      assert.ok(!res.out.includes('Exception:'), res.out)
    })
  })

  test('with a reading on a non-live account and none on the live one, the diagnosis names the live account', async () => {
    await sandboxed([rosterRec(B, 'other@example.com', NOW - 2 * HOUR), rosterRec(A, 'x@example.com', NOW - HOUR)], async () => {
      archiveAccountUsage(archived(B, 'other@example.com', NOW - 60_000, '2026-11-03T15:00:00.000Z'))
      const res = await runCli([], { env: {}, fetchImpl: fakeFetch(() => reply(200, H200)).impl, now: NOW, liveAccountId: A })
      assert.ok(res.out.includes('The live account has no usage reading'), res.out)
      assert.ok(!res.out.includes('No account has a usage reading'), res.out)
    })
  })

  test('a matched key whose row is cached from a fresh usage-endpoint archive still names the rows without a key', async () => {
    await withoutCredentials(() => sandboxed([rosterRec(A, 'x@example.com', NOW - 2 * HOUR)], async () => {
      const reason = usageRefreshCapability().reason
      assert.ok(reason !== null, 'with no credentials the archive is not maintained, so there is a reason to carry')
      archiveAccountUsage(archived(A, 'x@example.com', NOW - 60_000, '2026-11-03T15:00:00.000Z'))
      const probe = fakeFetch(() => reply(200, H200))
      const res = await runCli([], { env: KEY_01, fetchImpl: probe.impl, now: NOW })
      assert.strictEqual(res.code, 0, res.err)
      assert.strictEqual(probe.probes.count, 0, 'the archive is inside the TTL, so nothing is sent')
      assert.ok(res.out.includes('key 01  x@example.com  cached'), res.out)
      assert.ok(res.out.includes('⚠ rows without a long-lived key are NOT being refreshed — ' + reason), res.out)
      assert.ok(!res.out.includes('Exception:'), res.out)
    }))
  })

  test('a later run inside the TTL reads the same archive with no probe, and still names the key and the rows without one', async () => {
    await withoutCredentials(() => sandboxed([rosterRec(A, 'x@example.com', NOW - 2 * HOUR)], async () => {
      const reason = usageRefreshCapability().reason
      assert.ok(reason !== null, 'with no credentials the archive is not maintained, so there is a reason to carry')
      const probe = fakeFetch(() => reply(200, H200))
      const first = await runCli([], { env: KEY_01, fetchImpl: probe.impl, now: NOW })
      assert.strictEqual(first.code, 0, first.err)
      assert.strictEqual(probe.probes.count, 1)
      const second = await runCli([], { env: KEY_01, fetchImpl: probe.impl, now: NOW + 60_000 })
      assert.strictEqual(second.code, 0, second.err)
      assert.strictEqual(probe.probes.count, 1, 'inside the TTL nothing is sent')
      assert.ok(second.out.includes('Exception: the readings shown for key 01 were taken with the owner-supplied CLAUDE_CODE_LONG_OAUTH_KEY_* keys.'), second.out)
      assert.ok(second.out.includes('⚠ rows without a long-lived key are NOT being refreshed — ' + reason), second.out)
    }))
  })

  test('with no live account the diagnosis says none of the listed accounts is live right now', async () => {
    await sandboxed([rosterRec(B, 'other@example.com', NOW - 2 * HOUR), rosterRec(A, 'x@example.com', NOW - HOUR)], async () => {
      archiveAccountUsage(archived(B, 'other@example.com', NOW - 60_000, '2026-11-03T15:00:00.000Z'))
      const res = await runCli([], { env: {}, fetchImpl: fakeFetch(() => reply(200, H200)).impl, now: NOW })
      assert.ok(res.out.includes('None of the listed accounts is live right now'), res.out)
    })
  })

  test('a key that reads nothing adds no exception sentence, and the archive warning stays the original line', async () => {
    await withoutCredentials(() => sandboxed([rosterRec(B, 'other@example.com', NOW - HOUR)], async () => {
      const reason = usageRefreshCapability().reason
      assert.ok(reason !== null, 'with no credentials the archive is not maintained, so there is a reason to carry')
      const probe = fakeFetch(() => reply(403, {}, FORBIDDEN_403))
      const res = await runCli([], { env: KEY_01, fetchImpl: probe.impl, now: NOW })
      assert.strictEqual(res.code, 0, res.err)
      assert.strictEqual(probe.probes.count, 1)
      assert.ok(res.out.includes('⚠ these rows are NOT being refreshed — ' + reason), res.out)
      assert.ok(!res.out.includes('rows without a long-lived key'), res.out)
      assert.ok(!res.out.includes('Exception:'), res.out)
    }))
  })
})
suite('the leak test — a token never leaves through output, a file or a stamp', () => {
  test('a planted token reaches neither stdout, stderr, --json, the --out file, the archive nor a stamp', async () => {
    // Planted in a thrown message, its cause, and an AggregateError member: every place a platform error can carry it.
    const cause = new AggregateError([new Error('member ' + LEAK)], 'agg ' + LEAK)
    const throwing = (async () => { throw new Error('connect failed ' + LEAK, { cause }) }) as unknown as FetchLike
    const leakKey = { CLAUDE_CODE_LONG_OAUTH_KEY_01: 'x@example.com|' + LEAK }
    await sandboxed([rosterRec(A, 'x@example.com', NOW - 2 * HOUR)], async dir => {
      const outFile = path.join(dir, 'report.json')
      const json = await runCli(['--json'], { env: leakKey, fetchImpl: throwing, now: NOW })
      const toFile = await runCli(['--json', '--out', outFile], { env: leakKey, fetchImpl: throwing, now: NOW })
      assert.ok(json.out.includes('members: [Error: member [redacted]]'), 'the nested members were scrubbed, not dropped')
      const haystack = [json.out, json.err, toFile.out, toFile.err, fs.readFileSync(outFile, 'utf8'), allText(dir)].join('\n')
      assert.ok(!haystack.includes(LEAK), 'the token must not appear anywhere the run wrote or printed')
    })
    // Planted in a 403 body: its message and its error code are both server text.
    const forbidden = fakeFetch(() => reply(403, {}, {
      type: 'error', error: { type: 'permission_error', message: 'key ' + LEAK + ' refused', details: { error_code: LEAK } },
    }))
    await sandboxed([rosterRec(B, 'other@example.com', NOW - HOUR)], async dir => {
      const json = await runCli(['--json'], { env: leakKey, fetchImpl: forbidden.impl, now: NOW })
      assert.ok(json.out.includes('HTTP 403 [redacted]'), json.out)
      assert.ok(!(json.out + json.err + allText(dir)).includes(LEAK))
    })
  })
})
suite('offline guard — no test reaches the real Anthropic API', () => {
  test('the owner long-lived key variables are absent in the test process', () => {
    // setup.js deletes them before any spec file loads. Only the NAMES are reported, never a value.
    const present = SLOTS.map(s => 'CLAUDE_CODE_LONG_OAUTH_KEY_' + s).filter(n => process.env[n] !== undefined)
    assert.deepStrictEqual(present, [])
  })

  test('a fetch to api.anthropic.com throws network disabled in tests and never goes out', () => {
    assert.throws(() => { void fetch('https://api.anthropic.com/api/oauth/usage') }, /network disabled in tests/)
    assert.throws(() => { void fetch(new URL('https://api.anthropic.com/v1/messages')) }, /network disabled in tests/)
  })
})
