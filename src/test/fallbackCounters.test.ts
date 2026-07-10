import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { countFallback, fallbackTotals, resetFallbackCounters } from '../shared/fallbackCounters'
import { loadLogOffsets, loadPersistedCards, saveLogOffsets } from '../collectorState'

// ── Fallback counters (P6) — "silence is never invisible" ─────────────────────
// Registry semantics + a real-fs proof that the collectorState sidecar loads count their
// silent fallbacks WITHOUT changing behavior (they still return null exactly as before).

suite('shared/fallbackCounters — named-counter registry', () => {
  setup(() => resetFallbackCounters())

  test('unfired counters are absent (honest absence), fired ones accumulate', () => {
    assert.deepStrictEqual(fallbackTotals(), {})
    countFallback('a.one')
    countFallback('a.one')
    countFallback('b.two')
    assert.deepStrictEqual(fallbackTotals(), { 'a.one': 2, 'b.two': 1 })
  })

  test('totals are name-sorted for stable output', () => {
    countFallback('z.last')
    countFallback('a.first')
    assert.deepStrictEqual(Object.keys(fallbackTotals()), ['a.first', 'z.last'])
  })

  test('reset clears everything (the test-isolation hook)', () => {
    countFallback('x')
    resetFallbackCounters()
    assert.deepStrictEqual(fallbackTotals(), {})
  })
})

suite('collectorState sidecar loads — silent fallbacks are counted, behavior unchanged', () => {
  let dir = ''
  suiteSetup(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-fbk-')) })
  suiteTeardown(() => { fs.rmSync(dir, { recursive: true, force: true }) })
  setup(() => resetFallbackCounters())

  test('a MISSING offsets sidecar is the normal first boot: null returned, NOTHING counted', () => {
    // ENOENT must not be a "degradation" — counting it would bury real corruption in noise.
    assert.strictEqual(loadLogOffsets(path.join(dir, 'nope.json')), null)
    assert.deepStrictEqual(fallbackTotals(), {})
  })

  test('a CORRUPT offsets sidecar still falls back to null (cold rescan) AND is counted', () => {
    const f = path.join(dir, 'offsets.json')
    fs.writeFileSync(f, '{ not json !!!')
    assert.strictEqual(loadLogOffsets(f), null, 'behavior unchanged: corrupt → null')
    assert.strictEqual(fallbackTotals()['collectorState.offsetsCorrupt'], 1)
  })

  test('a CORRUPT cards sidecar still falls back to null AND is counted', () => {
    const f = path.join(dir, 'cards.json')
    fs.writeFileSync(f, 'garbage')
    assert.strictEqual(loadPersistedCards(f), null)
    assert.strictEqual(fallbackTotals()['collectorState.cardsCorrupt'], 1)
  })

  test('a HEALTHY round-trip counts nothing (counters fire only inside the swallow branch)', () => {
    const f = path.join(dir, 'good-offsets.json')
    saveLogOffsets(f, { '/x.jsonl': { bytesRead: 10, mtimeMs: 1 } })
    const loaded = loadLogOffsets(f)
    assert.ok(loaded && loaded['/x.jsonl'].bytesRead === 10)
    assert.deepStrictEqual(fallbackTotals(), {})
  })
})
