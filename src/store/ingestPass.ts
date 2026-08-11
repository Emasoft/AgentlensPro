// Ingest raw bodies into the store and reclaim their disk space (TRDD-K3WDPR7M Phase 3/5).
//
// THIS FUNCTION DELETES THE USER'S FILES, so the ordering below is the entire point and must not be
// "simplified":
//
//   1. ingest   — sectioned, content-addressed; ingestBody() already refuses anything that does not
//                 reconstruct byte-identically, so a body that cannot be restored is never stored.
//   2. FLUSH    — the spans reach an immutable Parquet part on disk. Until this returns, everything
//                 lives only in RAM. When `durableSource` is set (the source itself was already
//                 durable — the legacy SSD dir, never the volatile RAM spool), the part files and
//                 their directories are also fsync'd here before anything is deleted — a flushed part
//                 is "on disk" from the OS's point of view the moment write() returns; fsync is what
//                 asks the OS to actually push it out of its buffers (KB17X5G2-P0.5). This is NOT a
//                 guarantee against a drive with a volatile write cache losing power mid-write —
//                 Node's fs.constants.F_FULLFSYNC is false, so it cannot force that — just a real step
//                 up from never asking at all.
//   3. re-verify— reconstruct each body FROM THE FLUSHED STORE and compare sha256 against the file's
//                 own bytes. Step 1's check proves the sectioner is sound; only THIS proves the bytes
//                 actually survived the round trip through DuckDB and Parquet. Batched across the
//                 whole settling group (verifyBodiesInStore) rather than one-round-trip-per-file — the
//                 fix for the drain-rate inequality that dropped bodies (KB17X5G2-P0).
//   4. delete   — and only now.
//
// A crash at any point loses at most the un-flushed batch, and the source files are still there.
// Deleting before the flush would trade a 22 GB disk problem for an unrecoverable data-loss one.
//
// IT IS ALSO THROTTLED. The archiver this replaces ran an unbounded pass on every server boot and was
// measured at 694 MB/min of device writes — it turned "restart the server" into a disk-punishing
// event. A pass now has a hard byte budget and simply stops when it is spent.
import * as fs from 'fs'
import * as path from 'path'
import { flushDetailed, Store } from './db'
import { ingestBody } from './bodyStore'
import { verifyBodiesInStore } from './verifyInStore'

export interface IngestPassOptions {
  bodiesDir: string
  store: Store
  /** Leave bodies newer than this alone (the live window stays as plain files). 0 = ingest everything. */
  maxAgeMs?: number
  /** Hard ceiling on source bytes consumed per pass. THE THROTTLE — do not remove it. */
  maxBytesPerPass?: number
  /** Verify + delete the source. Off = ingest only (used to prove a backfill before committing to it). */
  deleteAfter?: boolean
  /** Bodies ingested+verified per flush. Bounds both RAM and how much a crash can cost. */
  batchSize?: number
  onProgress?: (p: { done: number; total: number; bytesIn: number; bytesStored: number }) => void
  /** Seam for reading a source file. Exists so the delete-gating verify can be tested against a
   *  source that does NOT match the store — the single most important failure mode in this file, and
   *  one that cannot otherwise be provoked (fs.readFileSync is a getter-only property in modern Node
   *  and cannot be stubbed). Defaults to the real read. */
  readFile?: (p: string) => string
  /** Whether the SOURCE files this pass drains are already durable on their own (the legacy SSD dir)
   *  as opposed to volatile (the RAM spool). When true, settleBatch fsyncs the flush's part files (and
   *  their directories) BEFORE unlinking sources — otherwise the delete gate's "durable" claim rests
   *  on a page-cache read-back, not a proof the bytes reached the drive (KB17X5G2-P0.5). RAM-spool
   *  sources skip the barrier: the source was volatile anyway, so there is nothing extra to lose.
   *  Default false (the safer default: no barrier is skipped only when the caller opts in). */
  durableSource?: boolean
  /** Seam for the fsync barrier. Same reason as `readFile`: `fs.fsyncSync` cannot be stubbed directly
   *  (TS's `import * as fs` copies it onto the module namespace as a getter-only accessor, so
   *  reassigning `fs.fsyncSync` throws "has only a getter" — verified). Defaults to the real
   *  open+fsync+close on the given path. */
  fsyncPath?: (p: string) => void
  /** Names whose bodies are ALREADY durable, so the pass skips the re-INGEST for them — never the
   *  reclaim (TRDD-K3WDPR7M Phase 3, item 5). The server seeds it once per boot from the store's
   *  already-ingested src_name set, so a spool drain every 60s does not re-read+re-hash what it has
   *  already stored. MUTATED in place: each name is added as it is ingested, so a later pass skips it
   *  too. */
  skipNames?: Set<string>
}

