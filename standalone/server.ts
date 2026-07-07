/**
 * AgentLens standalone server — runs the dashboard outside VS Code.
 *
 * Three HTTP servers:
 *   OTLP_PORT (default 4318) — receives OTLP traces/logs from agents
 *   UI_PORT   (default 3000) — serves the dashboard and SSE
 *   MCP_PORT  (default 4316) — MCP endpoint for Claude Code and other agents
 */

import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { exec } from 'child_process'
import { summarizeSpans } from '../src/spanSummarizer'
import { calcTokenCostUsd } from '../src/pricing'
import { autoConfigureClaudeCode, autoConfigureCodex, autoConfigureCopilotStandalone } from '../src/autoConfigNode'
import { ensureTelemetryConfig } from '../src/telemetryConfig'
import { classifyOtlpPayload } from '../src/otlpParser'
import { startMcpHttpServer } from '../src/mcpServer'
import { resolveCallContext, callBodyRegistry } from '../src/rawBodyContext'
import { LogReader, type OpenCodeSqlFactory } from '../src/logReader'
import { readScratchFile } from '../src/generatedFiles'
import { StatuslineUsageReader } from '../src/statuslineUsage'
import { buildContextComposition, resolveLoggedAncestor } from '../src/contextComposition'
import { buildContextHistory } from '../src/contextHistory'
import { generateSuggestions } from '../src/instructionAdvisor'
import { detectInstructionFiles, appendSuggestion } from '../src/instructionFiles'
import type { Span } from '../src/types'
import type { SessionSummaryCard } from '../src/summarizers/summarizerTypes'

const OTLP_PORT  = parseInt(process.env.OTLP_PORT  ?? '4318')
const UI_PORT    = parseInt(process.env.UI_PORT    ?? '3000')
const MCP_PORT   = parseInt(process.env.MCP_PORT   ?? '4316')
const BIND_HOST  = process.env.BIND_HOST ?? '127.0.0.1'

const mediaDir  = path.join(__dirname, '..', 'media')
const DATA_DIR  = process.env.DATA_DIR ?? path.join(os.homedir(), '.agentlens')
const DATA_FILE = path.join(DATA_DIR, 'spans.json')

// ── Build id for browser live-reload ──────────────────────────────────────────
// A cheap fingerprint of the served bundles' mtimes, computed ONCE at startup. Pushed over the
// existing dashboard SSE in every update payload; the injected client snippet reloads the page when
// the id it loaded with no longer matches. So: edit code → esbuild rebuild → dev-server restarts the
// server → the reconnecting browser sees a new id and refreshes itself. Guarded (reloads only on a
// real change vs the id embedded at load) so it can never loop.
function computeBuildId(): string {
  let sig = ''
  for (const f of ['dashboard.js', 'sidebar.js', 'dashboard.css']) {
    try { sig += `${f}:${fs.statSync(path.join(mediaDir, f)).mtimeMs}|` } catch { /* missing bundle — skip */ }
  }
  return sig || String(Date.now())
}
const BUILD_ID = computeBuildId()

// ── Span store with file persistence ─────────────────────────────────────────

let spans: Span[] = []
let sseClients: http.ServerResponse[] = []

// Hard cap on the in-memory span buffer. Unlike SessionStore's time-window trim, the standalone
// keeps a flat span array to rebuild the whole session list on demand — so with the FULL telemetry
// firehose now enabled (logs + metrics + traces + raw-body events from every active Claude Code
// session) it grew UNBOUNDED and OOM-killed the process (JS heap exhausted at ~4GB after ~19 min:
// FATAL "Ineffective mark-compacts near heap limit"). Capping to the most-recent MAX_SPANS keeps
// recent sessions (what diagnosis needs) while the process stays bounded (~200k × ~1.6KB ≈ 320MB).
// Older OTEL-only sessions age out of memory; the proper DB-backed retention is a follow-up TRDD.
// Env override so a big machine can raise it: AGENTLENS_MAX_SPANS.
const MAX_SPANS = Math.max(10_000, Number(process.env.AGENTLENS_MAX_SPANS) || 200_000)

// Load persisted spans on startup — cap to the most-recent MAX_SPANS so a large historical
// spans.json (seen at 98MB) can't blow the heap on load either.
try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
  if (fs.existsSync(DATA_FILE)) {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8')
    const loaded = JSON.parse(raw) as Span[]
    spans = loaded.length > MAX_SPANS ? loaded.slice(-MAX_SPANS) : loaded
    console.log(`[AgentLens] Loaded ${spans.length} spans from ${DATA_FILE}${loaded.length > spans.length ? ` (capped from ${loaded.length})` : ''}`)
  }
} catch (e) {
  console.warn('[AgentLens] Could not load persisted data:', e)
}

// Debounced save — writes at most once per second under continuous ingestion
let saveTimer: ReturnType<typeof setTimeout> | null = null
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(spans)) } catch (e) {
      console.warn('[AgentLens] Could not save data:', e)
    }
  }, 1000)
}

function addSpan(span: Span) {
  if (span.receivedAt === undefined) span.receivedAt = Date.now()
  spans.push(span)
  // Bound the buffer so the firehose can't grow it without limit (the OOM fix above). Evict the
  // oldest overflow in one batch (amortized O(1)) rather than shift() per push. A ~5% slack above
  // MAX_SPANS avoids re-slicing on every single add once at the cap.
  if (spans.length > MAX_SPANS * 1.05) spans = spans.slice(-MAX_SPANS)
}

// ── Log file sessions ─────────────────────────────────────────────────────────

// Indexed by sessionId; OTEL-derived sessions (from spans) take precedence —
// when the same session ID appears in both, the OTEL version is used.
let logSessions: Map<string, SessionSummaryCard> = new Map()

function buildImportCardStandalone(raw: Record<string, unknown>): SessionSummaryCard {
  const num = (v: unknown, def = 0): number => (typeof v === 'number' ? v : def)
  const str = (v: unknown, def = ''): string => (typeof v === 'string' ? v : def)
  const arrStr = (v: unknown): string[] => (Array.isArray(v) ? v.filter(x => typeof x === 'string') as string[] : [])
  return {
    sessionId:         str(raw['sessionId']),
    traceId:           str(raw['traceId']),
    source:            (raw['source'] as SessionSummaryCard['source']) ?? 'claude_code',
    dataSource:        'log',
    workspace:         str(raw['workspace']),
    userRequest:       str(raw['userRequest']),
    model:             str(raw['model']),
    turns:             num(raw['turns']),
    totalLlmCalls:     num(raw['turns']),
    totalToolCalls:    num(raw['totalToolCalls']),
    inputTokens:       num(raw['inputTokens']),
    outputTokens:      num(raw['outputTokens']),
    cacheReadTokens:   num(raw['cacheReadTokens']),
    cacheCreateTokens: num(raw['cacheCreateTokens']),
    cacheHitRate:      num(raw['cacheHitRate']),
    durationMs:        num(raw['durationMs']),
    startTime:         str(raw['startTime'], new Date().toISOString()),
    filesRead:         arrStr(raw['filesRead']),
    filesChanged:      arrStr(raw['filesChanged']),
    filesSearched:     [],
    filesWritten:      [],
    toolCounts:        (typeof raw['toolCounts'] === 'object' && raw['toolCounts'] !== null ? raw['toolCounts'] : {}) as Record<string, number>,
    errors:            num(raw['errors']),
    outcome:           (raw['outcome'] as SessionSummaryCard['outcome']) ?? 'unknown',
    timeline:          [],
    backgroundSpans:   [],
    loopSignals:       Array.isArray(raw['loopSignals']) ? raw['loopSignals'] as SessionSummaryCard['loopSignals'] : [],
  }
}

let logReader = new LogReader()
// P7: overlays authoritative context size + cost from the Claude Code statusline usage log onto each
// card before it is served. No-op for sessions/agents that wrote no statusline line.
const statuslineReader = new StatuslineUsageReader()

// ── MCP server ────────────────────────────────────────────────────────────────

// Dedicated server on MCP_PORT (default 4316) — same port as the VS Code extension.
// Fire-and-forget: the HTTP MCP server keeps itself alive via its own listeners; we don't hold the
// handle (nothing shuts it down before process exit), so we don't bind it (avoids an unused-local).
startMcpHttpServer({
  getSessions: () => {
    const summary = buildSessionSummary()
    return summary?.sessions ?? []
  },
  // The standalone cards already carry their inline timeline (log-parsed), so the MCP diagnostics
  // read per-turn tokens off the card; composition is reconstructed on demand from the raw .jsonl —
  // the same route /api/composition/:id serves the browser. This makes the P4 inflation / cache-break
  // tools return real data over the in-session MCP (http://localhost:4316/mcp).
  getComposition: (id) => {
    // Reconstruct a fork/sub-agent (no own .jsonl) from the nearest LOGGED ancestor so the MCP
    // context-composition / cache-break tools drill too — walking the chain, not just one hop.
    const sess = buildSessionSummary()?.sessions ?? []
    const parentOf = (sid: string): string | undefined => sess.find(s => s.sessionId === sid)?.parentSessionId
    return buildContextComposition(id, resolveLoggedAncestor(id, parentOf) ?? parentOf(id))
  },
  // P8: full per-step context history (every block drillable to actual text + diff). Same fork/ancestor
  // fallback as getComposition so a fork/sub-agent reconstructs from its parent transcript.
  getHistory: (id) => {
    const sess = buildSessionSummary()?.sessions ?? []
    const parentOf = (sid: string): string | undefined => sess.find(s => s.sessionId === sid)?.parentSessionId
    return buildContextHistory(id, resolveLoggedAncestor(id, parentOf) ?? parentOf(id))
  },
  // TRDD-ICHAVFCS: resolve a call (sessionId + requestId/spanId) to its full literal context tree,
  // reconstructed from the raw OTEL request body indexed by the collector. Works for OTEL-only sessions.
  getCallContext: (sessionId, sel) => resolveCallContext(sessionId, sel),
}, MCP_PORT, BIND_HOST)

