// Keep-warm / cache-gap diagnostic (P6 + TRDD-VY1IUVUM) — runtime-neutral (host AND webview).
//
// The Anthropic prompt cache expires after a per-session TTL (5 min or 1 hour — see the
// doc-verified matrix in ./cacheTtl). A session whose turns are spaced past ITS TTL re-pays the
// FULL prefix at the cache-WRITE rate (1.25×) on the next call instead of reading it at 0.1× — a
// 12.5× price difference on the dominant token bucket, invisible in per-turn totals because the
// turn "worked". This module measures it per session, from the claude_code.api_request timeline
// entries (the per-call ground truth: exact timestamps + the four disjoint cache buckets).
//
// TTL-AWARENESS (TRDD-VY1IUVUM): the TTL is NOT a global constant. The caller resolves the
// session's TtlRegime (kind × auth × env overrides — ./cacheTtl) and passes it in; a caller with
// no signals gets ASSUMED_TTL_REGIME, and the report SAYS so via ttlSource ('assumed') instead of
// silently guessing. The same 20-min gap is warm on a subscription main session (1h tier) and
// cold on a subagent (5-min tier).
//
// Classification, per consecutive api_request pair (prev → cur), against the EFFECTIVE TTL:
//   • gap < TTL                                → cur is a WARM turn (the cache was still alive).
//   • gap ≥ TTL and cur re-WROTE the prefix    → cur is a COLD turn; its cache_creation tokens are
//     (cacheCreate > cacheRead)                  the measured waste (a warm turn would have READ them).
//   • gap ≥ TTL but no re-write signature      → counted in NEITHER bucket: the TTL passed but no
//                                                penalty was observed (tiny prefix / missing buckets) —
//                                                inventing waste there would be a lie.
// The FIRST api_request of a session follows no gap — its cache write is the unavoidable session
// warm-up, never "waste" — so it is excluded from both buckets by construction.
//
// THE MEASURED FALSIFIER: a cache hit AFTER the assumed expiry contradicts the assumption. If any
// pair shows gap ≥ assumed TTL yet the following call READ a big prefix while writing almost
// nothing (cacheRead ≥ 1k and cacheCreate < cacheRead/4 — the same warm signature the cold-resume
// disarm uses), the entry provably survived that gap. The report then flags ttlContradicted,
// flips ttlSource to 'measured', and classifies against the measured floor: since Anthropic only
// enforces two tiers (5 min / 1 h), a survival past the 5-min tier proves the 1-hour tier — the
// effective TTL snaps to 1h (or to the observed gap itself in the anomalous >1h case) rather than
// to the bare gap, so a 20-min survival doesn't leave 21-min gaps mislabeled cold.
//
// Honest absence: a session with NO api_request entries returns null (rich OTEL logging off, or
// not a Claude Code session) — never zeros presented as measurements.

import type { TimelineEntry } from './summarizerTypes'
import { ASSUMED_TTL_REGIME, TTL_1H_MS, type TtlRegime, type TtlSource } from './cacheTtl'

export interface KeepWarmReport {
  /** Turns that landed inside the effective TTL — the cache was still warm when they hit. */
  warmTurns: number
  /** Turns that followed a ≥TTL gap AND re-wrote the prefix (cacheCreate > cacheRead). */
  coldTurns: number
  /** Σ cache_creation tokens over the cold turns — the prefix re-writes a kept-warm cadence
   *  would have paid at the 0.1× read rate instead of the 1.25× write rate. */
  wastedWriteTokens: number
  /** Largest gap between consecutive api_requests, in minutes (1 decimal). 0 with <2 requests. */
  worstGapMin: number
  /** The TTL the classification ran against, in minutes — the regime's assumption, or the
   *  measured tier when the falsifier contradicted it. */
  ttlAssumedMin: number
  /** Provenance of ttlAssumedMin: doc-matrix | config | measured | assumed — never omitted,
   *  so an absent signal is REPORTED as 'assumed' instead of silently guessed. */
  ttlSource: TtlSource
  /** True when a cache hit after the assumed expiry falsified the regime (details in ttlBasis). */
  ttlContradicted: boolean
  /** The largest gap (minutes, 1 decimal) the cache provably SURVIVED (warm hit after it) while
   *  the assumption said it should have expired. null when nothing contradicted the regime. */
  measuredWarmGapMin: number | null
  /** Provenance sentence for the TTL used (regime basis, or the contradiction evidence). */
  ttlBasis: string
}

