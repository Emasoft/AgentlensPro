// Segmented append-only span store — daily NDJSON segments under a dedicated directory
// (production: ~/.agentlens/spans/2026-07-10.ndjson, one JSON span per line) plus a small
// per-segment index (span count + time range + bytes) in <dir>/index.json.
//
// WHY THIS SHAPE (P4): the previous store was ONE spans.json capped at MAX_SPANS=50,000 with
// silent oldest-first eviction. Measured on 2026-07-10: every server restart logged
// "Loaded 50000 spans (capped from 51700)" — 1,700 spans silently destroyed in a single
// restart, which is exactly why OTEL had to be treated as a lossy lower bound in
// src/feedMergePolicy.ts. The segmented store removes the loss at its root:
//   - append cost is O(record): spans are buffered and appended to their day's segment —
//     a whole-file rewrite NEVER happens (the single-file compaction rewrite is gone too;
//     rewriting a growing store is the pattern that destroyed 420GB of SSD in 4 hours).
//   - NO span-count cap, NO eviction: disk keeps every span until retention expires its
//     whole segment. Bounded memory comes from callers loading only the segments a query's
//     time range overlaps (loadRange), never the whole store.
//   - retention (AGENTLENS_SPANS_RETENTION_DAYS, default 30 — enforced by the server) deletes
//     whole EXPIRED segments only, and logs one explicit line per deleted segment
//     ("retention: deleted segment 2026-06-01.ndjson, N spans, age 39d"). Nothing is ever
//     dropped silently.
//
// DELIBERATE DECISION — no native dependencies: better-sqlite3 (or any compiled addon) would
// give indexed queries for free, but it breaks `npx agentlenspro` portability (per-platform
// prebuilds, node-gyp fallbacks on user machines). Plain NDJSON + a JSON index keeps the
// store pure-Node and debuggable with cat/grep; segment-granular reads keep it fast enough.

import * as fs from 'fs'
import * as path from 'path'
import { atomicWriteFileSync } from './serverRuntime'
import { forEachNdjsonLine } from './ndjsonLines'
import type { Span } from './shared/telemetryTypes'

const DAY_MS = 86_400_000
const INDEX_FILE = 'index.json'
// Failure-path bound only: when disk appends keep failing (disk full, dir deleted) the pending
// buffer must not become its own memory leak. Overflow is dropped LOUDLY (counted + logged) —
// in normal operation this is never hit because flush() drains the buffer every tick.
const PENDING_FAILSAFE_MAX = 100_000

export interface SegmentMeta {
  count: number
  minTs: number
  maxTs: number
  bytes: number
}

interface SegmentIndex {
  version: 1
  segments: Record<string, SegmentMeta> // key: 'YYYY-MM-DD' (UTC)
}

export interface SpanStoreStats {
  segments: number
  totalSpans: number
  totalBytes: number
  pendingAppends: number
}

export interface RetentionDeletion {
  segment: string // filename, e.g. '2026-06-01.ndjson'
  spans: number
  ageDays: number
}

/** Best-effort wall-clock ms for a span: collector receive time, else its own start/end time.
 *  OTLP start/end times are unix-nano STRINGS ("1720512345000000000"); log-derived spans may
 *  carry ISO strings — accept both. */
export function spanTimestampMs(span: Span): number {
  if (typeof span.receivedAt === 'number' && Number.isFinite(span.receivedAt)) return span.receivedAt
  for (const t of [span.startTime, span.endTime]) {
    if (typeof t !== 'string' || t === '') continue
    if (/^\d+$/.test(t)) {
      const ms = Number(t) / 1e6 // unix-nano → ms
      if (Number.isFinite(ms) && ms > 0) return ms
    } else {
      const ms = Date.parse(t)
      if (Number.isFinite(ms)) return ms
    }
  }
  return Date.now()
}

function segmentKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10) // UTC day
}

// Segment filename → the UTC ms of the day it holds, or null when the file is not one of ours.
// The shape regex alone is NOT enough: '2026-13-99.ndjson' matches \d{2}-\d{2} yet parses to NaN,
// and NaN silently defeats both the range fast-path and the retention cutoff (an unpurgeable
// file). Parse once, round-trip to reject calendar-invalid dates (same lesson as hookEventStore).
function segmentDayMs(filename: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}\.ndjson$/.test(filename)) return null
  const day = filename.slice(0, 10)
  const ms = Date.parse(`${day}T00:00:00Z`)
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== day) return null
  return ms
}