function runLogScan() {
  const results = logReader.scan()
  // logReader.scan() returns ONLY sessions whose byte offset advanced (incremental tail — unchanged
  // files return null), so `changedCards` is exactly the set that grew this scan. That set drives
  // the immediate targeted push below; the heavier full-summary rebuild stays coalesced.
  const changedCards: SessionSummaryCard[] = []
  for (const { card, childCards } of results) {
    statuslineReader.overlay(card)
    logSessions.set(card.sessionId, card)
    changedCards.push(card)
    for (const child of childCards ?? []) { logSessions.set(child.sessionId, child); changedCards.push(child) }
  }
  if (changedCards.length > 0) {
    pushSessionChanged(changedCards)   // TRDD-U0UYC38A: targeted, immediate — sub-second drill refresh
    schedulePushUpdate()               // authoritative full refresh (sidebar/analytics, OTEL-wins) — coalesced
  }
}

// Debounced scan triggered by fs.watch events — fires 300 ms after the last event.
let watchScanTimer: ReturnType<typeof setTimeout> | null = null
function scheduleWatchScan() {
  if (watchScanTimer) clearTimeout(watchScanTimer)
  watchScanTimer = setTimeout(() => { watchScanTimer = null; runLogScan() }, 300)
}

function setupLogWatcher() {
  for (const dir of logReader.getWatchDirs()) {
    try {
      fs.watch(dir, { recursive: true, persistent: false }, scheduleWatchScan)
    } catch { /* dir may not exist yet — poll will cover it */ }
  }
}

async function startLogIngestion() {
  // Initialize sql.js so we can read the OpenCode SQLite DB.
  try {
    const sqlJsDir = path.dirname(require.resolve('sql.js'))
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const initSqlJs = require('sql.js') as (cfg: { locateFile: (f: string) => string }) => Promise<OpenCodeSqlFactory>
    const sqlFactory = await initSqlJs({ locateFile: (f: string) => path.join(sqlJsDir, f) })
    logReader = new LogReader({ log: (msg) => console.log(msg), sqlFactory })
  } catch { /* no sql.js — OpenCode falls back to JSON */ }

  // Register the poll first so it always runs, even if no files exist yet at startup.
  setInterval(runLogScan, 5_000)
  // Watch log directories for file-system events so updates appear immediately,
  // without waiting for the next poll interval.
  setupLogWatcher()
  console.log('[AgentLens] Log ingestion enabled — scanning local session files')

  const AGENT_KEY_LABEL: Record<string, string> = {
    claude:               'Claude Code',
    codex:                'Codex',
    copilot:              'Copilot CLI',
    copilot_vscode:       'Copilot (VS Code)',
    copilot_vscode_json:  'Copilot (VS Code)',
    opencode:             'OpenCode',
  }
  const AGENT_KEY_DIR: Record<string, string> = {
    claude:               '~/.claude/projects/',
    codex:                '~/.codex/sessions/',
    copilot:              '~/.copilot/session-state/',
    copilot_vscode:       '~/Library/…/workspaceStorage/',
    copilot_vscode_json:  '~/Library/…/workspaceStorage/',
    opencode:             '~/.local/share/opencode/',
  }

  const countByKey = new Map<string, number>()

  // OpenCode: one DB file = many sessions, handled separately.
  const ocResults = logReader.scanOpenCode()
  for (const { card } of ocResults) {
    logSessions.set(card.sessionId, card)
    countByKey.set('opencode', (countByKey.get('opencode') ?? 0) + 1)
  }

  // Run the initial batch synchronously so logSessions is populated before the
  // browser's first HTTP request. The setImmediate approach deferred this past
  // the first page load, causing a blank screen on startup.
  let files: ReturnType<typeof logReader.collectFileMeta>
  try { files = logReader.collectFileMeta() } catch { return }

  for (const file of files) {
    if (file.agentKey === 'opencode') continue  // already handled above
    try {
      const result = logReader.parseFile(file.filePath, file.agentKey)
      if (result) {
        statuslineReader.overlay(result.card)
        logSessions.set(result.card.sessionId, result.card)
        for (const child of result.childCards ?? []) logSessions.set(child.sessionId, child)
        countByKey.set(file.agentKey, (countByKey.get(file.agentKey) ?? 0) + 1)
      }
    } catch { /* skip bad file */ }
  }

  // Merge copilot_vscode and copilot_vscode_json into one display row
  const displayCounts = new Map<string, { label: string; dir: string; count: number }>()
  for (const [key, count] of countByKey) {
    const displayKey = key === 'copilot_vscode_json' ? 'copilot_vscode' : key
    const existing = displayCounts.get(displayKey)
    if (existing) { existing.count += count } else {
      displayCounts.set(displayKey, { label: AGENT_KEY_LABEL[key] ?? key, dir: AGENT_KEY_DIR[key] ?? key, count })
    }
  }

  const total = [...displayCounts.values()].reduce((s, v) => s + v.count, 0)
  if (total === 0) return
  const lines = [...displayCounts.values()]
    .sort((a, b) => b.count - a.count)
    .map(v => `  ${v.label.padEnd(20)} ${String(v.count).padStart(4)}  (${v.dir})`)
    .join('\n')
  console.log(`[AgentLens] Loaded ${total} sessions from local logs:\n${lines}`)
  // Push loaded sessions to any SSE clients that connected before the scan finished.
  schedulePushUpdate()
}

// ── OTLP parsing ──────────────────────────────────────────────────────────────

type RawAttr = { key: string; value: Record<string, unknown> }

function toAttrs(raw: unknown): RawAttr[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((a): a is RawAttr => {
    const o = a as Record<string, unknown>
    return typeof o.key === 'string' && typeof o.value === 'object' && o.value !== null
  })
}

function attrStr(attrs: RawAttr[], ...keys: string[]): string {
  for (const key of keys) {
    const a = attrs.find(x => x.key === key)
    if (!a) continue
    const v = a.value
    const s = v.stringValue ?? v.intValue ?? v.doubleValue
    if (s != null) return String(s)
  }
  return ''
}

function isCodexWebsocketSpanName(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.startsWith('codex.') && lower.includes('websocket')
}

function isCodexWebsocketTraceSpan(name: string, attrs: RawAttr[]): boolean {
  const lower = name.toLowerCase()
  if (!lower.includes('websocket')) return false
  const eventName = attrStr(attrs, 'event.name', 'event_name', 'name', 'event').toLowerCase()
  const hasCodexAttr = Boolean(attrStr(attrs, 'codex.session.id', 'codex.conversation.id', 'codex.turn.id'))
  return lower.startsWith('codex.') || eventName.startsWith('codex.') || hasCodexAttr
}

function attrsFromBodyKv(body: unknown): RawAttr[] {
  if (typeof body !== 'object' || body === null) return []
  const obj = body as Record<string, unknown>
  const kv = obj.kvlistValue as Record<string, unknown> | undefined
  const values = kv?.values
  if (!Array.isArray(values)) return []
  const attrs: RawAttr[] = []
  for (const value of values) {
    const entry = value as Record<string, unknown>
    const key = typeof entry.key === 'string' ? entry.key : ''
    const attrValue = entry.value as Record<string, unknown> | undefined
    if (!key || typeof attrValue !== 'object' || attrValue === null) continue
    attrs.push({ key, value: attrValue })
  }
  return attrs
}

function mergeAttrs(...lists: RawAttr[][]): RawAttr[] {
  const out: RawAttr[] = []
  const seen = new Set<string>()
  for (const list of lists) {
    for (const attr of list) {
      if (seen.has(attr.key)) continue
      seen.add(attr.key)
      out.push(attr)
    }
  }
  return out
}

function agentLabelFromSpanName(name: string): string {
  if (name.startsWith('claude_code.')) return 'Claude Code'
  if (name.startsWith('codex.'))       return 'Codex'
  if (name === 'invoke_agent' || name.startsWith('copilot.')) return 'Copilot'
  return 'unknown'
}

function processTraces(payload: unknown, collectorPath = '/v1/traces'): { count: number; agent: string } {
  const p = payload as { resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: unknown[] }> }> }
  const rawSpans = p?.resourceSpans?.flatMap(rs =>
    rs.scopeSpans?.flatMap(ss => ss.spans ?? []) ?? []
  ) ?? []
  let count = 0
  let agent = 'unknown'
  for (const raw of rawSpans) {
    const s = raw as Record<string, unknown>
    if (typeof s.traceId !== 'string' || typeof s.spanId !== 'string' || typeof s.name !== 'string') continue
    let attrs = toAttrs(s.attributes)
    if (isCodexWebsocketTraceSpan(s.name, attrs)) continue
    if (agent === 'unknown') agent = agentLabelFromSpanName(s.name)
    attrs = [...attrs, { key: '_agentlens.collector_path', value: { stringValue: collectorPath } }]
    addSpan({
      traceId: s.traceId,
      spanId: s.spanId,
      parentSpanId: (s.parentSpanId as string) || undefined,
      name: s.name,
      startTime: s.startTimeUnixNano as string,
      endTime: s.endTimeUnixNano as string,
      attributes: attrs,
      status: s.status as { code: number; message?: string } | undefined,
    })
    count++
  }
  return { count, agent }
}

