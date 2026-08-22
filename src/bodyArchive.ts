// bodyArchive — WAD-style compressed archive for OTEL raw bodies.
//
// WHY: the raw-body corpus is the forensic ground truth (cache-break diffs, burn profiles,
// heartbeat costs) and the user needs a MONTH of it for long-term diagnosis — but a month of
// live JSON files is ~45GB across ~100k files on a 98%-full disk. Deleting old bodies (the
// first retention design) destroyed evidence; keeping them raw destroys the disk. So bodies
// older than the live window are moved into monthly VOLUME files that stay randomly accessible
// — one lump per body, like a Doom WAD:
//
//   otel-bodies-archive/bodies-2026-07.wad       concatenated gzip members (the lumps)
//   otel-bodies-archive/bodies-2026-07.wad.idx   NDJSON directory: one {n,o,l,s,m} line per lump
//
// Append-only and crash-safe by construction: a lump's bytes are appended BEFORE its index
// line, so a crash between the two leaves orphan bytes (harmless — the next append derives its
// offset from the real file size) and never an index entry pointing at missing data. A
// truncated final index line is skipped on load, exactly like the NDJSON span store.
// Random access: read the idx once, then fs.read(offset, length) + gunzip — no volume scan.
// JSON bodies compress ~8-10×, so a month is ~4-5GB on disk instead of ~45GB.
import * as fs from 'fs'
import * as path from 'path'
import * as zlib from 'zlib'

export interface ArchiveEntry {
  name: string          // original filename, e.g. "<uuid>.request.json"
  offset: number        // byte offset of the gzip member inside the volume
  compressedLength: number
  size: number          // original (uncompressed) size
  mtimeMs: number       // original file mtime — preserved so time-window scans stay correct
}

export interface ArchivedBody extends ArchiveEntry {
  volume: string        // absolute path of the .wad volume holding this entry
}

const VOLUME_RE = /^bodies-(\d{4})-(\d{2})\.wad$/

function volumeNameFor(mtimeMs: number): string {
  const d = new Date(mtimeMs)
  return `bodies-${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}.wad`
}

/** Append one body to its month's volume (creating volume + index as needed). */
export function appendToArchive(archiveDir: string, name: string, data: Buffer, mtimeMs: number): void {
  fs.mkdirSync(archiveDir, { recursive: true })
  const volume = path.join(archiveDir, volumeNameFor(mtimeMs))
  const gz = zlib.gzipSync(data)
  // Offset is derived from the REAL current size, so orphan bytes from a past crash can never
  // corrupt later entries — they are simply dead space the next compaction-less append skips over.
  let offset = 0
  try { offset = fs.statSync(volume).size } catch { /* new volume */ }
  fs.appendFileSync(volume, gz)
  const line = `${JSON.stringify({ n: name, o: offset, l: gz.length, s: data.length, m: mtimeMs })}\n`
  fs.appendFileSync(`${volume}.idx`, line)
}

/** Load one volume's directory. Corrupt lines (crash-truncated tail) are skipped, never fatal. */
export function loadVolumeIndex(volumePath: string): ArchiveEntry[] {
  let raw: string
  try { raw = fs.readFileSync(`${volumePath}.idx`, 'utf-8') } catch { return [] }
  const entries: ArchiveEntry[] = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    try {
      const j = JSON.parse(line) as { n: string; o: number; l: number; s: number; m: number }
      entries.push({ name: j.n, offset: j.o, compressedLength: j.l, size: j.s, mtimeMs: j.m })
    } catch { /* truncated tail line — skip */ }
  }
  return entries
}

/** Every archived body across all volumes, oldest volume first. */
export function listArchiveEntries(archiveDir: string): ArchivedBody[] {
  let names: string[]
  try { names = fs.readdirSync(archiveDir).filter(f => VOLUME_RE.test(f)).sort() } catch { return [] }
  const out: ArchivedBody[] = []
  for (const v of names) {
    const volume = path.join(archiveDir, v)
    for (const e of loadVolumeIndex(volume)) out.push({ ...e, volume })
  }
  return out
}

