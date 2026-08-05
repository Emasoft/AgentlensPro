/**
 * AgentlensPro MCP server — exposes session history to Claude Code and other
 * MCP-compatible agents so they can query their own past work.
 *
 * Tools:
 *   get_recent_sessions      — recent session summaries, newest-first
 *   get_workspace_patterns   — aggregate patterns across all sessions
 *   get_session_detail       — full timeline for one session
 *   find_relevant_context    — files and patterns relevant to a task description
 *   get_efficiency_report    — trends and recurring efficiency problems
 *
 * Transport: Streamable HTTP — expose via a route on an existing http.Server
 * or start a dedicated server with startMcpHttpServer().
 */

import * as http from 'http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { isDisallowedCrossOrigin, setAllowedOriginCors } from './httpOrigin'
import { calcTokenCostUsd } from './shared/pricing'
import { contextTokens } from './shared/tokenBuckets'
import type {
  SessionSummaryCard, TimelineEntry, ContextComposition,
  CacheBreakReport, CacheBreakOffender, ContextHistory, CallContext, CollectorGap,
  Conversation, ConversationTurn,
} from './shared/summarizerTypes'
import { buildCacheBreakReport } from './shared/cacheBreak'
import { investigateBurn, attachCausingCalls } from './burnInvestigator'
import { burnSeismic, renderBurnSeismic, resolveSeismicFiles, type SeismicScope } from './burnSeismic'
import { checkBurnRisk, attachRiskCausingCalls } from './burnGuard'
import { buildRateLimitReport } from './rateLimitReport'
import { buildRuntimeInventory } from './runtimeInventory'
import type { HookEventRecord } from './hookEventStore'
import { readHookEvents } from './hookEventStore'
import { extractLifecycleEvents, type LifecycleKind } from './lifecycleEvents'
import { scanCacheRiskCommands, type CacheRiskCommand, type CacheRiskKind } from './cacheRiskCommands'
import { scanEffortTransitions, effortTransitionAsRiskCommand } from './effortTransitions'
import { buildAttributionReport } from './skillAttribution'
import { buildLoadedVersionsReport } from './loadedPluginVersions'
import * as fs from 'fs'
import type { BodiesActivityReport } from './bodiesActivity'
import { buildResidentCostReport } from './shared/residentCost'
import { buildSpawnRollup } from './shared/spawnRollup'
import { buildTokensByCause } from './shared/tokensByCause'
import { loadBurnConfig, lastActivityMs, type BurnStatus, type SessionStatus, type AccountWindowBudget, type ConsumptionEvent } from './burnMonitor'
import * as os from 'os'
import { type AccountInfo, accountLabelFor } from './accountInfo'
import { classifyTtlRegime, sessionTtlKindOf, type TtlContext } from './shared/cacheTtl'
import { assessCacheExpiry, type CacheExpiryVerdict } from './cacheExpiry'
import type { RateLimitsSnapshot } from './statuslineUsage'
// TRDD-YQZ9P8IL — plan/mode formatting + the auth-regime resolver live in accountStateTimeline (ONE
// source of truth shared by get_account_status and the account-state timeline sampler); resolveStateAt
// powers the get_account_state_at tool (reads the ndjson off disk directly, like the forensic tools).
import { describePlan, describeAccountMode, resolveAuthRegimeLabel, resolveStateAt } from './accountStateTimeline'
import { listAllAccounts } from './allAccounts'
import { listSessionFileIds } from './contextComposition'
import { generateSuggestions } from './instructionAdvisor'
import { readAllInstructionContent } from './instructionFiles'
import { ContextCompositionIndex, type CompositionBlockKind, type GroupBy } from './contextCompositionIndex'
import {
  buildCacheCreationReport, buildExpensiveWritesTrace, buildCacheBreakGapReport,
  formatExpensiveWrites, formatCostPeaks, type CostPeakGroupBy, type CostBucket, type ForensicsFormat,
  defaultBodiesDir,
} from './cacheCreationForensics'
import {
  buildCacheEventLog, formatCacheEventLog,
  type CacheEventMode, type CacheEventFormat,
} from './cacheEventLog'
import { getSubscriptionUsage, formatSubscriptionUsage } from './subscriptionUsage'
import { dataPath } from './dataDir'
// TRDD-1FEIW17E — who is writing raw OTEL bodies (live-dir scan + store totals, exact union).
import { scanLiveBodyWriters, queryStoreWriterTotals, buildBodyWritersReport } from './bodyWriters'
import type { Store } from './store/db'
// TRDD-1XM0YSWQ — who exhausted a given account's rate-limit window (time-based attribution).
import { readAccountSegments, resolveTargetAccount, resolveWindowUntil, buildAccountBurnersReport } from './accountBurners'
// TRDD-8ZMZ4I6B — cost-based time-to-exhaustion of the current account's windows.
import { buildWindowEtaReport } from './windowEta'
import {
  buildCacheBreakTimeline, buildCauseCostPeakReport, buildCacheBreakCauses, formatTimeline, type TimelineFormat,
} from './cacheBreakTimeline'
import { leanify } from './leanResponse'
import { buildSessionBurnProfile } from './sessionBurnProfile'
import { buildHeartbeatCost } from './heartbeatCost'
// TRDD-FB5RG4P1 — FAL comparative + SQL analytics over the forensics fact DB. Like the cache-forensic
// tools above, these read ~/.agentlens/{otel-bodies,forensics.db} directly off disk (self-loading
// sql.js), so they need no McpServerOptions accessor and work identically in both runtimes.
import { ensureFreshIndex } from './forensicsIndex'
import {
  buildCompareConfigs, type GroupByDim, type MetricKey, type AggKey, type CompareFilter,
} from './forensicsCompare'
import { runDiagnosticsSql, type SqlFormat } from './forensicsSql'
// TRDD-YJQXLHPA — ad-hoc DuckDB SQL over the session .jsonl transcripts (bounded, read-only).
import { runTranscriptSql } from './transcriptSql'

// TRDD-CTXQUERY — one process-lifetime, LRU-cached composition index shared by all composition tools.
// It reads the shared callBodyRegistry singleton (fed by both OTLP ingestors) directly, so the tools
// work in BOTH the extension host and the standalone server with no per-runtime accessor wiring.
const compositionIndex = new ContextCompositionIndex()

// Map a session id to its project path for scope/group-by. Built per-call from the live session cards.
function projectResolver(sessions: SessionSummaryCard[]): (id: string) => string | undefined {
  const map = new Map<string, string>()
  for (const s of sessions) { map.set(s.sessionId, s.projectPath ?? s.workspace ?? 'unknown') }
  return (id: string) => map.get(id)
}

// ── Session accessor ──────────────────────────────────────────────────────────

// Accepts either a live SessionRepository (VS Code extension) or a plain
// function returning the current session array (standalone).
export type SessionAccessor = () => SessionSummaryCard[]

// ── Cost helper ───────────────────────────────────────────────────────────────

function sessionCost(s: SessionSummaryCard): number {
  // inputTokens is RAW uncached input on EVERY card — the 2026-07-10 normalization moved the
  // convention to the ingestion sites (claude/copilot/codex summarizers + logReader sub cards) and
  // migrated persisted rows, retiring the read-time `inputTokens < cache` detection heuristic that
  // lived here. That heuristic was structurally unsound: a raw-convention card whose raw input
  // happened to exceed its cache total was misclassified as incl-cache and silently under-counted.
  // The four buckets are disjoint; bill each at its own rate, no subtraction anywhere.
  return calcTokenCostUsd(s.inputTokens, s.cacheReadTokens, s.cacheCreateTokens ?? 0, s.outputTokens, s.model)
}

// A session counts toward cache-health SLIs only when it actually exercised the prompt cache:
// at least one LLM call AND non-zero token traffic. Junk rows (synthetic empties, model:''
// zero-token cards) all carry cacheHitRate 0, so averaging them in drags the SLI toward 0 with
// no billing behind it — diluting the one signal that flags real cache regressions
// (TRDD-ZK37VG4X spec 3). Exported for unit tests.
export function isCacheMeasured(s: SessionSummaryCard): boolean {
  const traffic = s.inputTokens + s.outputTokens + s.cacheReadTokens + (s.cacheCreateTokens ?? 0)
  return s.totalLlmCalls > 0 && traffic > 0
}

// ── Session-cost prediction (TRDD-O981ZJKV item 9) ────────────────────────────────────────────
// "What will a session like THIS cost?" — match past sessions by task keywords + sub-agent
// type (+ a soft file-size band when both sides know it), then report the DISTRIBUTION
// (p25/p50/p75) of their 5 values. A distribution over real precedents, never a point guess:
// the honest answer to "predict the cost of a code review / an ultracode workflow".

export interface PredictSessionCostArgs {
  /** Description of the planned task — matched against past sessions' first user request. */
  task: string
  /** Restrict/prefer precedents of this spawn type (e.g. 'fork', 'general-purpose'). */
  subagentType?: string
  /** Approximate bytes of input files the task will read — soft 10× comparability band. */
  fileBytes?: number
  /** Max precedents used (default 12). */
  topK?: number
}

const pct = (sorted: number[], p: number): number =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]

export function predictSessionCost(sessions: SessionSummaryCard[], args: PredictSessionCostArgs): unknown {
  if (!args.task || args.task.trim().length < 3) return { error: 'task (a description of the planned work) is required' }
  const keywords = [...new Set(args.task.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3))]
  if (keywords.length === 0) return { error: 'task yielded no matchable keywords — describe the work in a sentence' }

  const readBytesOf = (s: SessionSummaryCard): number | null => {
    if (!s.fileOps || s.fileOps.length === 0) return null
    let n = 0
    for (const f of s.fileOps) n += (f as unknown as { readBytes?: number }).readBytes ?? 0
    return n > 0 ? n : null
  }

  const scored = sessions
    .filter(s => isCacheMeasured(s)) // zero-traffic cards would drag every percentile to 0
    .map(s => {
      const text = (s.userRequest || '').toLowerCase()
      let hits = 0
      for (const k of keywords) if (text.includes(k)) hits++
      let score = hits / keywords.length
      if (args.subagentType && s.spawnSubagentType === args.subagentType) score += 0.5
      // Soft comparability band: when BOTH sides know the input size, sessions outside a
      // 10× band are poor precedents for cost extrapolation.
      const rb = readBytesOf(s)
      if (args.fileBytes && rb !== null && (rb > args.fileBytes * 10 || rb < args.fileBytes / 10)) score *= 0.3
      return { s, score, readBytes: rb }
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)

  const topK = Math.max(3, Math.min(args.topK ?? 12, 50))
  const picked = scored.slice(0, topK)
  if (picked.length === 0) {
    return {
      matched: 0,
      note: 'no past session matched the task keywords' + (args.subagentType ? ` (subagentType ${args.subagentType})` : '') +
        ' — no precedent, no prediction. Broaden the task description or drop the type filter.',
    }
  }

  const dist = (get: (s: SessionSummaryCard) => number): { p25: number; p50: number; p75: number } => {
    const v = picked.map(x => get(x.s)).sort((a, b) => a - b)
    return { p25: pct(v, 25), p50: pct(v, 50), p75: pct(v, 75) }
  }
  const cost = dist(s => Number(sessionCost(s).toFixed(4)))
  return {
    matched: picked.length,
    keywords,
    // FLAT headline estimates — the lean shaper prunes deep nesting from the default view,
    // and "what will it cost" must survive it (p50 central, p75 budget-safe).
    estCostUsdP50: cost.p50,
    estCostUsdP75: cost.p75,
    estTurnsP50: dist(s => s.turns).p50,
    prediction: {
      input: dist(s => s.inputTokens),
      output: dist(s => s.outputTokens),
      cacheRead: dist(s => s.cacheReadTokens),
      cacheCreation: dist(s => s.cacheCreateTokens ?? 0),
      costUsd: cost,
      turns: dist(s => s.turns),
    },
    precedents: picked.slice(0, 8).map(x => ({
      sessionId: x.s.sessionId,
      workspace: x.s.workspace,
      model: x.s.model,
      subagentType: x.s.spawnSubagentType ?? null,
      similarity: Number(x.score.toFixed(2)),
      costUsd: Number(sessionCost(x.s).toFixed(4)),
      turns: x.s.turns,
      readBytes: x.readBytes,
      request: (x.s.userRequest || '').slice(0, 100),
    })),
    note: 'a DISTRIBUTION over real matched precedents (keyword + type + size-band similarity), not a point ' +
      'guess. p50 is the central estimate; p75 the budget-safe one. Model changes shift costs — check the ' +
      'precedents\' models against the model you will run.',
  }
}

// ── Cost rollup (TRDD-O981ZJKV): interval cost/rate aggregation over session cards ────────────
// One tool answers "what did project X / all projects / my subagents cost in interval Y, with
// the 5-value breakdown and the hourly rate". Cards are SESSION-granular, so the honesty rule
// is: a session counts when it OVERLAPS the window, and its token totals are whole-session —
// stated in coverage.note, never silently time-sliced (we have no per-turn slicing here).

export interface CostRollupArgs {
  groupBy?: 'project' | 'session' | 'subagent' | 'model' | 'all'
  windowHours?: number
  sinceIso?: string
  untilIso?: string
  /** Only sub-agent cards (sessions spawned by a parent). */
  subagentsOnly?: boolean
  /** Only sub-agents of this parent session. */
  parentSessionId?: string
  /** Only sessions still receiving turns (last activity ≤3min ago). */
  liveOnly?: boolean
  sortBy?: 'cost' | 'input' | 'output' | 'cacheRead' | 'cacheCreation' | 'total'
  topN?: number
}

interface RollupBuckets {
  sessions: number
  turns: number
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  costUsd: number
  /** Sessions whose model has no pricing entry — EXCLUDED from costUsd, never a silent $0. */
  unpricedSessions: number
}

const LIVE_WINDOW_MS = 3 * 60_000

export function buildCostRollup(sessions: SessionSummaryCard[], args: CostRollupArgs, now: number = Date.now()): unknown {
  const until = args.untilIso ? Date.parse(args.untilIso) : now
  const hours = Math.max(0.05, Math.min(24 * 45, args.windowHours ?? 24))
  const since = args.sinceIso ? Date.parse(args.sinceIso) : until - hours * 3600e3
  if (!Number.isFinite(until) || !Number.isFinite(since)) return { error: 'sinceIso/untilIso must be valid ISO datetimes' }
  if (since >= until) return { error: 'the window is empty (since >= until)' }
  const windowH = (until - since) / 3600e3
  const groupBy = args.groupBy ?? 'project'

  // Cards without a parseable startTime cannot be window-filtered — they are EXCLUDED and
  // counted, never silently mixed in or silently dropped.
  let undatedSessions = 0
  let pool = sessions.filter(s => {
    const start = Date.parse(s.startTime)
    if (!Number.isFinite(start)) { undatedSessions++; return false }
    const end = start + Math.max(0, s.durationMs || 0)
    return start <= until && end >= since
  })
  if (args.subagentsOnly) pool = pool.filter(s => !!s.parentSessionId)
  if (args.parentSessionId) pool = pool.filter(s => s.parentSessionId === args.parentSessionId)
  if (args.liveOnly) {
    pool = pool.filter(s => now - (Date.parse(s.startTime) + Math.max(0, s.durationMs || 0)) <= LIVE_WINDOW_MS)
  }
  // groupBy:subagent IS the "rank my subagents" view — restrict to spawned sessions implicitly.
  if (groupBy === 'subagent') pool = pool.filter(s => !!s.parentSessionId)

  const keyOf = (s: SessionSummaryCard): string =>
    groupBy === 'all' ? 'all'
      : groupBy === 'project' ? (s.workspace || '(unknown workspace)')
        : groupBy === 'model' ? (s.model || '(unknown model)')
          : s.sessionId // session AND subagent group per card; subagent rows get labels below

  const zero = (): RollupBuckets => ({ sessions: 0, turns: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, costUsd: 0, unpricedSessions: 0 })
  const add = (b: RollupBuckets, s: SessionSummaryCard): void => {
    b.sessions++
    b.turns += s.turns || 0
    b.input += s.inputTokens || 0
    b.output += s.outputTokens || 0
    b.cacheRead += s.cacheReadTokens || 0
    b.cacheCreation += s.cacheCreateTokens || 0
    if (s.unpriced) b.unpricedSessions++
    else b.costUsd += sessionCost(s)
  }

  const groups = new Map<string, RollupBuckets & Record<string, unknown>>()
  const totals = zero()
  for (const s of pool) {
    add(totals, s)
    const key = keyOf(s)
    let g = groups.get(key)
    if (!g) {
      g = { key, ...zero() }
      if (groupBy === 'session' || groupBy === 'subagent') {
        g.workspace = s.workspace
        g.model = s.model
        g.parentSessionId = s.parentSessionId ?? null
        g.spawnKind = s.spawnKind ?? null
        g.subagentType = s.spawnSubagentType ?? null
        g.startedAtIso = s.startTime
        // P7 provenance — session/subagent rows ARE per-session figures, so carry which feed
        // backs them; null = pre-P7 card ("unknown"). Note only when a decision recorded one.
        g.tokensSource = s.tokensSource ?? null
        if (s.coverageNote) { g.coverageNote = s.coverageNote }
      }
      groups.set(key, g)
    }
    add(g, s)
  }

  const totalOf = (b: RollupBuckets): number => b.input + b.output + b.cacheRead + b.cacheCreation
  const sortBy = args.sortBy ?? 'cost'
  const metric = (b: RollupBuckets): number =>
    sortBy === 'input' ? b.input
      : sortBy === 'output' ? b.output
        : sortBy === 'cacheRead' ? b.cacheRead
          : sortBy === 'cacheCreation' ? b.cacheCreation
            : sortBy === 'total' ? totalOf(b)
              : b.costUsd
  const topN = Math.max(1, Math.min(args.topN ?? 20, 100))
  const ranked = [...groups.values()].sort((a, b) => metric(b) - metric(a))
  // FLAT rate scalars, not a nested object: the lean shaper prunes nested objects from rows,
  // and the hourly rate is a headline number that must survive the default (shaped) view.
  const rateFields = (b: RollupBuckets): { tokensPerHour: number; costUsdPerHour: number } => ({
    tokensPerHour: Math.round(totalOf(b) / windowH),
    costUsdPerHour: Number((b.costUsd / windowH).toFixed(4)),
  })

  return {
    window: { sinceIso: new Date(since).toISOString(), untilIso: new Date(until).toISOString(), hours: Number(windowH.toFixed(2)) },
    groupBy,
    filters: {
      subagentsOnly: !!args.subagentsOnly,
      parentSessionId: args.parentSessionId ?? null,
      liveOnly: !!args.liveOnly,
      sortBy,
    },
    totals: { ...totals, totalTokens: totalOf(totals), ...rateFields(totals) },
    groups: ranked.slice(0, topN).map(g => ({
      ...g,
      totalTokens: totalOf(g),
      ...rateFields(g),
      costShare: totals.costUsd > 0 ? Number((g.costUsd / totals.costUsd).toFixed(3)) : null,
    })),
    coverage: {
      sessionsInWindow: pool.length,
      undatedSessions,
      groupsTotal: groups.size,
      groupsReturned: Math.min(groups.size, topN),
      note: 'sessions count when they OVERLAP the window; token totals are whole-session (cards are session-granular). unpricedSessions are excluded from costUsd, never silent $0. tokensPerHour/costUsdPerHour divide by the window length.',
    },
  }
}

