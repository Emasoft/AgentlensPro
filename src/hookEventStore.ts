// Hook-event store — Claude Code lifecycle hook payloads (SessionStart/Stop/StopFailure/
// PreCompact/...) forwarded by `agentlenspro hook`, persisted as append-only NDJSON in
// daily buckets (<dir>/YYYY-MM-DD.ndjsonl). These events carry signals the JSONL transcripts
// and OTEL bodies do NOT: exact rate-limit turn deaths (StopFailure), compaction boundaries
// with trigger (PreCompact), and true session lifecycle. Append-only daily buckets on purpose:
// a per-event rewrite of a growing store is the exact pattern that destroyed 420GB of SSD in
// 4 hours (see standalone/server.ts span store) — never reintroduce it here either.

import * as fs from 'fs'
import * as path from 'path'

export interface HookEventRecord {
  /** Server receive time (ms epoch) — the hook fires within ~1s of the real event. */
  ts: number
  /** hook_event_name from the payload (SessionStart, StopFailure, PreCompact, ...). */
  ev: string
  /** session_id from the payload when present. */
  session?: string
  /** The raw hook payload, verbatim — refinement/classification happens at read time. */
  payload: Record<string, unknown>
}

function bucketPath(dir: string, ts: number): string {
  return path.join(dir, `${new Date(ts).toISOString().slice(0, 10)}.ndjsonl`)
}

// A bucket filename → the UTC ms of the day it holds, or null when the file is not one of ours.
// The shape regex alone is NOT enough: `2026-13-99.ndjsonl` matches `\d{2}-\d{2}` yet parses to
// NaN, and NaN silently defeats BOTH the read fast-path (`NaN > until` is false, so the bucket is
// scanned) and a string-compare purge (`'2026-13-99' >= cutoff` is always true, so it is never
// deleted — an unpurgeable file counted in disk usage forever). Parse once, here, for all three.
function bucketDayMs(filename: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}\.ndjsonl$/.test(filename)) return null
  const day = filename.slice(0, 10)
  const ms = Date.parse(`${day}T00:00:00Z`)
  // Date.parse accepts overflow ('2026-02-31'); round-trip to reject anything not calendar-real.
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== day) return null
  return ms
}

/** One construction point for the record shape — the disk line and the server's in-memory
 *  ring (TRDD-GOD0108C) must never drift apart. */
export function buildHookEventRecord(payload: Record<string, unknown>, ts: number = Date.now()): HookEventRecord {
  return {
    ts,
    ev: String(payload.hook_event_name ?? ''),
    session: typeof payload.session_id === 'string' ? payload.session_id : undefined,
    payload,
  }
}

/** The exact on-disk location of one appended line — enough to read it back and PROVE it is durable
 *  before destroying the only other copy. TRDD-K3WDPR7M (2026-07-15 USER directive: a source file may
 *  be deleted ONLY after the durable destination is confirmed to hold its data). */
export interface AppendPosition {
  /** The daily bucket the line was appended to. */
  bucketPath: string
  /** Byte offset where the line STARTS — the bucket's size immediately before the append. */
  offset: number
  /** Byte length of the appended line, including its trailing newline. */
  length: number
}

/** Append one hook event; returns the record (for the server's in-memory ring), bytes written (for
 *  its persistence accounting), the exact append position + the exact line bytes — so a caller can
 *  read the line back and verify it is durable before deleting a spool copy (TRDD-K3WDPR7M). */
export function appendHookEvent(dir: string, payload: Record<string, unknown>): { rec: HookEventRecord; bytes: number; pos: AppendPosition; line: string } {
  const rec = buildHookEventRecord(payload)
  const line = `${JSON.stringify(rec)}\n`
  const bucket = bucketPath(dir, rec.ts)
  fs.mkdirSync(dir, { recursive: true })
  // Capture the offset BEFORE the append: appendFileSync writes at end-of-file, so the current size is
  // exactly where this line begins. Reading it here (not after) is what lets verifyAppendedLine seek
  // to this line and nothing else.
  let offset = 0
  try { offset = fs.statSync(bucket).size } catch { /* bucket does not exist yet — starts at 0 */ }
  fs.appendFileSync(bucket, line)
  const length = Buffer.byteLength(line)
  return { rec, bytes: length, pos: { bucketPath: bucket, offset, length }, line }
}