/** Count NDJSON lines without loading the file into memory (a segment can be hundreds of MB;
 *  a split('\n') here could OOM the boot path this exists to protect). */
function countLinesStreaming(file: string): number {
  let count = 0
  let lastByte = 0x0a
  const buf = Buffer.alloc(64 * 1024)
  const fd = fs.openSync(file, 'r')
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null)
      if (n <= 0) break
      for (let i = 0; i < n; i++) if (buf[i] === 0x0a) count++
      lastByte = buf[n - 1]
    }
  } finally {
    fs.closeSync(fd)
  }
  if (lastByte !== 0x0a) count++ // truncated final line (crash mid-append) still holds one record
  return count
}

export class SegmentedSpanStore {
  private index: SegmentIndex = { version: 1, segments: {} }
  // Pending appends, grouped by segment key so one flush = one appendFileSync per touched day.
  private pending = new Map<string, { lines: string[]; count: number; minTs: number; maxTs: number }>()
  private pendingCount = 0
  private droppedOnFailure = 0
  // S3-F3b read-time attribute overlay: `traceId:spanId` → { attrKey: stringValue }, merged into a
  // span WHEN IT IS READ (loadRange) rather than by rewriting its persisted NDJSON line. This is how
  // gen_ai_latest_experimental response content — which arrives as a SEPARATE log event, before OR
  // after the LLM span, on a different HTTP request — reaches the span without disk-segment surgery.
  // Because the merge happens on read, arrival order does not matter (a span appended later still
  // picks up an overlay recorded earlier, and vice-versa); no buffer/drain is needed. The overlay is
  // in-memory only, so it is lost on restart — an accepted tradeoff for LOW-severity enrichment (the
  // dominant ordering is span-first, whose content the legacy store also kept only in memory), and it
  // never touches the persisted spans (accounting) themselves. Cap-evicted oldest-first so an entry
  // whose span never arrives cannot leak memory.
  private overlay = new Map<string, Record<string, string>>()
  private readonly OVERLAY_MAX = 500

  constructor(
    readonly dir: string,
    private readonly log: (msg: string) => void = (m) => console.log(m),
  ) {
    try { fs.mkdirSync(dir, { recursive: true }) } catch { /* surfaced by the first flush */ }
    this.loadOrRebuildIndex()
  }

  get pendingAppends(): number {
    return this.pendingCount
  }

  /** Buffer one span for its daily segment. O(record) — disk is touched only by flush(). */
  append(span: Span): void {
    const ts = spanTimestampMs(span)
    const key = segmentKey(ts)
    let bucket = this.pending.get(key)
    if (!bucket) {
      bucket = { lines: [], count: 0, minTs: Infinity, maxTs: -Infinity }
      this.pending.set(key, bucket)
    }
    bucket.lines.push(JSON.stringify(span))
    bucket.count++
    if (ts < bucket.minTs) bucket.minTs = ts
    if (ts > bucket.maxTs) bucket.maxTs = ts
    this.pendingCount++
    // Disk-failure failsafe only (see PENDING_FAILSAFE_MAX). Dropping is loud, never silent.
    if (this.pendingCount > PENDING_FAILSAFE_MAX) {
      const oldestKey = [...this.pending.keys()].sort()[0]
      const oldest = this.pending.get(oldestKey)
      if (oldest && oldest.lines.length > 0) {
        oldest.lines.shift()
        oldest.count--
        this.pendingCount--
        this.droppedOnFailure++
        if (this.droppedOnFailure === 1 || this.droppedOnFailure % 1000 === 0) {
          this.log(`[AgentLens] span store: appends failing and buffer full — DROPPED ${this.droppedOnFailure} span(s) so far (fix the disk!)`)
        }
      }
    }
  }

