// src/allAccounts.ts — "where does EVERY account stand" (issue #8).
//
// WHAT THESE GUARD. Every assertion here is about a DISTINCTION that a rotator acts on, and each one
// has an opposite-signal failure mode: reporting "cannot read" as "no headroom" stalls a machine at
// the limit; reporting "unknown" as "empty" sends it onto an account that is already spent. A number
// and a null are not interchangeable here, and neither is an absent row.

import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { classifyWindow, listAllAccounts } from '../allAccounts'
import { runAllAccountsCli } from '../cli/allAccountsCli'
import { archiveAccountUsage, TTL_MS, type SubscriptionUsage } from '../subscriptionUsage'
import type { AccountStateRecord } from '../accountStateTimeline'

const NOW = Date.parse('2026-08-02T03:00:00Z')
const HOUR = 3_600_000
const iso = (ms: number): string => new Date(ms).toISOString()

const A = '32eb8302-c2a4-4333-a15f-ba17ec8960ad'
const B = '75099fe9-8c66-4edd-bd99-a05593a57928'
const C = '80ddbe47-1111-4222-8333-444455556666'

suite('classifyWindow — the four ways a stamped reading can be read', () => {
  test('inside the TTL it is a measurement', () => {
    const w = classifyWindow(42, iso(NOW + HOUR), NOW - 60_000, null, NOW)
    assert.strictEqual(w.freshness, 'fresh')
    assert.strictEqual(w.percent, 42)
    assert.strictEqual(w.reason, null, 'a measurement needs no caveat')
  })

  test('past the TTL but NOT reset, the number survives as a LOWER bound', () => {
    // Utilization only grows within a window, so an old reading understates it — which is the safe
    // direction and far more useful than discarding it.
    const w = classifyWindow(77, iso(NOW + HOUR), NOW - TTL_MS * 5, null, NOW)
    assert.strictEqual(w.freshness, 'aged')
    assert.strictEqual(w.percent, 77)
    assert.ok(w.reason?.includes('LOWER bound'))
  })

  test('reset, and this machine was already OFF the account when the new window began ⇒ rolled', () => {
    // The row that would have ended the outage in issue #8: an account at 91% whose window has since
    // reset, that nothing local can have filled, is AVAILABLE — not unknown.
    // The comparison is leftAt vs the RESET instant. Against fetchedAt it would never fire: a reading
    // is normally taken while the account is live, so the machine always leaves AFTER the reading.
    const w = classifyWindow(91, iso(NOW - HOUR), NOW - 6 * HOUR, NOW - 2 * HOUR, NOW)
    assert.strictEqual(w.freshness, 'rolled')
    assert.strictEqual(w.percent, 0)
    assert.ok(w.reason?.startsWith('INFERRED'), 'it must announce itself as an inference')
    assert.ok(w.reason?.includes('another host'), 'and state the precondition it rests on')
  })

  test('reset while the account is STILL the live one ⇒ stale, and null rather than 0', () => {
    // leftAt === null means we never left: traffic in the new window cannot be excluded, so its fill
    // is genuinely unknown. Reporting 0 here would send a rotator onto a burning account.
    const w = classifyWindow(91, iso(NOW - HOUR), NOW - 6 * HOUR, null, NOW)
    assert.strictEqual(w.freshness, 'stale')
    assert.strictEqual(w.percent, null)
  })

  test('reset, but the machine stayed on the account INTO the new window ⇒ stale', () => {
    // Window reset 3h ago, machine left 1h ago: two hours of possible traffic in the new window.
    const w = classifyWindow(91, iso(NOW - 3 * HOUR), NOW - 6 * HOUR, NOW - HOUR, NOW)
    assert.strictEqual(w.freshness, 'stale')
    assert.strictEqual(w.percent, null)
  })

  test('a SUSPECT label disables the rolled inference entirely', () => {
    // leftAt is derived from the timeline's accountId, which comes from ~/.claude.json. When the
    // reading's own account contradicts that claim, "this machine left the account" is unfounded —
    // MEASURED on the host that motivated this feature, where the config said one account and the
    // keychain credential belonged to another. Inferring empty there is a green light for the account
    // that may be the one actually burning.
    const ok = classifyWindow(91, iso(NOW - HOUR), NOW - 6 * HOUR, NOW - 2 * HOUR, NOW, false)
    const suspect = classifyWindow(91, iso(NOW - HOUR), NOW - 6 * HOUR, NOW - 2 * HOUR, NOW, true)
    assert.strictEqual(ok.freshness, 'rolled', 'precondition: identical inputs DO roll when trusted')
    assert.strictEqual(suspect.freshness, 'stale')
    assert.strictEqual(suspect.percent, null)
    assert.ok(suspect.reason?.includes('claude.json'), 'and say which claim it could not establish')
  })

  test('an absent percentage is unreadable, never zero', () => {
    const w = classifyWindow(null, iso(NOW + HOUR), NOW, null, NOW)
    assert.strictEqual(w.freshness, 'unreadable')
    assert.strictEqual(w.percent, null)
  })
})

