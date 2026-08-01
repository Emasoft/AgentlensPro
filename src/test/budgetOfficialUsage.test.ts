// `budget` must report Anthropic's OWN utilization beside its local projection — and must not let
// the projection alone decide when the two disagree.
//
// WHAT THIS GUARDS. `budget` projects from consumption ÷ capacity. When no capacity has been
// observed for the current account it borrows a SAME-PLAN PROXY from a different one. On
// 2026-08-01 that proxy put the 7d cap at $12,282 against $728 consumed → "5.9% full" → GO, while
// the account was really at 37% and a six-day-old cache was separately claiming 96%. Three numbers,
// no agreement, and the verdict rode the one nobody had checked. A second Claude session relayed it
// and recommended deferring work on it.
//
// The rule these tests pin: an official reading may only influence the verdict when it is LIVE and
// ACCOUNT-VERIFIED. Acting on a stale or unattributed reading is the same mistake pointing the
// other way — it is what produced the bogus 96% in the first place.

import * as assert from 'assert'
import { officialPct, applyOfficial, officialLine, type BudgetDecision } from '../cli/budgetCli'
import type { SubscriptionUsage } from '../subscriptionUsage'

function usage(over: Partial<SubscriptionUsage> = {}): SubscriptionUsage {
  return {
    fetchedAt: Date.now(), ageSeconds: 3, stale: false,
    accountFp: 'fp-a', accountUuid: 'uuid-a', accountLabel: 'me@example.com',
    accountLabelSuspect: false, accountVerified: 'yes', reason: 'ok',
    limits: [
      { kind: 'session', group: 'session', percent: 6, severity: 'normal', resetsAt: null, isActive: true, scopeLabel: null, resetsInSeconds: null },
      { kind: 'weekly_all', group: 'weekly', percent: 37, severity: 'normal', resetsAt: null, isActive: true, scopeLabel: null, resetsInSeconds: null },
      { kind: 'weekly_scoped', group: 'weekly', percent: 8, severity: 'normal', resetsAt: null, isActive: false, scopeLabel: 'Fable', resetsInSeconds: null },
    ],
    fiveHourPercent: 6, sevenDayPercent: 37, usageCreditsEnabled: false, spendPercent: 0, note: 'test',
    ...over,
  }
}

const GO: BudgetDecision = { verdict: 'GO', reason: "won't exhaust at this rate", etaMinutes: null, remainingMin: 60 }

suite('budget — the account\'s own utilization sits beside the local projection', () => {
  test('picks the session bucket for 5h and the FULLEST weekly bucket for 7d', () => {
    assert.strictEqual(officialPct(usage(), '5h'), 6)
    // weekly_all 37 vs weekly_scoped 8: either cap can be the one that stops you, so the binding
    // figure is the max — a mean would report a window as half as full as it really is.
    assert.strictEqual(officialPct(usage(), '7d'), 37)
  })

  test('no matching bucket yields null, never 0 — absence is not emptiness', () => {
    assert.strictEqual(officialPct(usage({ limits: [] }), '7d'), null)
    assert.strictEqual(officialPct(null, '7d'), null)
  })

  test('a healthy official reading leaves a GO alone', () => {
    assert.strictEqual(applyOfficial(GO, usage(), 37).verdict, 'GO')
  })

  test('THE BUG: a nearly-full window overrides a projection that says GO', () => {
    const d = applyOfficial(GO, usage(), 96)
    assert.strictEqual(d.verdict, 'NO_GO', 'a GO at 96% full is the exact failure this command exists to prevent')
    assert.ok(/96% full/.test(d.reason), 'and the reason must name the number that overrode it')
  })

  test('a merely high window downgrades to TIGHT rather than aborting', () => {
    assert.strictEqual(applyOfficial(GO, usage(), 85).verdict, 'TIGHT')
  })

  test('an override never UPGRADES a verdict — it can only make it worse', () => {
    const noGo: BudgetDecision = { verdict: 'NO_GO', reason: 'window exhausts first', etaMinutes: 5, remainingMin: 60 }
    assert.strictEqual(applyOfficial(noGo, usage(), 2).verdict, 'NO_GO',
      'a low official figure must not overrule a projection that says the window runs out')
  })

  test('a STALE reading is ignored for the verdict — trusting it is how the 96% happened', () => {
    assert.strictEqual(applyOfficial(GO, usage({ stale: true }), 96).verdict, 'GO')
  })

  test('an UNVERIFIED-account reading is ignored for the verdict', () => {
    assert.strictEqual(applyOfficial(GO, usage({ accountVerified: 'unknown' }), 96).verdict, 'GO')
    assert.strictEqual(applyOfficial(GO, usage({ accountVerified: 'no' }), 96).verdict, 'GO')
  })

  test('the printed line names the account, both windows, and its own trustworthiness', () => {
    const line = officialLine(usage(), '7d')
    assert.ok(line.includes('me@example.com'), 'an unattributed percentage is what caused the incident')
    assert.ok(line.includes('5h 6%') && line.includes('7d 37%'), 'both windows, always')
    assert.ok(line.includes('live'))
  })

  test('an unusable reading says so instead of being silently omitted', () => {
    // Silence would read as agreement with the projection — the reader would never learn that the
    // second opinion was missing.
    assert.ok(/NOT USABLE/.test(officialLine(usage({ stale: true }), '7d')))
    assert.ok(/DIFFERENT account/.test(officialLine(usage({ accountVerified: 'no' }), '7d')))
    assert.ok(/UNAVAILABLE/.test(officialLine(null, '7d')))
  })
})