function processLogs(payload: unknown, collectorPath = '/v1/logs'): number {
  type SL = { logRecords?: unknown[] }
  type RL = { scopeLogs?: SL[]; resource?: { attributes?: unknown } }
  const p = payload as { resourceLogs?: RL[] }
  const fallback = `codex-${Date.now()}`
  let n = 0
  for (const rl of p?.resourceLogs ?? []) {
    const resourceAttrs = toAttrs(rl.resource?.attributes)
    for (const sl of rl.scopeLogs ?? []) {
      const scopeAttrs = toAttrs((sl as { scope?: { attributes?: unknown } }).scope?.attributes)
      for (const rec of sl.logRecords ?? []) {
        const r = rec as Record<string, unknown>
        const attrs = mergeAttrs(toAttrs(r.attributes), attrsFromBodyKv(r.body), scopeAttrs, resourceAttrs)
        const name = attrStr(attrs, 'event.name', 'event_name', 'name', 'event')
        // TRDD-ICHAVFCS: index pointers to the raw API request/response bodies (OTEL_LOG_RAW_API_BODIES)
        // so a call can be resolved to its body file and its full context tree reconstructed on demand.
        // Store only the lightweight pointer — never the multi-MB body — then skip (no timeline value).
        if (name === 'claude_code.api_request_body' || name === 'claude_code.api_response_body') {
          const sid = attrStr(attrs, 'session.id', 'session_id')
          const bodyRef = attrStr(attrs, 'body_ref', 'body.ref', 'bodyRef')
          const inlineBody = attrStr(attrs, 'body')
          if (sid && (bodyRef || inlineBody)) {
            callBodyRegistry.record(sid, {
              kind: name === 'claude_code.api_request_body' ? 'request' : 'response',
              bodyRef: bodyRef || undefined,
              inlineBody: bodyRef ? undefined : (inlineBody || undefined),
              requestId: attrStr(attrs, 'request_id', 'request.id', 'requestId') || undefined,
              spanId: (typeof r.spanId === 'string' && r.spanId ? r.spanId : attrStr(attrs, 'span_id', 'spanId')) || undefined,
              model: attrStr(attrs, 'model') || undefined,
              querySource: attrStr(attrs, 'query_source', 'query.source') || undefined,
              ts: Date.now(),
            })
          }
          continue
        }
        const logToolName = attrStr(attrs, 'tool.name')
        const isCodexEvent = name.startsWith('codex.')
        const isClaudeToolResult = name === 'tool_result' && logToolName !== ''
        if (!isCodexEvent && !isClaudeToolResult) continue
        if (isCodexEvent && isCodexWebsocketSpanName(name)) continue
        let traceId: string
        let spanName: string
        if (isClaudeToolResult) {
          traceId = (typeof r.traceId === 'string' && r.traceId)
            ? r.traceId
            : attrStr(attrs, 'session.id', 'session_id') || fallback
          spanName = 'claude_code.tool_result'
        } else {
          traceId = (typeof r.traceId === 'string' && r.traceId)
            ? r.traceId
            : attrStr(attrs, 'conversation.id', 'conversation_id', 'session.id', 'session_id') || fallback
          spanName = name
        }
        const spanId = (typeof r.spanId === 'string' && r.spanId)
          ? r.spanId
          : attrStr(attrs, 'span_id', 'spanId') || `cl-${Math.random().toString(36).slice(2, 10)}`
        let startTime = String(r.timeUnixNano ?? r.observedTimeUnixNano ?? '0')
        let endTime = startTime
        if (startTime === '0') {
          const timestamp = attrStr(attrs, 'event.timestamp')
          const ms = timestamp ? new Date(timestamp).getTime() : 0
          if (ms > 0) {
            const endNs = String(BigInt(ms) * BigInt(1_000_000))
            const durMs = parseInt(attrStr(attrs, 'duration_ms') || '0') || 0
            endTime = endNs
            startTime = durMs > 0
              ? String(BigInt(endNs) - BigInt(durMs) * BigInt(1_000_000))
              : endNs
          }
        }
        addSpan({ traceId, spanId, name: spanName, startTime, endTime, attributes: [...attrs, { key: '_agentlens.collector_path', value: { stringValue: collectorPath } }], status: undefined })
        n++
      }
    }
  }
  return n
}

// ── SSE push ──────────────────────────────────────────────────────────────────

