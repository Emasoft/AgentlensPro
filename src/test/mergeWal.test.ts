import * as assert from 'assert'
import { _mergeWal } from '../logReader'

// Build a synthetic SQLite WAL. _mergeWal validates magic, page size, and per-frame salts, and reads
// each frame's dbSize commit marker — it does NOT verify checksums, so those stay 0 here.
const PS = 512
const SALT1 = 0xaabbccdd
const SALT2 = 0x11223344

function walHeader(): Uint8Array {
  const h = new Uint8Array(32)
  const dv = new DataView(h.buffer)
  dv.setUint32(0, 0x377f0682) // magic
  dv.setUint32(4, 3007000)    // version
  dv.setUint32(8, PS)         // page size
  dv.setUint32(12, 1)         // checkpoint seq
  dv.setUint32(16, SALT1)
  dv.setUint32(20, SALT2)
  return h
}

// One WAL frame: 24-byte header (pgno, dbSize, salt1, salt2, cksum1, cksum2) + PS bytes of page data.
function frame(pgno: number, dbSize: number, fill: number): Uint8Array {
  const f = new Uint8Array(24 + PS)
  const dv = new DataView(f.buffer)
  dv.setUint32(0, pgno)
  dv.setUint32(4, dbSize) // non-zero ONLY on a transaction's last (commit) frame
  dv.setUint32(8, SALT1)
  dv.setUint32(12, SALT2)
  f.fill(fill, 24) // page body
  return f
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) { out.set(p, off); off += p.length }
  return out
}

suite('_mergeWal commit-boundary (S1-F6)', () => {
  test('applies committed frames but ignores a trailing uncommitted transaction', () => {
    const db = new Uint8Array(2 * PS) // two pages of zeros
    // Committed txn: frame(page1, mid) + frame(page2, COMMIT dbSize=2). Then an in-flight txn:
    // frame(page1, mid) overwriting page 1 — uncommitted, must NOT be surfaced.
    const wal = concat(
      walHeader(),
      frame(1, 0, 0x11),   // committed page 1 content
      frame(2, 2, 0x22),   // COMMIT (dbSize != 0) — closes the transaction
      frame(1, 0, 0x33),   // uncommitted overwrite of page 1 — beyond the last commit
    )
    const merged = _mergeWal(db, wal)
    assert.strictEqual(merged[0], 0x11, 'page 1 reflects the COMMITTED value, not the uncommitted 0x33')
    assert.strictEqual(merged[PS], 0x22, 'page 2 reflects the committed value')
  })

  test('a WAL with no commit frame leaves the main db untouched', () => {
    const db = new Uint8Array(PS).fill(0x99)
    // Only mid-transaction frames (dbSize 0) — nothing committed.
    const wal = concat(walHeader(), frame(1, 0, 0x55))
    const merged = _mergeWal(db, wal)
    assert.strictEqual(merged[0], 0x99, 'no committed frame → main db is the truth')
  })
})