// Sampling honesty (TRDD-ZK37VG4X spec 4): every bounded cross-session scan must SAY what it
// covered. `complete` is true only when every log-backed session was actually scanned; otherwise
// the note states the sample explicitly so a consumer can never mistake a bounded scan for full
// history. sessionsSkipped counts both cap-cutoff and composition-unavailable sessions.
export function buildScanCoverage(considered: number, withLog: number, scanned: number, scanCap: number) {
  const skipped = withLog - scanned
  const complete = skipped === 0
  return {
    sessionsConsidered: considered,
    sessionsWithLog: withLog,
    sessionsScanned: scanned,
    sessionsSkipped: skipped,
    scanCap,
    complete,
    note: complete
      ? (withLog === 0
          ? `No log-backed sessions to scan (${considered} considered, none with a local transcript on disk).`
          : `Complete coverage: all ${withLog} log-backed sessions (of ${considered} considered) were scanned.`)
      : `SAMPLE, not full coverage: ${scanned} most-recent log-backed sessions scanned (cap ${scanCap}); ` +
        `${skipped} of ${withLog} log-backed sessions were NOT scanned. Totals reflect the scanned sample only.`,
  }
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'get_recent_sessions',
    description:
      'Returns { sessions, collectorGaps }: recent AgentlensPro session summaries — cost, turns, model, ' +
      'prompt excerpt, top tools used, loop signals — plus collectorGaps, any windows where the ' +
      'collector was offline and telemetry was lost. Ranked by LAST ACTIVITY (not start date), so ' +
      'long-running sessions still emitting rank first; rows carry lastActive and active:true when ' +
      'live within the last 5 minutes. Use this to orient yourself to recent work ' +
      '(and to know if coverage has gaps) before starting a new task.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit:     { type: 'number',  description: 'Max sessions to return (default 10, max 50)' },
        agent:     { type: 'string',  description: 'Filter by agent: copilot | claude_code | codex' },
        workspace: { type: 'string',  description: 'Filter by workspace path prefix' },
      },
    },
  },
  {
    name: 'get_workspace_patterns',
    description:
      'Returns aggregate patterns across all sessions: most-accessed files, average cost ' +
      'and turn count, common efficiency problems, top tools. Use this to understand ' +
      'the codebase context before starting work.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workspace: { type: 'string', description: 'Filter by workspace path prefix' },
        days:      { type: 'number', description: 'Only include sessions from the last N days (default: all)' },
      },
    },
  },
  {
    name: 'get_window_eta',
    description:
      'HOW LONG until the account exhausts its rate-limit windows, projected on the current COST rate ' +
      '(Anthropic meters the 5h/7d windows by cost, not raw tokens — cache-read is weighted ~0.1×, so a ' +
      'token projection is wrong). Returns both windows with consumed $ vs the calibrated $ cap, %% used, ' +
      'the account\'s current $/min (over `rate_window_min`, default 30), an ETA in h/m and an ISO ' +
      'exhaustion time, and marks which window EXHAUSTS FIRST. The rate is THIS account\'s own burn (rate ' +
      'limits are per OAuth account); capacity is the account\'s observed calibration, else a same-plan ' +
      'account\'s as a labeled proxy, else the verdict says no ETA can be projected (never guessed). ' +
      'Default account is `current`. Result includes a preformatted `text`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        account:         { type: 'string', description: '`current` (default) | `previous` | an account_uuid prefix | an email' },
        rate_window_min: { type: 'number', description: 'Minutes of recent history the $/min rate is measured over (default 30). Smaller = more reactive, larger = smoother' },
      },
    },
  },
  {
    name: 'get_account_burners',
    description:
      'WHO exhausted a given OAuth account\'s rate-limit windows — BOTH the 5h and the 7d window in one ' +
      'call, each as a PROJECT/agent table (sessions grouped by workspace, so a restarted agent stays one ' +
      'row) with share%, billable-weighted equiv, cost, explicit cache-created and cache-read token ' +
      'columns, session count and top model; per-session rows are in the JSON too. The window nearer/over ' +
      'its calibrated capacity at the rotation moment is marked MOST LIKELY EXHAUSTED (the rotation ' +
      'trigger) — capacity comes from the account\'s own observed calibration, else a same-plan account\'s ' +
      'as a labeled proxy, else the verdict says undetermined. Default account is `previous` (the one ' +
      'rotated away from), windows end at its rotation-out moment. Attribution is TIME-based against the ' +
      'machine account-state timeline, so a session alive across a rotation splits correctly between ' +
      'accounts. Coverage gaps are disclosed. Result includes a preformatted `text` with both tables.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        account:  { type: 'string', description: '`previous` (default) | `current` | an account_uuid prefix | an email' },
        interval: { type: 'string', description: 'Window end: `last` (default — the account\'s rotation-out moment, the window it last filled) | `current` (ongoing, ends now) | an ISO-8601 date (the window ending at/including that instant)' },
        limit:    { type: 'number', description: 'Max ranked rows per table (default 15)' },
      },
    },
  },
  {
    name: 'get_body_writers',
    description:
      'Identifies WHICH sessions are writing raw OTEL API bodies (OTEL_LOG_RAW_API_BODIES) and ranks ' +
      'them by recent write rate, then total written. A session keeps its launch-time env until ' +
      'restarted, so the `active` rows are the terminals still burning disk RIGHT NOW. Attribution ' +
      'unit is the request body (responses carry no session metadata and are aggregated separately). ' +
      'Totals are the exact union of the ingested store history and not-yet-ingested live files — ' +
      'never double-counted. Result includes a preformatted `text` table.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        window_min: { type: 'number', description: 'Rate window in minutes (default 30)' },
        active_min: { type: 'number', description: 'A session writing within this many minutes is flagged active (default 10)' },
        limit:      { type: 'number', description: 'Max ranked writers returned (default 20)' },
      },
    },
  },
  {
    name: 'get_session_detail',
    description:
      'Returns the full timeline (LLM calls, tool calls, file edits) for one session. ' +
      'Use this to learn from a specific past session in detail.',
    inputSchema: {
      type: 'object' as const,
      required: ['sessionId'],
      properties: {
        sessionId: { type: 'string', description: 'Session ID from get_recent_sessions' },
      },
    },
  },
  {
    name: 'find_relevant_context',
    description:
      'Given a task description, keyword-matches against past session prompts and returns ' +
      'files accessed in similar sessions, estimated cost/turns, and known traps. ' +
      'Reliable for established workflows (e.g. "add auth", "fix sidebar tests"); ' +
      'unreliable for novel tasks where keyword overlap is weak — file suggestions ' +
      'may pull in unrelated sessions. Treat results as a sanity check, not a reading list.',
    inputSchema: {
      type: 'object' as const,
      required: ['task'],
      properties: {
        task:      { type: 'string', description: 'Short description of the task you are about to start' },
        workspace: { type: 'string', description: 'Filter sessions by workspace path prefix' },
      },
    },
  },
  {
    name: 'get_efficiency_report',
    description:
      'Returns efficiency trends: are sessions getting more or less expensive? Which ' +
      'agent/model combinations are most efficient? What are the recurring loop signals ' +
      'and efficiency insights? Use this to understand systemic patterns.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workspace: { type: 'string', description: 'Filter by workspace path prefix' },
        days:      { type: 'number', description: 'Analyse sessions from last N days (default 30)' },
      },
    },
  },
  {
    name: 'get_instruction_suggestions',
    description:
      'Returns pending suggestions for improving the agent instruction file (CLAUDE.md, AGENTS.md, etc.) ' +
      'for the specified workspace. Suggestions are derived from patterns in past sessions and include ' +
      'ready-to-paste text. Use this at the start of a session to check for improvements before beginning work. ' +
      'workspace is REQUIRED — cross-workspace suggestions are not meaningful.',
    inputSchema: {
      type: 'object' as const,
      required: ['workspace'],
      properties: {
        workspace: { type: 'string', description: 'Absolute path of the workspace root (required)' },
      },
    },
  },
  // ── P4 context-inflation / cache-break diagnostics (TRDD-TKN5VALS) ─────────────
  {
    name: 'get_context_composition',
    description:
      'Returns WHAT occupies the context window per turn for one session — the injected blocks ' +
      '(hook injections, skill/tool/agent/mcp catalogs, file reads, task reminders) ranked by ' +
      'approximate token weight. Reconstructed on demand from the local Claude .jsonl; token ' +
      'figures are tokenizer estimates (labeled estimated). Pass a turn to drill into a single turn. Use this to answer ' +
      '"why is this turn\'s prompt so big / what is inflating my context".',
    inputSchema: {
      type: 'object' as const,
      required: ['sessionId'],
      properties: {
        sessionId: { type: 'string', description: 'Session ID from get_recent_sessions' },
        turn:      { type: 'number', description: 'Optional 1-based turn to isolate; omit for all turns' },
      },
    },
  },
  {
    name: 'get_context_history',
    description:
      'Reconstructs the FULL per-step context history of a session from the raw Claude .jsonl — every ' +
      'content block drillable to its ACTUAL text: system prompt, CLAUDE.md, rules, tool/skill/agent/mcp ' +
      'catalogs, loaded files, tool inputs AND outputs, bash in/out, hook injections, skill/agent prompts, ' +
      'user & assistant messages, reasoning, post-compact summaries, sub-agent outputs, harness/cron ' +
      'injections. Each block carries its own token count + taxonomy (kind) + role; each step carries the ' +
      'usage buckets (input/output/cache-read/cache-creation) + cost + a DIFF vs the previous step (added/' +
      'changed/removed blocks; firstChangeBlockId = the cache-break point). Progressive: omit turn for ' +
      'per-step summaries; pass turn=N for that step\'s blocks WITH full text; pass turn=N + blockId for one ' +
      'block\'s full text. Reconstructs a fork/sub-agent from its parent transcript. This is THE tool to ' +
      'answer "reconstruct exactly what content consumed the tokens at each call".',
    inputSchema: {
      type: 'object' as const,
      required: ['sessionId'],
      properties: {
        sessionId: { type: 'string', description: 'Session ID from get_recent_sessions' },
        turn:      { type: 'number', description: 'Optional 1-based step/turn to drill into (returns its blocks WITH full text)' },
        blockId:   { type: 'string', description: 'Optional block id (with turn) to return just that one block\'s full text' },
      },
    },
  },
  {
    name: 'get_conversation',
    description:
      'The NARRATIVE per-turn reader of a session (TRDD-B22NYTOY) — the session as a readable ' +
      'conversation, reconstructed verbatim from its .jsonl: each user prompt, the assistant\'s ' +
      'thinking and reply text, every tool call with its input AND its paired output, subagent ' +
      '(sidechain) turns labeled, compaction boundaries with exact pre/post/dropped tokens, per-turn ' +
      'wall duration and usage incl. the cache-TTL tier split (5m/1h). Ordered blocks — never merged ' +
      '(use get_context_history for the composition/cost lens instead). Progressive: omit turn for the ' +
      'header + per-turn summaries (role, preview, tools, usage); pass turn=N for that turn VERBATIM ' +
      '(full text); pass turnFrom/turnTo for a bounded verbatim range. Reconstructs a fork/sub-agent ' +
      'from its parent transcript. This is THE tool to answer "show me what was actually said and done".',
    inputSchema: {
      type: 'object' as const,
      required: ['sessionId'],
      properties: {
        sessionId: { type: 'string', description: 'Session ID from get_recent_sessions' },
        turn:      { type: 'number', description: 'Optional 1-based turn to return VERBATIM (all blocks, full text)' },
        turnFrom:  { type: 'number', description: 'Optional range start (verbatim, capped to 20 turns per call)' },
        turnTo:    { type: 'number', description: 'Optional range end (inclusive, with turnFrom)' },
      },
    },
  },
  {
    name: 'get_context_growth',
    description:
      'Returns the cumulative context-size trajectory per turn for one session: prompt size, the ' +
      'cache-READ vs cache-CREATED split, new (uncached) input, and the per-turn cache-hit rate. ' +
      'This is the "why did this turn balloon" view — a turn with a large cache-CREATED figure ' +
      're-wrote the prefix instead of reading it. Use get_cache_break_report to name the cause.',
    inputSchema: {
      type: 'object' as const,
      required: ['sessionId'],
      properties: {
        sessionId: { type: 'string', description: 'Session ID from get_recent_sessions' },
      },
    },
  },
  {
    name: 'get_cache_break_report',
    description:
      'Diagnoses prompt-cache breaks. The prompt cache is a PREFIX cache: turn N reuses turn N-1 ' +
      'only up to the first byte that differs; everything after is re-billed as cache_creation at ' +
      'full write rate. For one session (sessionId): per-turn break points, the classified CAUSE ' +
      '(TOOLS_CHANGED, MODEL_SWITCHED, INJECTED_BLOCK_CHANGED, IDLE_TTL_EXPIRY, …), the offending ' +
      'block, wasted tokens/cost, and a remediation hint. For a workspace: the top avoidable-break ' +
      'offenders aggregated across a bounded set of recent sessions.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string', description: 'One session to diagnose' },
        workspace: { type: 'string', description: 'Aggregate offenders across sessions under this workspace prefix instead' },
      },
    },
  },
  {
    name: 'get_context_inflation_report',
    description:
      'Ranks the biggest cumulative context contributors (turns × per-turn weight) for a session or ' +
      'workspace, and flags RUNAWAY sources — a block re-injected across many turns (a tool output ' +
      're-read every turn, a huge injected file, a per-turn hook) that, if it sits in the cached ' +
      'prefix, forces repeated cache-creation. With a sessionId it ALSO itemizes the whole ' +
      'transcript by RESIDENT COST (tokens × turns-resident, compaction-aware): every block — ' +
      'post-compaction summaries, tool outputs riding forward, pasted files, repeated hook/cron ' +
      'injections, messages — ranked with first/last turn, occurrences, a per-kind remediation ' +
      'hint, and a drill pointer into get_context_history; reconciled against the exact per-step ' +
      'usage totals so the unattributed remainder is explicit. Use this to find the structural ' +
      'token sinks.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string', description: 'One session to analyze' },
        workspace: { type: 'string', description: 'Aggregate across sessions under this workspace prefix instead' },
      },
    },
  },
  {
    name: 'find_context_hogs',
    description:
      'Returns the top context-consuming sources (files, tool outputs, rules, memories, hook ' +
      'injections, catalogs) ranked by cumulative token cost across a BOUNDED window of sessions. ' +
      'Optional scope filters by workspace path prefix. The cross-session "what is costing me the ' +
      'most context everywhere" leaderboard. The scan is a SAMPLE (most-recent log-backed sessions, ' +
      'capped) — read the `coverage` block in the response for exactly what was scanned vs skipped; ' +
      'never treat the totals as full-history figures unless coverage.complete is true.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        scope: { type: 'string', description: 'Optional workspace path prefix to scope the scan' },
        topN:  { type: 'number', description: 'How many hogs to return (default 15, max 50)' },
      },
    },
  },
  {
    name: 'get_subagent_tree',
    description:
      'Returns the sub-agent spawn tree for a session: the parent plus every sub-agent child with ' +
      'its spawn-KIND (fork = cache-warm; fresh / worktree / fleet = cache-cold), model (inherited ' +
      'vs override), the spawning turn, rolled-up total tokens, and cost. Also returns spawnRollup: ' +
      'the fan-out aggregate (child count, total cache-create/cache-read/output, cost, spawn-kind mix) ' +
      'PLUS antipattern detections — FLEET-COLD (≥3 cold children re-billing the inherited prefix), ' +
      'WORKTREE-SCATTER (worktree-isolated cache-heavy children), MODEL-MIX (children on a different ' +
      'model than the parent) — each with its aggregate waste (tokens + $) and a one-line remediation. ' +
      'Pass any node in the tree — the root is resolved automatically. Call this BEFORE fanning out to ' +
      'self-audit the cheaper spawn shape, or after to see fleet cost and cold-start waste.',
    inputSchema: {
      type: 'object' as const,
      required: ['sessionId'],
      properties: {
        sessionId: { type: 'string', description: 'Any session in the tree (parent or child)' },
      },
    },
  },
  {
    name: 'get_agent_tokens',
    description:
      'EXACT tokens + cost for ONE agent. Accepts a bare agent id, its agent-<id> transcript form, ' +
      'or a full sessionId (all case-insensitive); optional parentSessionId scopes the lookup. An ' +
      'ambiguous id returns an error LISTING the candidates — never a silent guess. Returns the four ' +
      'disjoint billing buckets (input / output / cacheRead / cacheCreation), totalTokens ' +
      '(input+output — the same convention as get_subagent_tree children), cost_usd (same pricing ' +
      'tables), spawn metadata (spawnKind / warm / model / parentSessionId / spawnedByTurn), and ' +
      'ccDisplayEquivalent to reconcile with Claude Code\'s per-agent ↓ footer display: CC\'s ↓ ≈ ' +
      'cumulativeInputSideTokens (cumulative input + cacheRead + cacheCreation across ALL the ' +
      'agent\'s turns, launch turn INCLUDED — a fork\'s turn-1 inherited-prefix cache read dominates ' +
      'it; output is excluded or below CC\'s 0.1k display rounding). The ↓ figure is VOLUME MOVED, ' +
      'not billing — use cost_usd for spend. lastTurnContextRead is the live context-size proxy ' +
      '(the last turn\'s input-side buckets). tokensSource/coverageNote carry the log-vs-otel ' +
      'provenance; zero buckets on an async child with no transcript are flagged asyncTokensUnknown ' +
      '(unknown, not measured-free).',
    inputSchema: {
      type: 'object' as const,
      required: ['agentId'],
      properties: {
        agentId:         { type: 'string', description: 'Bare agent id (e.g. a1b2c3…), agent-<id>, or a full sessionId — case-insensitive' },
        parentSessionId: { type: 'string', description: 'Optional spawning session id — scopes the lookup when the same agent id matches multiple cards' },
      },
    },
  },
  {
    name: 'get_call_context',
    description:
      'Returns the FULL literal context of ONE llm API call, reconstructed from Claude Code\'s raw ' +
      'OTEL request body ({system, messages[], tools[]}) captured via OTEL_LOG_RAW_API_BODIES. Every ' +
      'element — system prompt (CLAUDE.md/rules tagged), each user/assistant message, tool inputs AND ' +
      'outputs, bash in/out, MCP calls, thinking, the tool catalog — is an ORDERED block drillable to ' +
      'its ACTUAL text with per-block token count (tokenizer estimate, calibrated to usage when possible; see tokenSource) + taxonomy (kind) + role. Identify the ' +
      'call by sessionId + requestId (from the api_request event / an llm_request span) or by spanId. ' +
      'Works for OTEL-only sessions with no local .jsonl. This is THE tool to answer "show me the ' +
      'exact whole context at THIS specific call". Returns a clear message (never a spinner) when the ' +
      'raw body was not captured for that call.',
    inputSchema: {
      type: 'object' as const,
      required: ['sessionId'],
      properties: {
        sessionId: { type: 'string', description: 'Session ID from get_recent_sessions' },
        requestId: { type: 'string', description: 'request_id of the call (from the api_request event / llm_request span); omit to use spanId or the latest call' },
        spanId:    { type: 'string', description: 'spanId of the call\'s llm_request span (alternative to requestId)' },
      },
    },
  },
  {
    name: 'get_cost_by_cause',
    description:
      'Tokens-by-CAUSE attribution rollup — WHO spent the tokens. Groups every claude_code.api_request ' +
      'event by cause dimension (query source → agent → skill → plugin → MCP server → MCP tool) and sums ' +
      'the 4 usage buckets + the EXACT per-call cost_usd, ranked heaviest-first per dimension. Figures are ' +
      'ground truth (per-call usage + cost), not estimates; works for OTEL-only sessions (no .jsonl needed). ' +
      'Complements find_context_hogs (which ranks CONTEXT sources; this ranks per-call CAUSES). Pass ' +
      'sessionId for one session (reconciled against the session usage totals — the unattributed remainder ' +
      'is explicit, never dropped), or omit it for the cross-session leaderboard over the last `days` ' +
      '(default 7) — read the `coverage` block for exactly what was scanned; calls carrying no value for a ' +
      'dimension land in that dimension\'s pinned "(no <dim>)" bucket.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string', description: 'One session to roll up; omit for the cross-session leaderboard' },
        days:      { type: 'number', description: 'Leaderboard window in days (default 7, max 90); ignored when sessionId is set' },
      },
    },
  },
  // ── Realtime burn / rate-limit-window monitor (TRDD-OG9PARZQ) ──────────────────
  {
    name: 'get_burn_status',
    description:
      'Realtime token-burn "smoke detector" across ALL live sessions on this machine: rolling ' +
      'tokens/min and $/min (1-min + 5-min windows, global + per hottest session), the rate-limit ' +
      'WINDOW BUDGET (rolling 5h + 7d consumption vs a user-configured capacity, % consumed, and a ' +
      'time-to-exhaustion PROJECTION at the current rate — capacity/pct/projection are null when the ' +
      'capacity is unconfigured, never invented), and any active threshold ALERTS (each naming the ' +
      'session + dominant cause: agent/skill/plugin/mcp/compaction). Each top session also carries its ' +
      'keepWarm cache-gap diagnostic (warm/cold turns vs the ~5-min prompt-cache TTL + wasted write ' +
      'tokens; null without api_request data). Use this to self-throttle before you hit the provider ' +
      'rate-limit wall.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_session_status',
    description:
      'One-call self-diagnostic for YOUR session (agents rarely know their own sessionId — pass your ' +
      'workspace path and it resolves the newest LIVE session under that prefix, else the newest ' +
      'overall labeled live:false). Returns current + peak context usage, the 4 usage buckets (last ' +
      'turn), the avg-per-call 5 values, cache-hit rate, last-LLM-call cost, session-total cost, ' +
      'tokens/min rate, the keepWarm cache-gap diagnostic (warm/cold turns vs the ~5-min prompt-cache ' +
      'TTL + the cache-write tokens cold turns wasted; null without api_request data), remaining 5h + ' +
      '7d rate-limit-window %, and a compact comparison to your previous sessions in the same ' +
      'workspace (cost/turns/cache-hit deltas). For the per-turn context DIFF and composition ' +
      'drill-down, follow up with get_context_history / get_context_composition.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string', description: 'Your session id if known (exact match)' },
        workspace: { type: 'string', description: 'Your workspace path prefix — resolves the newest live session under it' },
      },
    },
  },
  // ── Cache-expiry probe (TRDD-OCNHOHE9) ────────────────────────────────────────
  {
    name: 'check_cache_expiry',
    description:
      'Has a session\'s prompt cache EXPIRED? Measures idle time since the session\'s last LLM ' +
      '(api_request) call and compares it to that session\'s TTL — 1h for a subscription main ' +
      'conversation, 5min for a subagent (ALWAYS) or a usage-credits/API session — so "expired" ' +
      'means the cached prefix was likely evicted and the next request pays a full cache-creation ' +
      'write (~1.25× the prefix). Returns per session: `verdict` (fresh|expired|unknown), `idleHuman` ' +
      '(e.g. "1h 12m"), `ttlMin`+`ttlSource`+`ttlBasis` (the TTL and WHY that number — never a bare ' +
      'guess; unknown auth surfaces an "assumed" 5-min floor), `lastRequestAt`, and `reason`. Default ' +
      'target = the newest MAIN session OF THE CALLING PROJECT (you rarely know your own id, and a ' +
      'machine-wide pick would silently answer about someone else\'s repo); pass `all:true` for every ' +
      'session, `sessionId` for one, `project` to name another repo (or `""` for machine-wide), or ' +
      '`thresholdMinutes` to override the TTL with an explicit cutoff (e.g. 60 to probe "more than 1h ' +
      'idle"). A `verdict:"unknown"` means no LLM request was recorded. For a plain true/false a shell ' +
      'can branch on, use the CLI verb `agentlenspro cache-expired` instead of parsing this payload.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string', description: 'Check one session by exact id (default: newest main session)' },
        all: { type: 'boolean', description: 'Check every known session instead of just the newest main one' },
        // The CLI auto-forwards its cwd into any tool that declares `project`, so this makes the
        // default "my own conversation" TRUE rather than aspirational — see the scoping note on
        // handleCheckCacheExpiry for why the unscoped default was a wrong-answer generator.
        project: { type: 'string', description: 'Absolute project path — restrict to sessions whose workspace is at or under it. Defaults to the calling working directory; pass "" for machine-wide' },
        thresholdMinutes: { type: 'number', description: 'Explicit idle cutoff in minutes; overrides the per-session TTL (e.g. 60 = "> 1h idle")' },
      },
    },
  },
  // ── Per-account awareness + window budget (TRDD-BURNWDGT) ──────────────────────
  {
    name: 'get_account_status',
    description:
      'WHICH OAuth account you are on right now + its PLAN, billing MODE, cache-TTL regime, and how much ' +
      'of ITS rate-limit window is left — with a one-line human `summary`. Rate limits are PER ACCOUNT — ' +
      'rotating to a second email does NOT reset the first. Returns: the current account (email/org label, ' +
      'account id); `plan` (e.g. "Max 5x"/"Max 20x"/"Pro" from planType + rateLimitTier); `mode` ' +
      '(subscription-within-plan vs drawing-usage-credits vs API pay-per-token); `cacheTtl` {minutes, ' +
      'regime, ttlSource} — the prompt-cache TTL your MAIN session actually rides (1h on a subscription, ' +
      '5min on usage-credits/API), so a warm gap is not misread as cold; and `usageWindows` {fiveHourPct, ' +
      'sevenDayPct, windowSource} — Claude Code\'s own rate_limits utilization when available ' +
      '(windowSource "cc-rate-limits"), else AgentlensPro\'s calibrated pct ("calibrated"; ' +
      '"calibrated-exceeded" = consumption has passed the auto-observed LOWER BOUND, so the pct is ' +
      'null because the denominator is proven stale — not because it is unknown), else null ' +
      '("none") — a null is NEVER presented as 0. The OAuth token is NEVER read or returned. Use this ' +
      'after a rotation, or before a long run, to know the ACCOUNT you will actually burn. ' +
      'PASS `all: true` FOR EVERY ACCOUNT this machine has ever been on, not just the live one — the ' +
      'answer a ROTATOR needs, since deciding whether to switch requires the headroom of the accounts ' +
      'you are NOT on. Still no credential is read: each row is what was OBSERVED while that account ' +
      'was live, with `observedAt`/`staleSeconds` and a per-window `freshness` — `fresh` (measured), ' +
      '`aged` (past the TTL but the window has NOT reset, so a LOWER bound), `rolled` (the window reset ' +
      'AND this machine left the account before the reading, so INFERRED ~0% — audit via `leftAt`), ' +
      '`stale` (reset but activity since cannot be excluded → null with a reason), `unreadable` (never ' +
      'observed → null with a reason, NEVER an absent row: "cannot read this account" and "this account ' +
      'has no headroom" are opposite signals). Per-model weekly buckets are reported separately and NOT ' +
      'folded into the verdict — a spent per-model bucket does not block other models.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        all: { type: 'boolean', description: 'Report every observed account instead of only the live one.' },
      },
    },
  },
  {
    name: 'get_account_state_at',
    description:
      'The subscription STATE that was active at a PAST instant — which account, billing mode, plan, ' +
      'and cache-TTL regime you were on when a given request/span happened. Resolved by binary-searching ' +
      'the change-detected account-state timeline (written only when the discrete state changes, so it ' +
      'costs a few disk writes/hour, never per-request). Pass `ts` (ms epoch) OR `iso` (ISO-8601). Use it ' +
      'to attribute a past burn/request to the mode+plan+TTL in force at that time (e.g. "was I on Max 5x ' +
      'or drawing usage credits when THIS span ran?"). Returns the matching state record + its start ' +
      'timestamp, or null when the timeline does not reach that far back (never a fabricated state).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ts: { type: 'number', description: 'Instant to resolve, milliseconds since the Unix epoch' },
        iso: { type: 'string', description: 'Instant to resolve as an ISO-8601 timestamp (alternative to ts)' },
      },
    },
  },
  {
    name: 'get_window_budget',
    description:
      'The rate-limit WINDOW budget split PER OAuth account (5h + 7d consumed tokens/cost + % of a ' +
      'configured capacity + a time-to-exhaustion projection), so a rotated account never pools with the ' +
      'first. Pass an accountId to get just that account; omit for every account (heaviest first, the ' +
      'unattributed bucket last) plus the machine-wide pooled total. When a COST capacity is configured, a ' +
      'cost-based % is returned too (the truthful fill metric when the plan bills by cost — cache-read at ' +
      '0.1× barely counts there even though it dominates the raw token count). With no manual capacity, ' +
      'AgentlensPro AUTO-CALIBRATES per account from real rate-limit hits (a premature 5h window end IS a ' +
      'capacity measurement): capacitySource "observed" + capacityObservedAt carry the calibration date, ' +
      'and the figure is a proven lower bound that only ever ratchets up.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        accountId: { type: 'string', description: 'An account_uuid to filter to; omit for all accounts + the pooled total' },
      },
    },
  },
  // ── OTEL-raw-body context composition query surface (TRDD-CTXQUERY) ────────────
  {
    name: 'get_image_report',
    description:
      'How many IMAGES a session (or project/all) sent into the context, and what re-reading them cost. ' +
      'Reconstructed LAZILY from Claude Code\'s raw OTEL request bodies (the exact per-call context). Per ' +
      'session: image count, per-call image token weight, the first turn they appeared, how many turns ' +
      'they stayed resident (the Anthropic API is stateless → the whole transcript incl. images is re-sent ' +
      'every call), and the CUMULATIVE cache-read cost of those re-reads. This is the tool that surfaces ' +
      'the "8 screenshots stuck for 400 turns = 525k tokens re-read every turn = ~$425" pattern. Scope by ' +
      'sessionId or a project path prefix; omit for a bounded most-recent scan (read `coverage`). Only ' +
      'sessions with raw bodies in the live registry are scanned (lazy — no full-disk sweep).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        scope: { type: 'string', description: 'A sessionId, a project path prefix, or omit for a bounded most-recent scan' },
      },
    },
  },
  {
    name: 'find_resident_blobs',
    description:
      'THE eviction-candidate finder: context blocks (images, tool_results, pasted files, bash output, ' +
      'text) that stay RESIDENT across many turns, ranked by wasted CUMULATIVE cache-read cost — because ' +
      'a block riding forward is re-read (cache-read billed) on every turn until compaction evicts it. ' +
      'Use this to decide what to compact, move to a sub-agent (isolated context), or stop retaining. ' +
      'Filter by block kind (image | toolOutput | bashOutput | file | userMsg | …), a minimum per-block ' +
      'token size, and a minimum resident-turn count. Scope by sessionId / project prefix / omit (bounded ' +
      'lazy scan — read `coverage`).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        scope:            { type: 'string', description: 'A sessionId, a project path prefix, or omit for a bounded most-recent scan' },
        kind:             { type: 'string', description: 'Optional block-kind filter (image, toolOutput, bashOutput, file, userMsg, assistantMsg, reasoning, mcp, …)' },
        minTokens:        { type: 'number', description: 'Only blocks whose peak single-occurrence tokens ≥ this (default 0)' },
        minResidentTurns: { type: 'number', description: 'Only blocks resident across ≥ this many turns (default 2)' },
        topN:             { type: 'number', description: 'How many ranked blobs to return (default 20, max 100)' },
      },
    },
  },
  {
    name: 'query_context_blocks',
    description:
      'The GENERIC composition query engine — "all possible queries" over the raw-body context blocks in ' +
      'one tool. FILTER by any of {project, sessionId, kind, model, minTokens, turnFrom, turnTo} and ' +
      'GROUP-BY any of {kind, session, project, model, turn}; returns each group\'s Σ tokens, block count, ' +
      'and estimated cache-read cost, heaviest-first. Reconstructed lazily from the OTEL request bodies ' +
      '(token figures calibrated to the paired response body\'s exact usage when available, else ' +
      'estimated). Read `coverage` for what was scanned. Examples: kind=image groupBy=session → biggest ' +
      'image sessions; groupBy=kind for one session → its block-type breakdown.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        project:   { type: 'string', description: 'Filter by project path prefix' },
        sessionId: { type: 'string', description: 'Filter to one session' },
        kind:      { type: 'string', description: 'Filter by block kind (image, toolOutput, file, system, claudemd, rule, toolCatalog, mcp, reasoning, …)' },
        model:     { type: 'string', description: 'Filter by model (substring match)' },
        minTokens: { type: 'number', description: 'Only blocks with ≥ this many tokens' },
        turnFrom:  { type: 'number', description: 'Only calls at turn ≥ this' },
        turnTo:    { type: 'number', description: 'Only calls at turn ≤ this' },
        groupBy:   { type: 'string', description: 'Group-by dimension: kind | session | project | model | turn (default kind)' },
        topN:      { type: 'number', description: 'How many ranked groups to return (default 20, max 100)' },
      },
    },
  },
  {
    name: 'get_block_content',
    description:
      'Drill into ONE context block of a specific call and return its ACTUAL text — the on-demand content ' +
      'fetch for the composition tools. Identify it by sessionId + turn (1-based call index) + blockIndex ' +
      '(from query_context_blocks / a composition record). An IMAGE block returns metadata + a body-file ' +
      'ref, never the base64 bytes (pointer-only). Pass full=true to lift the per-block text cap for a ' +
      'single deep read.',
    inputSchema: {
      type: 'object' as const,
      required: ['sessionId', 'turn', 'blockIndex'],
      properties: {
        sessionId:  { type: 'string', description: 'Session ID' },
        turn:       { type: 'number', description: '1-based call index within the session' },
        blockIndex: { type: 'number', description: 'Block position within that call' },
        full:       { type: 'boolean', description: 'Lift the per-block text cap for this single block (default false)' },
      },
    },
  },
  // ── cache_creation forensics (TRDD-CCFORNSC) ────────────────────────────────────
  {
    name: 'get_cache_creation_report',
    description:
      'The COST-PEAK finder: ranks WHO/WHAT is burning the most of a chosen cost BUCKET — cache_creation ' +
      '(the ~1.25x/2x prefix WRITE, default), output (billed ~5x — sometimes the real culprit, NOT the ' +
      'cache write), input, total tokens, or billable_weighted (the real USD cost across all buckets). ' +
      'Scans the raw OTEL bodies on disk, joins each write to its owning session via the ' +
      'previous_message_id chain, and aggregates heaviest-first by session, account, model, hourly ' +
      'time-window, or cause (the cache-break ROOT-CAUSE code from get_cache_break_timeline\'s ' +
      'classifier — "which misconfiguration is burning the most money", not just "which session"). ' +
      'Always includes an explicit `unattributed` bucket (last-turn / still-in-flight responses with no ' +
      'following request to join against — groupBy=cause has none, since only classified turns are ' +
      'counted) and a top-5 `outputSpikes` list surfacing the biggest single OUTPUT-token events even ' +
      'when ranking by a different bucket. The scan is a bounded, most-recent-first SAMPLE (never a full ' +
      '15k+-file sweep) — read `coverage` for exactly what was scanned.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        window:  { type: 'number', description: 'Only include writes from the last N hours (e.g. 5 for the live rate-limit window); omit for the bounded most-recent scan across all history' },
        groupBy: { type: 'string', description: 'Aggregation dimension: session | account | model | time | cause (default session)' },
        bucket:  { type: 'string', description: 'Cost bucket to rank by: cache_creation | output | input | total | billable_weighted (default cache_creation)' },
        topN:    { type: 'number', description: 'How many ranked groups to return (default 15, max 50)' },
        format:  { type: 'string', description: 'Output format: json (default) | table | markdown | timeline' },
      },
    },
  },
  {
    name: 'trace_expensive_writes',
    description:
      'For the biggest single cache_creation write events, resolves session/account via the ' +
      'previous_message_id chain and summarizes WHAT content made the write so expensive — image / ' +
      'tool_result / text / system / thinking token shares plus the tool-catalog size — from the request ' +
      'body that produced it. POINTER-ONLY: never returns base64 image bytes, raw block text, or the ' +
      'metadata.user_id token; only derived identifiers (session_id, account_uuid) and token counts. ' +
      'Complements get_cache_creation_report\'s "who" with the "what\'s inside the huge writes" view — ' +
      'the composition field is null when the owning request body could not be resolved (e.g. the write ' +
      'was unattributed). Rich filters {sessionId, accountUuid, model, minCacheCreate, minOutputTokens, ' +
      'turnRange, timeRange} narrow the events; chainDepth attaches each event\'s backward CONTEXT CHAIN ' +
      '(the ordered turns leading up to it) so you see HOW the context ramped to the write. Read ' +
      '`coverage` for the bounded scan scope.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId:       { type: 'string', description: 'Only writes from this session' },
        accountUuid:     { type: 'string', description: 'Only writes from this OAuth account' },
        model:           { type: 'string', description: 'Only writes on a model matching this substring' },
        minCacheCreate:  { type: 'number', description: 'Only events with at least this many cache_creation tokens (default 0 — no floor)' },
        minOutputTokens: { type: 'number', description: 'Only events with at least this many OUTPUT tokens (find output-token spikes, billed ~5x)' },
        turnFrom:        { type: 'number', description: 'Only writes at/after this per-session cache_creation-event turn index (1-based)' },
        turnTo:          { type: 'number', description: 'Only writes at/before this per-session cache_creation-event turn index' },
        timeFrom:        { type: 'string', description: 'Only writes at/after this ISO timestamp' },
        timeTo:          { type: 'string', description: 'Only writes at/before this ISO timestamp' },
        topN:            { type: 'number', description: 'How many top events to trace (default 6, max 25)' },
        chainDepth:      { type: 'number', description: 'Attach each event\'s N preceding turns as its backward context chain (default 0 = off, max 20)' },
        window:          { type: 'number', description: 'Only include writes from the last N hours; omit for the bounded most-recent scan across all history' },
        format:          { type: 'string', description: 'Output format: json (default) | table | markdown | timeline' },
      },
    },
  },
  {
    name: 'get_cache_break_gap_report',
    description:
      'Tells apart 5-min TTL EXPIRY from a genuine cache BREAK as the cause of expensive cache_creation ' +
      'writes — the two look identical in raw totals but have opposite fixes (a heartbeat prevents TTL ' +
      'expiry; nothing about a heartbeat stops a prefix from actually changing). Returns: (1) the TIER ' +
      'SPLIT of all scanned cache_creation into the 5-min vs 1-hour ephemeral-cache buckets (from ' +
      'usage.cache_creation) — a mostly-1h-tier total means a <5min heartbeat is irrelevant; (2) for every ' +
      'BIG (>= minCacheCreate, default 100k tokens) single write, the TIME GAP since the previous call in ' +
      'the SAME session (via the previous_message_id chain), bucketed into first-call / <4.5m / 4.5-6m ' +
      '(the 5-min TTL window) / 6-15m / 15-65m / >65m (the 1h TTL window). Mass in the 4.5-6m bucket means ' +
      'a heartbeat would help; mass in <4.5m means something upstream is breaking the cache prefix and no ' +
      'heartbeat can fix it. Read `coverage` for the bounded scan scope.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        minCacheCreate: { type: 'number', description: 'Only classify writes with at least this many cache_creation tokens (default 100000)' },
        window:         { type: 'number', description: 'Only include writes from the last N hours; omit for the bounded most-recent scan across all history' },
      },
    },
  },
  {
    name: 'get_cache_break_timeline',
    description:
      'The ROOT-CAUSE timeline: for ONE session, reconstructs its ordered turns from the raw OTEL ' +
      'bodies (via the previous_message_id chain) and, for every turn with a significant cache_creation ' +
      'write, DIFFS its cached prefix against the previous turn in the docs hierarchy order (model → ' +
      'tools → effort → system → message-prefix), finds the FIRST divergent element = the break point, ' +
      'and CLASSIFIES the definitive culprit into a cause code: TOOLSET_CHANGED, TOOLS_REORDERED, ' +
      'TOOL_SEARCH_DEFERRED, MCP_TOOLS_CHANGED, PLUGINS_RELOADED (≥2 of tool/skill/agent catalogs ' +
      'churned together = /reload-plugins — see get_cache_risk_costs / `reload-cost`), MODEL_SWITCH, EFFORT_SWITCH, HOOK_INJECTION, ' +
      'SKILL_INJECTION, SKILL_DESCRIPTION_TRUNCATION, SKILL_CHANGED, INLINE_EXEC_RESULT_CHANGED, ' +
      'CLAUDE_MD_CHANGED, AGENT_METADATA_CHANGED, SYSTEM_TIMESTAMP, CONTEXT_ORDER_CHANGED, TTL_EXPIRY, ' +
      'COLD_START, COMPACTION, SUBAGENT_INTERLEAVE (A→B→A stream artifact — sub-agent calls share the ' +
      'parent session id), NORMAL_GROWTH (append-only new-tail first-write — expected, not a break), ' +
      'MESSAGE_TRIMMED (harness context-editing removed a cached block), ATTACHMENT_CHANGED (image / ' +
      'tool_use fingerprint changed), UNCLASSIFIED. Emits a TIMELINE of break events (each naming the culprit ' +
      'element + tokens re-written) PLUS a REPEAT-OFFENDER rollup: break events grouped by (cause, the ' +
      'specific offending element) so the SAME element breaking the cache across many turns collapses ' +
      'into ONE chronic offender — flagged SYSTEMATIC at ≥3 turns with a plain-language verdict naming ' +
      'the exact misconfigured hook/skill/tool and its fix. POINTER-ONLY (stable fingerprints, never raw ' +
      'block text / base64 / the user_id token). The per-turn `events` log is bounded to the most recent ' +
      'topN (default 25, max 100) — `repeatOffenders`/`causeHistogram` always summarize the FULL session, ' +
      'never truncated, so the chronic-offender verdict is exact even when the raw log is capped. Read ' +
      '`coverage` for the bounded scan scope.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string', description: 'The session to reconstruct (exact match from get_cache_creation_report / get_recent_sessions). agent-<agentId> child sessions are supported: their turns are carved out of the parent stream via the child transcript\'s message-id chain.' },
        scope:     { type: 'string', description: 'A session-id prefix — resolves to the heaviest matching session; omit to pick the heaviest session overall in the scan' },
        minTokens: { type: 'number', description: 'Only classify turns whose cache_creation ≥ this (default 5000)' },
        window:    { type: 'number', description: 'Only scan bodies from the last N hours; omit for the bounded most-recent scan across all history' },
        topN:      { type: 'number', description: 'Cap on the returned per-turn events log, most-recent-first (default 25, max 100). repeatOffenders/causeHistogram are always computed over ALL classified turns regardless.' },
        format:    { type: 'string', description: 'Output format: json (default, full object) | table | markdown | timeline' },
      },
    },
  },
  {
    name: 'get_cache_risk_costs',
    description:
      'THE CACHE-BREAKING-COMMAND COST SHORTCUT — CLI alias `reload-cost` (TRDD-EYA3X5MQ). Lists the most ' +
      'recent prefix-breaking slash commands with the cache-write cost each caused (cache_creation tokens ' +
      '+ USD): /reload-plugins, /reload-skills, a mutating /plugin (install|uninstall|enable|disable|' +
      'update|marketplace), /login and /logout (a credential swap makes the previous cache entry ' +
      'unreachable), /mcp and /model. The causes are EXACT, not inferred — Claude Code persists every ' +
      'built-in command it runs as a transcript entry, so this is read off disk retroactively with no ' +
      'hook, no restart and no OTEL-body capture. The cost comes from the same composition path ' +
      'get_cache_break_report uses, joined on the turn wall-clock: a command at time T is billed on the ' +
      'FIRST turn at or after T, because the local command makes no API call and its changed prefix rides ' +
      'the NEXT model request. Menu commands (bare /plugin, /mcp, /model) are marked mutation=ambiguous ' +
      'and charged 0 when the following turn did not actually break. Read byKind for the per-command ' +
      'totals, eventsPriced vs commandsFoundInTranscripts for coverage, and unexplainedReloadTurns for ' +
      'reload-shaped turns no command explains (co-churn INFERENCE, listed separately and never summed in).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        window:    { type: 'number', description: 'Only consider commands from the last N hours; omit for all history' },
        minTokens: { type: 'number', description: 'Skip events whose billed cache_creation is below this' },
        topN:      { type: 'number', description: 'Cap on the returned events list, most-recent-first (default 25, max 200)' },
        workspace: { type: 'string', description: 'Only sessions whose workspace path starts with this' },
        kinds:     { type: 'array', items: { type: 'string' }, description: 'Filter to these kinds: PLUGINS_RELOADED, SKILLS_RELOADED, PLUGIN_CHANGED, ACCOUNT_SWITCHED, MCP_SERVER_TOGGLE, MODEL_SWITCHED, COMPACTION, CLEAR' },
      },
    },
  },
  {
    name: 'get_skill_attribution',
    description:
      'WHICH SKILL OR PLUGIN IS SPENDING MY MONEY — CLI alias `skill-cost` (TRDD-A4BA8IU5). Rolls up ' +
      'tokens and USD per skill and per plugin from the `attributionSkill` / `attributionPlugin` stamps ' +
      'Claude Code writes on assistant records. Exact and retroactive over the whole history: read off ' +
      'disk, no hook, no schema, no OTEL capture required. Usage is counted ONCE per message id — ' +
      'Claude Code writes one message as many content-block rows and repeats the full usage on each, ' +
      'so a naive sum over-counts 2-5x (duplicateRowsSkipped reports what was collapsed). Each rollup: ' +
      'messages, input/cacheRead/cacheWrite/output tokens, costUsd (priced per message with that ' +
      "message's own model), models seen, first/last timestamp. Sorted most-expensive-first, which is " +
      'the point — this is how you find the skill behind a burn. Read pricedMessages vs ' +
      'attributedMessages for coverage.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        window: { type: 'number', description: 'Only count messages from the last N hours; omit for all history' },
        topN:   { type: 'number', description: 'Cap each list (by cost, highest first); totals are unaffected' },
      },
    },
  },
  {
    name: 'get_loaded_plugin_versions',
    description:
      'WHICH PLUGIN VERSION IS EACH SESSION ACTUALLY RUNNING — CLI alias `plugin-versions` ' +
      '(AgentlensPro#5). A plugin update lands machine-wide, but hooks and skills are SESSION-LOADED: ' +
      'a running session keeps executing the OLD cached code until its own /reload-plugins, so a ' +
      'fleet rollout leaves invisible old-behavior ghosts that look exactly like "the fix does not ' +
      'work". Read off disk from the harness-emitted skill-load attachment (which carries the ' +
      'versioned plugin-cache path), compared against the newest version in ~/.claude/plugins/cache. ' +
      'loadedVersion is the MAX version observed in the session, deliberately NOT the ' +
      'latest-by-timestamp one: a compaction replays earlier skill invocations as fresh records ' +
      'carrying their ORIGINAL older content, so 18 of 19 multi-version sessions measured are ' +
      'non-monotone in time. stale is TRI-STATE — true (behind the cache), false (current), or ' +
      "'unknown' when a reload happened after our last evidence, because a fabricated verdict is " +
      'worse than an honest gap. There is no pid: read lastActivityTs (transcript mtime) with ' +
      'activeMinutes for liveness, and sessionsScanned vs sessionsWithSkillEvidence for the blind ' +
      'spot — a session that invoked no plugin skill is absent from rows, NOT current.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        plugin:        { type: 'string',  description: 'Only this plugin, bare name (e.g. ai-maestro-janitor)' },
        activeMinutes: { type: 'number',  description: 'Only sessions whose transcript was touched in the last N minutes' },
        staleOnly:     { type: 'boolean', description: 'Only sessions behind the cache (keeps unknown, drops current)' },
      },
    },
  },
  {
    name: 'get_lifecycle_events',
    description:
      'The session-LIFECYCLE timeline (TRDD-EYA3X5MQ): /clear, /compact, resume, fork, startup, ' +
      'session-end, turn-death (StopFailure), and Pre/PostCompact — the harness events that bound and ' +
      'RESET a session — read from the lifecycle hook-event store (needs --install-hooks). Most notably ' +
      '/clear (SessionStart source=clear), the cost REMEDY that resets the transcript floor. Each row: ts, ' +
      'session, kind, detail (the source/reason/trigger/error_type discriminator), ev (raw hook name). ' +
      'Per-turn Stop events are excluded by default (noise); pass `kinds` to select an exact set. Says ' +
      'honestly when the hook store is absent (dirExists:false).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        session: { type: 'string', description: 'Only this session id' },
        kinds:   { type: 'array', items: { type: 'string' }, description: 'Keep only these lifecycle kinds (e.g. ["CLEAR","STOP_FAILURE","COMPACT"]); default = all except the per-turn STOP' },
        window:  { type: 'number', description: 'Only events from the last N hours' },
        limit:   { type: 'number', description: 'Cap the returned events, most-recent-first (default 100)' },
      },
    },
  },
  {
    name: 'check_burn_risk',
    description:
      'REALTIME early-warning against token explosions — the guard half of investigate_burn (which explains ' +
      'a drain AFTER the fact; this warns AS it starts). One cheap in-memory call returns 6 risk flags: ' +
      'FANOUT_BURST (≥5 SubagentStart hook events in 2min — a fan-out is ' +
      'launching NOW), COLD_RESUME_RISK (a StopFailure ≤10min ago — the stall likely outlived the 5-min cache ' +
      'TTL; resuming a fan-out into it is the measured worst case), COMPACTION_REWRITE (PreCompact ≤5min — ' +
      'full-prefix rewrite in progress), HUGE_REQUEST_BURST (≥3 requests >1MB in 90s — a fat-context fan-out ' +
      'IN FLIGHT), BURN_SPIKE (live 5-min tokens/min above threshold), CACHE_THRASH (≥3 responses in 5min ' +
      'with big cache_creation and ~zero cache_read — the prefix is being INVALIDATED every turn instead of ' +
      'read from cache; exact Anthropic usage numbers, the measured lean-ctx-class disaster). Hook-event risks need ' +
      '--install-hooks; the sources block says honestly which feeds are absent. Poll every 10-30s, or use ' +
      '`agentlenspro-cli --guard [seconds]` which polls for you and prints one line per risk TRANSITION — ' +
      'designed to be armed via a background monitor so the agent is interrupted the moment a risk fires.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        fanoutThreshold:   { type: 'number', description: 'SubagentStarts in 2min that trip FANOUT_BURST (default 5)' },
        spikeTokensPerMin: { type: 'number', description: '5-min tokens/min that trips BURN_SPIKE (default 250000)' },
      },
    },
  },
  {
    name: 'get_cost_rollup',
    description:
      'Interval cost/usage ROLLUP with the 5-value breakdown (input, output, cache_read, cache_creation, ' +
      'cost USD) + tokens-and-$ PER HOUR, grouped your way: groupBy project (each workspace), all (one ' +
      'combined row), session, model, or subagent (every spawned sub-agent ranked — spawn kind/type and ' +
      'parent included). Filters: windowHours or sinceIso/untilIso (spawn-time interval), subagentsOnly, ' +
      'parentSessionId (sub-agents of one main session), liveOnly (still receiving turns — the "what are ' +
      'my currently running subagents burning" view). sortBy any of the 5 values or total. Honest by ' +
      'construction: sessions count when they OVERLAP the window (token totals are whole-session — cards ' +
      'are session-granular, disclosed in coverage); unpriced-model sessions are excluded from $ and ' +
      'counted, never silent $0. Answers: project cost in an interval, all projects combined, subagent ' +
      'leaderboards, live-fleet burn.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        groupBy:         { type: 'string', description: 'project (default) | all | session | model | subagent' },
        windowHours:     { type: 'number', description: 'Window ending now (default 24; ignored when sinceIso is set)' },
        sinceIso:        { type: 'string', description: 'Window start (ISO datetime)' },
        untilIso:        { type: 'string', description: 'Window end (ISO datetime, default now)' },
        subagentsOnly:   { type: 'boolean', description: 'Only sessions spawned by a parent (sub-agents)' },
        parentSessionId: { type: 'string', description: 'Only sub-agents of this parent session' },
        liveOnly:        { type: 'boolean', description: 'Only sessions active in the last 3min' },
        sortBy:          { type: 'string', description: 'cost (default) | input | output | cacheRead | cacheCreation | total' },
        topN:            { type: 'number', description: 'Max groups returned (default 20, max 100)' },
      },
    },
  },
  {
    name: 'predict_session_cost',
    description:
      'PREDICT what a planned session/sub-agent run will cost BEFORE launching it (code reviews, ultracode ' +
      'workflows, big refactors): matches past sessions by task keywords + sub-agent type + a soft file-size ' +
      'band, and returns the DISTRIBUTION (p25/p50/p75) of their 5 values (input, output, cache_read, ' +
      'cache_creation, cost USD) + turns, with the matched precedents listed (similarity, model, cost) so ' +
      'the estimate is auditable. p50 = central estimate, p75 = budget-safe. Honest by construction: no ' +
      'matching precedent → no prediction, never a fabricated point guess.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        task:         { type: 'string', description: 'Describe the planned work in a sentence (matched against past first-requests)' },
        subagentType: { type: 'string', description: 'Prefer precedents of this spawn type (fork, general-purpose, ...)' },
        fileBytes:    { type: 'number', description: 'Approx bytes of input files the task will read (soft 10x comparability band)' },
        topK:         { type: 'number', description: 'Max precedents used (default 12, max 50)' },
      },
    },
  },
  {
    name: 'get_runtime_inventory',
    description:
      'Every Claude Code INSTANCE running on this machine with its TOTAL memory footprint — the claude ' +
      'process plus EVERYTHING it spawned (subshells, worktree/subagent processes, forks, plugin crons, ' +
      'MCP servers, headless browsers, background tasks), computed from one ps snapshot via process-tree ' +
      'rollup (nested claude processes fold into their root instance). Ranked by total tree RSS; each ' +
      'instance shows its project dir (lsof cwd), process count, uptime, and its 5 heaviest descendants. ' +
      'Also reports the Claude Code client version. Join an instance to its live model/burn via workspace ' +
      'in get_burn_status / get_cost_rollup --liveOnly. POSIX (macOS/Linux/WSL) — says so on native Windows.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_rate_limit_report',
    description:
      'RATE-LIMIT forensics: every StopFailure (rate-limit/API turn death) in the window, grouped into ' +
      'stall EPISODES (events ≤10min apart = one incident) with the affected sessions, workspaces, and the ' +
      'verbatim error head — plus, for the NEWEST episode, the exact billed usage of the 5h window that ' +
      'ENDED at the stall (Anthropic\'s own response-body numbers — "the combined requests that triggered ' +
      'the limit", measured not estimated) with investigate_burn\'s ranked culprit findings and verdict. ' +
      'Needs lifecycle hook capture (--install-hooks) for the events; says so honestly when absent. For an ' +
      'older episode, run investigate_burn with untilIso = that episode\'s startIso.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        windowHours: { type: 'number', description: 'Look-back for stall events (default 24, max 336)' },
        maxEpisodes: { type: 'number', description: 'Episodes returned, newest first (default 5)' },
        maxFiles:    { type: 'number', description: 'Body-scan cap for the deep attribution (default 400)' },
      },
    },
  },
  {
    name: 'investigate_burn',
    description:
      'ONE-COMMAND window-burn investigation — "my 5h window drained: what burned it and WHO?" answered in a ' +
      'single call, culprits named and ranked with evidence, no follow-up commands required (TRDD-TW14MO7A; ' +
      'born from an incident where root-causing took 15 manual calls and the first attribution was wrong). ' +
      'Scans the raw OTEL bodies for the window: billed usage comes EXACTLY from the response bodies ' +
      '(cache_creation/cache_read/output — Anthropic\'s own numbers, never estimated); attribution comes ' +
      'from the request bodies (workspace via deep Environment-block search — it sits AFTER the messages in ' +
      'fat transcripts, so shallow scans misattribute; model; first-message fingerprint to group fork ' +
      'families; base64-image sampling). Detects the measured burn taxonomy: FORK_STORM (fan-out forked a ' +
      'fat parent into a cold cache — clustered full-prefix writes with cache_read≈0 sharing ONE inherited ' +
      'transcript), SUBAGENT_BOOT_TAX (fresh agents each re-paying the CLAUDE.md+tools base), ' +
      'PREMIUM_MODEL_FANOUT (fan-out burst on a top-price model, e.g. after a /model default switch), ' +
      'FAT_SESSION_REWRITES (compaction/model-switch/TTL-gap full rewrites of one big session), ' +
      'IDLE_FLEET_KEEPWARM (background sessions kept cache-warm by periodic heartbeats), ' +
      'IMAGE_BLOB_RESIDENT (images riding forward every turn), RATE_LIMIT_COLD_RESUME (fan-out resumed ' +
      'into a TTL-expired cache right after a StopFailure — correlated with the lifecycle hook-event store ' +
      'when installed). Returns { window, coverage (files scanned vs present — cap hits are DISCLOSED), ' +
      'totals (byHour, byModel, est $), attribution (workspace×model×interactive/subagent), findings ' +
      '(ranked, each with equivTokens, share, confidence, evidence numbers), verdict (2-4 plain sentences ' +
      'naming the culprits — including how much of the window the detectors could NOT attribute). ' +
      'Drill deeper afterwards with get_session_burn_profile / get_cache_break_report / run_diagnostics_sql.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        windowHours: { type: 'number', description: 'Hours to look back (default 5 — one rate-limit window; max 48)' },
        untilIso:    { type: 'string', description: 'End of the window (ISO); default now. Use to investigate a past drain.' },
        maxFiles:    { type: 'number', description: 'Scan cap per body kind (default 8000; largest-first so the burn is never the part dropped)' },
      },
    },
  },
  {
    name: 'burn_seismic',
    description:
      'PROVEN statistical (seismology-style) anomaly analysis of a token burn — a reproducible ' +
      'MEASUREMENT with named, textbook methods, not a heuristic verdict. Reconstructs a per-minute COST ' +
      'series ($/min) from each turn\'s message.usage (cache_creation=cold WRITE, cache_read, output) × ' +
      'the real per-model rates (the single pricing source), streamed from the raw session JSONL by ' +
      'DuckDB (works with OTEL capture OFF; image-bloated lines skip, never abort). The NULL MODEL is the ' +
      'series\' true generative structure — a MARKED POINT PROCESS: cost/min = (Poisson turn count) × ' +
      '(lognormal per-turn cost) — measured against a LOCAL background: a CFAR reference window ' +
      '(Finn–Johnson 1968; trimmed-mean variant Gandhi–Kassam 1988) estimates every bucket\'s baseline from ' +
      'its own neighbourhood minus a guard band, so a day/night regime is not mistaken for an anomaly (one ' +
      'global background measured a 13.5% false-alarm share against a 5% target). Each factor gets its ' +
      'CORRECT tail: an exact Poisson RATE test (trimmed LOCAL background λ̂ₜ) and a robust lognormal ' +
      'INTENSITY test (log per-turn cost, local median, active buckets only), combined by Fisher\'s method ' +
      '(χ²₄ closed form; independent by Poisson thinning) — and that ' +
      'decomposition IS the root cause: FANOUT_RATE (many-turns burst = spawn storm), FAT_TURN_THRASH ' +
      '(cold-write dominated = prefix cold-invalidation), FAT_TURN_MARATHON (read dominated = fat-prefix ' +
      're-read), COMPOUND. Significance: Benjamini–Hochberg FDR (PRDS-valid; Benjamini–Yekutieli 2001) or ' +
      'the arbitrary-dependence BY variant, with a CALIBRATION self-check on the background buckets. ' +
      'Events = PELT changepoint segments (Killick 2012, exact penalized) containing FDR-significant ' +
      'buckets, ranked by EXCESS $ over baseline (not raw totals); STA/LTA (Allen 1978) + CUSUM (Page ' +
      '1954) ride as diagnostics. Distribution tails come from the `stochastic` DuckDB community ' +
      'extension when available (independent engine, cross-checked to Δ≤2e-16; disclosed), else the ' +
      'unit-tested internal core. Per event: per-session EXCESS attribution with COLD_REWRITE / ' +
      'MODEL_SWITCH cause tags, plus every SPAWN call inside the mainshock verbatim. Returns the ' +
      'structured result AND a rendered report; a window with no significant event says so, never ' +
      'fabricates one.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        scope:            { type: 'string', description: "'fleet' (default; all recent sessions), 'workspace' (one project), or 'session'" },
        workspace:        { type: 'string', description: "For scope='workspace': the project path (e.g. ~/Code/foo)" },
        sessionId:        { type: 'string', description: "For scope='session': the session id or a unique prefix" },
        windowHours:      { type: 'number', description: 'Hours to look back (default 8; max 72)' },
        bucketMinutes:    { type: 'number', description: 'Time-bin width in minutes (default 1)' },
        includeSubagents: { type: 'boolean', description: 'fleet/workspace: also scan subagent transcripts (default false — the spawners)' },
        fdrAlpha:         { type: 'number', description: 'False-discovery level for the combined test (default 0.01)' },
        fdrMethod:        { type: 'string', description: "'bh' (default; Benjamini–Hochberg, PRDS-valid) or 'by' (Benjamini–Yekutieli — guaranteed under arbitrary dependence, ~ln(m) conservative)" },
        pvalueEngine:     { type: 'string', description: "'auto' (default; use the stochastic extension if it loads), 'stochastic' (require it), 'internal' (TS core)" },
        rateLaw:          { type: 'string', description: "Count law for the RATE test: 'auto' (default — negative binomial where the local background is over-dispersed, exact Poisson elsewhere) or 'poisson' (FORCE variance ≡ mean; reproduces the pre-NB false-alarm rate — a falsifier, not a tuning knob)" },
        cfarReference:    { type: 'number', description: 'LOCAL-background reference cells per side (default 120 = ±2h at 1-min buckets). 0 = one GLOBAL stationary background (v2.13 behaviour) — set it to A/B the effect' },
        cfarGuard:        { type: 'number', description: 'Guard cells per side excluded from each local background so an event cannot set its own baseline (default 15)' },
        cfarTrim:         { type: 'number', description: 'Trim fraction per tail of the local reference sample (default 0.25) — an interfering burst under that share is trimmed out of the background' },
        cfarMinReference: { type: 'number', description: 'Minimum reference cells before a local estimate is trusted; below it that bucket falls back to global (default 30, disclosed as localBaseline.fallbackShare)' },
        maxFiles:         { type: 'number', description: 'Cap on transcripts scanned, most-recent first (default 300)' },
      },
    },
  },
  {
    name: 'get_heartbeat_cost',
    description:
      'The EXACT token + dollar cost of ONE janitor heartbeat fire, end to end — built for the janitor to ' +
      'call after each fire. "The fire" = every API call in the heartbeat\'s session from the moment the ' +
      'cron injected its prompt until the next fire, so it INCLUDES everything the heartbeat causes: the ' +
      'dispatcher-stub turn, hook/security injections, skills it loads, logs it reads, and the SUB-AGENTS ' +
      'it spawns (sub-agent calls carry the parent session_id, so they are captured automatically; they ' +
      'also show up as a distinct tool-count in callsByToolSurface, and Agent/Task spawns are counted). ' +
      'Returns the four buckets separately — input, output, cache_read, cache_write (+ ephemeral 5m/1h) — ' +
      'with per-bucket dollars that sum to the total, plus per-model rows. ' +
      'IMPORTANT — the default `fire: "last-complete"` is a hard constraint, not a preference: a request ' +
      'body carries NO request_id, so a call\'s usage is only knowable once the NEXT call is written ' +
      '(chain: response(i).id == request(i+1).previous_message_id). A command running INSIDE the ' +
      'heartbeat\'s own turn therefore cannot see that turn\'s final response. So it reports the last fire ' +
      'whose calls have all settled (at a 5-min cadence: fire N reports exactly what fire N-1 cost) and ' +
      'discloses any unsettled calls under `inFlight` rather than silently under-counting. Calls from ' +
      'OTHER sessions overlapping the fire are reported under `concurrent`, never folded in. POINTER-ONLY.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        marker:    { type: 'string', description: 'Prompt prefix that identifies a fire (default "[janitor-heartbeat]") — the first call of a fire is the one whose LAST user message starts with it' },
        sessionId: { type: 'string', description: 'Restrict to one session (full id or prefix); omit to use whichever session most recently fired the marker' },
        window:    { type: 'number', description: 'Only scan bodies from the last N hours (default 3)' },
        fire:      { type: 'string', description: '"last-complete" (default, exact) | "current" (newest fire; its tail may be unsettled and excluded — see inFlight)' },
      },
    },
  },
  {
    name: 'get_session_burn_profile',
    description:
      'ONE-CALL diagnosis of "why is THIS session burning my window?" — replaces the four ad-hoc probes ' +
      '(call sequence, gap histogram, tool-surface breakdown, is-it-still-running) with a single ' +
      'server-side answer, because each probe would otherwise cost an agent turn (and a turn re-reads ' +
      'the whole transcript). Measures the cost model cost ≈ turns × context_size and separates the two ' +
      'independently-fixable sub-terms: (1) the TOOL SURFACE — every tool definition sits at the TOP of ' +
      'the cached prefix and is re-sent every turn, broken down by SOURCE (built-in vs each MCP server, ' +
      'with tok/turn and how many are `deferred`) so you know exactly which server to remove; and (2) the ' +
      'TRANSCRIPT — everything else, shrinkable only by compaction / a fresh session. Returns turns, ' +
      'turns-per-hour, a gap histogram (a loop shows as mass under 30s), Σ cache_read / Σ cache_create, ' +
      'avg context re-read per turn, COLD-call % (cacheRead=0 → the cache never warms → a trigger firing ' +
      'past the TTL), cost, top tool_use frequency (what it is doing), whether it is STILL ACTIVE, plus a ' +
      'one-line `verdict` and an ordered `remediation` list ranked by what actually dominates the cost ' +
      '(never by what is merely easy to change). Bounded + memory-safe (mtime window + size cap; exactly ' +
      'ONE body fully parsed). POINTER-ONLY: tool names, sizes, token counts — never schemas or message text.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string', description: 'Full session id or a unique prefix (e.g. "28e3a88d") — from get_burn_status / get_recent_sessions' },
        window:    { type: 'number', description: 'Only scan bodies from the last N hours (default 6)' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'get_cache_break_causes',
    description:
      'The cross-session PERPETRATOR backtrace — answers "what keeps breaking my cache, and WHO causes ' +
      'it?" over ALL sessions at once (get_cache_break_timeline is ONE session). The prompt-cache transcript ' +
      'is only ever the VICTIM: it re-writes as cache_creation whenever something ABOVE it in the prefix ' +
      '(tools/system/model) changes or a TTL expires. This tool runs the root-cause classifier across every ' +
      'session in the bounded scan and returns TWO ranked views: (1) `causeRanking` — the break causes ' +
      '(TOOL_SEARCH_DEFERRED, MCP_TOOLS_CHANGED, MODEL_SWITCH, HOOK_INJECTION, TTL_EXPIRY, COMPACTION, ' +
      'MESSAGE_TRIMMED, ATTACHMENT_CHANGED, plus the EXPECTED ones — COLD_START, NORMAL_GROWTH, ' +
      'SUBAGENT_INTERLEAVE — each row carrying an `expected` flag) ranked by wasted cache_creation, so ' +
      'you see the most common/expensive category; and (2) ' +
      '`actorLeaderboard` — the actual PERPETRATORS, backtraced from the enriched culprit id: the specific ' +
      'MCP server that toggled (chrome-devtools/lean-ctx/…), the specific hook that injected (pss-skills / ' +
      'janitor-memory / token-guard / …), the sub-agent MODEL that interleaved, or the harness ToolSearch ' +
      'churning its deferred built-ins — each with occurrences, sessionsAffected, cache_creation, cost, and ' +
      'a remediation. A one-line `verdict` names the dominant AVOIDABLE perpetrator (expected causes — ' +
      'cold warms, compaction, incremental growth, the interleave artifact — never win the verdict). ' +
      'POINTER-ONLY. Read `coverage` for the bounded scan scope.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        scope:     { type: 'string', description: 'Optional session-id prefix to restrict the scan to one session family; omit for all sessions' },
        minTokens: { type: 'number', description: 'Only classify turns whose cache_creation ≥ this (default 5000)' },
        window:    { type: 'number', description: 'Only scan bodies from the last N hours; omit for the bounded most-recent scan across all history' },
        topN:      { type: 'number', description: 'Cap on the actorLeaderboard (default 20, max 100); causeRanking is never truncated' },
      },
    },
  },
  {
    name: 'compare_configs',
    description:
      'Comparative cost/cache analytics across CONFIGURATIONS. Groups every API call (from the ' +
      'forensics fact DB, one row/call) by a config dimension and ranks the groups worst→best on a ' +
      'chosen metric, with per-group min/max/avg/median/p95/count/sum and a share of the total. Answers ' +
      "questions the per-session timeline can't: do FORKED agents consume less cache_creation than " +
      'FRESH subagents? do WORKTREE agents cost more? which model/effort/isolation/subagent_type breaks ' +
      'the cache least on average? which injected skill/mcp/rule co-occurs with the biggest writes? ' +
      'Reads a bounded, incrementally-indexed fact table — read `coverage` for scope and note the ' +
      'explicit `unresolved` spawn group (calls whose spawn config could not be resolved — never hidden). ' +
      'Correlation ≠ causation; drill a finding via trace_expensive_writes / get_cache_break_timeline / ' +
      'get_call_context on the shared session_id + request/response refs.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        groupBy:   { type: 'string', description: 'Config dimension: spawn_kind | model | effort | isolation | subagent_type | frontmatter | skill | mcp | rule | content_tag | break_cause | account | session (default spawn_kind)' },
        metric:    { type: 'string', description: 'cache_creation | cache_read | output_tokens | input_tokens | breaks | total | billable_weighted (default cache_creation)' },
        agg:       { type: 'string', description: 'Primary SORT aggregate: sum | avg | median | min | max | p95 | count (default avg). All of min/max/avg/median/p95/count/sum are ALWAYS returned per group; this only picks the sort key.' },
        filter:    { type: 'object', description: 'Optional narrowing: { window (hours), model, spawnKind, subagentType, effort, isolation, accountUuid, sessionId, minCacheCreate, minOutputTokens, breakCause, spawnResolution, hasContentTag:[…], hasSkill:[…], hasMcp:[…], hasRule:[…] }' },
        rankOrder: { type: 'string', description: 'worst-first (highest metric first, default) | best-first' },
        topN:      { type: 'number', description: 'How many ranked groups to return (default 20, max 100)' },
      },
    },
  },
  {
    name: 'run_diagnostics_sql',
    description:
      'Runs analytics over the forensics fact DB (one row/API call, plus content-tag and injection ' +
      'junction tables). Two modes: (1) `preset` — a curated, parameterized read-only query from the ' +
      'built-in library (worst configs, fork-vs-fresh, worktree cost delta, chronic offenders, output ' +
      'peaks by skill, cache lift by skill/mcp/rule, content-tag ranking, image burn, model×effort ' +
      'matrix, break-cause ranking, root-cause leaderboard, unresolved audit, session hotlist, tier ' +
      'split by config); (2) `sql` — RAW read-only SELECT/WITH with cost-aware custom functions ' +
      'billable_weight(), tier_classify(), cost_usd(), spike(). READ-ONLY & SANDBOXED: single SELECT/WITH ' +
      'only; INSERT/UPDATE/DELETE/DDL/ATTACH/PRAGMA rejected; runs on a fresh in-memory snapshot (source ' +
      'data untouchable); row-capped. Use it to pivot from an aggregate finding to the exact culprit ' +
      'calls (whose response_ref/request_ref feed trace_expensive_writes / get_call_context).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        preset: { type: 'string', description: 'Name of a built-in preset (mutually exclusive with sql). Omit both to list the preset library.' },
        sql:    { type: 'string', description: 'Raw read-only SQL (single SELECT or WITH…SELECT). Custom fns: billable_weight(cc5m,cc1h,cread,out,input,model), tier_classify(gap_minutes), cost_usd(input,cread,cwrite,out,model), spike(value,median,mult).' },
        params: { type: 'object', description: 'Named params bound safely into a preset or sql (e.g. window, sessionId, model, k). Never string-concatenated.' },
        format: { type: 'string', description: 'json (default, includes raw rows) | table (unicode-bordered, no raw rows) | markdown (no raw rows) — table/markdown carry the same data as one compact rendered string instead of doubling it' },
        limit:  { type: 'number', description: 'Row cap (default 50, hard max 2000). Wide TEXT/JSON cells are truncated at 500 chars with a marker; raise limit explicitly for a bigger pull.' },
      },
    },
  },
  {
    name: 'run_transcript_sql',
    description:
      'Ad-hoc SQL (DuckDB) DIRECTLY over the Claude session .jsonl transcripts — answers cost/cause/' +
      'content questions no hand-written drill covers, e.g. "which records carry usage.cache_creation ' +
      'over N", "what record types exist", "group output tokens by model". The bounded file set ' +
      '(sessionId fast path, else an mtime window, default 24h) is exposed as ONE relation named ' +
      '`transcripts` (union_by_name over heterogeneous records; live still-growing files tolerated; ' +
      '`filename` column identifies the source). Two modes: `preset` (frozen library — omit both ' +
      'preset and sql to list it) or `sql` (read-only single SELECT/WITH; DDL/DML/ATTACH/PRAGMA ' +
      'rejected). Every result carries a coverage block naming exactly which files were queried. ' +
      'NOT a replacement for the session cards/drills — an analysis surface beside them.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        preset:      { type: 'string', description: 'Name of a built-in preset (mutually exclusive with sql). Omit both to list the library.' },
        sql:         { type: 'string', description: "Raw read-only SQL over the `transcripts` view (single SELECT or WITH…SELECT). Quote camelCase columns: \"sessionId\", \"timestamp\"." },
        sessionId:   { type: 'string', description: 'Query exactly this session transcript (fast path — one file; the window does not apply).' },
        window:      { type: 'number', description: 'Only transcripts modified in the last N hours feed the view (default 24). Ignored with sessionId.' },
        limit:       { type: 'number', description: 'Row cap (default 50, hard max 2000). A hit cap is reported in coverage, never silent.' },
      },
    },
  },
  {
    name: 'get_cache_event_log',
    description:
      'The per-call CACHE LEDGER for ONE project — answers "did that compaction / command / turn burn ' +
      'tokens on a cache miss?" in a single call. One row per API call with every bucket spelled out ' +
      '(input tokens, cache write, cache read, output tokens), its cache-write TTL tier (1-hour = main ' +
      'conversation on a subscription; 5-minute = a subagent or a usage-credits session), the ' +
      'cost-weighted size in INPUT-EQUIVALENT tokens, and the exact USD. Cache writes are flagged with ' +
      'a 🔥 marker repeated 1-5 times by order of magnitude (1+ / 10k+ / 50k+ / 150k+ / 400k+), so a ' +
      'full-prefix rewrite never looks like a routine suffix write. mode=peak (default) centres the ' +
      'costliest call in the window and shows the `context` calls BEFORE and AFTER it — a cold write is ' +
      'only interpretable next to the warm turns around it; mode=recent lists the last `limit` calls ' +
      'regardless of cost. SCOPED TO ONE PROJECT BY DEFAULT: rows are emitted only for sessions this ' +
      'project owns (resolved via ~/.claude/projects/<slug>/<sessionId>.jsonl); calls belonging to any ' +
      'other project, or not attributable to a session, are counted in `excluded` and never printed. ' +
      'Pass `project` (an absolute path or a project slug) to read a different project. Reads the OTEL ' +
      'response bodies, not the session transcript — a compaction\'s own summarization call exists ONLY ' +
      'there, so from the transcript a compaction looks free.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        mode:      { type: 'string', description: 'peak (default) = the costliest call in the window plus its surrounding calls | recent = the last `limit` calls regardless of cost' },
        project:   { type: 'string', description: 'Absolute project path or Claude project slug. Defaults to the calling working directory — NEVER to all projects.' },
        sessionId: { type: 'string', description: 'Narrow to one session inside the project (default: every session the project owns)' },
        context:   { type: 'number', description: 'How many calls to show before AND after the peak (default 3, max 25). mode=peak only.' },
        limit:     { type: 'number', description: 'How many recent calls to list (default 12, max 200). mode=recent only.' },
        window:    { type: 'number', description: 'Only calls from the last N hours; omit for the bounded most-recent scan' },
        format:    { type: 'string', description: 'table (default) | json | markdown' },
      },
    },
  },
  {
    name: 'get_subscription_usage',
    description:
      'The AUTHORITATIVE 5-hour and 7-day rate-limit window utilization — Anthropic\'s own numbers, ' +
      'the same ones `/usage` renders, not a local projection. Every other window tool here INFERS ' +
      'the cap (capacityCalibration derives a lower bound from observed rate-limit hits, and reports ' +
      'no ETA at all when uncalibrated); this reads the real percentage. Returns the generic ' +
      '`limits[]` array — `{kind, group, percent, severity, resetsAt, isActive, scopeLabel}` with ' +
      'kinds `session` / `weekly_all` / `weekly_scoped` (a per-model bucket) — rather than only the ' +
      'two named windows, because the payload already carries buckets that named-field parsing drops. ' +
      'Also reports `usageCreditsEnabled`, which is the live oracle for the prompt-cache TTL regime: ' +
      'credits OFF = the automatic 1-hour TTL (so main-conversation cache writes bill at 2x base ' +
      'input); credits ON = the TTL drops to 5 minutes (1.25x). Reads the OAuth token Claude Code ' +
      'already stores — the credentials file first, then the macOS keychain, and the keychain path is ' +
      'OPT-IN via AGENTLENS_READ_KEYCHAIN_USAGE=1 because an un-ACL\'d read pops a password prompt. ' +
      'The endpoint is UNDOCUMENTED and community-reverse-engineered, and it 429s hard — results are ' +
      'cached for 10 minutes and a 429 arms an escalating back-off, so `force` is for a deliberate ' +
      'one-off refresh, never a loop. Every failure degrades to the last known reading with an ' +
      'explicit `reason` (cooldown / no_token / opt_in_required / lock_contended / http_error), and a ' +
      'stale reading suppresses its reset countdowns rather than rendering a rolled window as live.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        force:  { type: 'boolean', description: 'Bypass the 10-minute cache and refetch now. Respects an active 429 back-off.' },
        format: { type: 'string', description: 'table (default) | json' },
      },
    },
  },
]

