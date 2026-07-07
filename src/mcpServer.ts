/**
 * AgentLens MCP server — exposes session history to Claude Code and other
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
import { calcTokenCostUsd } from './pricing'
import type {
  SessionSummaryCard, TimelineEntry, ContextComposition,
  CacheBreakReport, CacheBreakOffender, ContextHistory, CallContext,
} from './summarizers/summarizerTypes'
import { buildCacheBreakReport } from './cacheBreak'
import { listSessionFileIds } from './contextComposition'
import { generateSuggestions } from './instructionAdvisor'
import { readAllInstructionContent } from './instructionFiles'

// ── Session accessor ──────────────────────────────────────────────────────────

// Accepts either a live SessionRepository (VS Code extension) or a plain
// function returning the current session array (standalone).
export type SessionAccessor = () => SessionSummaryCard[]

// ── Cost helper ───────────────────────────────────────────────────────────────

function sessionCost(s: SessionSummaryCard): number {
  const cache = s.cacheReadTokens + (s.cacheCreateTokens ?? 0)
  // Two ingestion paths store inputTokens under DIFFERENT conventions (verified empirically against
  // live cards): OTEL cards store it INCLUDING cache (e.g. synth-ae58: in=10.23M, cache=10.20M,
  // uncached=32K), while LOG-derived fork/sub-agent cards store it RAW/cache-EXCLUDED (e.g. agent-aeb:
  // in=274, cache=3.52M). The old `inputTokens − cache` was right for OTEL but went hugely NEGATIVE for
  // forks (274−3.52M) — producing the −$83 / −$47 fork costs that HID the fleet-of-forks burn (each
  // fork re-bills the inherited multi-M-token parent transcript). Detection is EXACT, not a guess:
  // under includes-cache, inputTokens = cache + uncached ≥ cache ALWAYS, so `inputTokens < cache` can
  // ONLY be the raw convention, where the true uncached IS inputTokens. Normalizing here (cost is a
  // DERIVED value) fixes every MCP tool + the dashboard at one source, tolerant of both conventions.
  const uncached = s.inputTokens >= cache ? s.inputTokens - cache : s.inputTokens
  return calcTokenCostUsd(uncached, s.cacheReadTokens, s.cacheCreateTokens ?? 0, s.outputTokens, s.model)
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'get_recent_sessions',
    description:
      'Returns recent AgentLens session summaries — cost, turns, model, prompt excerpt, ' +
      'top tools used, loop signals. Use this to orient yourself to what has been worked ' +
      'on recently before starting a new task.',
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
      'prefix, forces repeated cache-creation. Use this to find the structural token sinks.',
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
      'injections, catalogs) ranked by cumulative token cost across a bounded window of sessions. ' +
      'Optional scope filters by workspace path prefix. The cross-session "what is costing me the ' +
      'most context everywhere" leaderboard.',
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
      'vs override), the spawning turn, rolled-up total tokens, and cost. Pass any node in the ' +
      'tree — the root is resolved automatically. Use this to see fleet cost and cold-start waste.',
    inputSchema: {
      type: 'object' as const,
      required: ['sessionId'],
      properties: {
        sessionId: { type: 'string', description: 'Any session in the tree (parent or child)' },
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
]

// ── Tool handlers ─────────────────────────────────────────────────────────────

function handleGetRecentSessions(
  sessions: SessionSummaryCard[],
  args: { limit?: number; agent?: string; workspace?: string },
) {
  let filtered = sessions
  if (args.agent)     filtered = filtered.filter(s => s.source === args.agent)
  if (args.workspace) filtered = filtered.filter(s => s.sessionId.includes(args.workspace!) || (s.userRequest ?? '').includes(args.workspace!))
  const limit = Math.min(args.limit ?? 10, 50)
  const top = filtered.slice(0, limit)
  return top.map(s => ({
    sessionId:   s.sessionId,
    date:        s.startTime.slice(0, 16).replace('T', ' '),
    agent:       s.source,
    model:       s.model,
    prompt:      s.userRequest ? s.userRequest.slice(0, 120) + (s.userRequest.length > 120 ? '…' : '') : null,
    turns:       s.totalLlmCalls,
    cost_usd:    +sessionCost(s).toFixed(4),
    durationMin: +(s.durationMs / 60000).toFixed(1),
    errors:      s.errors,
    topTools:    Object.entries(s.toolCounts ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t, n]) => `${t}×${n}`),
    loopSignals: (s.loopSignals ?? []).map(l => l.type),
    filesChanged: s.filesChanged?.slice(0, 5) ?? [],
  }))
}

function handleGetWorkspacePatterns(
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

  // Averages
  const totalCost  = filtered.reduce((s, sess) => s + sessionCost(sess), 0)
  const totalTurns = filtered.reduce((s, sess) => s + sess.totalLlmCalls, 0)
  const totalCache = filtered.reduce((s, sess) => s + sess.cacheHitRate, 0)
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
    avgCacheHitRate: +(totalCache / filtered.length * 100).toFixed(0) + '%',
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

function handleGetEfficiencyReport(
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
  const avgHit = recent.reduce((s, x) => s + x.cacheHitRate, 0) / recent.length
  const below70 = recent.filter(s => s.cacheHitRate < 0.7)
  const worstCache = [...recent]
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
      avgCacheHitRatePct: Math.round(avgHit * 100),
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
  const avgHit = filtered.reduce((a, s) => a + s.cacheHitRate, 0) / filtered.length
  if (avgHit < 0.8) {
    out.push({
      id:            'cache-efficiency',
      category:      'behavior',
      title:         'Improve prompt-cache hit rate',
      evidence:      `Average cache-hit rate across ${filtered.length} sessions is ${Math.round(avgHit * 100)}% (target ≥ 80%). A low hit rate re-bills the prompt prefix as cache_creation at full write rate.`,
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

// Per-turn context size + cache split from a session timeline. promptTokens is the FULL prompt that
// turn — inputTokens already includes cacheRead + cacheCreate (P1 accounting) — so newInput is the
// non-cached remainder. Turn 1 warms cold; later turns should be almost entirely cache-read.
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
      promptTokens:      a.input,
      cacheReadTokens:   a.read,
      cacheCreateTokens: a.create,
      newInputTokens:    Math.max(0, a.input - a.read - a.create),
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
    }))
}

type CompositionAccessor = (sessionId: string) => Promise<ContextComposition | null>
type HistoryAccessor = (sessionId: string) => Promise<ContextHistory | null>
type CallContextAccessor = (sessionId: string, sel: { requestId?: string; spanId?: string }) => Promise<CallContext | null>

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

function handleGetContextGrowth(s: SessionSummaryCard, timeline: TimelineEntry[]) {
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

async function handleGetCacheBreakReport(
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
  const merged = new Map<string, CacheBreakOffender>()
  let analyzed = 0
  for (const s of pool) {
    const report = await reportFor(s)
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
    topOffenders:       ranked.slice(0, 15).map(o => ({ ...o, wastedCostUsd: +o.wastedCostUsd.toFixed(4) })),
  }
}

async function handleGetContextInflationReport(
  sessions: SessionSummaryCard[],
  getComposition: CompositionAccessor | null,
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
  }
}

async function handleFindContextHogs(
  sessions: SessionSummaryCard[],
  getComposition: CompositionAccessor | null,
  args: { scope?: string; topN?: number },
) {
  if (!getComposition) return { error: 'Composition accessor unavailable — context-hog analysis needs local Claude logs.' }
  const scope = args.scope?.trim()
  const topN = Math.min(args.topN ?? 15, 50)
  const { pool, considered, withLog } = fileBackedPool(sessions, scope ? (s => (s.workspace ?? '').startsWith(scope) || s.sessionId.includes(scope)) : null, 25)
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
  return { scope: scope ?? 'all', sessionsConsidered: considered, sessionsWithLog: withLog, sessionsScanned: scanned, hogs }
}

function handleGetSubagentTree(sessions: SessionSummaryCard[], args: { sessionId: string }) {
  const s = sessions.find(x => x.sessionId === args.sessionId)
  if (!s) return { error: `Session ${args.sessionId} not found.` }
  const root = s.parentSessionId ? (sessions.find(x => x.sessionId === s.parentSessionId) ?? s) : s
  const children = subAgentChildren(sessions, root.sessionId)
  const rolledUpTokens = (root.inputTokens + root.outputTokens) + children.reduce((n, c) => n + c.totalTokens, 0)
  const rolledUpCost = +(sessionCost(root) + children.reduce((n, c) => n + c.cost_usd, 0)).toFixed(4)
  return {
    root: { sessionId: root.sessionId, model: root.model, ownTokens: root.inputTokens + root.outputTokens, ownCost_usd: +sessionCost(root).toFixed(4) },
    childCount:       children.length,
    children:         children.length > 0 ? children : [],
    rolledUpTokens,
    rolledUpCost_usd: rolledUpCost,
    note: children.length === 0 ? 'No sub-agent children recorded for this session.' : undefined,
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
  /** Optionally reconstruct the full literal context of ONE llm call from its raw OTEL request body
   *  (TRDD-ICHAVFCS). Powers get_call_context — the per-call drill target that works for OTEL-only
   *  sessions with no local .jsonl. Async because it reads the (possibly multi-MB) raw body file. */
  getCallContext?: CallContextAccessor
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
    const getCallContext = opts.getCallContext ?? null

    let result: unknown
    switch (req.params.name) {
      case 'get_recent_sessions':
        result = handleGetRecentSessions(sessions, args as { limit?: number; agent?: string; workspace?: string })
        break
      case 'get_workspace_patterns':
        result = handleGetWorkspacePatterns(sessions, args as { workspace?: string; days?: number })
        break
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
        result = await handleGetContextInflationReport(sessions, getComposition, args as { sessionId?: string; workspace?: string })
        break
      case 'find_context_hogs':
        result = await handleFindContextHogs(sessions, getComposition, args as { scope?: string; topN?: number })
        break
      case 'get_subagent_tree':
        result = handleGetSubagentTree(sessions, args as { sessionId: string })
        break
      case 'get_call_context': {
        const a = args as { sessionId: string; requestId?: string; spanId?: string }
        const ctx = getCallContext
          ? await getCallContext(a.sessionId, { requestId: a.requestId, spanId: a.spanId }).catch(() => null)
          : null
        result = handleGetCallContext(ctx, a)
        break
      }
      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }], isError: true }
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
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

  // Buffer and parse the body before passing to the transport.
  let raw = ''
  req.on('data', (chunk: Buffer) => { raw += chunk.toString() })
  req.on('end', () => {
    let parsedBody: unknown
    try { parsedBody = raw ? JSON.parse(raw) : undefined } catch { parsedBody = undefined }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    server.connect(transport)
      .then(() => transport.handleRequest(req, res, parsedBody))
      .then(() => { res.on('finish', () => { transport.close().catch(() => {}) }) })
      .catch(err => {
        if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: String(err) })) }
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
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, mcp-session-id')
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
    handleMcpRequest(server, req, res)
  })
  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[AgentLens] Port ${port} (MCP) already in use — stop the process using it or set MCP_PORT=<other> to use a different port.`)
      process.exit(1)
    }
    throw err
  })
  httpServer.listen(port, bindHost)
  return httpServer
}