  /** Append every buffered span to its segment file and refresh the index (atomic write).
   *  Never throws: a failed segment keeps its buffer for the next tick. */
  flush(): { appendedSpans: number; appendedBytes: number } {
    if (this.pendingCount === 0) return { appendedSpans: 0, appendedBytes: 0 }
    let appendedSpans = 0
    let appendedBytes = 0
    let indexDirty = false
    for (const [key, bucket] of [...this.pending.entries()]) {
      if (bucket.lines.length === 0) { this.pending.delete(key); continue }
      const chunk = `${bucket.lines.join('\n')}\n`
      try {
        fs.mkdirSync(this.dir, { recursive: true })
        fs.appendFileSync(path.join(this.dir, `${key}.ndjson`), chunk)
      } catch (e) {
        // Keep the buffer — retried next tick; the failsafe in append() bounds it.
        this.log(`[AgentLens] span store: could not append to ${key}.ndjson: ${String(e)}`)
        continue
      }
      const bytes = Buffer.byteLength(chunk)
      appendedSpans += bucket.count
      appendedBytes += bytes
      this.pendingCount -= bucket.count
      this.pending.delete(key)
      const meta = this.index.segments[key] ?? { count: 0, minTs: bucket.minTs, maxTs: bucket.maxTs, bytes: 0 }
      meta.count += bucket.count
      meta.bytes += bytes
      if (bucket.minTs < meta.minTs) meta.minTs = bucket.minTs
      if (bucket.maxTs > meta.maxTs) meta.maxTs = bucket.maxTs
      this.index.segments[key] = meta
      indexDirty = true
    }
    if (indexDirty) this.writeIndex()
    return { appendedSpans, appendedBytes }
  }

  /** Record an attribute to merge into span `traceId:spanId` when it is next read (loadRange),
   *  WITHOUT rewriting any persisted segment. Order-independent: the merge is applied on read, so
   *  the span may arrive before or after this call. Always returns true (the overlay is recorded
   *  regardless of whether the span is currently in the store) — the boolean exists to mirror the
   *  legacy sessionStore.injectSpanAttribute signature so callers stay uniform. Cap-evicts the
   *  oldest entry when OVERLAY_MAX is exceeded, so a never-arriving span cannot leak memory. */
  injectSpanAttribute(traceId: string, spanId: string, key: string, value: string): boolean {
    const k = `${traceId}:${spanId}`
    const rec = this.overlay.get(k)
    if (rec) {
      rec[key] = value
    } else {
      this.overlay.set(k, { [key]: value })
      if (this.overlay.size > this.OVERLAY_MAX) {
        const firstKey = this.overlay.keys().next().value
        if (firstKey !== undefined) { this.overlay.delete(firstKey) }
      }
    }
    return true
  }

  /** Merge any recorded overlay attributes into a span read from disk (fresh JSON.parse per call,
   *  so mutating it here never contaminates the persisted line or another read). Upsert semantics:
   *  an existing attribute of the same key is overwritten, else appended. */
  private applyOverlay(span: Span): Span {
    const rec = this.overlay.get(`${span.traceId}:${span.spanId}`)
    if (!rec) return span
    for (const [key, value] of Object.entries(rec)) {
      const existing = span.attributes.find((a) => a.key === key)
      if (existing) { existing.value = { stringValue: value } }
      else { span.attributes.push({ key, value: { stringValue: value } }) }
    }
    return span
  }

  /** Load only the spans whose timestamp falls in [sinceMs, untilMs] — reads exclusively the
   *  segment files whose day/index range overlaps the window; every other segment is never
   *  opened. This is how "queries load segments, not the whole store" is enforced. */
  loadRange(sinceMs: number, untilMs: number): Span[] {
    this.flush() // reads must see everything appended so far
    const out: Span[] = []
    let names: string[]
    try {
      names = fs.readdirSync(this.dir).filter((f) => segmentDayMs(f) !== null).sort()
    } catch {
      return out // no dir yet — empty store
    }
    for (const name of names) {
      const dayMs = segmentDayMs(name) as number
      const key = name.slice(0, 10)
      const meta = this.index.segments[key]
      // Segment-level window test: index min/max when known (tighter), else the day bounds.
      const lo = meta ? meta.minTs : dayMs
      const hi = meta ? meta.maxTs : dayMs + DAY_MS
      if (lo > untilMs || hi < sinceMs) continue
      let skipped = 0
      let readError: string | null = null
      // Streamed, and the failure is LOUD. This used to be a whole-file
      // readFileSync('utf-8') inside `catch { continue }` — so any segment past V8's
      // 512 MB max-string-length threw and that entire DAY vanished from the result with
      // no log line, which is the exact silent loss this store's header promises never
      // happens. Two live segments (568 MB, 531 MB) were being dropped this way.
      try {
        forEachNdjsonLine(path.join(this.dir, name), (line) => {
          let span: Span
          try { span = JSON.parse(line) as Span } catch { skipped++; return } // truncated tail line
          const ts = spanTimestampMs(span)
          if (ts < sinceMs || ts > untilMs) return
          out.push(this.applyOverlay(span))
        })
      } catch (e) {
        readError = String(e)
      }
      if (readError !== null) {
        this.log(`[AgentLens] span store: could NOT read ${name} (${readError}) — that segment is MISSING from this query's result`)
      }
      if (skipped > 0) this.log(`[AgentLens] span store: skipped ${skipped} corrupt line(s) in ${name}`)
    }
    return out
  }

