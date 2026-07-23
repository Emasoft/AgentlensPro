import * as assert from 'assert'
import { rankContributors, formatCulprits, culpritsJson, projectName, BurnStatusPayload } from '../cli/attribution'

// ── attribution: "is it MY project, or another workdir?" ──────────────────────
// The fixture reproduces the get_burn_status.topSessions SHAPE (per-session sessionId +
// workspace + oneMin/fiveMin slices carrying tokensPerMin), with entirely synthetic values.
// Paths and ids here are invented on purpose: a test fixture must not embed one machine's real
// project names or session ids, because it runs on every contributor's checkout and is public.

const SESS = {
  spiky: 'aaaa1111-0000-4000-8000-000000000001',
  steady: 'bbbb2222-0000-4000-8000-000000000002',
  small: 'cccc3333-0000-4000-8000-000000000003',
  idle: 'dddd4444-0000-4000-8000-000000000004',
}

const payload: BurnStatusPayload = {
  topSessions: [
    // Spikes hard in the last minute, but is NOT the heaviest over five.
    { sessionId: SESS.spiky, workspace: '/workspaces/alpha-service', oneMin: { tokensPerMin: 1_900_000 }, fiveMin: { tokensPerMin: 750_000 } },
    // The sustained burner: lower one-minute rate, higher five-minute rate.
    { sessionId: SESS.steady, workspace: '/workspaces/beta-service', oneMin: { tokensPerMin: 600_000 }, fiveMin: { tokensPerMin: 900_000 } },
    { sessionId: SESS.small, workspace: '/workspaces/gamma-tools', oneMin: { tokensPerMin: 10_000 }, fiveMin: { tokensPerMin: 5_000 } },
    { sessionId: SESS.idle, workspace: '/workspaces/delta-idle', oneMin: { tokensPerMin: 0 }, fiveMin: { tokensPerMin: 0 } },
  ],
}

suite('attribution: ranking the culprits', () => {
  test('ranks by the chosen window, heaviest first', () => {
    assert.deepStrictEqual(rankContributors(payload, 'oneMin').map(c => c.project),
      ['alpha-service', 'beta-service', 'gamma-tools'])
  })

  test('the window CHOICE changes the answer — a peak and a sustained drain differ', () => {
    // alpha spiked in the last minute; beta is the heavier SUSTAINED burner. Using oneMin for
    // an abort verdict would name the wrong project.
    assert.strictEqual(rankContributors(payload, 'oneMin')[0].project, 'alpha-service')
    assert.strictEqual(rankContributors(payload, 'fiveMin')[0].project, 'beta-service')
  })

  test('drops sessions burning nothing rather than listing them at 0%', () => {
    assert.ok(!rankContributors(payload, 'oneMin').some(c => c.project === 'delta-idle'))
  })

  test('shares are fractions of the ranked total and sum to 1', () => {
    const sum = rankContributors(payload, 'oneMin').reduce((a, c) => a + c.share, 0)
    assert.ok(Math.abs(sum - 1) < 1e-9, `shares summed to ${sum}`)
  })

  test('an empty, missing, or all-idle feed yields no contributors instead of throwing', () => {
    assert.deepStrictEqual(rankContributors(null), [])
    assert.deepStrictEqual(rankContributors(undefined), [])
    assert.deepStrictEqual(rankContributors({}), [])
    assert.deepStrictEqual(rankContributors({ topSessions: [] }), [])
    assert.deepStrictEqual(rankContributors({ topSessions: [{ sessionId: 'x', oneMin: { tokensPerMin: 0 } }] }), [])
  })

  test('a non-finite rate is treated as no burn, never as NaN leaking into the share', () => {
    const odd: BurnStatusPayload = { topSessions: [{ sessionId: 'a', workspace: '/w/A', oneMin: { tokensPerMin: Number.NaN } }, { sessionId: 'b', workspace: '/w/B', oneMin: { tokensPerMin: 100 } }] }
    const r = rankContributors(odd, 'oneMin')
    assert.deepStrictEqual(r.map(c => c.project), ['B'])
    assert.strictEqual(r[0].share, 1)
  })
})

suite('attribution: projectName', () => {
  test('reduces a workspace path to the name a human uses', () => {
    assert.strictEqual(projectName('/workspaces/alpha-service'), 'alpha-service')
    assert.strictEqual(projectName('/workspaces/alpha-service/'), 'alpha-service')
  })

  test('an absent workspace becomes a visible placeholder, not an empty field', () => {
    assert.strictEqual(projectName(''), '(unknown workdir)')
  })
})

suite('attribution: the one-line answer', () => {
  const ranked = rankContributors(payload, 'oneMin')

  test('names project, session, rate and share, heaviest first', () => {
    const s = formatCulprits(ranked)
    assert.match(s, /^who: alpha-service \(aaaa1111, 1\.9M\/min, \d+%\)/)
    assert.ok(s.includes('beta-service (bbbb2222'))
  })

  test('marks the watched session so "is it me?" needs no id comparison by eye', () => {
    const s = formatCulprits(ranked, SESS.steady)
    assert.match(s, /beta-service \([^)]*\) ←THIS/)
    assert.ok(!/alpha-service \([^)]*\) ←THIS/.test(s), 'only the watched session may be marked')
  })

  test('caps the list and says how many were withheld', () => {
    assert.match(formatCulprits(ranked, null, 2), /\+1 more$/)
    assert.ok(!formatCulprits(ranked, null, 3).includes('more'))
  })

  test('returns an EMPTY STRING when nothing is attributable — the alert still goes out', () => {
    // Attribution is additive. A caller appends it conditionally, so "" must mean "say nothing
    // extra", never "no alert".
    assert.strictEqual(formatCulprits([]), '')
  })

  test('culpritsJson mirrors the same ranking for --json consumers', () => {
    const j = culpritsJson(ranked, 2)
    assert.strictEqual(j.length, 2)
    assert.strictEqual(j[0].project, 'alpha-service')
    assert.strictEqual(j[0].sessionId, SESS.spiky)
    assert.ok(typeof j[0].share === 'number')
  })
})
