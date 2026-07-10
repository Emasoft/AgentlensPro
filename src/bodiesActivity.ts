// BodiesActivityTracker — realtime incremental watch over the raw OTEL bodies dir
// (TRDD-GOD0108C). Response bodies land as files the instant calls complete and carry
// Anthropic's EXACT usage (cache_creation/cache_read) + model — the only realtime feed
// that can see the "invalidating most of the cache EVERY turn" pattern (CACHE_THRASH,
// the lean-ctx strip-in-place class from the 2026-07-10 incident).
//
// Why incremental: the previous HUGE_REQUEST_BURST scan readdir'd AND stat'd every file
// on every check — ~22k stats on a hot 72h dir, far too slow to sit behind a PreToolUse
// gate. Bodies are WRITE-ONCE (the collector never rewrites a body file), so a name seen
// once can never become "new" again: readdir + stat ONLY unseen names is exact, not a
// heuristic. First poll pays one full pass to seed; every later poll is O(new files).

import * as fs from 'fs'
import * as path from 'path'

export interface ThrashReport {
  active: boolean
  /** Responses inside the window that re-wrote a big prefix while reading ~no cache. */
  count: number
  /** Sum of cache_creation tokens across those responses — what got re-billed at write rate. */
  rebilledTokens: number
  /** The model seen most among thrashing responses, when any. */
  model: string | null
  windowMs: number
}

export interface BodiesActivityReport {
  available: boolean
  hugeRequests90s: { count: number; bytes: number }
  thrash: ThrashReport
  /** Share of the last-5min responses on premium models (opus/fable/mythos), for fan-out hints. */
  premium: { share: number; sampled: number; lastModel: string | null }
}

export interface BodiesActivityOptions {
  /** cache_creation above this marks a response as a big prefix write (default 100k). */
  thrashMinCc?: number
  /** cache_read share of (creation+read) below this marks the write as a MISS (default 0.25). */
  thrashMaxReadShare?: number
  /** Misses inside the window that flip thrash.active (default 3). */
  thrashMinCount?: number
  /** Thrash observation window (default 5min). */
  thrashWindowMs?: number
}

const RESPONSE_PARSE_CAP = 5 * 1024 * 1024 // a response body bigger than this is pathological — skip, never block
const HUGE_REQUEST_BYTES = 1_000_000
const LARGE_RING_WINDOW_MS = 10 * 60_000
const RESPONSE_RING_WINDOW_MS = 15 * 60_000
const SEED_LOOKBACK_MS = 15 * 60_000
const PREMIUM_RE = /opus|fable|mythos/i

interface LargeRequestEntry { t: number; bytes: number }
interface ResponseEntry { t: number; model: string | null; cc: number; cr: number }

/** Tolerant usage extraction — the raw response is the API JSON, but stay shape-lenient. */
export function extractResponseUsage(j: unknown): { model: string | null; cc: number; cr: number } | null {
  if (!j || typeof j !== 'object') return null
  const o = j as Record<string, unknown>
  const cand = [o, o.response, o.body].find(
    (x): x is Record<string, unknown> => !!x && typeof x === 'object' && typeof (x as Record<string, unknown>).usage === 'object',
  )
  const usage = cand?.usage as Record<string, unknown> | undefined
  if (!usage) return null
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return {
    model: typeof cand?.model === 'string' ? (cand.model as string) : null,
    cc: n(usage.cache_creation_input_tokens),
    cr: n(usage.cache_read_input_tokens),
  }
}

export class BodiesActivityTracker {
  private readonly dir: string
  private readonly opts: Required<BodiesActivityOptions>
  private seen = new Set<string>()
  private seeded = false
  private largeRequests: LargeRequestEntry[] = []
  private responses: ResponseEntry[] = []

  constructor(dir: string, opts: BodiesActivityOptions = {}) {
    this.dir = dir
    this.opts = {
      thrashMinCc: Math.max(1_000, opts.thrashMinCc ?? 100_000),
      thrashMaxReadShare: Math.min(0.9, Math.max(0, opts.thrashMaxReadShare ?? 0.25)),
      thrashMinCount: Math.max(2, opts.thrashMinCount ?? 3),
      thrashWindowMs: Math.max(60_000, opts.thrashWindowMs ?? 300_000),
    }
  }

