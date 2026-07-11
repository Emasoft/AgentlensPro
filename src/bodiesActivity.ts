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
  /** True only when ONE source session re-wrote its prefix ≥ thrashMinCount times in the window.
   *  N DISTINCT sessions' one-time cold-start writes are NOT thrash (see coldStartSessions) —
   *  the 2026-07-11 false positive classified 4 freshly-spawned agents' first prefix writes
   *  (~463k total) as thrash while the parent was reading its cache perfectly warm. */
  active: boolean
  /** Responses inside the window that re-wrote a big prefix while reading ~no cache (ALL sources). */
  count: number
  /** Sum of cache_creation tokens across those responses — what got re-billed at write rate. */
  rebilledTokens: number
  /** The model seen most among thrashing responses, when any. */
  model: string | null
  windowMs: number
  /** LIKELY sources: fat-request senders inside the window. When the thrashing session is
   *  attributed exactly (via the previous_message_id chain) the list is narrowed to it;
   *  otherwise this is inference from concurrent ≥400KB requests — callers label it "likely". */
  suspects: FatRequestSender[]
  /** The heaviest single miss source (session attributed via the previous_message_id chain;
   *  null session = the unattributed group). active keys off THIS group's count, never the total. */
  topSource: { session: string | null; count: number; rebilledTokens: number } | null
  /** FAN_OUT_COLD_START: DISTINCT attributed sessions whose in-window big writes stayed BELOW the
   *  same-session repeat threshold — N fresh agents each paying their one-time cold-start prefix
   *  write. Expected fan-out cost, advisory-only, never a reason to deny unrelated actions. */
  coldStartSessions: number
  coldStartRebilledTokens: number
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
interface ResponseEntry { t: number; model: string | null; cc: number; cr: number; id: string | null }

/**
 * Bounded 6KB attribution read on a fat request body — verified layout on real bodies:
 * `"model"` sits in the first 2KB and `metadata.user_id` (an ESCAPED JSON string carrying
 * session_id) plus `diagnostics.previous_message_id` (plain JSON, the response id of the
 * SAME session's previous call — the chain link that lets responses be attributed to their
 * source session) in the last 4KB. `Primary working directory` sits ~92% in — NOT reachable
 * by a bounded tail — so workspace resolution is the hook-event ring's job (cwd), never this read.
 */
export function extractRequestAttribution(filePath: string, size: number): { sessionId: string | null; model: string | null; previousMessageId: string | null } {
  let fd: number | null = null
  try {
    fd = fs.openSync(filePath, 'r')
    const head = Buffer.alloc(Math.min(2048, size))
    fs.readSync(fd, head, 0, head.length, 0)
    const tailLen = Math.min(4096, size)
    const tail = Buffer.alloc(tailLen)
    fs.readSync(fd, tail, 0, tailLen, size - tailLen)
    const tailStr = tail.toString('utf-8')
    const model = /"model"\s*:\s*"([^"]+)"/.exec(head.toString('utf-8'))?.[1] ?? null
    // user_id is a STRING of escaped JSON: \"session_id\":\"<uuid>\" — accept both forms.
    const sessionId = /\\?"session_id\\?":\\?"([0-9a-fA-F-]{8,36})/.exec(tailStr)?.[1] ?? null
    const previousMessageId = /"previous_message_id"\s*:\s*"(msg_[A-Za-z0-9]+)"/.exec(tailStr)?.[1] ?? null
    return { sessionId, model, previousMessageId }
  } catch {
    return { sessionId: null, model: null, previousMessageId: null } // unreadable — unattributed, never fatal
  } finally {
    if (fd !== null) try { fs.closeSync(fd) } catch { /* already closed */ }
  }
}

/** Tolerant usage extraction — the raw response is the API JSON, but stay shape-lenient.
 *  `id` (the msg_… response id) is what the previous_message_id chain attributes to a session. */
export function extractResponseUsage(j: unknown): { model: string | null; cc: number; cr: number; id: string | null } | null {
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
    id: typeof cand?.id === 'string' ? (cand.id as string) : null,
  }
}

