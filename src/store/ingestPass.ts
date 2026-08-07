// Ingest raw bodies into the store and reclaim their disk space (TRDD-K3WDPR7M Phase 3/5).
//
// THIS FUNCTION DELETES THE USER'S FILES, so the ordering below is the entire point and must not be
// "simplified":
//
//   1. ingest   — sectioned, content-addressed; ingestBody() already refuses anything that does not
//                 reconstruct byte-identically, so a body that cannot be restored is never stored.
//   2. FLUSH    — the spans reach an immutable Parquet part on disk. Until this returns, everything
//                 lives only in RAM.
//   3. re-verify— reconstruct each body FROM THE FLUSHED STORE and compare sha256 against the file's
//                 own bytes. Step 1's check proves the sectioner is sound; only THIS proves the bytes
//                 actually survived the round trip through DuckDB and Parquet.
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
import { flush, Store } from './db'
import { ingestBody } from './bodyStore'
import { verifyBodyInStore } from './verifyInStore'

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
    skipNames,
  } = opts

  const res: IngestPassResult = { ingested: 0, deleted: 0, reclaimedDurable: 0, bytesIn: 0, bytesStored: 0, failed: [], throttled: false }
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
  let batch: Array<{ p: string; name: string; mtime: number; size: number; durable?: boolean }> = []

  const settleBatch = async () => {
    if (batch.length === 0) return
    await flush(store) // (2) the spans are now in an immutable Parquet part — durable

    for (const b of batch) {
      try {
        // (3) The universal delete gate (USER directive 2026-07-15): the DURABLE store must hold the
        // source's exact bytes AND its (src_name, capture-ts) row. Byte-identity alone once passed a
        // backfill that stamped 100k bodies with the wrong time — metadata is data too.
        const onDisk = readFile(b.p)
        const v = await verifyBodyInStore(store, b.name, onDisk, b.mtime)
        if (!v.ok) {
          res.failed.push(v.reason ?? b.name)
          continue // NOT deleted
        }
        if (deleteAfter) {
          fs.unlinkSync(b.p) // (4) and only now
          res.deleted++
          if (b.durable) res.reclaimedDurable++
        }
      } catch (e) {
        // Any doubt at all ⇒ keep the file. A body we cannot prove we can return is a body we have
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
