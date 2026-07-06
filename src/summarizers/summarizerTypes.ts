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
