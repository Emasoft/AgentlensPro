import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { DeltaLog } from '../store/deltaLog'

// ── DeltaLog compaction: verify-before-delete (TRDD-K3WDPR7M, 2026-07-15 USER directive) ───────────
// compact() rewrites the snapshot then drops the delta — the delta being the ONLY other copy of the
// changes it holds. Before rmSync, compact() now reads the just-written snapshot BACK FROM DISK and
// proves it reproduces exactly the saved record set (count + every per-record hash). These tests drive
// the real class against a real tmpdir: (1) a good compaction verifies and drops the delta; (2) a
// silently corrupted snapshot write is caught, the delta is KEPT, and the fault is surfaced.

interface Card { id: string; blob: string }

let seq = 0
function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), `agentlens-deltaverify-${process.pid}-${seq++}-`)) }

/** A collection shaped like the real one: many cards, each a few KB, so churn forces a compaction. */
function cards(n: number, mark = 'a'): Map<string, Card> {
  const m = new Map<string, Card>()
  for (let i = 0; i < n; i++) m.set(`s${i}`, { id: `s${i}`, blob: `${mark}`.repeat(2000) })
  return m
}

/** Subclass with a seam that simulates a silently corrupted snapshot WRITE (valid NDJSON, but the
 *  WRONG record set), firing only on the compaction snapshot write and only when armed. */
class SabotageDeltaLog<T> extends DeltaLog<T> {
  sabotage = false
  protected onSnapshotWritten(p: string): void {
    if (this.sabotage) fs.writeFileSync(p, '{"k":"__bogus__","v":{"id":"__bogus__","blob":"x"}}\n')
  }
}

suite('deltaLog compaction verify — a good compaction verifies and drops the delta (TRDD-K3WDPR7M)', () => {
  test('a verified compaction folds the delta into the snapshot and loses nothing', () => {
    const dir = tmp()
    const log = new DeltaLog<Card>(dir, 'cards')
    const c = cards(30)
    log.save(c)

    let compacted = false
    for (let i = 0; i < 300 && !compacted; i++) {
      c.set(`s${i % 30}`, { id: `s${i % 30}`, blob: `v${i}`.repeat(1000) })
      compacted = log.save(c).compacted
    }
    assert.ok(compacted, 'the churn must trigger a compaction (or the verify path is never exercised)')
    assert.ok(fs.existsSync(path.join(dir, 'cards.snapshot.ndjson')), 'the verified snapshot is committed')
    assert.ok(!fs.existsSync(path.join(dir, 'cards.delta.ndjson')), 'a VERIFIED compaction drops the delta')
    assert.ok(!fs.existsSync(path.join(dir, 'cards.snapshot.ndjson.tmp')), 'no temp candidate left behind')

    const back = new DeltaLog<Card>(dir, 'cards').load()
    assert.deepStrictEqual([...back.entries()].sort(), [...c.entries()].sort(), 'every record survives the verified compaction')
  })
})

suite('deltaLog compaction verify — a corrupted snapshot keeps the delta and surfaces the fault (TRDD-K3WDPR7M)', () => {
  test('a sabotaged snapshot write is caught: the delta is KEPT, the snapshot is NOT replaced, and an error is thrown', () => {
    const dir = tmp()
    const log = new SabotageDeltaLog<Card>(dir, 'cards')
    const c = cards(30)
    log.save(c) // first save appends to the delta; no snapshot exists yet

    log.sabotage = true
    let err: Error | null = null
    try {
      for (let i = 0; i < 500; i++) {
        c.set(`s${i % 30}`, { id: `s${i % 30}`, blob: `v${i}`.repeat(1000) })
        log.save(c) // eventually compacts → sabotaged candidate → verify fails → throws
      }
    } catch (e) { err = e as Error }

    assert.ok(err, 'a sabotaged compaction must surface an error, never silently proceed to rmSync')
    assert.match(err!.message, /compaction verify failed/, 'the error names the verify failure')
    // The delta is the ONLY other copy of the accumulated changes — it must NOT have been dropped.
    assert.ok(fs.existsSync(path.join(dir, 'cards.delta.ndjson')), 'the delta is KEPT when the snapshot verify fails')
    // The bogus candidate was never renamed into place (nothing committed), and its temp is discarded.
    assert.ok(!fs.existsSync(path.join(dir, 'cards.snapshot.ndjson')), 'the corrupt candidate is NOT committed as the snapshot')
    assert.ok(!fs.existsSync(path.join(dir, 'cards.snapshot.ndjson.tmp')), 'the bad candidate is discarded, not left behind')

    // Every previously-persisted record reloads intact from the kept delta — no records lost.
    const back = new DeltaLog<Card>(dir, 'cards').load()
    assert.strictEqual(back.size, 30, 'all 30 previously-persisted records survive the aborted compaction')
  })
})