function safeJson(data: unknown): string {
  return JSON.stringify(data)
    .replace(/<\//g, '<\\/')
    .replace(/<!--/g, '<\\!--')
    .replace(/\$\{/g, '\\${')
}

function computeSidebarPayload(summary: ReturnType<typeof summarizeSpans>, allSpans: Span[]) {
  const sessions = summary.sessions
  // newest-first (summarizeSpans returns in arbitrary order — sort by startTime)
  const sorted = [...sessions].sort((a, b) =>
    Date.parse(b.startTime || '0') - Date.parse(a.startTime || '0')
  )
  const latest = sorted[0] ?? null

  const AGENT_ORDER = ['copilot', 'claude_code', 'codex']
  const agentSources = [...new Set(sorted.map(s => s.source).filter(Boolean))]
    .sort((a, b) => {
      const ai = AGENT_ORDER.indexOf(a), bi = AGENT_ORDER.indexOf(b)
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
    })

  // Activity: most recent span received
  let lastMs = 0
  for (const span of allSpans) {
    const ms = span.receivedAt ?? 0
    if (ms > lastMs) lastMs = ms
  }
  const isActive = lastMs > 0 && (Date.now() - lastMs) < 20_000

  // Turn input tokens for sparkline from timeline
  const turnInputTokens = latest
    ? (latest.timeline ?? [])
        .filter(e => e.type === 'llm' && (e.inputTokens ?? 0) > 0)
        .map(e => e.inputTokens ?? 0)
    : []

  // Simple burn rate estimate for active sessions
  let burnRate: { tokensPerMinute: number; costPerHour: number } | null = null
  if (latest && isActive && latest.durationMs > 10_000) {
    const totalTokens = latest.inputTokens + latest.outputTokens
    const tpm = (totalTokens / latest.durationMs) * 60_000
    burnRate = { tokensPerMinute: Math.round(tpm), costPerHour: 0 }
  }

  const avgInputTokens = sorted.length > 0
    ? sorted.reduce((s, x) => s + x.inputTokens, 0) / sorted.length : 1
  const avgOutputTokens = sorted.length > 0
    ? sorted.reduce((s, x) => s + x.outputTokens, 0) / sorted.length : 1

  const currentSession = latest ? {
    source: latest.source,
    model: latest.model || '',
    userRequest: latest.userRequest || '',
    totalLlmCalls: latest.totalLlmCalls,
    totalToolCalls: latest.totalToolCalls,
    errors: latest.errors,
    cacheHitRate: latest.cacheHitRate,
    durationMs: latest.durationMs,
    startTime: latest.startTime,
    turnInputTokens,
    inputTokens: latest.inputTokens,
    outputTokens: latest.outputTokens,
    cacheReadTokens: latest.cacheReadTokens,
    cacheCreateTokens: latest.cacheCreateTokens,
    costUsd: calcTokenCostUsd(
      Math.max(0, latest.inputTokens - latest.cacheReadTokens - latest.cacheCreateTokens),
      latest.cacheReadTokens,
      latest.cacheCreateTokens,
      latest.outputTokens,
      latest.model,
    ),
  } : null

  return { isActive, lastActivityMs: lastMs, sessionCount: sessions.length, agentSources, currentSession, burnRate, avgInputTokens, avgOutputTokens }
}

// Legacy shape kept for data the Preact dashboard still reads
function computeSidebarData(summary: ReturnType<typeof summarizeSpans>, _allSpans: Span[]) {
  const sessions = summary.sessions

  const filesSet = new Set<string>()
  let errorCount = 0
  for (const sess of sessions) {
    for (const f of sess.filesChanged) filesSet.add(f)
    errorCount += sess.errors
  }
  const cacheHitPct = sessions.length > 0
    ? Math.round(sessions.reduce((a, s) => a + s.cacheHitRate, 0) / sessions.length * 100) : 0
  const avgTurns = sessions.length > 0
    ? Math.round(sessions.reduce((a, s) => a + s.totalLlmCalls, 0) / sessions.length * 10) / 10 : 0

  const AGENT_KEY_ORDER = ['copilot', 'claude_code', 'codex']
  const agentSources = [...new Set(sessions.map(s => s.source).filter(Boolean))].sort((a, b) => {
    const ai = AGENT_KEY_ORDER.indexOf(a), bi = AGENT_KEY_ORDER.indexOf(b)
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
  })

  const totalToolCalls = sessions.reduce((s, sess) => s + sess.totalToolCalls, 0)
  const latest = sessions.length > 0 ? sessions[sessions.length - 1] : null
  const latestSession = latest ? {
    source: latest.source,
    model: latest.model || '',
    totalLlmCalls: latest.totalLlmCalls,
    totalToolCalls: latest.totalToolCalls,
    durationMs: latest.durationMs,
    errors: latest.errors,
    cacheHitRate: latest.cacheHitRate,
  } : null

  return {
    sessionCount: sessions.length,
    turnCount: sessions.reduce((s, sess) => s + sess.totalLlmCalls, 0),
    totalInputTokens: sessions.reduce((s, sess) => s + sess.inputTokens, 0),
    totalOutputTokens: sessions.reduce((s, sess) => s + sess.outputTokens, 0),
    filesChangedCount: filesSet.size,
    errors: errorCount,
    totalToolCalls,
    cacheHitPct,
    avgTurns,
    agentSources,
    latestSession,
  }
}

function computeAnalyticsData(sessions: ReturnType<typeof summarizeSpans>['sessions']) {
  const dayMap: Record<string, { totalTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number; costUsd: number; sessionCount: number }> = {}
  for (const sess of sessions) {
    if (!sess.startTime) continue
    const d = new Date(sess.startTime)
    if (isNaN(d.getTime())) continue
    const day = d.toISOString().slice(0, 10)
    if (!dayMap[day]) dayMap[day] = { totalTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: 0, sessionCount: 0 }
    const r = dayMap[day]
    r.totalTokens += sess.inputTokens
    r.outputTokens += sess.outputTokens
    r.cacheReadTokens += sess.cacheReadTokens
    r.cacheCreateTokens += sess.cacheCreateTokens
    r.sessionCount++
  }
  const dailyStats = Object.entries(dayMap).map(([day, r]) => ({ day, ...r })).sort((a, b) => a.day.localeCompare(b.day))
  const totalTokens = sessions.reduce((s, sess) => s + sess.inputTokens + sess.outputTokens, 0)
  const times = sessions.map(s => s.startTime ? new Date(s.startTime).getTime() : 0).filter(t => t > 0)
  const lifetimeStats = {
    totalSessions: sessions.length,
    totalTokens,
    totalCostUsd: 0,
    oldestSessionMs: times.length > 0 ? Math.min(...times) : 0,
    newestSessionMs: times.length > 0 ? Math.max(...times) : 0,
  }
  return { dailyStats, lifetimeStats }
}

function buildSessionSummary(): ReturnType<typeof summarizeSpans> | null {
  let summary: ReturnType<typeof summarizeSpans> | null = null
  try { summary = summarizeSpans(spans) } catch (e) { console.warn('[AgentLens] summarizeSpans error:', e) }

  // Merge log-sourced sessions; OTEL wins on ID collision.
  if (logSessions.size > 0) {
    const otelIds = new Set((summary?.sessions ?? []).map(s => s.sessionId))
    const logOnly = [...logSessions.values()].filter(s => !otelIds.has(s.sessionId))
    if (logOnly.length > 0) {
      const merged = [...logOnly, ...(summary?.sessions ?? [])]
        .sort((a, b) => Date.parse(b.startTime || '0') - Date.parse(a.startTime || '0'))
      summary = { ...(summary ?? { backgroundSpans: [], efficiency: { totalInputTokens: 0, totalOutputTokens: 0, totalLlmCalls: 0, avgInputPerCall: 0, avgTtft: 0, cacheHitRate: 0, toolDefWaste: 0, sysInstructionWaste: 0, topTokenConsumers: [] } }), sessions: merged }
    }
  }
  return summary
}

// Drop the heavy per-session detail (full timeline + per-file ops) from the inlined/broadcast
// payload — across thousands of sessions these add up to tens of MB and freeze the browser on
// first paint. Both are fetched lazily per session via /api/timeline/:id (loadSessionDetail).
function stripSessionDetail(summary: ReturnType<typeof summarizeSpans> | null): ReturnType<typeof summarizeSpans> | null {
  if (!summary) return null
  return { ...summary, sessions: summary.sessions.map(s => ({ ...s, timeline: [], fileOps: undefined, generatedFiles: undefined, generatedFilesTruncated: undefined })) }
}

function buildUpdatePayload(): string {
  const sessionSummary = buildSessionSummary()
  const stripped = stripSessionDetail(sessionSummary)
  const sidebar = sessionSummary ? computeSidebarData(sessionSummary, spans) : null
  const sidebarLive = sessionSummary ? computeSidebarPayload(sessionSummary, spans) : null
  const analyticsData = sessionSummary ? computeAnalyticsData(sessionSummary.sessions) : null
  return JSON.stringify({
    type: 'update', buildId: BUILD_ID, summary: { toolCalls: {} }, sessionSummary: stripped, sidebar, analyticsData,
    ...(sidebarLive ?? {}),
  })
}

function pushUpdate() {
  const data = buildUpdatePayload()
  sseClients = sseClients.filter(client => {
    try { client.write(`data: ${data}\n\n`); return true } catch { return false }
  })
}

// TRDD-U0UYC38A — targeted live-tail push. Emitted the instant a session's .jsonl grows (the scan
// only returns sessions whose byte offset advanced), carrying just the changed cards + their ids —
// NOT a full summarizeSpans rebuild. This is what makes a jsonl-derived session feel as live as an
// OTEL one: the browser merges the card into the list and, for the FOCUSED session, invalidates its
// History/composition caches so the drill views re-fetch the newest turns sub-second. The heavier
// full-summary push stays coalesced (schedulePushUpdate) so this immediate path can't reopen the
// OOM budget the coalesce protects. Cards are stripped of their heavy timeline/fileOps (fetched
// lazily per session), exactly like the full push does.
function pushSessionChanged(cards: SessionSummaryCard[]): void {
  if (cards.length === 0 || sseClients.length === 0) return
  const stripped = cards.map(s => ({ ...s, timeline: [], fileOps: undefined }))
  const data = JSON.stringify({ type: 'sessionChanged', sessionIds: stripped.map(s => s.sessionId), cards: stripped })
  sseClients = sseClients.filter(client => {
    try { client.write(`data: ${data}\n\n`); return true } catch { return false }
  })
}

// COALESCED update — this is the OOM fix (TRDD-0KNGDFQI). pushUpdate() runs a FULL
// summarizeSpans(up to MAX_SPANS) + sidebar + analytics + JSON.stringify; calling it on EVERY
// incoming OTLP POST (firehose rate = many/sec once logs+metrics+traces+raw-bodies are all enabled)
// produced allocation churn faster than GC could reclaim → the heap filled and the process was
// OOM-killed (FATAL mark-compact) in ~40s. Debouncing to at most once per PUSH_COALESCE_MS turns N
// firehose POSTs into ONE rebuild, so the working set stays bounded and RSS plateaus. Trailing-edge
// (not leading) so a burst emits exactly one update after it settles.
const PUSH_COALESCE_MS = 1000
let pushTimer: ReturnType<typeof setTimeout> | null = null
function schedulePushUpdate() {
  if (pushTimer) return
  pushTimer = setTimeout(() => { pushTimer = null; pushUpdate() }, PUSH_COALESCE_MS)
}

// ── Dashboard HTML ────────────────────────────────────────────────────────────

function getHtml(): string {
  const sessionSummary = buildSessionSummary()
  // Strip full timeline + per-file ops before inlining — they can be many MB across sessions.
  // Both are loaded lazily via /api/timeline/:sessionId after first paint.
  const sessionSummaryJson = safeJson(stripSessionDetail(sessionSummary))
  const sidebarLive = sessionSummary ? computeSidebarPayload(sessionSummary, spans) : {
    isActive: false, lastActivityMs: 0, sessionCount: 0, agentSources: [], currentSession: null, burnRate: null,
  }
  const sidebarInitJson = safeJson(sidebarLive)

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>AgentLens</title>
  <link rel="icon" href="/mascot.png" type="image/png">
  <link rel="stylesheet" href="/dashboard.css">
  <style>
    /* ── VS Code theme variable shim ─────────────────────────────────────── */
    :root {
      --vscode-editor-background:       #1e1e1e;
      --vscode-foreground:              #cccccc;
      --vscode-panel-border:            #3e3e42;
      --vscode-textLink-foreground:     #4fc3f7;
      --vscode-descriptionForeground:   #9d9d9d;
      --vscode-list-hoverBackground:    #2a2d2e;
      --vscode-editorWidget-background: #252526;
      --vscode-testing-iconFailed:      #f44747;
      --vscode-testing-iconPassed:      #4ec994;
      --vscode-font-family:             -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      --vscode-dropdown-background:     #3c3c3c;
      --vscode-dropdown-border:         #616161;
      --vscode-dropdown-foreground:     #f0f0f0;
      --vscode-button-background:       #0e639c;
      --vscode-button-foreground:       #ffffff;
      --vscode-button-hoverBackground:  #1177bb;
    }

    /* ── Standalone layout ───────────────────────────────────────────────── */
    html, body { height: 100%; overflow: hidden; margin: 0; padding: 0; }
    body { padding: 0; }
    #sa-wrap { display: flex; height: 100vh; width: 100vw; overflow: hidden; }

    /* ── Sidebar panel ───────────────────────────────────────────────────── */
    #sa-sidebar {
      width: 260px;
      min-width: 260px;
      background: var(--vscode-editorWidget-background);
      border-right: 1px solid var(--vscode-panel-border);
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
      overflow: hidden;
      transition: width 0.15s ease, min-width 0.15s ease;
    }
    #sa-sidebar.sa-collapsed { width: 0; min-width: 0; }

    /* Sidebar content — shared CSS classes with sidebarWebview.ts */
    .sb-card { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 8px 10px; margin-bottom: 6px; }
    .sb-section-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.4px; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
    .sb-row { display: flex; align-items: center; gap: 6px; }
    .sb-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .sb-dot.active { background: #56D364; animation: sbPulse 1.5s ease-in-out infinite; }
    .sb-dot.idle { background: var(--vscode-descriptionForeground); opacity: 0.5; }
    @keyframes sbPulse { 0%,100% { opacity:1;transform:scale(1); } 50% { opacity:0.5;transform:scale(1.4); } }
    .sb-status { font-size: 12px; font-weight: 600; }
    .sb-muted { color: var(--vscode-descriptionForeground); font-size: 11px; }
    .sb-prompt { font-size: 10px; color: var(--vscode-foreground); opacity: 0.8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin: 3px 0 2px; font-style: italic; }
    .sb-model { font-size: 10px; color: var(--vscode-textLink-foreground); margin-bottom: 4px; }
    #sa-sidebar canvas { display: block; width: 100%; height: 80px; }
    .sb-turn-label { font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 3px; }
    .sb-burn { font-size: 12px; font-weight: 600; color: var(--vscode-charts-green, #81c784); }
    .sb-counters { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; text-align: center; }
    .sb-counter-val { font-size: 16px; font-weight: 700; color: var(--vscode-textLink-foreground); }
    .sb-counter-key { font-size: 9px; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.3px; }
.sb-footer { display: flex; align-items: center; justify-content: space-between; padding: 6px 8px 8px; font-size: 11px; color: var(--vscode-descriptionForeground); border-top: 1px solid var(--vscode-panel-border); }
#sa-toast { position:fixed; bottom:20px; left:50%; transform:translateX(-50%); background:#333; color:#fff; padding:8px 16px; border-radius:4px; font-size:12px; z-index:9999; opacity:0; transition:opacity 0.2s; pointer-events:none; white-space:nowrap; box-shadow:0 2px 8px rgba(0,0,0,0.4); }
    #sa-toast.visible { opacity:1; }

    /* ── Main panel ──────────────────────────────────────────────────────── */
    #sa-main { flex: 1; overflow-y: auto; min-width: 0; padding: 0 18px 16px; }
    #app { min-height: 100%; }
  </style>
</head>
<body>
  <script>
    console.log('[AgentLens] HTML received', Date.now());
    window.__INITIAL_TOOL_CALLS__ = {};
    window.__INITIAL_SESSION_SUMMARY__ = ${sessionSummaryJson};
    window.__MASCOT_URI__ = '/help-mascot.png';
    window.__STANDALONE__ = true;
    window.__BUILD_ID__ = ${JSON.stringify(BUILD_ID)};

    // ── Client-side search support ────────────────────────────────────────────
    var __latestSessions__ = (window.__INITIAL_SESSION_SUMMARY__ && window.__INITIAL_SESSION_SUMMARY__.sessions) || [];
    window.addEventListener('message', function(e) {
      if (e.data && e.data.type === 'update' && e.data.sessionSummary && e.data.sessionSummary.sessions) {
        __latestSessions__ = e.data.sessionSummary.sessions;
      }
    });

    var _toastTimer;
    function showToast(msg) {
      var el = document.getElementById('sa-toast');
      if (!el) { el = document.createElement('div'); el.id = 'sa-toast'; document.body.appendChild(el); }
      el.textContent = msg;
      el.classList.add('visible');
      clearTimeout(_toastTimer);
      _toastTimer = setTimeout(function() { el.classList.remove('visible'); }, 3000);
    }

    function getNotifContainer() {
      var el = document.getElementById('sa-notif-container');
      if (!el) {
        el = document.createElement('div');
        el.id = 'sa-notif-container';
        el.style.cssText = 'position:fixed;bottom:20px;right:16px;z-index:9998;display:flex;flex-direction:column;gap:8px;max-width:320px;';
        document.body.appendChild(el);
      }
      return el;
    }

    // showActionNotification(label, prompt, color, preview, secondaryAction, dismissMs)
    // secondaryAction: { label: string, onClick: function } | null — rendered before Copy Prompt
    function showActionNotification(label, prompt, color, preview, secondaryAction, dismissMs) {
      color = color || '#f6a623';
      var container = getNotifContainer();
      var notif = document.createElement('div');
      notif.style.cssText = 'background:#252526;border:1px solid #3e3e42;border-left:3px solid ' + color + ';border-radius:4px;padding:10px 12px;font-size:12px;color:#ccc;box-shadow:0 2px 8px rgba(0,0,0,0.4);';

      var header = document.createElement('div');
      header.style.cssText = 'display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:6px;';

      var labelEl = document.createElement('span');
      labelEl.style.cssText = 'font-weight:600;color:' + color + ';line-height:1.3;';
      labelEl.textContent = label;

      var closeBtn = document.createElement('button');
      closeBtn.textContent = '×';
      closeBtn.style.cssText = 'background:none;border:none;color:#888;cursor:pointer;font-size:16px;padding:0;line-height:1;flex-shrink:0;';
      closeBtn.onclick = function() { notif.remove(); };

      header.appendChild(labelEl);
      header.appendChild(closeBtn);
      notif.appendChild(header);

      if (preview) {
        var previewEl = document.createElement('div');
        previewEl.style.cssText = 'font-size:11px;color:#999;margin-bottom:8px;line-height:1.4;max-height:56px;overflow:hidden;';
        previewEl.textContent = preview;
        notif.appendChild(previewEl);
      }

      var actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';

      if (secondaryAction) {
        var secBtn = document.createElement('button');
        secBtn.textContent = secondaryAction.label;
        secBtn.style.cssText = 'background:none;border:1px solid #555;border-radius:3px;color:#ccc;cursor:pointer;font-size:11px;padding:4px 10px;';
        secBtn.onclick = function() { secondaryAction.onClick(); notif.remove(); };
        actions.appendChild(secBtn);
      }

      var copyBtn = document.createElement('button');
      copyBtn.textContent = 'Copy Prompt';
      copyBtn.style.cssText = 'background:none;border:1px solid ' + color + ';border-radius:3px;color:' + color + ';cursor:pointer;font-size:11px;padding:4px 10px;';
      copyBtn.onclick = function() {
        navigator.clipboard.writeText(prompt).then(function() {
          copyBtn.textContent = 'Copied!';
          copyBtn.style.borderColor = '#56D364';
          copyBtn.style.color = '#56D364';
          setTimeout(function() { notif.remove(); }, 1500);
        }).catch(function() {
          showToast('Could not copy — check browser clipboard permissions');
        });
      };
      actions.appendChild(copyBtn);

      notif.appendChild(actions);
      container.appendChild(notif);
      setTimeout(function() { notif.remove(); }, dismissMs || 30000);
    }

    window.acquireVsCodeApi = function() {
      return {
        getState: function() { return null; },
        setState: function() {},
        postMessage: function(msg) {
          if (msg.type === 'confirmClear') {
            if (confirm('Clear all AgentLens data? OTEL session data is deleted permanently. AgentLens log cache is cleared and will be rebuilt from your local agent log files (the log files themselves are not deleted).')) {
              fetch('/api/clear', { method: 'POST' });
              window.dispatchEvent(new MessageEvent('message', { data: { type: 'clearAll' } }));
            }
          } else if (msg.type === 'clearAll') {
            fetch('/api/clear', { method: 'POST' });
          } else if (msg.type === 'automation' && msg.prompt) {
            // Build full prompt matching VS Code format: [label] + session ID + body
            var sessionLine = msg.sessionId ? 'Session ID: ' + msg.sessionId + '\\n' : '';
            var autoFull = '[' + (msg.label || 'Automation') + ']\\n\\n' + sessionLine + msg.prompt;
            var autoPreview = msg.prompt.length > 160 ? msg.prompt.slice(0, 160) + '…' : msg.prompt;
            var autoLabel = 'Automation: ' + (msg.label || 'Automation');
            var viewAutomations = {
              label: 'View Automations',
              onClick: function() {
                window.dispatchEvent(new MessageEvent('message', { data: { type: 'switchTab', tab: 'settings-automation' } }));
              }
            };
            if (msg.writePromptsFile) {
              fetch('/api/write-prompts-file', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ agent: msg.agent, label: msg.label, prompt: autoFull })
              }).then(function() {
                var slug = msg.agent === 'claude_code' ? 'claude' : msg.agent === 'codex' ? 'codex' : 'copilot';
                showToast('Prompt written to agentlens-prompts-' + slug + '.md');
              }).catch(function() {
                showActionNotification(autoLabel, autoFull, '#f6a623', autoPreview, viewAutomations, 30000);
              });
            } else {
              showActionNotification(autoLabel, autoFull, '#f6a623', autoPreview, viewAutomations, 30000);
            }
          } else if (msg.type === 'askAI' && msg.prompt) {
            navigator.clipboard.writeText(msg.prompt).then(function() {
              showToast('Prompt copied to clipboard');
            }).catch(function() {
              showToast('Could not copy — check browser clipboard permissions');
            });
          } else if (msg.type === 'exportSessionData' || msg.type === 'exportSessionDataRedacted') {
            var redact = msg.type === 'exportSessionDataRedacted';
            var exportIds = Array.isArray(msg.sessionIds) ? new Set(msg.sessionIds) : null;
            var exportSessions = exportIds
              ? (__latestSessions__ || []).filter(function(s) { return exportIds.has(s.sessionId); })
              : (__latestSessions__ || []);
            var exportable = exportSessions.map(function(s) {
              return {
                sessionId:         s.sessionId,
                traceId:           s.traceId,
                source:            s.source,
                model:             s.model,
                startTime:         s.startTime,
                durationMs:        s.durationMs,
                turns:             s.totalLlmCalls,
                totalToolCalls:    s.totalToolCalls,
                inputTokens:       s.inputTokens,
                outputTokens:      s.outputTokens,
                cacheReadTokens:   s.cacheReadTokens,
                cacheCreateTokens: s.cacheCreateTokens,
                cacheHitRate:      s.cacheHitRate,
                errors:            s.errors,
                outcome:           s.outcome,
                toolCounts:        s.toolCounts,
                filesRead:    redact ? (s.filesRead    || []).map(function() { return '[redacted]'; }) : s.filesRead,
                filesChanged: redact ? (s.filesChanged || []).map(function() { return '[redacted]'; }) : s.filesChanged,
                loopSignals:  s.loopSignals,
                userRequest:  redact ? '[redacted]' : (s.userRequest || null),
              };
            });
            var now = new Date();
            var pad = function(n) { return String(n).padStart(2, '0'); };
            var ts = '' + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) +
                     '_' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
            var filename = (redact ? 'export_redacted' : 'export') + '_sessions_' + ts + '.json';
            var blob = new Blob([JSON.stringify(exportable, null, 2)], { type: 'application/json' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url; a.download = filename; a.click();
            URL.revokeObjectURL(url);
            showToast('Downloaded ' + filename);
          } else if (msg.type === 'openSidebar' || msg.type === 'closeSidebar') {
            window.dispatchEvent(new CustomEvent('agentlens:sidebar', { detail: { open: msg.type === 'openSidebar' } }));
          } else if (msg.type === 'searchSessions' && msg.query) {
            var q = msg.query;
            var filtered = __latestSessions__.filter(function(s) {
              if (q.text) {
                var t = q.text.toLowerCase();
                if (!(s.userRequest || '').toLowerCase().includes(t) && !(s.model || '').toLowerCase().includes(t)) return false;
              }
              if (q.source && s.source !== q.source) return false;
              if (q.since) { var ms = s.startTime ? new Date(s.startTime).getTime() : 0; if (ms < q.since) return false; }
              if (q.until) { var ms2 = s.startTime ? new Date(s.startTime).getTime() : 0; if (ms2 > q.until) return false; }
              return true;
            });
            var dir = q.orderDir === 'ASC' ? 1 : -1;
            filtered.sort(function(a, b) {
              if (q.orderBy === 'start_time') return dir * (new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
              if (q.orderBy === 'total_tokens') return dir * ((a.inputTokens + a.outputTokens) - (b.inputTokens + b.outputTokens));
              if (q.orderBy === 'duration_ms') return dir * (a.durationMs - b.durationMs);
              if (q.orderBy === 'errors') return dir * (a.errors - b.errors);
              if (q.orderBy === 'cost_usd') return 0;
              return 0;
            });
            var offset = q.offset || 0; var limit = q.limit || 50;
            var page = filtered.slice(offset, offset + limit);
            setTimeout(function() {
              window.dispatchEvent(new MessageEvent('message', {
                data: { type: 'searchResults', sessions: page, totalCount: filtered.length, offset: offset, context: msg.context || 'search' }
              }));
            }, 0);
          } else if (msg.type === 'alert' && msg.label) {
            var alertColor = msg.severity === 'error' ? '#f44747' : msg.severity === 'info' ? '#4fc3f7' : '#f6a623';
            var alertPrompt = [
              "An alert was triggered in my AI coding session. Please explain what's happening and how I should respond.",
              '',
              'Alert: ' + msg.label,
            ].concat(msg.detail ? ['Detail: ' + msg.detail] : []).join('\\n');
            showActionNotification(
              'Alert: ' + msg.label,
              alertPrompt,
              alertColor,
              msg.detail || null,
              {
                label: 'View Alerts',
                onClick: function() {
                  window.dispatchEvent(new MessageEvent('message', { data: { type: 'switchTab', tab: 'alerts' } }));
                }
              },
              30000
            );
          } else if (msg.type === 'loadSessionDetail' && msg.sessionId) {
            fetch('/api/timeline/' + encodeURIComponent(msg.sessionId))
              .then(function(r) { return r.json(); })
              .then(function(data) {
                window.dispatchEvent(new MessageEvent('message', {
                  data: { type: 'sessionDetail', sessionId: msg.sessionId, timeline: data.timeline || [], fileOps: data.fileOps || [], generatedFiles: data.generatedFiles || [], generatedFilesTruncated: !!data.generatedFilesTruncated }
                }));
              })
              .catch(function(e) { console.warn('[AgentLens] timeline fetch failed', e); });
          } else if (msg.type === 'loadGeneratedFile' && msg.path) {
            fetch('/api/generated-file?path=' + encodeURIComponent(msg.path))
              .then(function(r) { return r.json(); })
              .then(function(data) {
                window.dispatchEvent(new MessageEvent('message', {
                  data: Object.assign({ type: 'generatedFileContent', path: msg.path }, data)
                }));
              })
              .catch(function(e) { console.warn('[AgentLens] generated-file fetch failed', e); });
          } else if (msg.type === 'loadContextComposition' && msg.sessionId) {
            var _compUrl = '/api/composition/' + encodeURIComponent(msg.sessionId);
            if (msg.parentSessionId) _compUrl += '?parent=' + encodeURIComponent(msg.parentSessionId);
            fetch(_compUrl)
              .then(function(r) { return r.json(); })
              .then(function(data) {
                window.dispatchEvent(new MessageEvent('message', {
                  data: { type: 'contextComposition', sessionId: msg.sessionId, composition: data.composition || null }
                }));
              })
              .catch(function(e) { console.warn('[AgentLens] composition fetch failed', e); });
          }
        }
      };
    };

    // SSE → dispatch as window message (picked up by Preact app AND sidebar handler below)
    // Falls back to polling /api/summary every 2s if EventSource fails (e.g. Safari private mode).
    var _sseOk = false;
    var _pollTimer = null;
    function _startPolling() {
      if (_pollTimer) return;
      console.warn('[AgentLens] SSE unavailable — falling back to polling');
      _pollTimer = setInterval(function() {
        fetch('/api/summary')
          .then(function(r) { return r.json(); })
          .then(function(summary) {
            window.dispatchEvent(new MessageEvent('message', {
              data: { type: 'update', sessionSummary: summary }
            }));
          })
          .catch(function(e) { console.warn('[AgentLens] poll failed', e); });
      }, 2000);
    }
    var _es = new EventSource('/events');
    _es.onopen = function() {
      console.log('[AgentLens] SSE connected', Date.now());
      _sseOk = true;
      if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
    };
    _es.onmessage = function(e) {
      var data = JSON.parse(e.data);
      // Live-reload: after a rebuild+restart the reconnecting SSE carries a new build id → refresh
      // once. Guarded on __BUILD_ID__ being set and actually differing so it can never loop.
      if (data && data.buildId && window.__BUILD_ID__ && data.buildId !== window.__BUILD_ID__) {
        console.log('[AgentLens] New build detected — reloading', data.buildId);
        location.reload();
        return;
      }
      window.dispatchEvent(new MessageEvent('message', { data: data }));
    };
    _es.onerror = function() {
      if (!_sseOk) {
        // Never connected — start polling immediately
        _startPolling();
      }
      // If it was connected before, browser will auto-reconnect; don't start polling yet
    };
  </script>

  <div id="sa-wrap">
    <!-- ── Sidebar (live session monitor) ────────────────────────────────── -->
    <div id="sa-sidebar">
      <div style="flex:1;overflow-y:auto;padding:8px 8px 8px;font-family:var(--vscode-font-family);color:var(--vscode-foreground)">
        <!-- Status row -->
        <div class="sb-card" style="margin-bottom:6px">
          <div class="sb-row" style="margin-bottom:2px">
            <span class="sb-dot idle" id="sb-dot"></span>
            <span class="sb-status" id="sb-status-text">Idle</span>
            <span style="flex:1"></span>
            <span id="sb-agent" class="sb-muted" style="display:flex;align-items:center"></span>
            <span id="sb-dur" class="sb-muted"></span>
          </div>
          <div id="sb-prompt" class="sb-prompt"></div>
          <div id="sb-model" class="sb-model"></div>
          <span id="sb-ago" class="sb-muted" style="font-size:10px"></span>
        </div>

        <!-- Session block (hidden when no sessions) -->
        <div id="sb-session-block" style="display:none">

          <!-- Key counters (shown first) -->
          <div class="sb-card">
            <div class="sb-counters">
              <div>
                <div class="sb-counter-val" id="sb-turns">—</div>
                <div class="sb-counter-key">Turns</div>
              </div>
              <div>
                <div class="sb-counter-val" id="sb-tools">—</div>
                <div class="sb-counter-key">Tools</div>
              </div>
              <div>
                <div class="sb-counter-val" id="sb-errors">—</div>
                <div class="sb-counter-key">Errors</div>
              </div>
              <div>
                <div class="sb-counter-val" id="sb-cache">—</div>
                <div class="sb-counter-key">Cache</div>
              </div>
            </div>
          </div>

          <!-- Context growth sparkline -->
          <div class="sb-card">
            <div class="sb-section-label">Context Growth</div>
            <canvas id="sb-sparkline"></canvas>
            <div id="sb-turn-label" class="sb-turn-label"></div>
            <div id="sb-sparkline-waiting" class="sb-muted" style="display:none;font-size:10px;font-style:italic;padding:2px 0">Waiting for data…</div>
          </div>

          <!-- Token breakdown (input / output) -->
          <div class="sb-card" id="sb-tokens-card">
            <div class="sb-section-label">Tokens</div>
            <div id="sb-token-bars" style="margin-top:4px"></div>
            <div id="sb-token-waiting" class="sb-muted" style="display:none;font-size:10px;font-style:italic;padding:2px 0">Waiting for data…</div>
          </div>

          <!-- Estimated cost -->
          <div class="sb-card" id="sb-cost-card">
            <div class="sb-section-label">Estimated Cost</div>
            <div id="sb-cost-val" style="font-size:16px;font-weight:700;color:var(--vscode-charts-green,#81c784)">—</div>
          </div>

          <!-- Burn rate -->
          <div class="sb-card" id="sb-burn-row">
            <div class="sb-section-label">Burn Rate</div>
            <div id="sb-burn" class="sb-burn"></div>
            <div id="sb-burn-waiting" class="sb-muted" style="display:none;font-size:10px;font-style:italic">Waiting for data…</div>
          </div>

        </div>

        <!-- Empty state (shown by render() when currentSession is null) -->
        <div id="sb-empty" class="sb-muted" style="text-align:center;padding:24px 0;font-size:11px;display:none">
          No sessions recorded yet
        </div>


      </div>

      <!-- Footer -->
      <div class="sb-footer">
        <span><span id="sb-session-count">0</span> sessions stored</span>
      </div>
    </div>

    <!-- ── Main dashboard ─────────────────────────────────────────────────── -->
    <div id="sa-main">
      <div id="app"></div>
    </div>
  </div>

  <script>
    console.log('[AgentLens] Inline setup done', Date.now());
    window.onerror = function(msg, src, line, col, err) {
      console.error('[AgentLens] JS error:', msg, src + ':' + line + ':' + col, err);
      var app = document.getElementById('app');
      if (app) {
        app.style.cssText = 'padding:20px;color:red;font-family:monospace;white-space:pre-wrap';
        app.textContent = 'JS ERROR: ' + msg + ' | At: ' + src + ':' + line + ':' + col + ' | ' + (err ? err.stack : '');
      }
    };
  </script>

  <script src="/dashboard.js" onload="console.log('[AgentLens] dashboard.js loaded', Date.now())"></script>

  <script>
    // Sidebar collapse driven by dashboard toggle
    var _sidebarEl = document.getElementById('sa-sidebar');
    window.addEventListener('agentlens:sidebar', function(e) {
      _sidebarEl.classList.toggle('sa-collapsed', !e.detail.open);
    });
</script>
  <script>var __SIDEBAR_INIT__ = ${sidebarInitJson};</script>
  <script src="/sidebar.js"></script>
</body>
</html>`
}

// ── Static file serving ───────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  '.css': 'text/css',
  '.js':  'application/javascript',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

// ── UI server ─────────────────────────────────────────────────────────────────

const uiServer = http.createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0]
  res.setHeader('Access-Control-Allow-Origin', '*')

  if (url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    })
    res.write(':\n\n') // initial ping
    res.write(`data: ${buildUpdatePayload()}\n\n`)
    sseClients.push(res)
    req.on('close', () => { sseClients = sseClients.filter(c => c !== res) })
    return
  }

  if (req.method === 'POST' && url === '/api/import') {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { sessions?: unknown[] }
        if (!Array.isArray(body.sessions)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'sessions array required' }))
          return
        }
        const VALID_SOURCES = new Set(['copilot', 'claude_code', 'codex', 'opencode'])
        let imported = 0
        let skipped = 0
        for (const raw of body.sessions) {
          if (typeof raw !== 'object' || raw === null) continue
          const s = raw as Record<string, unknown>
          const id = typeof s['sessionId'] === 'string' ? s['sessionId'] : ''
          if (!id || !VALID_SOURCES.has(s['source'] as string)) continue
          if (logSessions.has(id)) { skipped++; continue }
          const card = buildImportCardStandalone(s)
          logSessions.set(id, card)
          imported++
        }
        pushUpdate()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ imported, skipped, failed: 0, total: body.sessions.length }))
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: String(e) }))
      }
    })
    return
  }

  if (req.method === 'POST' && url === '/api/clear') {
    spans = []
    logSessions.clear()
    logReader.clearFileState()
    try { fs.writeFileSync(DATA_FILE, '[]') } catch (e) { console.warn('[AgentLens] Could not clear data file:', e) }
    pushUpdate()          // send cleared state to clients immediately
    res.writeHead(200); res.end()
    // Re-ingest after the response is sent so the client sees the cleared state first.
    setImmediate(() => runLogScan())
    return
  }

  if (req.method === 'POST' && url === '/api/write-prompts-file') {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      try {
        const { agent, label, prompt } = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { agent: string; label: string; prompt: string }
        const agentSlug = agent === 'claude_code' ? 'claude' : agent === 'codex' ? 'codex' : 'copilot'
        const agentName = agent === 'claude_code' ? 'Claude' : agent === 'codex' ? 'Codex' : 'Copilot'
        const filename = `agentlens-prompts-${agentSlug}.md`
        const filePath = path.join(process.cwd(), filename)
        const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
        const entry = `## ${timestamp} — ${label}\n\n${prompt}\n\n---\n\n`
        let existing = ''
        try { existing = fs.readFileSync(filePath, 'utf-8') } catch { /* new file */ }
        const content = existing ? existing + entry : `# AgentLens Prompts — ${agentName}\n\n${entry}`
        fs.writeFileSync(filePath, content, 'utf-8')
        console.log(`[AgentLens] Prompt written to ${filePath}`)
      } catch (e) {
        console.warn('[AgentLens] write-prompts-file error:', e)
      }
      res.writeHead(200); res.end()
    })
    return
  }

  if (req.method === 'GET' && url?.startsWith('/api/instruction-suggestions')) {
    const parsed = new URL(url, 'http://localhost')
    const workspace = parsed.searchParams.get('workspace')?.trim()
    if (!workspace) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'workspace query param is required' }))
      return
    }
    const sessions = (buildSessionSummary()?.sessions ?? [])
      .filter(s => (s.workspace ?? '') === workspace || s.workspace?.startsWith(workspace))
    const { readAllInstructionContent } = require('../src/instructionFiles') as typeof import('../src/instructionFiles')
    const existingText = readAllInstructionContent(workspace)
    const suggestions = generateSuggestions(sessions, existingText)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(suggestions))
    return
  }

  if (req.method === 'GET' && url?.startsWith('/api/instruction-files')) {
    const parsed = new URL(url, 'http://localhost')
    const workspace = parsed.searchParams.get('workspace')?.trim()
    if (!workspace) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'workspace query param is required' }))
      return
    }
    const files = detectInstructionFiles(workspace)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(files))
    return
  }

  if (req.method === 'POST' && url === '/api/instructions/apply') {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      try {
        const { workspace, targetFile, appliedText, id } = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
          workspace: string; targetFile: string; appliedText: string; id: string
        }
        if (!workspace || !targetFile || !appliedText || !id) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'workspace, targetFile, appliedText, and id are required' }))
          return
        }
        const absPath = path.join(workspace, targetFile)
        appendSuggestion(absPath, appliedText, id)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      } catch (e) {
        console.warn('[AgentLens] /api/instructions/apply error:', e)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: String(e) }))
      }
    })
    return
  }

  if (req.method === 'POST' && url === '/action') {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { type?: string }
        if (body.type === 'clearAll') {
          spans = []
          try { fs.writeFileSync(DATA_FILE, '[]') } catch (e) { console.warn('[AgentLens] Could not clear data file:', e) }
          pushUpdate()
        }
      } catch (e) { console.warn('[AgentLens] Malformed /action body:', e) }
      res.writeHead(200); res.end()
    })
    return
  }

  if (req.method === 'GET' && url === '/api/summary') {
    const summary = buildSessionSummary()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(stripSessionDetail(summary)))
    return
  }

  // TRDD-U0UYC38A: live-tail proof. `incrementalReads` counts changed logs re-parsed by tailing
  // only their appended bytes; `fullReads` counts from-0 (cold-start/fallback) parses. Appending to
  // a live session must bump incrementalReads while fullReads stays put — the "no full-file rescans
  // on each append" acceptance check.
  if (req.method === 'GET' && url === '/api/debug/log-scan-stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(logReader.getLogScanStats()))
    return
  }

  if (req.method === 'GET' && url?.startsWith('/api/timeline/')) {
    const sessionId = decodeURIComponent(url.slice('/api/timeline/'.length))
    const summary = buildSessionSummary()
    const session = summary?.sessions.find(s => s.sessionId === sessionId) ?? null
    res.writeHead(200, { 'Content-Type': 'application/json' })
    // TRDD-ZS1GDXVY: generatedFiles (session-level group + truncation flag) rides the lazy timeline
    // payload, not the bulk summary — stripSessionDetail drops it from /api/summary to keep it light.
    res.end(JSON.stringify({
      timeline: session?.timeline ?? [],
      fileOps: session?.fileOps ?? [],
      generatedFiles: session?.generatedFiles ?? [],
      generatedFilesTruncated: session?.generatedFilesTruncated ?? false,
    }))
    return
  }

  // TRDD-ZS1GDXVY: lazy content fetch for one generated/output file. Serves ONLY files under a Claude
  // scratch tree (isClaudeScratchPath) so this can never be turned into an arbitrary-file reader.
  // Capped at 200KB with an explicit truncation flag; a deleted file returns exists:false (never a
  // silent null). Localhost-only server, so returning local absolute-path content is in-scope.
  if (req.method === 'GET' && url === '/api/generated-file') {
    const rawUrl = req.url ?? ''
    const qIdx = rawUrl.indexOf('?')
    const filePath = qIdx >= 0 ? new URLSearchParams(rawUrl.slice(qIdx + 1)).get('path') ?? '' : ''
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(readScratchFile(filePath)))
    return
  }

  if (req.method === 'GET' && url?.startsWith('/api/composition/')) {
    // `url` has the query stripped (L1144); read the raw req.url for the ?parent= param.
    const sessionId = decodeURIComponent(url.slice('/api/composition/'.length))
    // A fork/sub-agent card carries parentSessionId (?parent=) — the parser falls back to the
    // parent's .jsonl when the fork has no own log, so its inherited context still drills.
    const rawUrl = req.url ?? ''
    const qIdx = rawUrl.indexOf('?')
    const parentHint = qIdx >= 0
      ? new URLSearchParams(rawUrl.slice(qIdx + 1)).get('parent') ?? undefined
      : undefined
    // Resolve the nearest ANCESTOR that actually has a log: the immediate parent hint may itself be a
    // logless sub-agent (agent-… → agent-… → real session), so walk the whole chain rather than
    // dead-ending after one hop. The graph comes from the session summary.
    const compSessions = buildSessionSummary()?.sessions ?? []
    const parentOf = (id: string): string | undefined => compSessions.find(s => s.sessionId === id)?.parentSessionId
    // Prefer the nearest LOGGED ancestor (drillable). If none has a log, still pass the immediate
    // parent so the parser returns an honest empty-with-reconstructedFrom composition — the UI then
    // shows "transcript lives in parent <id>" instead of a perpetual loading spinner.
    const parentSessionId = resolveLoggedAncestor(sessionId, parentOf) ?? parentOf(sessionId) ?? parentHint
    // Parse the raw .jsonl on demand — heavy work stays server-side, only the capped per-turn
    // summary crosses to the browser. null = no local Claude log for this session and no parent.
    buildContextComposition(sessionId, parentSessionId)
      .then(composition => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ composition }))
      })
      .catch(e => {
        console.warn('[AgentLens] composition parse failed', e)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ composition: null }))
      })
    return
  }

  if (req.method === 'GET' && url?.startsWith('/api/history/')) {
    // P8: full per-step context history (every block drillable to actual text + per-step diff).
    // Same ?parent= + nearest-logged-ancestor fallback as /api/composition so a fork/sub-agent
    // reconstructs from its parent transcript. The reconstruction carries the FULL block text, so a
    // huge session can be large — the browser drills progressively; this route returns the whole
    // reconstruction and the client renders lazily. null = no local Claude log and no parent.
    const sessionId = decodeURIComponent(url.slice('/api/history/'.length))
    const rawUrl = req.url ?? ''
    const qIdx = rawUrl.indexOf('?')
    const parentHint = qIdx >= 0 ? new URLSearchParams(rawUrl.slice(qIdx + 1)).get('parent') ?? undefined : undefined
    const histSessions = buildSessionSummary()?.sessions ?? []
    const parentOf = (id: string): string | undefined => histSessions.find(s => s.sessionId === id)?.parentSessionId
    const parentSessionId = resolveLoggedAncestor(sessionId, parentOf) ?? parentOf(sessionId) ?? parentHint
    buildContextHistory(sessionId, parentSessionId)
      .then(history => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ history }))
      })
      .catch(e => {
        console.warn('[AgentLens] history parse failed', e)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ history: null }))
      })
    return
  }

  if (req.method === 'GET' && url?.startsWith('/api/callcontext/')) {
    // TRDD-ICHAVFCS: the full literal context of ONE llm call, reconstructed from the raw OTEL request
    // body captured via OTEL_LOG_RAW_API_BODIES. Path: /api/callcontext/:sessionId/:requestId or
    // /api/callcontext/:sessionId?span=:spanId. callContext=null → no raw body captured for that call
    // (the client renders an honest "not captured" note, never a spinner). `url` is the query-stripped
    // pathname; the ?span= hint is read from the raw req.url.
    const rest = url.slice('/api/callcontext/'.length)
    const parts = rest.split('/')
    const sessionId = decodeURIComponent(parts[0] ?? '')
    const requestId = parts[1] ? decodeURIComponent(parts[1]) : undefined
    const rawUrl = req.url ?? ''
    const qIdx = rawUrl.indexOf('?')
    const spanId = qIdx >= 0 ? new URLSearchParams(rawUrl.slice(qIdx + 1)).get('span') ?? undefined : undefined
    resolveCallContext(sessionId, { requestId, spanId })
      .then(callContext => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ callContext }))
      })
      .catch(e => {
        console.warn('[AgentLens] callcontext build failed', e)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ callContext: null }))
      })
    return
  }

  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(getHtml())
    return
  }

  const filePath = path.join(mediaDir, url)
  const ext = path.extname(filePath)
  const mime = MIME[ext]
  if (mime && fs.existsSync(filePath) && filePath.startsWith(mediaDir)) {
    res.writeHead(200, { 'Content-Type': mime })
    fs.createReadStream(filePath).pipe(res)
    return
  }

  res.writeHead(404); res.end('Not found')
})

