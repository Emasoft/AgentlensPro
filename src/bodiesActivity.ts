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

/** One fat-request SENDER, aggregated by session — the attribution unit for culprit naming.
 *  session comes from the request tail's metadata.user_id (exact); a null session means the
 *  bounded read couldn't attribute it, and messages must say so instead of guessing. */
export interface FatRequestSender {
  session: string | null
  model: string | null
  count: number
  bytes: number
}

/** One consistent, concise culprit string for warnings: top-2 senders + "+N more".
 *  e.g. `session 249c4216… (claude-fable-5, 4 fat requests ~13.9MB)` — the essential
 *  who/what/how-much without flooding a one-line hook message. */
export function fmtFatSenders(senders: FatRequestSender[], cap = 2): string {
  if (senders.length === 0) return 'no fat-request sender attributable'
  const parts = senders.slice(0, cap).map(s => {
    const who = s.session ? `session ${s.session.slice(0, 8)}…` : 'unattributed sender(s)'
    const model = s.model ? `${s.model}, ` : ''
    return `${who} (${model}${s.count} fat request${s.count === 1 ? '' : 's'} ~${(s.bytes / 1e6).toFixed(1)}MB)`
  })
  const more = senders.length > cap ? `; +${senders.length - cap} more` : ''
  return parts.join('; ') + more
}

export interface ThrashReport {
  active: boolean
  /** Responses inside the window that re-wrote a big prefix while reading ~no cache. */
  count: number
  /** Sum of cache_creation tokens across those responses — what got re-billed at write rate. */
  rebilledTokens: number
  /** The model seen most among thrashing responses, when any. */
  model: string | null
  windowMs: number
  /** LIKELY sources: fat-request senders inside the window. Responses carry no session id,
   *  so this is inference from concurrent ≥400KB requests — callers must label it "likely". */
  suspects: FatRequestSender[]
}

export interface BodiesActivityReport {
  available: boolean
  hugeRequests90s: { count: number; bytes: number; senders: FatRequestSender[] }
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
// Attribution floor: a 100k-token cache write ≈ a ~400KB request, so fat-but-not-huge
// requests still get their sender extracted — that's what lets thrash suspects be named.
const ATTRIB_REQUEST_BYTES = 400_000
const LARGE_RING_WINDOW_MS = 10 * 60_000
const RESPONSE_RING_WINDOW_MS = 15 * 60_000
const SEED_LOOKBACK_MS = 15 * 60_000
const PREMIUM_RE = /opus|fable|mythos/i

interface LargeRequestEntry { t: number; bytes: number; huge: boolean; sessionId: string | null; model: string | null }
interface ResponseEntry { t: number; model: string | null; cc: number; cr: number }

/**
 * Bounded 6KB attribution read on a fat request body — verified layout on real bodies:
 * `"model"` sits in the first 2KB and `metadata.user_id` (an ESCAPED JSON string carrying
 * session_id) in the last 4KB. `Primary working directory` sits ~92% in — NOT reachable by a
 * bounded tail — so workspace resolution is the hook-event ring's job (cwd), never this read.
 */
export function extractRequestAttribution(filePath: string, size: number): { sessionId: string | null; model: string | null } {
  let fd: number | null = null
  try {
    fd = fs.openSync(filePath, 'r')
    const head = Buffer.alloc(Math.min(2048, size))
    fs.readSync(fd, head, 0, head.length, 0)
    const tailLen = Math.min(4096, size)
    const tail = Buffer.alloc(tailLen)
    fs.readSync(fd, tail, 0, tailLen, size - tailLen)
    const model = /"model"\s*:\s*"([^"]+)"/.exec(head.toString('utf-8'))?.[1] ?? null
    // user_id is a STRING of escaped JSON: \"session_id\":\"<uuid>\" — accept both forms.
    const sessionId = /\\?"session_id\\?":\\?"([0-9a-fA-F-]{8,36})/.exec(tail.toString('utf-8'))?.[1] ?? null
    return { sessionId, model }
  } catch {
    return { sessionId: null, model: null } // unreadable — unattributed, never fatal
  } finally {
    if (fd !== null) try { fs.closeSync(fd) } catch { /* already closed */ }
  }
}

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
        if (st.size >= ATTRIB_REQUEST_BYTES) {
          this.largeRequests.push({
            t: st.mtimeMs,
            bytes: st.size,
            huge: st.size > HUGE_REQUEST_BYTES,
            ...extractRequestAttribution(path.join(this.dir, name), st.size),
          })
        }
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

  /** Aggregate fat-request entries by sending session, heaviest first. */
  private static senders(entries: LargeRequestEntry[]): FatRequestSender[] {
    const by = new Map<string, FatRequestSender>()
    for (const e of entries) {
      const key = e.sessionId ?? '(unattributed)'
      const s = by.get(key) ?? { session: e.sessionId, model: e.model, count: 0, bytes: 0 }
      s.count++
      s.bytes += e.bytes
      if (!s.model && e.model) s.model = e.model
      by.set(key, s)
    }
    return [...by.values()].sort((a, b) => b.bytes - a.bytes)
  }

  report(now: number = Date.now()): BodiesActivityReport {
    const available = fs.existsSync(this.dir)
    this.prune(now)

    const huge90 = this.largeRequests.filter(e => e.huge && now - e.t <= 90_000)
    let hugeCount = 0
    let hugeBytes = 0
    for (const e of huge90) { hugeCount++; hugeBytes += e.bytes }

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
      hugeRequests90s: { count: hugeCount, bytes: hugeBytes, senders: BodiesActivityTracker.senders(huge90) },
      thrash: {
        active: misses.length >= this.opts.thrashMinCount,
        count: misses.length,
        rebilledTokens: rebilled,
        model: topModel,
        windowMs: this.opts.thrashWindowMs,
        suspects: BodiesActivityTracker.senders(
          this.largeRequests.filter(e => now - e.t <= this.opts.thrashWindowMs)),
      },
      premium: {
        share: recent.length > 0 ? premiumCount / recent.length : 0,
        sampled: recent.length,
        lastModel: newest?.model ?? null,
      },
    }
  }
}
