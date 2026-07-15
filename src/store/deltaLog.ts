// Log-structured delta persistence (TRDD-K3WDPR7M Phase 4) — stop rewriting whole files to record a
// few KB of change.
//
// THE PROBLEM, VERIFIED FROM THE CODE AND THE DISK (not from memory):
//   log-sessions.json  31.6 MB rewritten every 300 s  =>  6.3 MB/min
//   log-offsets.json    3.1 MB rewritten every  60 s  =>  3.1 MB/min
// ~9.4 MB/min of device writes, forever, to persist a handful of changed records. On an SSD that is
// pure wear: the same blocks, rewritten thousands of times a day.
//
// THE FIX: append only what CHANGED, and rebuild state as snapshot + replayed deltas. A turn that
// touches one session appends a few hundred bytes instead of 31.6 MB.
//
// WHY NOT JUST TRACK DIRTY FLAGS UPSTREAM: the server only knows "something changed" (one boolean for
// the entire card collection), and threading per-record dirty tracking through every mutation site is
// exactly the kind of invariant that silently rots — one missed mutation and a card is never persisted
// again, which is a data-loss bug you would not notice for weeks. Hashing each record's serialized
// form is O(size) CPU but ZERO extra device writes, and it CANNOT miss a change: what is written is
// derived from what is actually there, not from a flag someone remembered to set.
import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'

/** Compact when the delta log grows past this multiple of the snapshot — bounded replay cost on load,
 *  while still amortizing the (expensive) full rewrite over many cheap appends. */
export const COMPACT_RATIO = 1.0
/** ...but always allow a small delta before compacting, so a tiny snapshot doesn't force a rewrite on
 *  every single append (a 2 KB snapshot with a 2 KB delta would otherwise compact constantly). */
export const COMPACT_MIN_BYTES = 256 * 1024

export interface SaveResult {
  /** Records appended (changed or new) this save. */
  appended: number
  /** Tombstones appended for records that disappeared. */
  deleted: number
  /** Bytes actually written to the device — the number that matters. */
  bytes: number
  compacted: boolean
}

interface Line<T> { k: string; v?: T; d?: 1 }

function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

/**
 * A keyed record collection persisted as `<name>.snapshot.ndjson` + `<name>.delta.ndjson`.
 *
 * Durability: an append is a single `appendFileSync` of complete lines. A crash mid-append can leave a
 * TRAILING PARTIAL LINE, so load() drops a final unparseable line rather than throwing — losing the
 * last few hundred bytes of a delta is recoverable (the record is re-derived and re-appended on the
 * next save), whereas refusing to start because of it would strand the whole corpus.
 */
export class DeltaLog<T> {
  private readonly snapshotPath: string
  private readonly deltaPath: string
  /** key -> sha of the last SERIALIZED form we persisted. This is what makes a save a no-op when
   *  nothing changed — without it we would re-append every record every interval and gain nothing. */
  private written = new Map<string, string>()

  constructor(dir: string, name: string) {
    this.snapshotPath = path.join(dir, `${name}.snapshot.ndjson`)
    this.deltaPath = path.join(dir, `${name}.delta.ndjson`)
  }

  /** Read NDJSON, skipping blank lines and tolerating ONE trailing partial line (a torn append). */
  private readLines(file: string): Array<Line<T>> {
    let raw: string
    try { raw = fs.readFileSync(file, 'utf8') } catch { return [] }
    const lines = raw.split('\n')
    const out: Array<Line<T>> = []
    for (const [i, ln] of lines.entries()) {
      if (ln.trim() === '') continue
      try {
        out.push(JSON.parse(ln) as Line<T>)
      } catch {
        // Only the LAST line may be torn (an append is atomic per write, and a crash can only cut the
        // final one). A corrupt line anywhere else means real damage — say so instead of silently
        // dropping records the caller believes are persisted.
        if (i === lines.length - 1 || lines.slice(i + 1).every((l) => l.trim() === '')) break
        throw new Error(`${file}: corrupt line ${i + 1} (not a torn tail — the file is damaged)`)
      }
    }
    return out
  }

  /** Replay NDJSON files in order into a fresh map — the ONE definition of "how lines become state",
   *  shared by load() and compaction's verify so there is never a second, drifting parser. Later lines
   *  win; a tombstone (d:1) deletes. */
  private replay(files: string[]): Map<string, T> {
    const map = new Map<string, T>()
    for (const file of files) {
      for (const l of this.readLines(file)) {
        if (l.d === 1) map.delete(l.k)
        else if (l.v !== undefined) map.set(l.k, l.v)
      }
    }
    return map
  }

  /** Snapshot, then deltas replayed in order. Later lines win; tombstones delete. */
  load(): Map<string, T> {
    const map = this.replay([this.snapshotPath, this.deltaPath])

    // Seed the written-hashes from what we just loaded, or the first save after a restart would
    // re-append every record (turning a restart into a full 31.6 MB rewrite — the very thing we are
    // removing).
    this.written = new Map([...map].map(([k, v]) => [k, sha(JSON.stringify(v))]))
    return map
  }

