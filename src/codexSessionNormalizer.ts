// ── Codex per-prompt session grouping — the ONE source of truth ────────────────────────────────
// Three OTLP log-ingest impls need the SAME Codex session grouping: src/otlpParser.ts
// (parseLogPayload), src/otlpCollector.ts (the OtlpCollector class), and standalone/server.ts
// (processLogs — the SHIPPED npx/Docker path). Before S3-F3a the logic lived inline in the first
// two and was ABSENT from the third, so the deployment actually running on most machines grouped
// Codex by conversation-id alone instead of per prompt (`codex:<conv>:prompt-N`). This class holds
// that grouping ONCE. It is a pure structural extraction of otlpParser's inline `resolveSessionId`
// closure (per-call maps → instance fields, closures → methods) — no behavior change.
//
// Lifetime: a per-PAYLOAD caller (otlpParser) makes a fresh instance per call, so state is scoped
// to one payload exactly as the old per-call closures were. A long-lived caller (OtlpCollector, the
// standalone server) holds ONE instance so the prompt-ordinal + trace→session maps persist across
// payloads/requests — matching the pre-extraction behavior of those callers' private fields.

/** True for the Codex log/span event names that OPEN a new prompt cycle. */
export function isCodexPromptEventName(name: string): boolean {
  return name === 'codex.user_prompt'
    || name === 'codex.prompt'
    || name === 'codex.user_message'
    || name === 'codex.session_start'
}

export class CodexSessionNormalizer {
  private codexSessionByOtelTraceId = new Map<string, string>()
  private codexCurrentSessionByConversation = new Map<string, string>()
  private codexSessionStateById = new Map<string, { hasPrompt: boolean }>()
  private codexPromptOrdinalByConversation = new Map<string, number>()
  private codexActivePromptSessionId = ''

  /**
   * The prompt session most recently mapped for `otlpTraceId`, if any. The collector's
   * processTraces path reads this to fold a raw trace-only span into its prompt cycle without
   * re-running resolveSessionId (it previously reached into the private map directly).
   */
  sessionByOtelTraceId(otlpTraceId: string): string | undefined {
    return this.codexSessionByOtelTraceId.get(otlpTraceId)
  }

  private getSessionState(sessionId: string): { hasPrompt: boolean } {
    let state = this.codexSessionStateById.get(sessionId)
    if (!state) {
      state = { hasPrompt: false }
      this.codexSessionStateById.set(sessionId, state)
    }
    return state
  }

  private nextPromptSessionId(conversationId: string): string {
    const next = (this.codexPromptOrdinalByConversation.get(conversationId) ?? 0) + 1
    this.codexPromptOrdinalByConversation.set(conversationId, next)
    return `codex:${conversationId}:prompt-${next}`
  }

  resolveSessionId(opts: {
    conversationId: string
    otlpTraceId?: string
    turnId?: string
    spanName: string
  }): string | undefined {
    const isPrompt = isCodexPromptEventName(opts.spanName)
    let sessionId = opts.otlpTraceId ? this.codexSessionByOtelTraceId.get(opts.otlpTraceId) : undefined

    if (isPrompt) {
      const currentSessionId = this.codexCurrentSessionByConversation.get(opts.conversationId)
      const currentState = currentSessionId ? this.getSessionState(currentSessionId) : undefined
      if (!sessionId && currentSessionId && !currentState?.hasPrompt) {
        sessionId = currentSessionId
      }
      if (!sessionId) {
        sessionId = opts.turnId
          ? `codex:${opts.conversationId}:${opts.turnId}`
          : this.nextPromptSessionId(opts.conversationId)
      } else if (this.getSessionState(sessionId).hasPrompt) {
        sessionId = opts.turnId
          ? `codex:${opts.conversationId}:${opts.turnId}`
          : this.nextPromptSessionId(opts.conversationId)
      }
    } else if (sessionId) {
      // Existing raw OTEL trace was already mapped to the active prompt cycle.
    } else if (this.codexCurrentSessionByConversation.has(opts.conversationId)) {
      sessionId = this.codexCurrentSessionByConversation.get(opts.conversationId)
    } else if (this.codexActivePromptSessionId) {
      sessionId = this.codexActivePromptSessionId
    } else if (opts.turnId) {
      sessionId = `codex:${opts.conversationId}:${opts.turnId}`
    } else {
      return undefined
    }

    if (!sessionId) { return undefined }
    this.codexCurrentSessionByConversation.set(opts.conversationId, sessionId)
    if (opts.otlpTraceId) { this.codexSessionByOtelTraceId.set(opts.otlpTraceId, sessionId) }
    const state = this.getSessionState(sessionId)
    if (isPrompt) {
      state.hasPrompt = true
      this.codexActivePromptSessionId = sessionId
    }
    return sessionId
  }
}
