// ── OTLP log-event classification — the ONE source of truth for both ingest paths ─────────────
// Two OTLP ingestion implementations exist (src/otlpCollector.ts for the VS Code extension,
// standalone/server.ts processLogs for the npx/Docker server) and they DRIFTED: the collector
// gained the rich-event gate while the standalone never did, so the deployment actually running
// on most machines silently dropped every api_request/compaction/api_error event regardless of
// naming convention (found 2026-07-10 while live-verifying the bare-name fix — the unit-tested
// collector passed while the running server still ingested nothing). The event-name resolution,
// prefix normalization, and gate SETS live here so the two paths can never disagree again.

/**
 * Resolve a log record's event name. Order: an explicit name attribute (the value the caller
 * already extracted from attrs — legacy convention) → the OTLP 1.4+ LogRecord `event_name`
 * PROTO FIELD (`eventName` in JSON: modern OTel SDKs put the event name HERE, not in
 * attributes) → a plain string body.
 */
export function resolveLogEventName(fromAttrs: string, rec: Record<string, unknown>): string {
  if (fromAttrs) return fromAttrs
  const en = rec['eventName']
  if (typeof en === 'string' && en) return en
  const body = rec['body']
  const b = (typeof body === 'object' && body !== null) ? (body as Record<string, unknown>)['stringValue'] : undefined
  return typeof b === 'string' ? b : ''
}

/**
 * Strip the `claude_code.` prefix. Claude Code changed conventions across versions: the docs
 * (and older builds) prefix event names, 2.1.206 emits BARE names (the prefixed strings do not
 * exist in that binary). Gates compare the bare form; STORED span names are always re-prefixed
 * (`claude_code.${bare}`) because spanSummarizer keys on the prefixed names.
 */
export function bareLogEventName(name: string): string {
  return name.startsWith('claude_code.') ? name.slice('claude_code.'.length) : name
}

// Rich Claude Code LOG events (per code.claude.com/docs monitoring-usage): the per-call ground
// truth the llm_request SPANS lack — exact cost + who caused the call (query_source / agent /
// skill / plugin / mcp), compaction burn, API errors. Bare (prefix-stripped) names.
export const CLAUDE_RICH_LOG_EVENTS: ReadonlySet<string> = new Set([
  'api_request', 'compaction', 'api_error', 'api_retries_exhausted',
])

// Raw API request/response body POINTER events (OTEL_LOG_RAW_API_BODIES). Bare names.
export const BODY_POINTER_LOG_EVENTS: ReadonlySet<string> = new Set([
  'api_request_body', 'api_response_body',
])