  private sizeOf(file: string): number {
    try { return fs.statSync(file).size } catch { return 0 }
  }

  /** Test seam: called after the candidate snapshot bytes are written to `path` and BEFORE they are
   *  verified. Production no-op. A test overrides it to simulate a silently corrupted/truncated
   *  snapshot write and prove compaction's verify catches it and KEEPS the delta (TRDD-K3WDPR7M). */
  protected onSnapshotWritten(_path: string): void { /* no-op in production */ }

  /** Rewrite the snapshot from `records`, VERIFY it from disk, then drop the delta. The ONE expensive
   *  write — amortized. */
  private compact(records: Map<string, T>): number {
    let body = ''
    for (const [k, v] of records) body += JSON.stringify({ k, v }) + '\n'
    // temp + rename: a crash mid-compaction must never leave a half-written snapshot, which would
    // silently truncate the corpus on the next load.
    const tmp = `${this.snapshotPath}.tmp`
    fs.writeFileSync(tmp, body)
    this.onSnapshotWritten(tmp)

    // TRDD-K3WDPR7M (2026-07-15 USER directive: a source file may be deleted ONLY after the durable
    // destination is confirmed to hold ALL its data). The delta is the ONLY other copy of every change
    // it holds; a silently truncated/short snapshot write (disk full, fs bug) followed by rmSync would
    // destroy those records forever. So PROVE the snapshot before committing to it: read the candidate
    // BACK FROM DISK (not in-memory state — the whole point is to catch a bad write) and confirm it
    // reproduces EXACTLY the saved record set (count + every per-record hash). Verify the temp file
    // BEFORE the rename, so a failure leaves the OLD snapshot AND the delta fully intact — nothing is
    // committed, nothing is lost — and surface the fault per this file's fail-fast convention (throw,
    // exactly as readLines() throws on a corrupt mid-file line).
    const reloaded = this.replay([tmp])
    const expected = new Map<string, string>()
    for (const [k, v] of records) expected.set(k, sha(JSON.stringify(v)))
    let mismatch: string | null = null
    if (reloaded.size !== expected.size) {
      mismatch = `holds ${reloaded.size} records, expected ${expected.size}`
    } else {
      for (const [k, want] of expected) {
        const got = reloaded.get(k)
        if (got === undefined || sha(JSON.stringify(got)) !== want) {
          mismatch = `record ${JSON.stringify(k)} is not durable in the snapshot`
          break
        }
      }
    }
    if (mismatch !== null) {
      try { fs.rmSync(tmp, { force: true }) } catch { /* discard the bad candidate */ }
      throw new Error(`${this.snapshotPath}: compaction verify failed (${mismatch}); delta KEPT, snapshot NOT replaced — no records lost`)
    }

    fs.renameSync(tmp, this.snapshotPath)
    // Only AFTER the snapshot is durable AND verified — deleting the delta any earlier would lose every
    // change it holds if the rename never happened or the write was short.
    try { fs.rmSync(this.deltaPath, { force: true }) } catch { /* nothing to drop */ }
    return Buffer.byteLength(body)
  }

  /**
   * Persist `records`, writing ONLY what changed. Returns what it actually cost the device.
   *
   * Nothing changed ⇒ ZERO bytes written. That is the point: the current code writes 31.6 MB every
   * 5 minutes whether or not anything happened.
   */
  save(records: Map<string, T>): SaveResult {
    fs.mkdirSync(path.dirname(this.snapshotPath), { recursive: true })

    let body = ''
    let appended = 0
    let deleted = 0
    for (const [k, v] of records) {
      const json = JSON.stringify(v)
      if (this.written.get(k) === sha(json)) continue // unchanged — the whole saving
      body += JSON.stringify({ k, v }) + '\n'
      this.written.set(k, sha(json))
      appended++
    }
    for (const k of [...this.written.keys()]) {
      if (records.has(k)) continue
      body += JSON.stringify({ k, d: 1 }) + '\n' // tombstone: the record is gone
      this.written.delete(k)
      deleted++
    }
    if (body === '') return { appended: 0, deleted: 0, bytes: 0, compacted: false }

    const snapBytes = this.sizeOf(this.snapshotPath)
    const deltaBytes = this.sizeOf(this.deltaPath) + Buffer.byteLength(body)
    if (deltaBytes > COMPACT_MIN_BYTES && deltaBytes > snapBytes * COMPACT_RATIO) {
      return { appended, deleted, bytes: this.compact(records), compacted: true }
    }
    fs.appendFileSync(this.deltaPath, body)
    return { appended, deleted, bytes: Buffer.byteLength(body), compacted: false }
  }

  /** Total bytes on disk (both files) — for the persist stats the dashboard shows. */
  diskBytes(): number {
    return this.sizeOf(this.snapshotPath) + this.sizeOf(this.deltaPath)
  }
}