  /** One incremental pass. Every error path is fail-open: worst case the report says quiet. */
  poll(now: number = Date.now()): void {
    let names: string[]
    try {
      names = fs.readdirSync(this.dir)
    } catch {
      return // dir absent — report() will say available:false
    }
    const seedFloor = this.seeded ? 0 : now - SEED_LOOKBACK_MS
    for (const name of names) {
      if (this.seen.has(name)) continue
      this.seen.add(name)
      const isReq = name.endsWith('.request.json')
      const isResp = name.endsWith('.response.json')
      if (!isReq && !isResp) continue
      let st: fs.Stats
      try {
        st = fs.statSync(path.join(this.dir, name))
      } catch {
        continue // raced with the archiver
      }
      if (st.mtimeMs < seedFloor) continue // pre-boot history beyond the seed window
      if (isReq) {
        if (st.size > HUGE_REQUEST_BYTES) this.largeRequests.push({ t: st.mtimeMs, bytes: st.size })
        continue
      }
      if (st.size > RESPONSE_PARSE_CAP) continue
      try {
        const u = extractResponseUsage(JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf-8')))
        if (u) this.responses.push({ t: st.mtimeMs, model: u.model, cc: u.cc, cr: u.cr })
      } catch {
        /* truncated mid-write or not JSON — skip */
      }
    }
    this.seeded = true
    this.prune(now)
    // The hourly archiver removes old files; when the listing shrinks well below the seen
    // set, rebuild it from the live listing so memory stays bounded to the dir's contents.
    if (this.seen.size > names.length * 2 + 512) this.seen = new Set(names)
  }

  private prune(now: number): void {
    // Unconditional filter: entries arrive in readdir order, NOT mtime order, so a
    // "check the head, skip the pass" shortcut could strand old entries forever.
    // Rings hold minutes of traffic — the filter is O(hundreds), not worth a shortcut.
    const lFloor = now - LARGE_RING_WINDOW_MS
    const rFloor = now - RESPONSE_RING_WINDOW_MS
    this.largeRequests = this.largeRequests.filter(e => e.t >= lFloor)
    this.responses = this.responses.filter(e => e.t >= rFloor)
  }

  report(now: number = Date.now()): BodiesActivityReport {
    const available = fs.existsSync(this.dir)
    this.prune(now)

    let hugeCount = 0
    let hugeBytes = 0
    for (const e of this.largeRequests) {
      if (now - e.t <= 90_000) { hugeCount++; hugeBytes += e.bytes }
    }

    const misses = this.responses.filter(e => {
      if (now - e.t > this.opts.thrashWindowMs) return false
      const denom = e.cc + e.cr
      return e.cc > this.opts.thrashMinCc && denom > 0 && e.cr / denom < this.opts.thrashMaxReadShare
    })
    const byModel = new Map<string, number>()
    let rebilled = 0
    for (const m of misses) {
      rebilled += m.cc
      if (m.model) byModel.set(m.model, (byModel.get(m.model) ?? 0) + 1)
    }
    const topModel = [...byModel.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null

    const recent = this.responses.filter(e => now - e.t <= 300_000)
    const premiumCount = recent.filter(e => e.model && PREMIUM_RE.test(e.model)).length
    // Newest by mtime, not by array position — entries arrive in readdir order.
    const newest = recent.reduce<ResponseEntry | null>((a, e) => (a === null || e.t > a.t ? e : a), null)

    return {
      available,
      hugeRequests90s: { count: hugeCount, bytes: hugeBytes },
      thrash: {
        active: misses.length >= this.opts.thrashMinCount,
        count: misses.length,
        rebilledTokens: rebilled,
        model: topModel,
        windowMs: this.opts.thrashWindowMs,
      },
      premium: {
        share: recent.length > 0 ? premiumCount / recent.length : 0,
        sampled: recent.length,
        lastModel: newest?.model ?? null,
      },
    }
  }
}
