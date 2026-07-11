/**
 * Window-capacity auto-calibration (P5) — turns a rate-limit hit into a MEASURED window capacity.
 *
 * Anthropic does not publish the raw 5h/7d window caps, so get_window_budget's projections were dead
 * on unconfigured machines (`capacitySource: none`). But the cap IS observable: the moment a
 * rate-limit-class StopFailure kills a turn BEFORE the account's 5h window rolled, the consumption
 * accumulated since the window started is a proven LOWER BOUND on the cap. This module snapshots that
 * figure from the live per-account consumption stream and persists it into the burn config
 * (~/.agentlens/burn-config.json `observed` section) that loadBurnConfig/computeWindowBudget already
 * read — so projections + time-to-exhaustion + the remaining-window warning clause work with zero
 * manual config.
 *
 * Hard rules (each has a test):
 *   - only rate-limit-CLASS StopFailures calibrate (an auth/network turn death proves nothing);
 *   - NEVER clobber user-configured capacity — any manual cap (env or file) disables calibration;
 *   - a PREMATURE window end is a measurement, a natural 5h rollover is NOT (window-age guard:
 *     consumption straddling the 5h boundary means the window rolled — skip);
 *   - per-account granularity (rate limits are per OAuth account);
 *   - later observations may RAISE an observed figure, never lower it (ratchet);
 *   - atomic write (temp+rename via atomicWriteFileSync) and refuse-unparseable — a torn or
 *     corrupt config is never overwritten with a "fresh" one (the 2026-07-07 settings.json lesson).
 */

import * as fs from 'fs'
import * as path from 'path'
import {
  burnConfigPath, loadBurnConfig, observeCapacityFromPrematureEnd,
  type ConsumptionEvent, type ObservedAccountCapacity,
} from './burnMonitor'
import { atomicWriteFileSync } from './serverRuntime'
import type { HookEventRecord } from './hookEventStore'
import type { SessionSummaryCard } from './shared/summarizerTypes'

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
/** How far past the 5h boundary we look for earlier consumption. Any account activity in this margin
 *  BEFORE (stall − 5h) means the rolling 5h sum straddles a window boundary — i.e. the account's real
 *  window started >5h ago and rolled naturally, so the sum mixes two windows and is NOT a cap. */
export const ROLLOVER_LOOKBACK_MS = 30 * 60 * 1000

// Rate-limit-class signatures seen in real StopFailure payloads ("429 rate_limit_error: exceeded",
// "usage limit reached", "overloaded_error", 529). Deliberately NOT matching generic "error"/"timeout"
// — a network or auth turn death says nothing about window capacity.
const RATE_LIMIT_RE = /rate.?limit|usage.?limit|limit (?:reached|exceeded)|too many requests|overloaded|quota|\b(?:429|529)\b/i

/** True when a StopFailure hook payload carries a rate-limit-class error. Only the payload's
 *  dedicated error fields are scanned — matching the whole payload would false-positive on
 *  paths/prompts that merely contain the words. */
export function isRateLimitStopFailure(payload: Record<string, unknown>): boolean {
  for (const key of ['error', 'message', 'reason'] as const) {
    const v = payload[key]
    if (typeof v === 'string' && RATE_LIMIT_RE.test(v)) return true
  }
  return false
}

export interface CalibrationDeps {
  /** The live machine-wide consumption stream (gatherBurn().events at the stall moment). */
  events: ConsumptionEvent[]
  /** The live session cards — resolve the stalled session's OAuth account (card.accountId). */
  sessions: SessionSummaryCard[]
  /** The current live OAuth account — fallback when the stalled session carries no attribution. */
  currentAccountUuid: string | null
  env: NodeJS.ProcessEnv
  homeDir: string
}

export interface CalibrationOutcome {
  calibrated: boolean
  /** Human-readable why (logged by the server; every skip names its guard). */
  reason: string
  accountUuid?: string
  observed?: ObservedAccountCapacity
}

/** Field-wise ratchet: an observed figure only ever goes UP. A later window that consumed LESS before
 *  limiting proves nothing about the cap (the limit may be cost-weighted, the window partially spent
 *  before our telemetry started, …) — but a window that consumed MORE proves the cap is at least that. */
function ratchet(prev: ObservedAccountCapacity | undefined, next: ObservedAccountCapacity): { merged: ObservedAccountCapacity; raised: boolean } {
  if (!prev) return { merged: next, raised: true }
  const up = (a: number | null, b: number | null): number | null =>
    a === null ? b : b === null ? a : Math.max(a, b)
  const merged: ObservedAccountCapacity = {
    window5hTokens: up(prev.window5hTokens, next.window5hTokens),
    window7dTokens: up(prev.window7dTokens, next.window7dTokens),
    window5hCostUsd: up(prev.window5hCostUsd, next.window5hCostUsd),
    window7dCostUsd: up(prev.window7dCostUsd, next.window7dCostUsd),
    observedAt: prev.observedAt,
  }
  const raised =
    merged.window5hTokens !== prev.window5hTokens || merged.window7dTokens !== prev.window7dTokens ||
    merged.window5hCostUsd !== prev.window5hCostUsd || merged.window7dCostUsd !== prev.window7dCostUsd
  if (raised) merged.observedAt = next.observedAt   // the calibration date is the last RAISING observation
  return { merged, raised }
}

/**
 * The ingest-path hook: called by the standalone server for every StopFailure hook event. Applies all
 * the guards, measures the account's window consumption at the stall, and atomically persists the
 * observed capacity. Returns an outcome for logging; never throws on a malformed config (it refuses
 * instead) — only a genuine fs write failure propagates.
 */
