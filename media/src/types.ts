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
  // Session-level "generated files" group (TRDD-ZS1GDXVY) — mirror of summarizerTypes.ts. Served
  // lazily via /api/timeline (stripped from the bulk summary); truncated flag set when the bounded
  // scratch index hit its cap.
  generatedFiles?: GeneratedFileRef[]
  generatedFilesTruncated?: boolean
}

// Mirror of src/summarizers/summarizerTypes.ts GeneratedFileRef (TRDD-ZS1GDXVY). One output file
// produced/referenced by a session; content lazy-fetched on expand. Paths are local-only.
export interface GeneratedFileRef {
  path: string
  sizeBytes: number
  mtimeMs: number
  tokenEstimate: number
  origin: 'referenced' | 'scratch'
  missing?: boolean
}

// Lazy-fetched content of one generated/output file (TRDD-ZS1GDXVY) — the payload of a
// generatedFileContent message / /api/generated-file response. exists:false = deleted or blocked
// (the leaf renders a "file gone" state); truncated:true = capped at the 200KB display limit.
export interface GeneratedFileContent {
  path: string
  exists: boolean
  sizeBytes?: number
  mtimeMs?: number
  truncated?: boolean
  content?: string
  error?: string
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
  // 'api_request' / 'compaction' / 'api_error' are log-derived Claude Code events (mirror of
  // src/summarizers/summarizerTypes.ts) — they carry per-call ground truth (exact cost + attribution)
  // the llm_request SPANS lack. Kept in sync so the media mirror matches the backend shape 1:1.
  type: 'llm' | 'tool' | 'user_input' | 'background' | 'api_request' | 'compaction' | 'api_error'
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
  // Output files this tool call produced/referenced under the session scratch tree (TRDD-ZS1GDXVY,
  // mirror of summarizerTypes.ts) — expandable leaves whose content is lazy-fetched on expand.
  generatedFiles?: GeneratedFileRef[]
  // Mirror of src/summarizers/summarizerTypes.ts — set on DB-loaded entries whose blob fields were
  // stripped from the row; tells the trace UI it can lazy-fetch the FULL tool output via
  // loadBlob('full-result'). Absent on live sessions (fullResult already inline).
  hasBlob?: boolean
  // ── Attribution + burn fields for the log-derived Claude Code events (mirror of
  // src/summarizers/summarizerTypes.ts). All optional; set on api_request/compaction/api_error
  // entries, and surfaced per-call in the trace ("issued by <query_source> · agent · skill · mcp").
  costUsd?: number           // api_request: exact per-call cost (cost_usd) — ground truth, not estimated
  querySource?: string       // api_request: repl_main_thread | compact | <subagent name>
  agentName?: string         // api_request: agent.name (which sub-agent issued the call)
  skillName?: string         // api_request: skill.name
  pluginName?: string        // api_request: plugin.name
  mcpServerName?: string     // api_request: mcp_server.name
  mcpToolName?: string       // api_request: mcp_tool.name
  requestId?: string         // api_request / api_error: request_id (correlates with an llm_request span + its raw body)
  compactionTrigger?: string // compaction: auto | manual
  preTokens?: number         // compaction: context tokens before compaction
  postTokens?: number        // compaction: context tokens after compaction
  statusCode?: number        // api_error / api_retries_exhausted: HTTP status
  attempts?: number          // api_error: attempt # · api_retries_exhausted: total_attempts
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
  // Mirror of src/summarizers/summarizerTypes.ts — a capped excerpt of the ACTUAL injected text so
  // the recursive drill-down tree (P5) renders the real content of this block at a leaf. Undefined
  // when the attachment shape carried no extractable content text.
  excerpt?: string
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
  // Set when reconstructed from a parent session's transcript (fork / sub-agent with no own .jsonl).
  reconstructedFrom?: string
}

// Mirror of src/summarizers/summarizerTypes.ts — per-STEP context-history reconstruction. Each step
// carries the ACTUAL context blocks at that assistant turn (per-block token estimate + taxonomy) and
// a turn-to-turn diff. Loaded on demand so the trace tree can drill to real block content.
export type ContextBlockKind =
  | 'system' | 'claudemd' | 'rule' | 'toolCatalog' | 'skillCatalog' | 'agentCatalog' | 'mcp'
  | 'file' | 'toolInput' | 'toolOutput' | 'bashInput' | 'bashOutput' | 'hook' | 'skillPrompt'
  | 'agentPrompt' | 'userMsg' | 'assistantMsg' | 'reasoning' | 'postCompact' | 'subagentOutput'
  | 'harness' | 'cron' | 'reminder' | 'other'
export interface ContextBlock {
  id: string
  kind: ContextBlockKind
  label: string
  tokens: number
  bytes: number
  text: string
  role: 'input' | 'output'
  toolName?: string
}
export interface StepDiff {
  added: string[]
  removed: string[]
  changed: string[]
  firstChangeBlockId?: string
}
export interface ContextHistoryStep {
  turn: number
  timestamp?: string
  model?: string
  usage?: { input: number; output: number; cacheRead: number; cacheCreate: number }
  blocks: ContextBlock[]
  diff: StepDiff
}
export interface ContextHistory {
  sessionId: string
  steps: ContextHistoryStep[]
  estimated: true
  truncated: boolean
  reconstructedFrom?: string
}

// Mirror of src/summarizers/summarizerTypes.ts — the full literal context of ONE llm call
// (TRDD-ICHAVFCS), reconstructed from Claude Code's raw OTEL request body. Every element is an
// ordered ContextBlock drillable to its actual text; token figures are estimates (bytes/4).
export interface CallContext {
  requestId?: string
  sessionId: string
  model?: string
  blocks: ContextBlock[]
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
