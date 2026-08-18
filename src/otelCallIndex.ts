// src/otelCallIndex.ts — incremental sidecar index over the span store's SEALED day segments
// (TRDD-7I5805QM).
//
// WHY: scanOtelCallEvents answers every call by re-walking the span store; with no window that is
// the ENTIRE store (measured on this machine: 5.5M spans / 31 segments), minutes of one pegged
// core per call — the "server burns one core continuously" incident of 2026-08-18. Memory was
// already bounded (TRDD-QK3L5QAS visitor, TRDD-9NAUEUUR prefilter); the CPU stayed O(all history)
// per call because immutable data was re-parsed every time.
//
// THE FIX: a segment is SEALED once its UTC day is over (segmentedSpanStore.compressSealedSegments'
// own definition) — its api_request/compaction events can never change. So each sealed day is
// extracted ONCE into a small JSON sidecar (`<spansDir>/.call-events-index/<day>.calls.json`,
// typically KBs against a multi-MB segment), and every later query reads sidecars + scans only
// TODAY's live segment. Full-history cost drops from O(every span ever) to O(today) + O(sidecars).
// The sidecar dir lives INSIDE spansDir deliberately: the store's day-file regex ignores foreign
// names, tests that relocate spansDir get the index for free, and /api/clear leaves foreign files
// alone (an orphaned index self-heals below).
//
// Honesty rules:
// - A sidecar is only PERSISTED when the underlying scan actually read the store (the scan's
//   documented never-throw fallback returns a "No readable OTEL span store" note — persisting that
//   as an empty day would turn a transient read failure into a permanent false "nothing happened").
// - A sidecar whose segment no longer exists (retention purge) is dropped, so the index never
//   answers with history the store itself has forgotten.
// - Assembly dedupes by request identity: a day-edge span can be visited by two adjacent builds
//   (segment selection is min/max-ts overlap, not exact day), and dedupe is cheaper than proving
//   it never happens.
// - Midnight skew caveat: an event whose ts is late-day-D but which lands in day-D+1's segment
//   after day-D's sidecar was built is missed until that sidecar is rebuilt. The skew between an
//   event's ts and its append is seconds (collector wall-clock), and sidecars for D are built on
//   the first query AFTER D ends, so the race window is effectively empty — accepted, documented.

import * as fs from 'fs'
import * as path from 'path'
import {
  scanOtelCallEvents,
  type OtelCallEvent, type OtelCompactionEvent, type OtelScanCoverage, type OtelScanOptions,
} from './otelCallEvents'
import { dataPath } from './dataDir'

const DAY_MS = 86_400_000
const SIDECAR_VERSION = 1

interface DaySidecar {
  version: number
  day: string
  builtAt: number
  spansScanned: number
  events: OtelCallEvent[]
  compactions: OtelCompactionEvent[]
}

export interface IndexedScanOptions extends OtelScanOptions {
  /** Test override; default `<spansDir>/.call-events-index`. */
  indexDir?: string
}

function utcDayKey(ms: number): string { return new Date(ms).toISOString().slice(0, 10) }
function dayStartMs(day: string): number { return Date.parse(`${day}T00:00:00Z`) }

/** The store's own filename shape (segmentedSpanStore.segmentDayMs) — day files only, calendar-valid. */
function segmentDayOf(filename: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}\.ndjson(\.gz)?$/.test(filename)) return null
  const day = filename.slice(0, 10)
  const ms = dayStartMs(day)
  if (!Number.isFinite(ms) || utcDayKey(ms) !== day) return null
  return day
}

function eventKey(e: OtelCallEvent): string {
  return e.requestId ?? `${e.sessionId}:${e.ts}:${e.model ?? ''}:${e.outputTokens}`
}
function compactionKey(c: OtelCompactionEvent): string {
  return `${c.sessionId}:${c.ts}:${c.trigger ?? ''}`
}

function readSidecar(file: string): DaySidecar | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as DaySidecar
    if (raw.version !== SIDECAR_VERSION || !Array.isArray(raw.events) || !Array.isArray(raw.compactions)) return null
    return raw
  } catch {
    return null // absent or corrupt — rebuilt below; a bad sidecar must never poison an answer
  }
}

function writeSidecarAtomic(file: string, sidecar: DaySidecar): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(sidecar))
  fs.renameSync(tmp, file)
}

/**
 * Same contract and return shape as scanOtelCallEvents, served incrementally: sealed days come from
 * (or are extracted once into) per-day sidecars; only today's live segment is parsed per call.
 * Never throws (matches the underlying scan's documented contract).
 */
