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
import { BLOBS_DIR, BODIES_DIR, PARTS_DIR, flushDetailed, Store } from './db'
import { ingestBody } from './bodyStore'
import { verifyBodiesInStore } from './verifyInStore'

/** How many bodies are held in memory at once inside a settle. The batch itself may be 200 files,
 *  but reading all of their raws up front is ~176 MB at the measured ~881 KB average — a per-settle
 *  RSS spike that stacks on the off-heap DuckDB arena already implicated in the server's external
 *  SIGKILLs (review finding: the chunking in verifyInStore bounded only the DuckDB result set,
 *  never this source-side copy). 32 keeps the round-trip win (200/32 ≈ 7 verify calls ≈ 14 round
 *  trips, vs ~400 pre-P0) at ~3% of the memory. */
export const SETTLE_READ_CHUNK = 32

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
  /** Names PERMANENTLY parked because the store's row disagrees with the file on capture-ts while
   *  the BYTES are proven identical. Re-ingesting cannot repair that row (dedup on (bodyId,
   *  srcName) is a no-op that never updates ts), so without this set the file oscillates forever:
   *  verify-fail → drop from skipNames → re-ingest no-op → verify-fail — every 60 s, at full read
   *  cost, spamming `failed` (review finding: the durable-reclaim livelock). A stranded name is
   *  skipped with ZERO I/O and reported once via `strandedTs`; the file is deliberately KEPT — its
   *  mtime is the only true capture record the wrong store row cannot replace. Pass a long-lived
   *  set (the server does) or each process re-detects them once. */
  strandedNames?: Set<string>
  /** TRDD-P8JGIEOG: durable directory to RELOCATE parked (stranded) files into. A parked file is
   *  correct to skip but wrong to leave on the RAM spool forever — a bulk wrong-ts event pins the
   *  fixed-size spool below the backpressure floor with no reclaim path, and RAM capture silently
   *  dies. Set this on VOLATILE-source passes only (the server points it at the legacy SSD bodies
   *  dir); leave unset when the source is already durable — relocating durable→durable is churn. */
  relocateStrandedTo?: string
  /** Part files already fsynced by this PROCESS. The durable barrier must cover every part that
   *  holds a batch body's bytes — a reclaimed body's parts were flushed in an EARLIER settle (or an
   *  earlier boot) and `flushed.partPaths` never names them (review finding: the barrier covered
   *  only freshly-flushed parts, so durable sources were unlinked on a page-cache proof). With the
   *  cache, each part file is fsynced once per process; without it, once per pass — correct either
   *  way, just cheaper with. */
  fsyncedPartsCache?: Set<string>
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
  /** Of `deleted`, how many were RE-EMITTED bodies: bytes proven bit-exact, but the file's mtime has
   *  moved away from the row's capture ts (TRDD-6SPXOV0P). OPTIONAL because only the Rust engine
   *  emits it — this interface also types `alstore pass`'s JSON (see src/rustStorePass.ts), and the
   *  TS pass is not gaining the behaviour: it is being deleted with the rest of the TS core
   *  (TRDD-DMWOBWFH, USER decision 2026-08-27). An older sidecar omits it too, so read it as
   *  `?? 0` — `undefined` in a running total silently becomes NaN. */
  reclaimedReemitted?: number
  /** Files that could NOT be verified. They are NOT deleted, and they are named. */
  failed: string[]
  /** Names newly parked this pass because the store's ts row is wrong while the bytes are proven —
   *  kept on disk, excluded from every future pass (see strandedNames). Reported so the condition
   *  is visible instead of recurring silently or livelocking loudly. */
  strandedTs: string[]
  /** Of the ALREADY-parked names, how many this pass relocated off the volatile spool into
   *  `relocateStrandedTo` (destination proven byte-identical + fsynced BEFORE the spool copy was
   *  unlinked; name and mtime preserved). Their bytes count in bytesFreed — spool capacity is
   *  what the relocation exists to reclaim (TRDD-P8JGIEOG). */
  strandedRelocated: number
  /** True when the byte budget stopped the pass early (more remains for the next one). */
  throttled: boolean
}

export const DEFAULT_MAX_BYTES_PER_PASS = 512 * 1024 * 1024 // 512 MB
export const DEFAULT_BATCH = 200

/** TRDD-P8JGIEOG: move one parked file to the durable dir. Verify-before-unlink, mtime preserved.
 *  Throws on anything unprovable; the caller keeps the spool copy in that case. */
