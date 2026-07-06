// Browser-side type definitions for AgentLens dashboard
// These mirror the backend types from src/types.ts and src/summarizers/summarizerTypes.ts

export interface Span {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  startTime: string
  endTime: string
  attributes: SpanAttribute[]
  status?: SpanStatus
  receivedAt?: number
}

export interface SpanAttribute {
  key: string
  value: {
    stringValue?: string
    intValue?: number
    doubleValue?: number
    boolValue?: boolean
    arrayValue?: unknown
    kvlistValue?: unknown
  }
}

export interface SpanStatus {
  code: number
  message?: string
}

export type LoopSignalType =
  | 'exact_tool_repeat'
  | 'edit_revert_cycle'
  | 'error_recurrence'
  | 'runaway_steps'
  | 'token_runaway'

export interface LoopSignal {
  type: LoopSignalType
  severity: 'warning' | 'critical'
  evidence: string
  count: number
  examples: string[]
  patternName: string
  action: string
}

export interface SessionSummaryCard {
  sessionId: string
  traceId: string
  source: 'copilot' | 'claude_code' | 'codex' | 'opencode'
  dataSource: 'otel' | 'log'
  initiator?: 'user' | 'agent' | 'api'
  conversationId?: string
  // Mirror of src/summarizers/summarizerTypes.ts — session that spawned this one (sub-agent/fork).
  parentSessionId?: string
  // 1-based turn of the parent at which this child was spawned (the Task/Agent tool_use turn).
  spawnedByTurn?: number
  // Mirror of src/summarizers/summarizerTypes.ts — sub-agent spawn taxonomy (fork = cache-warm;
  // fresh/worktree/fleet = cold) + the requested model/isolation. Set only on child cards.
  spawnKind?: 'fresh' | 'fork' | 'worktree' | 'fleet'
  spawnModelOverride?: string
  spawnIsolation?: string
  workspace: string
  projectPath?: string
  userRequest: string
  model: string
  turns: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreateTokens: number
  cacheHitRate: number
  durationMs: number
  startTime: string
  filesRead: string[]
  filesSearched: string[]
  filesChanged: string[]
  filesChangedNote?: string
  toolCounts: Record<string, number>
  totalToolCalls: number
  totalLlmCalls: number
  errors: number
  outcome: 'text_response' | 'tool_calls' | 'unknown'
  timeline: TimelineEntry[]
  backgroundSpans: BackgroundSpanSummary[]
  loopSignals: LoopSignal[]
  peakContextPerTurn?: number
  filesWritten: string[]
  fileOps?: FileOpSummary[]     // per-file read/write/edit byte volumes (Claude log sessions)
}

// Mirror of src/summarizers/summarizerTypes.ts FileOpSummary. Read bytes = file text pulled
// into context; write/edit bytes = content produced. ~tokens ≈ bytes / 4.
export interface FileOpSummary {
  path: string
  readBytes: number
  writeBytes: number
  editBytes: number
  readCount: number
  writeCount: number
  editCount: number
}

export interface TimelineEntry {
  type: 'llm' | 'tool' | 'user_input' | 'background'
  spanId: string
  label: string
  turn?: number   // 1-based turn index this entry belongs to (mirror of summarizerTypes.ts)
  thinking?: string
  model?: string
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreateTokens?: number
  ttft?: number
  durationMs: number
  action?: string
  responseText?: string
  resultSummary?: string
  fullResult?: string
  toolInput?: string
  decision?: string
  isError: boolean
  errorMessage?: string
  timestamp: string
  editDetails?: EditDetail[]
}

export interface EditDetail {
  filePath: string
  oldString?: string
  newString?: string
  content?: string
  toolName?: string
}

// Mirror of src/summarizers/summarizerTypes.ts — per-turn context-composition breakdown (P3).
// Token figures are ESTIMATES (bytes/4); loaded on demand per session via a loadContextComposition
// message so thousands of attachments are never shipped at once.
export interface ContextSource {
  label: string
  kind: string
  tokens: number
  bytes: number
  count: number
}
export interface ContextCompositionTurn {
  turn: number
  sources: ContextSource[]
}
export interface ContextComposition {
  sessionId: string
  turns: ContextCompositionTurn[]
  estimated: true
  truncated: boolean
}

