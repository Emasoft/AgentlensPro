// TRDD-X2E6OSWK — the version-keyed memo behind the standalone server's dashboard-model caches.
// These tests pin the two properties the CPU fix depends on: (1) the same version NEVER recomputes,
// (2) a bumped version ALWAYS recomputes (a cache that could serve the previous version's value
// would show a stale dashboard, which is the one thing this optimisation may not do).
import * as assert from 'assert'
import { VersionedCache } from '../derivedCache'

suite('VersionedCache — memoizes per input version', () => {
  test('computes once for a version and reuses the value for every later call at that version', () => {
    const cache = new VersionedCache<number>()
    let computed = 0
    const compute = (): number => { computed++; return computed }

    assert.strictEqual(cache.get(7, compute), 1)
    assert.strictEqual(cache.get(7, compute), 1)
    assert.strictEqual(cache.get(7, compute), 1)
    assert.strictEqual(computed, 1, 'the derivation must run exactly once per version')
    assert.deepStrictEqual(cache.stats(), { hits: 2, misses: 1 })
  })

  test('recomputes as soon as the version is bumped (never serves the previous version)', () => {
    const cache = new VersionedCache<string>()
    let version = 1
    const compute = (): string => `v${version}`

    assert.strictEqual(cache.get(version, compute), 'v1')
    version = 2
    assert.strictEqual(cache.get(version, compute), 'v2')
    version = 3
    assert.strictEqual(cache.get(version, compute), 'v3')
    assert.deepStrictEqual(cache.stats(), { hits: 0, misses: 3 })
  })

  test('caches a null value (an empty dashboard model is a real answer, not a cache miss)', () => {
    const cache = new VersionedCache<string | null>()
    let computed = 0
    const compute = (): string | null => { computed++; return null }

    assert.strictEqual(cache.get(1, compute), null)
    assert.strictEqual(cache.get(1, compute), null)
    assert.strictEqual(computed, 1, 'null must be cached, not re-derived every call')
  })

  test('returns the SAME object reference on a hit (no re-allocation — that is the point)', () => {
    const cache = new VersionedCache<{ n: number }>()
    const first = cache.get(1, () => ({ n: 1 }))
    const second = cache.get(1, () => ({ n: 2 }))
    assert.strictEqual(first, second)
  })

  test('a version going BACKWARDS is a miss, not a stale hit', () => {
    const cache = new VersionedCache<number>()
    cache.get(5, () => 50)
    assert.strictEqual(cache.get(4, () => 40), 40)
  })

  test('a throwing derivation caches nothing and propagates (fail-fast, no half-built value)', () => {
    const cache = new VersionedCache<number>()
    assert.throws(() => cache.get(1, () => { throw new Error('boom') }), /boom/)
    // The failed version must not be poisoned: the next attempt recomputes.
    assert.strictEqual(cache.get(1, () => 42), 42)
  })

  test('invalidate() forces the next call to recompute at the same version', () => {
    const cache = new VersionedCache<number>()
    let computed = 0
    const compute = (): number => { computed++; return computed }

    cache.get(1, compute)
    cache.invalidate()
    cache.get(1, compute)
    assert.strictEqual(computed, 2)
  })
})
