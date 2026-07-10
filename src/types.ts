// Host-only types. The runtime-neutral telemetry + loop-signal types (Span, SpanAttribute,
// SpanStatus, LoopSignal, LoopSignalType) live in src/shared/telemetryTypes.ts so the webview
// imports the same source instead of hand-mirroring them — do not re-declare them here.

export interface SessionSummary {
  totalSpans: number
  agentSessions: number
  toolCalls: Record<string, number>
  totalDurationMs: number
  tokensUsed: number
  filesChanged: string[]
  errors: number
  lastUpdated: Date
}
