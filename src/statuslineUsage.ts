/**
 * Ingests the Claude Code statusline usage log — an AUTHORITATIVE, rate-limit-free source of the
 * exact per-turn token buckets, context-window occupancy and cumulative cost that Claude Code hands
 * its statusline every turn. The statusline script (~/.claude/statusline.py, write_usage_jsonl)
 * appends ONE JSON line per turn to a SINGLE shared file; every concurrent Claude instance appends
 * to the same file with an atomic O_APPEND single-write, so this reader just tails it by byte offset.
 *
 * Why a second source when the transcript .jsonl parser already reads token usage: the statusline
 * numbers come straight from the API response (context_window.used_percentage, context_window_size,
 * cost.total_cost_usd) with NO server query and NO pricing-table estimate. So they are authoritative
 * for CONTEXT SIZE and COST. The transcript .jsonl parser stays the source for cumulative token
 * buckets and per-source composition drill-down (the statusline carries no composition breakdown, and
 * its ≤1/10s throttle means it can miss fast turns — hence we never SUM its lines for cumulative
 * totals; we take latest-wins snapshots + the max observed context occupancy).
 */

import type { SessionSummaryCard, StatuslineUsageAgg } from './shared/summarizerTypes'
import type { StatuslineBillingEvent } from './burnMonitor'

/** One window of Claude Code's own rate_limits block, as statusline.py surfaces it (utilization is a
 *  0-100 float; resets_at is carried by CC but unused here). Optional throughout — a statusline build
 *  that predates rate_limits emission simply omits the whole block. */
interface StatuslineRateLimitWindow {
  utilization?: number
}

/** One raw line of the shared statusline-usage.jsonl (mirrors statusline.py's write_usage_jsonl). */
interface StatuslineUsageRecord {
  ts: number
  session_id: string
  project_dir: string
  model: string
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  total_input_tokens: number
  total_output_tokens: number
  context_window_size: number
  used_percentage: number
  total_cost_usd: number
  // TRDD-VY1IUVUM Part-5: Claude Code's own authoritative window fill, present ONLY when the
  // statusline build persists rate_limits into the usage log (it reads it from the CC input JSON but
  // older builds don't re-emit it). Absent → getLatestRateLimits() returns null and get_account_status
  // falls back to AgentlensPro's own calibrated pct. NEVER a guess — an absent block is reported as null.
  rate_limits?: {
    five_hour?: StatuslineRateLimitWindow
    seven_day?: StatuslineRateLimitWindow
  }
}

/** TRDD-VY1IUVUM Part-5 — the latest observed Claude-Code-authoritative window utilization. Both
 *  fields are 0-100 or null (null = that window was absent in the record — never presented as 0). The
 *  ts is the record's own timestamp so a consumer can judge staleness. This is the AUTHORITATIVE
 *  5h/7d fill source (get_account_status prefers it over the calibrated estimate when present). */