export interface IngestPassResult {
  ingested: number
  deleted: number
  /** Source bytes consumed. */
  bytesIn: number
  /** Bytes actually added to the store (the marginal cost — dedup means this is far smaller). */
  bytesStored: number
  /** Of `deleted`, how many needed no re-ingest because the store already held them. Distinct from
   *  `ingested` so a pass that only reclaims cannot be mistaken for a pass that did nothing. */
  reclaimedDurable: number
  /** Source bytes actually UNLINKED. Distinct from `bytesIn` (bytes read): a pass that reads a
   *  gigabyte and verifies none of it frees nothing, and reporting the read as "freed" would show
   *  a healthy drain while the disk never moves. */
  bytesFreed: number
  /** Files that could NOT be verified. They are NOT deleted, and they are named. */
  failed: string[]
  /** True when the byte budget stopped the pass early (more remains for the next one). */
  throttled: boolean
}

export const DEFAULT_MAX_BYTES_PER_PASS = 512 * 1024 * 1024 // 512 MB
export const DEFAULT_BATCH = 200

function bodyFiles(dir: string): Array<{ p: string; name: string; mtime: number; size: number }> {
  let names: string[]
  try { names = fs.readdirSync(dir) } catch { return [] }
  const out: Array<{ p: string; name: string; mtime: number; size: number }> = []
  for (const name of names) {
    if (!name.endsWith('.request.json') && !name.endsWith('.response.json')) continue
    const p = path.join(dir, name)
    try {
      const st = fs.statSync(p)
      out.push({ p, name, mtime: st.mtimeMs, size: st.size })
    } catch { /* raced with a writer — skip it, we'll get it next pass */ }
  }
  out.sort((a, b) => a.mtime - b.mtime) // OLDEST FIRST — also the true turn order, which is what dedups
  return out
}

/**
 * Run one ingest pass. Returns what it actually did — a caller must never have to infer success from
 * the absence of an exception.
 */