// ── Tool handlers ─────────────────────────────────────────────────────────────

// A session is "active" when its last activity is within this window — bounded by the OTEL
// span-store heartbeat cadence, so a session still emitting spans always qualifies.
const ACTIVE_WINDOW_MS = 5 * 60_000

// Exported for unit tests (TRDD-RS3NGN53 — ranking must be by last ACTIVITY, provable).
export function handleGetRecentSessions(
  sessions: SessionSummaryCard[],
  args: { limit?: number; agent?: string; workspace?: string },
) {
  let filtered = sessions
  if (args.agent)     filtered = filtered.filter(s => s.source === args.agent)
  if (args.workspace) filtered = filtered.filter(s => s.sessionId.includes(args.workspace!) || (s.userRequest ?? '').includes(args.workspace!))
  const limit = Math.min(args.limit ?? 10, 50)
  // "Recent" means recently ACTIVE, not recently STARTED (TRDD-RS3NGN53): the caller's list is
  // start-date-ordered, which buried long-running sessions still emitting spans NOW below fresh
  // idle ones (live-confirmed: 4 actively-emitting sessions missing from the default top-10).
  // Never trust caller order — re-rank on start + duration here, the one place it matters.
  const lastActiveMs = (s: SessionSummaryCard): number => (Date.parse(s.startTime) || 0) + (s.durationMs || 0)
  const now = Date.now()
  const top = [...filtered].sort((a, b) => lastActiveMs(b) - lastActiveMs(a)).slice(0, limit)
  return top.map(s => ({
    sessionId:   s.sessionId,
    date:        s.startTime.slice(0, 16).replace('T', ' '),
    lastActive:  new Date(lastActiveMs(s)).toISOString().slice(0, 16).replace('T', ' '),
    // Rides only on live sessions — absent means idle, never a false.
    ...(now - lastActiveMs(s) < ACTIVE_WINDOW_MS ? { active: true as const } : {}),
    // Transcript-signal enrichment (TRDD-B22NYTOY P4) — absent when the transcript carries none.
    ...(s.title ? { title: s.title } : {}),
    ...(s.entrypoint ? { entrypoint: s.entrypoint } : {}),
    agent:       s.source,
    model:       s.model,
    prompt:      s.userRequest ? s.userRequest.slice(0, 120) + (s.userRequest.length > 120 ? '…' : '') : null,
    turns:       s.totalLlmCalls,
    cost_usd:    +sessionCost(s).toFixed(4),
    durationMin: +(s.durationMs / 60000).toFixed(1),
    errors:      s.errors,
    // P7 provenance — which feed backs this row's token/cost figures; null = pre-P7 card
    // ("unknown"), never a backfilled guess. coverageNote rides only when a decision set it.
    tokensSource: s.tokensSource ?? null,
    ...(s.coverageNote ? { coverageNote: s.coverageNote } : {}),
    topTools:    Object.entries(s.toolCounts ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t, n]) => `${t}×${n}`),
    loopSignals: (s.loopSignals ?? []).map(l => l.type),
    filesChanged: s.filesChanged?.slice(0, 5) ?? [],
  }))
}