function relocateStrandedFile(
  f: { p: string; name: string; mtime: number },
  destDir: string,
  readFile: (p: string) => string,
  fsyncPath: (p: string) => void,
): void {
  const dst = path.join(destDir, f.name)
  const raw = readFile(f.p)
  if (fs.existsSync(dst)) {
    // Same name already durable: only proven-identical bytes may stand in for the spool copy.
    // Different bytes = a genuine collision — keep both, never overwrite either.
    if (readFile(dst) !== raw) throw new Error('destination exists with different bytes')
  } else {
    fs.mkdirSync(destDir, { recursive: true })
    const tmp = `${dst}.reloc.tmp`
    fs.writeFileSync(tmp, raw)
    // The mtime IS the capture record (the store's ts row being wrong is WHY the file is parked) —
    // it must survive the move byte-for-byte and second-for-second.
    fs.utimesSync(tmp, f.mtime / 1000, f.mtime / 1000)
    fs.renameSync(tmp, dst)
    if (readFile(dst) !== raw) {
      try { fs.unlinkSync(dst) } catch { /* keep the spool copy either way */ }
      throw new Error('destination verify mismatch after copy')
    }
    fsyncPath(dst) // prove the bytes reached the drive before the volatile copy goes away
  }
  fs.unlinkSync(f.p)
}

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
      try {
        fs.fsyncSync(fd)
      } catch (e) {
        // A DIRECTORY fsync is a POSIX durability nicety that Windows cannot do at all — fsync on a
        // directory handle fails there (EISDIR/EPERM/EBADF depending on the layer), and treating
        // that as fatal aborted every settle after the flush but before ANY delete, so reclaim
        // never progressed (review finding). Swallow it for directories only: the FILE fsyncs are
        // the durability claim and a failed one must still propagate — an unlink gated on an fsync
        // that silently failed would be the page-cache hole reopened.
        let isDir = false
        try { isDir = fs.fstatSync(fd).isDirectory() } catch { /* the throw below stands */ }
        if (!isDir) throw e
      } finally { fs.closeSync(fd) }
    },
    skipNames,
    strandedNames,
    relocateStrandedTo,
    fsyncedPartsCache,
  } = opts

  const res: IngestPassResult = { ingested: 0, deleted: 0, reclaimedDurable: 0, bytesFreed: 0, bytesIn: 0, bytesStored: 0, failed: [], strandedTs: [], strandedRelocated: 0, throttled: false }
  // ponytail: per-pass circuit breaker on stranded relocation. A directory-level failure (dest
  // unwritable, disk full) would otherwise retry a COPY per parked file per pass — on a bulk park
  // that is the read-cost livelock reappearing in a new shape. 3 strikes → stop for this pass;
  // the next pass retries (a transient failure heals, a permanent one costs 3 attempts/pass).
  let relocateFailures = 0
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
    if (durableSource) {
      // The barrier must cover EVERY part that can hold a batch body's bytes, not only this
      // settle's fresh parts: a reclaimed already-durable body was flushed in an EARLIER settle (or
      // an earlier boot), so `flushed.partPaths` never names its parts — and unlinking a durable
      // source gated on a read-back of never-fsynced parts is the page-cache hole this barrier
      // exists to close (review finding on KB17X5G2-P0.5). Walk all three part dirs; the process-
      // lifetime cache makes the steady-state cost one fsync per NEW part file, and an fsync of an
      // already-clean file is nearly free besides.
      try {
        const dirs = new Set<string>()
        for (const sub of [BLOBS_DIR, BODIES_DIR, PARTS_DIR]) {
          const d = path.join(store.dir, sub)
          let names: string[] = []
          try { names = fs.readdirSync(d) } catch { continue }
          let any = false
          for (const n of names) {
            if (!n.endsWith('.parquet')) continue
            const p = path.join(d, n)
            if (fsyncedPartsCache?.has(p)) continue
            fsyncPath(p)
            fsyncedPartsCache?.add(p)
            any = true
          }
          // The directory entries themselves (new part files) also need a sync, or a crash can
          // leave a file's data on disk but the directory entry pointing at it lost.
          if (any || flushed.partPaths.some((p) => path.dirname(p) === d)) dirs.add(d)
        }
        for (const d of dirs) fsyncPath(d)
      } catch (e) {
        // No proven barrier ⇒ no deletes for this batch — but the PASS continues (review finding:
        // one thrown barrier error used to abort the entire pass before any reclaim). The files
        // stay, named, and the next settle retries.
        for (const b of batch) res.failed.push(`${b.name}: fsync barrier failed — kept (${(e as Error).message})`)
        batch = []
        return
      }
    }

    // (3) The universal delete gate (USER directive 2026-07-15): the DURABLE store must hold the
    // source's exact bytes AND its (src_name, capture-ts) row. Byte-identity alone once passed a
    // backfill that stamped 100k bodies with the wrong time — metadata is data too. Batched
    // (verifyBodiesInStore) for the round-trip win (KB17X5G2-P0), but read+verified in CHUNKS of
    // SETTLE_READ_CHUNK: reading all ~200 raws up front held ~176 MB of source copies for the whole
    // settle (review finding), and a verify throw used to abort the entire pass — now it costs one
    // chunk its verify, named, and the rest of the batch still settles.
    for (let ci = 0; ci < batch.length; ci += SETTLE_READ_CHUNK) {
      const chunkItems: Array<{ b: BatchItem; raw: string }> = []
      for (const b of batch.slice(ci, ci + SETTLE_READ_CHUNK)) {
        try {
          chunkItems.push({ b, raw: readFile(b.p) })
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue
          res.failed.push(`${b.name}: ${(e as Error).message}`)
        }
      }
      if (chunkItems.length === 0) continue

      let results: Awaited<ReturnType<typeof verifyBodiesInStore>>
      try {
        results = await verifyBodiesInStore(store, chunkItems.map(({ b, raw }) => ({ srcName: b.name, raw, tsMs: b.mtime })))
      } catch (e) {
        // Per-chunk isolation: a store/query error costs THIS chunk its verify (files kept, named)
        // — never the rest of the batch, never the rest of the pass (review finding: the old
        // per-file catch was lost in the P0 batching, so one corrupt part aborted every drain).
        for (const { b } of chunkItems) res.failed.push(`${b.name}: verify errored — kept (${(e as Error).message})`)
        continue
      }

      for (const { b } of chunkItems) {
        const v = results.get(b.name) ?? { ok: false, reason: `${b.name}: missing verify result` }
        try {
          if (!v.ok) {
            const reason = v.reason ?? b.name
            // A durable-named file failing ONLY on capture-ts is a livelock, not a repair case:
            // the bytes are proven (same body_id), and re-ingesting is a dedup no-op that can never
            // update the stored ts — so dropping the skip-name would re-read, re-hash and re-fail
            // it every pass forever (review finding). Park it: zero I/O from the next pass on,
            // reported once, file KEPT — its mtime is the only true capture record.
            if (b.durable && /stored ts .* != capture time/.test(reason)) {
              strandedNames?.add(b.name)
              res.strandedTs.push(b.name)
              res.failed.push(reason)
              continue
            }
            res.failed.push(reason)
            // A byte mismatch DOES converge through re-ingest (different bytes = different body_id
            // = a genuinely new row with the correct ts), so that path keeps the original repair.
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
          // A file that VANISHED between the read above and this unlink is not a verification
          // failure — it is simply gone, and the ingest path has always treated that as fine.
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue
          // Any other doubt ⇒ keep the file. A body we cannot prove we can return is a body we
          // have no right to delete.
          res.failed.push(`${b.name}: ${(e as Error).message}`)
        }
      }
    }
    batch = []
  }

  for (const f of all) {
    if (res.bytesIn + f.size > maxBytesPerPass && res.bytesIn > 0) { res.throttled = true; break }

    // Parked by an earlier pass: the store's ts row is wrong while the bytes are proven, and no
    // amount of re-ingesting can repair that row. Zero I/O — reading it again would be the livelock.
    // TRDD-P8JGIEOG: when the pass has a durable relocation target, move the parked file there
    // ONCE — name + mtime preserved (the mtime is the only true capture record), destination proven
    // byte-identical and fsynced BEFORE the spool copy is unlinked (the settleBatch delete-gate
    // discipline: never delete unproven bytes). After the move the file leaves this dir's listing,
    // so every later pass is back to zero I/O here, and the SHARED strandedNames set keeps the
    // legacy-dir drain skipping it at its new home. A failed relocation keeps the spool copy and
    // the park — the livelock fix must survive the move failing.
    if (strandedNames?.has(f.name)) {
      if (relocateStrandedTo && relocateFailures < 3) {
        try {
          relocateStrandedFile(f, relocateStrandedTo, readFile, fsyncPath)
          res.strandedRelocated++
          res.bytesFreed += f.size
        } catch (e) {
          relocateFailures++
          res.failed.push(`${f.name}: stranded relocate failed — kept on spool (${(e as Error).message})`)
        }
      }
      continue
    }

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
