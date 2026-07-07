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
  // Session-level "generated files" group (TRDD-ZS1GDXVY): scratch-tree files not correlated to a
  // specific tool call + any uncorrelated referenced outputs. generatedFilesTruncated is set live
  // when the bounded index hit its cap (500/session) — surfaced so the cap is never silent.
  generatedFiles?: GeneratedFileRef[]
  generatedFilesTruncated?: boolean
  // AUTHORITATIVE live usage from the Claude Code statusline (P7). Populated by StatuslineUsageReader
  // when this session wrote to the shared statusline-usage.jsonl. Carries the exact context-window
  // occupancy + used% + cumulative cost straight from the API response CC embeds (no server query, no
  // pricing-table estimate). The transcript .jsonl parser stays the source for cumulative token buckets
  // and per-source composition drill-down; these numbers OVERRIDE context size + cost only.
  statusline?: StatuslineUsageAgg
  // Cost-integrity flags (TRDD-ZK37VG4X), mirrored in media/src/types.ts.
  // unpriced: the session has real token traffic but its model has no pricing-table entry, so its
  // true cost is UNKNOWN — NOT $0. Derived by SessionRepository at read time (never persisted;
  // adding the missing rate retroactively prices old sessions). Consumers must badge it and
  // exclude it (labeled) from cost aggregates instead of letting silent $0s deflate them —
  // exactly how 14 claude-sonnet-5 sessions billed $0 before 2026-07-07.
  unpriced?: boolean
  // Session ids this card absorbed during identity dedup (a synth-* OTEL placeholder and its log
  // twin, or an id-drifted duplicate with identical usage). Derived at read time.
  mergedFrom?: string[]
}

/** Per-session aggregate of the statusline usage log — the authoritative, rate-limit-free live view
 *  of one Claude Code session's context window + cost. `last*` fields are the most recent turn's exact
 *  buckets (current_usage from the API); `peakContextTokens` is the max context occupancy observed
 *  (each sample exact); `totalCostUsd` is Claude Code's own cumulative session cost. Built by
 *  StatuslineUsageReader.overlay() from the shared statusline-usage.jsonl. */
