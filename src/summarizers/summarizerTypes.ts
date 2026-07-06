import { LoopSignal } from '../types'

export interface SessionSummaryCard {
  sessionId: string
  traceId: string
  source: 'copilot' | 'claude_code' | 'codex' | 'opencode'
  dataSource: 'otel' | 'log'
  initiator?: 'user' | 'agent' | 'api'
  conversationId?: string
  // Session that spawned this one (sub-agent / Task / fork). Set on child sessions so the
  // dashboard can roll their tokens into the parent's total and render them as sub-branches.
  parentSessionId?: string
  // 1-based turn of the PARENT at which this child was spawned (the Task/Agent tool_use turn).
  // Lets the trace tree render the sub-agent as a sub-branch beneath the exact spawning turn.
  spawnedByTurn?: number
  // Spawn taxonomy for a sub-agent child (derived from the parent's Task/Agent/Workflow tool_use
  // input) — drives the spawn-kind badge + cache-warmth hint in the trace. fork = warm (reads the
  // parent cache); fresh/worktree/fleet = cold. spawnModelOverride/spawnIsolation carry the raw
  // `model`/`isolation` the spawn requested. Set only on child (sub-agent) cards.
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
  peakContextPerTurn?: number   // max single-turn (input + cacheRead + cacheCreate); undefined for single-turn sessions
  filesWritten: string[]        // files fully written (Write / create_file tools); subset of filesChanged
  fileOps?: FileOpSummary[]     // per-file read/write/edit byte volumes (Claude log sessions); see FileOpSummary
}

/** Per-file I/O volume for one session: how many bytes were read / written / edited for
 *  a path, and how many operations of each. Read bytes = the tool_result content length
 *  (the file text the agent pulled into context); write/edit bytes = the content the agent
 *  produced. Lets the dashboard show real per-file size + read-vs-write split and sort by
 *  it. Populated for Claude log sessions (the only source that records file tool I/O);
 *  an approximate token count is bytes / 4. */
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
  turn?: number   // 1-based turn (assistant message) index this entry belongs to; backbone for the trace tree
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
  // True when a blob (full tool result / response / thinking / tool input) was persisted for this
  // entry but stripped from the DB row to keep the payload light. Set by the reader on DB-loaded
  // sessions so the webview knows it can lazy-fetch the FULL tool output via loadBlob('full-result').
  // Absent on live/in-memory sessions (their entries carry fullResult inline already).
  hasBlob?: boolean
}

export interface EditDetail {
  filePath: string
  oldString?: string
  newString?: string
  content?: string
  toolName?: string
}

// ── Context-composition tracer (P3, TRDD-TKN5VALS) ────────────────────────────
// Per-turn breakdown of WHAT was injected into the context window and its approximate weight,
// reconstructed on demand from the raw session .jsonl (attachments = hook injections, the skill
// catalog, tool/agent/mcp catalog deltas, file reads, task reminders). Token counts are ESTIMATES
// (bytes/4) and always surfaced as such — the exact per-turn totals come from usage. Built lazily
// per session (buildContextComposition) so thousands of attachments are never shipped to the
// webview; only the aggregated, capped per-source summary is.
export interface ContextSource {
  label: string   // e.g. "hook: janitor-memory", "skill catalog", "file: CLAUDE.md"
  kind: string    // hook | skill | toolCatalog | agentCatalog | mcp | file | reminder | other
  tokens: number  // approximate (bytes / 4)
  bytes: number
  count: number   // entries aggregated into this source
}

export interface ContextCompositionTurn {
  turn: number
  sources: ContextSource[]   // heaviest-first, capped (remainder folded into an "other" source)
}

export interface ContextComposition {
  sessionId: string
  turns: ContextCompositionTurn[]
  estimated: true            // marker: token figures here are approximate
  truncated: boolean         // true if the session was larger than the parse cap
}

// ── Cache-break diagnosis (P4, TRDD-TKN5VALS) ─────────────────────────────────
// The prompt cache is a PREFIX cache: turn N reuses turn N-1 only up to the first byte that differs;
// everything after is re-billed as cache_creation (write rate) instead of cache_read (~10% of input).
// The classifier reconstructs each turn's ordered context blocks (ContextSource[]), diffs vs N-1,
// finds the FIRST divergent block = the break point, and labels the cause. Sizing is an ESTIMATE
// (the turn's cache_creation attributed to the break); the taxonomy pinpoints the CAUSE.
export type CacheBreakCause =
  | 'TOOLS_CHANGED'            // a tool added/removed/param-changed (the #1 cause)
  | 'TOOLS_REORDERED'         // same tool set, different order
  | 'SYSTEM_PROMPT_TIMESTAMP' // a moving clock/timestamp in the otherwise-static system prompt
  | 'MODEL_SWITCHED'          // model changed mid-session (caches are model-specific)
  | 'EFFORT_CHANGED'          // reasoning-effort level changed
  | 'FAST_MODE'               // fast mode toggled on
  | 'MCP_SERVER_TOGGLE'       // an MCP server whose tools load into the prefix connected/disconnected
  | 'PLUGIN_TOGGLE'           // a plugin providing non-deferred MCP tools toggled
  | 'TOOL_DENY'               // an entire tool denied
  | 'INJECTED_BLOCK_CHANGED'  // a supposedly-stable injected file/rule/memory or per-turn hook mutated
  | 'COMPACTION'              // conversation compaction rebuilt the message layer
  | 'UPGRADE'                 // Claude Code upgraded
  | 'RESUME_AFTER_UPGRADE'    // a session resumed after an upgrade (full re-read)
  | 'IDLE_TTL_EXPIRY'         // a >5-min gap let the cache entry expire (one-time, not structural)
  | 'UNKNOWN'                 // a break whose cause the diff couldn't localise

export interface CacheBreakTurn {
  turn: number
  broke: boolean              // did an AVOIDABLE break occur this turn (vs expected conversation growth)
  cause: CacheBreakCause
  breakSourceLabel?: string   // the first divergent block's label (e.g. "hook: janitor-memory")
  breakSourceKind?: string    // its kind (hook | toolCatalog | file | …)
  wastedTokens: number        // cache_creation tokens attributed to the avoidable break (estimate)
  wastedCostUsd: number       // 0 unless rates were supplied to the analyzer
  idleGapMs?: number          // inter-turn wall-clock gap (set when cause = IDLE_TTL_EXPIRY)
  remediation?: string        // one-line fix hint for this cause
}

export interface CacheBreakOffender {
  label: string
  kind: string
  cause: CacheBreakCause
  occurrences: number         // how many turns this source broke the cache
  wastedTokens: number        // cumulative across those turns
  wastedCostUsd: number
}

export interface CacheBreakReport {
  sessionId: string
  turns: CacheBreakTurn[]         // per-turn break verdicts (turn 1 never "breaks" — nothing precedes it)
  offenders: CacheBreakOffender[] // ranked heaviest-wasted-cost first
  totalWastedTokens: number
  totalWastedCostUsd: number
  cacheHitRate: number            // cache_read / (cache_read + cache_create) across the session (0..1)
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
