// src/otelCallEvents.ts — one record per Claude Code API call, read from the OTEL span store.
//
// WHY THIS EXISTS: the raw-body scan (cacheCreationForensics.ts) attributes a call by walking the
// `diagnostics.previous_message_id` chain — the FOLLOWING request names the response it replies to.
// That chain structurally cannot attribute two calls we care about most: a session's most recent
// call (nothing follows it yet) and a compaction's own summarization call (the next request does not
// chain to it). Both land in an "unattributable" bucket.
//
// The `claude_code.api_request` OTEL event has no such problem: it carries `session.id` DIRECTLY,
// plus every token bucket, `cost_usd`, `query_source` (which labels the compaction call `compact`),
// and `request_id` — the API id that the raw body files are named after, so it is also the join key
// BACK to a body when one is still on the spool. Measured 2026-07-26: `request_id` matched a body
// filename 482/2046 in one day (the shortfall is RAM-disk spool eviction, not a join failure), while
// `client_request_id` matched 0/1993 — the similar name is a trap, it is NOT the body key.
//
// COST: prefer `cost_usd` over recomputing from the rate table. Claude Code's own price table is
// cache-TTL-tier aware (a 1-hour write bills at 2x base input, a 5-minute write at 1.25x) and ours
// was not; recomputing a 1h write at the 5m rate under-reports it by 60%. Verified to the cent on a
// live call: in=2, read=62,610, write=405,521 (all 1h), out=133 -> cost_usd 4.089850, which only
// $10.00/MTok reproduces.

import { SegmentedSpanStore } from './segmentedSpanStore'
import { dataPath } from './dataDir'
import { makeRssSampler } from './serverRuntime'
import type { Span, SpanAttribute } from './shared/telemetryTypes'

export const API_REQUEST_SPAN = 'claude_code.api_request'
export const COMPACTION_SPAN = 'claude_code.compaction'

export interface OtelCallEvent {
  ts: number                      // epoch ms
  sessionId: string
  requestId?: string              // the `req_…` API id — also the raw-body filename stem
  model?: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreateTokens: number
  /** Claude Code's OWN cost figure for this call — tier-aware, authoritative, never recomputed. */
  costUsd: number | null
  querySource?: string            // repl_main_thread | compact | agent:* | agent_summary | away_summary | …
  speed?: string
  effort?: string
  agentName?: string
}

/** A `claude_code.compaction` event: what a compaction did to the context, straight from the harness. */
export interface OtelCompactionEvent {
  ts: number
  sessionId: string
  trigger?: string                // manual | auto | …
  preTokens?: number
  postTokens?: number
}

export interface OtelScanCoverage {
  spansDir: string
  windowHours?: number
  spansScanned: number
  apiRequests: number
  compactions: number
  note: string
}

function attrMap(attrs: readonly SpanAttribute[] | undefined): Map<string, string | number | boolean> {
  const m = new Map<string, string | number | boolean>()
  for (const a of attrs ?? []) {
    const v = a.value ?? {}
    const val = v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue
    if (val !== undefined) m.set(a.key, val)
  }
  return m
}

function num(v: string | number | boolean | undefined): number {
  if (typeof v === 'number') return isFinite(v) ? v : 0
  if (typeof v === 'string') { const n = Number(v); return isFinite(n) ? n : 0 }
  return 0
}
function str(v: string | number | boolean | undefined): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/** Call time, most reliable source first. The api_request LOG event carries an ISO `event.timestamp`;
 *  its span start/end are often "0" because it is an event, not a timed span, so `receivedAt`
 *  (collector wall-clock) is the fallback before the nanosecond span start. */
function eventTimeMs(span: Span, a: Map<string, string | number | boolean>): number {
  const iso = str(a.get('event.timestamp'))
  if (iso) { const t = Date.parse(iso); if (!isNaN(t)) return t }
  if (typeof span.receivedAt === 'number' && span.receivedAt > 0) return span.receivedAt
  const start = Number(span.startTime)
  return isFinite(start) && start > 0 ? Math.floor(start / 1e6) : 0
}

export interface OtelScanOptions {
  spansDir?: string
  windowHours?: number
  /** Absolute lower bound in epoch ms; overrides windowHours when set. */
  sinceMs?: number
  untilMs?: number
  nowMs?: number
}

/** Read every `claude_code.api_request` (and `claude_code.compaction`) event in the window.
 *  Returns [] with an explanatory coverage note when the span store is absent — never throws, so a
 *  caller can always fall back to the raw-body scan. */
