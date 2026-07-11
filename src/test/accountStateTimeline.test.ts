import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  AccountStateTimeline, buildAccountStateRecord, resolveStateAt,
  type AccountStateRecord,
} from '../accountStateTimeline'
import type { AccountInfo } from '../accountInfo'
import type { TtlContext } from '../shared/cacheTtl'
import { handleGetAccountStateAt } from '../mcpServer'

// ── Account-state timeline (TRDD-YQZ9P8IL) ────────────────────────────────────
// REAL temp-file writes (no mocks): every test drives the actual append+fsync path and reads the
// ndjson back. Timers are disabled (autoTimer:false) so nothing dangles; flush is exercised explicitly.

let seq = 0
function tempFile(): { file: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `al-ast-${process.pid}-${seq++}-`))
  return { file: path.join(dir, 'account-state.ndjson'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}
function readLines(file: string): AccountStateRecord[] {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as AccountStateRecord)
}
function account(over: Partial<AccountInfo> = {}): AccountInfo {
  return {
    accountUuid: 'acct-A', email: 'dev@example.com', organizationName: null, organizationUuid: null,
    billingType: 'stripe_subscription', hasExtraUsageEnabled: false,
    organizationRateLimitTier: null, userRateLimitTier: null, displayName: null,
    planType: 'max', rateLimitTier: 'default_claude_max_5x', label: 'dev@example.com', source: 'claude.json', ...over,
  }
}
const ttl = (auth: TtlContext['auth']): TtlContext => ({ auth, force5m: false, enable1h: false })
function rec(over: Partial<AccountStateRecord>): AccountStateRecord {
  return { ts: 0, accountId: 'a', email: 'e', mode: 'm', plan: 'p', authRegime: 'r', ttlMinutes: 60, ttlSource: 'doc-matrix', ...over }
}

suite('accountStateTimeline — buildAccountStateRecord (the recorded VALUES)', () => {
  test('stripe_subscription Max-5x + ttlCtx → subscription mode, Max 5x, 60-min doc-matrix', () => {
    const r = buildAccountStateRecord(account(), ttl('subscription'), 1000)
    assert.strictEqual(r.ts, 1000)
    assert.strictEqual(r.accountId, 'acct-A')
    assert.strictEqual(r.mode, 'subscription (within plan)')
    assert.strictEqual(r.plan, 'Max 5x')
    assert.strictEqual(r.authRegime, 'subscription')
    assert.strictEqual(r.ttlMinutes, 60)
    assert.strictEqual(r.ttlSource, 'doc-matrix')
  })

  test('no ttlCtx → honest assumed 5-min floor; billingType substring still resolves subscription mode', () => {
    const r = buildAccountStateRecord(account(), null, 1)
    assert.strictEqual(r.mode, 'subscription (within plan)')   // stripe_subscription substring, not api-key
    assert.strictEqual(r.ttlMinutes, 5)
    assert.strictEqual(r.ttlSource, 'assumed')
  })

  test('null account → unknown plan/regime, never a throw', () => {
    const r = buildAccountStateRecord(null, null, 1)
    assert.strictEqual(r.plan, 'unknown')
    assert.strictEqual(r.authRegime, 'unknown')
    assert.strictEqual(r.accountId, null)
  })
})

suite('accountStateTimeline — change-detection (the SSD win)', () => {
  test('an unchanged discrete state does NOT re-enqueue; a real change does', () => {
    const { file, cleanup } = tempFile()
    try {
      const tl = new AccountStateTimeline({ filePath: file, autoTimer: false })
      assert.strictEqual(tl.record(rec({ ts: 1, plan: 'Max 5x' })), true)   // first ever
      assert.strictEqual(tl.record(rec({ ts: 2, plan: 'Max 5x' })), false)  // identical discrete state
      assert.strictEqual(tl.record(rec({ ts: 3, plan: 'Max 20x' })), true)  // plan changed
      assert.strictEqual(tl.record(rec({ ts: 4, plan: 'Max 20x', accountId: 'b' })), true) // account changed
      tl.flush()
      assert.strictEqual(readLines(file).length, 3)   // 3 changes, NOT 4 samples
    } finally { cleanup() }
  })

  test('the continuously-moving 5h/7d % are NOT in the record, so they can never trigger a write', () => {
    // The record shape itself has no 5h/7d field — proven structurally by buildAccountStateRecord's
    // output keys. A stream of identical discrete states writes exactly one line however often sampled.
    const { file, cleanup } = tempFile()
    try {
      const tl = new AccountStateTimeline({ filePath: file, autoTimer: false })
      for (let i = 0; i < 100; i++) tl.record(buildAccountStateRecord(account(), ttl('subscription'), i))
      tl.flush()
      assert.strictEqual(readLines(file).length, 1)   // 100 samples, ONE state → ONE line
      assert.ok(!('fiveHourPct' in readLines(file)[0]))
    } finally { cleanup() }
  })
})

