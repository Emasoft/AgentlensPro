// Log-event sink (TRDD-AMEA4O4Z) — persist every OTEL log event the rich-event gate REJECTS,
// instead of dropping it. The gate (src/otlpLogEvents.ts) converts only {api_request, compaction,
// api_error, api_retries_exhausted} + tool_result + body pointers into spans; everything else —
// user_prompt, assistant_response, tool_decision, hook_execution_*, mcp_server_connection,
// plugin_loaded, hook_registered, skill_activated, subagent_completed — used to be counted and
// DISCARDED. The settings explicitly request these events (OTEL_LOG_USER_PROMPTS=1 etc.), and
// several exist nowhere else (permission decisions, lifecycle events are NOT in the transcripts),
// so discarding them was real data loss (USER directive 2026-07-16: lose no logged data).
//
// Sink format: append-only NDJSON daily buckets (<data>/log-events/YYYY-MM-DD.ndjsonl) via the
// shared src/ndjsonBuckets.ts machinery — same shape as hook-events, same retention model.
// The record builder lives HERE, shared by BOTH OTLP ingest paths (standalone processLogs and
// src/otlpCollector.ts), because the two paths drifted apart once already; one builder = the
// persisted shape can never disagree between them.

import { appendBucketLine, bucketsDiskUsage, purgeBuckets } from './ndjsonBuckets'

/** Wire-format OTLP attribute as both ingest paths carry it at the gate. */
export interface WireAttr { key: string; value: Record<string, unknown> }

export interface DroppedLogEventRecord {
  /** Server receive time (ms epoch). */
  ts: number
  /** Bare (prefix-stripped) event name — the gate's comparison key. */
  ev: string
  /** The original wire name, verbatim (may carry the claude_code. prefix). */
  name: string
  /** session.id / session_id when the event carries one. */
  session?: string
  traceId?: string
  spanId?: string
  /** The record's own timeUnixNano → ms, when present (emit time, vs ts = receive time). */
  tsEvent?: number
  severity?: string
  /** ALL merged attributes, flattened key → primitive (arrays/kvlists kept as raw objects) —
   *  nothing on the wire record is discarded. */
  attrs: Record<string, unknown>
  /** A plain string body, when present. kvlist bodies are omitted here because both call sites
   *  merge them into attrs BEFORE the gate (attrsFromBodyKv) — persisting them again would
   *  double the data without adding any. */
  body?: string
}

/** Unwrap one OTLP JSON attribute value: {stringValue}/{intValue}/{boolValue}/{doubleValue}/
 *  {arrayValue}/{kvlistValue} → the inner value verbatim. intValue arrives as a STRING in OTLP
 *  JSON — kept verbatim (lossless beats convenient: Number() would corrupt 64-bit ids). */
function unwrapAttrValue(v: Record<string, unknown>): unknown {
  for (const k of ['stringValue', 'intValue', 'doubleValue', 'boolValue', 'arrayValue', 'kvlistValue', 'bytesValue']) {
    if (k in v) return v[k]
  }
  return v // unknown wrapper shape — keep raw rather than lose it
}

/** Build the persisted record from exactly what a gate drop site has in hand: the resolved names,
 *  the MERGED wire attrs, and the raw log record. Pure — shared by both ingest paths. */
export function buildDroppedLogEventRecord(
  name: string,
  bare: string,
  wireAttrs: WireAttr[],
  rec: Record<string, unknown>,
  ts: number = Date.now(),
): DroppedLogEventRecord {
  const attrs: Record<string, unknown> = {}
  for (const a of wireAttrs) {
    if (typeof a?.key === 'string' && a.value && typeof a.value === 'object') {
      attrs[a.key] = unwrapAttrValue(a.value)
    }
  }
  const session = typeof attrs['session.id'] === 'string' && attrs['session.id']
    ? attrs['session.id'] as string
    : (typeof attrs['session_id'] === 'string' && attrs['session_id'] ? attrs['session_id'] as string : undefined)

  // timeUnixNano is a decimal-string ns count; /1e6 in float is exact enough for ms until ~2255.
  let tsEvent: number | undefined
  const tun = rec['timeUnixNano']
  if (typeof tun === 'string' && /^\d+$/.test(tun)) tsEvent = Math.round(Number(tun) / 1e6)
  else if (typeof tun === 'number' && Number.isFinite(tun) && tun > 0) tsEvent = Math.round(tun / 1e6)

  const body = rec['body']
  const bodyStr = (typeof body === 'object' && body !== null && typeof (body as Record<string, unknown>)['stringValue'] === 'string')
    ? (body as Record<string, unknown>)['stringValue'] as string
    : undefined

  return {
    ts,
    ev: bare,
    name,
    ...(session ? { session } : {}),
    ...(typeof rec['traceId'] === 'string' && rec['traceId'] ? { traceId: rec['traceId'] as string } : {}),
    ...(typeof rec['spanId'] === 'string' && rec['spanId'] ? { spanId: rec['spanId'] as string } : {}),
    ...(tsEvent !== undefined ? { tsEvent } : {}),
    ...(typeof rec['severityText'] === 'string' && rec['severityText'] ? { severity: rec['severityText'] as string } : {}),
    attrs,
    ...(bodyStr !== undefined ? { body: bodyStr } : {}),
  }
}

/** Append one record to its day bucket. Returns bytes written (for persistence accounting). */
export function appendDroppedLogEvent(dir: string, rec: DroppedLogEventRecord): { bytes: number } {
  const { bytes } = appendBucketLine(dir, rec.ts, JSON.stringify(rec))
  return { bytes }
}

/** Delete daily buckets older than retentionDays (foreign files never touched). */
export function purgeLogEventBuckets(dir: string, retentionDays: number): { removed: string[]; freedBytes: number } {
  return purgeBuckets(dir, retentionDays)
}

export function logEventsDiskUsage(dir: string): { files: number; bytes: number } {
  return bucketsDiskUsage(dir)
}