// Exported for unit tests (TRDD-ZK37VG4X spec 3 — junk rows must not dilute the cache SLI).
export function handleGetWorkspacePatterns(
  sessions: SessionSummaryCard[],
  args: { workspace?: string; days?: number },
) {
  let filtered = sessions
  if (args.days) {
    const cutoff = Date.now() - args.days * 86_400_000
    filtered = filtered.filter(s => Date.parse(s.startTime) >= cutoff)
  }
  if (filtered.length === 0) return { message: 'No sessions found matching the filters.' }

  // File frequency
  const fileFreq = new Map<string, number>()
  for (const s of filtered) {
    for (const f of [...(s.filesRead ?? []), ...(s.filesChanged ?? [])]) {
      fileFreq.set(f, (fileFreq.get(f) ?? 0) + 1)
    }
  }
  const hotFiles = [...fileFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([file, count]) => ({ file, sessions: count, pct: Math.round(count / filtered.length * 100) }))

  // Tool frequency
  const toolFreq = new Map<string, number>()
  for (const s of filtered) {
    for (const [t, n] of Object.entries(s.toolCounts ?? {})) {
      toolFreq.set(t, (toolFreq.get(t) ?? 0) + n)
    }
  }
  const topTools = [...toolFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([tool, total]) => ({ tool, total }))

  // Loop signal frequency
  const signalFreq = new Map<string, number>()
  for (const s of filtered) {
    for (const sig of s.loopSignals ?? []) {
      signalFreq.set(sig.type, (signalFreq.get(sig.type) ?? 0) + 1)
    }
  }
  const loopSignals = [...signalFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => ({ type, count }))

  // Averages. The cache-hit SLI averages ONLY cache-measured sessions — junk rows (0 tokens /
  // no LLM calls) all read 0% and would dilute it toward 0 without any billing behind them.
  const totalCost  = filtered.reduce((s, sess) => s + sessionCost(sess), 0)
  const totalTurns = filtered.reduce((s, sess) => s + sess.totalLlmCalls, 0)
  const cacheMeasured = filtered.filter(isCacheMeasured)
  const totalCache = cacheMeasured.reduce((s, sess) => s + sess.cacheHitRate, 0)
  const errorSess  = filtered.filter(s => s.errors > 0).length

  // Agent/model breakdown
  const agentMap = new Map<string, { sessions: number; cost: number; turns: number }>()
  for (const s of filtered) {
    const key = `${s.source}/${s.model}`
    const e = agentMap.get(key) ?? { sessions: 0, cost: 0, turns: 0 }
    e.sessions++; e.cost += sessionCost(s); e.turns += s.totalLlmCalls
    agentMap.set(key, e)
  }
  const agentBreakdown = [...agentMap.entries()]
    .sort((a, b) => b[1].sessions - a[1].sessions)
    .slice(0, 6)
    .map(([key, v]) => ({ agentModel: key, sessions: v.sessions, avgCost: +(v.cost / v.sessions).toFixed(4), avgTurns: +(v.turns / v.sessions).toFixed(1) }))

  return {
    sessionCount:    filtered.length,
    avgCostUsd:      +(totalCost / filtered.length).toFixed(4),
    avgTurns:        +(totalTurns / filtered.length).toFixed(1),
    avgCacheHitRate: cacheMeasured.length > 0 ? +(totalCache / cacheMeasured.length * 100).toFixed(0) + '%' : 'n/a',
    // Exclusion is labeled, never silent: how many sessions actually back the cache SLI.
    cacheMeasuredSessions: cacheMeasured.length,
    cacheExcludedJunkSessions: filtered.length - cacheMeasured.length,
    errorRate:       Math.round(errorSess / filtered.length * 100) + '%',
    hotFiles,
    topTools,
    loopSignals,
    agentBreakdown,
  }
}

function handleGetSessionDetail(
  sessions: SessionSummaryCard[],
  getTimeline: ((id: string) => unknown[]) | null,
  composition: ContextComposition | null,
  args: { sessionId: string },
) {
  const s = sessions.find(x => x.sessionId === args.sessionId)
  if (!s) return { error: `Session ${args.sessionId} not found.` }

  const timeline = asTimeline(getTimeline, s.sessionId, s)
  const growth = computeTurnGrowth(timeline)
  const children = subAgentChildren(sessions, s.sessionId)
  return {
    sessionId:    s.sessionId,
    date:         s.startTime.slice(0, 19).replace('T', ' '),
    agent:        s.source,
    model:        s.model,
    prompt:       s.userRequest || null,
    cost_usd:     +sessionCost(s).toFixed(4),
    turns:        s.totalLlmCalls,
    errors:       s.errors,
    outcome:      s.outcome,
    // P4: cache accounting so a consumer can see cache health without a second call.
    cacheReadTokens:   s.cacheReadTokens,
    cacheCreateTokens: s.cacheCreateTokens,
    cacheHitRatePct:   Math.round(s.cacheHitRate * 100),
    peakContextPerTurn: s.peakContextPerTurn ?? null,
    // P4: per-turn cache-READ vs cache-CREATED split (capped) — the "what ballooned" view inline.
    perTurnCacheSplit: growth.slice(0, 60).map(g => ({
      turn: g.turn, prompt: g.promptTokens, cacheRead: g.cacheReadTokens,
      cacheCreated: g.cacheCreateTokens, newInput: g.newInputTokens, hitPct: g.hitRatePct,
    })),
    // P4: what occupied the context, aggregated heaviest-first (null when no local composition).
    compositionSummary: composition
      ? aggregateComposition(composition).slice(0, 12).map(a => ({
          label: a.label, kind: a.kind, cumulativeTokens: a.cumulativeTokens, turnsPresent: a.turnsPresent,
        }))
      : null,
    // P4: sub-agent children rolled up (spawn-kind, warmth, tokens) — null when none.
    subAgents: children.length > 0 ? children : null,
    loopSignals:  s.loopSignals ?? [],
    filesRead:    s.filesRead ?? [],
    filesChanged: s.filesChanged ?? [],
    toolCounts:   s.toolCounts,
    // Output-file / subfolder tracking (TRDD-ZS1GDXVY): a compact summary of the files this session
    // wrote under its scratch tree — total count + top-5 by size — so an MCP consumer sees the
    // generated artifacts without fetching each. Combines the session-level group with per-tool leaves.
    generatedFiles: summarizeGeneratedFiles(s, timeline),
    timeline:     timeline
      .slice(0, 80)
      .map(e => ({ type: e.type, label: e.label, ms: e.durationMs, error: e.isError || false })),
  }
}

// Compact generatedFiles summary for get_session_detail: count + top-5 by size (path/size/tokens).
// null when the session produced none. Dedupes across the session-level group + per-tool-call leaves.
function summarizeGeneratedFiles(s: SessionSummaryCard, timeline: TimelineEntry[]) {
  const byPath = new Map<string, { path: string; sizeBytes: number; tokenEstimate: number }>()
  const add = (gf: { path: string; sizeBytes: number; tokenEstimate: number }) => {
    if (!byPath.has(gf.path)) byPath.set(gf.path, gf)
  }
  for (const gf of s.generatedFiles ?? []) add(gf)
  for (const e of timeline) for (const gf of e.generatedFiles ?? []) add(gf)
  if (byPath.size === 0) return null
  const all = [...byPath.values()].sort((a, b) => b.sizeBytes - a.sizeBytes)
  return {
    count: all.length,
    top: all.slice(0, 5).map(gf => ({ path: gf.path, sizeBytes: gf.sizeBytes, tokenEstimate: gf.tokenEstimate })),
  }
}

