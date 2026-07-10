/**
 * Burn monitor — the "smoke detector" (TRDD-OG9PARZQ). Turns AgentLens from a post-mortem microscope
 * into a real-time alarm: rolling tokens/min + $/min burn rates (per session + global), a
 * rate-limit-window budget model (rolling 5h + weekly consumption vs a user-configurable capacity, with
 * a time-to-exhaustion projection), threshold alerts naming the session + dominant cause, and the two
 * agent-facing MCP status tools (get_burn_status / get_session_status).
 *
 * This module is PURE (no I/O beyond loadBurnConfig reading the optional config file): it takes the
 * already-ingested live data — OTEL `claude_code.api_request` timeline events (per-call cost + the 4
 * usage buckets + attribution, ingested since 7612ff5) and per-turn statusline billing deltas
 * (KT87QPM0, the authoritative rate-limit-free cost source) — and computes everything over it, so the
 * rolling-window math and alert logic are unit-testable in isolation. The server and the extension host
 * gather the events and call these functions from their MCP accessors + the SSE burn tick.
 */

import * as fs from 'fs'
import * as path from 'path'
import { calcTokenCostUsd } from './shared/pricing'
import { computeKeepWarm, type KeepWarmReport } from './shared/keepWarm'
import type { SessionSummaryCard, TimelineEntry, TokensSource } from './shared/summarizerTypes'

// ── Consumption events ─────────────────────────────────────────────────────────

/** One unified consumption event on the machine-wide timeline. `ts` is epoch MILLISECONDS. Sourced
 *  from a Claude Code api_request LOG event (rich: per-call cost + attribution) or a statusline billing
 *  delta (authoritative cost, no attribution). `tokens` is the billable total for that call/turn
 *  (input + output + cache-read + cache-create). */
export interface ConsumptionEvent {
  ts: number
  sessionId: string
  workspace?: string
  accountUuid?: string       // TRDD-BURNWDGT — the OAuth account that issued the call (card.accountId).
                             // Rate limits are per-account; the window budget groups by this so a rotated
                             // account never pools with the first. undefined ⇒ the "unknown" bucket.
  costUsd: number
  tokens: number
  source: 'api_request' | 'statusline'
  attribution?: string       // agent:… | skill:… | plugin:… | mcp:… | compaction | main (api_request only)
  // Per-bucket split (api_request only — statusline gives just the total). When present they sum to
  // `tokens`; when absent (statusline) the whole `tokens` is counted as `unknown` in a window breakdown.
  // This is THE data that answers "what consumes the tokens" — cache-read (resident context re-read every
  // turn) dominates real workloads, so a bare tokens/min hides the fact that ~96% is cheap cache reads.
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreateTokens?: number  // per-call cache-creation tokens (also drives the cache-create-spike alert)
}

/** Per-input-token-equivalent weights from Anthropic's PUBLIC price ratios (model-independent: output is
 *  5× input for both Sonnet 3/15 and Opus 15/75; cache-read is 0.1× input; 5-min cache-write is 1.25×).
 *  `billableWeightedPerMin` expresses burn as effective fresh-input tokens — i.e. cost, denominated in
 *  tokens. It is NOT the rate-limit-window weighting (Anthropic does not publish that); it exists so a
 *  reader can see past the cache-read count inflation to the real spend. `unknown` (statusline totals with
 *  no split) is weighted 1× — conservative (treats it as fresh input). */
export const BILLABLE_WEIGHTS = { input: 1, output: 5, cacheRead: 0.1, cacheCreate: 1.25, unknown: 1 } as const

/** Per-turn billing delta emitted by StatuslineUsageReader. `ts` is epoch MILLISECONDS (normalized from
 *  the statusline's epoch-seconds). `deltaCostUsd` is the increment of the session's cumulative
 *  authoritative cost; `deltaTokens` is that turn's 4 usage buckets summed. */
export interface StatuslineBillingEvent {
  ts: number
  sessionId: string
  workspace?: string
  deltaCostUsd: number
  deltaTokens: number
  // Per-turn buckets (the statusline reports all four). Carried so the burn BREAKDOWN is accurate for
  // statusline-sourced sessions — the common case when OTEL enhanced-telemetry is off, and exactly the
  // sessions the live burn monitor watches. When present they sum to `deltaTokens`.
  deltaInput?: number
  deltaOutput?: number
  deltaCacheRead?: number
  deltaCacheCreate?: number
}

// ── Config ─────────────────────────────────────────────────────────────────────

/** Alert threshold rules (spec 3). Each is a ceiling; crossing it raises an alert. */
export interface BurnThresholds {
  tokensPerMin: number         // global rolling-1-min tokens/min
  costPerHour: number          // global $/hr (from the rolling-5-min rate)
  windowPct: number            // % of a rate-limit window consumed (5h or 7d)
  cacheCreateSingleCall: number // a single api_request cache-creation ≥ N (one call re-wrote a huge prefix)
}

/** One account's AUTO-CALIBRATED capacity, measured at a premature rate-limit window end (P5).
 *  Every figure is a proven LOWER BOUND — the account consumed that much before Anthropic limited it —
 *  never an invented plan cap. Later, larger observations RAISE these values; they are never lowered
 *  automatically (a smaller later window proves nothing about the cap). */
export interface ObservedAccountCapacity {
  window5hTokens: number | null
  window7dTokens: number | null
  window5hCostUsd: number | null
  window7dCostUsd: number | null
  /** ISO timestamp of the observation that last RAISED a figure — the calibration date reported
   *  alongside `capacitySource: 'observed'`. */
  observedAt: string | null
}

/** Rate-limit-window capacities are USER-CONFIGURABLE (plans differ) — NEVER invented. When unset,
 *  consumption + rate are still reported but capacity/pct/projection are null (clearly labeled). */
export interface BurnConfig {
  window5hTokens: number | null
  window7dTokens: number | null
  // TRDD-BURNWDGT — OPTIONAL cost ($) capacities. When set, the window budget also reports a COST-based
  // pctConsumed (consumedCostUsd / cap) — the right metric when a plan's rate-limit window is billed by
  // cost, because cache-read (0.1×) barely counts there even though it dominates the raw token count.
  window5hCostUsd: number | null
  window7dCostUsd: number | null
  capacitySource: 'env' | 'config' | 'observed' | 'none'
  // P5 auto-calibration — per-account OBSERVED capacities (keyed by accountUuid), written by
  // capacityCalibration.ts when a rate-limit StopFailure ends a window prematurely. Consumed by
  // computeWindowBudget ONLY when no manual (env/file) cap is set — user config always wins.
  observed: Record<string, ObservedAccountCapacity>
  notify: boolean               // opt-in macOS notification (AGENTLENS_NOTIFY=1)
  thresholds: BurnThresholds
}