// ── OTLP server ───────────────────────────────────────────────────────────────

const otlpServer = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/agentlens/standalone') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ agentlens: true, kind: 'standalone' }))
    return
  }
  if (req.method !== 'POST') { res.writeHead(200); res.end(); return }
  const chunks: Buffer[] = []
  req.on('data', (c: Buffer) => chunks.push(c))
  req.on('end', () => {
    try {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
      const kind = classifyOtlpPayload(payload)
      if (req.url === '/v1/traces' || kind === 'traces') {
        const { count, agent } = processTraces(payload, req.url ?? '/v1/traces')
        if (count > 0) console.log(`[AgentLens] Ingested ${count} span${count !== 1 ? 's' : ''} (${agent})`)
      } else if (req.url === '/v1/logs' || kind === 'logs') {
        const n = processLogs(payload, req.url ?? '/v1/logs')
        if (n > 0) console.log(`[AgentLens] ${n} log event${n !== 1 ? 's' : ''} ingested`)
      } else if (kind === 'metrics' || req.url === '/v1/metrics') {
        // Metrics are accepted so OTLP exporters do not retry, but AgentLens does not display them.
      } else {
        console.warn(`[AgentLens] ignored POST ${req.url ?? '/'}: unrecognized OTLP JSON payload`)
      }
      schedulePushUpdate()
      scheduleSave()
    } catch (e) {
      console.error('[AgentLens] Parse error:', e)
    }
    res.writeHead(200); res.end()
  })
})