export class BodiesActivityTracker {
  private readonly dir: string
  private readonly opts: Required<BodiesActivityOptions>
  private seen = new Set<string>()
  private seeded = false
  private largeRequests: LargeRequestEntry[] = []
  private responses: ResponseEntry[] = []
  // Response→session attribution via the previous_message_id chain: a request from session S
  // carrying previous_message_id=m proves response m belongs to S (the chain links calls WITHIN
  // one stream). Fed by the same bounded 6KB read the fat-request attribution already pays, so
  // attribution lags by exactly one call — fine for thrash (a thrashing session calls every few
  // seconds) and for the cold-resume warm-evidence check (the recovering session keeps working).
  private msgSession = new Map<string, { session: string; t: number }>()

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
          const attr = extractRequestAttribution(path.join(this.dir, name), st.size)
          this.largeRequests.push({
            t: st.mtimeMs,
            bytes: st.size,
            huge: st.size > HUGE_REQUEST_BYTES,
            sessionId: attr.sessionId,
            model: attr.model,
          })
          // Chain link: this request's previous_message_id names the SAME session's previous
          // response — the only realtime response→session attribution the bodies afford
          // (response bodies carry no metadata; request/response FILES share no basename).
          if (attr.sessionId && attr.previousMessageId) {
            this.msgSession.set(attr.previousMessageId, { session: attr.sessionId, t: st.mtimeMs })
          }
        }
        continue
      }
      if (st.size > RESPONSE_PARSE_CAP) continue
      try {
        const u = extractResponseUsage(JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf-8')))
        if (u) this.responses.push({ t: st.mtimeMs, model: u.model, cc: u.cc, cr: u.cr, id: u.id })
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
    // The chain map is keyed on request mtimes (always ≥ the response they attribute), so the
    // response-ring floor keeps every attribution a live response could still need.
    for (const [id, v] of this.msgSession) { if (v.t < rFloor) this.msgSession.delete(id) }
  }

  /** Resolve a response's source session via the previous_message_id chain, or null. */
  private sessionOf(e: ResponseEntry): string | null {
    return e.id ? this.msgSession.get(e.id)?.session ?? null : null
  }

  /**
   * Cold-resume disarm evidence (agentGate COLD_RESUME rules): did `session` complete a WARM
   * request after `sinceMs`? Warm = big cache_read with a small cache_creation share — proof the
   * session's prompt cache survived (or was already re-warmed), so holding the cold-resume deny
   * any longer only blocks legitimate work (measured 2026-07-11: 6 extra minutes of denials after
   * the stalled session was already reading 215-247k tokens from cache per call).
   */
  sessionWarmSince(session: string, sinceMs: number, warmReadFloor = 50_000): boolean {
    return this.responses.some(e =>
      e.t > sinceMs &&
      e.cr >= warmReadFloor && e.cc < e.cr * 0.25 &&
      this.sessionOf(e) === session)
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

    // Per-SOURCE attribution (2026-07-11 field fix): thrash = the SAME session re-writing its
    // prefix ≥ thrashMinCount times; N distinct sessions' single cold-start writes are a fan-out
    // paying its one-time cost, not thrash. Unattributed misses still pool into one pseudo-source
    // so a thrash whose requests we could not read is caught, never silently ignored — the ONLY
    // case that re-admits the old cross-session false positive is total attribution failure.
    const bySource = new Map<string | null, { count: number; cc: number }>()
    for (const m of misses) {
      const sid = this.sessionOf(m)
      const g = bySource.get(sid) ?? { count: 0, cc: 0 }
      g.count++
      g.cc += m.cc
      bySource.set(sid, g)
    }
    let topSource: ThrashReport['topSource'] = null
    let coldStartSessions = 0
    let coldStartRebilled = 0
    for (const [sid, g] of bySource) {
      if (topSource === null || g.count > topSource.count) {
        topSource = { session: sid, count: g.count, rebilledTokens: g.cc }
      }
      if (sid !== null && g.count < this.opts.thrashMinCount) {
        coldStartSessions++
        coldStartRebilled += g.cc
      }
    }
    const thrashActive = topSource !== null && topSource.count >= this.opts.thrashMinCount
    const windowLarge = this.largeRequests.filter(e => now - e.t <= this.opts.thrashWindowMs)
    // Exact culprit narrowing: when the thrashing source is an attributed session, name ITS fat
    // requests instead of every concurrent sender (an innocent fat parent must not be blamed).
    const culpritLarge = thrashActive && topSource?.session
      ? windowLarge.filter(e => e.sessionId === topSource.session)
      : windowLarge

    const recent = this.responses.filter(e => now - e.t <= 300_000)
    const premiumCount = recent.filter(e => e.model && PREMIUM_RE.test(e.model)).length
    // Newest by mtime, not by array position — entries arrive in readdir order.
    const newest = recent.reduce<ResponseEntry | null>((a, e) => (a === null || e.t > a.t ? e : a), null)

    return {
      available,
      hugeRequests90s: { count: hugeCount, bytes: hugeBytes, senders: BodiesActivityTracker.senders(huge90) },
      thrash: {
        active: thrashActive,
        count: misses.length,
        rebilledTokens: rebilled,
        model: topModel,
        windowMs: this.opts.thrashWindowMs,
        suspects: BodiesActivityTracker.senders(culpritLarge.length > 0 ? culpritLarge : windowLarge),
        topSource,
        coldStartSessions,
        coldStartRebilledTokens: coldStartRebilled,
      },
      premium: {
        share: recent.length > 0 ? premiumCount / recent.length : 0,
        sampled: recent.length,
        lastModel: newest?.model ?? null,
      },
    }
  }
}