// Mirror of src/summarizers/summarizerTypes.ts — cache-break diagnosis (P4). A prefix cache breaks
// at the first divergent block turn-to-turn; these carry the per-turn verdict + ranked offenders the
// Cache tab / trace markers render. Sizing is an estimate; the cause taxonomy pinpoints WHY.
export type CacheBreakCause =
  | 'TOOLS_CHANGED'
  | 'TOOLS_REORDERED'
  | 'SYSTEM_PROMPT_TIMESTAMP'
  | 'MODEL_SWITCHED'
  | 'EFFORT_CHANGED'
  | 'FAST_MODE'
  | 'MCP_SERVER_TOGGLE'
  | 'PLUGIN_TOGGLE'
  | 'TOOL_DENY'
  | 'INJECTED_BLOCK_CHANGED'
  | 'COMPACTION'
  | 'UPGRADE'
  | 'RESUME_AFTER_UPGRADE'
  | 'IDLE_TTL_EXPIRY'
  | 'UNKNOWN'

export interface CacheBreakTurn {
  turn: number
  broke: boolean
  cause: CacheBreakCause
  breakSourceLabel?: string
  breakSourceKind?: string
  wastedTokens: number
  wastedCostUsd: number
  idleGapMs?: number
  remediation?: string
}

export interface CacheBreakOffender {
  label: string
  kind: string
  cause: CacheBreakCause
  occurrences: number
  wastedTokens: number
  wastedCostUsd: number
}

export interface CacheBreakReport {
  sessionId: string
  turns: CacheBreakTurn[]
  offenders: CacheBreakOffender[]
  totalWastedTokens: number
  totalWastedCostUsd: number
  cacheHitRate: number
}

export interface EfficiencyReport {
  totalInputTokens: number
  totalOutputTokens: number
  totalLlmCalls: number
  avgInputPerCall: number
  avgTtft: number
  cacheHitRate: number
  toolDefWaste: number
  sysInstructionWaste: number
  topTokenConsumers: Array<{ label: string; tokens: number }>
}

export interface BackgroundSpanSummary {
  name: string
  model: string
  purpose: string
  inputTokens: number
  outputTokens: number
}

export interface FullSummary {
  sessions: SessionSummaryCard[]
  backgroundSpans: BackgroundSpanSummary[]
  efficiency: EfficiencyReport
}

// ── Phase 4 analytics types ───────────────────────────────────────────────────

export interface DailyStatRow {
  day: string              // 'YYYY-MM-DD'
  totalTokens: number
  cacheReadTokens: number
  cacheCreateTokens: number
  outputTokens: number
  costUsd: number
  sessionCount: number
}

export interface LifetimeStats {
  totalSessions: number
  totalTokens: number
  totalCostUsd: number
  oldestSessionMs: number
  newestSessionMs: number
}

export interface BurnRate {
  tokensPerMinute: number
  costPerHour: number
}

export interface Projection {
  totalTokens: number
  totalCostUsd: number
  remainingMinutes: number
  contextFillPct: number
}

export interface SearchQuery {
  text?: string
  source?: string
  model?: string
  since?: number
  until?: number
  minCostUsd?: number
  orderBy?: 'start_time' | 'cost_usd' | 'total_tokens' | 'duration_ms' | 'errors'
  orderDir?: 'ASC' | 'DESC'
  limit?: number
  offset?: number
}

export type AgentFilter = 'all' | 'copilot' | 'claude_code' | 'codex' | 'opencode'
export type InitiatorFilter = 'all' | 'user' | 'agent' | 'api'
export type DataSourceFilter = 'all' | 'otel' | 'log'
export type InsightFilter = 'all' | 'loop' | 'efficiency'
export type WorkspaceFilter = 'all' | string

export interface VsCodeApi {
  postMessage(message: unknown): void
  getState(): unknown
  setState(state: unknown): void
}

// Insight type used by Recommendations and Efficiency tabs
export interface Insight {
  severity: 'loop-critical' | 'loop-warning' | 'warning' | 'info'
  category: 'loop' | 'efficiency'
  sessionIdx?: number
  title: string
  detail: string
  action: string
  helpId?: string
  _loopType?: LoopSignalType
}

// Span tree node used by Traces and Flow tabs
export interface SpanTreeNode {
  span: Span
  children: SpanTreeNode[]
  depth: number
}

declare global {
  interface Window {
    acquireVsCodeApi(): VsCodeApi
    __INITIAL_TOOL_CALLS__?: Record<string, number>
    __INITIAL_SESSION_SUMMARY__?: FullSummary | null
    __MASCOT_URI__?: string
    __STANDALONE__?: boolean
  }
}