// ── Start ─────────────────────────────────────────────────────────────────────

otlpServer.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[AgentLens] Port ${OTLP_PORT} (OTLP) already in use — stop the process using it or set OTLP_PORT=<other> to use a different port.`)
    process.exit(1)
  }
  console.error('[AgentLens] OTLP server error:', err)
})

// Auto-configure Claude Code (full telemetry), Codex, and Copilot to point at this collector.
async function applyAutoConfig(): Promise<void> {
  // 1) FULL reversible telemetry env FIRST — it must record the TRUE prior state of
  //    ~/.claude/settings.json before any other writer touches the file. It also runs BEFORE
  //    autoConfigureClaudeCode (which writes a subset of the same env keys) so the two never
  //    race on the same file (read-modify-write) and the marker's prior values are truthful.
  //    Opt out with AGENTLENS_NO_TELEMETRY_CONFIG=1.
  //
  //    CANONICAL-INSTANCE GATE: only an instance listening on the DEFAULT OTLP port (4318) may
  //    write the GLOBAL ~/.claude/settings.json. Without this gate, any isolated-port instance
  //    (test runs, headless proofs, a second dev server) would "repair" the global
  //    OTEL_EXPORTER_OTLP_ENDPOINT to point at ITS OWN ephemeral port — observed 2026-07-07:
  //    a headless test on port 4387 silently repointed every new Claude Code session's
  //    telemetry at a dead port. Override for a deliberately non-default deployment with
  //    AGENTLENS_TELEMETRY_CONFIG=1 (explicit opt-IN beats an implicit hijack).
  const canonicalInstance = OTLP_PORT === 4318 || process.env.AGENTLENS_TELEMETRY_CONFIG === '1'
  if (process.env.AGENTLENS_NO_TELEMETRY_CONFIG === '1') {
    console.log('[AgentLens] AGENTLENS_NO_TELEMETRY_CONFIG=1 — skipping automatic telemetry config.')
  } else if (!canonicalInstance) {
    console.log(`[AgentLens] Non-default OTLP port ${OTLP_PORT} — NOT touching the global telemetry config (set AGENTLENS_TELEMETRY_CONFIG=1 to force).`)
  } else {
    try {
      const r = await ensureTelemetryConfig({ otlpPort: OTLP_PORT })
      if (r.changed) {
        console.log(`[AgentLens] Full telemetry config applied → ${r.settingsPath} (${r.added.length} added, ${r.overrode.length} overridden${r.backupPath ? `; backup ${r.backupPath}` : ''})`)
        console.log('[AgentLens] ⚠ Restart your Claude Code sessions for telemetry to take effect.')
      } else {
        console.log('[AgentLens] Full telemetry config already in place.')
      }
    } catch (e) {
      // Fail-safe at the server boundary: a bad settings.json shouldn't stop the dashboard.
      console.warn(`[AgentLens] Could not apply telemetry config: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // 2) Then the per-agent auto-config (Stop-hook automation + Codex + Copilot). Runs AFTER
  //    ensureTelemetryConfig so the two Claude Code writers are strictly sequential.
  await applyLegacyAgentConfig()
}

