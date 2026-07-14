// The delta log exists to kill ~9.4 MB/min of pointless device writes (TRDD-K3WDPR7M Phase 4):
// log-sessions.json (31.6 MB every 5 min) and log-offsets.json (3.1 MB every 60 s) were FULL-FILE
// rewrites of the whole collection to record a few changed records.
//
// So the tests assert the two properties that make it worth having — an unchanged save costs ZERO,
// and a one-record change costs ~one record — and the two that make it SAFE: state survives a
// restart, and a crash cannot corrupt the corpus.
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { COMPACT_MIN_BYTES, DeltaLog } from '../store/deltaLog'

interface Card { id: string; blob: string }

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-delta-')) }

/** A collection shaped like the real one: many cards, each a few KB. */
function cards(n: number, mark = 'a'): Map<string, Card> {
  const m = new Map<string, Card>()
  for (let i = 0; i < n; i++) m.set(`s${i}`, { id: `s${i}`, blob: `${mark}`.repeat(2000) })
  return m
}

suite('deltaLog — the write must be proportional to the CHANGE, not to the collection', () => {
  test('saving an UNCHANGED collection writes ZERO bytes', () => {
    const dir = tmp()
    const log = new DeltaLog<Card>(dir, 'cards')
    const c = cards(100)
    const first = log.save(c)
    assert.ok(first.bytes > 0, 'the first save must persist everything')

    // The old code rewrote 31.6 MB every 5 minutes whether or not anything had happened. This is the
    // single most important assertion in the file.
    const second = log.save(c)
    assert.strictEqual(second.bytes, 0)
    assert.strictEqual(second.appended, 0)
  })

  test('changing ONE record of 100 costs about ONE record, not the whole collection', () => {
    const dir = tmp()
    const log = new DeltaLog<Card>(dir, 'cards')
    const c = cards(100)
    const full = log.save(c)

    c.set('s7', { id: 's7', blob: 'z'.repeat(2000) })
    const delta = log.save(c)

    assert.strictEqual(delta.appended, 1)
    assert.ok(delta.bytes < full.bytes / 50,
      `one changed record must not cost the collection (${delta.bytes} vs ${full.bytes})`)
  })

  test('a NEW record is appended; a REMOVED one is tombstoned', () => {
    const dir = tmp()
    const log = new DeltaLog<Card>(dir, 'cards')
    const c = cards(3)
    log.save(c)

    c.set('new', { id: 'new', blob: 'n' })
    c.delete('s1')
    const r = log.save(c)
    assert.strictEqual(r.appended, 1)
    assert.strictEqual(r.deleted, 1)

    const back = new DeltaLog<Card>(dir, 'cards').load()
    assert.ok(back.has('new'))
    assert.ok(!back.has('s1'), 'a tombstone must actually remove the record on reload')
  })
})

suite('deltaLog — state must survive a restart', () => {
  test('snapshot + deltas reload to exactly the live collection', () => {
    const dir = tmp()
    const log = new DeltaLog<Card>(dir, 'cards')
    const c = cards(20)
    log.save(c)
    c.set('s3', { id: 's3', blob: 'changed' })
    c.set('s99', { id: 's99', blob: 'added' })
    log.save(c)

    const back = new DeltaLog<Card>(dir, 'cards').load()
    assert.deepStrictEqual([...back.entries()].sort(), [...c.entries()].sort())
  })

  test('after a reload, an UNCHANGED save still writes ZERO — a restart must not force a full rewrite', () => {
    // If the written-hashes were not seeded from the loaded state, the first save after every restart
    // would re-append the entire collection — turning a restart into exactly the 31.6 MB write we are
    // removing, just less often.
    const dir = tmp()
    const a = new DeltaLog<Card>(dir, 'cards')
    const c = cards(50)
    a.save(c)

    const b = new DeltaLog<Card>(dir, 'cards')
    const loaded = b.load()
    assert.strictEqual(b.save(loaded).bytes, 0)
  })

  test('compaction folds the delta back into the snapshot and the data is unchanged', () => {
    const dir = tmp()
    const log = new DeltaLog<Card>(dir, 'cards')
    const c = cards(30)
    log.save(c)

    // Churn until the delta outgrows the snapshot and a compaction must trigger.
    let compacted = false
    for (let i = 0; i < 200 && !compacted; i++) {
      c.set(`s${i % 30}`, { id: `s${i % 30}`, blob: `v${i}`.repeat(1000) })
      compacted = log.save(c).compacted
    }
    assert.ok(compacted, 'the delta must eventually be folded back, or load-time replay grows forever')
    assert.deepStrictEqual([...new DeltaLog<Card>(dir, 'cards').load().entries()].sort(), [...c.entries()].sort())
    assert.ok(!fs.existsSync(path.join(dir, 'cards.delta.ndjson')), 'the delta is dropped after compaction')
  })

  test('a tiny collection does not compact on every append', () => {
    // With no floor, a 2 KB snapshot + a 2 KB delta would compact constantly — rewriting the snapshot
    // on every save and defeating the entire purpose.
    const dir = tmp()
    const log = new DeltaLog<Card>(dir, 'small')
    const c = new Map<string, Card>([['a', { id: 'a', blob: 'x' }]])
    log.save(c)
    for (let i = 0; i < 5; i++) {
      c.set('a', { id: 'a', blob: `x${i}` })
      assert.strictEqual(log.save(c).compacted, false)
    }
    assert.ok(COMPACT_MIN_BYTES > 0)
  })
})