suite('listAllAccounts — the roster joined to what was observed', () => {
  function rec(uuid: string, email: string, ts: number): AccountStateRecord {
    return {
      ts, accountId: uuid, email, mode: 'subscription (within plan)', plan: 'Max 20x',
      authRegime: 'subscription', ttlMinutes: 60, ttlSource: 'doc-matrix',
    }
  }
  function usage(uuid: string, fetchedAt: number, fivePct: number, fiveResets: number, suspect = false): SubscriptionUsage {
    return {
      fetchedAt, ageSeconds: 0, stale: false, reason: 'ok',
      accountFp: 'fp', accountUuid: uuid, accountLabel: null, accountTier: null,
      localClaimedLabel: null, accountLabelSuspect: suspect, accountVerified: 'yes',
      limits: [
        { kind: 'session', group: 'session', percent: fivePct, severity: 'normal', resetsAt: iso(fiveResets), isActive: true, scopeLabel: null, resetsInSeconds: 0 },
        { kind: 'weekly_all', group: 'weekly', percent: 50, severity: 'normal', resetsAt: iso(NOW + 48 * HOUR), isActive: true, scopeLabel: null, resetsInSeconds: 0 },
        { kind: 'weekly_scoped', group: 'weekly', percent: 99, severity: 'warning', resetsAt: iso(NOW + 48 * HOUR), isActive: false, scopeLabel: 'Fable', resetsInSeconds: 0 },
      ],
      fiveHourPercent: fivePct, sevenDayPercent: 50, usageCreditsEnabled: false, spendPercent: null, note: '',
    } as unknown as SubscriptionUsage
  }

  /** Isolated DATA_DIR *and* timeline path — both are read from the environment, and a shared one
   *  would let this machine's real accounts answer the test's question. */
  function inSandbox<T>(timeline: AccountStateRecord[], fn: () => T): T {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'all-acct-'))
    const dir = path.join(sandbox, 'data')
    fs.mkdirSync(dir)
    const tl = path.join(dir, 'account-state.ndjson')
    fs.writeFileSync(tl, timeline.map(r => JSON.stringify(r)).join('\n') + '\n')
    const prevData = process.env.AGENTLENS_DATA_DIR
    const prevLog = process.env.AGENTLENS_ACCOUNT_STATE_LOG
    process.env.AGENTLENS_DATA_DIR = dir
    process.env.AGENTLENS_ACCOUNT_STATE_LOG = tl
    try { return fn() } finally {
      if (prevData === undefined) delete process.env.AGENTLENS_DATA_DIR; else process.env.AGENTLENS_DATA_DIR = prevData
      if (prevLog === undefined) delete process.env.AGENTLENS_ACCOUNT_STATE_LOG; else process.env.AGENTLENS_ACCOUNT_STATE_LOG = prevLog
      fs.rmSync(sandbox, { recursive: true, force: true })
    }
  }

  test('an account with NO reading is reported as unreadable — never omitted', () => {
    // The whole point. A missing row renders identically to "this account has no headroom", which is
    // the opposite signal, and it is what stalled the host in issue #8.
    inSandbox([rec(A, 'a@x', NOW - 40 * HOUR), rec(B, 'b@x', NOW - 20 * HOUR)], () => {
      const r = listAllAccounts({ now: NOW, liveAccountId: B })
      assert.strictEqual(r.accounts.length, 2, 'both accounts must appear')
      const a = r.accounts.find(x => x.accountId === A)!
      assert.strictEqual(a.freshness, 'unreadable')
      assert.strictEqual(a.fiveHour.percent, null)
      assert.ok(a.fiveHour.reason?.includes('NOT the same as'))
    })
  })

  test('a non-live account whose 5h window rolled reads as available', () => {
    inSandbox([rec(A, 'a@x', NOW - 40 * HOUR), rec(B, 'b@x', NOW - 20 * HOUR)], () => {
      // A was left at NOW-20h; its reading is older still, and its 5h window reset an hour ago.
      archiveAccountUsage(usage(A, NOW - 30 * HOUR, 91, NOW - HOUR))
      const a = listAllAccounts({ now: NOW, liveAccountId: B }).accounts.find(x => x.accountId === A)!
      assert.strictEqual(a.isLive, false)
      assert.strictEqual(a.leftAt, NOW - 20 * HOUR)
      assert.strictEqual(a.fiveHour.freshness, 'rolled')
      assert.strictEqual(a.fiveHour.percent, 0)
      assert.strictEqual(a.staleSeconds, 30 * 3600)
    })
  })

  test('the LIVE account never inherits a leftAt, so its rolled window is never inferred empty', () => {
    // The timeline only writes on a discrete state CHANGE, so the live account can trail a leftAt from
    // an earlier run. Without the isLive override it would be reported as idle — and its window
    // inferred empty — while it is the one actually burning.
    inSandbox([rec(A, 'a@x', NOW - 40 * HOUR), rec(B, 'b@x', NOW - 30 * HOUR), rec(A, 'a@x', NOW - 20 * HOUR)], () => {
      archiveAccountUsage(usage(B, NOW - 25 * HOUR, 91, NOW - HOUR))
      const b = listAllAccounts({ now: NOW, liveAccountId: B }).accounts.find(x => x.accountId === B)!
      assert.strictEqual(b.isLive, true)
      assert.strictEqual(b.leftAt, null, 'the live account has not been left, whatever the timeline trails')
      assert.strictEqual(b.fiveHour.freshness, 'stale')
      assert.strictEqual(b.fiveHour.percent, null)
    })
  })

  test('a spent per-model weekly bucket does NOT make the account read as spent', () => {
    // ccbroker states the semantic: a spent per-model bucket does not block other models. Folding it
    // into the verdict reports an account with real headroom as exhausted.
    inSandbox([rec(A, 'a@x', NOW - 40 * HOUR), rec(B, 'b@x', NOW - 20 * HOUR)], () => {
      archiveAccountUsage(usage(A, NOW - 60_000, 12, NOW + HOUR))   // 99% Fable weekly in the fixture
      const a = listAllAccounts({ now: NOW, liveAccountId: B }).accounts.find(x => x.accountId === A)!
      assert.strictEqual(a.freshness, 'fresh')
      assert.strictEqual(a.fiveHour.percent, 12)
      assert.strictEqual(a.scopedWeekly.length, 1, 'reported...')
      assert.strictEqual(a.scopedWeekly[0].percent, 99)
      assert.ok(!('scoped' in (a.fiveHour as object)), '...but never folded into the account windows')
    })
  })

  test('the account verdict is the WORSE of its two windows', () => {
    inSandbox([rec(A, 'a@x', NOW - 40 * HOUR), rec(B, 'b@x', NOW - 20 * HOUR)], () => {
      archiveAccountUsage(usage(A, NOW - 30 * HOUR, 91, NOW - HOUR))  // 5h rolled, 7d merely aged
      const a = listAllAccounts({ now: NOW, liveAccountId: B }).accounts.find(x => x.accountId === A)!
      assert.strictEqual(a.sevenDay.freshness, 'aged')
      assert.strictEqual(a.freshness, 'rolled', 'the weaker claim must win, not the flattering one')
    })
  })

  test('an empty roster is BLIND, not "no accounts"', () => {
    inSandbox([], () => {
      const r = listAllAccounts({ now: NOW, liveAccountId: null })
      assert.strictEqual(r.blind, true)
      assert.deepStrictEqual(r.accounts, [])
    })
  })

  test('latest-wins on the descriptive fields — a plan change is not reported from the oldest record', () => {
    inSandbox([
      { ...rec(C, 'c@x', NOW - 40 * HOUR), plan: 'Pro', mode: 'subscription (within plan)' },
      { ...rec(C, 'c@x', NOW - 2 * HOUR), plan: 'Max 20x', mode: 'drawing usage credits' },
    ], () => {
      const c = listAllAccounts({ now: NOW, liveAccountId: C }).accounts[0]
      assert.strictEqual(c.plan, 'Max 20x')
      assert.strictEqual(c.mode, 'drawing usage credits')
      assert.strictEqual(c.leftAt, null, 'never left — it is the only account in the timeline')
    })
  })
})