// Legacy per-agent auto-config: Claude Code Stop-hook + Codex + Copilot. Split out of
// applyAutoConfig so each concern stays readable (and keeps cognitive complexity low).
async function applyLegacyAgentConfig(): Promise<void> {
  try {
    const [claudeResult, codexResult, copilotResults] = await Promise.all([
      autoConfigureClaudeCode(OTLP_PORT),
      autoConfigureCodex(OTLP_PORT),
      autoConfigureCopilotStandalone(OTLP_PORT),
    ])
    if (claudeResult.error) {
      console.warn(`[AgentLens] Could not auto-configure Claude Code: ${claudeResult.error}`)
    } else if (claudeResult.changed) {
      console.log(`[AgentLens] Claude Code configured — restart Claude Code in your terminal to activate tracing`)
    }
    if (codexResult.error) {
      console.warn(`[AgentLens] Could not auto-configure Codex: ${codexResult.error}`)
    } else if (codexResult.changed) {
      console.log(`[AgentLens] Codex configured — restart Codex in your terminal to activate tracing`)
    }
    const copilotChanged = copilotResults.filter(r => r.changed)
    const copilotErrors  = copilotResults.filter(r => r.error)
    if (copilotChanged.length > 0) {
      console.log(`[AgentLens] Copilot configured — reload VS Code window to activate tracing (Ctrl+Shift+P → "Reload Window")`)
    }
    for (const r of copilotErrors) {
      console.warn(`[AgentLens] Could not auto-configure Copilot: ${r.error}`)
    }
  } catch (e) {
    console.warn('[AgentLens] Auto-configure error:', e)
  }
}
applyAutoConfig()

