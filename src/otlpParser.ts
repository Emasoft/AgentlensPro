import { Span, SpanAttribute } from './shared/telemetryTypes'
import { CodexSessionNormalizer, isCodexPromptEventName } from './codexSessionNormalizer'

export type OtlpPayloadKind = 'traces' | 'logs' | 'metrics' | 'unknown'

export function classifyOtlpPayload(payload: unknown): OtlpPayloadKind {
  if (typeof payload !== 'object' || payload === null) { return 'unknown' }
  const obj = payload as Record<string, unknown>
  if (Array.isArray(obj.resourceSpans)) { return 'traces' }
  if (Array.isArray(obj.resourceLogs)) { return 'logs' }
  if (Array.isArray(obj.resourceMetrics)) { return 'metrics' }
  return 'unknown'
}

export function toSpanAttributes(raw: unknown): SpanAttribute[] {
  if (!Array.isArray(raw)) { return [] }
  return raw
    .map(item => {
      const obj = item as Record<string, unknown>
      const key = typeof obj.key === 'string' ? obj.key : ''
      const value = obj.value as SpanAttribute['value'] | undefined
      if (!key || !value || typeof value !== 'object') { return undefined }
      return { key, value }
    })
    .filter((x): x is SpanAttribute => Boolean(x))
}

function attrsFromBodyKv(body: unknown): SpanAttribute[] {
  if (typeof body !== 'object' || body === null) { return [] }
  const obj = body as Record<string, unknown>
  const kv = obj.kvlistValue as Record<string, unknown> | undefined
  const values = kv?.values
  if (!Array.isArray(values)) { return [] }
  const attrs: SpanAttribute[] = []
  for (const v of values) {
    const entry = v as Record<string, unknown>
    const key = typeof entry.key === 'string' ? entry.key : ''
    const value = entry.value as SpanAttribute['value'] | undefined
    if (!key || !value || typeof value !== 'object') { continue }
    attrs.push({ key, value })
  }
  return attrs
}

function mergeAttributes(...lists: SpanAttribute[][]): SpanAttribute[] {
  const out: SpanAttribute[] = []
  const seen = new Set<string>()
  for (const list of lists) {
    for (const attr of list) {
      if (seen.has(attr.key)) { continue }
      seen.add(attr.key)
      out.push(attr)
    }
  }
  return out
}

function setStringAttr(attrs: SpanAttribute[], key: string, value: string): SpanAttribute[] {
  if (!value) { return attrs }
  let replaced = false
  const next = attrs.map(attr => {
    if (attr.key !== key) { return attr }
    replaced = true
    return { key, value: { stringValue: value } }
  })
  return replaced ? next : [...next, { key, value: { stringValue: value } }]
}

function withStringAttr(attrs: SpanAttribute[], key: string, value: string): SpanAttribute[] {
  if (!value || attrs.some(attr => attr.key === key)) { return attrs }
  return [...attrs, { key, value: { stringValue: value } }]
}

export function getAttrFrom(attrs: SpanAttribute[], ...keys: string[]): string {
  for (const key of keys) {
    const a = attrs.find(x => x.key === key)
    if (!a) { continue }
    const val = a.value?.stringValue ?? a.value?.intValue ?? a.value?.doubleValue
    if (val !== undefined && val !== null && String(val).length > 0) {
      return String(val)
    }
  }
  return ''
}

function isCodexWebsocketSpan(spanName: string, attrs: SpanAttribute[]): boolean {
  const name = spanName.toLowerCase()
  if (!name.includes('websocket')) { return false }
  const eventName = getAttrFrom(attrs, 'event.name', 'event_name', 'name', 'event').toLowerCase()
  const hasCodexAttr = Boolean(getAttrFrom(attrs, 'codex.session.id', 'codex.conversation.id', 'codex.turn.id'))
  return name.startsWith('codex.') || eventName.startsWith('codex.') || hasCodexAttr
}

export function parseTracePayload(payload: unknown): Span[] {
  const p = payload as { resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: unknown[] }> }> }
  const rawSpans = p?.resourceSpans?.flatMap(rs =>
    rs.scopeSpans?.flatMap(ss => ss.spans ?? []) ?? []
  ) ?? []

  const result: Span[] = []
  for (const raw of rawSpans) {
    const span = raw as Record<string, unknown>
    if (typeof span.traceId !== 'string' || typeof span.spanId !== 'string' || typeof span.name !== 'string') {
      continue
    }
    const attrs = toSpanAttributes(span.attributes)
    if (isCodexWebsocketSpan(span.name, attrs)) { continue }
    result.push({
      traceId: span.traceId,
      spanId: span.spanId,
      parentSpanId: (span.parentSpanId as string) || undefined,
      name: span.name,
      startTime: span.startTimeUnixNano as string,
      endTime: span.endTimeUnixNano as string,
      attributes: attrs,
      status: span.status as { code: number; message?: string } | undefined,
    })
  }
  return result
}