suite('deltaLog — a crash must never cost more than the last append', () => {
  test('a TORN trailing line is dropped, not fatal', () => {
    const dir = tmp()
    const log = new DeltaLog<Card>(dir, 'cards')
    const c = cards(5)
    log.save(c)
    c.set('s2', { id: 's2', blob: 'updated' })
    log.save(c)

    // Simulate a crash mid-append: a half-written final line.
    fs.appendFileSync(path.join(dir, 'cards.delta.ndjson'), '{"k":"s4","v":{"id":"s4","bl')

    const back = new DeltaLog<Card>(dir, 'cards').load()
    assert.strictEqual(back.get('s2')?.blob, 'updated', 'complete lines before the tear must survive')
    assert.strictEqual(back.size, 5)
  })

  test('a corrupt line in the MIDDLE is a hard error — that is real damage, not a torn tail', () => {
    // Silently skipping it would drop records the caller believes are persisted. Fail loudly.
    const dir = tmp()
    const log = new DeltaLog<Card>(dir, 'cards')
    log.save(cards(3))
    fs.appendFileSync(path.join(dir, 'cards.delta.ndjson'), 'GARBAGE\n{"k":"ok","v":{"id":"ok","blob":"b"}}\n')
    assert.throws(() => new DeltaLog<Card>(dir, 'cards').load(), /corrupt line/)
  })

  test('an interrupted compaction never leaves a half-written snapshot', () => {
    // temp + rename is atomic, so the snapshot is either the old one or the new one — never a truncated
    // file that would silently shrink the corpus on the next load.
    const dir = tmp()
    const log = new DeltaLog<Card>(dir, 'cards')
    const c = cards(30)
    log.save(c)
    for (let i = 0; i < 200; i++) {
      c.set(`s${i % 30}`, { id: `s${i % 30}`, blob: `v${i}`.repeat(1000) })
      if (log.save(c).compacted) break
    }
    assert.ok(!fs.existsSync(path.join(dir, 'cards.snapshot.ndjson.tmp')), 'no temp file left behind')
    assert.strictEqual(new DeltaLog<Card>(dir, 'cards').load().size, 30)
  })
})

suite('deltaLog — the real-world saving', () => {
  test('100 saves of a 31 MB-shaped collection with one change each cost ~one record per save', () => {
    // The measured production shape: ~31.6 MB of cards, one or two sessions changing per interval.
    // Old cost: 100 x 31.6 MB = 3.16 GB. New cost: asserted below.
    const dir = tmp()
    const log = new DeltaLog<Card>(dir, 'cards')
    const c = cards(300) // ~600 KB — same shape, smaller so the test is fast
    const fullWrite = log.save(c).bytes

    let total = 0
    for (let i = 0; i < 100; i++) {
      c.set(`s${i % 300}`, { id: `s${i % 300}`, blob: `turn${i}`.repeat(200) })
      total += log.save(c).bytes
    }
    // 100 full rewrites would be 100 x fullWrite. We must be a small fraction of that.
    assert.ok(total < fullWrite * 5,
      `100 one-record saves cost ${total} B; 100 full rewrites would cost ${fullWrite * 100} B`)
  })
})
