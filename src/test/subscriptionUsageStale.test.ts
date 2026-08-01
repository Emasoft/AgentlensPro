// Regression tests for the stale-cache misreport (src/subscriptionUsage.ts).
//
// WHAT WENT WRONG, and why these are the assertions that would have caught it.
//
// `normalize` computes `ageSeconds` and `stale` at WRITE time, so the values PERSISTED in
// subscription-usage.json are permanently `0` and `false`. Every cache-serving return except one
// spread that object verbatim and overrode only `reason`, so a caller got a six-day-old snapshot
// that self-reported as "0s old, not stale". The module's own guards — the `⚠ NOT LIVE` banner and
// the suppression of the reset countdown — are keyed on exactly that frozen `false`, so they could
// never fire. On macOS the token is in the keychain behind an opt-in, so `opt_in_required` is the
// DEFAULT path: the broken branch was the normal one, and it could not self-correct.
//
// Observed on 2026-08-01: `get_subscription_usage` reported the 7d window at 96% "critical" —
// Anthropic's own number, per its header — while the account was really at 36%. The cached reading
// was fetched 2026-07-26 and described a weekly window that had RESET on 2026-07-28, four days
// before it was served. A second Claude session relayed that 96% to the user as fact and built a
// "defer the work" recommendation on it.
//
// Hence two independent staleness signals, because age alone was not the sharpest one available:
// a reading whose window has already reset is obsolete no matter how recently it was fetched.

import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { deriveStale, formatSubscriptionUsage, getSubscriptionUsage, TTL_MS, type SubscriptionUsage } from '../subscriptionUsage'

const NOW = Date.parse('2026-08-01T07:00:00Z')

/** A reading shaped exactly like the one found on disk: percentages that look authoritative, and
 *  the `ageSeconds: 0` / `stale: false` that `normalize` freezes into every cache file. */
function reading(over: Partial<SubscriptionUsage> = {}): SubscriptionUsage {
  return {
    fetchedAt: NOW - 60_000,
    ageSeconds: 0,
    stale: false,
    accountFp: 'acct-under-test',
    accountUuid: null,
    accountLabel: 'tester@example.com',
    accountLabelSuspect: false,
    accountVerified: 'yes',
    reason: 'ok',
    limits: [
      {
        kind: 'weekly_all', group: 'weekly', percent: 96, severity: 'critical',
        resetsAt: new Date(NOW + 3_600_000).toISOString(),
        isActive: true, scopeLabel: null, resetsInSeconds: 3600,
      },
    ],
    fiveHourPercent: 5,
    sevenDayPercent: 96,
    usageCreditsEnabled: false,
    spendPercent: 0,
    note: 'test',
    ...over,
  }
}