export interface RateLimitsSnapshot {
  ts: number
  fiveHourUtilization: number | null
  sevenDayUtilization: number | null
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Like num() but returns null (not 0) for an unresolvable value — the honest "absent" for a
 *  utilization figure, so a missing window is never silently reported as 0% consumed. */
function numOrNull(v: unknown): number | null {
  if (v == null) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Project ONE captured status-line payload onto the flat record the aggregates are built from.
 *
 * This mapping used to live in ~/.claude/statusline.py (`write_usage_jsonl`), which is exactly why it
 * had to move here: that script was replaced on 2026-07-31 20:28, its replacement dropped the writer,
 * and this module's "authoritative, rate-limit-free" source silently froze for 23 hours. It also only
 * ever emitted 13 hand-picked fields and NEVER `rate_limits` — which is why getLatestRateLimits()
 * returned null and get_account_status fell back to a calibrated guess. Owning the projection means
 * the product's data no longer depends on a user's personal script.
 *
 * `ts` is deliberately epoch SECONDS: getBillingEvents prunes against a seconds cutoff and
 * burnMonitor.toMs() re-normalises (`ts < 1e12 ? ts*1000 : ts`). Emitting ms here would make every
 * event look ~55,000 years old and silently prune the entire billing stream.
 */
export function recordFromStatuslinePayload(payload: Record<string, unknown>, tsMs: number = Date.now()): StatuslineUsageRecord | null {
  const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})
  const sid = payload?.session_id
  if (typeof sid !== 'string' || sid === '') return null
  const cw = obj(payload.context_window)
  const cu = obj(cw.current_usage)
  const cost = obj(payload.cost)
  const ws = obj(payload.workspace)
  const rl = obj(payload.rate_limits)
  const five = obj(rl.five_hour)
  const seven = obj(rl.seven_day)
  const rec: StatuslineUsageRecord = {
    ts: Math.floor(tsMs / 1000),
    session_id: sid,
    project_dir: String(ws.project_dir ?? ws.current_dir ?? payload.cwd ?? ''),
    model: String(obj(payload.model).display_name ?? ''),
    input_tokens: num(cu.input_tokens),
    output_tokens: num(cu.output_tokens),
    cache_creation_input_tokens: num(cu.cache_creation_input_tokens),
    cache_read_input_tokens: num(cu.cache_read_input_tokens),
    total_input_tokens: num(cw.total_input_tokens),
    total_output_tokens: num(cw.total_output_tokens),
    context_window_size: num(cw.context_window_size),
    used_percentage: num(cw.used_percentage),
    total_cost_usd: num(cost.total_cost_usd),
  }
  // The live payload spells this `used_percentage`; `utilization` is the legacy CC API name the
  // record type carries. Accept either, and attach the block ONLY when a window really reported a
  // number — an absent window must stay null, never 0% consumed.
  const f = numOrNull(five.used_percentage ?? five.utilization)
  const s = numOrNull(seven.used_percentage ?? seven.utilization)
  if (f !== null || s !== null) {
    rec.rate_limits = {
      ...(f !== null ? { five_hour: { utilization: f } } : {}),
      ...(s !== null ? { seven_day: { utilization: s } } : {}),
    }
  }
  return rec
}

/**
 * Tails the single shared statusline usage log by byte offset and aggregates it per session, then
 * OVERLAYS the authoritative context size + cost onto a SessionSummaryCard. One instance is kept per
 * ingestion context (extension host, standalone server); overlay() self-refreshes on a throttle so
 * the caller only needs to invoke it right before persisting/serving each card.
 */
export class StatuslineUsageReader {
  private readonly agg = new Map<string, StatuslineUsageAgg>()
  // Per-turn billing deltas for the burn monitor (TRDD-OG9PARZQ). Each ingested line yields one event:
  // deltaCostUsd = the increment of the session's cumulative authoritative cost; deltaTokens = that
  // turn's 4 usage buckets summed. Bounded to the last 7 days + a hard cap so the firehose can't grow
  // it without limit. This is the machine-wide, rate-limit-free window-budget source.
  private billingEvents: StatuslineBillingEvent[] = []
  private static readonly BILLING_MAX = 100_000
  private static readonly BILLING_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000
  // TRDD-VY1IUVUM Part-5: latest-wins snapshot of Claude Code's own rate_limits utilization. Only a
  // record carrying a rate_limits block updates it; a rotated/shrunk file resets it to null (below).
  private latestRateLimits: RateLimitsSnapshot | null = null
  // Per-session, because the machine-wide snapshot above cannot be attributed: several accounts run
  // concurrently here and each reports its OWN window. See getRateLimitsForSessions.
  private readonly rateLimitsBySession = new Map<string, RateLimitsSnapshot>()

  /** Ingest ONE captured status-line payload — the single entry point.
   *
   *  This replaced a byte-offset tail of a shared JSONL file. That file's only writer was a function
   *  in the user's personal ~/.claude/statusline.py, so when the script was replaced the "reader"
   *  went on running against a frozen file and every aggregate quietly went stale. Samples are now
   *  pushed in as the server ingests them: no file, no offset, no rotation handling, and no
   *  dependence on anything outside this product.
   *
   *  Never throws — a malformed sample is skipped. It is one point in a 3-second series. */
  ingestSample(payload: Record<string, unknown>, tsMs: number = Date.now()): void {
    try {
      const rec = recordFromStatuslinePayload(payload, tsMs)
      if (rec) this._ingest(rec)
    } catch { /* one bad sample must never break ingestion */ }
  }