  /** Delete whole EXPIRED segments only (day older than retentionDays). Partial segments are
   *  never trimmed; every deletion is logged explicitly — silence would read as data loss. */
  runRetention(retentionDays: number, nowMs: number = Date.now()): RetentionDeletion[] {
    const deleted: RetentionDeletion[] = []
    const cutoffDay = segmentKey(nowMs - Math.max(1, retentionDays) * DAY_MS)
    const cutoffMs = Date.parse(`${cutoffDay}T00:00:00Z`)
    let names: string[]
    try { names = fs.readdirSync(this.dir) } catch { return deleted }
    let indexDirty = false
    for (const name of names) {
      const dayMs = segmentDayMs(name)
      if (dayMs === null) continue // not one of our segments — never delete a foreign file
      if (dayMs >= cutoffMs) continue
      const key = name.slice(0, 10)
      const file = path.join(this.dir, name)
      let spanCount = this.index.segments[key]?.count
      if (spanCount === undefined) {
        try { spanCount = countLinesStreaming(file) } catch { spanCount = 0 }
      }
      try {
        fs.unlinkSync(file)
      } catch (e) {
        this.log(`[AgentLens] span store: retention could not delete ${name}: ${String(e)}`)
        continue
      }
      delete this.index.segments[key]
      indexDirty = true
      const ageDays = Math.floor((nowMs - dayMs) / DAY_MS)
      deleted.push({ segment: name, spans: spanCount, ageDays })
      this.log(`[AgentLens] retention: deleted segment ${name}, ${spanCount} spans, age ${ageDays}d`)
    }
    if (indexDirty) this.writeIndex()
    return deleted
  }

  /** Remove every segment + the index (the /api/clear + clearAll paths). Foreign files stay. */
  clear(): void {
    this.pending.clear()
    this.pendingCount = 0
    this.droppedOnFailure = 0
    this.overlay.clear()
    let names: string[] = []
    try { names = fs.readdirSync(this.dir) } catch { /* no dir — nothing to clear */ }
    for (const name of names) {
      if (segmentDayMs(name) === null && name !== INDEX_FILE) continue
      try { fs.unlinkSync(path.join(this.dir, name)) } catch { /* raced — ignore */ }
    }
    this.index = { version: 1, segments: {} }
  }

  stats(): SpanStoreStats {
    let totalSpans = 0
    let totalBytes = 0
    const keys = Object.keys(this.index.segments)
    for (const k of keys) {
      totalSpans += this.index.segments[k].count
      totalBytes += this.index.segments[k].bytes
    }
    return { segments: keys.length, totalSpans, totalBytes, pendingAppends: this.pendingCount }
  }

  private writeIndex(): void {
    try {
      atomicWriteFileSync(path.join(this.dir, INDEX_FILE), JSON.stringify(this.index))
    } catch (e) {
      this.log(`[AgentLens] span store: could not write index: ${String(e)}`)
    }
  }