suite('the --all CLI — answers with the server DOWN, and BLIND is not "no accounts"', () => {
  /** The plural verb is assembled from files precisely so it works when the server does not. Before
   *  the local fast path it proxied to the server and answered `cannot reach localhost:4316` — the one
   *  answer that is useless to a rotator, since a wedged machine is when it asks. */
  function inSandbox<T>(timelineLines: string, fn: () => T): T {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'all-cli-'))
    const dir = path.join(sandbox, 'data')
    fs.mkdirSync(dir)
    const tl = path.join(dir, 'account-state.ndjson')
    fs.writeFileSync(tl, timelineLines)
    const prevData = process.env.AGENTLENS_DATA_DIR
    const prevLog = process.env.AGENTLENS_ACCOUNT_STATE_LOG
    process.env.AGENTLENS_DATA_DIR = dir
    process.env.AGENTLENS_ACCOUNT_STATE_LOG = tl
    try { return fn() } finally {
      if (prevData === undefined) delete process.env.AGENTLENS_DATA_DIR; else process.env.AGENTLENS_DATA_DIR = prevData
      if (prevLog === undefined) delete process.env.AGENTLENS_ACCOUNT_STATE_LOG; else process.env.AGENTLENS_ACCOUNT_STATE_LOG = prevLog
      fs.rmSync(sandbox, { recursive: true, force: true })
    }
  }

  test('an empty roster exits BLIND (1), and says so in words', () => {
    inSandbox('', () => {
      const errs: string[] = []
      const realErr = console.error
      console.error = (...a: unknown[]): void => { errs.push(a.join(' ')) }
      try {
        assert.strictEqual(runAllAccountsCli([]), 1, 'BLIND must be a non-zero exit a script can branch on')
      } finally { console.error = realErr }
      assert.ok(errs.join('\n').includes('cannot see'), 'and it must not read as "no accounts"')
    })
  })

  test('a populated roster renders a table and exits 0', () => {
    const line = JSON.stringify({
      ts: NOW - HOUR, accountId: A, email: 'a@x', mode: 'subscription (within plan)',
      plan: 'Max 20x', authRegime: 'subscription', ttlMinutes: 60, ttlSource: 'doc-matrix',
    }) + '\n'
    inSandbox(line, () => {
      const outs: string[] = []
      const realLog = console.log
      console.log = (...a: unknown[]): void => { outs.push(a.join(' ')) }
      try {
        assert.strictEqual(runAllAccountsCli([]), 0)
      } finally { console.log = realLog }
      const text = outs.join('\n')
      assert.ok(text.includes('a@x'))
      assert.ok(text.includes('unreadable'), 'an account with no reading must SHOW as unreadable')
      assert.ok(!/\b0%/.test(text), 'and never as 0%, which is the opposite signal')
    })
  })
})