  private _ingest(rec: StatuslineUsageRecord): void {
    const sid = rec.session_id
    if (!sid) return
    const totalInput = num(rec.total_input_tokens)
    const a: StatuslineUsageAgg = this.agg.get(sid) ?? {
      sessionId: sid, projectDir: '', model: '',
      lastInputTokens: 0, lastOutputTokens: 0, lastCacheCreateTokens: 0, lastCacheReadTokens: 0,
      lastTotalInputTokens: 0, lastTotalOutputTokens: 0,
      contextWindowSize: 0, usedPercentage: 0, totalCostUsd: 0,
      peakContextTokens: 0, samples: 0, lastTs: 0,
    }
    // Billing delta for the burn monitor (before mutating the aggregate): the increment of the
    // cumulative authoritative cost, and this turn's 4 usage buckets summed. total_cost_usd is
    // cumulative, so the delta is real incremental spend; a rotated/shrunk file resets prevCost to 0
    // (agg was cleared in refresh()), so the first line after a reset counts from 0 (over-counts at
    // most one turn — acceptable, and never negative).
    const prevCost = a.totalCostUsd
    const newCost = num(rec.total_cost_usd)
    // This turn's 4 usage buckets — carried individually so the burn breakdown can attribute the split
    // (cache-read is ~96% of the count on real workloads). deltaTokens is their sum, matching the
    // api_request event convention.
    const dInput = num(rec.input_tokens)
    const dOutput = num(rec.output_tokens)
    const dCacheCreate = num(rec.cache_creation_input_tokens)
    const dCacheRead = num(rec.cache_read_input_tokens)
    const deltaTokens = dInput + dOutput + dCacheCreate + dCacheRead
    const deltaCost = Math.max(0, newCost - prevCost)
    if (deltaTokens > 0 || deltaCost > 0) {
      this.billingEvents.push({
        ts: num(rec.ts), sessionId: sid, workspace: rec.project_dir || undefined,
        deltaCostUsd: deltaCost, deltaTokens,
        deltaInput: dInput, deltaOutput: dOutput, deltaCacheRead: dCacheRead, deltaCacheCreate: dCacheCreate,
      })
    }

    // Latest-wins for the snapshot fields (lines are appended in time order; the ts guard keeps a
    // late/out-of-order line from clobbering a newer snapshot).
    if (num(rec.ts) >= a.lastTs) {
      a.lastTs = num(rec.ts)
      a.projectDir = rec.project_dir || a.projectDir
      a.model = rec.model || a.model
      a.lastInputTokens = num(rec.input_tokens)
      a.lastOutputTokens = num(rec.output_tokens)
      a.lastCacheCreateTokens = num(rec.cache_creation_input_tokens)
      a.lastCacheReadTokens = num(rec.cache_read_input_tokens)
      a.lastTotalInputTokens = totalInput
      a.lastTotalOutputTokens = num(rec.total_output_tokens)
      a.contextWindowSize = num(rec.context_window_size)
      a.usedPercentage = num(rec.used_percentage)
      a.totalCostUsd = num(rec.total_cost_usd)
    }
    a.peakContextTokens = Math.max(a.peakContextTokens, totalInput)
    a.samples += 1
    this.agg.set(sid, a)

    // TRDD-VY1IUVUM Part-5: latest-wins capture of CC's authoritative window utilization. The block
    // is absent on older statusline builds — only update when present, and only when this record is
    // at least as new as the last one seen (guards a late/out-of-order line clobbering a fresher
    // snapshot, mirroring the aggregate's ts guard above). Machine-wide (not per-session): the
    // rate-limit window is per-ACCOUNT, and every session on the account shares the same fill.
    if (rec.rate_limits) {
      const recTs = num(rec.ts)
      const five = numOrNull(rec.rate_limits.five_hour?.utilization)
      const seven = numOrNull(rec.rate_limits.seven_day?.utilization)
      if (five !== null || seven !== null) {
        const snap: RateLimitsSnapshot = { ts: recTs, fiveHourUtilization: five, sevenDayUtilization: seven }
        if (this.latestRateLimits === null || recTs >= this.latestRateLimits.ts) this.latestRateLimits = snap
        // Also keyed by session, so a caller that knows which sessions belong to the account it is
        // reporting on can get THAT account's window instead of whichever session sampled last.
        const prev = this.rateLimitsBySession.get(sid)
        if (!prev || recTs >= prev.ts) this.rateLimitsBySession.set(sid, snap)
      }
    }
  }