export async function ingestPass(opts: IngestPassOptions): Promise<IngestPassResult> {
  const {
    bodiesDir, store,
    maxAgeMs = 0,
    maxBytesPerPass = DEFAULT_MAX_BYTES_PER_PASS,
    deleteAfter = true,
    batchSize = DEFAULT_BATCH,
    onProgress,
    readFile = (p: string) => fs.readFileSync(p, 'utf8'),
    durableSource = false,
    fsyncPath = (p: string) => {
      const fd = fs.openSync(p, 'r')
      try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    },
    skipNames,
  } = opts

  const res: IngestPassResult = { ingested: 0, deleted: 0, reclaimedDurable: 0, bytesFreed: 0, bytesIn: 0, bytesStored: 0, failed: [], throttled: false }
  const cutoff = maxAgeMs > 0 ? Date.now() - maxAgeMs : Infinity
  // The AGE gate is the only filter here. `skipNames` must NOT filter at this level: a file whose name
  // is already durable still has to reach the verify+delete gate in settleBatch(). Excluding it from
  // the pass entirely is what stranded 3,615 bodies in a full 2 GB RAM spool — never re-ingested
  // (correct) and never deleted (the bug), so a fixed-size spool fills with files the store already
  // holds until capture silently dies. The skip belongs on the INGEST, not on the reclaim.
  const all = bodyFiles(bodiesDir).filter((f) => f.mtime < cutoff)
  if (all.length === 0) return res

  // The batch currently in flight. The post-flush check re-reads the FILE, so the verification
  // compares the store against the source — not against something we derived from the same
  // in-memory object (which would prove nothing).
  type BatchItem = { p: string; name: string; mtime: number; size: number; durable?: boolean }
  let batch: BatchItem[] = []

  const settleBatch = async () => {
    if (batch.length === 0) return
    const flushed = await flushDetailed(store) // (2) the spans are now in an immutable Parquet part

    // (2.5) THE FSYNC BARRIER (KB17X5G2-P0.5, gated by source). A flushed part is only "durable" in
    // the sense that PROVES the delete gate below is safe if the bytes actually reached the drive —
    // otherwise the gate's read-back can be served from the page cache and a crash before the OS
    // flushes it loses data the source held that the store never actually got. Only worth doing when
    // the SOURCE itself was durable to begin with (the legacy SSD dir): a RAM-spool source was already
    // volatile, so skipping costs nothing extra.
    //
    // NOTE — what this does NOT prove: Node's fs.constants.F_FULLFSYNC is `false` (verified), so this
    // cannot force the drive's own write cache to media on macOS the way a real F_FULLFSYNC ioctl
    // would. fsync(2) still asks the OS to flush its buffers to the device, which is a real
    // improvement over "never asked at all" — just not a guarantee against a power-loss-mid-write on
    // a drive with a volatile write cache. Document the gap; do not claim more than this buys.
    if (durableSource && flushed.partPaths.length > 0) {
      for (const p of flushed.partPaths) fsyncPath(p)
      // The directory entries themselves (the part files are brand new) also need a sync, or a crash
      // can leave the file's data on disk but the directory entry pointing at it lost.
      for (const dir of new Set(flushed.partPaths.map((p) => path.dirname(p)))) fsyncPath(dir)
    }

    // Re-read every file's CURRENT bytes up front — same source-of-truth as before: the verify
    // compares the store against a fresh read of the file, never something derived from the batch. A
    // file that vanished mid-pass (ENOENT) is not a verification failure, exactly as before.
    const items: Array<{ b: BatchItem; raw: string }> = []
    for (const b of batch) {
      try {
        items.push({ b, raw: readFile(b.p) })
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue
        res.failed.push(`${b.name}: ${(e as Error).message}`)
      }
    }

    // (3) The universal delete gate (USER directive 2026-07-15): the DURABLE store must hold the
    // source's exact bytes AND its (src_name, capture-ts) row. Byte-identity alone once passed a
    // backfill that stamped 100k bodies with the wrong time — metadata is data too. Batched
    // (verifyBodiesInStore) instead of per-file: ~200 files/batch was ~400 DuckDB round trips and
    // could not keep up with burst inflow — the throughput fix this pass exists for (KB17X5G2-P0).
    const results = await verifyBodiesInStore(store, items.map(({ b, raw }) => ({ srcName: b.name, raw, tsMs: b.mtime })))

    for (const { b } of items) {
      const v = results.get(b.name) ?? { ok: false, reason: `${b.name}: missing verify result` }
      try {
        if (!v.ok) {
          res.failed.push(v.reason ?? b.name)
          // A durable-NAMED file whose bytes no longer match is not durable, so drop the name from
          // the skip-set: the next pass must re-INGEST the true bytes through the normal path.
          // Without this it is skipped forever (never re-ingested) AND never deleted (verify keeps
          // failing) — it occupies a fixed-size spool permanently, which is the exact
          // fills-until-capture-dies failure this pass exists to prevent.
          if (b.durable) skipNames?.delete(b.name)
          continue // NOT deleted
        }
        if (deleteAfter) {
          fs.unlinkSync(b.p) // (4) and only now
          res.deleted++
          res.bytesFreed += b.size
          if (b.durable) res.reclaimedDurable++
        }
      } catch (e) {
        // A file that VANISHED between the read above and this unlink is not a verification failure —
        // it is simply gone, and the ingest path has always treated that as fine.
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue
        // Any other doubt ⇒ keep the file. A body we cannot prove we can return is a body we have
        // no right to delete.
        res.failed.push(`${b.name}: ${(e as Error).message}`)
      }
    }
    batch = []
  }

  for (const f of all) {
    if (res.bytesIn + f.size > maxBytesPerPass && res.bytesIn > 0) { res.throttled = true; break }

    if (skipNames?.has(f.name)) {
      // Already durable: straight to the gate, no re-ingest and no re-hash — that is what the set is
      // for. settleBatch() still re-reads the file and re-proves it against the store before the
      // unlink, so a same-NAME-different-BYTES file is KEPT and named in `failed` rather than
      // deleted on the strength of its filename.
      res.bytesIn += f.size // the verify DOES read it — the throttle must see those bytes
      batch.push({ p: f.p, name: f.name, mtime: f.mtime, size: f.size, durable: true })
    } else {
      let raw: string
      try { raw = readFile(f.p) } catch { continue } // vanished mid-pass — fine

      try {
        // f.mtime = the CAPTURE time. Omitting it stamps the body with ingest time and silently breaks
        // every time-window query over the store (the first backfill's mistake).
        const r = await ingestBody(store, f.name, raw, f.mtime) // (1) refuses anything not byte-exact
        res.ingested++
        res.bytesIn += f.size
        res.bytesStored += r.newBytes
        skipNames?.add(f.name) // now durable → a later pass must not re-read+re-hash it
        batch.push({ p: f.p, name: f.name, mtime: f.mtime, size: f.size })
      } catch (e) {
        res.failed.push(`${f.name}: ${(e as Error).message}`)
        continue
      }
    }

    if (batch.length >= batchSize) {
      await settleBatch()
      onProgress?.({ done: res.ingested, total: all.length, bytesIn: res.bytesIn, bytesStored: res.bytesStored })
    }
    // Yield: a pass can chew tens of thousands of files, and a tight sync loop would starve the
    // OTLP/UI listeners for minutes (the old archiver's mistake).
    await new Promise((r) => setImmediate(r))
  }
  await settleBatch()
  onProgress?.({ done: res.ingested, total: all.length, bytesIn: res.bytesIn, bytesStored: res.bytesStored })
  return res
}
