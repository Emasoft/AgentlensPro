// Keep-warm / cache-gap diagnostic (P6) — runtime-neutral (imported by the host AND the webview).
//
// The Anthropic prompt cache expires ~5 minutes after the last request. A session whose turns are
// spaced past that TTL re-pays the FULL prefix at the cache-WRITE rate (1.25×) on the next call
// instead of reading it at 0.1× — a 12.5× price difference on the dominant token bucket, invisible
// in per-turn totals because the turn "worked". This module measures it per session, from the
// claude_code.api_request timeline entries (the per-call ground truth: exact timestamps + the four
// disjoint cache buckets).
//
// Classification, per consecutive api_request pair (prev → cur):
//   • gap < TTL                                → cur is a WARM turn (the cache was still alive).
//   • gap ≥ TTL and cur re-WROTE the prefix    → cur is a COLD turn; its cache_creation tokens are
//     (cacheCreate > cacheRead)                  the measured waste (a warm turn would have READ them).
//   • gap ≥ TTL but no re-write signature      → counted in NEITHER bucket: the TTL passed but no
//                                                penalty was observed (tiny prefix / missing buckets) —
//                                                inventing waste there would be a lie.
// The FIRST api_request of a session follows no gap — its cache write is the unavoidable session
// warm-up, never "waste" — so it is excluded from both buckets by construction.
//
// Honest absence: a session with NO api_request entries returns null (rich OTEL logging off, or not
// a Claude Code session) — never zeros presented as measurements.

import type { TimelineEntry } from './summarizerTypes'

/** Anthropic prompt-cache TTL (~5 min after the last request). The single constant every
 *  keep-warm consumer (MCP tools, dashboard badge, tests) compares gaps against. */
export const CACHE_TTL_MS = 5 * 60_000

export interface KeepWarmReport {
  /** Turns that landed inside the TTL — the cache was still warm when they hit. */
  warmTurns: number
  /** Turns that followed a ≥TTL gap AND re-wrote the prefix (cacheCreate > cacheRead). */
  coldTurns: number
  /** Σ cache_creation tokens over the cold turns — the prefix re-writes a kept-warm cadence
   *  would have paid at the 0.1× read rate instead of the 1.25× write rate. */
  wastedWriteTokens: number
  /** Largest gap between consecutive api_requests, in minutes (1 decimal). 0 with <2 requests. */
  worstGapMin: number
}

/**
 * Measure a session's cache keep-warm behaviour from its timeline. Returns null when the timeline
 * carries no api_request entries with a parseable timestamp (honest absence — see header).
 */
export function computeKeepWarm(timeline: TimelineEntry[], ttlMs: number = CACHE_TTL_MS): KeepWarmReport | null {
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

  let warmTurns = 0
  let coldTurns = 0
  let wastedWriteTokens = 0
  let worstGapMs = 0
  for (let i = 1; i < requests.length; i++) {
    const gap = requests[i].ts - requests[i - 1].ts
    if (gap > worstGapMs) worstGapMs = gap
    if (gap < ttlMs) {
      warmTurns++
    } else if (requests[i].cacheCreate > requests[i].cacheRead) {
      // The TTL expired AND this call re-wrote more prefix than it read — the cold signature.
      coldTurns++
      wastedWriteTokens += requests[i].cacheCreate
    }
    // gap ≥ TTL without the re-write signature: neither bucket (no observed penalty — header note).
  }
  return {
    warmTurns,
    coldTurns,
    wastedWriteTokens,
    worstGapMin: Math.round(worstGapMs / 60_000 * 10) / 10,
  }
}