  /** TRDD-VY1IUVUM Part-5: the latest Claude-Code-authoritative window utilization, or null when no
   *  ingested record has carried a rate_limits block (an older statusline build, or none yet). Refreshes
   *  the tail first (throttled) so get_account_status always reflects the newest persisted line. */
  getLatestRateLimits(): RateLimitsSnapshot | null {
    return this.latestRateLimits
  }

  /** The newest window reading among a GIVEN set of sessions — the account-safe accessor.
   *
   *  MEASURED 2026-08-01: 13 concurrent sessions on this machine reported EIGHT distinct (5h, 7d)
   *  pairs, i.e. at least four different accounts were live at once. The machine-wide latest-wins
   *  snapshot therefore returns whichever session happened to sample last, and a caller that labels
   *  it with "the current account" prints one account's utilization under another's name — the exact
   *  mis-attribution that made `get_subscription_usage` untrustworthy. Callers that know which
   *  sessions belong to the account they are reporting on MUST use this instead.
   *
   *  Returns null when none of those sessions has reported a window — absent, never a stand-in. */
  getRateLimitsForSessions(sessionIds: Iterable<string>): RateLimitsSnapshot | null {
    let best: RateLimitsSnapshot | null = null
    for (const sid of sessionIds) {
      const snap = this.rateLimitsBySession.get(sid)
      if (snap && (best === null || snap.ts >= best.ts)) best = snap
    }
    return best
  }

  /** Returns the aggregate for a session, or undefined if it never wrote a statusline line. */
  get(sessionId: string): StatuslineUsageAgg | undefined {
    return this.agg.get(sessionId)
  }

  /** Per-turn billing deltas for the burn monitor, pruned to the last ~8 days + a hard cap. Refreshes
   *  the tail first so the caller always gets current data (cheap — throttled). */
  getBillingEvents(now = Date.now()): StatuslineBillingEvent[] {
    const cutoffSec = (now - StatuslineUsageReader.BILLING_MAX_AGE_MS) / 1000
    if (this.billingEvents.length > StatuslineUsageReader.BILLING_MAX || this.billingEvents.some(e => e.ts < cutoffSec)) {
      this.billingEvents = this.billingEvents
        .filter(e => e.ts >= cutoffSec)
        .slice(-StatuslineUsageReader.BILLING_MAX)
    }
    return this.billingEvents
  }

  /**
   * Mutates the card in place: attaches the authoritative statusline aggregate and raises
   * peakContextPerTurn to the exact context occupancy the statusline observed. Cost is applied at
   * write time (DatabaseWriter reads card.statusline.totalCostUsd). No-op when this session has no
   * statusline data. Self-refreshes on a throttle so the caller need not manage freshness.
   */
  overlay(card: SessionSummaryCard): void {
    const a = this.agg.get(card.sessionId)
    if (!a) return
    card.statusline = a
    // Context size: each statusline observation is exact, so take the max — a throttle-dropped turn
    // can never lower a peak the transcript parser (or an earlier statusline line) already saw.
    card.peakContextPerTurn = Math.max(card.peakContextPerTurn ?? 0, a.peakContextTokens)
  }
}
