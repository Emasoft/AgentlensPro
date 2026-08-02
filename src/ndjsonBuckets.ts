// Generic append-only NDJSON daily buckets (<dir>/YYYY-MM-DD.ndjsonl) — the ONE home of the
// bucket-file machinery shared by hookEventStore (lifecycle hooks) and logEventSink (gated-out
// OTEL log events, TRDD-AMEA4O4Z). Extracted from hookEventStore rather than duplicated because
// the date logic below carries a subtle trap (see bucketDayMs) and duplicated subtle logic is
// exactly how the two OTLP ingest paths drifted apart once already (src/otlpLogEvents.ts header).
// Append-only daily buckets on purpose: a per-event rewrite of a growing store is the pattern
// that destroyed 420GB of SSD in 4 hours — never reintroduce it here either.

import * as fs from 'fs'
import * as path from 'path'

/** The daily bucket file a timestamp lands in. */
export function bucketPath(dir: string, ts: number): string {
  return path.join(dir, `${new Date(ts).toISOString().slice(0, 10)}.ndjsonl`)
}

// A bucket filename → the UTC ms of the day it holds, or null when the file is not one of ours.
// The shape regex alone is NOT enough: `2026-13-99.ndjsonl` matches `\d{2}-\d{2}` yet parses to
// NaN, and NaN silently defeats BOTH the read fast-path (`NaN > until` is false, so the bucket is
// scanned) and a string-compare purge (`'2026-13-99' >= cutoff` is always true, so it is never
// deleted — an unpurgeable file counted in disk usage forever). Parse once, here, for all users.
export function bucketDayMs(filename: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}\.ndjsonl$/.test(filename)) return null
  return dayKeyMs(filename.slice(0, 10))
}

/** A bare 'YYYY-MM-DD' key → the UTC ms of that day, or null when it is not a calendar-real date.
 *  Split out of bucketDayMs so the statusline store's day-PARTITION DIRECTORIES validate through the
 *  exact same trap-aware parse — the header's whole point is that this logic has one home. */
export function dayKeyMs(day: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
  const ms = Date.parse(`${day}T00:00:00Z`)
  // Date.parse accepts overflow ('2026-02-31'); round-trip to reject anything not calendar-real.
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== day) return null
  return ms
}

/** The exact on-disk location of one appended line — enough to read it back and PROVE it is durable
 *  before destroying the only other copy (TRDD-K3WDPR7M verify-before-delete). */
export interface AppendPosition {
  /** The daily bucket the line was appended to. */
  bucketPath: string
  /** Byte offset where the line STARTS — the bucket's size immediately before the append. */
  offset: number
  /** Byte length of the appended line, including its trailing newline. */
  length: number
}

/** Append one already-serialized NDJSON line (caller supplies the trailing newline is NOT needed —
 *  it is added here) to the day bucket for `ts`. Returns the exact append position so a caller can
 *  read the line back and verify durability before deleting a source copy. */
export function appendBucketLine(dir: string, ts: number, json: string): { pos: AppendPosition; line: string; bytes: number } {
  const line = `${json}\n`
  const bucket = bucketPath(dir, ts)
  fs.mkdirSync(dir, { recursive: true })
  // Capture the offset BEFORE the append: appendFileSync writes at end-of-file, so the current size
  // is exactly where this line begins — what lets a verifier seek to this line and nothing else.
  let offset = 0
  try { offset = fs.statSync(bucket).size } catch { /* bucket does not exist yet — starts at 0 */ }
  fs.appendFileSync(bucket, line)
  const length = Buffer.byteLength(line)
  return { pos: { bucketPath: bucket, offset, length }, line, bytes: length }
}

/** Delete daily buckets older than retentionDays. Returns the removed filenames + freed bytes.
 *  Non-bucket files are never touched (bucketDayMs gate). */
export function purgeBuckets(dir: string, retentionDays: number): { removed: string[]; freedBytes: number } {
  const removed: string[] = []
  let freedBytes = 0
  const cutoffDay = new Date(Date.now() - retentionDays * 86_400_000).toISOString().slice(0, 10)
  const cutoffMs = Date.parse(`${cutoffDay}T00:00:00Z`)
  let files: string[]
  try { files = fs.readdirSync(dir) } catch { return { removed, freedBytes } }
  for (const f of files) {
    const dayMs = bucketDayMs(f)
    if (dayMs === null) continue   // not one of our buckets — never delete a foreign file
    if (dayMs >= cutoffMs) continue
    const p = path.join(dir, f)
    try {
      freedBytes += fs.statSync(p).size
      fs.unlinkSync(p)
      removed.push(f)
    } catch { /* raced — skip */ }
  }
  return { removed, freedBytes }
}

/** Total size/count of the bucket files in a dir (foreign files excluded). */
export function bucketsDiskUsage(dir: string): { files: number; bytes: number } {
  let files = 0
  let bytes = 0
  try {
    for (const f of fs.readdirSync(dir)) {
      if (bucketDayMs(f) === null) continue
      try { bytes += fs.statSync(path.join(dir, f)).size; files++ } catch { /* raced */ }
    }
  } catch { /* no dir yet */ }
  return { files, bytes }
}