export const DEFAULT_THRESHOLDS: BurnThresholds = {
  tokensPerMin: 2_000_000,      // 2M tok/min is a firehose (the founding "all tokens in a minute" incident)
  costPerHour: 50,
  windowPct: 80,
  cacheCreateSingleCall: 200_000,
}

function numEnv(v: string | undefined): number | null {
  if (v === undefined || v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** The one place the burn-config file path is resolved — loadBurnConfig (read) and
 *  capacityCalibration (write) must never disagree on where the config lives. */
export function burnConfigPath(env: NodeJS.ProcessEnv, homeDir: string): string {
  return env['AGENTLENS_BURN_CONFIG'] || path.join(homeDir, '.agentlens', 'burn-config.json')
}

/** Parse the `observed` per-account map from the raw config file, keeping only entries with at least
 *  one positive figure (a junk entry must never flip capacitySource to 'observed'). */
function parseObservedCapacities(raw: unknown): Record<string, ObservedAccountCapacity> {
  const out: Record<string, ObservedAccountCapacity> = {}
  if (!raw || typeof raw !== 'object') return out
  const pos = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null)
  for (const [uuid, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!uuid || !v || typeof v !== 'object') continue
    const o = v as Record<string, unknown>
    const entry: ObservedAccountCapacity = {
      window5hTokens: pos(o.window5hTokens),
      window7dTokens: pos(o.window7dTokens),
      window5hCostUsd: pos(o.window5hCostUsd),
      window7dCostUsd: pos(o.window7dCostUsd),
      observedAt: typeof o.observedAt === 'string' ? o.observedAt : null,
    }
    if ((entry.window5hTokens ?? entry.window7dTokens ?? entry.window5hCostUsd ?? entry.window7dCostUsd) !== null) {
      out[uuid] = entry
    }
  }
  return out
}

/**
 * Loads the burn config from (in precedence order) env vars, then ~/.agentlens/burn-config.json, then
 * defaults. Capacity is null unless the user set it (env OR file) — we never fabricate a plan cap.
 * The one exception is the `observed` section: per-account capacities AUTO-CALIBRATED from real
 * rate-limit hits (P5) — measured lower bounds, not invented caps, and outranked by any manual cap.
 * env: AGENTLENS_WINDOW_5H_TOKENS, AGENTLENS_WINDOW_7D_TOKENS, AGENTLENS_NOTIFY,
 *      AGENTLENS_BURN_TOKENS_PER_MIN, AGENTLENS_BURN_COST_PER_HOUR, AGENTLENS_BURN_WINDOW_PCT,
 *      AGENTLENS_BURN_CACHE_CREATE.
 */
export function loadBurnConfig(env: NodeJS.ProcessEnv, homeDir: string): BurnConfig {
  let file: Partial<{ window5hTokens: number; window7dTokens: number; window5hCostUsd: number; window7dCostUsd: number; notify: boolean; thresholds: Partial<BurnThresholds>; observed: unknown }> = {}
  try {
    const p = burnConfigPath(env, homeDir)
    if (fs.existsSync(p)) file = JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch { /* malformed config must never crash the monitor — fall back to env + defaults */ }

  const env5h = numEnv(env['AGENTLENS_WINDOW_5H_TOKENS'])
  const env7d = numEnv(env['AGENTLENS_WINDOW_7D_TOKENS'])
  const file5h = typeof file.window5hTokens === 'number' && file.window5hTokens > 0 ? file.window5hTokens : null
  const file7d = typeof file.window7dTokens === 'number' && file.window7dTokens > 0 ? file.window7dTokens : null
  const window5hTokens = env5h ?? file5h
  const window7dTokens = env7d ?? file7d

  const env5hCost = numEnv(env['AGENTLENS_WINDOW_5H_COST_USD'])
  const env7dCost = numEnv(env['AGENTLENS_WINDOW_7D_COST_USD'])
  const file5hCost = typeof file.window5hCostUsd === 'number' && file.window5hCostUsd > 0 ? file.window5hCostUsd : null
  const file7dCost = typeof file.window7dCostUsd === 'number' && file.window7dCostUsd > 0 ? file.window7dCostUsd : null
  const window5hCostUsd = env5hCost ?? file5hCost
  const window7dCostUsd = env7dCost ?? file7dCost

  const observed = parseObservedCapacities(file.observed)

  const anyEnv = (env5h ?? env7d ?? env5hCost ?? env7dCost) !== null
  const anyFile = (file5h ?? file7d ?? file5hCost ?? file7dCost) !== null
  // Manual sources rank above observed: 'observed' is reported only when the SOLE capacity knowledge
  // on this machine is auto-calibrated (so a user cap always shows as env/config, never masked).
  const capacitySource: BurnConfig['capacitySource'] =
    anyEnv ? 'env' : anyFile ? 'config' : Object.keys(observed).length > 0 ? 'observed' : 'none'

  const ft = file.thresholds ?? {}
  const thresholds: BurnThresholds = {
    tokensPerMin: numEnv(env['AGENTLENS_BURN_TOKENS_PER_MIN']) ?? ft.tokensPerMin ?? DEFAULT_THRESHOLDS.tokensPerMin,
    costPerHour:  numEnv(env['AGENTLENS_BURN_COST_PER_HOUR'])  ?? ft.costPerHour  ?? DEFAULT_THRESHOLDS.costPerHour,
    windowPct:    numEnv(env['AGENTLENS_BURN_WINDOW_PCT'])     ?? ft.windowPct    ?? DEFAULT_THRESHOLDS.windowPct,
    cacheCreateSingleCall: numEnv(env['AGENTLENS_BURN_CACHE_CREATE']) ?? ft.cacheCreateSingleCall ?? DEFAULT_THRESHOLDS.cacheCreateSingleCall,
  }

  return {
    window5hTokens, window7dTokens, window5hCostUsd, window7dCostUsd, capacitySource, observed,
    notify: env['AGENTLENS_NOTIFY'] === '1' || file.notify === true,
    thresholds,
  }
}

// ── Event extraction ────────────────────────────────────────────────────────────

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
const ONE_MIN_MS = 60 * 1000
const FIVE_MIN_MS = 5 * 60 * 1000
const LIVE_MS = 10 * 60 * 1000   // "live" = activity within the last 10 minutes (session resolution)

/** Normalize a possibly epoch-SECONDS timestamp (statusline) to epoch MILLISECONDS. */
export function toMs(ts: number): number {
  return ts > 0 && ts < 1e12 ? ts * 1000 : ts
}

/** The dominant-cause bucket for one api_request event (spec 3: agent/skill/plugin/mcp/compaction/spawn).
 *  A sub-agent call (agent.name) IS the fleet-spawn bucket. */
function attributionOf(e: TimelineEntry): string {
  if (e.querySource === 'compact' || e.compactionTrigger) return 'compaction'
  if (e.agentName) return `agent:${e.agentName}`
  if (e.skillName) return `skill:${e.skillName}`
  if (e.pluginName) return `plugin:${e.pluginName}`
  if (e.mcpServerName) return `mcp:${e.mcpServerName}`
  if (e.querySource && e.querySource !== 'repl_main_thread') return e.querySource
  return 'main'
}

function apiRequestEvents(card: SessionSummaryCard): ConsumptionEvent[] {
  const out: ConsumptionEvent[] = []
  for (const e of card.timeline ?? []) {
    if (e.type !== 'api_request') continue
    const ts = Date.parse(e.timestamp || '')
    if (!Number.isFinite(ts)) continue
    const inputTokens = e.inputTokens ?? 0, outputTokens = e.outputTokens ?? 0
    const cacheReadTokens = e.cacheReadTokens ?? 0, cacheCreateTokens = e.cacheCreateTokens ?? 0
    const tokens = inputTokens + outputTokens + cacheReadTokens + cacheCreateTokens
    out.push({
      ts, sessionId: card.sessionId, workspace: card.workspace, accountUuid: card.accountId,
      costUsd: e.costUsd ?? 0, tokens, source: 'api_request',
      attribution: attributionOf(e),
      inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens,
    })
  }
  return out
}

/**
 * Merges the two live consumption sources into one machine-wide event stream, DEDUPED per session:
 * a session that emits rich api_request events uses ONLY those (they carry the same authoritative
 * cost PLUS per-call attribution); a session with no api_request events falls back to its statusline
 * billing deltas. This prevents double-counting the same turn from both sources.
 */
export function gatherConsumptionEvents(
  sessions: SessionSummaryCard[],
  statuslineEvents: StatuslineBillingEvent[],
  _now: number,
): ConsumptionEvent[] {
  const events: ConsumptionEvent[] = []
  const apiSessions = new Set<string>()
  const cardBy = new Map(sessions.map(c => [c.sessionId, c]))
  for (const card of sessions) {
    const evs = apiRequestEvents(card)
    if (evs.length > 0) { apiSessions.add(card.sessionId); events.push(...evs) }
  }
  for (const be of statuslineEvents) {
    if (apiSessions.has(be.sessionId)) continue
    if (be.deltaTokens <= 0 && be.deltaCostUsd <= 0) continue
    const card = cardBy.get(be.sessionId)
    events.push({
      ts: toMs(be.ts), sessionId: be.sessionId, workspace: be.workspace, accountUuid: card?.accountId,
      // TRDD-BURNWDGT burn-rate fix: derive this turn's cost from ITS OWN per-turn buckets ×
      // calcTokenCostUsd, NOT the cumulative `deltaCostUsd`. The statusline samples sparsely, so a
      // single cumulative delta lumps several turns' spend onto one timestamp — spiking the rolling
      // $/hr ~4× (the "pricing bug" that turned out to be a sparse-cumulative-delta artifact). A
      // per-turn priced cost is consistent with that turn's own tokens. Fall back to deltaCostUsd only
      // when buckets are absent or the model is unpriced (derived 0) so cost is never lost.
      costUsd: statuslineCostUsd(be, card?.model),
      tokens: be.deltaTokens, source: 'statusline',
      // Per-bucket split from the statusline (when present) so the breakdown is accurate here too.
      inputTokens: be.deltaInput, outputTokens: be.deltaOutput,
      cacheReadTokens: be.deltaCacheRead, cacheCreateTokens: be.deltaCacheCreate,
    })
  }
  return events.sort((a, b) => a.ts - b.ts)
}

/** Cost of ONE statusline turn from its own uncached buckets × the model rate. The statusline reports
 *  input/output as FRESH (uncached) per-turn tokens (separate from cache_read), so they map directly onto
 *  calcTokenCostUsd's (uncachedInput, cacheRead, cacheWrite, output). Falls back to the cumulative delta
 *  when no split is present or the model has no pricing entry (derived === 0) — never loses cost. */
function statuslineCostUsd(be: StatuslineBillingEvent, model: string | undefined): number {
  const hasSplit = be.deltaInput !== undefined || be.deltaOutput !== undefined ||
    be.deltaCacheRead !== undefined || be.deltaCacheCreate !== undefined
  if (!hasSplit || !model) { return be.deltaCostUsd }
  const derived = calcTokenCostUsd(
    be.deltaInput ?? 0, be.deltaCacheRead ?? 0, be.deltaCacheCreate ?? 0, be.deltaOutput ?? 0, model)
  return derived > 0 ? derived : be.deltaCostUsd
}

// ── Rolling-window math ──────────────────────────────────────────────────────────

/** The 4 token buckets in a window (+ `unknown` = statusline totals with no split), summing to `tokens`.
 *  This is what the burn number is MADE OF — cache-read is ~96% of real workloads (resident context
 *  re-read every turn), so exposing the split is the whole point: a bare tokens/min hides that. */
export interface BurnBreakdown {
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
  unknown: number
}

export interface BurnRateWindow {
  windowMs: number
  tokens: number
  costUsd: number
  events: number
  tokensPerMin: number
  costPerMin: number
  breakdown: BurnBreakdown          // window totals per bucket (sum === tokens)
  billableWeightedPerMin: number    // burn in fresh-input-token-equivalents/min (cost, denominated in tokens)
}

function emptyBreakdown(): BurnBreakdown {
  return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, unknown: 0 }
}

function windowSum(
  events: ConsumptionEvent[], now: number, windowMs: number,
): { tokens: number; cost: number; count: number; breakdown: BurnBreakdown } {
  const from = now - windowMs
  let tokens = 0, cost = 0, count = 0
  const breakdown = emptyBreakdown()
  for (const e of events) {
    if (e.ts < from || e.ts > now) continue
    tokens += e.tokens; cost += e.costUsd; count++
    // Split on PRESENCE of the per-bucket fields, not the source: both api_request AND statusline events
    // now carry them (they sum to e.tokens by construction). Only a truly split-less event (a future
    // source) falls into `unknown`, so breakdown.(input+output+cacheRead+cacheCreate+unknown) === tokens.
    const hasSplit = e.inputTokens !== undefined || e.outputTokens !== undefined ||
      e.cacheReadTokens !== undefined || e.cacheCreateTokens !== undefined
    if (hasSplit) {
      breakdown.input += e.inputTokens ?? 0
      breakdown.output += e.outputTokens ?? 0
      breakdown.cacheRead += e.cacheReadTokens ?? 0
      breakdown.cacheCreate += e.cacheCreateTokens ?? 0
    } else {
      breakdown.unknown += e.tokens
    }
  }
  return { tokens, cost, count, breakdown }
}

/** Burn in fresh-input-token-equivalents (cost, denominated in tokens) — see BILLABLE_WEIGHTS. */
function billableWeightedTokens(b: BurnBreakdown): number {
  return b.input * BILLABLE_WEIGHTS.input + b.output * BILLABLE_WEIGHTS.output +
    b.cacheRead * BILLABLE_WEIGHTS.cacheRead + b.cacheCreate * BILLABLE_WEIGHTS.cacheCreate +
    b.unknown * BILLABLE_WEIGHTS.unknown
}

/** Rolling-window burn rate. tokensPerMin/costPerMin normalize the window's total to a per-minute rate
 *  (a 1-min window's rate IS its sum; a 5-min window's rate is its sum / 5). `breakdown` holds the raw
 *  window totals per bucket; `billableWeightedPerMin` is the cost-weighted burn (cache-read at 0.1×) —
 *  the number that matters if the plan's rate-limit window is cost-based, not raw-token-based. */
export function rateWindow(events: ConsumptionEvent[], now: number, windowMs: number): BurnRateWindow {
  const { tokens, cost, count, breakdown } = windowSum(events, now, windowMs)
  const minutes = windowMs / ONE_MIN_MS
  return {
    windowMs, tokens, costUsd: +cost.toFixed(6), events: count,
    tokensPerMin: Math.round(tokens / minutes),
    costPerMin: +(cost / minutes).toFixed(6),
    breakdown,
    billableWeightedPerMin: Math.round(billableWeightedTokens(breakdown) / minutes),
  }
}

// ── Burn series (spec 1) ─────────────────────────────────────────────────────────

export interface SessionBurn {
  sessionId: string
  workspace?: string
  oneMin: BurnRateWindow
  fiveMin: BurnRateWindow
  dominantCause: string | null
  /** Keep-warm / cache-gap diagnostic (P6) — set by computeBurnStatus from the session's timeline
   *  (computeBurnSeries has no card access). null = no api_request entries (honest absence). */
  keepWarm?: KeepWarmReport | null
}

export interface BurnSeries {
  now: number
  global: { oneMin: BurnRateWindow; fiveMin: BurnRateWindow }
  sessions: SessionBurn[]   // sessions active in the last 5 min, hottest first (by 1-min rate)
}

/** Top attribution bucket (by tokens) among a session's events in the window; null when none/unknown. */
function dominantCause(events: ConsumptionEvent[], now: number, windowMs: number): string | null {
  const from = now - windowMs
  const tally = new Map<string, number>()
  for (const e of events) {
    if (e.ts < from || e.ts > now || !e.attribution) continue
    tally.set(e.attribution, (tally.get(e.attribution) ?? 0) + e.tokens)
  }
  let top: string | null = null, max = -1
  for (const [k, v] of tally) if (v > max) { max = v; top = k }
  return top
}

export function computeBurnSeries(events: ConsumptionEvent[], now: number): BurnSeries {
  const bySession = new Map<string, ConsumptionEvent[]>()
  for (const e of events) {
    const arr = bySession.get(e.sessionId)
    if (arr) arr.push(e); else bySession.set(e.sessionId, [e])
  }
  const sessions: SessionBurn[] = []
  for (const [sessionId, evs] of bySession) {
    const fiveMin = rateWindow(evs, now, FIVE_MIN_MS)
    if (fiveMin.events === 0) continue   // not active in the last 5 min
    sessions.push({
      sessionId, workspace: evs[0].workspace,
      oneMin: rateWindow(evs, now, ONE_MIN_MS),
      fiveMin,
      dominantCause: dominantCause(evs, now, FIVE_MIN_MS),
    })
  }
  sessions.sort((a, b) => b.oneMin.tokensPerMin - a.oneMin.tokensPerMin || b.fiveMin.tokens - a.fiveMin.tokens)
  return {
    now,
    global: { oneMin: rateWindow(events, now, ONE_MIN_MS), fiveMin: rateWindow(events, now, FIVE_MIN_MS) },
    sessions,
  }
}

// ── Window budget (spec 2) ────────────────────────────────────────────────────────

export interface WindowConsumption {
  window: '5h' | '7d'
  windowMs: number
  consumedTokens: number
  consumedCostUsd: number
  consumedBillableWeighted: number      // cost-weighted tokens (cache-read 0.1×) — see note below
  breakdown: BurnBreakdown              // what the consumed tokens are made of (cache-read usually ~96%)
  capacityTokens: number | null
  pctConsumed: number | null            // null when capacity unset — NEVER invented
  // TRDD-BURNWDGT — COST-based capacity + %: consumedCostUsd / capacityCostUsd. Set only when a cost cap
  // is configured. This is the truthful fill metric when the plan's window is billed by cost (cache-read
  // barely counts), unlike the raw-token pctConsumed which the ~96% cache-read volume inflates.
  capacityCostUsd: number | null
  pctConsumedCost: number | null        // null when no cost cap — NEVER invented
  tokensPerMin: number                  // the current burn rate used for the projection
  minutesToExhaustion: number | null    // null when capacity unset or burn rate 0
}
// pctConsumed is RAW-TOKEN based (consumedTokens / capacityTokens). If a plan's rate-limit window is
// COST-based (Anthropic weights cache-read at 0.1× / 0.2×), raw tokens over-state consumption — read
// consumedCostUsd / consumedBillableWeighted instead. A cost-capacity + cost-pct is the next step
// (needs the plan's cost cap; tracked as account+window-awareness work).

export interface WindowBudget {
  fiveHour: WindowConsumption
  sevenDay: WindowConsumption
  capacitySource: BurnConfig['capacitySource']
  capacityConfigured: boolean
  /** ISO date of the rate-limit observation the capacity was auto-calibrated from (P5);
   *  null unless capacitySource === 'observed'. */
  capacityObservedAt: string | null
  note?: string
}

function windowConsumption(
  events: ConsumptionEvent[], now: number, windowMs: number, label: '5h' | '7d',
  capacity: number | null, projectionTokensPerMin: number, capacityCost: number | null = null,
): WindowConsumption {
  const { tokens, cost, breakdown } = windowSum(events, now, windowMs)
  const pct = capacity !== null && capacity > 0 ? +(tokens / capacity * 100).toFixed(2) : null
  const pctCost = capacityCost !== null && capacityCost > 0 ? +(cost / capacityCost * 100).toFixed(2) : null
  const remaining = capacity !== null ? capacity - tokens : null
  const minutesToExhaustion =
    remaining !== null && remaining > 0 && projectionTokensPerMin > 0
      ? +(remaining / projectionTokensPerMin).toFixed(1)
      : (remaining !== null && remaining <= 0 ? 0 : null)
  return {
    window: label, windowMs,
    consumedTokens: tokens, consumedCostUsd: +cost.toFixed(4),
    consumedBillableWeighted: Math.round(billableWeightedTokens(breakdown)),
    breakdown,
    capacityTokens: capacity, pctConsumed: pct,
    capacityCostUsd: capacityCost, pctConsumedCost: pctCost,
    tokensPerMin: projectionTokensPerMin, minutesToExhaustion,
  }
}

/** The observed capacity applicable to a budget, or null. Manual (env/file) caps DISABLE observed
 *  entirely — an auto-calibrated lower bound must never shadow a user-configured cap. For the
 *  machine-wide pooled budget (accountUuid === undefined) observed applies only when exactly ONE
 *  account has been calibrated: pooled consumption on a multi-account machine has no single cap
 *  (rate limits are per account), so guessing there would over-promise headroom. */
function observedCapacityFor(config: BurnConfig, accountUuid: string | null | undefined): ObservedAccountCapacity | null {
  const manual = config.window5hTokens !== null || config.window7dTokens !== null ||
    config.window5hCostUsd !== null || config.window7dCostUsd !== null
  if (manual) return null
  if (accountUuid === undefined) {
    const keys = Object.keys(config.observed)
    return keys.length === 1 ? config.observed[keys[0]] : null
  }
  return accountUuid !== null ? config.observed[accountUuid] ?? null : null
}

/** Rolling 5h + 7d consumption across ALL sessions. `projectionTokensPerMin` is the current burn rate
 *  the time-to-exhaustion projects at (pass the global rolling-5-min tokens/min). `accountUuid` scopes
 *  the OBSERVED-capacity lookup (P5): pass the account the events belong to so its auto-calibrated
 *  caps apply; omit for the machine-wide pooled budget (observed then applies only on a
 *  single-calibrated-account machine — see observedCapacityFor). */
export function computeWindowBudget(
  events: ConsumptionEvent[], config: BurnConfig, projectionTokensPerMin: number, now: number,
  accountUuid?: string | null,
): WindowBudget {
  const obs = observedCapacityFor(config, accountUuid)
  const cap5h = config.window5hTokens ?? obs?.window5hTokens ?? null
  const cap7d = config.window7dTokens ?? obs?.window7dTokens ?? null
  const cap5hCost = config.window5hCostUsd ?? obs?.window5hCostUsd ?? null
  const cap7dCost = config.window7dCostUsd ?? obs?.window7dCostUsd ?? null
  const configured = cap5h !== null || cap7d !== null || cap5hCost !== null || cap7dCost !== null
  // Per-BUDGET source, not the config's global one: on a multi-account machine only the calibrated
  // account's budget may claim 'observed' — the others are honestly 'none'.
  const manual = config.capacitySource === 'env' || config.capacitySource === 'config'
  const source: BurnConfig['capacitySource'] = manual ? config.capacitySource : obs !== null ? 'observed' : 'none'
  return {
    fiveHour: windowConsumption(events, now, FIVE_HOURS_MS, '5h', cap5h, projectionTokensPerMin, cap5hCost),
    sevenDay: windowConsumption(events, now, SEVEN_DAYS_MS, '7d', cap7d, projectionTokensPerMin, cap7dCost),
    capacitySource: source,
    capacityConfigured: configured,
    capacityObservedAt: source === 'observed' ? obs?.observedAt ?? null : null,
    note: configured
      ? (source === 'observed'
        ? `Capacity auto-calibrated from a rate-limit hit observed ${obs?.observedAt ?? 'at an unknown time'} — a PROVEN LOWER BOUND (the real cap may be higher; a later larger observation raises it, never lowers). Set AGENTLENS_WINDOW_5H_TOKENS / _7D_TOKENS (or burn-config.json) to override with the exact plan cap.`
        : undefined)
      : 'Window capacity not configured — set AGENTLENS_WINDOW_5H_TOKENS / AGENTLENS_WINDOW_7D_TOKENS (raw-token caps) or AGENTLENS_WINDOW_5H_COST_USD / AGENTLENS_WINDOW_7D_COST_USD (cost caps), or ~/.agentlens/burn-config.json, so % consumed and time-to-exhaustion can be computed. AgentlensPro also auto-calibrates an observed capacity the next time a rate limit ends a window prematurely (P5).',
  }
}

// ── Per-account window budget (TRDD-BURNWDGT) ──────────────────────────────────
// Rate limits are per OAuth account, so the machine-wide budget above is misleading once the user
// rotates accounts mid-window (a firehose on account B must not eat account A's remaining %). These
// group the SAME event stream by accountUuid and compute each account's own 5h/7d budget + burn rate.

export interface AccountWindowBudget {
  accountUuid: string | null    // null = the "unknown" bucket (events whose account wasn't attributed)
  accountLabel?: string         // live-only display label (email/org for the current account, else short id);
                                // resolved by the MCP layer (accountInfo), not here — this module stays I/O-free
  budget: WindowBudget
  fiveMinTokensPerMin: number   // this account's own recent burn rate (drives its projection)
  events: number                // events attributed to this account across the 7d window
}

/** Split the consumption stream by account and compute each account's own window budget + burn rate.
 *  Sorted heaviest-5h-consumption first; the unknown bucket (if any) is pinned last. Pure — the caller
 *  supplies the events + config; labels are resolved separately (accountInfo) to keep this I/O-free. */
export function computeAccountWindowBudgets(
  events: ConsumptionEvent[], config: BurnConfig, now: number,
): AccountWindowBudget[] {
  const byAccount = new Map<string | null, ConsumptionEvent[]>()
  for (const e of events) {
    const key = e.accountUuid ?? null
    const arr = byAccount.get(key)
    if (arr) { arr.push(e) } else { byAccount.set(key, [e]) }
  }
  const out: AccountWindowBudget[] = []
  for (const [accountUuid, evs] of byAccount) {
    const fiveMin = rateWindow(evs, now, FIVE_MIN_MS).tokensPerMin
    out.push({
      accountUuid,
      // Pass the account key so THIS account's auto-calibrated (observed) capacity applies (P5) —
      // the null bucket and uncalibrated accounts keep capacitySource 'none'.
      budget: computeWindowBudget(evs, config, fiveMin, now, accountUuid),
      fiveMinTokensPerMin: fiveMin,
      events: windowSum(evs, now, SEVEN_DAYS_MS).count,
    })
  }
  out.sort((a, b) => {
    // Unknown bucket pinned last; otherwise heaviest 7d consumption first.
    if (a.accountUuid === null) { return 1 }
    if (b.accountUuid === null) { return -1 }
    return b.budget.sevenDay.consumedTokens - a.budget.sevenDay.consumedTokens
  })
  return out
}

// ── Empirical capacity calibration (TRDD-BURNWDGT next-action 3) ───────────────
// The real window cap is Anthropic's undisclosed rate-limit ceiling — observable ONLY at the moment a
// window ends PREMATURELY (a rate-limit / usage-limit hit; the user waits for exhaustion), NOT at a
// time-based 5h rollover (that measures elapsed time, not the cap). Given the account's window START and
// the premature-END timestamp, the consumption accumulated in between IS the observed cap for that
// account/plan — removing the need to hardcode a cap.

export interface ObservedCapacity {
  accountUuid: string | null
  windowStartMs: number
  windowEndMs: number
  tokens: number                // raw tokens consumed in [start, end] — the raw-token cap
  costUsd: number               // cost consumed — the cost cap
  billableWeighted: number      // cost in fresh-input-token equivalents
  breakdown: BurnBreakdown
  events: number
}

/** Snapshot the consumption an account accrued between its window start and a PREMATURE end (rate-limit
 *  hit). The result is the empirically-observed capacity to feed back into the config caps. Pure. */
export function observeCapacityFromPrematureEnd(
  events: ConsumptionEvent[], accountUuid: string | null, windowStartMs: number, windowEndMs: number,
): ObservedCapacity {
  const breakdown = emptyBreakdown()
  let tokens = 0, costUsd = 0, count = 0
  for (const e of events) {
    if ((e.accountUuid ?? null) !== accountUuid) { continue }
    if (e.ts < windowStartMs || e.ts > windowEndMs) { continue }
    tokens += e.tokens; costUsd += e.costUsd; count++
    const hasSplit = e.inputTokens !== undefined || e.outputTokens !== undefined ||
      e.cacheReadTokens !== undefined || e.cacheCreateTokens !== undefined
    if (hasSplit) {
      breakdown.input += e.inputTokens ?? 0
      breakdown.output += e.outputTokens ?? 0
      breakdown.cacheRead += e.cacheReadTokens ?? 0
      breakdown.cacheCreate += e.cacheCreateTokens ?? 0
    } else {
      breakdown.unknown += e.tokens
    }
  }
  return {
    accountUuid, windowStartMs, windowEndMs,
    tokens, costUsd: +costUsd.toFixed(4),
    billableWeighted: Math.round(billableWeightedTokens(breakdown)),
    breakdown, events: count,
  }
}

// ── Alerts (spec 3) ────────────────────────────────────────────────────────────

export type BurnAlertRule = 'tokens_per_min' | 'cost_per_hour' | 'window_5h_pct' | 'window_7d_pct' | 'cache_create_spike'

export interface BurnAlert {
  id: string                 // stable dedupe key `${rule}:${sessionId}`
  rule: BurnAlertRule
  severity: 'error' | 'warning' | 'info'
  label: string
  detail: string             // names the session + dominant cause
  sessionId: string | null
  cause: string | null
  value: number
  threshold: number
  ts: number
}

function sessionLabel(sessions: SessionSummaryCard[], sessionId: string | null): string {
  if (!sessionId) return 'unknown session'
  const c = sessions.find(s => s.sessionId === sessionId)
  const req = c?.userRequest && !c.userRequest.startsWith('[') ? ` — "${c.userRequest.slice(0, 60)}"` : ''
  const ws = c?.workspace ? ` (${c.workspace.split('/').pop()})` : ''
  return `${sessionId.slice(0, 12)}${ws}${req}`
}

/**
 * Evaluates the threshold rules against the current burn series + window budget. Each alert names the
 * offending session and its dominant cause. Machine-wide rules (%window) name the top consumer.
 * `cacheCreateEvents` are the last-5-min api_request events (with per-call cache-create tokens) that the
 * cache-create-spike rule scans.
 */
export function evaluateBurnAlerts(
  series: BurnSeries, budget: WindowBudget, config: BurnConfig,
  sessions: SessionSummaryCard[], events: ConsumptionEvent[], now: number,
): BurnAlert[] {
  const alerts: BurnAlert[] = []
  const th = config.thresholds
  const topSession = series.sessions[0] ?? null

  // Rule 1 — global tokens/min (rolling 1-min).
  if (series.global.oneMin.tokensPerMin > th.tokensPerMin) {
    const cause = topSession?.dominantCause ?? null
    alerts.push({
      id: `tokens_per_min:${topSession?.sessionId ?? 'global'}`,
      rule: 'tokens_per_min', severity: 'error',
      label: 'Token burn rate high',
      detail: `${series.global.oneMin.tokensPerMin.toLocaleString()} tok/min (threshold ${th.tokensPerMin.toLocaleString()}). Hottest: ${sessionLabel(sessions, topSession?.sessionId ?? null)}${cause ? ` · cause: ${cause}` : ''}`,
      sessionId: topSession?.sessionId ?? null, cause,
      value: series.global.oneMin.tokensPerMin, threshold: th.tokensPerMin, ts: now,
    })
  }

  // Rule 2 — global $/hr (from the rolling-5-min rate, steadier than 1-min).
  const costPerHour = series.global.fiveMin.costPerMin * 60
  if (costPerHour > th.costPerHour) {
    const cause = topSession?.dominantCause ?? null
    alerts.push({
      id: `cost_per_hour:${topSession?.sessionId ?? 'global'}`,
      rule: 'cost_per_hour', severity: 'warning',
      label: 'Spend rate high',
      detail: `$${costPerHour.toFixed(2)}/hr (threshold $${th.costPerHour}). Hottest: ${sessionLabel(sessions, topSession?.sessionId ?? null)}${cause ? ` · cause: ${cause}` : ''}`,
      sessionId: topSession?.sessionId ?? null, cause,
      value: +costPerHour.toFixed(2), threshold: th.costPerHour, ts: now,
    })
  }

  // Rule 3 — rate-limit window % (only when a capacity is configured).
  for (const [rule, wc] of [['window_5h_pct', budget.fiveHour], ['window_7d_pct', budget.sevenDay]] as const) {
    if (wc.pctConsumed !== null && wc.pctConsumed > th.windowPct) {
      const cause = topSession?.dominantCause ?? null
      const proj = wc.minutesToExhaustion !== null ? ` · ~${wc.minutesToExhaustion}min to exhaustion at current rate` : ''
      alerts.push({
        id: `${rule}:global`,
        rule, severity: 'error',
        label: `${wc.window} rate-limit window ${wc.pctConsumed.toFixed(0)}% consumed`,
        detail: `${wc.window} window ${wc.pctConsumed.toFixed(1)}% consumed (threshold ${th.windowPct}%)${proj}. Top consumer: ${sessionLabel(sessions, topSession?.sessionId ?? null)}${cause ? ` · cause: ${cause}` : ''}`,
        sessionId: topSession?.sessionId ?? null, cause,
        value: wc.pctConsumed, threshold: th.windowPct, ts: now,
      })
    }
  }

  // Rule 4 — a single api_request re-wrote a huge prefix (cache-creation ≥ N in the last 5 min).
  const from = now - FIVE_MIN_MS
  let worstSpike: ConsumptionEvent | null = null
  for (const e of events) {
    if (e.ts < from || e.ts > now) continue
    const cc = e.cacheCreateTokens ?? 0
    if (cc >= th.cacheCreateSingleCall && (!worstSpike || cc > (worstSpike.cacheCreateTokens ?? 0))) worstSpike = e
  }
  if (worstSpike) {
    const cc = worstSpike.cacheCreateTokens ?? 0
    alerts.push({
      id: `cache_create_spike:${worstSpike.sessionId}`,
      rule: 'cache_create_spike', severity: 'warning',
      label: 'Large cache-creation on a single call',
      detail: `One call wrote ${cc.toLocaleString()} cache-creation tokens (threshold ${th.cacheCreateSingleCall.toLocaleString()}). Session: ${sessionLabel(sessions, worstSpike.sessionId)}${worstSpike.attribution ? ` · cause: ${worstSpike.attribution}` : ''}`,
      sessionId: worstSpike.sessionId, cause: worstSpike.attribution ?? null,
      value: cc, threshold: th.cacheCreateSingleCall, ts: now,
    })
  }

  return alerts
}

// ── Aggregate burn status (spec 4: get_burn_status) ────────────────────────────

export interface BurnStatus {
  now: number
  global: { oneMin: BurnRateWindow; fiveMin: BurnRateWindow; costPerHour: number }
  window: WindowBudget                    // machine-wide (all accounts pooled) — kept for back-compat
  accountWindows: AccountWindowBudget[]   // TRDD-BURNWDGT — the same budget split PER OAuth account
  topSessions: SessionBurn[]
  alerts: BurnAlert[]
  activeSessions: number
}

export function computeBurnStatus(
  events: ConsumptionEvent[], sessions: SessionSummaryCard[], config: BurnConfig, now: number,
): BurnStatus {
  const series = computeBurnSeries(events, now)
  const budget = computeWindowBudget(events, config, series.global.fiveMin.tokensPerMin, now)
  const alerts = evaluateBurnAlerts(series, budget, config, sessions, events, now)
  return {
    now,
    global: {
      oneMin: series.global.oneMin,
      fiveMin: series.global.fiveMin,
      costPerHour: +(series.global.fiveMin.costPerMin * 60).toFixed(4),
    },
    window: budget,
    accountWindows: computeAccountWindowBudgets(events, config, now),
    // P6 keep-warm: decorate each hot session with its cache-gap diagnostic from the card's
    // timeline (api_request ground truth). null when the card is unknown here or carries no
    // api_request entries — honest absence, never zeros presented as measurements.
    topSessions: series.sessions.slice(0, 5).map(sb => ({
      ...sb,
      keepWarm: computeKeepWarm(sessions.find(c => c.sessionId === sb.sessionId)?.timeline ?? []),
    })),
    alerts,
    activeSessions: series.sessions.length,
  }
}

// ── Session resolution + status (spec 5: get_session_status) ────────────────────

/** Last activity (epoch ms) of a card: last timeline ts, else statusline lastTs, else startTime. */
export function lastActivityMs(card: SessionSummaryCard): number {
  const tl = card.timeline
  if (tl && tl.length > 0) {
    for (let i = tl.length - 1; i >= 0; i--) {
      const t = Date.parse(tl[i].timestamp || '')
      if (Number.isFinite(t)) return t
    }
  }
  if (card.statusline?.lastTs) return toMs(card.statusline.lastTs)
  const st = Date.parse(card.startTime || '')
  return Number.isFinite(st) ? st : 0
}

export type SessionMatchKind = 'sessionId' | 'workspace-recent' | 'workspace-latest' | 'latest' | 'none'

export interface ResolvedSession {
  card: SessionSummaryCard | null
  live: boolean
  matchedBy: SessionMatchKind
}

/**
 * Resolves the caller's session robustly (callers rarely know their own sessionId):
 *   1. exact sessionId when given;
 *   2. else, under the workspace prefix: the newest session with activity in the last ~10 min (live);
 *      if none is recent, the newest overall under the prefix (labeled live:false);
 *   3. else, the newest session machine-wide.
 */
export function resolveSession(sessions: SessionSummaryCard[], sel: { sessionId?: string; workspace?: string }, now: number): ResolvedSession {
  if (sel.sessionId) {
    const c = sessions.find(s => s.sessionId === sel.sessionId) ?? null
    return { card: c, live: c ? now - lastActivityMs(c) < LIVE_MS : false, matchedBy: c ? 'sessionId' : 'none' }
  }
  if (sel.workspace) {
    const ws = sel.workspace
    const cands = sessions.filter(s =>
      (s.workspace ?? '').startsWith(ws) || (s.projectPath ?? '').startsWith(ws) || s.sessionId.includes(ws))
    if (cands.length === 0) return { card: null, live: false, matchedBy: 'none' }
    const recent = cands.filter(s => now - lastActivityMs(s) < LIVE_MS).sort((a, b) => lastActivityMs(b) - lastActivityMs(a))
    if (recent.length > 0) return { card: recent[0], live: true, matchedBy: 'workspace-recent' }
    const byRecency = [...cands].sort((a, b) => lastActivityMs(b) - lastActivityMs(a))
    return { card: byRecency[0], live: false, matchedBy: 'workspace-latest' }
  }
  const all = [...sessions].sort((a, b) => lastActivityMs(b) - lastActivityMs(a))
  if (all.length === 0) return { card: null, live: false, matchedBy: 'none' }
  return { card: all[0], live: now - lastActivityMs(all[0]) < LIVE_MS, matchedBy: 'latest' }
}

/** Authoritative session cost: the statusline cumulative cost when present (no pricing estimate),
 *  else the pricing-table estimate. inputTokens is RAW on every card (2026-07-10 normalization at
 *  the ingestion sites) — the four buckets are disjoint, each billed at its own rate. */
export function cardCostUsd(card: SessionSummaryCard): number {
  if (card.statusline && card.statusline.totalCostUsd > 0) return card.statusline.totalCostUsd
  return calcTokenCostUsd(card.inputTokens, card.cacheReadTokens, card.cacheCreateTokens ?? 0, card.outputTokens, card.model)
}

export interface SessionStatus {
  // tokensSource (P7): which feed backs the card's token figures — null = pre-P7 card ("unknown",
  // never a guess); coverageNote rides only when the merge decision recorded a displacement.
  resolved: { sessionId: string; workspace: string; source: string; model: string; live: boolean; matchedBy: SessionMatchKind; tokensSource: TokensSource | null; coverageNote?: string }
  context: { currentTokens: number; peakTokens: number; windowSize: number | null; usedPct: number | null }
  usageBuckets: { input: number; output: number; cacheRead: number; cacheCreate: number }   // last turn
  avgPerCall: { input: number; output: number; cacheRead: number; cacheCreate: number; total: number } // the "avg 5 values"
  cacheHitRatePct: number
  lastCallCostUsd: number
  sessionTotalCostUsd: number
  tokensPerMin: number
  /** Keep-warm / cache-gap diagnostic (P6): warm vs cold turns against the ~5-min prompt-cache TTL
   *  + the cache-write tokens the cold turns wasted. null = no api_request entries to measure. */
  keepWarm: KeepWarmReport | null
  rateLimitWindow: { fiveHourPct: number | null; sevenDayPct: number | null; fiveHourMinutesToExhaustion: number | null; sevenDayMinutesToExhaustion: number | null; capacityConfigured: boolean }
  comparison: { previousSessions: number; avgCostUsd: number | null; avgTurns: number | null; avgCacheHitRatePct: number | null; deltaCostUsd: number | null; deltaTurns: number | null; deltaCacheHitPct: number | null } | null
  drill: { context_history: string; context_composition: string }
  message?: string
}

/**
 * The one-call self-diagnostic (spec 5) other Claudes ask for: for the caller's resolved session, the
 * current + peak context, the 4 usage buckets, the avg-5-values, cache-hit rate, last-call cost,
 * session-total cost, tokens/min, remaining 5h + 7d window %, and a compact comparison to the caller's
 * previous sessions in the same workspace. Context diff/composition stay in
 * get_context_history / get_context_composition — pointed at via `drill`.
 */
export function computeSessionStatus(
  sessions: SessionSummaryCard[], events: ConsumptionEvent[], config: BurnConfig,
  sel: { sessionId?: string; workspace?: string }, now: number,
): SessionStatus | { message: string; matchedBy: 'none' } {
  const r = resolveSession(sessions, sel, now)
  if (!r.card) {
    return {
      message: sel.sessionId
        ? `No session ${sel.sessionId} found.`
        : sel.workspace
          ? `No session found under workspace "${sel.workspace}".`
          : 'No sessions recorded yet.',
      matchedBy: 'none',
    }
  }
  const card = r.card
  const sl = card.statusline

  // Per-session tokens/min from the recent (rolling-5-min) event window.
  const sessEvents = events.filter(e => e.sessionId === card.sessionId)
  const tokensPerMin = rateWindow(sessEvents, now, FIVE_MIN_MS).tokensPerMin

  // Last-call cost: newest api_request event's cost, else derived from the last statusline turn.
  const lastApi = [...(card.timeline ?? [])].reverse().find(e => e.type === 'api_request' && e.costUsd !== undefined)
  const lastCallCostUsd = lastApi?.costUsd ?? 0

  const turns = Math.max(1, card.totalLlmCalls || card.turns || 1)
  const totalTok = card.inputTokens + card.outputTokens + card.cacheReadTokens + (card.cacheCreateTokens ?? 0)

  const budget = computeWindowBudget(events, config, computeBurnSeries(events, now).global.fiveMin.tokensPerMin, now)

  // Comparison vs previous sessions in the SAME workspace (older than this one).
  const ws = card.workspace ?? ''
  const prev = sessions.filter(s =>
    s.sessionId !== card.sessionId && (s.workspace ?? '') === ws && ws !== '' &&
    lastActivityMs(s) < lastActivityMs(card))
  let comparison: SessionStatus['comparison'] = null
  if (prev.length > 0) {
    const avgCost = prev.reduce((a, s) => a + cardCostUsd(s), 0) / prev.length
    const avgTurns = prev.reduce((a, s) => a + (s.totalLlmCalls || 0), 0) / prev.length
    const avgHit = prev.reduce((a, s) => a + s.cacheHitRate, 0) / prev.length
    const thisCost = cardCostUsd(card)
    comparison = {
      previousSessions: prev.length,
      avgCostUsd: +avgCost.toFixed(4),
      avgTurns: +avgTurns.toFixed(1),
      avgCacheHitRatePct: Math.round(avgHit * 100),
      deltaCostUsd: +(thisCost - avgCost).toFixed(4),
      deltaTurns: +((card.totalLlmCalls || 0) - avgTurns).toFixed(1),
      deltaCacheHitPct: Math.round((card.cacheHitRate - avgHit) * 100),
    }
  }

  return {
    resolved: {
      sessionId: card.sessionId, workspace: ws, source: card.source, model: card.model,
      live: r.live, matchedBy: r.matchedBy,
      // P7 provenance of the figures below — null (pre-P7 card) reads as "unknown", never a guess.
      tokensSource: card.tokensSource ?? null,
      ...(card.coverageNote ? { coverageNote: card.coverageNote } : {}),
    },
    context: {
      currentTokens: sl?.lastTotalInputTokens ?? card.peakContextPerTurn ?? 0,
      peakTokens: card.peakContextPerTurn ?? sl?.peakContextTokens ?? 0,
      windowSize: sl?.contextWindowSize ?? null,
      usedPct: sl?.usedPercentage ?? null,
    },
    usageBuckets: {
      input: sl?.lastInputTokens ?? lastApi?.inputTokens ?? 0,
      output: sl?.lastOutputTokens ?? lastApi?.outputTokens ?? 0,
      cacheRead: sl?.lastCacheReadTokens ?? lastApi?.cacheReadTokens ?? 0,
      cacheCreate: sl?.lastCacheCreateTokens ?? lastApi?.cacheCreateTokens ?? 0,
    },
    avgPerCall: {
      input: Math.round(card.inputTokens / turns),
      output: Math.round(card.outputTokens / turns),
      cacheRead: Math.round(card.cacheReadTokens / turns),
      cacheCreate: Math.round((card.cacheCreateTokens ?? 0) / turns),
      total: Math.round(totalTok / turns),
    },
    cacheHitRatePct: Math.round(card.cacheHitRate * 100),
    lastCallCostUsd: +lastCallCostUsd.toFixed(4),
    sessionTotalCostUsd: +cardCostUsd(card).toFixed(4),
    tokensPerMin,
    keepWarm: computeKeepWarm(card.timeline ?? []),
    rateLimitWindow: {
      fiveHourPct: budget.fiveHour.pctConsumed,
      sevenDayPct: budget.sevenDay.pctConsumed,
      fiveHourMinutesToExhaustion: budget.fiveHour.minutesToExhaustion,
      sevenDayMinutesToExhaustion: budget.sevenDay.minutesToExhaustion,
      capacityConfigured: budget.capacityConfigured,
    },
    comparison,
    drill: {
      context_history: 'get_context_history(sessionId) — per-step context blocks + diffs (what changed each turn)',
      context_composition: 'get_context_composition(sessionId) — what occupies the context window per turn',
    },
    ...(r.matchedBy === 'workspace-latest'
      ? { message: 'No live session under this workspace in the last 10 min — returning the most recent one (live:false).' }
      : {}),
  }
}
