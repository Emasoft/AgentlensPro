// Webview-side type surface. The card/timeline/diagnosis types and the telemetry types are NOT
// declared here — they live in src/shared/ (runtime-neutral, imported by both the host and this
// webview) and are re-exported below so webview modules keep importing from './types'. Only
// webview-SPECIFIC message/UI types may be declared in this file: scripts/check-no-mirrors.js
// fails the build if a top-level declaration here shadows a src/shared export.

import type { Span, LoopSignalType } from '../../src/shared/telemetryTypes'
import type { ContextBlockKind, TokenSource, FullSummary } from '../../src/shared/summarizerTypes'

export type * from '../../src/shared/telemetryTypes'
export type * from '../../src/shared/summarizerTypes'

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

// Mirror of src/contextCompositionIndex.ts (TRDD-CTXQUERY, dashboard piece 1) — the compact per-session
// OTEL-raw-body composition summary served by /api/composition-index/:id. Pointer-only: token counts +
// refs, never bytes. `imageKind` composition taxonomy adds 'image' on top of ContextBlockKind.
export type CompositionBlockKind = ContextBlockKind | 'image'

export interface CompositionPeakCall {
  turn: number
  contextTokens: number
  contextPct: number          // percent (0..100+)
  windowSize: number
  tokenSource: TokenSource
  imageTokens: number
  imageCount: number
  toolResultTokens: number
  textTokens: number
  thinkingTokens: number
  systemTokens: number
  toolCatalogTokens: number
  otherTokens: number
}

export interface CompositionResidentBlob {
  signature: string
  kind: CompositionBlockKind
  label: string
  isImage: boolean
  peakTokens: number
  occurrences: number
  residentTurns: number
  firstSeenTurn: number
  lastSeenTurn: number
  cumulativeReadTokens: number
  cumulativeReadCostUsd: number
  sampleTurn: number          // drill key for /api/block-content (0 when none)
  sampleBlockIndex: number    // drill key (−1 when none)
}

export interface CompositionSummary {
  sessionId: string
  accountUuid?: string
  project: string
  model?: string
  callsTotal: number
  callsWithExactUsage: number
  peakCall: CompositionPeakCall | null
  images: {
    count: number
    tokens: number
    firstSeenTurn: number
    residentTurns: number
    cumulativeReadTokens: number
    cumulativeReadCostUsd: number
  }
  residentBlobs: CompositionResidentBlob[]
  coverageNote?: string
}

// One drilled block (get_block_content / /api/block-content). An IMAGE block carries metadata + ref
// only — never `text` (the base64 bytes are never stored or transported).
export interface CompositionBlockContent {
  sessionId: string
  turn: number
  index?: number
  kind?: CompositionBlockKind
  label?: string
  tokens?: number
  bytes?: number
  role?: string
  isImage?: boolean
  mediaType?: string
  bodyRef?: string
  text?: string
  message?: string            // present instead of block fields when the turn/block wasn't resolvable
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
  // TRDD-BURNWDGT — the current live OAuth account (identity + plan), enriched at the server for the
  // dashboard. Null when ~/.claude.json has no oauthAccount. No secret — only public identity + plan.
  currentAccount?: {
    accountId: string | null
    label: string
    email: string | null
    organizationName: string | null
    planType: string | null
    billingType: string | null
    hasExtraUsageEnabled: boolean
  } | null
  // TRDD-CTXQUERY (dashboard piece 3) — proactive eviction-candidate flag: blocks resident across many
  // turns (the "525k images re-read every turn" case), server-scanned on a slow cadence. Empty when none.
  residentBlobs?: Array<{
    sessionId: string; project: string; kind: string; label: string; isImage: boolean
    peakTokens: number; residentTurns: number; cumulativeReadTokens: number; cumulativeReadCostUsd: number
  }>
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