otlpServer.listen(OTLP_PORT, BIND_HOST, () => {
  console.log(`[AgentLens] OTLP receiver → http://localhost:${OTLP_PORT}`)
})

uiServer.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[AgentLens] Port ${UI_PORT} (UI) already in use — set UI_PORT=<other> to use a different port.`)
    process.exit(1)
  }
  console.error('[AgentLens] UI server error:', err)
})

uiServer.listen(UI_PORT, BIND_HOST, () => {
  const url = `http://localhost:${UI_PORT}`
  console.log(`[AgentLens] Dashboard      → ${url}`)
  console.log(`[AgentLens] MCP server     → http://localhost:${MCP_PORT}/mcp`)

  // Auto-open browser
  const cmd = process.platform === 'darwin' ? `open "${url}"`
            : process.platform === 'win32'  ? `start "" "${url}"`
            : `xdg-open "${url}"`
  exec(cmd, err => { if (err) console.log(`\nOpen ${url} in your browser\n`) })

  // Start log ingestion after the server is ready
  startLogIngestion()
})

// ── Graceful shutdown — flush data before exit ────────────────────────────────

function shutdown() {
  if (saveTimer) clearTimeout(saveTimer)
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(spans))
    console.log(`\n[AgentLens] Saved ${spans.length} spans to ${DATA_FILE}`)
  } catch { /* ignore */ }
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
