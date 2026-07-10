// Card / timeline / diagnosis types shared by the extension host, the standalone server, and the
// webview. This directory (src/shared/) is the ONE source of truth — the webview re-exports these
// from media/src/types.ts instead of hand-mirroring them (the old mirror drifted). Everything here
// must stay runtime-neutral: no Node imports, no DOM APIs.
import { LoopSignal } from './telemetryTypes'

export interface SessionSummaryCard {
  sessionId: string
  traceId: string
  source: 'copilot' | 'claude_code' | 'codex' | 'opencode'
  dataSource: 'otel' | 'log'
  initiator?: 'user' | 'agent' | 'api'
  conversationId?: string
  // ── Per-account attribution (TRDD-BURNWDGT) ───────────────────────────────────
  // The OAuth account that issued this session's API calls. `accountId` is the raw `account_uuid`
  // (a stable IDENTIFIER, not a secret — safe to persist; the OAuth TOKEN is NEVER stored). Sourced
  // at ingest from the raw request body's metadata.user_id (via the shared CallBodyRegistry, keyed by
  // session_id) and, for OTEL cards, the span's user.account_uuid attribute. Rate limits are
  // per-account, so per-account window budgeting groups events by this — a session rotated to a
  // second account must NOT pool with the first. `accountLabel` is a LIVE-ONLY, display-only resolution
  // (email/org from ~/.claude.json) attached at read time — never persisted (it can drift + is PII).
  accountId?: string
  accountLabel?: string
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
  // TRDD-FB5RG4P1 EHT: the requested sub-agent type (e.g. spark, general-purpose) from the spawning
  // tool_use — persisted so FAL's compare_configs groupBy:subagent_type is a real dimension.
  spawnSubagentType?: string
  // True when the child was an ASYNC/background launch: the parent transcript carries only the
  // status:"async_launched" acknowledgment, never the child's usage — so this card's token buckets
  // are zero BY DATA ABSENCE, not because the child ran free. Consumers must not read the zeros
  // as a measured cost. Set only on log-derived child cards.
  spawnAsync?: boolean
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
  // Cost-integrity flags (TRDD-ZK37VG4X).
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
  accountUuid?: string        // parsed from metadata.user_id blob (identifier, not a secret; pointer-only)
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
// a "telemetry lost" band instead of a silent hole, and get_recent_sessions returns it.
export interface CollectorGap {
  startedAt: string   // ISO — downtime began (prior run's stop, or last heartbeat if it crashed)
  endedAt: string     // ISO — downtime ended (next run's start)
  durationMs: number
  reason: 'crash' | 'shutdown'
}

// ── Spawn-cost rollup + cache-friendly-spawn advisor (TRDD-62E8UU41) ──────────
// Aggregate of ONE parent's sub-agent fan-out (all children spawned by a session, or by a single
// turn): total tokens/cost, the spawn-KIND mix, and any antipattern detections. The founding burn
// was a fable-5 parent spawning a FLEET of children, each re-billing a multi-M-token inherited prefix
// as cache_creation (write rate ~1.25×) instead of reading the parent cache (~0.1×) — millions of
// tokens/minute. This is the automatic aggregate that names that shape and the cheaper alternative.
// Computed by buildSpawnRollup (src/shared/spawnRollup.ts).
export type SpawnDetectionCode = 'FLEET-COLD' | 'WORKTREE-SCATTER' | 'MODEL-MIX'

export interface SpawnDetection {
  code: SpawnDetectionCode
  severity: 'HIGH' | 'MEDIUM'
  childCount: number          // children implicated in THIS detection (subset of the rollup's children)
  wastedTokens: number        // Σ cache-create the implicated children re-billed — the avoidable prefix write
  wastedCostUsd: number       // aggregate cost of the implicated children (0 when unpriced) — order-of-magnitude
  message: string             // one-line human summary carrying the aggregate waste
  remediation: string         // one-line cheaper-spawn hint
}

// Counts of children by spawn method. `unknown` is FAIL-FAST: a child whose spawnKind is absent or
// unrecognized is counted here, NEVER silently folded into `fresh` (a mislabeled cold fork must not
// hide). `modelOverride` counts children that requested a different model (a separate model cache).
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
  // Children spawned async whose tokens were never reported into the parent transcript. When >0,
  // the totals above UNDERCOUNT by these children's (unknown) usage — surfaced so the rollup never
  // silently reads as complete coverage.
  asyncUnreportedChildren?: number
  kindMix: SpawnKindMix
  detections: SpawnDetection[]
}