export function parseLogPayload(payload: unknown): Span[] {
  type LogRecord = Record<string, unknown>
  type ScopeLogs = { logRecords?: LogRecord[]; scope?: { attributes?: unknown } }
  type ResourceLogs = { scopeLogs?: ScopeLogs[]; resource?: { attributes?: unknown } }
  const p = payload as { resourceLogs?: ResourceLogs[] }
  // Per-payload instance ⇒ Codex grouping state is scoped to THIS payload, exactly as the old
  // per-call closure maps were (S3-F3a: the grouping now lives in one shared normalizer).
  const codexNorm = new CodexSessionNormalizer()
  // Trace→root-span map stays local: it links child Codex spans to their prompt's root span, a
  // concern separate from session resolution (used only for parentSpanId synthesis below).
  const codexSessionRootByTrace = new Map<string, string>()

  const result: Span[] = []
  for (const rl of p?.resourceLogs ?? []) {
    const resourceAttrs = toSpanAttributes(rl.resource?.attributes)
    for (const sl of rl.scopeLogs ?? []) {
      const scopeAttrs = toSpanAttributes(sl.scope?.attributes)
      for (const rec of sl.logRecords ?? []) {
        const recordAttrs = toSpanAttributes(rec.attributes)
        const bodyAttrs = attrsFromBodyKv(rec.body)
        let attrs = mergeAttributes(recordAttrs, bodyAttrs, scopeAttrs, resourceAttrs)

        const bodyObj = (typeof rec.body === 'object' && rec.body !== null)
          ? (rec.body as Record<string, unknown>)
          : undefined

        const eventName = getAttrFrom(attrs, 'event.name', 'event_name', 'name', 'event')
          || (typeof bodyObj?.stringValue === 'string' ? bodyObj.stringValue : '')

        if (!eventName.startsWith('codex.')) { continue }
        if (isCodexWebsocketSpan(eventName, attrs)) { continue }

        const otlpTraceId = (typeof rec.traceId === 'string' && rec.traceId) ? rec.traceId : ''
        const conversationId = getAttrFrom(attrs,
          'conversation.id',
          'conversation_id',
          'codex.conversation.id',
          'thread.id',
          'thread_id',
          'session.id',
          'session_id',
          'trace_id',
          'traceId',
        )
        if (!otlpTraceId && !conversationId) { continue }

        const spanId = (typeof rec.spanId === 'string' && rec.spanId)
          ? rec.spanId
          : getAttrFrom(attrs, 'span_id', 'spanId') || `cl-${Math.random().toString(36).slice(2, 10)}`
        const turnId = getAttrFrom(attrs, 'turn.id', 'turn_id', 'codex.turn.id')
        const conversationKey = conversationId || otlpTraceId
        const sessionId = codexNorm.resolveSessionId({
          conversationId: conversationKey,
          otlpTraceId,
          turnId,
          spanName: eventName,
        })
        const traceId = sessionId || otlpTraceId || conversationKey

        if (sessionId) {
          attrs = setStringAttr(attrs, 'codex.session.id', sessionId)
          attrs = setStringAttr(attrs, 'codex.conversation.id', conversationKey)
          if (turnId) { attrs = setStringAttr(attrs, 'codex.turn.id', turnId) }
        }
        if (otlpTraceId && sessionId && otlpTraceId !== traceId) {
          attrs = withStringAttr(attrs, 'otel.trace_id', otlpTraceId)
        }

        let parentSpanId = getAttrFrom(attrs, 'parent_span_id', 'parentSpanId') || undefined
        if (isCodexPromptEventName(eventName)) {
          codexSessionRootByTrace.set(traceId, spanId)
        } else if (traceId && !parentSpanId) {
          parentSpanId = codexSessionRootByTrace.get(traceId)
        }
        const timeNano = String(rec.timeUnixNano ?? rec.observedTimeUnixNano ?? '0')

        result.push({
          traceId,
          spanId,
          parentSpanId,
          name: eventName,
          startTime: timeNano,
          endTime: timeNano,
          attributes: attrs,
          status: undefined,
        })
      }
    }
  }
  return result
}