export interface StatuslineUsageAgg {
  sessionId: string
  projectDir: string
  model: string
  lastInputTokens: number        // current_usage.input_tokens of the latest logged turn
  lastOutputTokens: number       // current_usage.output_tokens
  lastCacheCreateTokens: number  // current_usage.cache_creation_input_tokens
  lastCacheReadTokens: number    // current_usage.cache_read_input_tokens
  lastTotalInputTokens: number   // context_window.total_input_tokens (current context occupancy)
  lastTotalOutputTokens: number  // context_window.total_output_tokens
  contextWindowSize: number      // context_window.context_window_size (the window cap)
  usedPercentage: number         // context_window.used_percentage (exact fill %, not an estimate)
  totalCostUsd: number           // cost.total_cost_usd (cumulative session cost — authoritative)
  peakContextTokens: number      // max total_input_tokens across all sampled turns
  samples: number                // how many statusline lines were aggregated for this session
  lastTs: number                 // epoch seconds of the most recent line
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

// One output file produced/referenced by a session (TRDD-ZS1GDXVY). `origin` distinguishes a path
// NAMED in the transcript (a tool_use input / toolUseResult output-file — correlated to its
// producing tool call) from one DISCOVERED by the bounded scratch-tree index. Size/mtime are a
// snapshot at index time; tokenEstimate is bytes/4 (byte-only — the file is stat'd, not tokenized).
// `missing:true` marks a referenced path whose file is absent (never written or already deleted).
// Paths are LOCAL absolute paths — never exported off-machine without the standard redaction.
export interface GeneratedFileRef {
  path: string
  sizeBytes: number
  mtimeMs: number
  tokenEstimate: number
  origin: 'referenced' | 'scratch'
  missing?: boolean
}

export interface TimelineEntry {
  // 'api_request' / 'compaction' / 'api_error' are log-derived Claude Code events (from the OTEL
  // LOG records claude_code.api_request / .compaction / .api_error|.api_retries_exhausted). They
  // carry per-call ground truth (exact cost + attribution) the llm_request SPANS lack.
  type: 'llm' | 'tool' | 'user_input' | 'background' | 'api_request' | 'compaction' | 'api_error'
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
  // Output files this tool call produced/referenced under the session scratch tree (TRDD-ZS1GDXVY).
  // Correlated by tool_use id → attached to this exact step as expandable leaves; content is
  // lazy-fetched on expand (blob-style), never shipped inline.
  generatedFiles?: GeneratedFileRef[]
  // True when a blob (full tool result / response / thinking / tool input) was persisted for this
  // entry but stripped from the DB row to keep the payload light. Set by the reader on DB-loaded
  // sessions so the webview knows it can lazy-fetch the FULL tool output via loadBlob('full-result').
  // Absent on live/in-memory sessions (their entries carry fullResult inline already).
  hasBlob?: boolean
  // ── Attribution + burn fields for the log-derived Claude Code events ──────────
  // (type === 'api_request' | 'compaction' | 'api_error'). All optional; only set on those entries.
  costUsd?: number           // api_request: exact per-call cost (cost_usd) — ground truth, not estimated
  querySource?: string       // api_request: repl_main_thread | compact | <subagent name>
  agentName?: string         // api_request: agent.name (which sub-agent issued the call)
  skillName?: string         // api_request: skill.name
  pluginName?: string        // api_request: plugin.name
  mcpServerName?: string     // api_request: mcp_server.name
  mcpToolName?: string       // api_request: mcp_tool.name
  requestId?: string         // api_request / api_error: request_id (correlates with an llm_request span)
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

// ── Context-composition tracer (P3, TRDD-TKN5VALS) ────────────────────────────
// Per-turn breakdown of WHAT was injected into the context window and its approximate weight,
// reconstructed on demand from the raw session .jsonl (attachments = hook injections, the skill
// catalog, tool/agent/mcp catalog deltas, file reads, task reminders). Token counts are tokenEstimator
// ESTIMATES (TRDD-IQENK7JM), always surfaced as such — the exact per-turn totals come from usage. Built
// lazily per session (buildContextComposition) so thousands of attachments are never shipped to the
// webview; only the aggregated, capped per-source summary is.
// How a token figure was derived (TRDD-IQENK7JM): 'exact' from a usage bucket, 'calibrated' = an
// estimate scaled so its group sums to a known exact total, 'estimated' = a raw estimate.
export type TokenSource = 'exact' | 'calibrated' | 'estimated'

export interface ContextSource {
  label: string   // e.g. "hook: janitor-memory", "skill catalog", "file: CLAUDE.md"
  kind: string    // hook | skill | toolCatalog | agentCatalog | mcp | file | reminder | other
  tokens: number  // tokenEstimator estimate (composition aggregates a subset → always 'estimated')
  tokenSource?: TokenSource  // how `tokens` was derived (TRDD-IQENK7JM)
  bytes: number
  count: number   // entries aggregated into this source
  // A capped excerpt of the ACTUAL injected text (first occurrence) so the recursive drill-down
  // tree (P5) can render the real content of this block at a leaf — the actual CLAUDE.md / rule /
  // memory / hook-output bytes that occupied those tokens, not just a label + count. Capped so an
  // on-demand parse of a huge session never ships an unbounded payload.
  excerpt?: string
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
  // Set when this composition was reconstructed from a DIFFERENT session's transcript — i.e. this is
  // a fork / sub-agent with no own .jsonl, so its inherited context was read from the parent's log.
  // The webview surfaces this as "reconstructed from parent <id>" and never dead-ends on loading.
  reconstructedFrom?: string
}

// ── Context-history reconstruction (per-STEP, TRDD-TKN5VALS) ───────────────────
// A step-by-step reconstruction of the ACTUAL context blocks present at each assistant turn of a
// Claude session, with a per-block token count (tokenEstimator, CALIBRATED to the step's usage totals
// where possible — see ContextBlock.tokenSource) + taxonomy, and a turn-to-turn diff
// (what blocks were added / removed / changed). Built lazily from the raw .jsonl by
// buildContextHistory so the trace tree can drill from a turn down to the real injected content of
// every block. The container's `estimated: true` marker remains (per-block sources are exact via usage).
export type ContextBlockKind =
  | 'system' | 'claudemd' | 'rule' | 'toolCatalog' | 'skillCatalog' | 'agentCatalog' | 'mcp'
  | 'file' | 'toolInput' | 'toolOutput' | 'bashInput' | 'bashOutput' | 'hook' | 'skillPrompt'
  | 'agentPrompt' | 'userMsg' | 'assistantMsg' | 'reasoning' | 'postCompact' | 'subagentOutput'
  | 'harness' | 'cron' | 'reminder' | 'other'

export interface ContextBlock {
  id: string                  // stable identity `${kind}:${label}` (diffed turn-to-turn)
  kind: ContextBlockKind
  label: string
  tokens: number              // final per-block count: tokenEstimator estimate, CALIBRATED to the
                              // step's exact usage total when possible (TRDD-IQENK7JM) — see tokenSource
  tokenSource?: TokenSource   // 'calibrated' when scaled to a usage total, else 'estimated'
  bytes: number
  text: string                // the ACTUAL injected content (capped per block)
  role: 'input' | 'output'
  toolName?: string
}

export interface StepDiff {
  added: string[]             // block ids present this step but not the previous
  removed: string[]           // block ids present the previous step but not this
  changed: string[]           // block ids in both whose text-hash differs
  firstChangeBlockId?: string // first (in block order) id that is in added ∪ changed
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
  estimated: true             // marker: token figures here are approximate
  truncated: boolean          // true if the session was larger than the parse cap
  // Set when reconstructed from a DIFFERENT session's transcript (fork / sub-agent with no own log).
  reconstructedFrom?: string
}

// ── Resident-cost itemization (TRDD-W0RRL2FZ) ─────────────────────────────────
// The cost model is `cost ≈ turns × per-turn-context`: a block is expensive not for its size but
// for its size × HOW LONG it rides forward in the transcript. Every occurrence of a block (one
// step's copy) stays resident from the step it was added until the next compaction evicts it (or
// the session ends), and is re-read (cache-read billed) on every turn in between. residentCost is
// the Σ over occurrences of tokens × turns-resident — the true cumulative context weight of the
// block, directly comparable to the session's Σ per-turn usage (input + cacheRead + cacheCreate).
// Derived purely from ContextHistory by buildResidentCostReport — no new ingestion.
// MIRRORED in media/src/types.ts — change both.
export interface ResidentCostBlock {
  id: string                  // ContextBlock id `${kind}:${label}` — the drill key for get_context_history
  kind: ContextBlockKind
  label: string
  tokens: number              // Σ tokens injected across all occurrences (per-step calibrated counts)
  peakTokens: number          // largest single-occurrence token count
  occurrences: number         // how many steps (re-)injected this block id
  firstSeenTurn: number
  lastResidentTurn: number    // last turn any copy was still resident (next compaction − 1, or lastTurn)
  turnsResident: number       // lastResidentTurn − firstSeenTurn + 1 (the residency span)
  residentCost: number        // Σ over occurrences of tokens × turns-resident (token·turns)
  remediation: string         // per-kind one-line fix hint
}

export interface ResidentCostReport {
  sessionId: string
  stepCount: number
  stepsWithUsage: number      // steps that carried exact usage buckets (the reconciliation base)
  lastTurn: number
  compactionTurns: number[]   // turns whose step carries a postCompact block (eviction boundaries)
  totalContextTokens: number  // Σ per-step usage (input + cacheRead + cacheCreate) — EXACT ground truth
  itemizedResidentTokens: number // Σ residentCost over every block — what the itemization attributes
  unattributedTokens: number  // totalContextTokens − itemizedResidentTokens; SIGNED (negative =
                              // estimator overshoot), never silently clamped — see note
  note: string                // what the unattributed remainder contains (invisible system prompt /
                              // tool definitions, estimator drift, preserved-message approximation)
  blocks: ResidentCostBlock[] // ranked by residentCost, heaviest first
  estimated: true             // marker: per-block figures are estimates calibrated to usage
  truncated: boolean          // the underlying history hit a parse cap
}

// ── Per-call full context (TRDD-ICHAVFCS) ─────────────────────────────────────
// The literal, untruncated context of ONE llm API call, reconstructed from Claude Code's raw OTEL
// request body ({system, messages[], tools[]}) captured via OTEL_LOG_RAW_API_BODIES. Reuses the
// ContextBlock taxonomy above: every element of the call (system prompt, each message, tool_use,
// tool_result, thinking, the tool catalog) becomes one ordered block drillable to its actual text.
// Per-block token figures are tokenEstimator estimates (TRDD-IQENK7JM), labeled estimated — the exact
// per-call total is not plumbed into the raw-body registry, so these are not calibrated. Works for
// OTEL-only sessions with no local .jsonl — the raw body IS the whole context at that call.
export interface CallContext {
  requestId?: string
  sessionId: string
  model?: string
  blocks: ContextBlock[]
  truncated: boolean          // true if the file was oversized or any block text was capped
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

// TRDD-PJC8N1HO — an explicit collector-downtime window. The interval between one collector run's
// last-known-alive time and the next run's start, during which every OTEL export from the agents was
// dropped (exporters retry briefly then discard) and is lost forever. Surfaced so the dashboard shows
// a "telemetry lost" band instead of a silent hole, and get_recent_sessions returns it. MIRRORED in
// media/src/types.ts — change both.
export interface CollectorGap {
  startedAt: string   // ISO — downtime began (prior run's stop, or last heartbeat if it crashed)
  endedAt: string     // ISO — downtime ended (next run's start)
  durationMs: number
  reason: 'crash' | 'shutdown'
}
