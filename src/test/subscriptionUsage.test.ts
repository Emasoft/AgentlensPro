// Tests for the subscription-usage probe (src/subscriptionUsage.ts).
//
// Pure functions only — no network. The HTTP path is exercised live (it needs a real OAuth token and
// the endpoint 429s hard, so hammering it from a test suite would be exactly the abuse the back-off
// exists to prevent). What IS tested here is every decision the module makes AROUND the request:
// back-off escalation, header parsing, normalization, bar rendering, and the stale-suppression rule.

import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  usageBar, retryAfterSeconds, normalize, formatSubscriptionUsage, loadToken,
  archiveAccountUsage, listObservedAccountUsage,
  type SubscriptionUsage,
} from '../subscriptionUsage'

const NOW = Date.parse('2026-07-26T12:00:00Z')

function hdrs(o: Record<string, string>): Headers {
  const h = new Headers()
  for (const [k, v] of Object.entries(o)) h.set(k, v)
  return h
}

suite('subscriptionUsage', () => {
  test('renders a 10-cell bar without drawing the number inside it', () => {
    assert.strictEqual(usageBar(0), '[░░░░░░░░░░]')
    assert.strictEqual(usageBar(50), '[█████░░░░░]')
    assert.strictEqual(usageBar(100), '[██████████]')
    assert.strictEqual(usageBar(97), '[██████████]', '97% rounds to a full bar — the number carries the precision')
    assert.strictEqual(usageBar(-5), '[░░░░░░░░░░]', 'out-of-range clamps rather than throwing')
    assert.strictEqual(usageBar(1e9), '[██████████]')
    assert.strictEqual(usageBar(NaN), '[░░░░░░░░░░]')
  })

  test('parses Retry-After as delta-seconds AND as an HTTP-date', () => {
    assert.strictEqual(retryAfterSeconds(hdrs({ 'retry-after': '120' }), NOW), 120)
    const future = new Date(NOW + 300_000).toUTCString()
    const secs = retryAfterSeconds(hdrs({ 'retry-after': future }), NOW)
    assert.ok(secs !== null && Math.abs(secs - 300) <= 1, `expected ~300, got ${secs}`)
  })

  test('falls back to the anthropic-ratelimit reset headers, epoch or ISO', () => {
    const epoch = String(Math.floor(NOW / 1000) + 90)
    assert.strictEqual(retryAfterSeconds(hdrs({ 'anthropic-ratelimit-unified-reset': epoch }), NOW), 90)
    const iso = new Date(NOW + 45_000).toISOString()
    assert.strictEqual(retryAfterSeconds(hdrs({ 'anthropic-ratelimit-unified-5h-reset': iso }), NOW), 45)
    assert.strictEqual(retryAfterSeconds(hdrs({}), NOW), null, 'no usable header → null, never a guessed delay')
    assert.strictEqual(retryAfterSeconds(null, NOW), null)
  })

  test('normalizes the generic limits[] array, not just the two named windows', () => {
    const u = normalize({
      five_hour: { utilization: 97, resets_at: new Date(NOW + 1_440_000).toISOString() },
      seven_day: { utilization: 90, resets_at: new Date(NOW + 285_000_000).toISOString() },
      limits: [
        { kind: 'session', group: 'session', percent: 97, severity: 'critical', resets_at: new Date(NOW + 1_440_000).toISOString(), is_active: true },
        { kind: 'weekly_all', group: 'weekly', percent: 90, severity: 'critical', resets_at: null, is_active: false },
        { kind: 'weekly_scoped', group: 'weekly', percent: 45, severity: 'normal', resets_at: null, is_active: false, scope: { model: { display_name: 'Fable' } } },
      ],
      extra_usage: { is_enabled: false },
      spend: { percent: 0 },
    }, NOW, 'ok', NOW)
    assert.strictEqual(u.limits.length, 3, 'every bucket survives — a per-model scoped limit is not dropped')
    assert.strictEqual(u.limits[2].scopeLabel, 'Fable')
    assert.strictEqual(u.limits[0].resetsInSeconds, 1440)
    assert.strictEqual(u.fiveHourPercent, 97)
    assert.strictEqual(u.sevenDayPercent, 90)
    assert.strictEqual(u.usageCreditsEnabled, false)
    assert.strictEqual(u.reason, 'ok')
  })

  test('credits-disabled is the 1-hour TTL oracle, and it is stated in the rendering', () => {
    const u = normalize({ limits: [], extra_usage: { is_enabled: false } }, NOW, 'ok', NOW)
    assert.ok(formatSubscriptionUsage(u).includes('1-hour prompt-cache TTL active'))
    const credits = normalize({ limits: [], extra_usage: { is_enabled: true } }, NOW, 'ok', NOW)
    assert.ok(formatSubscriptionUsage(credits).includes('TTL drops to 5 min'))
  })

  test('a stale reading suppresses its countdowns instead of rendering a rolled window as live', () => {
    const fresh = normalize({
      limits: [{ kind: 'session', group: 'session', percent: 50, severity: 'normal', resets_at: new Date(NOW + 600_000).toISOString(), is_active: true }],
    }, NOW, 'ok', NOW)
    assert.ok(formatSubscriptionUsage(fresh).includes('resets in 10m'))
    // Same payload, fetched long ago: the cached resets_at may name a window that already rolled.
    const stale: SubscriptionUsage = { ...fresh, fetchedAt: NOW - 7_200_000, ageSeconds: 7200, stale: true, reason: 'cooldown' }
    const text = formatSubscriptionUsage(stale)
    assert.ok(!text.includes('resets in'), 'no countdown may be printed from a stale cache')
    assert.ok(text.includes('NOT LIVE') && text.includes('cooldown'), 'it names the reason instead of guessing')
  })

  test('unavailable renders as unavailable — never as 0% used', () => {
    const text = formatSubscriptionUsage(null)
    assert.ok(text.includes('unavailable'))
    assert.ok(!text.includes('0%'), 'a missing reading must never look like an empty window')
  })

  test('the macOS keychain is not touched without an explicit opt-in', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-usage-'))
    try {
      // No credentials file in this CLAUDE_CONFIG_DIR, and no opt-in: on darwin the answer must be
      // opt_in_required (NOT a keychain read, which would pop a password prompt on a test run).
      const r = loadToken({ CLAUDE_CONFIG_DIR: dir } as NodeJS.ProcessEnv)
      assert.strictEqual(r.token, undefined)
      assert.strictEqual(r.reason, process.platform === 'darwin' ? 'opt_in_required' : 'no_token')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  test('reads the credentials file when present, without any keychain access', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-usage-'))
    try {
      fs.writeFileSync(path.join(dir, '.credentials.json'),
        JSON.stringify({ claudeAiOauth: { accessToken: 'tok-abc', expiresAt: NOW + 3_600_000 } }))
      const r = loadToken({ CLAUDE_CONFIG_DIR: dir } as NodeJS.ProcessEnv)
      assert.strictEqual(r.token, 'tok-abc')
      assert.strictEqual(r.expiresAt, NOW + 3_600_000)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})

// ─── The per-account archive (issue #8, phase 1) ─────────────────────────────────────────────────
//
// The live cache is one file, overwritten on every fetch, so a rotation used to destroy the previous
// account's numbers outright. These pin the archive that stops that — the part that cannot be
// backfilled, so a regression here is silent and permanent.
suite('subscription usage — the per-account archive', () => {
  const A = '32eb8302-c2a4-4333-a15f-ba17ec8960ad'
  const B = '75099fe9-8c66-4edd-bd99-a05593a57928'

  function rec(uuid: string | null, fetchedAt: number, label: string): SubscriptionUsage {
    return {
      fetchedAt, ageSeconds: 0, stale: false, reason: 'ok',
      accountFp: 'fp-' + label, accountUuid: uuid, accountLabel: label, accountTier: null,
      localClaimedLabel: null, accountLabelSuspect: false, accountVerified: 'yes',
      limits: [], fiveHourPercent: 10, sevenDayPercent: 20,
      usageCreditsEnabled: false, spendPercent: null, note: '',
    } as unknown as SubscriptionUsage
  }

  /** Each case gets its own DATA_DIR: the archive is real files, and a shared dir would let one
   *  test's records answer another's question.
   *
   *  The data dir is NESTED one level inside the sandbox on purpose. A `../../` traversal out of
   *  `<data>/subscription-usage/` lands in the sandbox root, which the test owns and can assert is
   *  untouched. Without the nesting it lands in os.tmpdir(), which is full of other files — and the
   *  escape-attempt test then passes against a version with NO path guard at all. (Measured: it did.) */
  function inDataDir<T>(fn: (sandbox: string) => T): T {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-arch-'))
    const dir = path.join(sandbox, 'data')
    fs.mkdirSync(dir)
    const prev = process.env.AGENTLENS_DATA_DIR
    process.env.AGENTLENS_DATA_DIR = dir
    try { return fn(sandbox) } finally {
      if (prev === undefined) delete process.env.AGENTLENS_DATA_DIR
      else process.env.AGENTLENS_DATA_DIR = prev
      fs.rmSync(sandbox, { recursive: true, force: true })
    }
  }

  test('a second account does not overwrite the first — that IS the feature', () => {
    inDataDir(() => {
      archiveAccountUsage(rec(A, 1000, 'a@x'))
      archiveAccountUsage(rec(B, 2000, 'b@x'))
      const all = listObservedAccountUsage()
      assert.strictEqual(all.length, 2, 'both accounts must survive; one file per fetch is the bug')
      assert.deepStrictEqual(all.map(r => r.accountUuid), [B, A], 'newest first')
    })
  })

  test('the same account re-archived replaces its own record rather than accumulating', () => {
    inDataDir(() => {
      archiveAccountUsage(rec(A, 1000, 'a@x'))
      archiveAccountUsage(rec(A, 5000, 'a@x'))
      const all = listObservedAccountUsage()
      assert.strictEqual(all.length, 1)
      assert.strictEqual(all[0].fetchedAt, 5000)
    })
  })

  test('an unidentified reading is NOT filed under a made-up key', () => {
    inDataDir(() => {
      archiveAccountUsage(rec(null, 1000, 'who?'))
      assert.deepStrictEqual(listObservedAccountUsage(), [],
        'a row that cannot say whose numbers it holds is worse than no row')
    })
  })

  test('a uuid that is not a uuid never becomes a path', () => {
    inDataDir(sandbox => {
      // It arrives from the NETWORK. Sanitizing and using it anyway is how `../` becomes a filename.
      for (const bad of ['../../evil', '../escape', 'a/b', '..', '', 'not-a-uuid']) {
        archiveAccountUsage(rec(bad, 1000, 'x'))
      }
      assert.deepStrictEqual(listObservedAccountUsage(), [], 'and none of them may be reported back')
      // The load-bearing assertion: NOTHING appeared outside the data dir. Checking only that the
      // listing is empty is not enough — an escaped write lands outside the archive, so the listing
      // stays empty either way and the test guards nothing.
      assert.deepStrictEqual(fs.readdirSync(sandbox), ['data'],
        'a write escaped the data directory')
      const archive = path.join(sandbox, 'data', 'subscription-usage')
      assert.deepStrictEqual(fs.existsSync(archive) ? fs.readdirSync(archive) : [], [],
        'nothing may be filed under a key that is not an account')
    })
  })

  test('the legacy single-file cache is adopted, but never clobbers a FRESHER archived record', () => {
    inDataDir(() => {
      const dir = String(process.env.AGENTLENS_DATA_DIR)
      // Case 1: nothing archived yet — the one reading already on disk must not be lost.
      fs.writeFileSync(path.join(dir, 'subscription-usage.json'), JSON.stringify(rec(A, 3000, 'a@x')))
      assert.strictEqual(listObservedAccountUsage().length, 1, 'legacy reading adopted')
      assert.strictEqual(listObservedAccountUsage()[0].fetchedAt, 3000)
      // Case 2: the archive is NEWER. Re-adopting unconditionally would walk it backwards on every
      // call — the legacy file is only overwritten on a fetch, so it goes stale while the archive does not.
      archiveAccountUsage(rec(A, 9000, 'a@x'))
      assert.strictEqual(listObservedAccountUsage()[0].fetchedAt, 9000,
        'a stale legacy file must not overwrite a fresher archived record')
    })
  })

  test('one unreadable record costs one account, not all of them', () => {
    inDataDir(() => {
      archiveAccountUsage(rec(A, 1000, 'a@x'))
      fs.writeFileSync(path.join(String(process.env.AGENTLENS_DATA_DIR), 'subscription-usage', `${B}.json`), '{ truncated')
      const all = listObservedAccountUsage()
      assert.strictEqual(all.length, 1, 'the readable account still reports')
      assert.strictEqual(all[0].accountUuid, A)
    })
  })

  test('reading an empty archive is [] — and it is the caller who must not call that "no accounts"', () => {
    inDataDir(() => { assert.deepStrictEqual(listObservedAccountUsage(), []) })
  })
})
