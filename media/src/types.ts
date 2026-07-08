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
  // Mirror of src/summarizers/summarizerTypes.ts (TRDD-BURNWDGT) — the OAuth account that issued this
  // session's calls. accountId = raw account_uuid (identifier, not a secret); accountLabel = live-only
  // display resolution (email/org). Rate limits are per-account; per-account window budgets group by this.
  accountId?: string
  accountLabel?: string
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
  // Mirror of summarizerTypes.ts cost-integrity flags (TRDD-ZK37VG4X). unpriced = token traffic
  // with no pricing-table entry for the model: cost is UNKNOWN, not $0 — badge it, never hide it.
  unpriced?: boolean
  mergedFrom?: string[]
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
// Token figures are tokenEstimator ESTIMATES (TRDD-IQENK7JM); loaded on demand per session via a loadContextComposition
// message so thousands of attachments are never shipped at once.
// Mirror of src/summarizers/summarizerTypes.ts — how a token figure was derived (TRDD-IQENK7JM).
export type TokenSource = 'exact' | 'calibrated' | 'estimated'
export interface ContextSource {
  label: string
  kind: string
  tokens: number
  tokenSource?: TokenSource
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
  tokens: number              // CALIBRATED to the step's exact usage total when possible (TRDD-IQENK7JM)
  tokenSource?: TokenSource   // 'calibrated' | 'estimated' — drives the ≈/~ marker in BlockRow
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

// Mirror of src/summarizers/summarizerTypes.ts — resident-cost itemization (TRDD-W0RRL2FZ).
// residentCost = Σ over a block's occurrences of tokens × turns-resident (compaction-aware): the
// true cumulative context weight of a block, comparable to Σ per-turn usage. Derived in the webview
// by media/src/residentCost.ts (mirror of src/residentCost.ts) from an already-loaded ContextHistory.
export interface ResidentCostBlock {
  id: string
  kind: ContextBlockKind
  label: string
  tokens: number              // Σ tokens injected across all occurrences
  peakTokens: number
  occurrences: number
  firstSeenTurn: number
  lastResidentTurn: number
  turnsResident: number
  residentCost: number        // token·turns
  remediation: string
}

export interface ResidentCostReport {
  sessionId: string
  stepCount: number
  stepsWithUsage: number
  lastTurn: number
  compactionTurns: number[]
  totalContextTokens: number  // Σ per-step usage (input + cacheRead + cacheCreate) — exact
  itemizedResidentTokens: number
  unattributedTokens: number  // signed — negative = estimator overshoot (never clamped)
  note: string
  blocks: ResidentCostBlock[] // ranked heaviest first
  estimated: true
  truncated: boolean
}

// Mirror of src/summarizers/summarizerTypes.ts — the full literal context of ONE llm call
// (TRDD-ICHAVFCS), reconstructed from Claude Code's raw OTEL request body. Every element is an
// ordered ContextBlock drillable to its actual text; token figures are tokenizer estimates (see tokenSource).
export interface CallContext {
  requestId?: string
  sessionId: string
  model?: string
  blocks: ContextBlock[]
  truncated: boolean
}

// Mirror of src/summarizers/summarizerTypes.ts — an explicit collector-downtime window (TRDD-PJC8N1HO).
// The interval during which the collector was dead and every OTEL export was dropped/lost. Rendered as
// an "offline — telemetry lost" band so the gap is explicit instead of a silent hole in the timeline.
export interface CollectorGap {
  startedAt: string
  endedAt: string
  durationMs: number
  reason: 'crash' | 'shutdown'
}

// Mirror of src/summarizers/summarizerTypes.ts — spawn-cost rollup + cache-friendly-spawn advisor
// (TRDD-62E8UU41). Aggregate of a parent's sub-agent fan-out (per session, or per spawning turn):
// tokens/cost, the spawn-KIND mix, and antipattern detections (FLEET-COLD / WORKTREE-SCATTER /
// MODEL-MIX). Computed by media/src/spawnRollup.ts (mirror of src/spawnRollup.ts). Rendered as the
// per-turn spawn panel + the session-level "spawn cost" panel in Traces.
export type SpawnDetectionCode = 'FLEET-COLD' | 'WORKTREE-SCATTER' | 'MODEL-MIX'

export interface SpawnDetection {
  code: SpawnDetectionCode
  severity: 'HIGH' | 'MEDIUM'
  childCount: number
  wastedTokens: number
  wastedCostUsd: number
  message: string
  remediation: string
}

// `unknown` is FAIL-FAST: an absent/unrecognized spawnKind is counted here, never folded into fresh.
export interface SpawnKindMix {
  fresh: number
  fork: number
  worktree: number
  fleet: number
  modelOverride: number
  unknown: number
}

export interface SpawnRollup {
  childCount: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheCreateTokens: number
  totalCostUsd: number
  kindMix: SpawnKindMix
  detections: SpawnDetection[]
}

// Mirror of src/summarizers/summarizerTypes.ts — tokens-by-CAUSE attribution rollup (TRDD-UBEP5XY7).
// Groups every claude_code.api_request event by cause dimension (querySource → agent → skill → plugin
// → mcpServer → mcpTool) and sums the 4 usage buckets + the EXACT per-call cost_usd, so the session
// view can rank "who spent the tokens". Figures are exact ground truth (estimated:false). Computed by
// media/src/tokensByCause.ts (mirror of src/tokensByCause.ts). The unattributed bucket is explicit +
// labeled (FAIL-FAST — never silently dropped).
export type CauseDimension = 'querySource' | 'agent' | 'skill' | 'plugin' | 'mcpServer' | 'mcpTool'

export interface CauseRollupRow {
  dimension: CauseDimension
  key: string
  unattributed: boolean
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreateTokens: number
  totalTokens: number
  costUsd: number
  costKnown: boolean          // true iff every folded call carried a cost_usd (else costUsd is a floor)
}

export interface CauseDimensionRollup {
  dimension: CauseDimension
  rows: CauseRollupRow[]       // named causes heaviest-first; the unattributed row pinned LAST
  attributedCalls: number
  unattributedCalls: number
}

export interface CauseReconciliation {
  apiRequestCalls: number
  attributedInputTokens: number
  attributedOutputTokens: number
  attributedCacheReadTokens: number
  attributedCacheCreateTokens: number
  attributedTotalTokens: number
  attributedCostUsd: number
  costComplete: boolean
  costCalls: number
  sessionTotalTokens: number | null
  unattributedTotalTokens: number | null   // signed api_request coverage remainder, never clamped
  note: string
}

export interface TokensByCauseReport {
  sessionId?: string
  sessionsScanned?: number
  apiRequestCalls: number
  hasAttribution: boolean
  dimensions: CauseDimensionRollup[]
  reconciliation: CauseReconciliation
  estimated: false
  note: string
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

// ── Realtime burn monitor (TRDD-OG9PARZQ) — mirrors the subset of src/burnMonitor.ts the UI reads.
export interface BurnAlert {
  id: string
  rule: string
  severity: 'error' | 'warning' | 'info'
  label: string
  detail: string
  sessionId: string | null
  cause: string | null
}

// Mirror of src/burnMonitor.ts BurnBreakdown — the 4 token buckets (+ statusline `unknown`) summing to
// the window total. cache-read is ~96% of real workloads (resident context re-read every turn).
export interface BurnBreakdown {
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
  unknown: number
}

export interface BurnWindowConsumption {
  window: string
  consumedTokens: number
  consumedCostUsd: number
  consumedBillableWeighted: number   // cost-weighted tokens (cache-read 0.1×) — matters if the window is cost-based
  breakdown: BurnBreakdown
  capacityTokens: number | null
  pctConsumed: number | null
  // TRDD-BURNWDGT — cost-based capacity + % (present only when a cost cap is configured).
  capacityCostUsd?: number | null
  pctConsumedCost?: number | null
  minutesToExhaustion: number | null
}

// Mirror of src/burnMonitor.ts AccountWindowBudget (TRDD-BURNWDGT) — one OAuth account's own window
// budget. accountLabel is resolved live (email/org) at the server; null accountUuid = the unknown bucket.
export interface AccountWindowBudget {
  accountUuid: string | null
  accountLabel?: string
  budget: { fiveHour: BurnWindowConsumption; sevenDay: BurnWindowConsumption; capacityConfigured: boolean; note?: string }
  fiveMinTokensPerMin: number
  events: number
}

// Mirror of src/burnMonitor.ts BurnRateWindow (the fields the webview reads). `breakdown` holds window
// TOTALS; divide by windowMs/60000 to get per-minute.
export interface BurnRateWindowLite {
  windowMs: number
  tokensPerMin: number
  costPerMin: number
  breakdown: BurnBreakdown
  billableWeightedPerMin: number
}

export interface BurnStatus {
  now: number
  global: { oneMin: BurnRateWindowLite; fiveMin: BurnRateWindowLite; costPerHour: number }
  window: { fiveHour: BurnWindowConsumption; sevenDay: BurnWindowConsumption; capacityConfigured: boolean; note?: string }
  // TRDD-BURNWDGT — the machine-wide window split PER OAuth account (rate limits are per-account).
  accountWindows?: AccountWindowBudget[]
  alerts: BurnAlert[]
  activeSessions: number
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
