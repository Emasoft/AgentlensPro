// Drain the legacy .wad archive into the content-addressed store (TRDD-K3WDPR7M Phase 5).
//
// The old archiver gzipped each body into a monthly WAD volume — one gzip member per body, with NO
// cross-body dedup, so the identical 268 KB tools array and the whole re-sent transcript were stored
// again on every single turn. 16 GB of it accumulated.
//
// This reads each lump, ingests it into the store, and PROVES the round trip before the archive is
// eligible for reclamation. It NEVER deletes a volume: the .wad is the only remaining copy of that
// history, and destroying it is a separate, explicit human decision (RULE 0). The caller gets a report
// and decides.
//
// A lump that fails to verify is COUNTED AND NAMED, never skipped silently — "0 failures" has to mean
// something, and a validator that quietly drops what it cannot handle is how a corpus rots unnoticed.
import { listArchiveEntries, readArchiveEntry } from '../bodyArchive'
import { flush, Store } from './db'
import { ingestBody } from './bodyStore'
import { verifyBodyInStore } from './verifyInStore'

export interface ArchiveMigrationResult {
  entries: number
  ingested: number
  /** Lumps already in the store (a re-run costs nothing — the pass is idempotent and resumable). */
  alreadyPresent: number
  verified: number
  failed: string[]
  bytesIn: number
  bytesStored: number
}

export interface ArchiveMigrationOptions {
  archiveDir: string
  store: Store
  /** Verify every ingested lump reconstructs byte-identically from the DURABLE store. Leave it on. */
  verify?: boolean
  batchSize?: number
  limit?: number
  onProgress?: (p: { done: number; total: number; bytesIn: number; bytesStored: number; failed: number }) => void
}

export async function migrateArchiveToStore(opts: ArchiveMigrationOptions): Promise<ArchiveMigrationResult> {
  const { archiveDir, store, verify = true, batchSize = 300, limit, onProgress } = opts
  const r: ArchiveMigrationResult = {
    entries: 0, ingested: 0, alreadyPresent: 0, verified: 0, failed: [], bytesIn: 0, bytesStored: 0,
  }

  let entries = listArchiveEntries(archiveDir)
  // Oldest first — also the true turn order, which is what makes consecutive turns dedup against each
  // other instead of each looking novel.
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs)
  if (limit) entries = entries.slice(0, limit)
  r.entries = entries.length
  if (entries.length === 0) return r

  let batch: Array<{ name: string; raw: string; mtimeMs: number }> = []

  const settle = async () => {
    if (batch.length === 0) return
    await flush(store) // durable BEFORE we claim anything is verified
    if (verify) {
      for (const b of batch) {
        // The universal gate (USER directive 2026-07-15): exact bytes from the DURABLE store AND the
        // (src_name, capture-ts) row. "Verified" here is what later authorizes archive reclamation,
        // so it must mean ALL the lump's data — a byte-only check once blessed a drain that stamped
        // every lump with the wrong capture time.
        const v = await verifyBodyInStore(store, b.name, b.raw, b.mtimeMs)
        if (v.ok) r.verified++
        else r.failed.push(v.reason ?? b.name)
      }
    }
    batch = []
  }

  for (const e of entries) {
    let raw: string
    try {
      raw = readArchiveEntry(e).toString('utf8')
    } catch (err) {
      r.failed.push(`${e.name}: unreadable lump (${(err as Error).message})`)
      continue
    }
    r.bytesIn += e.size

    try {
      // e.mtimeMs is the ORIGINAL capture time, preserved by the archiver in the .idx — pass it
      // through or the store stamps the lump with today's date and time-window queries lie.
      const ing = await ingestBody(store, e.name, raw, e.mtimeMs)
      if (ing.existed) r.alreadyPresent++ // the explicit flag — newBlobs===0 also fires for a fully-deduped NEW body
      r.ingested++
      r.bytesStored += ing.newBytes
      batch.push({ name: e.name, raw, mtimeMs: e.mtimeMs })
    } catch (err) {
      r.failed.push(`${e.name}: ${(err as Error).message}`)
      continue
    }

    if (batch.length >= batchSize) {
      await settle()
      onProgress?.({ done: r.ingested, total: r.entries, bytesIn: r.bytesIn, bytesStored: r.bytesStored, failed: r.failed.length })
    }
    await new Promise((res) => setImmediate(res)) // never starve the event loop
  }
  await settle()
  onProgress?.({ done: r.ingested, total: r.entries, bytesIn: r.bytesIn, bytesStored: r.bytesStored, failed: r.failed.length })
  return r
}