// ── Tokens-by-CAUSE attribution rollup (TRDD-UBEP5XY7) ────────────────────────
// Every claude_code.api_request event (ingested by the R-I rich-event pass, 7612ff5) carries its
// CAUSE — WHO issued the call: querySource (repl_main_thread | compact | <subagent>), agent.name,
// skill.name, plugin.name, mcp_server.name, mcp_tool.name — plus the per-call usage buckets and the
// EXACT per-call cost_usd. Per-row attribution already shows this; this rollup GROUPS the calls by
// cause dimension and sums the 4 buckets + cost so "which skill/plugin/subagent costs me the most?"
// is one ranked table instead of a row-by-row read. Figures are EXACT ground truth (per-call usage +
// cost_usd), not estimates — hence `estimated: false`, unlike ResidentCostReport. Pure OTEL data (no
// .jsonl required); OTEL-only sessions are fully supported. Computed by buildTokensByCause
// (src/shared/tokensByCause.ts).
export type CauseDimension = 'querySource' | 'agent' | 'skill' | 'plugin' | 'mcpServer' | 'mcpTool'

// One cause value's rolled-up totals within a dimension. `unattributed:true` marks the explicit
// bucket that absorbs api_request calls carrying NO value for this dimension — FAIL-FAST: those
// tokens are counted and labeled, NEVER silently dropped and NEVER fabricated into a named cause.
export interface CauseRollupRow {
  dimension: CauseDimension
  key: string                 // the cause value (e.g. agent name, "server/tool"); the bucket label when unattributed
  unattributed: boolean
  calls: number               // api_request events folded into this row
  inputTokens: number         // Σ per-call input_tokens (uncached — CC emits it cache-excluded)
  outputTokens: number
  cacheReadTokens: number
  cacheCreateTokens: number
  totalTokens: number         // input + output + cacheRead + cacheCreate
  costUsd: number             // Σ per-call cost_usd (0 when none of the folded calls carried a cost)
  costKnown: boolean          // true iff EVERY folded call carried a cost_usd — else costUsd is a floor
}

export interface CauseDimensionRollup {
  dimension: CauseDimension
  rows: CauseRollupRow[]       // named causes ranked by totalTokens (heaviest first), the unattributed row pinned LAST
  attributedCalls: number      // api_request calls that carried a value for this dimension
  unattributedCalls: number    // api_request calls with no value for this dimension (the pinned bucket)
}

// Session/window ground-truth usage totals vs the Σ over api_request events (the attributable subset).
// The remainder is api_request coverage honesty: token traffic the rich events did NOT attribute (an
// llm call with no matching api_request log event). SIGNED, never clamped — see note.
export interface CauseReconciliation {
  apiRequestCalls: number
  attributedInputTokens: number
  attributedOutputTokens: number
  attributedCacheReadTokens: number
  attributedCacheCreateTokens: number
  attributedTotalTokens: number
  attributedCostUsd: number
  costComplete: boolean          // every api_request event carried a cost_usd (else attributedCostUsd is a floor)
  costCalls: number              // api_request events that carried a cost_usd
  sessionTotalTokens: number | null   // usage-bucket ground truth (normalized: uncached input + read + create + output); null when not supplied
  unattributedTotalTokens: number | null // sessionTotalTokens − attributedTotalTokens (SIGNED); null when sessionTotalTokens null
  note: string
}

export interface TokensByCauseReport {
  sessionId?: string           // set for a single session; absent for the global leaderboard
  sessionsScanned?: number     // set for the global leaderboard (# sessions folded)
  apiRequestCalls: number      // total api_request events aggregated
  hasAttribution: boolean      // apiRequestCalls > 0 — false ⇒ no rich api_request events (OTEL rich logging off / not a CC session)
  dimensions: CauseDimensionRollup[]  // one per CauseDimension, in CAUSE_DIMENSIONS order
  reconciliation: CauseReconciliation
  estimated: false             // tokens + per-call cost are EXACT ground truth (not estimates)
  note: string
}