function handleFindRelevantContext(
  sessions: SessionSummaryCard[],
  args: { task: string; workspace?: string },
) {
  const taskWords = new Set(
    args.task.toLowerCase().replace(/[^a-z0-9\s/_.]/g, ' ').split(/\s+/).filter(w => w.length > 3)
  )
  if (taskWords.size === 0) return { message: 'Task description too short to match against history.' }

  // Score each session by word overlap with the task description
  const scored = sessions.map(s => {
    const req = (s.userRequest ?? '').toLowerCase()
    const overlap = [...taskWords].filter(w => req.includes(w)).length
    return { s, score: overlap }
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score)

  const similar = scored.slice(0, 15).map(x => x.s)
  if (similar.length === 0) return { message: 'No past sessions closely match this task description. No history to draw from yet.' }

  // Aggregate files from similar sessions
  const fileFreq = new Map<string, number>()
  for (const s of similar) {
    for (const f of [...(s.filesRead ?? []), ...(s.filesChanged ?? [])]) {
      fileFreq.set(f, (fileFreq.get(f) ?? 0) + 1)
    }
  }
  const relevantFiles = [...fileFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([file, count]) => ({ file, appearsIn: count, pct: Math.round(count / similar.length * 100) }))

  // Cost and turn estimates
  const costs  = similar.map(s => sessionCost(s))
  const turns  = similar.map(s => s.totalLlmCalls)
  const minC   = +Math.min(...costs).toFixed(3), maxC = +Math.max(...costs).toFixed(3)
  const avgC   = +(costs.reduce((a, b) => a + b, 0) / costs.length).toFixed(3)
  const avgT   = +(turns.reduce((a, b) => a + b, 0) / turns.length).toFixed(1)

  // Common loop signals in similar sessions
  const sigFreq = new Map<string, number>()
  for (const s of similar) {
    for (const sig of s.loopSignals ?? []) {
      sigFreq.set(sig.type, (sigFreq.get(sig.type) ?? 0) + 1)
    }
  }
  const knownTraps = [...sigFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([type, count]) => `${type} (${count}/${similar.length} similar sessions)`)

  return {
    matchedSessions: similar.length,
    estimatedCostUsd: { min: minC, avg: avgC, max: maxC },
    estimatedTurns:   avgT,
    relevantFiles,
    knownTraps: knownTraps.length > 0 ? knownTraps : null,
    tip: relevantFiles.length > 0
      ? `Consider mentioning these files upfront: ${relevantFiles.slice(0, 3).map(f => f.file).join(', ')}`
      : null,
  }
}

// Exported for unit tests (TRDD-ZK37VG4X spec 3 — junk rows must not dilute the cache SLI).
export function handleGetEfficiencyReport(
  sessions: SessionSummaryCard[],
  args: { workspace?: string; days?: number },
) {
  const cutoffDays = args.days ?? 30
  const cutoff = Date.now() - cutoffDays * 86_400_000
  const recent = sessions.filter(s => Date.parse(s.startTime) >= cutoff)
  if (recent.length === 0) return { message: `No sessions in the last ${cutoffDays} days.` }

  // Week-over-week cost trend (split into two halves)
  const mid = Date.now() - (cutoffDays / 2) * 86_400_000
  const firstHalf  = recent.filter(s => Date.parse(s.startTime) < mid)
  const secondHalf = recent.filter(s => Date.parse(s.startTime) >= mid)
  const avgFirst  = firstHalf.length  > 0 ? firstHalf.reduce((s, x)  => s + sessionCost(x), 0) / firstHalf.length  : 0
  const avgSecond = secondHalf.length > 0 ? secondHalf.reduce((s, x) => s + sessionCost(x), 0) / secondHalf.length : 0
  const trend = avgFirst === 0 ? 'no data'
    : avgSecond > avgFirst * 1.15 ? 'increasing ↑'
    : avgSecond < avgFirst * 0.85 ? 'decreasing ↓'
    : 'stable →'

  // Loop signal totals
  const sigFreq = new Map<string, number>()
  for (const s of recent) {
    for (const sig of s.loopSignals ?? []) {
      sigFreq.set(sig.type, (sigFreq.get(sig.type) ?? 0) + 1)
    }
  }
  const topSignals = [...sigFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => ({ type, count, rate: Math.round(count / recent.length * 100) + '%' }))

  // Best agent/model combos by cost efficiency
  const agentMap = new Map<string, { n: number; totalCost: number; totalTurns: number; errors: number }>()
  for (const s of recent) {
    const key = `${s.source}/${s.model || 'unknown'}`
    const e = agentMap.get(key) ?? { n: 0, totalCost: 0, totalTurns: 0, errors: 0 }
    e.n++; e.totalCost += sessionCost(s); e.totalTurns += s.totalLlmCalls; e.errors += s.errors
    agentMap.set(key, e)
  }
  const agentRanking = [...agentMap.entries()]
    .filter(([, v]) => v.n >= 2)
    .map(([key, v]) => ({
      agentModel: key, sessions: v.n,
      avgCostUsd: +(v.totalCost / v.n).toFixed(4),
      avgTurns:   +(v.totalTurns / v.n).toFixed(1),
      errorRate:  Math.round(v.errors / v.n * 100) + '%',
    }))
    .sort((a, b) => a.avgCostUsd - b.avgCostUsd)

  // P4: cache-health SLI. A low hit rate means the prompt cache is being re-written (cache_creation
  // billed at full rate instead of ~10% cache_read) — the dominant, invisible token sink.
  // Junk rows (0 tokens / no LLM calls) are excluded-but-counted: they all read 0% and would both
  // dilute the average AND monopolize worstSessions with rows that never billed anything.
  const measured = recent.filter(isCacheMeasured)
  const avgHit = measured.length > 0 ? measured.reduce((s, x) => s + x.cacheHitRate, 0) / measured.length : 0
  const below70 = measured.filter(s => s.cacheHitRate < 0.7)
  const worstCache = [...measured]
    .sort((a, b) => a.cacheHitRate - b.cacheHitRate)
    .slice(0, 5)
    .map(s => ({ sessionId: s.sessionId, model: s.model, cacheHitRatePct: Math.round(s.cacheHitRate * 100), cacheCreateTokens: s.cacheCreateTokens }))

  return {
    period:       `last ${cutoffDays} days`,
    sessionCount: recent.length,
    costTrend:    trend,
    avgCostUsd:   +(recent.reduce((s, x) => s + sessionCost(x), 0) / recent.length).toFixed(4),
    avgTurns:     +(recent.reduce((s, x) => s + x.totalLlmCalls, 0) / recent.length).toFixed(1),
    errorRate:    Math.round(recent.filter(s => s.errors > 0).length / recent.length * 100) + '%',
    cacheHealth: {
      avgCacheHitRatePct: measured.length > 0 ? Math.round(avgHit * 100) : null,
      measuredSessions:   measured.length,
      excludedJunkSessions: recent.length - measured.length,  // 0-token / no-LLM-call rows — excluded, labeled
      sessionsBelow70pct: below70.length,
      worstSessions:      worstCache,
    },
    topLoopSignals: topSignals,
    agentRanking,
  }
}

function handleGetInstructionSuggestions(
  sessions: SessionSummaryCard[],
  args: { workspace?: string },
) {
  const workspace = args.workspace?.trim()
  if (!workspace) {
    return { error: 'workspace is required — instruction suggestions are project-scoped.' }
  }
  const filtered = sessions.filter(s => (s.workspace ?? '') === workspace || s.workspace?.startsWith(workspace))
  if (filtered.length < 5) {
    return { message: `Not enough history for workspace "${workspace}" (${filtered.length} sessions, need 5).`, suggestions: [] }
  }
  const existingText = readAllInstructionContent(workspace)
  const suggestions = generateSuggestions(filtered, existingText)
  const out = suggestions.map(s => ({
    id:            s.id,
    category:      s.category as string,
    title:         s.title,
    evidence:      s.evidence,
    suggestedText: s.suggestedText,
    targetAgents:  s.targetAgents as string[],
    priority:      s.priority as string,
  }))

  // P4: a data-driven cache-efficiency suggestion when the workspace's prompt cache is under-used.
  // Low hit rate → the cache is re-written every turn at full write rate; the fix is instruction-level
  // (avoid mid-session tool/model churn + volatile per-turn injections).
  // Same junk-row exclusion as the efficiency-report SLI (spec 3): only cache-measured sessions
  // back the average, and the suggestion needs ≥5 of them so a handful of real sessions among a
  // pile of synthetic empties can't trigger (or suppress) it.
  const cacheMeasured = filtered.filter(isCacheMeasured)
  const avgHit = cacheMeasured.length > 0 ? cacheMeasured.reduce((a, s) => a + s.cacheHitRate, 0) / cacheMeasured.length : 1
  if (cacheMeasured.length >= 5 && avgHit < 0.8) {
    out.push({
      id:            'cache-efficiency',
      category:      'behavior',
      title:         'Improve prompt-cache hit rate',
      evidence:      `Average cache-hit rate across ${cacheMeasured.length} cache-measured sessions is ${Math.round(avgHit * 100)}% (target ≥ 80%). A low hit rate re-bills the prompt prefix as cache_creation at full write rate.`,
      suggestedText: 'Avoid mid-session tool-set changes, model switches, and volatile per-turn injections (they break the prefix cache). Run get_cache_break_report for the specific offending blocks and remediations.',
      targetAgents:  [],
      priority:      'medium',
    })
  }
  return out
}

// ── P4 diagnostics: shared helpers (TRDD-TKN5VALS) ────────────────────────────

// getTimeline returns unknown[]; narrow it to TimelineEntry[] (falling back to the card's inline
// timeline when no accessor is wired). The shapes match — the accessor IS a TimelineEntry source.
function asTimeline(getTimeline: ((id: string) => unknown[]) | null, id: string, card?: SessionSummaryCard): TimelineEntry[] {
  const raw = getTimeline ? getTimeline(id) : (card?.timeline ?? [])
  return raw as TimelineEntry[]
}

// ── check_cache_expiry (TRDD-OCNHOHE9) ────────────────────────────────────────
// Is a session past its prompt-cache TTL? Finds each target's last LLM-request time, classifies
// its per-session TTL regime, and reports fresh/expired/unknown via the pure assessCacheExpiry.
type CacheExpiryRow = CacheExpiryVerdict & {
  sessionId: string
  workspace: string
  kind: string
  /** ISO of the last LLM request the idle was measured from, or null when none was recorded. */
  lastRequestAt: string | null
}

// The freshest billed call. api_request entries are the ground-truth LLM calls; 'llm' spans are a
// fallback for OTEL-only cards that predate log correlation. NaN timestamps are skipped, not zeroed.
function lastLlmRequestMs(timeline: TimelineEntry[]): number | null {
  let best: number | null = null
  for (const e of timeline) {
    if (e.type !== 'api_request' && e.type !== 'llm') continue
    const ms = Date.parse(e.timestamp)
    if (!Number.isNaN(ms) && (best === null || ms > best)) best = ms
  }
  return best
}

function assessOneSession(
  card: SessionSummaryCard,
  getTimeline: ((id: string) => unknown[]) | null,
  ctx: TtlContext | null,
  nowMs: number,
  thresholdMs?: number,
): CacheExpiryRow {
  const lastMs = lastLlmRequestMs(asTimeline(getTimeline, card.sessionId, card))
  const kind = sessionTtlKindOf(card)
  const verdict = assessCacheExpiry({ lastRequestAtMs: lastMs, nowMs, kind, ctx, thresholdMs })
  return {
    ...verdict,
    sessionId: card.sessionId,
    workspace: card.workspace,
    kind,
    lastRequestAt: lastMs === null ? null : new Date(lastMs).toISOString(),
  }
}

// How many newest-by-activity candidates the DEFAULT path reparses to find the caller's active
// conversation. Card-level lastActivityMs is metadata-cheap (no reparse), and an LLM request IS
// card activity — so the session with the newest last-LLM-request cannot rank below sessions with
// zero newer activity; the probe only disambiguates staleness among the leaders. Before this cap
// the default path reparsed EVERY main transcript synchronously (thousands after a restart, when
// all disk-restored cards are timeline-stripped) — the same wedge shape as the cost-by-cause
// flatMap (X2E6OSWK). Exported for the unit tests.
export const EXPIRY_NEWEST_PROBE = 12

/** Is this card's workspace AT or UNDER `root`? Path-boundary aware on purpose: a bare
 *  `startsWith` makes `/x/y` match the sibling `/x/y-old`, which is the same off-by-one-directory
 *  bug the SQL side guards with its `/%` pattern. Same shape as logReader's containment check. */
function workspaceUnder(workspace: string | undefined, root: string): boolean {
  if (!workspace) return false
  const w = workspace.replace(/\/+$/, '')
  const r = root.replace(/\/+$/, '')
  return w === r || w.startsWith(`${r}/`)
}

// Exported for unit tests (X2E6OSWK — bounded-scan behavior is pinned, not assumed).
export async function handleCheckCacheExpiry(
  sessions: SessionSummaryCard[],
  getTimeline: ((id: string) => unknown[]) | null,
  ctx: TtlContext | null,
  args: { sessionId?: string; all?: boolean; project?: string; thresholdMinutes?: number },
  timeBudgetMs: number = DRILL_SCAN_TIME_BUDGET_MS,
): Promise<{
  sessions: CacheExpiryRow[]
  scope?: { project: string | null; sessionsInScope: number }
  coverage?: { sessionsConsidered: number; sessionsScanned: number; stoppedEarly: boolean; note: string }
  note?: string
}> {
  const nowMs = Date.now()
  const thresholdMs =
    typeof args.thresholdMinutes === 'number' && args.thresholdMinutes > 0
      ? args.thresholdMinutes * 60_000
      : undefined

  if (args.sessionId) {
    const targets = sessions.filter(s => s.sessionId === args.sessionId)
    return { sessions: targets.map(c => assessOneSession(c, getTimeline, ctx, nowMs, thresholdMs)) }
  }

  // PROJECT SCOPE, and it is a correctness fix rather than a convenience. The default pick used to
  // be the newest main session MACHINE-WIDE, so a caller asking "has MY cache expired" from inside
  // one repo was answered about whichever repo happened to be busiest — measured live: a probe run
  // in AgentlensPro returned a session in an unrelated project, with nothing in the payload saying
  // so. Filtering here (not client-side) also spends the bounded probe budget on sessions that can
  // actually be the answer, which is what makes the pick reliable on a busy machine.
  // An explicit empty string is the documented opt-out: `project: ""` = machine-wide.
  const projectRoot = args.project?.trim() ? args.project.trim().replace(/\/+$/, '') : null
  const inScope = projectRoot === null
    ? sessions
    : sessions.filter(s => workspaceUnder(s.projectPath ?? s.workspace, projectRoot))
  const scope = { project: projectRoot, sessionsInScope: inScope.length }
  sessions = inScope

  if (args.all) {
    // Whole-corpus assessment, newest-activity first so the budget spends itself on the sessions a
    // caller actually cares about. Every card can trigger a synchronous transcript reparse, hence
    // the one-per-macrotask + deadline scan — the unbounded `sessions.map(assessOneSession)` this
    // replaced was a full wedge (O(corpus) synchronous work inline in one request).
    const pool = [...sessions].sort((a, b) => lastActivityMs(b) - lastActivityMs(a))
    const { results, scanned, stoppedEarly } =
      await scanWithBudget(pool, timeBudgetMs, c => assessOneSession(c, getTimeline, ctx, nowMs, thresholdMs))
    return {
      sessions: results,
      scope,
      coverage: {
        sessionsConsidered: pool.length,
        sessionsScanned: scanned.length,
        stoppedEarly,
        note: stoppedEarly
          ? `SAMPLE, not full coverage: the ${timeBudgetMs / 1000}s scan budget stopped after ` +
            `${scanned.length} of ${pool.length} sessions (newest-activity first; reparsed timelines ` +
            `are cached on their cards, so a retry widens coverage).`
          : `Complete coverage: all ${pool.length} sessions assessed.`,
      },
    }
  }

  // Default: the caller's active conversation — the newest MAIN session by its last LLM request
  // (agents rarely know their own sessionId). Fall back to any kind if there are no main cards.
  // BOUNDED: rank by card-metadata lastActivityMs (cheap), reparse ONLY the top candidates for the
  // precise last-request time — see EXPIRY_NEWEST_PROBE for why the probe cannot miss the true
  // newest session.
  const mains = sessions.filter(s => sessionTtlKindOf(s) === 'main')
  const pool = (mains.length > 0 ? mains : sessions)
    .sort((a, b) => lastActivityMs(b) - lastActivityMs(a))
    .slice(0, EXPIRY_NEWEST_PROBE)
  const { results, stoppedEarly } = await scanWithBudget(pool, timeBudgetMs, s => ({
    s,
    ms: lastLlmRequestMs(asTimeline(getTimeline, s.sessionId, s)) ?? Date.parse(s.startTime),
  }))
  let newest: SessionSummaryCard | null = null
  let newestMs = -1
  for (const { s, ms } of results) {
    if (!Number.isNaN(ms) && ms > newestMs) {
      newestMs = ms
      newest = s
    }
  }
  const targets = newest ? [newest] : []
  return {
    sessions: targets.map(c => assessOneSession(c, getTimeline, ctx, nowMs, thresholdMs)),
    scope,
    // Honest pick: a budget-stopped probe chose from a subset — say so instead of presenting the
    // pick as the corpus-wide newest.
    ...(stoppedEarly ? { note: 'Newest-session probe stopped early on the scan time budget — the pick is from the probed subset only.' } : {}),
  }
}

// Per-turn context size + cache split from a session timeline. Entries carry the FOUR DISJOINT
// buckets (entry.inputTokens is the raw uncached share since the 2026-07-10 normalization — see
// src/shared/tokenBuckets.ts), so promptTokens (the FULL prompt that turn) is derived as
// input + cacheRead + cacheCreation. Turn 1 warms cold; later turns should be almost entirely
// cache-read.
interface TurnGrowth {
  turn: number
  promptTokens: number
  cacheReadTokens: number
  cacheCreateTokens: number
  newInputTokens: number
  outputTokens: number
  hitRatePct: number
}

function computeTurnGrowth(timeline: TimelineEntry[]): TurnGrowth[] {
  const byTurn = new Map<number, { input: number; read: number; create: number; output: number }>()
  for (const e of timeline) {
    if (e.turn === undefined || e.type === 'background') continue
    let a = byTurn.get(e.turn)
    if (!a) { a = { input: 0, read: 0, create: 0, output: 0 }; byTurn.set(e.turn, a) }
    a.input  += e.inputTokens ?? 0
    a.read   += e.cacheReadTokens ?? 0
    a.create += e.cacheCreateTokens ?? 0
    a.output += e.outputTokens ?? 0
  }
  return [...byTurn.entries()].sort((x, y) => x[0] - y[0]).map(([turn, a]) => {
    const denom = a.read + a.create
    return {
      turn,
      promptTokens:      contextTokens({ inputTokens: a.input, cacheReadTokens: a.read, cacheCreateTokens: a.create }),
      cacheReadTokens:   a.read,
      cacheCreateTokens: a.create,
      newInputTokens:    a.input,
      outputTokens:      a.output,
      hitRatePct:        denom > 0 ? Math.round(a.read / denom * 100) : 0,
    }
  })
}

// One injected source aggregated across a composition's turns: the "turns × per-turn weight"
// inflation view. cumulativeTokens = Σ tokens over every turn the source appears in.
interface SourceAggregate {
  label: string
  kind: string
  cumulativeTokens: number
  turnsPresent: number
  peakTokens: number
}

function aggregateComposition(composition: ContextComposition): SourceAggregate[] {
  const byKey = new Map<string, SourceAggregate>()
  for (const t of composition.turns) {
    for (const s of t.sources) {
      const key = `${s.kind}::${s.label}`
      const a = byKey.get(key) ?? { label: s.label, kind: s.kind, cumulativeTokens: 0, turnsPresent: 0, peakTokens: 0 }
      a.cumulativeTokens += s.tokens
      a.turnsPresent += 1
      a.peakTokens = Math.max(a.peakTokens, s.tokens)
      byKey.set(key, a)
    }
  }
  return [...byKey.values()].sort((a, b) => b.cumulativeTokens - a.cumulativeTokens)
}

// Direct sub-agent children of a session, rolled up for the tree view. fork = cache-warm (reads the
// parent's cache); fresh / worktree / fleet = cache-cold.
function subAgentChildren(sessions: SessionSummaryCard[], parentId: string) {
  return sessions
    .filter(s => s.parentSessionId === parentId)
    .map(c => ({
      sessionId:     c.sessionId,
      spawnedByTurn: c.spawnedByTurn ?? null,
      spawnKind:     c.spawnKind ?? 'fresh',
      warm:          c.spawnKind === 'fork',
      model:         c.spawnModelOverride || c.model,
      modelOverride: c.spawnModelOverride ?? null,
      isolation:     c.spawnIsolation ?? null,
      totalTokens:   c.inputTokens + c.outputTokens,
      cost_usd:      +sessionCost(c).toFixed(4),
      // Async launches never report tokens into the parent transcript — without this flag the
      // zero totalTokens/cost above would read as "measured free" instead of "unknown".
      asyncTokensUnknown: c.spawnAsync ? true : undefined,
    }))
}

type CompositionAccessor = (sessionId: string) => Promise<ContextComposition | null>
type HistoryAccessor = (sessionId: string) => Promise<ContextHistory | null>
type ConversationAccessor = (sessionId: string) => Promise<Conversation | null>
type CallContextAccessor = (sessionId: string, sel: { requestId?: string; spanId?: string }) => Promise<CallContext | null>
// Burn/session status are computed at the accessor site (server/extension) where the live sessions +
// statusline billing events live; the MCP layer just serializes the ready object (TRDD-OG9PARZQ).
type BurnStatusAccessor = () => BurnStatus
type SessionStatusAccessor = (sel: { sessionId?: string; workspace?: string }) => SessionStatus | { message: string; matchedBy: 'none' }
// TRDD-BURNWDGT — the CURRENT live OAuth account (identity + plan). Powers get_account_status and labels
// the per-account window budgets. Live-only (never persisted); returns nulls when unresolved.
type AccountAccessor = () => AccountInfo

// ── P4 diagnostic tool handlers ───────────────────────────────────────────────

// P8 (TRDD-TKN5VALS): the full per-STEP context history — every content block (system prompt,
// CLAUDE.md, rules, catalogs, files, tool in/out, bash in/out, hooks, skill/agent prompts, messages,
// sub-agent output, harness/cron injections) with its token count + taxonomy + the step's usage
// buckets + a diff vs the previous step. The raw reconstruction carries the FULL text of every block,
// which for a large session is far too big to return whole — so this MCP view is progressive:
//   • no turn        → per-step SUMMARIES (turn, usage, cost, and each block's kind/label/tokens/role,
//                       plus the diff's added/changed/removed counts + firstChangeBlockId).
//   • turn=N         → that step's blocks WITH full text (bounded by the reconstruction's 20k/block cap).
//   • turn=N,blockId → just that one block's full text (the deepest drill).
function handleGetCallContext(ctx: CallContext | null, args: { sessionId: string; requestId?: string; spanId?: string }) {
  // Honest fallback — a call with no raw body on disk (legacy OTEL-only, pre-config) returns a clear
  // message, never a perpetual spinner and never "check the previous turn" (TRDD-ICHAVFCS §6).
  if (!ctx) {
    return {
      sessionId: args.sessionId, requestId: args.requestId, spanId: args.spanId,
      message: 'Raw API body not captured for this call (recorded before raw-body logging was enabled, or not a Claude Code session with OTEL_LOG_RAW_API_BODIES set).',
    }
  }
  return {
    sessionId: ctx.sessionId,
    requestId: ctx.requestId,
    model: ctx.model,
    truncated: ctx.truncated,
    estimated: true,
    blockCount: ctx.blocks.length,
    totalTokens: ctx.blocks.reduce((n, b) => n + b.tokens, 0),
    blocks: ctx.blocks.map(b => ({ id: b.id, kind: b.kind, label: b.label, tokens: b.tokens, bytes: b.bytes, role: b.role, toolName: b.toolName, text: b.text })),
  }
}

function handleGetContextHistory(
  history: ContextHistory | null,
  card: SessionSummaryCard | undefined,
  args: { sessionId: string; turn?: number; blockId?: string },
) {
  if (!history) return { sessionId: args.sessionId, message: 'No local Claude log to reconstruct (OTEL-only session, or its transcript is not on disk).' }
  if (history.steps.length === 0 && history.reconstructedFrom) {
    return { sessionId: args.sessionId, reconstructedFrom: history.reconstructedFrom, message: `This spawned session has no transcript of its own — its context lives in parent ${history.reconstructedFrom}, whose log is not on disk to reconstruct.` }
  }
  const model = card?.model
  const cost = (u: { input: number; output: number; cacheRead: number; cacheCreate: number } | undefined): number | undefined =>
    u && model ? +calcTokenCostUsd(Math.max(0, u.input - u.cacheRead - u.cacheCreate), u.cacheRead, u.cacheCreate, u.output, model).toFixed(4) : undefined

  // Deepest drill: one block's full text.
  if (args.turn !== undefined && args.blockId) {
    const step = history.steps.find(s => s.turn === args.turn)
    const block = step?.blocks.find(b => b.id === args.blockId)
    if (!block) return { sessionId: args.sessionId, turn: args.turn, message: `No block ${args.blockId} at turn ${args.turn}.` }
    return { sessionId: args.sessionId, turn: args.turn, block: { ...block } }
  }
  // One step's blocks WITH full text.
  if (args.turn !== undefined) {
    const step = history.steps.find(s => s.turn === args.turn)
    if (!step) return { sessionId: args.sessionId, turn: args.turn, message: `No step at turn ${args.turn}.` }
    return {
      sessionId: args.sessionId, turn: step.turn, timestamp: step.timestamp, model: step.model ?? model,
      usage: step.usage, costUsd: cost(step.usage), diff: step.diff,
      blocks: step.blocks.map(b => ({ id: b.id, kind: b.kind, label: b.label, tokens: b.tokens, bytes: b.bytes, role: b.role, toolName: b.toolName, text: b.text })),
    }
  }
  // Whole session: per-step summaries (no full text — drill with turn=N).
  return {
    sessionId:  history.sessionId,
    reconstructedFrom: history.reconstructedFrom,
    estimated:  history.estimated,
    truncated:  history.truncated,
    stepCount:  history.steps.length,
    steps: history.steps.slice(0, 500).map(s => ({
      turn: s.turn, timestamp: s.timestamp, model: s.model ?? model,
      usage: s.usage, costUsd: cost(s.usage),
      blockCount: s.blocks.length,
      totalTokens: s.blocks.reduce((n, b) => n + b.tokens, 0),
      diff: { added: s.diff.added.length, changed: s.diff.changed.length, removed: s.diff.removed.length, firstChangeBlockId: s.diff.firstChangeBlockId },
      blocks: s.blocks.map(b => ({ id: b.id, kind: b.kind, label: b.label, tokens: b.tokens, role: b.role })),
    })),
  }
}

// ── get_conversation (TRDD-B22NYTOY) — the narrative lens over a session ──────────────────────────
// Progressive drill-down IS the bounding strategy (same contract as get_context_history): the
// no-arg shape carries per-turn SUMMARIES only (preview text, no full blocks); full verbatim text
// is returned only for one turn or a hard-capped range. leanify still caps whatever comes back.
const CONVERSATION_SUMMARY_TURN_CAP = 500
const CONVERSATION_RANGE_CAP = 20

/** One turn, verbatim — every block with its full stored text. */
function verbatimTurn(t: ConversationTurn) {
  return {
    turn: t.turn, role: t.role, ts: t.ts, model: t.model,
    ...(t.sidechain ? { sidechain: true } : {}),
    ...(t.durationMs !== undefined ? { durationMs: t.durationMs } : {}),
    ...(t.usage ? { usage: t.usage } : {}),
    blocks: t.blocks.map(b => ({ kind: b.kind, ...(b.toolName ? { toolName: b.toolName } : {}), ...(b.toolUseId ? { toolUseId: b.toolUseId } : {}), ...(b.tokens ? { tokens: b.tokens } : {}), ...(b.meta ? { meta: b.meta } : {}), text: b.text ?? '' })),
  }
}

function handleGetConversation(
  conv: Conversation | null,
  args: { sessionId: string; turn?: number; turnFrom?: number; turnTo?: number },
) {
  if (!conv) return { sessionId: args.sessionId, message: 'No local Claude log to reconstruct (OTEL-only session, or its transcript is not on disk).' }
  if (conv.turns.length === 0 && conv.reconstructedFrom) {
    return { sessionId: args.sessionId, reconstructedFrom: conv.reconstructedFrom, message: `This spawned session has no transcript of its own — its conversation lives in parent ${conv.reconstructedFrom}, whose log is not on disk to reconstruct.` }
  }
  const header = {
    sessionId: conv.sessionId,
    title: conv.title, agentName: conv.agentName, entrypoint: conv.entrypoint, cwd: conv.cwd, model: conv.model,
    totals: conv.totals, compactions: conv.compactions, otherRecords: conv.otherRecords,
    truncated: conv.truncated, reconstructedFrom: conv.reconstructedFrom,
  }
  // One turn, verbatim.
  if (args.turn !== undefined) {
    const t = conv.turns.find(x => x.turn === args.turn)
    if (!t) return { sessionId: args.sessionId, turn: args.turn, message: `No turn ${args.turn} (session has ${conv.turns.length}).` }
    return { sessionId: conv.sessionId, ...verbatimTurn(t) }
  }
  // Bounded verbatim range.
  if (args.turnFrom !== undefined || args.turnTo !== undefined) {
    const from = Math.max(1, args.turnFrom ?? 1)
    const to = Math.min(args.turnTo ?? from + CONVERSATION_RANGE_CAP - 1, from + CONVERSATION_RANGE_CAP - 1)
    const picked = conv.turns.filter(t => t.turn >= from && t.turn <= to)
    return { sessionId: conv.sessionId, turnFrom: from, turnTo: to, rangeCap: CONVERSATION_RANGE_CAP, turns: picked.map(verbatimTurn) }
  }
  // Whole session: header + per-turn summaries (drill with turn=N for full text).
  return {
    ...header,
    turnCount: conv.turns.length,
    turns: conv.turns.slice(0, CONVERSATION_SUMMARY_TURN_CAP).map(t => {
      const firstText = t.blocks.find(b => (b.kind === 'userText' || b.kind === 'assistantText' || b.kind === 'systemNote') && b.text)
      const tools = t.blocks.filter(b => b.kind === 'toolUse').map(b => b.toolName ?? 'tool')
      return {
        turn: t.turn, role: t.role, ts: t.ts,
        ...(t.sidechain ? { sidechain: true } : {}),
        ...(t.durationMs !== undefined ? { durationMs: t.durationMs } : {}),
        ...(t.usage ? { usage: t.usage } : {}),
        blockCount: t.blocks.length,
        ...(tools.length ? { tools } : {}),
        preview: (firstText?.text ?? '').slice(0, 100),
      }
    }),
  }
}

function handleGetContextComposition(composition: ContextComposition | null, args: { sessionId: string; turn?: number }) {
  if (!composition) return { sessionId: args.sessionId, message: 'No local Claude log composition available for this session (OTEL-only or not a Claude session).' }
  let turns = composition.turns
  if (args.turn !== undefined) turns = turns.filter(t => t.turn === args.turn)
  return {
    sessionId:  composition.sessionId,
    estimated:  composition.estimated,
    truncated:  composition.truncated,
    turnCount:  composition.turns.length,
    turns: turns.slice(0, 200).map(t => ({
      turn:        t.turn,
      totalTokens: t.sources.reduce((n, s) => n + s.tokens, 0),
      sources:     t.sources.map(s => ({ label: s.label, kind: s.kind, tokens: s.tokens, count: s.count })),
    })),
  }
}

// Exported for the ai-maestro consumed-fields contract test (AgentlensPro#3) — the perTurn cache
// read-vs-created split is consumed downstream, so its shape must fail CI on rename, not drift.
export function handleGetContextGrowth(s: SessionSummaryCard, timeline: TimelineEntry[]) {
  const growth = computeTurnGrowth(timeline)
  if (growth.length === 0) return { sessionId: s.sessionId, message: 'No per-turn token data (OTEL session without turn indices, or empty timeline).' }
  const peak = growth.reduce((m, g) => Math.max(m, g.promptTokens), 0)
  const totalCreate = growth.reduce((n, g) => n + g.cacheCreateTokens, 0)
  const totalRead = growth.reduce((n, g) => n + g.cacheReadTokens, 0)
  const denom = totalRead + totalCreate
  return {
    sessionId:                  s.sessionId,
    model:                      s.model,
    turns:                      growth.length,
    peakPromptTokens:           peak,
    persistedPeakContextPerTurn: s.peakContextPerTurn ?? null,
    overallCacheHitRatePct:     denom > 0 ? Math.round(totalRead / denom * 100) : 0,
    totalCacheCreatedTokens:    totalCreate,
    perTurn:                    growth.slice(0, 300),
  }
}

// Restrict a cross-session pool to sessions that have a reconstructable .jsonl on disk, THEN slice.
// Without the disk filter a recency-ordered pool is dominated by no-log cards (synth-*/agent-*/OTEL)
// and the scan reports 0 (see listSessionFileIds). Returns the honest before/after counts so a 0
// result is diagnosable ("considered N cards, M had a local log, scanned K").
function fileBackedPool(
  sessions: SessionSummaryCard[],
  scopeMatch: ((s: SessionSummaryCard) => boolean) | null,
  limit: number,
): { pool: SessionSummaryCard[]; considered: number; withLog: number } {
  const fileIds = listSessionFileIds()
  const scoped = scopeMatch ? sessions.filter(scopeMatch) : sessions
  const backed = scoped.filter(s => fileIds.has(s.sessionId))
  return { pool: backed.slice(0, limit), considered: scoped.length, withLog: backed.length }
}

// Exported for the ai-maestro CLI contract lock (cliContract.aimaestro.test.ts) — the tailored
// janitor consumes this payload's field names, so a rename must fail the gate, not ship silently.
export async function handleGetCacheBreakReport(
  sessions: SessionSummaryCard[],
  getTimeline: ((id: string) => unknown[]) | null,
  getComposition: CompositionAccessor | null,
  args: { sessionId?: string; workspace?: string },
) {
  if (!getComposition) return { error: 'Composition accessor unavailable — cache-break analysis needs local Claude logs.' }
  const reportFor = async (s: SessionSummaryCard): Promise<CacheBreakReport | null> =>
    buildCacheBreakReport(s.sessionId, asTimeline(getTimeline, s.sessionId, s), await getComposition(s.sessionId), s.model)

  if (args.sessionId) {
    const s = sessions.find(x => x.sessionId === args.sessionId)
    if (!s) return { error: `Session ${args.sessionId} not found.` }
    const report = await reportFor(s)
    if (!report) return { sessionId: s.sessionId, message: 'Not enough data to diff (no local composition, or a single-turn session).' }
    const broken = report.turns.filter(t => t.broke)
    return {
      sessionId:          report.sessionId,
      model:              s.model,
      cacheHitRatePct:    Math.round(report.cacheHitRate * 100),
      totalWastedTokens:  report.totalWastedTokens,
      totalWastedCostUsd: +report.totalWastedCostUsd.toFixed(4),
      breakCount:         broken.length,
      breaks: broken.slice(0, 40).map(t => ({
        turn: t.turn, cause: t.cause, block: t.breakSourceLabel ?? null,
        wastedTokens: t.wastedTokens, wastedCostUsd: +t.wastedCostUsd.toFixed(4), remediation: t.remediation,
      })),
      topOffenders: report.offenders.slice(0, 10).map(o => ({ ...o, wastedCostUsd: +o.wastedCostUsd.toFixed(4) })),
    }
  }

  const scope = args.workspace?.trim()
  const { pool, considered, withLog } = fileBackedPool(sessions, scope ? (s => (s.workspace ?? '').startsWith(scope)) : null, 20)
  // The pool is capped at 20, but each reportFor runs one SYNCHRONOUS transcript reparse
  // (asTimeline) before its composition await — scanWithBudget adds the macrotask yield + deadline
  // so post-restart worst cases (20 stripped multi-MB cards) stay interleavable and bounded.
  const { results, scanned, stoppedEarly } = await scanWithBudget(pool, DRILL_SCAN_TIME_BUDGET_MS, reportFor)
  const merged = new Map<string, CacheBreakOffender>()
  let analyzed = 0
  for (const report of results) {
    if (!report) continue
    analyzed++
    for (const o of report.offenders) {
      const key = `${o.cause}::${o.kind}::${o.label}`
      const cur = merged.get(key) ?? { label: o.label, kind: o.kind, cause: o.cause, occurrences: 0, wastedTokens: 0, wastedCostUsd: 0 }
      cur.occurrences += o.occurrences
      cur.wastedTokens += o.wastedTokens
      cur.wastedCostUsd += o.wastedCostUsd
      merged.set(key, cur)
    }
  }
  const ranked = [...merged.values()].sort((a, b) => (b.wastedCostUsd - a.wastedCostUsd) || (b.wastedTokens - a.wastedTokens))
  return {
    scope:              scope ?? 'all',
    sessionsConsidered: considered,
    sessionsWithLog:    withLog,
    sessionsAnalyzed:   analyzed,
    ...(stoppedEarly ? {
      scanStoppedEarly: true,
      scanNote: `SAMPLE: the ${DRILL_SCAN_TIME_BUDGET_MS / 1000}s scan budget stopped after ${scanned.length} of ${pool.length} pooled sessions — retry to widen (reparsed timelines are cached).`,
    } : {}),
    topOffenders:       ranked.slice(0, 15).map(o => ({ ...o, wastedCostUsd: +o.wastedCostUsd.toFixed(4) })),
  }
}

// get_cache_risk_costs / `reload-cost` (TRDD-EYA3X5MQ) — "what did each cache-breaking command cost
// me?". EXACT, not inferred: Claude Code persists every built-in slash command it runs as a
// transcript entry, so /reload-plugins, /reload-skills, a mutating /plugin, /login|/logout, /mcp and
// /model are read straight off disk with their real wall-clock (src/cacheRiskCommands.ts). The COST
// still comes from the same composition path get_cache_break_report uses, joined on
// CacheBreakTurn.tsMs: a command at time T is billed on the FIRST turn at or after T, because the
// local command makes no API call of its own and its changed prefix rides the NEXT model request.
//
// The join is also what settles the ambiguous commands. Bare /plugin, /mcp and /model open a picker
// the user may simply close — so an invocation is only charged when the turn that followed it
// actually broke. No break after it ⇒ cost 0, stated as such, never quietly dropped.
//
// The old co-churn heuristic survives ONLY as a labeled residue: reload-shaped turns that no command
// explains. It over-counted badly (102 vs 69 actual on this machine) so it must never be summed into
// the exact rows — but discarding it outright would hide real breaks in sessions whose transcript
// has been rotated away.
async function handleGetCacheRiskCosts(
  sessions: SessionSummaryCard[],
  getTimeline: ((id: string) => unknown[]) | null,
  getComposition: CompositionAccessor | null,
  args: { window?: number; minTokens?: number; topN?: number; workspace?: string; kinds?: string[] },
) {
  if (!getComposition) return { error: 'Composition accessor unavailable — reload-cost needs local Claude logs.' }
  const cap = Math.min(Math.max(1, args.topN ?? 25), 200)
  const scope = args.workspace?.trim()
  const sinceMs = args.window ? Date.now() - args.window * 3_600_000 : undefined
  const minTokens = Math.max(0, args.minTokens ?? 0)

  // 1. The exact causes, off disk. Machine-wide and retroactive — no hook, no restart, no capture.
  const commands = scanCacheRiskCommands({
    sinceMs,
    kinds: args.kinds?.length ? (args.kinds as CacheRiskKind[]) : undefined,
  })
  // TWO SOURCES, because a typed command is not the only way a prefix breaks (TRDD-A4BA8IU5 gap B).
  // An effort change needs no command at all — a /model switch or the automatic safety-classifier
  // fallback moves it with no user action — and MEASURED corpus-wide, all 12 real effort transitions
  // occurred in sessions containing ZERO /effort commands. Reading only commands scored 0 of 12 on a
  // cause that genuinely invalidates the prefix. The transition is also the STRONGER signal of the
  // two: `/effort` is 'ambiguous' because it may re-select the same value, while a transition is the
  // observed change.
  const wantEffort = !args.kinds?.length || args.kinds.includes('EFFORT_CHANGED')
  const effortEvents = wantEffort
    ? scanEffortTransitions({ sinceMs }).map(effortTransitionAsRiskCommand)
    : []
  const bySession = new Map<string, CacheRiskCommand[]>()
  for (const c of [...commands, ...effortEvents]) {
    if (!c.session) continue
    const list = bySession.get(c.session)
    if (list) list.push(c); else bySession.set(c.session, [c])
  }

  // 2. Price them. Analysing a session is the expensive half, so spend the bounded pool ONLY on
  //    sessions a command was actually typed in — otherwise the budget goes to sessions that can
  //    contribute nothing to this report.
  const pred = (s: SessionSummaryCard) => {
    if (!bySession.has(s.sessionId)) return false
    if (scope && !(s.workspace ?? '').startsWith(scope)) return false
    if (sinceMs !== undefined && Date.parse(s.startTime) < sinceMs) return false
    return true
  }
  const { pool, considered, withLog } = fileBackedPool(sessions, pred, 40)
  const reportFor = async (s: SessionSummaryCard): Promise<{ card: SessionSummaryCard; report: CacheBreakReport | null }> =>
    ({ card: s, report: buildCacheBreakReport(s.sessionId, asTimeline(getTimeline, s.sessionId, s), await getComposition(s.sessionId), s.model) })
  const { results, scanned, stoppedEarly } = await scanWithBudget(pool, DRILL_SCAN_TIME_BUDGET_MS, reportFor)

  interface Row {
    when: string; sessionId: string; command: string; args?: string
    kind: CacheRiskKind; mutation: 'certain' | 'ambiguous'
    turn: number | null; cacheCreateTokens: number; wastedCostUsd: number
    model?: string; evidence: 'exact'; note?: string
  }
  const rows: Row[] = []
  const residue: Array<{ sessionId: string; turn: number; catalogs: string | null; cacheCreateTokens: number; wastedCostUsd: number; evidence: 'inference' }> = []
  let totalCC = 0, totalCost = 0, analyzed = 0, priced = 0

  for (const r of results) {
    if (!r || !r.report) continue
    analyzed++
    const cmds = (bySession.get(r.report.sessionId) ?? []).slice().sort((a, b) => a.ts - b.ts)
    const timed = r.report.turns.filter(t => t.tsMs !== undefined).sort((a, b) => (a.tsMs ?? 0) - (b.tsMs ?? 0))
    const explained = new Set<number>()
    // A turn's cache_creation is ONE cost. Several commands can land before the same next turn
    // (two /login 18s apart, a /reload-plugins immediately followed by /reload-skills) — they broke
    // the prefix once, together, so only the EARLIEST is charged and the rest are listed at 0 with
    // the reason. Charging each of them the full turn is exactly the double-count that made the old
    // heuristic untrustworthy; `cmds` is sorted ascending so "earliest" is the first one seen.
    const charged = new Set<number>()
    for (const c of cmds) {
      const billed = timed.find(t => (t.tsMs ?? 0) >= c.ts)
      const alreadyCharged = billed !== undefined && charged.has(billed.turn)
      const broke = billed?.broke === true && billed.wastedTokens > 0 && !alreadyCharged
      if (billed) explained.add(billed.turn)
      if (broke && billed.wastedTokens < minTokens) continue
      const cc = broke ? billed.wastedTokens : 0
      const usd = broke ? billed.wastedCostUsd : 0
      if (broke) charged.add(billed.turn)
      totalCC += cc; totalCost += usd
      if (cc > 0) priced++
      const row: Row = {
        when: new Date(c.ts).toISOString(), sessionId: c.session ?? r.report.sessionId,
        command: c.command, kind: c.kind, mutation: c.mutation,
        turn: billed?.turn ?? null, cacheCreateTokens: cc, wastedCostUsd: +usd.toFixed(4),
        model: r.card.model, evidence: 'exact',
      }
      if (c.args) row.args = c.args
      if (!billed) row.note = 'no turn recorded at or after this command — cost unattributable'
      else if (alreadyCharged) row.note = `turn ${billed.turn} was already charged to an earlier command — they broke the prefix once, together`
      else if (!broke) row.note = 'the next turn did not break — this invocation changed nothing (menu opened and closed)'
      rows.push(row)
    }
    // Reload-shaped turns nothing explains. Reported separately, never summed with the exact rows.
    for (const t of r.report.turns) {
      if (t.cause !== 'PLUGINS_RELOADED' || t.wastedTokens <= 0 || explained.has(t.turn)) continue
      residue.push({
        sessionId: r.report.sessionId, turn: t.turn, catalogs: t.breakSourceLabel ?? null,
        cacheCreateTokens: t.wastedTokens, wastedCostUsd: +t.wastedCostUsd.toFixed(4), evidence: 'inference',
      })
    }
  }

  rows.sort((a, b) => (a.when < b.when ? 1 : a.when > b.when ? -1 : 0))
  const shown = rows.slice(0, cap)
  const byKind: Record<string, { events: number; cacheCreateTokens: number; costUsd: number }> = {}
  for (const r of rows) {
    const k = byKind[r.kind] ?? (byKind[r.kind] = { events: 0, cacheCreateTokens: 0, costUsd: 0 })
    k.events++; k.cacheCreateTokens += r.cacheCreateTokens; k.costUsd = +(k.costUsd + r.wastedCostUsd).toFixed(4)
  }

  return {
    windowHours: args.window ?? null, scope: scope ?? 'all',
    commandsFoundInTranscripts: commands.length,
    sessionsWithCommands: bySession.size,
    sessionsConsidered: considered, sessionsWithLog: withLog, sessionsAnalyzed: analyzed,
    eventsPriced: priced, eventsListed: rows.length,
    totalCacheCreateTokens: totalCC, totalCostUsd: +totalCost.toFixed(4),
    byKind,
    ...(stoppedEarly ? {
      scanStoppedEarly: true,
      scanNote: `SAMPLE: the ${DRILL_SCAN_TIME_BUDGET_MS / 1000}s scan budget stopped after ${scanned.length} of ${pool.length} pooled sessions — retry to widen (reparsed timelines are cached).`,
    } : {}),
    events: shown,
    eventsNote: rows.length > cap ? `Showing the most recent ${shown.length} of ${rows.length} (raise topN, max 200).` : undefined,
    unexplainedReloadTurns: residue.length ? residue.slice(0, cap) : undefined,
    unexplainedNote: residue.length
      ? `${residue.length} reload-shaped turn(s) had no matching command in the transcript (co-churn INFERENCE — historically over-counts; listed separately and NOT included in the totals above).`
      : undefined,
    note: commands.length === 0
      ? 'No cache-risk commands found in the transcripts for this window/scope.'
      : rows.length === 0
        ? `Found ${commands.length} command(s) in the transcripts, but none of their sessions is in the analysable pool (needs local Claude logs + composition). Widen the window or drop the workspace filter.`
        : undefined,
  }
}

async function handleGetContextInflationReport(
  sessions: SessionSummaryCard[],
  getComposition: CompositionAccessor | null,
  getHistory: HistoryAccessor | null,
  args: { sessionId?: string; workspace?: string },
) {
  if (!getComposition) return { error: 'Composition accessor unavailable — inflation analysis needs local Claude logs.' }
  const agg = new Map<string, SourceAggregate & { sessions: number }>()
  const fold = (aggs: SourceAggregate[]) => {
    for (const a of aggs) {
      const key = `${a.kind}::${a.label}`
      const cur = agg.get(key) ?? { label: a.label, kind: a.kind, cumulativeTokens: 0, turnsPresent: 0, peakTokens: 0, sessions: 0 }
      cur.cumulativeTokens += a.cumulativeTokens
      cur.turnsPresent += a.turnsPresent
      cur.peakTokens = Math.max(cur.peakTokens, a.peakTokens)
      cur.sessions += 1
      agg.set(key, cur)
    }
  }

  let scanned = 0
  let considered = 1
  let withLog = 1
  if (args.sessionId) {
    const c = await getComposition(args.sessionId)
    if (!c) return { sessionId: args.sessionId, message: 'No local composition available for this session.' }
    fold(aggregateComposition(c)); scanned = 1
  } else {
    const scope = args.workspace?.trim()
    const fb = fileBackedPool(sessions, scope ? (s => (s.workspace ?? '').startsWith(scope)) : null, 20)
    considered = fb.considered; withLog = fb.withLog
    for (const s of fb.pool) { const c = await getComposition(s.sessionId); if (c) { fold(aggregateComposition(c)); scanned++ } }
  }
  const ranked = [...agg.values()].sort((a, b) => b.cumulativeTokens - a.cumulativeTokens)
  // Runaway = re-injected across many turns AND heavy per turn — if it lives in the cached prefix it
  // forces repeated cache-creation. This is the fixable structural sink.
  const runaway = ranked.filter(a => a.turnsPresent >= 5 && a.peakTokens >= 1000)

  // TRDD-W0RRL2FZ: itemize the "conversation remainder" for a single session — every context block
  // ranked by residentCost = tokens × turns-resident, reconciled against the exact per-step usage
  // totals so no token stays unattributed silently. Single-session only: the workspace path already
  // streams every pooled transcript once for the composition; a second full-history pass per pooled
  // session would double the scan cost of one MCP call for an aggregate the per-session drill answers
  // better.
  let residentCost: unknown = null
  if (args.sessionId) {
    const history = getHistory ? await getHistory(args.sessionId).catch(() => null) : null
    if (history && history.steps.length > 0) {
      const rc = buildResidentCostReport(history)
      residentCost = {
        estimated: rc.estimated,
        truncated: rc.truncated,
        stepCount: rc.stepCount,
        stepsWithUsage: rc.stepsWithUsage,
        compactionTurns: rc.compactionTurns,
        totalContextTokens: rc.totalContextTokens,
        itemizedResidentTokens: rc.itemizedResidentTokens,
        unattributedTokens: rc.unattributedTokens,
        itemizedPct: rc.totalContextTokens > 0 ? +(rc.itemizedResidentTokens / rc.totalContextTokens * 100).toFixed(1) : null,
        note: rc.note,
        topBlocks: rc.blocks.slice(0, 10).map(b => ({
          ...b,
          // The drill pointer: get_context_history(sessionId, turn, blockId) returns this block's
          // full text at its first occurrence.
          drill: { tool: 'get_context_history', sessionId: args.sessionId, turn: b.firstSeenTurn, blockId: b.id },
        })),
      }
    } else {
      // Honest absence — an OTEL-only session (or missing accessor) cannot be itemized; say so
      // instead of returning a silent null field.
      residentCost = { message: 'No local transcript to itemize (history accessor unavailable, or OTEL-only session with no .jsonl on disk).' }
    }
  }

  return {
    scope:              args.sessionId ? `session ${args.sessionId}` : (args.workspace ?? 'all'),
    sessionsConsidered: considered,
    sessionsWithLog:    withLog,
    sessionsScanned:    scanned,
    topContributors: ranked.slice(0, 15).map(a => ({ label: a.label, kind: a.kind, cumulativeTokens: a.cumulativeTokens, turnsPresent: a.turnsPresent, peakTokens: a.peakTokens, sessions: a.sessions })),
    runawaySources:  runaway.slice(0, 10).map(a => ({
      label: a.label, kind: a.kind, turnsPresent: a.turnsPresent, peakTokens: a.peakTokens, cumulativeTokens: a.cumulativeTokens,
      hint: 'Re-injected across many turns — if it sits in the cached prefix it forces repeated cache-creation; move it into the message suffix after the last breakpoint.',
    })),
    // Session-scoped resident-cost itemization (null only on workspace scope, where it is not computed).
    residentCost,
  }
}

// Exported for unit tests (TRDD-ZK37VG4X spec 4 — sampling honesty).
export const HOG_SCAN_CAP = 25

export async function handleFindContextHogs(
  sessions: SessionSummaryCard[],
  getComposition: CompositionAccessor | null,
  args: { scope?: string; topN?: number },
) {
  if (!getComposition) return { error: 'Composition accessor unavailable — context-hog analysis needs local Claude logs.' }
  const scope = args.scope?.trim()
  const topN = Math.min(args.topN ?? 15, 50)
  const { pool, considered, withLog } = fileBackedPool(sessions, scope ? (s => (s.workspace ?? '').startsWith(scope) || s.sessionId.includes(scope)) : null, HOG_SCAN_CAP)
  const byKey = new Map<string, { label: string; kind: string; cumulativeTokens: number; sessions: number; occurrences: number }>()
  let scanned = 0
  for (const s of pool) {
    const c = await getComposition(s.sessionId)
    if (!c) continue
    scanned++
    for (const a of aggregateComposition(c)) {
      const key = `${a.kind}::${a.label}`
      const cur = byKey.get(key) ?? { label: a.label, kind: a.kind, cumulativeTokens: 0, sessions: 0, occurrences: 0 }
      cur.cumulativeTokens += a.cumulativeTokens
      cur.sessions += 1
      cur.occurrences += a.turnsPresent
      byKey.set(key, cur)
    }
  }
  const hogs = [...byKey.values()].sort((a, b) => b.cumulativeTokens - a.cumulativeTokens).slice(0, topN)
  return {
    scope: scope ?? 'all',
    // Legacy flat counters kept for existing consumers; `coverage` is the honest-sampling contract
    // (spec 4): it states explicitly what was scanned vs skipped so bounded totals are never
    // mistaken for full history.
    sessionsConsidered: considered,
    sessionsWithLog: withLog,
    sessionsScanned: scanned,
    coverage: buildScanCoverage(considered, withLog, scanned, HOG_SCAN_CAP),
    // Top-N truncation is labeled too: how many distinct sources existed vs how many are returned.
    distinctSources: byKey.size,
    returnedHogs: hogs.length,
    hogsTruncated: byKey.size > topN,
    hogs,
  }
}

// Exported for unit tests (TRDD-62E8UU41 — spawn rollup + detections surface in the MCP output).
export function handleGetSubagentTree(sessions: SessionSummaryCard[], args: { sessionId: string }) {
  const s = sessions.find(x => x.sessionId === args.sessionId)
  if (!s) return { error: `Session ${args.sessionId} not found.` }
  const root = s.parentSessionId ? (sessions.find(x => x.sessionId === s.parentSessionId) ?? s) : s
  const children = subAgentChildren(sessions, root.sessionId)
  const rolledUpTokens = (root.inputTokens + root.outputTokens) + children.reduce((n, c) => n + c.totalTokens, 0)
  const rolledUpCost = +(sessionCost(root) + children.reduce((n, c) => n + c.cost_usd, 0)).toFixed(4)
  // TRDD-62E8UU41: the spawn-cost rollup + antipattern detections over the FULL child cards (the
  // reduced `children` shape above lacks the cache buckets the detectors read). sessionCost is the
  // normalizing pricer (recovers uncached input from either token convention), so the rollup + waste
  // figures are consistent with rolledUpCost. Agents call this before fanning out to self-audit the
  // cheaper spawn shape.
  const childCards = sessions.filter(c => c.parentSessionId === root.sessionId && c.sessionId !== root.sessionId)
  const spawnRollup = buildSpawnRollup(childCards, { parentModel: root.model, costOf: sessionCost })
  return {
    root: { sessionId: root.sessionId, model: root.model, ownTokens: root.inputTokens + root.outputTokens, ownCost_usd: +sessionCost(root).toFixed(4) },
    childCount:       children.length,
    children:         children.length > 0 ? children : [],
    rolledUpTokens,
    rolledUpCost_usd: rolledUpCost,
    spawnRollup,
    note: children.length === 0 ? 'No sub-agent children recorded for this session.' : undefined,
  }
}

// ── get_agent_tokens (TRDD-9YT1UR2F) ──────────────────────────────────────────

// Strip the transcript-card prefix: 'agent-<id>' → '<id>'. A bare agent id and its agent-<id>
// form name the SAME agent — the subagents/*.jsonl filename convention that
// feedMergePolicy.linkSubagentTranscripts pairs on. Case handled by the caller (ids lowercased).
function stripAgentPrefix(sessionId: string): string {
  return sessionId.startsWith('agent-') ? sessionId.slice('agent-'.length) : sessionId
}

// Compact candidate line for the ambiguity error — enough to pick one (full sessionId is the
// unambiguous re-query key), never the whole card.
function agentCandidateSummary(s: SessionSummaryCard) {
  return {
    sessionId:       s.sessionId,
    parentSessionId: s.parentSessionId ?? null,
    model:           s.spawnModelOverride || s.model,
    spawnKind:       s.spawnKind ?? null,
    totalTokens:     s.inputTokens + s.outputTokens,
  }
}

/**
 * CC-footer ↓ reconciliation numbers (TRDD-9YT1UR2F addendum, empirically decoded 2026-07-11 by
 * regressing a live fork's transcript against two footer readings):
 *
 *   • CC's per-agent ↓ = CUMULATIVE (input + cacheRead + cacheCreation) across ALL the agent's
 *     turns, INCLUDING the launch turn — a fork's turn 1 is the inherited-prefix cache read,
 *     ~99.5% of the figure. output is excluded or below CC's 0.1k display rounding
 *     (indistinguishable: turn-1 input-side 407,449 vs footer 409.3k; 6-turn cumulative
 *     2,463,246 predicting footer ≈2.46m). That is `cumulativeInputSideTokens`.
 *   • `lastTurnContextRead` is the context-SIZE proxy: the LAST turn's input-side buckets
 *     (what the model read on the most recent call).
 *
 * Both are VOLUME MOVED, not billing — the four buckets bill at different rates (cost_usd is
 * the spend figure). Derivation of lastTurnContextRead, most→least authoritative, never a guess:
 *   1. statusline overlay (CC's own context_window numbers, exact) when present;
 *   2. the last usage-carrying timeline entry (transcript-parsed per-turn buckets);
 *   3. a single-turn card's cumulative figure (one turn ⇒ cumulative == last turn — this is the
 *      sync-placeholder path, whose card buckets ARE the final-turn snapshot);
 *   4. null — a multi-turn card without per-turn data cannot honestly answer.
 */
function ccDisplayEquivalent(c: SessionSummaryCard, timeline: TimelineEntry[]) {
  const cumulativeInputSideTokens = contextTokens(c)
  let lastTurnContextRead: number | null = null
  if (c.statusline) {
    lastTurnContextRead = c.statusline.lastTotalInputTokens
  } else {
    for (let i = timeline.length - 1; i >= 0; i--) {
      const t = contextTokens(timeline[i])
      if (t > 0) { lastTurnContextRead = t; break }
    }
    if (lastTurnContextRead === null && c.totalLlmCalls <= 1 && cumulativeInputSideTokens > 0) {
      lastTurnContextRead = cumulativeInputSideTokens
    }
  }
  return {
    cumulativeInputSideTokens,
    lastTurnContextRead,
    note:
      "CC's footer ↓ ≈ cumulativeInputSideTokens (cumulative input+cacheRead+cacheCreation across " +
      "ALL turns, launch turn included; output excluded or below CC's 0.1k rounding). It is volume " +
      'moved, not billing — use cost_usd for spend.',
  }
}

// Exported for unit tests (TRDD-9YT1UR2F — exact per-agent buckets, cross-tool consistent with
// get_subagent_tree). ONE implementation: the CLI reaches it through this same registry (its
// schemas come live from tools/list), so there is no second dispatch table to keep in sync.
export function handleGetAgentTokens(
  sessions: SessionSummaryCard[],
  getTimeline: ((id: string) => unknown[]) | null,
  args: { agentId: string; parentSessionId?: string },
) {
  const q = (args.agentId ?? '').trim()
  if (!q) return { error: 'agentId is required — a bare agent id, its agent-<id> transcript form, or a full sessionId.' }
  const qLower = q.toLowerCase()
  const qBare = stripAgentPrefix(qLower)

  // Normalized equivalence class first (bare id ↔ agent-<id>, case-insensitive). Exact sessionId
  // equality must NOT take blanket precedence: a spawn PLACEHOLDER's sessionId IS the bare agent id,
  // so on an un-merged placeholder + transcript pair a bare-id query would "exactly" match the
  // zero-bucket placeholder and silently serve it over the real totals — a guess dressed as
  // precision. Exact equality is only trusted as a TIE-BREAK below, when the query carries the
  // distinguishing agent-<id> form.
  let matches = sessions.filter(s => stripAgentPrefix(s.sessionId.toLowerCase()) === qBare)

  const parentArg = args.parentSessionId?.trim()
  if (parentArg && matches.length > 0) {
    const p = parentArg.toLowerCase()
    const scoped = matches.filter(s => (s.parentSessionId ?? '').toLowerCase() === p)
    if (scoped.length === 0) {
      // The id exists but not under that parent — say so and show where it DOES live, instead of
      // a bare not-found that would send the caller hunting a typo in the agent id.
      return {
        error: `Agent "${q}" matched ${matches.length} card(s), but none under parent ${parentArg}.`,
        candidates: matches.map(agentCandidateSummary),
      }
    }
    matches = scoped
  }

  if (matches.length === 0) {
    return {
      error: `Agent "${q}" not found. Accepted forms: bare agent id, agent-<id>, or a full sessionId ` +
        '(case-insensitive). Use get_subagent_tree on the spawning session to list its children.',
    }
  }
  if (matches.length > 1) {
    // Tie-break by exact sessionId ONLY when the query is distinguishable (it carried the agent-
    // prefix, so it names exactly one card of the pair). A bare-id query equals the placeholder's
    // sessionId BY CONSTRUCTION — treating that as intent would be the silent guess this tool bans.
    const exact = matches.filter(s => s.sessionId.toLowerCase() === qLower)
    if (exact.length === 1 && qLower !== qBare) {
      matches = exact
    } else {
      // NEVER guess between conflicting cards (e.g. a placeholder + transcript pair the
      // cross-parent guard left un-merged): list the candidates and let the caller pin one — by
      // parentSessionId (each candidate carries its parent), or by the agent-<id> transcript form.
      return {
        error: `Agent id "${q}" is ambiguous — ${matches.length} cards match. Pass parentSessionId ` +
          'to scope the lookup, or the full sessionId of one candidate (the agent-<id> transcript form).',
        candidates: matches.map(agentCandidateSummary),
      }
    }
  }

  const c = matches[0]
  // Same conventions as get_subagent_tree children — the cross-tool consistency contract:
  // spawnKind defaults 'fresh' on child cards, model prefers the spawn override, totalTokens is
  // input+output (non-cache), cost_usd is the shared normalizing pricer. A card with no parent
  // (a full-sessionId query for a top-level session) carries no spawn taxonomy — null, not 'fresh'.
  const spawnKind = c.spawnKind ?? (c.parentSessionId ? 'fresh' as const : null)
  const startMs = Date.parse(c.startTime)
  const timeline = asTimeline(getTimeline, c.sessionId, c)
  return {
    agentId:         stripAgentPrefix(c.sessionId),
    sessionId:       c.sessionId,
    parentSessionId: c.parentSessionId ?? null,
    spawnedByTurn:   c.spawnedByTurn ?? null,
    spawnKind,
    warm:            spawnKind === 'fork',
    model:           c.spawnModelOverride || c.model,
    modelOverride:   c.spawnModelOverride ?? null,
    isolation:       c.spawnIsolation ?? null,
    subagentType:    c.spawnSubagentType ?? null,
    startedAt:       c.startTime || null,
    // lastSeenAt derives from the card's own span (start + duration) — null when the card has no
    // parseable start (an async placeholder before its transcript exists), never a fabricated now().
    lastSeenAt:      Number.isFinite(startMs) ? new Date(startMs + (c.durationMs || 0)).toISOString() : null,
    turns:           c.totalLlmCalls > 0 ? c.totalLlmCalls : null,
    inputTokens:       c.inputTokens,
    outputTokens:      c.outputTokens,
    cacheReadTokens:   c.cacheReadTokens,
    cacheCreateTokens: c.cacheCreateTokens ?? 0,
    totalTokens:       c.inputTokens + c.outputTokens,
    cost_usd:          +sessionCost(c).toFixed(4),
    // Async launches never report tokens into the parent transcript — without this flag the zero
    // buckets above would read as "measured free" instead of "unknown" (same flag as the tree).
    ...(c.spawnAsync ? { asyncTokensUnknown: true } : {}),
    ccDisplayEquivalent: ccDisplayEquivalent(c, timeline),
    // P7 provenance — which feed backs this card's token figures; null = pre-P7 card ("unknown"),
    // never a backfilled guess. coverageNote rides only when a decision set it.
    tokensSource: c.tokensSource ?? null,
    ...(c.coverageNote ? { coverageNote: c.coverageNote } : {}),
  }
}

// Session usage ground truth for the by-cause reconciliation: uncached input + cacheRead +
// cacheCreate + output. inputTokens is RAW on every card (2026-07-10 normalization), so the
// total is a plain sum of the four disjoint buckets.
function normalizedSessionTotalTokens(s: SessionSummaryCard): number {
  return s.inputTokens + s.cacheReadTokens + (s.cacheCreateTokens ?? 0) + s.outputTokens
}

// Exported for unit tests (TRDD-UBEP5XY7). Leaderboard scan cap: cross-session mode must load
// every candidate timeline (DB reads in the extension), so the window is bounded and the coverage
// block states the bound explicitly — the find_context_hogs honesty pattern.
export const CAUSE_SCAN_CAP = 50

// X2E6OSWK: cap on how long ANY corpus-fanning drill scan may hold the event loop. Each pool entry
// can trigger a SYNCHRONOUS full-transcript reparse (resolveSessionCard on a stripped card — after
// a server restart that is EVERY disk-restored card), so 50 back-to-back reparses ran for minutes
// inline in one request and starved the loop into the wedge state (100% CPU, every request
// hanging — the 2026-07-16 recurrence). The budget stops the scan honestly instead.
export const DRILL_SCAN_TIME_BUDGET_MS = 20_000

// X2E6OSWK: the ONE bounded-scan primitive for every corpus-fanning drill handler. The
// setImmediate yield between items is a MACROTASK boundary — a bare `await` of a resolved promise
// only drains microtasks and would still starve I/O, so queued HTTP requests could never
// interleave. The deadline bounds the worst case. Never fold such a loop back into a map/flatMap —
// the unyielding 50-reparse flatMap was the exact 2026-07-16 wedge this replaced.
async function scanWithBudget<T, R>(
  pool: T[],
  timeBudgetMs: number,
  perItem: (item: T) => R | Promise<R>,
): Promise<{ results: R[]; scanned: T[]; stoppedEarly: boolean }> {
  const results: R[] = []
  const scanned: T[] = []
  const deadline = Date.now() + timeBudgetMs
  let stoppedEarly = false
  for (const item of pool) {
    if (Date.now() > deadline) { stoppedEarly = true; break }
    results.push(await perItem(item))
    scanned.push(item)
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  return { results, scanned, stoppedEarly }
}

export async function handleGetCostByCause(
  sessions: SessionSummaryCard[],
  getTimeline: ((id: string) => unknown[]) | null,
  args: { sessionId?: string; days?: number },
  timeBudgetMs: number = DRILL_SCAN_TIME_BUDGET_MS,
) {
  if (args.sessionId) {
    const s = sessions.find(x => x.sessionId === args.sessionId)
    if (!s) return { error: `Session ${args.sessionId} not found.` }
    return buildTokensByCause(asTimeline(getTimeline, s.sessionId, s), {
      sessionId: s.sessionId,
      sessionTotalTokens: normalizedSessionTotalTokens(s),
    })
  }

  // Cross-session leaderboard over a bounded recent window. Only claude_code sessions can carry
  // api_request events (the rich events are CC-specific), so other agents are excluded from the
  // scan but still counted in `considered` for honest coverage.
  const days = Math.min(Math.max(args.days ?? 7, 1), 90)
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  // Window + ranking are by LAST ACTIVITY, not startTime. On a busy fleet the newest-STARTED cards
  // are ephemeral subagents/heartbeats with no attribution, while the heavy long-lived sessions
  // (started days ago, still burning NOW) never make a startTime-ranked pool — measured 2026-07-16:
  // 13,241 CC cards, the active flagship session ranked #446 by startTime, and the machine-wide
  // leaderboard read 0 attributed calls while that session's own drill showed 1155. startTime also
  // silently DROPS an old-started-but-active session from the window itself.
  const inWindow = sessions.filter(s => lastActivityMs(s) >= cutoff)
  const candidates = inWindow.filter(s => s.source === 'claude_code')
    .sort((a, b) => lastActivityMs(b) - lastActivityMs(a))
  const scanPool = candidates.slice(0, CAUSE_SCAN_CAP)
  // One session per macrotask, deadline-checked (scanWithBudget): a stripped card's timeline is
  // reparsed from its whole JSONL transcript SYNCHRONOUSLY inside asTimeline.
  const { results, scanned, stoppedEarly } =
    await scanWithBudget(scanPool, timeBudgetMs, s => asTimeline(getTimeline, s.sessionId, s))
  const merged: unknown[] = results.flat()
  // Window ground truth = Σ normalized per-session totals over the SCANNED pool only, so the
  // reconciliation remainder compares like with like (scanned traffic vs scanned api_requests).
  const windowTotal = scanned.reduce((n, s) => n + normalizedSessionTotalTokens(s), 0)
  const report = buildTokensByCause(merged as Parameters<typeof buildTokensByCause>[0], {
    sessionsScanned: scanned.length,
    sessionTotalTokens: windowTotal,
  })
  const skipped = candidates.length - scanned.length
  return {
    ...report,
    days,
    coverage: {
      sessionsConsidered: inWindow.length,
      claudeCodeSessions: candidates.length,
      sessionsScanned: scanned.length,
      sessionsSkipped: skipped,
      scanCap: CAUSE_SCAN_CAP,
      stoppedEarly,
      complete: skipped === 0,
      note: skipped === 0
        ? `Complete coverage: all ${candidates.length} Claude Code sessions in the last ${days}d were scanned (${inWindow.length} total sessions considered).`
        : stoppedEarly
          ? `SAMPLE, not full coverage: the ${timeBudgetMs / 1000}s scan time budget stopped the scan after ` +
            `${scanned.length} of ${candidates.length} Claude Code sessions (transcript reparses are expensive right ` +
            `after a server restart). Totals reflect the scanned sample only — retry for wider coverage as reparsed ` +
            `timelines are cached on their cards.`
          : `SAMPLE, not full coverage: the ${scanned.length} most-recently-ACTIVE Claude Code sessions scanned (cap ${CAUSE_SCAN_CAP}); ` +
            `${skipped} of ${candidates.length} active in the ${days}d window were NOT scanned. Totals reflect the scanned sample only.`,
    },
  }
}

// ── Per-account awareness handlers (TRDD-BURNWDGT) ─────────────────────────────

/** Attach a human label to one account's window budget: the current account's email/org, else a short
 *  account id (a rotated-away account is not resolvable to an email — only its id is known). */
/**
 * How full a rolling window is, as one honest percentage.
 *
 * COST first, raw tokens only as a fallback: the plan's windows are metered by cost-equivalent, not
 * by token count (a cache read bills at 0.1x), so with ~96% of volume being cache reads the raw-token
 * percentage systematically overstates the fill. Reporting it as *the* utilisation is what let a
 * pooled 7d window read 171.51% while the cost figure for the same window read 64.49%.
 *
 * Null when the capacity is an auto-observed LOWER BOUND that consumption has already passed: the
 * denominator is then proven wrong, and any percentage off it is noise wearing a number's clothes.
 */
export function windowFillPct(w: { pctConsumed: number | null; pctConsumedCost: number | null; capacityExceeded: boolean }): number | null {
  if (w.capacityExceeded) return null
  return w.pctConsumedCost ?? w.pctConsumed
}

function labelAccountWindow(w: AccountWindowBudget, account: AccountInfo | null): AccountWindowBudget {
  const label = account
    ? accountLabelFor(account, w.accountUuid)
    : (w.accountUuid ? w.accountUuid.slice(0, 8) : 'unknown')
  return { ...w, accountLabel: label }
}

// Exported for unit tests. Labels every per-account window on a burn status in place (immutably).
export function labelBurnStatusAccounts(status: BurnStatus, account: AccountInfo | null): BurnStatus {
  return { ...status, accountWindows: status.accountWindows.map(w => labelAccountWindow(w, account)) }
}

// Exported for unit tests. get_account_status: the current account (identity + plan) + how much of ITS
// rate-limit window is left + (TRDD-VY1IUVUM Part-5) its billing MODE, the machine's cache-TTL regime,
// and the authoritative 5h/7d window fill. The OAuth token is never touched — only the plan string.
// ttlCtx + rateLimits are optional so the pre-Part-5 two-arg callers (and unit tests) keep working; the
// standalone server always passes both (getTtlContext / getRateLimits accessors).
export function handleGetAccountStatus(
  account: AccountInfo | null,
  burn: BurnStatus | null,
  ttlCtx: TtlContext | null = null,
  rateLimits: RateLimitsSnapshot | null = null,
) {
  const uuid = account?.accountUuid ?? null
  const win = burn?.accountWindows.find(w => (w.accountUuid ?? null) === uuid) ?? null

  // Auth regime: from the resolved ttlCtx when present; else a coarse fallback off billingType (the
  // substring match is the stripe_subscription fix). Shared with the account-state timeline sampler.
  const authRegime: string | null = resolveAuthRegimeLabel(account, ttlCtx)

  // Cache-TTL regime for the current session (always 'main' here — get_account_status is a main-
  // conversation tool). classifyTtlRegime with a null ctx yields the honest 'assumed' 5-min floor.
  const ttlRegime = classifyTtlRegime('main', ttlCtx)

  // Authoritative-preferred window fill: Claude Code's own rate_limits utilization when the statusline
  // build persists it, else AgentlensPro's calibrated pct, else null (never a null presented as 0).
  const usageWindows: { fiveHourPct: number | null; sevenDayPct: number | null; windowSource: 'cc-rate-limits' | 'calibrated' | 'calibrated-exceeded' | 'none' } =
    (rateLimits && (rateLimits.fiveHourUtilization !== null || rateLimits.sevenDayUtilization !== null))
      ? { fiveHourPct: rateLimits.fiveHourUtilization, sevenDayPct: rateLimits.sevenDayUtilization, windowSource: 'cc-rate-limits' }
      : (win && win.budget.capacityConfigured)
        ? {
            fiveHourPct: windowFillPct(win.budget.fiveHour), sevenDayPct: windowFillPct(win.budget.sevenDay),
            // A calibrated capacity that consumption has already PASSED yields a null pct — and a bare
            // 'calibrated' + null is indistinguishable from 'we have no data', which is a different
            // (and much less urgent) situation. Name the falsification so the reader knows the bound
            // is stale rather than absent.
            windowSource: (win.budget.fiveHour.capacityExceeded || win.budget.sevenDay.capacityExceeded)
              ? 'calibrated-exceeded' : 'calibrated',
          }
        : { fiveHourPct: null, sevenDayPct: null, windowSource: 'none' }

  const plan = account && account.source !== 'none' ? describePlan(account.planType, account.rateLimitTier) : 'unknown'
  const mode = describeAccountMode(authRegime)
  const cacheTtl = { minutes: ttlRegime.ttlAssumedMin, regime: authRegime ?? 'unknown', ttlSource: ttlRegime.ttlSource, basis: ttlRegime.ttlBasis }

  // One-line human digest — the "clean human-readable summary" the Part-5 directive asks for, sitting
  // alongside the structured fields so a reader gets the gist without parsing the object.
  const emailStr = account?.email ?? account?.label ?? 'account unresolved'
  const pct = (v: number | null) => v !== null ? `${Math.round(v)}%` : 'n/a'
  const summary = `${emailStr} · ${plan} · ${mode} · 5h ${pct(usageWindows.fiveHourPct)} / 7d ${pct(usageWindows.sevenDayPct)} (${usageWindows.windowSource}) · cache TTL ${cacheTtl.minutes}min (${cacheTtl.ttlSource})`

  return {
    summary,
    plan,
    mode,
    cacheTtl,
    usageWindows,
    account: account && account.source !== 'none'
      ? {
          accountId: account.accountUuid,
          label: account.label,
          email: account.email,
          organizationName: account.organizationName,
          planType: account.planType,                 // max | pro | team | enterprise | free (keychain)
          billingType: account.billingType,           // subscription (window-limited) | api (pay-per-token)
          hasExtraUsageEnabled: account.hasExtraUsageEnabled,  // opted into token billing past the window
          rateLimitTier: account.rateLimitTier,
        }
      : { planType: account?.planType ?? null, note: 'No ~/.claude.json oauthAccount found — identity unresolved.' },
    window: win
      ? {
          fiveHourPctConsumed: win.budget.fiveHour.pctConsumed,
          fiveHourPctConsumedCost: win.budget.fiveHour.pctConsumedCost,
          sevenDayPctConsumed: win.budget.sevenDay.pctConsumed,
          sevenDayPctConsumedCost: win.budget.sevenDay.pctConsumedCost,
          fiveHourMinutesToExhaustion: win.budget.fiveHour.minutesToExhaustion,
          sevenDayMinutesToExhaustion: win.budget.sevenDay.minutesToExhaustion,
          consumedTokens5h: win.budget.fiveHour.consumedTokens,
          consumedCostUsd5h: win.budget.fiveHour.consumedCostUsd,
          capacityConfigured: win.budget.capacityConfigured,
          // P5 — where the capacity came from: env/config (manual) or observed (auto-calibrated
          // from a real rate-limit hit, dated by capacityObservedAt).
          capacitySource: win.budget.capacitySource,
          capacityObservedAt: win.budget.capacityObservedAt,
        }
      : null,
    note: uuid == null
      ? 'Current account id is unresolved, so no per-account window could be matched. Enable OTEL raw bodies / metrics so sessions attribute to an account.'
      : win == null
        ? 'No consumption recorded yet for the current account in the rolling windows.'
        : (win.budget.capacityConfigured ? undefined
          : 'Window % is null until a capacity is configured (AGENTLENS_WINDOW_5H_TOKENS / _COST_USD or ~/.agentlens/burn-config.json) — or until AgentlensPro auto-calibrates one from the next rate-limit hit (P5).'),
  }
}

// Exported for unit tests. get_account_state_at (TRDD-YQZ9P8IL): the subscription state (account /
// mode / plan / cache-TTL regime) that was active at an arbitrary past instant, resolved by binary-
// searching the change-detected account-state timeline (~/.agentlens/account-state.ndjson). Accepts a
// ms-epoch `ts` OR an ISO-8601 `iso`. Reads the ndjson off disk directly — no server state needed.
export function handleGetAccountStateAt(args: { ts?: number; iso?: string }) {
  const t = typeof args.ts === 'number' ? args.ts : (args.iso ? Date.parse(args.iso) : NaN)
  if (!Number.isFinite(t)) {
    return { error: 'Provide `ts` (ms epoch) or `iso` (ISO-8601) — could not resolve a timestamp.' }
  }
  const atIso = new Date(t).toISOString()
  const state = resolveStateAt(t)
  return state
    ? { at: atIso, state }
    : { at: atIso, state: null, note: 'No account-state record precedes this timestamp — the timeline may not extend that far back (it starts when the server first observed a state), or no state has been recorded yet.' }
}

// Exported for unit tests. get_window_budget(accountId?): per-account budgets (labeled) + the pooled total.
export function handleGetWindowBudget(burn: BurnStatus | null, account: AccountInfo | null, args: { accountId?: string }) {
  if (!burn) { return { message: 'Burn monitor unavailable in this runtime (no live session/statusline source wired).' } }
  const labeled = burn.accountWindows.map(w => labelAccountWindow(w, account))
  const accounts = args.accountId ? labeled.filter(w => w.accountUuid === args.accountId) : labeled
  return {
    accounts,
    machineWide: burn.window,          // all accounts pooled — the pre-per-account view, kept for reference
    capacitySource: burn.window.capacitySource,
    // P5 — the calibration date when the capacity is an auto-observed lower bound (null otherwise).
    capacityObservedAt: burn.window.capacityObservedAt,
    ...(args.accountId && accounts.length === 0
      ? { message: `No consumption recorded for account ${args.accountId} in the rolling windows.` }
      : {}),
  }
}

// ── MCP Server factory ────────────────────────────────────────────────────────

export interface McpServerOptions {
  /** Returns the current session list. Called on every tool invocation. */
  getSessions: SessionAccessor
  /** Optionally load full timeline for a session (VS Code has this; standalone uses session.timeline). */
  getTimeline?: (sessionId: string) => unknown[]
  /** Optionally reconstruct the per-turn context composition from the raw Claude .jsonl (on demand).
   *  Wired in both the extension and the standalone server so the P4 inflation / cache-break tools
   *  return real data. Async because it streams a (possibly multi-GB) log file. */
  getComposition?: (sessionId: string) => Promise<ContextComposition | null>
  /** Optionally reconstruct the FULL per-step context history from the raw Claude .jsonl (on demand).
   *  Powers get_context_history — every block drillable to its actual text with per-block tokens +
   *  per-step usage/cost + a diff. Async because it streams a (possibly multi-GB) log file. */
  getHistory?: HistoryAccessor
  /** Optionally reconstruct the NARRATIVE conversation from the raw Claude .jsonl (TRDD-B22NYTOY).
   *  Powers get_conversation — verbatim ordered turns (prompts, replies, tool in/out pairs). */
  getConversation?: ConversationAccessor
  /** Optionally reconstruct the full literal context of ONE llm call from its raw OTEL request body
   *  (TRDD-ICHAVFCS). Powers get_call_context — the per-call drill target that works for OTEL-only
   *  sessions with no local .jsonl. Async because it reads the (possibly multi-MB) raw body file. */
  getCallContext?: CallContextAccessor
  /** Realtime burn status across all live sessions (TRDD-OG9PARZQ). Computed in the server/extension
   *  from the live sessions + statusline billing events; powers get_burn_status. */
  getBurnStatus?: BurnStatusAccessor
  /** One-call self-diagnostic for the caller's resolved session; powers get_session_status. */
  getSessionStatus?: SessionStatusAccessor
  /** TRDD-BURNWDGT — the current live OAuth account (identity + plan type). Powers get_account_status and
   *  labels the per-account window budgets in get_window_budget / get_burn_status. */
  getAccount?: AccountAccessor
  /** TRDD-VY1IUVUM Part-5 — the machine's resolved TTL context (auth regime + prompt-caching env
   *  overrides). Feeds get_account_status's cacheTtl summary field (classified for kind='main'). */
  getTtlContext?: () => TtlContext
  /** TRDD-VY1IUVUM Part-5 — Claude Code's own rate_limits.{five_hour,seven_day}.utilization, when the
   *  statusline build persists it into the usage log. null when absent or stale — get_account_status
   *  then falls back to AgentlensPro's own calibrated window pct (never presents a null as 0). */
  getRateLimits?: () => RateLimitsSnapshot | null
  /** TRDD-PJC8N1HO — collector downtime windows during which OTEL exports were dropped/lost. Returned
   *  by get_recent_sessions so an agent orienting itself sees explicit "telemetry lost HH:MM–HH:MM"
   *  gaps instead of assuming continuous coverage. */
  getCollectorGaps?: () => CollectorGap[]
  /** TRDD-GOD0108C — the server's in-memory hook-event ring (fed by POST /api/hook-events). When
   *  present, check_burn_risk reads it instead of the NDJSON buckets: zero disk on the hot path. */
  getRecentHookEvents?: () => HookEventRecord[]
  /** TRDD-GOD0108C — the server's BodiesActivityTracker report (incremental bodies scan). Powers
   *  the CACHE_THRASH risk and replaces the stat-every-file HUGE_REQUEST_BURST pass. */
  getBodiesActivity?: () => BodiesActivityReport | null
  /** TRDD-1FEIW17E — the server's durable body store (opened lazily). get_body_writers reads
   *  all-time per-session totals from it; a null/absent store degrades to live-dir-only. */
  getStore?: () => Promise<Store | null>
  /** TRDD-1XM0YSWQ — the burn monitor's deduped consumption-event stream (api_request events +
   *  statusline deltas). get_account_burners scopes it by account segment × window and ranks. */
  getConsumptionEvents?: () => ConsumptionEvent[]
}

export function createMcpServer(opts: McpServerOptions): Server {
  const server = new Server(
    { name: 'agentlens', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const sessions = opts.getSessions()
    const args = (req.params.arguments ?? {}) as Record<string, unknown>
    const getTimeline = opts.getTimeline ?? null
    const getComposition = opts.getComposition ?? null
    const getHistory = opts.getHistory ?? null
    const getConversation = opts.getConversation ?? null
    const getCallContext = opts.getCallContext ?? null
    const getBurnStatus = opts.getBurnStatus ?? null
    const getSessionStatus = opts.getSessionStatus ?? null
    const getAccount = opts.getAccount ?? null
    const getTtlContext = opts.getTtlContext ?? null
    const getRateLimits = opts.getRateLimits ?? null

    let result: unknown
    switch (req.params.name) {
      case 'get_recent_sessions': {
        // TRDD-PJC8N1HO: wrap the session list with the collector's downtime gaps so a caller sees
        // where telemetry was lost. Shape is now { sessions, collectorGaps } (was a bare array).
        const recent = handleGetRecentSessions(sessions, args as { limit?: number; agent?: string; workspace?: string })
        result = { sessions: recent, collectorGaps: opts.getCollectorGaps?.() ?? [] }
        break
      }
      case 'get_workspace_patterns':
        result = handleGetWorkspacePatterns(sessions, args as { workspace?: string; days?: number })
        break
      case 'get_account_burners': {
        const a = args as { account?: string; interval?: string; limit?: number }
        const nowMs = Date.now()
        const segments = readAccountSegments()
        if (segments.length === 0) {
          result = { error: 'No account-state timeline yet (~/.agentlens/account-state.ndjson) — the server records it on account changes; nothing to attribute against.' }
          break
        }
        const target = resolveTargetAccount(segments, a.account ?? 'previous', nowMs)
        if (!target) {
          result = { error: `No account matches '${a.account ?? 'previous'}' in the timeline. Known: ${[...new Set(segments.map(s => `${s.accountId.slice(0, 8)} (${s.email ?? '?'})`))].join(', ')}` }
          break
        }
        const { untilMs, error: intervalError } = resolveWindowUntil(a.interval ?? 'last', target, nowMs)
        if (intervalError) { result = { error: intervalError }; break }
        result = buildAccountBurnersReport({
          events: opts.getConsumptionEvents?.() ?? [],
          target,
          allSegments: segments,
          cards: sessions.map(s => ({ sessionId: s.sessionId, workspace: s.workspace, source: s.source, model: s.model })),
          untilMs, nowMs, limit: Math.max(1, a.limit ?? 15),
          observed: loadBurnConfig(process.env, os.homedir()).observed,
        })
        break
      }
      case 'get_window_eta': {
        const a = args as { account?: string; rate_window_min?: number }
        const nowMs = Date.now()
        const segments = readAccountSegments()
        if (segments.length === 0) {
          result = { error: 'No account-state timeline yet (~/.agentlens/account-state.ndjson) — nothing to project against.' }
          break
        }
        const target = resolveTargetAccount(segments, a.account ?? 'current', nowMs)
        if (!target) {
          result = { error: `No account matches '${a.account ?? 'current'}'. Known: ${[...new Set(segments.map(s => `${s.accountId.slice(0, 8)} (${s.email ?? '?'})`))].join(', ')}` }
          break
        }
        result = buildWindowEtaReport({
          events: opts.getConsumptionEvents?.() ?? [],
          target,
          allSegments: segments,
          nowMs,
          rateWindowMs: Math.max(1, a.rate_window_min ?? 30) * 60_000,
          observed: loadBurnConfig(process.env, os.homedir()).observed,
        })
        break
      }
      case 'get_body_writers': {
        const a = args as { window_min?: number; active_min?: number; limit?: number }
        const nowMs = Date.now()
        const windowMs = Math.max(1, a.window_min ?? 30) * 60_000
        const activeMs = Math.max(1, a.active_min ?? 10) * 60_000
        const live = scanLiveBodyWriters(defaultBodiesDir(), nowMs, windowMs)
        // Store totals are best-effort: a closed/broken store degrades to live-only (the note says
        // so) because "which sessions must I restart" must be answerable even mid-migration.
        const storeHandle = opts.getStore ? await opts.getStore().catch(() => null) : null
        // recentSrcNames floor: live retention is 72h, +24h slack covers every file still on disk.
        const totals = storeHandle
          ? await queryStoreWriterTotals(storeHandle, nowMs - 96 * 3600_000).catch(() => null)
          : null
        result = buildBodyWritersReport({
          live, store: totals,
          cards: sessions.map(s => ({ sessionId: s.sessionId, workspace: s.workspace, source: s.source })),
          nowMs, windowMs, activeMs, limit: Math.max(1, a.limit ?? 20),
        })
        break
      }
      case 'get_session_detail': {
        const id = (args as { sessionId: string }).sessionId
        // Composition is optional context — a null accessor or non-Claude session just omits it.
        const composition = getComposition ? await getComposition(id).catch(() => null) : null
        result = handleGetSessionDetail(sessions, getTimeline, composition, args as { sessionId: string })
        break
      }
      case 'find_relevant_context':
        result = handleFindRelevantContext(sessions, args as { task: string; workspace?: string })
        break
      case 'get_efficiency_report':
        result = handleGetEfficiencyReport(sessions, args as { workspace?: string; days?: number })
        break
      case 'get_instruction_suggestions':
        result = handleGetInstructionSuggestions(sessions, args as { workspace?: string })
        break
      case 'get_context_composition': {
        const id = (args as { sessionId: string }).sessionId
        const composition = getComposition ? await getComposition(id).catch(() => null) : null
        result = handleGetContextComposition(composition, args as { sessionId: string; turn?: number })
        break
      }
      case 'get_context_history': {
        const id = (args as { sessionId: string }).sessionId
        const history = getHistory ? await getHistory(id).catch(() => null) : null
        const card = sessions.find(x => x.sessionId === id)
        result = handleGetContextHistory(history, card, args as { sessionId: string; turn?: number; blockId?: string })
        break
      }
      case 'get_conversation': {
        const id = (args as { sessionId: string }).sessionId
        const conv = getConversation ? await getConversation(id).catch(() => null) : null
        result = handleGetConversation(conv, args as { sessionId: string; turn?: number; turnFrom?: number; turnTo?: number })
        break
      }
      case 'get_context_growth': {
        const id = (args as { sessionId: string }).sessionId
        const s = sessions.find(x => x.sessionId === id)
        result = s ? handleGetContextGrowth(s, asTimeline(getTimeline, id, s)) : { error: `Session ${id} not found.` }
        break
      }
      case 'get_cache_break_report':
        result = await handleGetCacheBreakReport(sessions, getTimeline, getComposition, args as { sessionId?: string; workspace?: string })
        break
      case 'get_context_inflation_report':
        result = await handleGetContextInflationReport(sessions, getComposition, getHistory, args as { sessionId?: string; workspace?: string })
        break
      case 'find_context_hogs':
        result = await handleFindContextHogs(sessions, getComposition, args as { scope?: string; topN?: number })
        break
      case 'get_subagent_tree':
        result = handleGetSubagentTree(sessions, args as { sessionId: string })
        break
      case 'get_agent_tokens':
        result = handleGetAgentTokens(sessions, getTimeline, args as { agentId: string; parentSessionId?: string })
        break
      case 'get_cost_by_cause':
        result = await handleGetCostByCause(sessions, getTimeline, args as { sessionId?: string; days?: number })
        break
      case 'get_call_context': {
        const a = args as { sessionId: string; requestId?: string; spanId?: string }
        const ctx = getCallContext
          ? await getCallContext(a.sessionId, { requestId: a.requestId, spanId: a.spanId }).catch(() => null)
          : null
        result = handleGetCallContext(ctx, a)
        break
      }
      case 'get_burn_status':
        // TRDD-BURNWDGT — label the per-account windows (email/org for the current account, short id
        // for rotated-away ones) so the caller sees WHICH account each budget belongs to.
        result = getBurnStatus
          ? labelBurnStatusAccounts(getBurnStatus(), getAccount?.() ?? null)
          : { message: 'Burn monitor unavailable in this runtime (no live session/statusline source wired).' }
        break
      case 'get_session_status':
        result = getSessionStatus
          ? getSessionStatus(args as { sessionId?: string; workspace?: string })
          : { message: 'Session status unavailable in this runtime (no live session/statusline source wired).' }
        break
      case 'get_account_status':
        // `all` reads only what is already on disk (the roster + the per-account usage archive), so it
        // needs none of the live-session accessors the singular form depends on and works with the
        // server cold — which is exactly when a rotator is asking.
        result = (args as { all?: boolean } | undefined)?.all === true
          ? listAllAccounts()
          : handleGetAccountStatus(
            getAccount?.() ?? null, getBurnStatus?.() ?? null,
            getTtlContext?.() ?? null, getRateLimits?.() ?? null,
          )
        break
      case 'check_cache_expiry':
        result = await handleCheckCacheExpiry(
          sessions, getTimeline, getTtlContext?.() ?? null,
          args as { sessionId?: string; all?: boolean; project?: string; thresholdMinutes?: number },
        )
        break
      case 'get_account_state_at':
        result = handleGetAccountStateAt(args as { ts?: number; iso?: string })
        break
      case 'get_window_budget':
        result = handleGetWindowBudget(getBurnStatus?.() ?? null, getAccount?.() ?? null, args as { accountId?: string })
        break
      case 'get_image_report': {
        const a = args as { scope?: string }
        result = await compositionIndex.imageReport(a.scope, projectResolver(sessions))
        break
      }
      case 'find_resident_blobs': {
        const a = args as { scope?: string; kind?: CompositionBlockKind; minTokens?: number; minResidentTurns?: number; topN?: number }
        result = await compositionIndex.findResidentBlobs(a.scope, { kind: a.kind, minTokens: a.minTokens, minResidentTurns: a.minResidentTurns, topN: a.topN }, projectResolver(sessions))
        break
      }
      case 'query_context_blocks': {
        const a = args as { project?: string; sessionId?: string; kind?: CompositionBlockKind; model?: string; minTokens?: number; turnFrom?: number; turnTo?: number; groupBy?: GroupBy; topN?: number }
        result = await compositionIndex.queryBlocks(
          { project: a.project, sessionId: a.sessionId, kind: a.kind, model: a.model, minTokens: a.minTokens, turnFrom: a.turnFrom, turnTo: a.turnTo, topN: a.topN },
          a.groupBy ?? 'kind',
          projectResolver(sessions),
        )
        break
      }
      case 'get_block_content': {
        const a = args as { sessionId: string; turn: number; blockIndex: number; full?: boolean }
        result = await compositionIndex.getBlockContent(a.sessionId, a.turn, a.blockIndex, { full: a.full })
        break
      }
      case 'get_cache_creation_report': {
        const a = args as { window?: number; groupBy?: CostPeakGroupBy; bucket?: CostBucket; topN?: number; format?: ForensicsFormat }
        // groupBy='cause' needs the full prefix-diff classifier (cacheBreakTimeline.ts's
        // buildCauseCostPeakReport, scanning EVERY session); every other dimension stays on the
        // lightweight response-only scan (buildCacheCreationReport). Both return the identical
        // CacheCreationReport shape, so formatCostPeaks renders either uniformly.
        const report = a.groupBy === 'cause'
          ? await buildCauseCostPeakReport({ windowHours: a.window, bucket: a.bucket, topN: a.topN })
          : await buildCacheCreationReport({ windowHours: a.window, groupBy: a.groupBy, bucket: a.bucket, topN: a.topN })
        result = formatCostPeaks(report, a.format ?? 'json')
        break
      }
      case 'trace_expensive_writes': {
        const a = args as {
          sessionId?: string; accountUuid?: string; model?: string; minCacheCreate?: number
          minOutputTokens?: number; turnFrom?: number; turnTo?: number; timeFrom?: string; timeTo?: string
          topN?: number; chainDepth?: number; window?: number; format?: ForensicsFormat
        }
        const trace = await buildExpensiveWritesTrace({
          sessionId: a.sessionId, accountUuid: a.accountUuid, model: a.model, minCacheCreate: a.minCacheCreate,
          minOutputTokens: a.minOutputTokens, turnFrom: a.turnFrom, turnTo: a.turnTo,
          timeFromIso: a.timeFrom, timeToIso: a.timeTo, topN: a.topN, chainDepth: a.chainDepth, windowHours: a.window,
        })
        result = formatExpensiveWrites(trace, a.format ?? 'json')
        break
      }
      case 'get_cache_break_gap_report': {
        const a = args as { minCacheCreate?: number; window?: number }
        result = await buildCacheBreakGapReport({ minCacheCreate: a.minCacheCreate, windowHours: a.window })
        break
      }
      case 'get_subscription_usage': {
        const a = args as { force?: boolean; format?: string }
        const usage = await getSubscriptionUsage({ force: a.force })
        result = (a.format ?? 'table') === 'json'
          ? (usage ?? { error: 'unavailable', reason: 'no_token_or_opt_in_required' })
          : { format: 'table', text: formatSubscriptionUsage(usage) }
        break
      }
      case 'get_cache_event_log': {
        const a = args as {
          mode?: CacheEventMode; project?: string; sessionId?: string
          context?: number; limit?: number; window?: number; format?: CacheEventFormat
        }
        const log = await buildCacheEventLog({
          mode: a.mode, project: a.project, sessionId: a.sessionId,
          contextEvents: a.context, limit: a.limit, windowHours: a.window,
        })
        result = formatCacheEventLog(log, a.format ?? 'table')
        break
      }
      case 'get_cache_break_timeline': {
        const a = args as { sessionId?: string; scope?: string; minTokens?: number; window?: number; topN?: number; format?: TimelineFormat }
        const report = await buildCacheBreakTimeline({ sessionId: a.sessionId, scope: a.scope, minTokens: a.minTokens, windowHours: a.window, topN: a.topN })
        result = formatTimeline(report, a.format ?? 'json')
        break
      }
      case 'get_skill_attribution': {
        const a = args as { window?: number; topN?: number }
        // Date.now() is fine here — mcpServer is not a Workflow script (that is the only place it is banned).
        const rep = buildAttributionReport({
          sinceMs: a.window ? Date.now() - a.window * 3_600_000 : undefined,
          topN: a.topN,
        })
        result = { ...rep, windowHours: a.window ?? null }
        break
      }
      case 'get_loaded_plugin_versions': {
        const a = args as { plugin?: string; activeMinutes?: number; staleOnly?: boolean }
        result = buildLoadedVersionsReport({ plugin: a.plugin, activeMinutes: a.activeMinutes, staleOnly: a.staleOnly })
        break
      }
      case 'get_cache_risk_costs': {
        result = await handleGetCacheRiskCosts(sessions, getTimeline, getComposition, args as { window?: number; minTokens?: number; topN?: number; workspace?: string; kinds?: string[] })
        break
      }
      case 'get_lifecycle_events': {
        const a = args as { session?: string; kinds?: string[]; window?: number; limit?: number }
        const dir = dataPath('hook-events')
        const dirExists = fs.existsSync(dir)
        // Date.now() is fine here — mcpServer is not a Workflow script (that is the only place it is banned).
        const sinceMs = a.window ? Date.now() - a.window * 3_600_000 : undefined
        const records = dirExists ? readHookEvents(dir, { session: a.session, sinceMs, limit: 1000 }) : []
        const events = extractLifecycleEvents(records, {
          session: a.session, kinds: a.kinds as LifecycleKind[] | undefined, limit: a.limit ?? 100,
        })
        result = {
          hookEventsDir: dir, dirExists, count: events.length, events,
          note: dirExists ? undefined
            : `No lifecycle hook-event store at ${dir} — run 'agentlenspro --install-hooks' then restart the session to capture /clear and other lifecycle events.`,
        }
        break
      }
      case 'check_burn_risk': {
        const a = args as { fanoutThreshold?: number; spikeTokensPerMin?: number }
        const report = checkBurnRisk({
          burnStatus: getBurnStatus?.() ?? null,
          fanoutThreshold: a.fanoutThreshold,
          spikeTokensPerMin: a.spikeTokensPerMin,
          // Hot-path injections (standalone server only): in-memory event ring + incremental
          // bodies tracker — the same call is gate-frequency there, so disk scans are out.
          recentEvents: opts.getRecentHookEvents?.(),
          bodiesActivity: opts.getBodiesActivity?.() ?? null,
        })
        // Name the verbatim spawning call behind an active fan-out risk (reads the JSONL only when a
        // risk fired — the quiet path never opens a transcript).
        await attachRiskCausingCalls(report)
        result = report
        break
      }
      case 'get_cost_rollup': {
        result = buildCostRollup(sessions, args as CostRollupArgs)
        break
      }
      case 'predict_session_cost': {
        result = predictSessionCost(sessions, args as unknown as PredictSessionCostArgs)
        break
      }
      case 'get_runtime_inventory': {
        result = buildRuntimeInventory()
        break
      }
      case 'get_rate_limit_report': {
        const a = args as { windowHours?: number; maxEpisodes?: number; maxFiles?: number }
        result = buildRateLimitReport({ windowHours: a.windowHours, maxEpisodes: a.maxEpisodes, maxFiles: a.maxFiles })
        break
      }
      case 'investigate_burn': {
        const a = args as { windowHours?: number; untilIso?: string; maxFiles?: number }
        const untilMs = a.untilIso ? Date.parse(a.untilIso) : undefined
        if (a.untilIso && !Number.isFinite(untilMs)) {
          result = { error: `untilIso "${a.untilIso}" is not a parseable ISO datetime` }
          break
        }
        {
          const inv = investigateBurn({ windowHours: a.windowHours, untilMs, maxFiles: a.maxFiles })
          // Name the VERBATIM tool-call behind each fan-out finding (reads the JSONL only for real
          // findings — a no-op on a blind/empty scan, so the fast path is untouched).
          await attachCausingCalls(inv)
          result = inv
        }
        break
      }
      case 'burn_seismic': {
        const a = args as {
          scope?: SeismicScope; workspace?: string; sessionId?: string; windowHours?: number
          bucketMinutes?: number; includeSubagents?: boolean; fdrAlpha?: number; fdrMethod?: 'bh' | 'by'
          pvalueEngine?: 'auto' | 'stochastic' | 'internal'; maxFiles?: number
          cfarReference?: number; cfarGuard?: number; cfarTrim?: number; cfarMinReference?: number
          rateLaw?: 'auto' | 'poisson'
        }
        const scope: SeismicScope = a.scope ?? 'fleet'
        if (scope === 'workspace' && !a.workspace) { result = { error: "scope='workspace' requires a workspace path" }; break }
        if (scope === 'session' && !a.sessionId) { result = { error: "scope='session' requires a sessionId" }; break }
        const windowHours = Math.min(72, Math.max(0.1, a.windowHours ?? 8))
        const sinceMs = Date.now() - windowHours * 3600_000
        const files = resolveSeismicFiles({
          scope, workspace: a.workspace, sessionId: a.sessionId, sinceMs,
          includeSubagents: a.includeSubagents, maxFiles: a.maxFiles,
        })
        const seismic = await burnSeismic({
          files, sinceIso: new Date(sinceMs).toISOString(), bucketMinutes: a.bucketMinutes,
          fdrAlpha: a.fdrAlpha, fdrMethod: a.fdrMethod, pvalueEngine: a.pvalueEngine,
          cfarReference: a.cfarReference, cfarGuard: a.cfarGuard,
          cfarTrim: a.cfarTrim, cfarMinReference: a.cfarMinReference, rateLaw: a.rateLaw,
          topEvents: 10, topSessions: 10,
        })
        // Ship the rendered report AND the structured result: the CLI prints `report` verbatim, an
        // MCP/API caller keeps the machine-readable fields. buckets[] is dropped from the wire form
        // (480+ rows) — the report + events/sessions already carry the signal.
        const { buckets: _buckets, ...wire } = seismic
        result = { report: renderBurnSeismic(seismic), ...wire }
        break
      }
      case 'get_heartbeat_cost': {
        const a = args as { marker?: string; sessionId?: string; window?: number; fire?: 'last-complete' | 'current' }
        result = await buildHeartbeatCost({ marker: a.marker, sessionId: a.sessionId, windowHours: a.window, fire: a.fire })
        break
      }
      case 'get_session_burn_profile': {
        const a = args as { sessionId?: string; window?: number }
        if (!a.sessionId) throw new Error('get_session_burn_profile requires sessionId')
        const profile = await buildSessionBurnProfile({ sessionId: a.sessionId, windowHours: a.window })
        // P7 provenance — the profile itself is body-scan derived; the served card (exact id, or
        // the unique-prefix match the tool accepts) carries which feed backs the session's token
        // figures. null = no card / pre-P7 card ("unknown"), never a guess.
        const card = sessions.find(s => s.sessionId === a.sessionId)
          ?? sessions.find(s => s.sessionId.startsWith(a.sessionId!))
        result = {
          ...profile,
          tokensSource: card?.tokensSource ?? null,
          ...(card?.coverageNote ? { coverageNote: card.coverageNote } : {}),
        }
        break
      }
      case 'get_cache_break_causes': {
        const a = args as { scope?: string; minTokens?: number; window?: number; topN?: number }
        result = await buildCacheBreakCauses({ scope: a.scope, minTokens: a.minTokens, windowHours: a.window, topN: a.topN })
        break
      }
      case 'compare_configs': {
        // TRDD-FB5RG4P1 — lazily (re)index the bounded fact slice, then rank configs. ensureFreshIndex
        // reuses cached facts inside a 5-min freshness window so only the first call pays the scan cost.
        const a = args as { groupBy?: GroupByDim; metric?: MetricKey; agg?: AggKey; filter?: CompareFilter; rankOrder?: 'worst-first' | 'best-first'; topN?: number }
        await ensureFreshIndex({ windowHours: (a.filter?.window) })
        result = await buildCompareConfigs(a)
        break
      }
      case 'run_diagnostics_sql': {
        const a = args as { preset?: string; sql?: string; params?: Record<string, unknown>; format?: SqlFormat; limit?: number }
        // Index only when actually querying (no args = list presets, which needs no fresh index).
        if (a.preset || a.sql) {
          const win = typeof a.params?.window === 'number' ? a.params.window : undefined
          await ensureFreshIndex({ windowHours: win })
        }
        result = await runDiagnosticsSql(a)
        break
      }
      case 'run_transcript_sql': {
        const a = args as { preset?: string; sql?: string; sessionId?: string; window?: number; limit?: number }
        result = await runTranscriptSql({
          preset: a.preset, sql: a.sql, sessionId: a.sessionId, windowHours: a.window, limit: a.limit,
        })
        break
      }
      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }], isError: true }
    }

    // TOKEN ECONOMY (single choke point — see leanResponse.ts): a tool result is re-read on EVERY later
    // turn of the caller's conversation, so a verbose payload is a permanent tax, not a one-time cost.
    // Every tool is therefore LEAN BY DEFAULT: verdict + the head of each ranked array + a one-line
    // coverage note, under a hard token ceiling, with truncation always disclosed. Pass verbosity:"full"
    // on any tool to get the untouched payload for a genuine deep drill.
    const verbosity = args.verbosity === 'full' ? 'full' : 'summary'
    const lean = leanify(result, { verbosity, maxTokens: typeof args.maxTokens === 'number' ? args.maxTokens : undefined })

    return {
      content: [{ type: 'text', text: JSON.stringify(lean) }],
    }
  })

  return server
}