suite('accountStateTimeline — resolveStateAt (binary search)', () => {
  test('returns the last record with ts <= T; null before the first record', () => {
    const { file, cleanup } = tempFile()
    try {
      const tl = new AccountStateTimeline({ filePath: file, autoTimer: false })
      tl.record(rec({ ts: 100, plan: 'P100' }))
      tl.record(rec({ ts: 200, plan: 'P200' }))
      tl.record(rec({ ts: 300, plan: 'P300' }))
      tl.flush()
      assert.strictEqual(resolveStateAt(50, file), null)                 // before everything
      assert.strictEqual(resolveStateAt(100, file)?.plan, 'P100')        // exact first
      assert.strictEqual(resolveStateAt(150, file)?.plan, 'P100')        // between
      assert.strictEqual(resolveStateAt(200, file)?.plan, 'P200')        // exact middle
      assert.strictEqual(resolveStateAt(250, file)?.plan, 'P200')        // between
      assert.strictEqual(resolveStateAt(400, file)?.plan, 'P300')        // after everything
    } finally { cleanup() }
  })

  test('missing file → null (never a throw)', () => {
    assert.strictEqual(resolveStateAt(1000, path.join(os.tmpdir(), 'al-ast-nope-does-not-exist.ndjson')), null)
  })
})

suite('accountStateTimeline — flush triggers + durability', () => {
  test('the 32-record cap auto-flushes WITHOUT a manual flush call', () => {
    const { file, cleanup } = tempFile()
    try {
      const tl = new AccountStateTimeline({ filePath: file, autoTimer: false })
      for (let i = 0; i < 32; i++) tl.record(rec({ ts: i, plan: `P${i}` }))  // 32 distinct → hits the cap
      assert.strictEqual(readLines(file).length, 32, 'auto-flushed on the 32nd record')
    } finally { cleanup() }
  })

  test('stop() does a final flush (the graceful-shutdown / SIGTERM path)', () => {
    const { file, cleanup } = tempFile()
    try {
      const tl = new AccountStateTimeline({ filePath: file, autoTimer: false })
      tl.record(rec({ ts: 5, plan: 'Pending' }))
      assert.strictEqual(readLines(file).length, 0, 'buffered, not yet on disk')
      tl.stop()
      assert.strictEqual(resolveStateAt(10, file)?.plan, 'Pending', 'persisted by stop()')
    } finally { cleanup() }
  })

  test('two flushes APPEND (never overwrite) — the timeline accumulates', () => {
    const { file, cleanup } = tempFile()
    try {
      const tl = new AccountStateTimeline({ filePath: file, autoTimer: false })
      tl.record(rec({ ts: 1, plan: 'A' })); tl.flush()
      tl.record(rec({ ts: 2, plan: 'B' })); tl.flush()
      assert.deepStrictEqual(readLines(file).map(r => r.plan), ['A', 'B'])
    } finally { cleanup() }
  })

  test('a RESTART into an unchanged state does not re-log it (lastKey seeded from the file tail)', () => {
    const { file, cleanup } = tempFile()
    try {
      const first = new AccountStateTimeline({ filePath: file, autoTimer: false })
      const state = buildAccountStateRecord(account(), ttl('subscription'), 1)
      first.record(state); first.flush()
      assert.strictEqual(readLines(file).length, 1)
      // "Restart": a fresh instance on the same file. Recording the SAME discrete state must NOT append.
      const second = new AccountStateTimeline({ filePath: file, autoTimer: false })
      assert.strictEqual(second.record(buildAccountStateRecord(account(), ttl('subscription'), 2)), false)
      second.flush()
      assert.strictEqual(readLines(file).length, 1, 'no duplicate state after restart')
      // A genuinely new state after restart DOES append.
      assert.strictEqual(second.record(buildAccountStateRecord(account({ planType: 'pro', rateLimitTier: null }), ttl('api-key'), 3)), true)
      second.flush()
      assert.strictEqual(readLines(file).length, 2)
    } finally { cleanup() }
  })
})

suite('mcpServer — get_account_state_at handler (TRDD-YQZ9P8IL)', () => {
  const OLD = process.env.AGENTLENS_ACCOUNT_STATE_LOG
  let dir: string, file: string
  suiteSetup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), `al-gsa-${process.pid}-`))
    file = path.join(dir, 'account-state.ndjson')
    process.env.AGENTLENS_ACCOUNT_STATE_LOG = file   // the handler reads the default path, which honors this
    const tl = new AccountStateTimeline({ filePath: file, autoTimer: false })
    tl.record(rec({ ts: 100, plan: 'Max 5x', mode: 'subscription (within plan)' }))
    tl.record(rec({ ts: 200, plan: 'Max 20x', mode: 'subscription drawing usage credits (over plan limit)' }))
    tl.flush()
  })
  suiteTeardown(() => {
    if (OLD === undefined) delete process.env.AGENTLENS_ACCOUNT_STATE_LOG; else process.env.AGENTLENS_ACCOUNT_STATE_LOG = OLD
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('resolves a ms-epoch ts to the state active then', () => {
    const res = handleGetAccountStateAt({ ts: 150 }) as { state: AccountStateRecord | null }
    assert.strictEqual(res.state?.plan, 'Max 5x')
    const later = handleGetAccountStateAt({ ts: 250 }) as { state: AccountStateRecord | null }
    assert.strictEqual(later.state?.plan, 'Max 20x')
  })

  test('accepts an ISO-8601 iso string', () => {
    const iso = new Date(250).toISOString()
    const res = handleGetAccountStateAt({ iso }) as { state: AccountStateRecord | null }
    assert.strictEqual(res.state?.plan, 'Max 20x')
  })

  test('a ts before the timeline → state null + explanatory note (never a fabricated state)', () => {
    const res = handleGetAccountStateAt({ ts: 1 }) as { state: AccountStateRecord | null; note?: string }
    assert.strictEqual(res.state, null)
    assert.ok(res.note)
  })

  test('neither ts nor iso → error, not a guess', () => {
    const res = handleGetAccountStateAt({}) as { error?: string }
    assert.ok(res.error)
  })
})