  // Load index.json and reconcile it against the segment files actually on disk. A crash
  // between an append and the index write leaves counts stale-low, so any segment whose byte
  // size disagrees with the index is recounted (streaming — never a whole-file load). Segments
  // missing from the index are adopted; index entries whose file vanished are dropped.
  private loadOrRebuildIndex(): void {
    let parsed: SegmentIndex | null = null
    try {
      const raw = fs.readFileSync(path.join(this.dir, INDEX_FILE), 'utf-8')
      const candidate = JSON.parse(raw) as SegmentIndex
      if (candidate && candidate.version === 1 && candidate.segments && typeof candidate.segments === 'object') {
        parsed = candidate
      }
    } catch { /* missing or corrupt — rebuilt below */ }
    this.index = parsed ?? { version: 1, segments: {} }

    let names: string[] = []
    try { names = fs.readdirSync(this.dir).filter((f) => segmentDayMs(f) !== null) } catch { return }
    const onDisk = new Set<string>()
    let dirty = false
    for (const name of names) {
      const key = name.slice(0, 10)
      onDisk.add(key)
      const file = path.join(this.dir, name)
      let size = 0
      try { size = fs.statSync(file).size } catch { continue }
      const meta = this.index.segments[key]
      if (meta && meta.bytes === size) continue // index agrees with disk — trust it
      const dayMs = segmentDayMs(name) as number
      let count = 0
      try { count = countLinesStreaming(file) } catch { /* unreadable — treat as empty */ }
      // Day bounds as the (conservative, correct) time range — exact min/max would require a
      // full JSON parse of the segment, which the boot path must not pay.
      this.index.segments[key] = { count, minTs: dayMs, maxTs: dayMs + DAY_MS - 1, bytes: size }
      dirty = true
    }
    for (const key of Object.keys(this.index.segments)) {
      if (!onDisk.has(key)) { delete this.index.segments[key]; dirty = true }
    }
    if (dirty) this.writeIndex()
  }
}

/**
 * One-time migration: split a legacy single-file span store (spans.json — either the ancient
 * whole-JSON-array format or the NDJSON single file that replaced it) into daily segments,
 * then rename the original to spans.json.bak. The original is NEVER deleted — if a .bak
 * already exists from an earlier run, a timestamped suffix keeps both.
 * Returns null when there is no legacy file (the normal case after the first boot).
 */
export function migrateLegacySpansFile(
  legacyFile: string,
  store: SegmentedSpanStore,
  log: (msg: string) => void = (m) => console.log(m),
): { migratedSpans: number; skippedLines: number; bakPath: string } | null {
  let raw: string
  try {
    if (!fs.existsSync(legacyFile)) return null
    raw = fs.readFileSync(legacyFile, 'utf-8')
  } catch {
    return null
  }
  // The legacy store was bounded (compaction kept it ≤ ~2× the 50k cap), so a whole-file read
  // here is safe — and this path runs at most once per install.
  let spans: Span[] = []
  let skippedLines = 0
  if (raw.trimStart().startsWith('[')) {
    try { spans = JSON.parse(raw) as Span[] } catch { skippedLines = -1 }
  } else {
    for (const line of raw.split('\n')) {
      if (!line) continue
      try { spans.push(JSON.parse(line) as Span) } catch { skippedLines++ }
    }
  }
  if (skippedLines === -1) {
    log(`[AgentLens] migration: ${path.basename(legacyFile)} is unreadable — leaving it untouched`)
    return null
  }
  for (const span of spans) store.append(span)
  store.flush()
  let bakPath = `${legacyFile}.bak`
  if (fs.existsSync(bakPath)) bakPath = `${legacyFile}.bak-${Date.now()}`
  try {
    fs.renameSync(legacyFile, bakPath)
  } catch (e) {
    // Rename failed → the legacy file stays; next boot would re-migrate (duplicating spans),
    // so surface it loudly rather than silently doubling the store.
    log(`[AgentLens] migration: could not rename ${legacyFile} → ${bakPath}: ${String(e)} — remove or rename it manually`)
    return { migratedSpans: spans.length, skippedLines, bakPath: legacyFile }
  }
  const st = store.stats()
  log(`[AgentLens] migration: split ${path.basename(legacyFile)} into ${st.segments} daily segment(s) — ${spans.length} span(s) migrated, ${skippedLines} corrupt line(s) skipped; original preserved as ${path.basename(bakPath)}`)
  return { migratedSpans: spans.length, skippedLines, bakPath }
}