// ── HTTP route handler ────────────────────────────────────────────────────────

/**
 * Handles a single HTTP request as an MCP endpoint.
 * Mount this on a route (e.g. `/mcp`) in your existing HTTP server.
 *
 * Each request gets its own transport instance (stateless per-request for
 * Streamable HTTP). The server instance is reused across requests.
 */
// 4 MB matches the standalone server's JSON-tool POST routes — tool-call requests are small; only
// hostile or broken clients exceed this.
const MCP_BODY_MAX_BYTES = 4 * 1024 * 1024

export function handleMcpRequest(
  server: Server,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  // Simple GET health check so opening the URL in a browser gives a clear response.
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', server: 'agentlens-mcp', transport: 'streamable-http', endpoint: req.url }))
    return
  }

  // Buffer and parse the body before passing to the transport — with a hard byte cap. MCP tool
  // calls are small JSON; without the cap a runaway or hostile client could grow the buffer until
  // the heap dies (every capped POST route in the standalone server guards this the same way, and
  // this was the one uncapped POST body on the machine). On overflow the socket is destroyed and
  // no handler runs — mirroring standalone readBodyCapped semantics.
  const chunks: Buffer[] = []
  let received = 0
  let overflowed = false
  req.on('data', (c: Buffer) => {
    received += c.length
    if (received > MCP_BODY_MAX_BYTES) { overflowed = true; req.destroy() }
    else chunks.push(c)
  })
  req.on('error', () => { /* transport error — never crash the endpoint */ })
  req.on('end', () => {
    if (overflowed) return
    const raw = Buffer.concat(chunks).toString()
    let parsedBody: unknown
    try { parsedBody = raw ? JSON.parse(raw) : undefined } catch { parsedBody = undefined }

    // X2E6OSWK: per-TOOL duration logging at the one choke point every tool call crosses. The HTTP
    // request log times POST /mcp but cannot say WHICH tool — and a WEDGED handler never finishes,
    // so a completion-only log can't name it either. The start line is the wedge-namer: the last
    // "tool <name> start" with no matching done line in the server log IS the culprit. 'close'
    // fires after a normal finish AND on client abort, so the done line covers errors too. Two
    // console writes per CLI-driven call — negligible volume (dashboard polling never hits /mcp).
    const body = parsedBody as { method?: string; params?: { name?: string } } | undefined
    const calledTool = body?.method === 'tools/call' ? body.params?.name : undefined
    if (calledTool) {
      const toolT0 = Date.now()
      console.log(`[AgentLens] tool ${calledTool} start`)
      res.once('close', () => {
        console.log(`[AgentLens] tool ${calledTool} done in ${Date.now() - toolT0}ms (status ${res.statusCode})`)
      })
    }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    // Close the transport when the RESPONSE is done, whatever path got it there. 'close' fires
    // after a normal finish AND on client abort, and attaching it BEFORE handling fixes two leaks
    // the previous shape had: on handleRequest rejection the transport was never closed, and on a
    // fast response 'finish' could fire before the success-path .then() attached its listener.
    res.once('close', () => { transport.close().catch(() => { /* already closed */ }) })
    server.connect(transport)
      .then(() => transport.handleRequest(req, res, parsedBody))
      .catch(err => {
        if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: String(err) })) }
        else res.end() // headers already streamed — end the response so 'close' fires and cleans up
      })
  })
}

