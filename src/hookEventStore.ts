// Hook-event store — Claude Code lifecycle hook payloads (SessionStart/Stop/StopFailure/
// PreCompact/...) forwarded by scripts/spy-agentlens.sh, persisted as append-only NDJSON in
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

/** Append one hook event; returns the record (for the server's in-memory ring) + bytes
 *  written (for its persistence accounting). */
export function appendHookEvent(dir: string, payload: Record<string, unknown>): { rec: HookEventRecord; bytes: number } {
  const rec = buildHookEventRecord(payload)
  const line = `${JSON.stringify(rec)}\n`
  fs.mkdirSync(dir, { recursive: true })
  fs.appendFileSync(bucketPath(dir, rec.ts), line)
  return { rec, bytes: Buffer.byteLength(line) }
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
