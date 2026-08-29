import * as assert from 'assert'
import { verdictFor, bucketMatches, EXHAUSTED_PCT } from '../cli/modelHeadroomCli'
import type { SubscriptionUsage, UsageLimit } from '../subscriptionUsage'

// ── agentlenspro model-headroom (TRDD-VNKPUAY4) ────────────────────────────────────────
// The verb an agent runs BEFORE spawning the Fable advisor. Fable is metered by its own
// weekly window, separate from weekly_all, so the aggregate cannot answer "is it callable".
// Measured 2026-08-29: the advisor was spawned against an exhausted window and ~20 minutes
// were spent waiting for a verdict that could never arrive.
//
// `verdictFor` is pure and exported for exactly this reason — the matching and the
// null-handling are the parts that can be wrong, and neither needs a credential to reach.

const limit = (over: Partial<UsageLimit>): UsageLimit => ({
  kind: 'weekly_scoped', group: 'weekly', percent: 0, severity: 'normal',
  resetsAt: null, isActive: true, scopeLabel: null, resetsInSeconds: null, ...over,
})

const usage = (limits: UsageLimit[]): SubscriptionUsage => ({
  fetchedAt: Date.now(), ageSeconds: 0, stale: false, accountFp: null, limits,
} as unknown as SubscriptionUsage)

suite('agentlenspro model-headroom — verdictFor', () => {
  test('a scoped weekly bucket at or above the threshold is EXHAUSTED', () => {
    const v = verdictFor(usage([limit({ scopeLabel: 'claude-fable-5', percent: EXHAUSTED_PCT })]), 'fable')
    assert.strictEqual(v.state, 'exhausted')
    assert.strictEqual(v.label, 'claude-fable-5', 'the deciding bucket must be named, so a wrong match is visible')
    // Exactly AT the threshold counts as spent — a boundary written down because "95" appears in
    // the help text and the rule file, and an off-by-one here would make those two documents lie.
    assert.strictEqual(v.pct, EXHAUSTED_PCT)
  })

  test('the same bucket below the threshold is OK', () => {
    const v = verdictFor(usage([limit({ scopeLabel: 'claude-fable-5', percent: EXHAUSTED_PCT - 1 })]), 'fable')
    assert.strictEqual(v.state, 'ok')
  })

  test('NO payload is unknown, never ok — an unreadable credential must not read as headroom', () => {
    const v = verdictFor(null, 'fable')
    assert.strictEqual(v.state, 'unknown')
    assert.ok(v.reason, 'unknown must carry a reason, or the caller cannot tell why')
  })

  test('a payload with ONLY weekly_all is unknown, never ok (the whole point of the verb)', () => {
    // This is the case that would silently defeat the verb if it guessed. weekly_all says nothing
    // about Fable's own window, so answering `ok` here would send the caller straight into the
    // 20-minute hang this exists to prevent.
    const v = verdictFor(usage([limit({ kind: 'weekly_all', scopeLabel: null, percent: 12 })]), 'fable')
    assert.strictEqual(v.state, 'unknown')
  })

  test('the FULLEST matching bucket binds when a model reports more than one scope', () => {
    const v = verdictFor(usage([
      limit({ scopeLabel: 'fable-a', percent: 10 }),
      limit({ scopeLabel: 'fable-b', percent: 99 }),
    ]), 'fable')
    assert.strictEqual(v.state, 'exhausted', 'the cap closest to full is the one that will stop the call')
    assert.strictEqual(v.label, 'fable-b')
  })

  test('a DIFFERENT model\'s bucket does not answer for this one', () => {
    const v = verdictFor(usage([limit({ scopeLabel: 'claude-opus-5', percent: 99 })]), 'fable')
    assert.strictEqual(v.state, 'unknown', 'opus being spent says nothing about fable')
  })

  test('a null percent is not treated as an empty window', () => {
    // officialBuckets drops non-finite percents, so this must fall through to unknown rather than
    // becoming a 0% "plenty of room" answer — the most dangerous thing to say about a window
    // nobody could read (subscriptionUsage.ts states this contract for `percent`).
    const v = verdictFor(usage([limit({ scopeLabel: 'claude-fable-5', percent: null })]), 'fable')
    assert.strictEqual(v.state, 'unknown')
  })
})

suite('agentlenspro model-headroom — bucketMatches', () => {
  test('matches a bare name against the full model id, ignoring case and separators', () => {
    assert.ok(bucketMatches('claude-fable-5', 'fable'))
    assert.ok(bucketMatches('Fable', 'fable'))
    assert.ok(bucketMatches('claude_fable_5', 'FABLE'))
  })

  test('does not match an unrelated model', () => {
    assert.ok(!bucketMatches('claude-opus-5', 'fable'))
    assert.ok(!bucketMatches('claude-haiku-4-5', 'fable'))
  })
})
