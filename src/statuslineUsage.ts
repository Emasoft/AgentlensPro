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

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { SessionSummaryCard, StatuslineUsageAgg } from './shared/summarizerTypes'
import type { StatuslineBillingEvent } from './burnMonitor'

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
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * Resolves the SINGLE shared statusline usage log. Mirrors statusline.py's _agentlens_usage_log_path
 * byte-for-byte so writer and reader always agree on the path:
 *   1. $AGENTLENS_STATUSLINE_LOG (explicit full path override)
 *   2. <CLAUDE_CONFIG_DIR first entry, minus a trailing /projects>/agentlens/statusline-usage.jsonl
 *   3. ~/.claude/agentlens/statusline-usage.jsonl
 */
export function statuslineUsageLogPath(): string {
  const override = process.env['AGENTLENS_STATUSLINE_LOG']
  if (override) return override
  const cfg = process.env['CLAUDE_CONFIG_DIR']
  let base: string
  if (cfg) {
    let first = cfg.split(',')[0].trim()
    if (path.basename(first) === 'projects') first = path.dirname(first)
    base = first
  } else {
    base = path.join(os.homedir(), '.claude')
  }
  return path.join(base, 'agentlens', 'statusline-usage.jsonl')
}

/**
 * Tails the single shared statusline usage log by byte offset and aggregates it per session, then
 * OVERLAYS the authoritative context size + cost onto a SessionSummaryCard. One instance is kept per
 * ingestion context (extension host, standalone server); overlay() self-refreshes on a throttle so
 * the caller only needs to invoke it right before persisting/serving each card.
 */
export class StatuslineUsageReader {
  private readonly filePath: string
  private offset = 0
  private carry = ''                                   // partial trailing line held across reads
  private readonly agg = new Map<string, StatuslineUsageAgg>()
  private lastRefreshMs = 0
  // Per-turn billing deltas for the burn monitor (TRDD-OG9PARZQ). Each ingested line yields one event:
  // deltaCostUsd = the increment of the session's cumulative authoritative cost; deltaTokens = that
  // turn's 4 usage buckets summed. Bounded to the last 7 days + a hard cap so the firehose can't grow
  // it without limit. This is the machine-wide, rate-limit-free window-budget source.
  private billingEvents: StatuslineBillingEvent[] = []
  private static readonly BILLING_MAX = 100_000
  private static readonly BILLING_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000

  constructor(filePath?: string) {
    this.filePath = filePath ?? statuslineUsageLogPath()
  }

  /** Refreshes at most once per `throttleMs` — cheap enough to call before every card overlay. */
  refreshIfStale(throttleMs = 2000): void {
    const now = Date.now()
    if (now - this.lastRefreshMs < throttleMs) return
    this.lastRefreshMs = now
    this.refresh()
  }

  /** Reads only the bytes appended since the last read. Rebuilds from 0 if the file shrank (rotated). */
  refresh(): void {
    let size: number
    try {
      size = fs.statSync(this.filePath).size
    } catch {
      return  // no log yet — nothing to ingest
    }
    if (size < this.offset) {
      // File was truncated or rotated out from under us — restart the tail and the aggregate.
      this.offset = 0
      this.carry = ''
      this.agg.clear()
      this.billingEvents = []
    }
    if (size === this.offset) return

    let fd: number
    try {
      fd = fs.openSync(this.filePath, 'r')
    } catch {
      return
    }
    try {
      const len = size - this.offset
      const buf = Buffer.allocUnsafe(len)
      const read = fs.readSync(fd, buf, 0, len, this.offset)
      this.offset += read
      const text = this.carry + buf.toString('utf8', 0, read)
      const lines = text.split('\n')
      // The last element is either '' (chunk ended on a newline) or a partial line still being
      // written — hold it and prepend it to the next read so a line split across reads isn't dropped.
      this.carry = lines.pop() ?? ''
      for (const line of lines) {
        const t = line.trim()
        if (!t) continue
        let rec: StatuslineUsageRecord
        try {
          rec = JSON.parse(t) as StatuslineUsageRecord
        } catch {
          continue  // a torn line (should not happen with atomic appends) — skip it
        }
        this._ingest(rec)
      }
    } finally {
      fs.closeSync(fd)
    }
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
  }

  /** Returns the aggregate for a session, or undefined if it never wrote a statusline line. */
  get(sessionId: string): StatuslineUsageAgg | undefined {
    return this.agg.get(sessionId)
  }

  /** Per-turn billing deltas for the burn monitor, pruned to the last ~8 days + a hard cap. Refreshes
   *  the tail first so the caller always gets current data (cheap — throttled). */
  getBillingEvents(now = Date.now()): StatuslineBillingEvent[] {
    this.refreshIfStale()
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
    this.refreshIfStale()
    const a = this.agg.get(card.sessionId)
    if (!a) return
    card.statusline = a
    // Context size: each statusline observation is exact, so take the max — a throttle-dropped turn
    // can never lower a peak the transcript parser (or an earlier statusline line) already saw.
    card.peakContextPerTurn = Math.max(card.peakContextPerTurn ?? 0, a.peakContextTokens)
  }
}