/** Random-access read of one archived body (the transparent-subfolder read path). */
export function readArchiveEntry(entry: ArchivedBody): Buffer {
  const fd = fs.openSync(entry.volume, 'r')
  try {
    const buf = Buffer.alloc(entry.compressedLength)
    const got = fs.readSync(fd, buf, 0, entry.compressedLength, entry.offset)
    if (got !== entry.compressedLength) {
      throw new Error(`short read on ${path.basename(entry.volume)} at ${entry.offset}: ${got}/${entry.compressedLength}`)
    }
    return zlib.gunzipSync(buf)
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Drop whole volumes older than the retention window (a volume covers one UTC month).
 *
 * `canDelete` is the verify-before-delete gate (TRDD-K3WDPR7M, USER directive 2026-07-15): the
 * caller proves the durable store holds EVERY lump of the volume before the volume is destroyed.
 * A volume the gate does not bless is KEPT and reported in `kept` — ageing out is never, on its
 * own, a reason to destroy data that might exist nowhere else. Callers without a store (tests,
 * legacy tooling) must pass an explicit gate; there is deliberately NO default-allow.
 *
 * The `.idx` sidecar is KEPT even when the volume is deleted: it is ~0.05% of the volume's size
 * and is the only remaining record of each lump's capture time (provenance the ts-recovery
 * migration feeds on).
 */
export async function purgeArchiveVolumes(
  archiveDir: string,
  olderThanDays: number,
  canDelete: (volumeName: string) => Promise<boolean>,
): Promise<{ removed: string[]; kept: string[]; freedBytes: number }> {
  const cutoff = Date.now() - olderThanDays * 86400e3
  const removed: string[] = []
  const kept: string[] = []
  let freedBytes = 0
  let names: string[]
  try { names = fs.readdirSync(archiveDir).filter(f => VOLUME_RE.test(f)) } catch { return { removed, kept, freedBytes } }
  for (const v of names) {
    const m = VOLUME_RE.exec(v)!
    // A volume is purgeable only when its whole month ended before the cutoff.
    const monthEnd = Date.UTC(Number(m[1]), Number(m[2]), 1) // first ms of the FOLLOWING month
    if (monthEnd >= cutoff) continue
    if (!(await canDelete(v))) { kept.push(v); continue }
    const volume = path.join(archiveDir, v)
    try { freedBytes += fs.statSync(volume).size; fs.unlinkSync(volume) } catch { /* already gone */ }
    removed.push(v)
  }
  return { removed, kept, freedBytes }
}

/** Extract archived bodies (optionally filtered) back into plain files at destDir. */
export function extractArchive(
  archiveDir: string,
  destDir: string,
  filter?: (e: ArchivedBody) => boolean,
): { files: number; bytes: number } {
  fs.mkdirSync(destDir, { recursive: true })
  let files = 0
  let bytes = 0
  for (const e of listArchiveEntries(archiveDir)) {
    if (filter && !filter(e)) continue
    const data = readArchiveEntry(e)
    fs.writeFileSync(path.join(destDir, e.name), data)
    fs.utimesSync(path.join(destDir, e.name), e.mtimeMs / 1000, e.mtimeMs / 1000)
    files++
    bytes += data.length
  }
  return { files, bytes }
}

/** Liveness of the LIVE bodies dir: how many raw files sit there and how old the newest one is.
 *
 *  TRDD-0SA5QZTG. Raw-body capture died on this machine and went unnoticed for ~4 days while
 *  `server status` reported healthy — spans, store size, log sessions, archive footprint, all
 *  fine — because nothing it printed described CAPTURE. Everything that reads raw bodies
 *  (`investigate_burn`, `get_cache_event_log`, ctxmap/ctxvis, the real-corpus tests) answered
 *  from a stale snapshot with no indication it was stale.
 *
 *  The newest file's mtime is the cheapest true signal: it needs no counter plumbed through the
 *  write path, and it is the exact quantity a human checks by hand when they finally suspect
 *  something. `newestMs` is null for an empty or absent dir — an ABSENT reading, never 0, which
 *  would render as "captured just now" and state the opposite of the truth. */
export function liveBodiesLiveness(liveDir: string): { files: number; newestMs: number | null } {
  let files = 0
  let newestMs: number | null = null
  let names: string[]
  try { names = fs.readdirSync(liveDir) } catch { return { files, newestMs } }
  for (const f of names) {
    if (!f.endsWith('.request.json') && !f.endsWith('.response.json')) continue
    files++
    try {
      const m = fs.statSync(path.join(liveDir, f)).mtimeMs
      if (newestMs === null || m > newestMs) newestMs = m
    } catch { /* vanished mid-scan — the drain is allowed to race us */ }
  }
  return { files, newestMs }
}

/** Total on-disk footprint of the archive (volumes + indexes). */
export function archiveDiskUsage(archiveDir: string): { volumes: number; bytes: number; entries: number } {
  let volumes = 0
  let bytes = 0
  let entries = 0
  let names: string[]
  try { names = fs.readdirSync(archiveDir).filter(f => VOLUME_RE.test(f)) } catch { return { volumes, bytes, entries } }
  for (const v of names) {
    volumes++
    const volume = path.join(archiveDir, v)
    for (const f of [volume, `${volume}.idx`]) {
      try { bytes += fs.statSync(f).size } catch { /* ignore */ }
    }
    entries += loadVolumeIndex(volume).length
  }
  return { volumes, bytes, entries }
}