export function calibrateFromStopFailure(rec: HookEventRecord, deps: CalibrationDeps): CalibrationOutcome {
  if (rec.ev !== 'StopFailure') return { calibrated: false, reason: `not a StopFailure event (${rec.ev})` }
  if (!isRateLimitStopFailure(rec.payload)) {
    return { calibrated: false, reason: 'StopFailure error is not rate-limit-class — no capacity information' }
  }

  // NEVER clobber user-configured capacity: any manual cap (env or file) disables calibration
  // entirely. Checked against a FRESH load, not a boot-time snapshot — the user may have configured
  // a cap while the server was running.
  const config = loadBurnConfig(deps.env, deps.homeDir)
  if (config.capacitySource === 'env' || config.capacitySource === 'config') {
    return { calibrated: false, reason: `capacity is user-configured (${config.capacitySource}) — auto-calibration never overrides it` }
  }

  // The HOT account: the stalled session's own OAuth account when attributed, else the live account.
  const sessionAccount = rec.session
    ? deps.sessions.find(s => s.sessionId === rec.session)?.accountId ?? null
    : null
  const accountUuid = sessionAccount ?? deps.currentAccountUuid
  if (!accountUuid) {
    return { calibrated: false, reason: 'no OAuth account resolvable for the stalled session — nothing to key the observation by' }
  }

  const stopTs = rec.ts
  const accountEvents = deps.events.filter(e => (e.accountUuid ?? null) === accountUuid)
  const in5h = accountEvents.filter(e => e.ts >= stopTs - FIVE_HOURS_MS && e.ts <= stopTs)
  if (in5h.length === 0) {
    return { calibrated: false, reason: `no consumption attributed to account ${accountUuid} in the 5h before the stall — nothing to measure` }
  }

  // Window-age guard: consumption in the lookback margin BEFORE the 5h boundary means the account was
  // already burning >5h ago — its real window started back then and rolled naturally at some point
  // inside our 5h sum. That sum mixes two windows: a rollover is NOT a capacity measurement.
  const straddles = accountEvents.some(e =>
    e.ts >= stopTs - FIVE_HOURS_MS - ROLLOVER_LOOKBACK_MS && e.ts < stopTs - FIVE_HOURS_MS)
  if (straddles) {
    return { calibrated: false, reason: 'consumption straddles the 5h boundary — the window rolled naturally, not a premature end' }
  }

  // The window START is the account's first event inside the 5h span: with the straddle guard above,
  // the account was idle for ≥30min before it, which is how a fresh Anthropic 5h window begins
  // (first message after the previous window lapsed).
  // reduce, not Math.min(...spread): in5h is a slice of the machine-wide consumption stream (up to
  // ~100k events), and an argument-spread that large can hit V8's max-arguments limit → RangeError —
  // during exactly the high-volume burst this calibrates from. (observeCapacityFromPrematureEnd already
  // loops for the same reason.)
  const windowStartMs = in5h.reduce((m, e) => Math.min(m, e.ts), Infinity)
  const measured5h = observeCapacityFromPrematureEnd(deps.events, accountUuid, windowStartMs, stopTs)
  if (measured5h.tokens <= 0 && measured5h.costUsd <= 0) {
    return { calibrated: false, reason: 'measured window consumption is zero — nothing to persist' }
  }
  // The trailing-7d consumption at the stall is an observed FLOOR of the weekly cap too: the account
  // provably consumed this much within 7d (the limit that fired was the 5h one, so the weekly cap is
  // at least this). It ratchets upward across observations exactly like the 5h figure.
  const measured7d = observeCapacityFromPrematureEnd(deps.events, accountUuid, stopTs - SEVEN_DAYS_MS, stopTs)

  const next: ObservedAccountCapacity = {
    window5hTokens: measured5h.tokens > 0 ? measured5h.tokens : null,
    window7dTokens: measured7d.tokens > 0 ? measured7d.tokens : null,
    window5hCostUsd: measured5h.costUsd > 0 ? measured5h.costUsd : null,
    window7dCostUsd: measured7d.costUsd > 0 ? measured7d.costUsd : null,
    observedAt: new Date(stopTs).toISOString(),
  }
  const { merged, raised } = ratchet(config.observed[accountUuid], next)
  if (!raised) {
    return { calibrated: false, reason: 'a prior observation is already ≥ this one on every figure — observed capacity never lowers', accountUuid }
  }

  // Persist: merge into the RAW file (preserving thresholds/notify/any manual fields verbatim) and
  // write atomically. An existing-but-unparseable file is REFUSED, never replaced — silently starting
  // fresh is the exact pattern that wiped a user's settings.json on 2026-07-07.
  const configPath = burnConfigPath(deps.env, deps.homeDir)
  let raw: Record<string, unknown> = {}
  try {
    if (fs.existsSync(configPath)) {
      raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { calibrated: false, reason: `refusing to write: ${configPath} is not a JSON object`, accountUuid }
      }
    }
  } catch {
    return { calibrated: false, reason: `refusing to write: ${configPath} exists but is unparseable — never clobber a corrupt config`, accountUuid }
  }
  const observedSection = (raw.observed && typeof raw.observed === 'object' && !Array.isArray(raw.observed))
    ? raw.observed as Record<string, unknown>
    : {}
  observedSection[accountUuid] = merged
  raw.observed = observedSection
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  atomicWriteFileSync(configPath, JSON.stringify(raw, null, 2) + '\n')

  return {
    calibrated: true,
    reason: `observed 5h capacity ${merged.window5hTokens ?? '—'} tokens / $${merged.window5hCostUsd ?? '—'} for account ${accountUuid} (window ${new Date(windowStartMs).toISOString()} → ${new Date(stopTs).toISOString()})`,
    accountUuid,
    observed: merged,
  }
}
