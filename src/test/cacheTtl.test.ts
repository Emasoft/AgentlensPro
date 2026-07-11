import * as assert from 'assert'
import {
  TTL_5M_MS, TTL_1H_MS, TTL_5M_MIN, TTL_1H_MIN, DEFAULT_COLD_IDLE_MS, COLD_IDLE_SLACK_MS,
  ASSUMED_TTL_REGIME, classifyTtlRegime, sessionTtlKindOf, ttlPhrase, type TtlContext,
} from '../shared/cacheTtl'

// ── Cache-TTL regime classifier (TRDD-VY1IUVUM) ───────────────────────────────
// The doc-verified matrix as code: session kind × auth regime × env overrides → TTL + provenance.
// Every absent signal must resolve 'assumed' — the classifier NEVER silently guesses.

const ctx = (auth: TtlContext['auth'], over: Partial<TtlContext> = {}): TtlContext =>
  ({ auth, force5m: false, enable1h: false, ...over })

suite('shared/cacheTtl — classifyTtlRegime (the doc matrix)', () => {
  test('main + subscription within plan → automatic 1-hour tier, doc-matrix provenance', () => {
    const r = classifyTtlRegime('main', ctx('subscription'))
    assert.strictEqual(r.ttlMs, TTL_1H_MS)
    assert.strictEqual(r.ttlAssumedMin, TTL_1H_MIN)
    assert.strictEqual(r.ttlSource, 'doc-matrix')
  })

  test('main + subscription drawing USAGE CREDITS → dropped to the 5-min tier', () => {
    const r = classifyTtlRegime('main', ctx('usage-credits'))
    assert.strictEqual(r.ttlMs, TTL_5M_MS)
    assert.strictEqual(r.ttlSource, 'doc-matrix')
    assert.ok(r.ttlBasis.includes('USAGE CREDITS'), r.ttlBasis)
  })

  test('main + API key → 5-min default; ENABLE_PROMPT_CACHING_1H=1 opts into 1h with config provenance', () => {
    const plain = classifyTtlRegime('main', ctx('api-key'))
    assert.strictEqual(plain.ttlMs, TTL_5M_MS)
    assert.strictEqual(plain.ttlSource, 'doc-matrix')
    const opted = classifyTtlRegime('main', ctx('api-key', { enable1h: true }))
    assert.strictEqual(opted.ttlMs, TTL_1H_MS)
    assert.strictEqual(opted.ttlSource, 'config')
  })

  test('subagent → 5 min ALWAYS, auth-independent, even with NO machine context', () => {
    // The one kind whose doc row needs no machine signals: the 1h auto applies only to the
    // main conversation, so a subagent resolves doc-matrix even when ctx is null.
    for (const c of [ctx('subscription'), ctx('api-key', { enable1h: true }), ctx('unknown'), null]) {
      const r = classifyTtlRegime('subagent', c)
      assert.strictEqual(r.ttlMs, TTL_5M_MS, JSON.stringify(c))
      assert.strictEqual(r.ttlSource, 'doc-matrix')
    }
  })

  test('fork rides the parent-conversation regime (reads the PARENT cache entry)', () => {
    assert.strictEqual(classifyTtlRegime('fork', ctx('subscription')).ttlMs, TTL_1H_MS)
    assert.strictEqual(classifyTtlRegime('fork', ctx('api-key')).ttlMs, TTL_5M_MS)
    assert.ok(classifyTtlRegime('fork', ctx('subscription')).ttlBasis.includes('PARENT'))
  })

  test('FORCE_PROMPT_CACHING_5M wins over every auth regime, config provenance', () => {
    for (const auth of ['subscription', 'usage-credits', 'api-key', 'unknown'] as const) {
      const r = classifyTtlRegime('main', ctx(auth, { force5m: true, enable1h: true }))
      assert.strictEqual(r.ttlMs, TTL_5M_MS, auth)
      assert.strictEqual(r.ttlSource, 'config', auth)
      assert.ok(r.ttlBasis.includes('FORCE_PROMPT_CACHING_5M'), r.ttlBasis)
    }
  })

  test('absent signals NEVER silently guess: null ctx / null kind / unknown auth → assumed 5-min floor', () => {
    for (const r of [
      classifyTtlRegime('main', null),
      classifyTtlRegime('main', undefined),
      classifyTtlRegime(null, ctx('subscription')),
      classifyTtlRegime('main', ctx('unknown')),
    ]) {
      assert.strictEqual(r.ttlMs, TTL_5M_MS)
      assert.strictEqual(r.ttlSource, 'assumed')
    }
    assert.strictEqual(ASSUMED_TTL_REGIME.ttlSource, 'assumed')
    assert.strictEqual(ASSUMED_TTL_REGIME.ttlAssumedMin, TTL_5M_MIN)
  })

  test('ttlPhrase carries minutes + provenance for warning messages', () => {
    assert.strictEqual(ttlPhrase(classifyTtlRegime('main', ctx('subscription'))), '60-min TTL (doc-matrix)')
    assert.strictEqual(ttlPhrase(ASSUMED_TTL_REGIME), '5-min TTL (assumed)')
  })

  test('the gate cold-idle default derives from the shared 5-min tier + slack (historical 5.5min)', () => {
    assert.strictEqual(DEFAULT_COLD_IDLE_MS, TTL_5M_MS + COLD_IDLE_SLACK_MS)
    assert.strictEqual(DEFAULT_COLD_IDLE_MS, 330_000)
  })
})

suite('shared/cacheTtl — sessionTtlKindOf (card lineage → TTL kind)', () => {
  test('no parentSessionId → main conversation', () => {
    assert.strictEqual(sessionTtlKindOf({}), 'main')
    assert.strictEqual(sessionTtlKindOf({ spawnKind: undefined }), 'main')
  })

  test('a child card (parentSessionId set) → subagent', () => {
    assert.strictEqual(sessionTtlKindOf({ parentSessionId: 'p1' }), 'subagent')
    assert.strictEqual(sessionTtlKindOf({ parentSessionId: 'p1', spawnKind: 'fresh' }), 'subagent')
    assert.strictEqual(sessionTtlKindOf({ parentSessionId: 'p1', spawnKind: 'worktree' }), 'subagent')
  })

  test('spawnKind fork wins over parentSessionId — a fork IS a child but reads the PARENT entry', () => {
    assert.strictEqual(sessionTtlKindOf({ parentSessionId: 'p1', spawnKind: 'fork' }), 'fork')
  })
})