// ── Standalone HTTP server ────────────────────────────────────────────────────

/**
 * Starts a dedicated HTTP server for the MCP endpoint.
 * Used when there is no existing HTTP server to attach to.
 */
export function startMcpHttpServer(
  opts: McpServerOptions,
  port: number,
  bindHost = '127.0.0.1',
): http.Server {
  const server = createMcpServer(opts)
  const httpServer = http.createServer((req, res) => {
    // ACAO only for same-origin/loopback origins — never the wildcard. MCP responses carry the
    // user's session data (prompts, costs, project paths), so ACAO:* let ANY browsed page read
    // them cross-origin — the same read-exfil class the UI server closed (TRDD-F6BM1BDI). The
    // policy is shared via src/httpOrigin.ts; non-browser clients send no Origin and are unaffected.
    //
    // NON-GOAL (WYC4KB50 #8): the TRDD-1ZH1D5EG viewer-role gate (X-Agentlens-Viewer) is wired into
    // the UI server ONLY, not here. That is deliberate: this endpoint binds loopback (127.0.0.1) and
    // is reached server-to-server by MCP clients (Claude Code, the CLI) — ai-maestro's reverse proxy
    // forwards the UI port, not this one, so no browser viewer reaches it. If a future deployment
    // ever proxies THIS port to untrusted viewers, it must add the viewer-role gate here too — the
    // loopback bind + origin check is the current containment, not a role check.
    setAllowedOriginCors(req, res)
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, mcp-session-id')
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
    // Refuse cross-origin browser mutations before any handler runs: a "simple" POST needs no
    // preflight, and POST /mcp EXECUTES a tool — a write side effect the blocked read can't undo.
    if (req.method !== 'GET' && req.method !== 'HEAD' && isDisallowedCrossOrigin(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'cross-origin request refused' }))
      return
    }
    handleMcpRequest(server, req, res)
  })
  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[AgentlensPro] Port ${port} (MCP) already in use — stop the process using it or set MCP_PORT=<other> to use a different port.`)
      process.exit(1)
    }
    throw err
  })
  httpServer.listen(port, bindHost)
  return httpServer
}
