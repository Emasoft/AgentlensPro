// Verify a whole .wad archive volume against the durable store (TRDD-K3WDPR7M, USER directive
// 2026-07-15) — THE gate that authorizes deleting a volume. Every lump is decompressed from the
// volume, hashed, reconstructed from the store, and byte-compared, AND its (src_name, capture-ts)
// row must match the .idx mtime. Deleting 16 GB of history is irreversible; nothing cheaper than
// per-lump proof earns it.
//
// Used by: the retention purge (a volume ageing past the window), the explicit purge endpoint, and
// the one-off .wad reclamation runner. One implementation so the bar cannot quietly differ by path.
import * as path from 'path'
import * as fs from 'fs'
import { listArchiveEntries, readArchiveEntry } from '../bodyArchive'
import { Store } from './db'
import { verifyBodyInStore } from './verifyInStore'

export interface VolumeVerifyResult {
  /** True ONLY when the volume has a readable index, at least one entry, and EVERY entry verified. */
  ok: boolean
  entries: number
  verified: number
  /** Every entry that could not be proven, named with the reason. NOT ok while non-empty. */
  failed: string[]
}

/**
 * Prove the store fully holds one archive volume. Fail-safe by construction:
 *  - no .idx / empty .idx while the volume has bytes -> NOT verifiable -> ok=false (a volume we
 *    cannot enumerate is a volume we cannot prove, so it must not be deleted);
 *  - any lump that fails bytes/row/ts verification -> ok=false, entry named.
 */
export async function verifyVolumeInStore(
  store: Store,
  archiveDir: string,
  volumeName: string,
  opts: { onProgress?: (p: { done: number; total: number; failed: number }) => void } = {},
): Promise<VolumeVerifyResult> {
  const volumePath = path.join(archiveDir, volumeName)
  const entries = listArchiveEntries(archiveDir).filter((e) => e.volume === volumePath)
  const res: VolumeVerifyResult = { ok: false, entries: entries.length, verified: 0, failed: [] }

  if (entries.length === 0) {
    let bytes = 0
    try { bytes = fs.statSync(volumePath).size } catch { /* volume gone — nothing to verify */ }
    res.failed.push(bytes > 0
      ? `${volumeName}: has ${bytes} bytes but no readable index entries — unverifiable, refusing to bless`
      : `${volumeName}: no such volume / empty`)
    return res
  }

  let done = 0
  for (const e of entries) {
    try {
      const raw = readArchiveEntry(e).toString('utf8')
      const v = await verifyBodyInStore(store, e.name, raw, e.mtimeMs)
      if (v.ok) res.verified++
      else res.failed.push(v.reason ?? e.name)
    } catch (err) {
      res.failed.push(`${e.name}: unreadable lump (${(err as Error).message})`)
    }
    done++
    if (opts.onProgress && done % 250 === 0) opts.onProgress({ done, total: entries.length, failed: res.failed.length })
    // A volume holds tens of thousands of lumps — never starve the event loop for minutes.
    await new Promise((r) => setImmediate(r))
  }
  opts.onProgress?.({ done, total: entries.length, failed: res.failed.length })

  res.ok = res.failed.length === 0 && res.verified === res.entries
  return res
}