/** Read back the bytes we believe we appended and prove they equal `expectedLine` byte-for-byte.
 *  Reads the FILE at the recorded offset — never trusts in-memory state, because the whole point is to
 *  catch a silently short/failed WRITE (disk full, truncation, fs bug). Returns false on any shortfall
 *  or mismatch so the caller KEEPS the source copy. TRDD-K3WDPR7M (2026-07-15 USER directive: verify
 *  the durable destination before deleting the source). */
export function verifyAppendedLine(pos: AppendPosition, expectedLine: string): boolean {
  const expected = Buffer.from(expectedLine, 'utf-8')
  if (expected.length !== pos.length) return false // the recorded length must match the line we expect
  let fd: number
  try { fd = fs.openSync(pos.bucketPath, 'r') } catch { return false } // bucket vanished — cannot prove durability
  try {
    const buf = Buffer.alloc(pos.length)
    const read = fs.readSync(fd, buf, 0, pos.length, pos.offset)
    if (read !== pos.length) return false // fewer bytes than expected — a truncated / short write
    return buf.equals(expected)
  } finally {
    fs.closeSync(fd)
  }
}

/** Move a spool file that can never ingest (unparseable JSON, or a payload the server rejects with a
 *  400) into a `rejected/` quarantine dir instead of deleting it. TRDD-K3WDPR7M (2026-07-15 USER
 *  directive): a payload we cannot ingest is still DATA — destroying it is the exact loss the directive
 *  forbids. Quarantine keeps the spool unwedged WITHOUT throwing anything away. Same basename; on a
 *  name collision suffix `-1`, `-2`, ... so no quarantined file is ever overwritten. Returns the
 *  destination path. */
export function quarantineSpoolFile(file: string, rejectedDir: string): string {
  fs.mkdirSync(rejectedDir, { recursive: true })
  const base = path.basename(file)
  let dest = path.join(rejectedDir, base)
  if (fs.existsSync(dest)) {
    const ext = path.extname(base)
    const stem = base.slice(0, base.length - ext.length)
    let i = 1
    do { dest = path.join(rejectedDir, `${stem}-${i}${ext}`); i++ } while (fs.existsSync(dest))
  }
  fs.renameSync(file, dest)
  return dest
}

export interface HookEventFilter {
  session?: string
  ev?: string
  sinceMs?: number
  untilMs?: number
  limit?: number
}

/** Read events newest-first, bounded. Buckets hold lifecycle events only, so scans are tiny. */
export function readHookEvents(dir: string, filter: HookEventFilter = {}): HookEventRecord[] {
  const limit = Math.max(1, Math.min(filter.limit ?? 100, 1000))
  const since = filter.sinceMs ?? 0
  const until = filter.untilMs ?? Infinity
  const out: HookEventRecord[] = []
  let buckets: string[]
  try {
    buckets = fs.readdirSync(dir).filter(f => bucketDayMs(f) !== null).sort().reverse()
  } catch {
    return out // no dir yet — no events
  }
  for (const b of buckets) {
    // Filename dates bound the bucket's contents — skip whole buckets outside the window.
    const dayStart = bucketDayMs(b) as number
    if (dayStart > until || dayStart + 86_400_000 < since) continue
    let lines: string[]
    try {
      lines = fs.readFileSync(path.join(dir, b), 'utf-8').split('\n')
    } catch {
      continue
    }
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i].trim()
      if (!l) continue
      let rec: HookEventRecord
      try { rec = JSON.parse(l) as HookEventRecord } catch { continue } // corrupt tail line — skip
      if (rec.ts < since || rec.ts > until) continue
      if (filter.session && rec.session !== filter.session) continue
      if (filter.ev && rec.ev !== filter.ev) continue
      out.push(rec)
      if (out.length >= limit) return out
    }
  }
  return out
}

/** Delete daily buckets older than retentionDays. Returns the removed filenames + freed bytes. */
export function purgeHookEventBuckets(dir: string, retentionDays: number): { removed: string[]; freedBytes: number } {
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

export function hookEventsDiskUsage(dir: string): { files: number; bytes: number } {
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