suite('subscriptionUsage — a cached reading must never present itself as current', () => {
  test('a fresh reading with a live window is not stale', () => {
    assert.strictEqual(deriveStale(reading(), NOW), false)
  })

  test('age alone makes it stale once past TTL x 3', () => {
    assert.strictEqual(deriveStale(reading({ fetchedAt: NOW - TTL_MS * 3 - 1 }), NOW), true)
    assert.strictEqual(deriveStale(reading({ fetchedAt: NOW - TTL_MS * 3 + 1000 }), NOW), false,
      'just inside the bound is still usable — the age rule must not be off by a window')
  })

  test('THE BUG: a window that already reset is stale even when the read is seconds old', () => {
    // The exact shape found on disk: fetched recently by the clock, but describing a window whose
    // reset instant has passed. Age-only staleness calls this fresh and serves a dead 96%.
    const rolled = reading({
      fetchedAt: NOW - 5_000,
      limits: [{
        kind: 'weekly_all', group: 'weekly', percent: 96, severity: 'critical',
        resetsAt: new Date(NOW - 1_000).toISOString(),
        isActive: true, scopeLabel: null, resetsInSeconds: 3600,
      }],
    })
    assert.strictEqual(deriveStale(rolled, NOW), true)
  })

  test('an unparseable or absent resetsAt never fabricates staleness', () => {
    assert.strictEqual(deriveStale(reading({ limits: [{ ...reading().limits[0], resetsAt: null }] }), NOW), false)
    assert.strictEqual(deriveStale(reading({ limits: [{ ...reading().limits[0], resetsAt: 'not-a-date' }] }), NOW), false)
  })

  test('the renderer does not call a stale snapshot "Anthropic\'s own numbers"', () => {
    const live = formatSubscriptionUsage(reading())
    assert.ok(live.includes("Anthropic's own numbers"), 'a live read keeps the authoritative header')

    const stale = formatSubscriptionUsage(reading({ stale: true, ageSeconds: 511_518 }))
    assert.ok(!stale.includes("Anthropic's own numbers"),
      'the header is the claim a reader acts on — a stale snapshot must not inherit it')
    assert.ok(stale.includes('STALE SNAPSHOT'), 'and must say so in the header itself')
    assert.ok(stale.includes('NOT LIVE'), 'the footer warning still fires')
  })

  test('a stale age is rendered in days, not five-digit minutes', () => {
    const out = formatSubscriptionUsage(reading({ stale: true, ageSeconds: 511_518 }))
    assert.ok(/5d \d+h ago/.test(out), `expected a d/h age, got: ${out}`)
    assert.ok(!out.includes('8525m'), 'minutes buries the one fact the warning exists to convey')
  })

  test('a stale reading suppresses the reset countdown rather than rendering it as live', () => {
    const out = formatSubscriptionUsage(reading({ stale: true }))
    assert.ok(!out.includes('resets in'),
      'a countdown from a cached resets_at reads as live for a window that may already have rolled')
  })

  // MEASURED 2026-08-01: the usage endpoint's response carries NO identity field — top-level keys
  // are all usage buckets, and the only /account|email|user/ match is `extra_usage.user_disabled`.
  // So the numbers are determined solely by the token presented, and swapping the token WITHOUT
  // touching the logged-in email returns another account's numbers under an unchanged label. The
  // label must therefore never be evidence of attribution; it is annotated, never believed.
  // REGRESSION, found by testing the fix instead of trusting it. JSON has no `undefined`: a cache
  // file written before the identity fields existed simply lacks the key, so the parsed value is
  // `undefined` — and `undefined === null` is FALSE. Every identity comparison is written against
  // `null`, so a pre-upgrade file took the "fingerprints differ" branch and a perfectly valid
  // reading was reported as ANOTHER ACCOUNT'S: a false accusation introduced BY the fix for the
  // original mis-attribution. Absence is coerced to null once, in readCache.
  test('a pre-upgrade cache file is UNVERIFIABLE, never a different account', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-usage-old-'))
    const prev = process.env['AGENTLENS_DATA_DIR']
    process.env['AGENTLENS_DATA_DIR'] = dir
    try {
      // No accountFp / accountUuid / accountLabel keys at all — the pre-upgrade shape.
      fs.writeFileSync(path.join(dir, 'subscription-usage.json'), JSON.stringify({
        fetchedAt: Date.now() - 5_000, ageSeconds: 0, stale: false, reason: 'ok',
        limits: [{
          kind: 'weekly_all', group: 'weekly', percent: 37, severity: 'normal',
          resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
          isActive: true, scopeLabel: null, resetsInSeconds: 3600,
        }],
        fiveHourPercent: 7, sevenDayPercent: 37, usageCreditsEnabled: false, spendPercent: 0, note: '',
      }))
      // A cooldown forces the cache-serving path without any network call.
      fs.writeFileSync(path.join(dir, 'subscription-usage-cooldown.json'),
        JSON.stringify({ until: Date.now() + 600_000, consecutive: 1 }))
      const u = await getSubscriptionUsage({})
      assert.ok(u, 'the cached reading is still served')
      assert.notStrictEqual(u.accountVerified, 'no',
        'an absent fingerprint is UNKNOWN provenance, not proof of a different account')
      assert.strictEqual(u.accountLabelSuspect, false, 'and nothing about the label is disputed')
    } finally {
      if (prev === undefined) delete process.env['AGENTLENS_DATA_DIR']
      else process.env['AGENTLENS_DATA_DIR'] = prev
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('freshness and attribution are SEPARATE — an unreadable credential does not age the data', () => {
    // Conflating them called a 13-second-old reading "NOT LIVE" merely because this process could
    // not read the credential to check whose it was, and printed a false LABEL DISPUTED with it.
    const out = formatSubscriptionUsage(reading({ accountVerified: 'unknown', ageSeconds: 13 }))
    assert.ok(!out.includes('NOT LIVE'), `13s-old data is live; only its attribution is missing: ${out}`)
    assert.ok(!out.includes('LABEL DISPUTED'), 'unknown is no evidence about the label')
    assert.ok(out.includes('UNATTRIBUTED'), 'but the missing attribution must still be stated')
    assert.ok(out.includes('NOT verified'), 'and the header must not claim the numbers are that account\'s')
  })

  test('a disputed label is marked as disputed rather than printed as attribution', () => {
    const out = formatSubscriptionUsage(reading({ accountLabelSuspect: true }))
    assert.ok(/LABEL DISPUTED/.test(out), `expected the label to be marked disputed, got: ${out}`)
    assert.ok(out.includes('tester@example.com'), 'still show it — a disputed label is a lead, not noise')
  })

  test('the renderer names window rollover, not merely age, when that is what happened', () => {
    const out = formatSubscriptionUsage(reading({
      stale: true,
      limits: [{
        kind: 'weekly_all', group: 'weekly', percent: 96, severity: 'critical',
        resetsAt: new Date(NOW - 4 * 86_400_000).toISOString(),
        isActive: true, scopeLabel: null, resetsInSeconds: 3600,
      }],
    }))
    assert.ok(/ALREADY RESET/.test(out),
      'a reader who sees only "old" may still anchor on the percentage; say the window is gone')
  })
})