export async function scanOtelCallEventsIndexed(opts: IndexedScanOptions = {}): Promise<{
  events: OtelCallEvent[]
  compactions: OtelCompactionEvent[]
  coverage: OtelScanCoverage
}> {
  const spansDir = opts.spansDir ?? dataPath('spans')
  const indexDir = opts.indexDir ?? path.join(spansDir, '.call-events-index')
  const now = opts.nowMs ?? Date.now()
  const until = opts.untilMs ?? now
  const since = opts.sinceMs ?? (opts.windowHours ? now - opts.windowHours * 3_600_000 : 0)
  const todayStart = dayStartMs(utcDayKey(now))

  let names: string[]
  try {
    names = fs.readdirSync(spansDir)
  } catch {
    // No store yet — identical answer to the direct scan on a fresh install.
    return scanOtelCallEvents({ ...opts, spansDir })
  }

  const daysOnDisk = new Set<string>()
  for (const n of names) {
    const d = segmentDayOf(n)
    if (d !== null) daysOnDisk.add(d)
  }

  // Drop sidecars for days the store no longer holds (retention purge) — the index must never
  // remember what the store forgot.
  try {
    for (const n of fs.readdirSync(indexDir)) {
      const m = /^(\d{4}-\d{2}-\d{2})\.calls\.json$/.exec(n)
      if (m && !daysOnDisk.has(m[1])) {
        try { fs.unlinkSync(path.join(indexDir, n)) } catch { /* next call retries */ }
      }
    }
  } catch { /* no index dir yet */ }

  const sealedInRange = [...daysOnDisk]
    .filter(d => {
      const start = dayStartMs(d)
      return start < todayStart && start <= until && start + DAY_MS > since
    })
    .sort()

  const events = new Map<string, OtelCallEvent>()
  const compactions = new Map<string, OtelCompactionEvent>()
  let sidecarSpansScanned = 0
  let servedFromIndex = 0
  let builtThisCall = 0
  let unreadableDays = 0

  for (const day of sealedInRange) {
    const file = path.join(indexDir, `${day}.calls.json`)
    let sc = readSidecar(file)
    if (sc === null) {
      const start = dayStartMs(day)
      const r = await scanOtelCallEvents({ spansDir, sinceMs: start, untilMs: start + DAY_MS - 1, nowMs: now })
      if (r.coverage.note.includes('No readable OTEL span store')) {
        // Transient read failure — answer degrades for this day this call, but nothing false is
        // persisted; the next call retries the build.
        unreadableDays += 1
        continue
      }
      sc = {
        version: SIDECAR_VERSION, day, builtAt: now,
        spansScanned: r.coverage.spansScanned, events: r.events, compactions: r.compactions,
      }
      try { writeSidecarAtomic(file, sc) } catch { /* still answer from the in-memory build */ }
      builtThisCall += 1
    } else {
      servedFromIndex += 1
    }
    sidecarSpansScanned += sc.spansScanned
    for (const e of sc.events) if (e.ts >= since && e.ts <= until) events.set(eventKey(e), e)
    for (const c of sc.compactions) if (c.ts >= since && c.ts <= until) compactions.set(compactionKey(c), c)
  }

  // The live (today's) segment is the only per-call parse. Its lower bound never reaches into
  // sealed days: those are the index's job, and letting the live scan overlap yesterday would
  // re-parse a whole sealed segment on every call — the exact cost this module removes.
  let liveCoverage: OtelScanCoverage | null = null
  const liveSince = Math.max(since, todayStart)
  if (until >= liveSince) {
    const live = await scanOtelCallEvents({ spansDir, sinceMs: liveSince, untilMs: until, nowMs: now })
    liveCoverage = live.coverage
    for (const e of live.events) if (e.ts >= since && e.ts <= until) events.set(eventKey(e), e)
    for (const c of live.compactions) if (c.ts >= since && c.ts <= until) compactions.set(compactionKey(c), c)
  }

  const outEvents = [...events.values()].sort((x, y) => x.ts - y.ts)
  const outCompactions = [...compactions.values()].sort((x, y) => x.ts - y.ts)
  const liveScanned = liveCoverage?.spansScanned ?? 0
  return {
    events: outEvents,
    compactions: outCompactions,
    coverage: {
      spansDir, windowHours: opts.windowHours,
      spansScanned: sidecarSpansScanned + liveScanned,
      apiRequests: outEvents.length,
      compactions: outCompactions.length,
      note: `Call-events index: ${servedFromIndex} sealed day(s) served from sidecars, ${builtThisCall} extracted this call` +
        (unreadableDays > 0 ? `, ${unreadableDays} day(s) UNREADABLE this call (retried next call)` : '') +
        `; live segment parsed ${liveScanned} candidate line(s). ${outEvents.length} api_request event(s) carry session.id + cost_usd directly.`,
    },
  }
}