export function scanOtelCallEvents(opts: OtelScanOptions = {}): {
  events: OtelCallEvent[]
  compactions: OtelCompactionEvent[]
  coverage: OtelScanCoverage
} {
  const spansDir = opts.spansDir ?? dataPath('spans')
  const now = opts.nowMs ?? Date.now()
  const until = opts.untilMs ?? now
  const since = opts.sinceMs ?? (opts.windowHours ? now - opts.windowHours * 3_600_000 : 0)

  // forEachInRange, NOT loadRange: this scan keeps only `api_request` and `compaction` spans, a
  // small fraction of the window, but loadRange returns EVERY span in the window in one array —
  // so an unbounded query (windowHours undefined ⇒ since 0 ⇒ the entire store) materialized ~1M
  // span objects to discard almost all of them on the next line, and killed the server with a V8
  // heap OOM at ~4 GB. With the visitor, peak memory follows what is KEPT, not the window
  // (TRDD-QK3L5QAS).
  const events: OtelCallEvent[] = []
  const compactions: OtelCompactionEvent[] = []
  // Counted rather than derived from an array's length: nothing holds the scanned spans any more,
  // which is the entire point — so the coverage figure has to be tallied as they go past.
  let spansScanned = 0

  // The try must span BOTH the construction and the read. It used to, because the read was the
  // `loadRange` call sitting inside it; `flush()` still runs on the read path and can throw, so
  // wrapping only the constructor would turn a degradation (fall back to the raw-body scan) into a
  // thrown error. On failure the partially-filled arrays are discarded with the fallback return,
  // exactly as an aborted loadRange used to yield nothing.
  // In-scan rss trail (TRDD-34B9JAZK): this walk visits millions of spans synchronously, so the
  // request log cannot sample during it — every 500k spans, one line to server.log brackets a
  // climb that would otherwise end in a silent kill with no trace past the tool-start line.
  const rssSample = makeRssSampler('otel-span-scan', 500_000)
  try {
    const store = new SegmentedSpanStore(spansDir, () => { /* read-only: ingest errors are not ours */ })
    // Line prefilter (TRDD-9NAUEUUR): this scan only ever keeps API_REQUEST_SPAN/COMPACTION_SPAN
    // spans out of millions, so parsing every discarded line was the dominant transient-heap
    // churn (~2GB/GC, rss sawtoothing 2.6→4.7GB over a 5.4M-span walk). The substring test is
    // CONSERVATIVE-SAFE, not a heuristic: any raw line whose JSON.parse would yield
    // `name: "claude_code.api_request"` (or `.compaction`) necessarily contains that exact
    // substring somewhere in the line, so this can only produce false POSITIVES (the span name
    // string appears inside some OTHER field's value, e.g. an attribute), never a false negative
    // — the `s.name !==` check right below still filters those out at zero cost beyond the one
    // extra JSON.parse. No span this scan wants can ever be skipped by this line.
    const linePrefilter = (line: string): boolean =>
      line.includes(API_REQUEST_SPAN) || line.includes(COMPACTION_SPAN)
    store.forEachInRange(since, until, (s: Span) => {
      spansScanned += 1
      rssSample()
      if (s.name !== API_REQUEST_SPAN && s.name !== COMPACTION_SPAN) return
      const a = attrMap(s.attributes)
      const sessionId = str(a.get('session.id'))
      if (!sessionId) return
      const ts = eventTimeMs(s, a)
      if (s.name === COMPACTION_SPAN) {
        compactions.push({
          ts, sessionId,
          trigger: str(a.get('trigger')),
          preTokens: a.has('pre_tokens') ? num(a.get('pre_tokens')) : undefined,
          postTokens: a.has('post_tokens') ? num(a.get('post_tokens')) : undefined,
        })
        return
      }
      // cost_usd_micros is the precise integer form; prefer it and fall back to the float.
      const micros = a.has('cost_usd_micros') ? num(a.get('cost_usd_micros')) : null
      const costUsd = micros !== null ? micros / 1e6 : (a.has('cost_usd') ? num(a.get('cost_usd')) : null)
      events.push({
        ts, sessionId,
        requestId: str(a.get('request_id')),
        model: str(a.get('model')),
        inputTokens: num(a.get('input_tokens')),
        outputTokens: num(a.get('output_tokens')),
        cacheReadTokens: num(a.get('cache_read_tokens')),
        cacheCreateTokens: num(a.get('cache_creation_tokens')),
        costUsd,
        querySource: str(a.get('query_source')),
        speed: str(a.get('speed')),
        effort: str(a.get('effort')),
        agentName: str(a.get('agent.name')),
      })
    }, linePrefilter)
  } catch {
    return {
      events: [], compactions: [],
      coverage: {
        spansDir, windowHours: opts.windowHours, spansScanned: 0, apiRequests: 0, compactions: 0,
        note: `No readable OTEL span store at ${spansDir} — falling back to the raw-body scan, which cannot attribute a session's newest call or a compaction's own summarization call.`,
      },
    }
  }

  events.sort((x, y) => x.ts - y.ts)
  compactions.sort((x, y) => x.ts - y.ts)

  return {
    events, compactions,
    coverage: {
      spansDir, windowHours: opts.windowHours,
      spansScanned, apiRequests: events.length, compactions: compactions.length,
      note: `Scanned ${spansScanned} span(s) from the OTEL store; ${events.length} api_request event(s) carry session.id + cost_usd directly (no previous_message_id chain needed).`,
    },
  }
}
