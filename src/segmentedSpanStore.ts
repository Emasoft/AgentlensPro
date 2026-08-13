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
import * as zlib from 'zlib'
import { atomicWriteFileSync, rssPressure } from './serverRuntime'
import { forEachNdjsonLineAuto, forEachGunzipChunkSync } from './ndjsonLines'
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
//
// The optional `.gz` suffix is a SEALED, compressed segment (see `compressSealedSegments` below).
// The day token stays in the same leading 10 chars either way, so `name.slice(0, 10)` — the key
// every call site already uses — is unchanged; only the shape check and the reader/writer paths
// needed to learn the new suffix. This was the PARKED bug: a `.gz` segment failing this regex
// silently disappears from every read/stats/retention path with no error (docs_dev spec, ATOM-
// UNJH-PDX2) — fixing the regex is what makes a compressed segment visible again everywhere.
function segmentDayMs(filename: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}\.ndjson(\.gz)?$/.test(filename)) return null
  const day = filename.slice(0, 10)
  const ms = Date.parse(`${day}T00:00:00Z`)
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== day) return null
  return ms
}

/** Count NDJSON lines without loading the file into memory (a segment can be hundreds of MB;
 *  a split('\n') here could OOM the boot path this exists to protect). Transparent over a `.gz`
 *  segment: decompression is STREAMED (forEachGunzipChunkSync), so the newline scan only ever
 *  holds one bounded chunk — a whole-day gunzipSync Buffer here (568 MB measured) was the
 *  review-confirmed RSS spike on every boot index rebuild over compressed days. */
/** Round-trip verify a written `.gz` against the plain bytes it was made from, STREAMED: the old
 *  `gunzipSync(...).equals(plainBytes)` held plain + gz + a second decompressed-day Buffer at once
 *  (>1 GB peak per big file — the allocator ratchet behind the boot-sweep RSS kill in
 *  TRDD-34B9JAZK's trail). Comparing chunk-by-chunk keeps the peak at plain + gz + one chunk.
 *  Throws on a gunzip error (callers log and keep both forms); returns false on a byte mismatch. */
function gzVerifiesAgainst(gzFile: string, plainBytes: Buffer): boolean {
  let off = 0
  let mismatch = false
  forEachGunzipChunkSync(gzFile, (chunk) => {
    if (mismatch) return
    if (off + chunk.length > plainBytes.length || !chunk.equals(plainBytes.subarray(off, off + chunk.length))) {
      mismatch = true
      return
    }
    off += chunk.length
  })
  return !mismatch && off === plainBytes.length
}

