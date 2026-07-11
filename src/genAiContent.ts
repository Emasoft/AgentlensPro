// Shared formatter for gen_ai_latest_experimental response-content log events.
//
// WHY THIS EXISTS (S3-F3b): the gen_ai instrumentation (Codex/OpenAI SDKs) does NOT put the
// assistant's response text on the LLM span — it emits it as a SEPARATE `gen_ai.choice` /
// `gen_ai.assistant.message` LOG event correlated to the span by traceId:spanId. Both the
// (extension-host) OtlpCollector and the shipped standalone server must turn that raw event
// content into the `gen_ai.output.messages` shape the summarizer's extractResponseText reads.
// The formatter lived only inside otlpCollector.ts; the standalone needed the same logic, so
// it moved here as the ONE copy both import (no duplicated formatter — the drift class that
// already bit the log-event gate).

import { countFallback } from './shared/fallbackCounters'

// Normalises a gen_ai.choice or gen_ai.assistant.message event content value into the
// gen_ai.output.messages array format expected by extractResponseText in the summarizer.
// Returns '' when the raw content is unparseable (the response text is then silently absent —
// counted via the fallback meter so it is observable, never a hard failure).
export function formatGenAiEventContent(raw: string, eventName: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    // gen_ai.choice wraps the message: { finish_reason, index, message: { role, content } }
    const msg: Record<string, unknown> = eventName === 'gen_ai.choice' && parsed.message
      ? parsed.message as Record<string, unknown>
      : parsed
    const role = msg.role ?? 'assistant'
    let content = msg.content
    // Normalise string content to block array format for extractResponseText compatibility
    if (typeof content === 'string') {
      content = [{ type: 'text', text: content }]
    }
    return JSON.stringify([{ role, content }])
  } catch {
    // Unparseable gen_ai event content → the response text is silently lost; count it (P6).
    countFallback('otlp.genAiEventUnparseable')
    return ''
  }
}
