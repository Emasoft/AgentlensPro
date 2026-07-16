// Cache-expiry probe (TRDD-OCNHOHE9) — pure, runtime-neutral (no Node/DOM).
//
// Answers "has this session's prompt cache expired?" by comparing the idle time since its
// last LLM request against the session's TTL. The TTL itself is NEVER re-declared here — it
// comes from classifyTtlRegime (src/shared/cacheTtl.ts, the one place TTL numbers live), so a
// subagent correctly reads 5-min and a subscription main reads 1h. This module only does the
// idle math + the fresh/expired decision, and inherits cacheTtl's honesty contract: a missing
// last-request time yields 'unknown', an unresolved regime surfaces its 'assumed' provenance —
// it never presents a guessed number as fact.

import {
  classifyTtlRegime,
  type SessionTtlKind,
  type TtlContext,
  type TtlSource,
} from './shared/cacheTtl'

export interface CacheExpiryInput {
  /** Epoch-ms of the session's most recent LLM (api_request) call, or null if none recorded. */
  lastRequestAtMs: number | null
  /** Epoch-ms "now" (injected so the assessment is pure and testable). */
  nowMs: number
  /** Session lineage kind (sessionTtlKindOf(card)); null when it cannot be resolved. */
  kind: SessionTtlKind | null
  /** Machine auth/override context (getTtlContext()); null when unresolved. */
  ctx: TtlContext | null
  /** Explicit user cutoff in ms. When > 0 it WINS over the regime TTL (e.g. "> 1h" probe). */
  thresholdMs?: number
}

export interface CacheExpiryVerdict {
  /** 'fresh' = cache likely warm; 'expired' = likely evicted; 'unknown' = no last-request time. */
  verdict: 'fresh' | 'expired' | 'unknown'
  idleMs: number | null
  idleHuman: string | null
  /** The TTL the verdict was measured against (regime TTL, or the explicit override). */
  ttlMs: number
  ttlMin: number
  ttlSource: TtlSource
  ttlBasis: string
  /** ttlMs − idleMs; negative when expired, null when idle is unknown. */
  marginMs: number | null
  usedThresholdOverride: boolean
  /** One human line — always the WHY when verdict is 'unknown'. */
  reason: string
}

/** Compact idle duration: "45s" · "1m 30s" · "1h 2m". Hours drop the seconds; negatives clamp to 0s. */
export function formatIdle(ms: number): string {
  const totalSec = Math.floor(Math.max(0, ms) / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

export function assessCacheExpiry(input: CacheExpiryInput): CacheExpiryVerdict {
  const regime = classifyTtlRegime(input.kind, input.ctx)
  // A positive explicit threshold is itself a signal, so it overrides the regime TTL AND its
  // provenance (the user's cutoff decided the number → 'config'), while usedThresholdOverride
  // records that we departed from the resolved regime so a reader can tell.
  const override = input.thresholdMs != null && input.thresholdMs > 0
  const ttlMs = override ? (input.thresholdMs as number) : regime.ttlMs
  const ttlMin = Math.round(ttlMs / 60_000)
  const base = {
    ttlMs,
    ttlMin,
    ttlSource: (override ? 'config' : regime.ttlSource) as TtlSource,
    ttlBasis: override
      ? `explicit --threshold-minutes=${ttlMin} override (regime would use ${regime.ttlAssumedMin}m)`
      : regime.ttlBasis,
    usedThresholdOverride: override,
  }

  if (input.lastRequestAtMs == null) {
    return {
      verdict: 'unknown',
      idleMs: null,
      idleHuman: null,
      marginMs: null,
      reason: 'no LLM request recorded for this session — cannot measure idle time or cache freshness',
      ...base,
    }
  }

  // Every cache HIT resets the inactivity timer, so idle is correctly measured from the LAST
  // request. A future timestamp (clock skew across machines) clamps to 0 rather than reporting
  // a nonsensical negative idle.
  const idleMs = Math.max(0, input.nowMs - input.lastRequestAtMs)
  const expired = idleMs > ttlMs
  return {
    verdict: expired ? 'expired' : 'fresh',
    idleMs,
    idleHuman: formatIdle(idleMs),
    marginMs: ttlMs - idleMs,
    reason: expired
      ? `idle ${formatIdle(idleMs)} exceeds the ${ttlMin}-min TTL — the cached prefix has likely been evicted; the next request pays a full cache-creation write (~1.25× the prefix)`
      : `idle ${formatIdle(idleMs)} is within the ${ttlMin}-min TTL — the cached prefix is likely still warm`,
    ...base,
  }
}