function countLinesStreaming(file: string): number {
  let count = 0
  let lastByte = 0x0a
  if (file.endsWith('.gz')) {
    let sawBytes = false
    forEachGunzipChunkSync(file, (chunk) => {
      sawBytes = true
      for (let i = 0; i < chunk.length; i++) if (chunk[i] === 0x0a) count++
      lastByte = chunk[chunk.length - 1]
    })
    if (!sawBytes) return 0
    if (lastByte !== 0x0a) count++
    return count
  }
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
      // A day is normally only ever appended to WHILE it is still today — compression only
      // touches days strictly before today (see compressSealedSegments). A late-arriving span
      // whose OWN timestamp names an already-compressed day is the one path where that invariant
      // can still be crossed (a backfilled/replayed OTEL export). It is never silently dropped:
      // the plain form is (re)created here, and every reader below merges both forms by span id
      // rather than picking one — so this is loud, not lost.
      if (fs.existsSync(path.join(this.dir, `${key}.ndjson.gz`))) {
        this.log(`[AgentLens] span store: late span(s) appended to ${key} after it was already compressed to ${key}.ndjson.gz — both forms now exist and are merged on read`)
      }
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

  /** Load only the spans whose timestamp falls in [sinceMs, untilMs].
   *
   *  Prefer `forEachInRange` when the caller only wants SOME of them. This returns every span in
   *  the window in ONE array, so its peak memory is the whole window regardless of how few spans
   *  the caller keeps — which is how an unbounded query OOM'd the server (TRDD-QK3L5QAS): the
   *  cache-ledger scan loaded ~1M span objects and discarded all but the `api_request` ones on the
   *  very next line. */
  loadRange(sinceMs: number, untilMs: number): Span[] {
    const out: Span[] = []
    this.forEachInRange(sinceMs, untilMs, (span) => { out.push(span) })
    return out
  }

  /** Visit each span in [sinceMs, untilMs] without ever holding them all at once — reads
   *  exclusively the segment files whose day/index range overlaps the window; every other segment
   *  is never opened. This is how "queries load segments, not the whole store" is enforced, and
   *  the visitor is how a selective caller's peak memory stays proportional to what it KEEPS
   *  rather than to the size of the window.
   *
   *  `linePrefilter`, when given, is tested against the RAW line BEFORE `JSON.parse` — a line it
   *  rejects is skipped without ever being parsed. This exists because a caller that keeps only a
   *  couple of span names (e.g. scanOtelCallEvents) still paid a full JSON.parse + object-graph
   *  allocation for every discarded span, which is the transient-heap churn measured in
   *  TRDD-9NAUEUUR (~2GB/GC cycle, rss sawtoothing 2.6→4.7GB across a 5.4M-span walk). The
   *  CALLER owns the correctness contract: `linePrefilter(line) === false` must be usable ONLY
   *  when it is IMPOSSIBLE for that line's parsed span to be one the caller wants — a false
   *  negative here is silent, unrecoverable data loss, not a discarded candidate. When omitted,
   *  behavior is byte-identical to before this parameter existed (every line is parsed). */
  forEachInRange(sinceMs: number, untilMs: number, visit: (span: Span) => void, linePrefilter?: (line: string) => boolean): void {
    this.flush() // reads must see everything appended so far
    let byKey: Map<string, string[]>
    try {
      byKey = this.listSegmentFiles()
    } catch {
      return // no dir yet — empty store
    }
    for (const key of [...byKey.keys()].sort()) {
      const files = byKey.get(key) as string[]
      const dayMs = Date.parse(`${key}T00:00:00Z`)
      const meta = this.index.segments[key]
      // Segment-level window test: index min/max when known (tighter), else the day bounds.
      const lo = meta ? meta.minTs : dayMs
      const hi = meta ? meta.maxTs : dayMs + DAY_MS
      if (lo > untilMs || hi < sinceMs) continue
      let skipped = 0
      let readError: string | null = null
      // Almost always exactly one file backs a key. The rare >1 case (a compress crash-recovery
      // leftover, or a late span appended after compression — see flush()'s warning above) is
      // de-duplicated by (traceId, spanId) across the forms rather than picking one: picking the
      // plain form would double-read a crash leftover, picking the .gz form would silently drop
      // a genuinely late span — the exact silent-loss class this store exists to end.
      const seenIds = files.length > 1 ? new Set<string>() : null
      for (const name of files) {
        // Streamed, and the failure is LOUD. This used to be a whole-file
        // readFileSync('utf-8') inside `catch { continue }` — so any segment past V8's
        // 512 MB max-string-length threw and that entire DAY vanished from the result with
        // no log line, which is the exact silent loss this store's header promises never
        // happens. Two live segments (568 MB, 531 MB) were being dropped this way.
        try {
          forEachNdjsonLineAuto(path.join(this.dir, name), (line) => {
            // Cheap substring test BEFORE the parse — see the linePrefilter doc comment above.
            // A rejected line is never even handed to JSON.parse, which is the whole saving.
            if (linePrefilter && !linePrefilter(line)) return
            let span: Span
            try { span = JSON.parse(line) as Span } catch { skipped++; return } // truncated tail line
            if (seenIds) {
              const id = `${span.traceId}:${span.spanId}`
              if (seenIds.has(id)) return
              seenIds.add(id)
            }
            const ts = spanTimestampMs(span)
            if (ts < sinceMs || ts > untilMs) return
            visit(this.applyOverlay(span))
          })
        } catch (e) {
          readError = readError ?? String(e)
        }
      }
      if (readError !== null) {
        this.log(`[AgentLens] span store: could NOT read ${files.join('+')} (${readError}) — that segment is MISSING from this query's result`)
      }
      if (skipped > 0) this.log(`[AgentLens] span store: skipped ${skipped} corrupt line(s) in ${files.join('+')}`)
    }
  }

  /** One entry per calendar day, mapping to EVERY filename currently backing it (normally exactly
   *  one — `<day>.ndjson` or, once sealed and compressed, `<day>.ndjson.gz`). More than one form
   *  is a real but rare state (see the flush()/forEachInRange comments above); callers that only
   *  want a single winner should still go through this so day-derivation stays in one place. */
  private listSegmentFiles(): Map<string, string[]> {
    const names = fs.readdirSync(this.dir)
    const byKey = new Map<string, string[]>()
    for (const name of names) {
      if (segmentDayMs(name) === null) continue
      const key = name.slice(0, 10)
      const arr = byKey.get(key)
      if (arr) arr.push(name); else byKey.set(key, [name])
    }
    return byKey
  }

  /** Span count for a day, de-duplicated by (traceId, spanId) when more than one file backs it.
   *  Single-file case is the streamed byte-scan (countLinesStreaming); the >1 case must parse
   *  lines to dedupe, but only ever happens for the rare both-forms-present day, never the common
   *  path. */
  private countSpansForKey(files: string[]): number {
    if (files.length === 1) {
      try { return countLinesStreaming(path.join(this.dir, files[0])) } catch { return 0 }
    }
    const seen = new Set<string>()
    for (const name of files) {
      try {
        forEachNdjsonLineAuto(path.join(this.dir, name), (line) => {
          try {
            const p = JSON.parse(line) as { traceId?: string; spanId?: string }
            seen.add(`${p.traceId ?? ''}:${p.spanId ?? ''}`)
          } catch { /* corrupt line — forEachInRange already logs this case on read */ }
        })
      } catch { /* one form unreadable — best-effort count from the other */ }
    }
    return seen.size
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

  /** Gzip every SEALED plain segment (any day strictly before today — an active/current-day
   *  segment can still receive appends, so it is never touched here) into `<day>.ndjson.gz`.
   *  Measured 19.5x on a real segment (project memory ATOM-UNJH-PDX2); every reader path above
   *  (forEachInRange, retention's spanCount fallback, loadOrRebuildIndex) already treats `.gz`
   *  transparently, so a compressed day stays fully visible.
   *
   *  Atomic, verify-before-delete: gzip to a sibling temp file via `atomicWriteFileSync` (fsync +
   *  rename — the SAME primitive this file already uses for the index, so this is not a new
   *  discipline), then gunzip the just-written `.gz` back and byte-compare it against the plain
   *  bytes BEFORE deleting the plain file. A crash before the rename leaves only the (ignored,
   *  regex-invisible) temp file and the plain file untouched; a crash after the rename but before
   *  the delete leaves BOTH forms, which every reader above already tolerates (merge-by-id) and
   *  which the "already compressed" branch below finishes cleaning up on the next sweep. */
  compressSealedSegments(
    nowMs: number = Date.now(),
    // Pause the sweep under RSS pressure. WHY (2026-08-13, observed live): the first boot sweep
    // gunzip-verified 31 segments back-to-back — each iteration holds plain + gz + round-trip
    // buffers (a big day is ~568MB decompressed, so >1GB peak per file) and the allocator ratchets
    // across files; post-sweep RSS sat at 5.4GB and the server was silently killed executing the
    // very next heavy tool. The sweep is resumable BY DESIGN (an already-verified .gz finishes its
    // deferred delete next pass), so pausing costs one day of latency, never correctness.
    underPressure: () => boolean = () => rssPressure().over,
    // Bounded-slice mode (review finding: the FULL boot sweep ran synchronously before the
    // servers could listen — 3m40s of closed ports over a 31-segment backlog). A caller passes a
    // small maxSegments and reschedules while `remaining > 0`, so a backlog drains one blocking
    // slice at a time with the event loop breathing between slices instead of one multi-minute
    // block. Infinity keeps the original single-call semantics for tests and small stores.
    maxSegments: number = Infinity,
  ): { compressed: string[]; bytesSaved: number; pausedForPressure: boolean; remaining: number } {
    const compressed: string[] = []
    let bytesSaved = 0
    let pausedForPressure = false
    let touched = 0
    let remaining = 0
    const todayKey = segmentKey(nowMs)
    let names: string[]
    try { names = fs.readdirSync(this.dir) } catch { return { compressed, bytesSaved, pausedForPressure, remaining } }
    let indexDirty = false
    for (const name of names) {
      if (!/^\d{4}-\d{2}-\d{2}\.ndjson$/.test(name)) continue // only plain, un-compressed segments
      const key = name.slice(0, 10)
      if (key >= todayKey) continue // active/current-day segment — never compress
      if (touched >= maxSegments) { remaining++; continue }
      if (underPressure()) {
        if (!pausedForPressure) { // log the pause ONCE, not once per remaining segment
          this.log(`[AgentLens] span store: compression sweep paused under RSS pressure after ${compressed.length} segment(s) — remaining sealed segments compress on the next sweep`)
        }
        pausedForPressure = true
        remaining++
        continue // keep counting `remaining` so the caller knows work is left
      }
      touched++
      const plainFile = path.join(this.dir, name)
      const gzFile = `${plainFile}.gz`
      let plainBytes: Buffer
      try { plainBytes = fs.readFileSync(plainFile) } catch { continue } // vanished — retried next sweep
      if (plainBytes.length === 0) continue // nothing to gain, nothing to compress

      if (fs.existsSync(gzFile)) {
        // Resume an interrupted compress (crash between the rename and the delete): finish the
        // delete IF the existing .gz still verifies against the current plain bytes; otherwise
        // leave both forms alone rather than guess.
        try {
          if (gzVerifiesAgainst(gzFile, plainBytes)) {
            fs.unlinkSync(plainFile)
            const meta = this.index.segments[key]
            if (meta) { meta.bytes = fs.statSync(gzFile).size; indexDirty = true }
          }
        } catch (e) {
          this.log(`[AgentLens] span store: could not verify existing ${key}.ndjson.gz against ${name}: ${String(e)} — leaving both forms`)
        }
        continue
      }

      const gz = zlib.gzipSync(plainBytes)
      try {
        atomicWriteFileSync(gzFile, gz) // temp file + fsync + rename — never a half-written .gz
      } catch (e) {
        this.log(`[AgentLens] span store: could not compress ${name}: ${String(e)}`)
        continue
      }
      // Verify before delete: never remove the only-known-good copy on faith.
      try {
        if (!gzVerifiesAgainst(gzFile, plainBytes)) {
          this.log(`[AgentLens] span store: ${name} compressed but did NOT verify byte-identical — leaving both forms, NOT deleting the plain copy`)
          continue
        }
      } catch (e) {
        this.log(`[AgentLens] span store: could not verify compressed ${name}: ${String(e)} — leaving both forms`)
        continue
      }
      try {
        fs.unlinkSync(plainFile)
      } catch (e) {
        // Not fatal — listSegmentFiles()/forEachInRange already read the .gz form correctly (and
        // would merge-by-id if the delete keeps failing); this just wastes disk until retried.
        this.log(`[AgentLens] span store: compressed ${name} but could not delete the plain copy: ${String(e)}`)
      }
      const meta = this.index.segments[key]
      if (meta) { meta.bytes = gz.length; indexDirty = true }
      compressed.push(name)
      bytesSaved += plainBytes.length - gz.length
      this.log(`[AgentLens] span store: compressed sealed segment ${name} → ${key}.ndjson.gz (${plainBytes.length}B → ${gz.length}B)`)
    }
    if (indexDirty) this.writeIndex()
    return { compressed, bytesSaved, pausedForPressure, remaining }
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

    let byKey: Map<string, string[]>
    try { byKey = this.listSegmentFiles() } catch { return }
    const onDisk = new Set<string>()
    let dirty = false
    for (const [key, files] of byKey) {
      onDisk.add(key)
      // Total on-disk bytes across every form backing this day — when both a plain and a `.gz`
      // form are present (see forEachInRange), this is a real, if temporary, doubling of disk
      // usage and stats() should say so rather than silently reporting only one form's size.
      let size = 0
      let statOk = true
      for (const name of files) {
        try { size += fs.statSync(path.join(this.dir, name)).size } catch { statOk = false }
      }
      if (!statOk) continue
      const meta = this.index.segments[key]
      if (meta && meta.bytes === size) continue // index agrees with disk — trust it
      const dayMs = Date.parse(`${key}T00:00:00Z`)
      const count = this.countSpansForKey(files)
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