/** Warm-hit signature for the falsifier: a big prefix READ with only a small (normal incremental
 *  suffix) write. The 1k floor keeps trivial prefixes from "proving" anything; the /4 share bound
 *  mirrors BodiesActivityTracker.sessionWarmSince (cc < cr × 0.25) so "warm" means the same thing
 *  in the falsifier and in the cold-resume disarm. */
function isWarmHit(cacheRead: number, cacheCreate: number): boolean {
  return cacheRead >= 1_000 && cacheCreate * 4 < cacheRead
}

/**
 * Measure a session's cache keep-warm behaviour from its timeline against its TTL regime.
 * Returns null when the timeline carries no api_request entries with a parseable timestamp
 * (honest absence — see header). Callers without resolved signals omit `regime` and get the
 * assumed 5-min floor, labeled as such.
 */
export function computeKeepWarm(timeline: TimelineEntry[], regime: TtlRegime = ASSUMED_TTL_REGIME): KeepWarmReport | null {
  // Only api_request entries carry the exact per-call timestamps + cache buckets this measurement
  // needs; llm spans can be missing (OTEL down) or lossy. Unparseable timestamps are dropped
  // rather than defaulted — a fabricated ts would fabricate a gap.
  const requests: { ts: number; cacheRead: number; cacheCreate: number }[] = []
  for (const e of timeline) {
    if (e.type !== 'api_request') continue
    const ts = Date.parse(e.timestamp || '')
    if (!Number.isFinite(ts)) continue
    requests.push({ ts, cacheRead: e.cacheReadTokens ?? 0, cacheCreate: e.cacheCreateTokens ?? 0 })
  }
  if (requests.length === 0) return null
  // Timelines are normally chronological, but merged/reparsed sessions can interleave — sort so a
  // spurious negative "gap" can never mis-classify a turn.
  requests.sort((a, b) => a.ts - b.ts)

  // ── Falsifier pass (BEFORE classification, so the contradiction corrects the buckets too):
  // find the largest gap the cache provably survived past the assumed TTL.
  let measuredWarmGapMs = 0
  for (let i = 1; i < requests.length; i++) {
    const gap = requests[i].ts - requests[i - 1].ts
    if (gap >= regime.ttlMs && isWarmHit(requests[i].cacheRead, requests[i].cacheCreate) && gap > measuredWarmGapMs) {
      measuredWarmGapMs = gap
    }
  }
  const contradicted = measuredWarmGapMs > 0
  // Only two tiers exist (doc fact): survival past the assumed tier proves the 1-hour tier.
  // Snapping to the tier (not the bare gap) keeps gaps BETWEEN the observation and the tier edge
  // from being mislabeled cold. A >1h survival is off-matrix (timer-reset semantics or a doc
  // change) — classify against the observation itself rather than inventing a bigger tier.
  const effectiveTtlMs = contradicted ? Math.max(TTL_1H_MS, measuredWarmGapMs + 1) : regime.ttlMs

  let warmTurns = 0
  let coldTurns = 0
  let wastedWriteTokens = 0
  let worstGapMs = 0
  for (let i = 1; i < requests.length; i++) {
    const gap = requests[i].ts - requests[i - 1].ts
    if (gap > worstGapMs) worstGapMs = gap
    if (gap < effectiveTtlMs) {
      warmTurns++
    } else if (requests[i].cacheCreate > requests[i].cacheRead) {
      // The TTL expired AND this call re-wrote more prefix than it read — the cold signature.
      coldTurns++
      wastedWriteTokens += requests[i].cacheCreate
    }
    // gap ≥ TTL without the re-write signature: neither bucket (no observed penalty — header note).
  }
  const toMin = (ms: number): number => Math.round(ms / 60_000 * 10) / 10
  return {
    warmTurns,
    coldTurns,
    wastedWriteTokens,
    worstGapMin: toMin(worstGapMs),
    ttlAssumedMin: Math.round(effectiveTtlMs / 60_000),
    ttlSource: contradicted ? 'measured' : regime.ttlSource,
    ttlContradicted: contradicted,
    measuredWarmGapMin: contradicted ? toMin(measuredWarmGapMs) : null,
    ttlBasis: contradicted
      ? `assumed ${regime.ttlAssumedMin}-min TTL (${regime.ttlSource}) CONTRADICTED: a cache hit landed ` +
        `${toMin(measuredWarmGapMs)}min after the last call — the entry survived, so the measured floor ` +
        `(${Math.round(effectiveTtlMs / 60_000)}min tier) was preferred`
      : regime.ttlBasis,
  }
}
