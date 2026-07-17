import { signal, computed } from '@preact/signals'
import { calcSessionCost } from './sessionMetrics'
import type {
  FullSummary, SessionSummaryCard, TimelineEntry, FileOpSummary,
  AgentFilter, InitiatorFilter, DataSourceFilter, InsightFilter, WorkspaceFilter, VsCodeApi,
  DailyStatRow, LifetimeStats, BurnRate, Projection, ContextComposition,
  GeneratedFileRef, GeneratedFileContent, BurnStatus, CollectorGap, CompositionSummary,
} from './types'

// Maximum sessions rendered in any single chart or table
export const CHART_MAX = 25

// TRDD-1ZH1D5EG — the AgentlensPro#4 viewer-role contract, webview half. The server injects
// <meta name="agentlens-viewer" content="restricted"> into the document it serves when the
// request carried a valid role:"user" assertion. A boot CONSTANT, not a signal: the verdict is
// per-document (decided server-side from the signed header) and cannot change within a page
// life. UI-only convenience — the real enforcement is the server's method gate; hiding the
// settings chrome here just keeps a restricted viewer from seeing controls that would 403.
export const viewerRestricted =
  typeof document !== 'undefined'
  && document.querySelector('meta[name="agentlens-viewer"]')?.getAttribute('content') === 'restricted'

// TRDD-1ZH1D5EG (WYC4KB50 #6) — the ONE list of tab ids a restricted viewer must never reach, so
// the three enforcement sites (tab-bar filter, deep-link parser, host-message switchTab guard)
// can't drift apart. 'import' is a real tab (its POST /action 403s server-side); the settings
// pseudo-tabs open the config panel (already suppressed for restricted viewers). Add a future
// settings-adjacent tab here ONCE and every site honors it.
export const RESTRICTED_BLOCKED_TABS = new Set(['import', 'alerts', 'automation', 'settings-automation'])

/** True when a restricted viewer must be blocked from `tabId`. Non-restricted viewers: always false. */
export function isRestrictedBlockedTab(tabId: string): boolean {
  return viewerRestricted && RESTRICTED_BLOCKED_TABS.has(tabId)
}

// ── Time range navigation ─────────────────────────────────────────────────────

// 'custom' carries an explicit since/until from the datetime-local inputs (not in TIME_PRESETS —
// it is set directly, never via makeTimeRange). '15m' is the shortest quick window.
export type TimePreset = '15m' | '1h' | '6h' | '24h' | '7d' | '30d' | 'all' | 'custom'

export interface TimeRange {
  preset: TimePreset
  since?: number   // unix ms — undefined means no lower bound
  until?: number   // unix ms — undefined means now
}

// Quick-select presets (the button row). 'custom' is deliberately absent — it is driven by the
// from/to datetime inputs, so makeTimeRange (which looks up this table) is never called with it.
export const TIME_PRESETS: Array<{ id: TimePreset; label: string; ms: number | null }> = [
  { id: '15m',  label: '15m',  ms: 15 * 60_000 },
  { id: '1h',   label: '1h',   ms: 60 * 60_000 },
  { id: '6h',   label: '6h',   ms: 6 * 60 * 60_000 },
  { id: '24h',  label: '24h',  ms: 24 * 60 * 60_000 },
  { id: '7d',   label: '7d',   ms: 7 * 86_400_000 },
  { id: '30d',  label: '30d',  ms: 30 * 86_400_000 },
  { id: 'all',  label: 'All',  ms: null },
]

export function makeTimeRange(preset: TimePreset): TimeRange {
  const p = TIME_PRESETS.find(t => t.id === preset)
  if (!p || p.ms === null) return { preset }   // 'all'/'custom'/unknown → no computed lower bound
  return { preset, since: Date.now() - p.ms }
}

/** An explicit from/to window (from the datetime inputs). Normalizes order so since ≤ until. */
export function makeCustomRange(sinceMs: number, untilMs: number): TimeRange {
  const lo = Math.min(sinceMs, untilMs)
  const hi = Math.max(sinceMs, untilMs)
  return { preset: 'custom', since: lo, until: hi }
}

// Active time range — defaults to 'all' (no time bound, always live)
export const timeRange = signal<TimeRange>({ preset: 'all' })

// DB-queried sessions for the active time range (separate from the Search tab results)
export const rangedSearchResults = signal<SearchResultData | null>(null)

// ── Analytics signals ─────────────────────────────────────────────────────────

export const dailyStats = signal<DailyStatRow[]>([])
export const lifetimeStats = signal<LifetimeStats | null>(null)

export interface BurnRateData {
  sessionId: string
  burnRate: BurnRate
  projection: Projection | null
}
export const burnRateData = signal<BurnRateData | null>(null)

// Realtime server-computed burn status (TRDD-OG9PARZQ) — pushed over SSE as { type: 'burnStatus' }.
// Drives the Alerts-tab server-alerts section + window-budget readout. null until the first tick.
export const serverBurnStatus = signal<BurnStatus | null>(null)

// TRDD-PJC8N1HO spec 2: collector downtime windows, pushed on every SSE `update`. Renders the
// "collector offline — telemetry lost" band so a gap in coverage is explicit, not a silent hole.
export const collectorGaps = signal<CollectorGap[]>([])

export interface SearchResultData {
  sessions: SessionSummaryCard[]
  totalCount: number
  offset: number
}
export const searchResults = signal<SearchResultData | null>(null)

// ── Global session text filter + sort ─────────────────────────────────────────

export type SortKey = 'start_time' | 'total_tokens' | 'duration_ms' | 'errors' | 'prompt' | 'model' | 'source' | 'cost'
export const sessionTextFilter = signal('')
export const sessionSortKey = signal<SortKey>('start_time')
export const sessionSortDir = signal<'asc' | 'desc'>('desc')

// When set, Sessions tab shows only these session IDs (used by Instructions "View sessions" button).
export const evidenceSessionIds = signal<Set<string> | null>(null)

// ── Set signal helper ─────────────────────────────────────────────────────────

function makeSetSignal<T>() {
  const s = signal<ReadonlySet<T>>(new Set<T>())
  return {
    get value(): ReadonlySet<T> { return s.value },
    peek(): ReadonlySet<T> { return s.peek() },
    has(item: T): boolean { return s.value.has(item) },
    add(item: T): void { const n = new Set(s.value); n.add(item); s.value = n },
    delete(item: T): void { const n = new Set(s.value); n.delete(item); s.value = n },
    toggle(item: T): void { const n = new Set(s.value); n.has(item) ? n.delete(item) : n.add(item); s.value = n },
    clear(): void { s.value = new Set<T>() },
    get size(): number { return s.value.size },
  }
}

// ── Core data signals ─────────────────────────────────────────────────────────

export const sessionSummary = signal<FullSummary | null>(window.__INITIAL_SESSION_SUMMARY__ ?? null)
export const toolCalls = signal<Record<string, number>>(window.__INITIAL_TOOL_CALLS__ ?? {})

// ── Lazy timeline cache: sessionId → loaded timeline entries ──────────────────
// Populated by sessionDetail messages from the extension host.
// blobCache: `${spanId}:${field}` → content string

export const sessionTimelines = signal<Record<string, TimelineEntry[]>>({})
// Per-file read/write/edit byte volumes, fetched lazily alongside the timeline (heavy, so kept
// out of the bulk card payload — same lifecycle as sessionTimelines).
export const sessionFileOps = signal<Record<string, FileOpSummary[]>>({})
export const blobCache = signal<Record<string, string>>({})
// Output-file / subfolder tracking (TRDD-ZS1GDXVY). Session-level "generated files" group per
// session (scratch discoveries + uncorrelated referenced outputs), fetched lazily alongside the
// timeline; and a path→content cache for the on-demand "expand" leaf. Same lazy lifecycle as the
// timeline/blob caches so a long browse can't grow memory without bound.
export const sessionGeneratedFiles = signal<Record<string, { files: GeneratedFileRef[]; truncated: boolean }>>({})
export const generatedFileCache = signal<Record<string, GeneratedFileContent>>({})

// LRU bound on cached session detail. A session's detail (timeline entries + per-file ops) is
// the heavy part: the bulk payload ships only lightweight cards, and detail is fetched on demand
// (loadSessionDetail). To keep memory bounded when many sessions are opened over a long browse,
// evict the least-recently cached sessions once more than DETAIL_CACHE_MAX are held — revisiting
// an evicted session re-triggers the fetch (and its loading spinner). The cap is generous so
// normal use never evicts an actively-viewed set ("discard only if memory consumption is huge").
const DETAIL_CACHE_MAX = 40
const detailLRU: string[] = []

export function cacheSessionDetail(
  sessionId: string,
  timeline: TimelineEntry[],
  fileOps: FileOpSummary[],
  generatedFiles?: { files: GeneratedFileRef[]; truncated: boolean },
): void {
  const existing = detailLRU.indexOf(sessionId)
  if (existing !== -1) detailLRU.splice(existing, 1)
  detailLRU.push(sessionId)

  const tl: Record<string, TimelineEntry[]> = { ...sessionTimelines.value, [sessionId]: timeline }
  const fo: Record<string, FileOpSummary[]> = { ...sessionFileOps.value, [sessionId]: fileOps }
  const gf: Record<string, { files: GeneratedFileRef[]; truncated: boolean }> = { ...sessionGeneratedFiles.value }
  if (generatedFiles) gf[sessionId] = generatedFiles
  while (detailLRU.length > DETAIL_CACHE_MAX) {
    const evicted = detailLRU.shift()
    if (evicted === undefined) break
    delete tl[evicted]
    delete fo[evicted]
    delete gf[evicted]
  }
  sessionTimelines.value = tl
  sessionFileOps.value = fo
  sessionGeneratedFiles.value = gf
}

// Request one generated file's content on expand (TRDD-ZS1GDXVY). Deduped: an in-flight/loaded path
// is not re-requested. Routes through vscode.postMessage — in VS Code the dashboardPanel reads the
// file; in standalone the inline shim fetches /api/generated-file. The reply lands as a
// generatedFileContent message → cacheGeneratedFileContent.
const generatedFileInFlight = new Set<string>()
export function loadGeneratedFile(path: string): void {
  if (!path || generatedFileInFlight.has(path) || generatedFileCache.value[path] !== undefined) return
  generatedFileInFlight.add(path)
  vscode?.postMessage({ type: 'loadGeneratedFile', path })
}

export function cacheGeneratedFileContent(content: GeneratedFileContent): void {
  generatedFileInFlight.delete(content.path)
  generatedFileCache.value = { ...generatedFileCache.value, [content.path]: content }
}

// Per-session context composition (host-parsed from the raw .jsonl on demand — the exact injected
// blocks: hooks, skill/tool/agent/mcp catalogs, file reads, reminders). Fetched lazily via a
// loadContextComposition message; null means the session has no local Claude log to parse. Bounded
// by the same LRU discipline as the timeline cache so a long browse can't grow it without limit.
export const sessionCompositions = signal<Record<string, ContextComposition | null>>({})
const compositionLRU: string[] = []

// Per-session full per-step context history (host-reconstructed from the raw .jsonl, loaded lazily
// by the History tab + the Context tab's resident-cost panel). Keyed by sessionId. A present `null`
// means the host had no local transcript to reconstruct (OTEL-only session); an absent key means
// "not yet fetched".
export const sessionHistories = signal<Record<string, import('./types').ContextHistory | null>>({})

// Request one session's context history on demand (TRDD-W0RRL2FZ). Deduped: an in-flight/loaded
// session is not re-requested. Routes through vscode.postMessage — in VS Code the dashboardPanel
// reconstructs the history; in standalone the inline shim proxies /api/history. Falls back to a
// direct fetch when no vscode API is present so the standalone page still works if the shim is
// absent. The reply lands as a contextHistory message → cacheSessionHistory.
const historyInFlight = new Set<string>()
export function requestContextHistory(sessionId: string, parentSessionId?: string): void {
  if (!sessionId || historyInFlight.has(sessionId) || sessionId in sessionHistories.value) return
  historyInFlight.add(sessionId)
  if (vscode) {
    vscode.postMessage({ type: 'loadContextHistory', sessionId, parentSessionId })
    return
  }
  const url = `/api/history/${encodeURIComponent(sessionId)}${parentSessionId ? '?parent=' + encodeURIComponent(parentSessionId) : ''}`
  fetch(url)
    .then(r => r.json())
    .then((data: { history: import('./types').ContextHistory | null }) => cacheSessionHistory(sessionId, data.history ?? null))
    // null is the honest terminal state ("no transcript"), never a perpetual pending key.
    .catch(() => cacheSessionHistory(sessionId, null))
}

export function cacheSessionHistory(sessionId: string, history: import('./types').ContextHistory | null): void {
  historyInFlight.delete(sessionId)
  sessionHistories.value = { ...sessionHistories.value, [sessionId]: history }
}

// Per-CALL full literal context tree (TRDD-ICHAVFCS), reconstructed by the host from Claude Code's
// raw OTEL request body and fetched lazily over HTTP when an LLM call is expanded. Keyed by
// `${sessionId}::${req:requestId | span:spanId}`. A present `null` means the raw body was NOT
// captured for that call (legacy / OTEL-only before raw-body logging was on); an absent key means
// "not yet fetched". This is what lets an OTEL-only call show its whole context with no local .jsonl.
export const callContexts = signal<Record<string, import('./types').CallContext | null>>({})

// Per-session OTEL-raw-body composition summary (TRDD-CTXQUERY, dashboard piece 1). Fetched LAZILY —
// only when the user expands a session's "OTEL context composition" panel — from /api/composition-index/:id
// (which parses the raw bodies on demand and LRU-caches server-side). A present value with callsTotal:0
// is the honest "no raw bodies captured" state; null means the fetch failed. Bounded by the same LRU
// discipline as the timeline/composition caches so a long browse can't grow it without bound.
export const sessionCompositionSummaries = signal<Record<string, CompositionSummary | null>>({})
const compositionSummaryLRU: string[] = []
const compositionSummaryInFlight = new Set<string>()

// Request one session's OTEL-raw-body composition summary on expand. Deduped: an in-flight/loaded
// session is not re-requested. Direct fetch (no vscode round-trip): the only runtime is the standalone
// server, so a relative fetch to /api/composition-index is always correct. A failed fetch caches null
// (the honest terminal state), never a perpetual pending key.
export function requestCompositionSummary(sessionId: string): void {
  if (!sessionId || compositionSummaryInFlight.has(sessionId) || sessionId in sessionCompositionSummaries.value) return
  compositionSummaryInFlight.add(sessionId)
  fetch('/api/composition-index/' + encodeURIComponent(sessionId))
    .then(r => r.json())
    .then((data: { summary: CompositionSummary | null }) => cacheCompositionSummary(sessionId, data.summary ?? null))
    .catch(() => cacheCompositionSummary(sessionId, null))
}

export function cacheCompositionSummary(sessionId: string, summary: CompositionSummary | null): void {
  compositionSummaryInFlight.delete(sessionId)
  const existing = compositionSummaryLRU.indexOf(sessionId)
  if (existing !== -1) compositionSummaryLRU.splice(existing, 1)
  compositionSummaryLRU.push(sessionId)
  const next: Record<string, CompositionSummary | null> = { ...sessionCompositionSummaries.value, [sessionId]: summary }
  while (compositionSummaryLRU.length > DETAIL_CACHE_MAX) {
    const evicted = compositionSummaryLRU.shift()
    if (evicted === undefined) break
    delete next[evicted]
  }
  sessionCompositionSummaries.value = next
}

// Per-session NARRATIVE conversation (TRDD-B22NYTOY) — verbatim ordered turns, fetched lazily when
// the Transcript sub-tab is opened. Keyed by sessionId; a present `null` means the host had no
// local transcript (OTEL-only session); an absent key means "not yet fetched". Direct fetch (no
// vscode round-trip) per the requestCompositionSummary precedent: the standalone server is the
// only runtime, so a relative fetch to /api/conversation is always correct.
export const sessionConversations = signal<Record<string, import('./types').Conversation | null>>({})
const conversationLRU: string[] = []
const conversationInFlight = new Set<string>()

export function requestConversation(sessionId: string, parentSessionId?: string): void {
  if (!sessionId || conversationInFlight.has(sessionId) || sessionId in sessionConversations.value) return
  conversationInFlight.add(sessionId)
  const url = `/api/conversation/${encodeURIComponent(sessionId)}${parentSessionId ? '?parent=' + encodeURIComponent(parentSessionId) : ''}`
  fetch(url)
    .then(r => r.json())
    .then((data: { conversation: import('./types').Conversation | null }) => cacheConversation(sessionId, data.conversation ?? null))
    // null is the honest terminal state ("no transcript"), never a perpetual pending key.
    .catch(() => cacheConversation(sessionId, null))
}

export function cacheConversation(sessionId: string, conversation: import('./types').Conversation | null): void {
  conversationInFlight.delete(sessionId)
  const existing = conversationLRU.indexOf(sessionId)
  if (existing !== -1) conversationLRU.splice(existing, 1)
  conversationLRU.push(sessionId)
  const next: Record<string, import('./types').Conversation | null> = { ...sessionConversations.value, [sessionId]: conversation }
  while (conversationLRU.length > DETAIL_CACHE_MAX) {
    const evicted = conversationLRU.shift()
    if (evicted === undefined) break
    delete next[evicted]
  }
  sessionConversations.value = next
}

export function cacheSessionComposition(sessionId: string, composition: ContextComposition | null): void {
  const existing = compositionLRU.indexOf(sessionId)
  if (existing !== -1) compositionLRU.splice(existing, 1)
  compositionLRU.push(sessionId)

  const next: Record<string, ContextComposition | null> = { ...sessionCompositions.value, [sessionId]: composition }
  while (compositionLRU.length > DETAIL_CACHE_MAX) {
    const evicted = compositionLRU.shift()
    if (evicted === undefined) break
    delete next[evicted]
  }
  sessionCompositions.value = next
}

// ── Live-tail refresh (TRDD-U0UYC38A) ──────────────────────────────────────────
// The standalone server pushes a `sessionChanged` SSE event the instant a session's raw .jsonl
// grows (see App.tsx handler). These two helpers turn that signal into a live view.

// Drop the focused session's on-demand drill caches so the History tab + Traces composition
// re-fetch the newest turns. Called ONLY for the session the user is currently viewing (App.tsx
// gates on focusedSessionId), which is what keeps this from causing refetch storms when many
// background sessions grow at once. Deleting a key from sessionCompositions leaves a now-stale
// compositionLRU entry, which is harmless: the LRU eviction just skips missing keys, and a later
// re-fetch re-registers the key via cacheSessionComposition.
export function invalidateSessionDrill(sessionId: string): void {
  if (sessionId in sessionHistories.value) {
    const next = { ...sessionHistories.value }
    delete next[sessionId]
    sessionHistories.value = next
  }
  if (sessionId in sessionCompositions.value) {
    const next = { ...sessionCompositions.value }
    delete next[sessionId]
    sessionCompositions.value = next
  }
  // Also drop the OTEL-raw-body composition summary so a live-growing session re-parses its newest
  // bodies on the next expand (the panel re-fires requestCompositionSummary when its key is absent).
  if (sessionId in sessionCompositionSummaries.value) {
    const next = { ...sessionCompositionSummaries.value }
    delete next[sessionId]
    sessionCompositionSummaries.value = next
  }
}

// Merge server-pushed changed cards into the session list immediately (sub-second) instead of
// waiting for the ~1s coalesced full-summary push. OTEL precedence is preserved — a 'log'-sourced
// card never overwrites an existing 'otel' card (the authoritative full push reconciles fully); it
// only inserts new sessions or refreshes other log-sourced cards. Re-sorted newest-first to match
// the server's own ordering so the list order stays stable across the later full push.
export function mergeChangedSessionCards(cards: SessionSummaryCard[]): void {
  const cur = sessionSummary.value
  if (!cur || cards.length === 0) return
  const byId = new Map(cur.sessions.map(s => [s.sessionId, s]))
  let mutated = false
  for (const c of cards) {
    const existing = byId.get(c.sessionId)
    if (existing && (existing.dataSource ?? 'otel') === 'otel') continue  // OTEL always wins
    byId.set(c.sessionId, c)
    mutated = true
  }
  if (!mutated) return
  const merged = [...byId.values()].sort((a, b) => Date.parse(b.startTime || '0') - Date.parse(a.startTime || '0'))
  sessionSummary.value = { ...cur, sessions: merged }
}

// ── UI control signals ────────────────────────────────────────────────────────

// Focused session — set by clicking any session in any view.
// Traces and Flow auto-open to it; a context bar shows it across all tabs.
export const focusedSessionId = signal<string | null>(null)

// Focused turn — set by clicking a single point on the Context Growth chart (or a
// token bar). Carries the exact timeline step's spanId so the session detail opens
// straight to the trace tab and scrolls/highlights THAT event with its token count
// (answers "clicking the graph should open the exact event"). Cleared when the
// session is deselected.
export const focusedTurn = signal<{ sessionId: string; spanId: string } | null>(null)

// ── Trace timeline metric (P2.1: hoisted out of per-session TimelineWaterfall so the
// metric toggle lives in ONE sticky place and every open trace shares the selection) ──
export type TimelineMetric = 'time' | 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'cost'
export const timelineMetric = signal<TimelineMetric>('time')
export const timelineSortByValue = signal(false)
// Group the trace into a session → turn → step tree (P2.2). On by default; the toggle lets
// the user fall back to the flat chronological waterfall.
export const timelineGroupByTurn = signal(true)

// Cache-hit-rate SLI: sessions whose hit rate (cache_read / (cache_read + cache_create)) falls
// below this fraction are flagged (Cache tab worst-sessions, Alerts, and a trace card badge). The
// Anthropic "prompt caching is everything" post treats the hit rate like an uptime SLI — a few
// points of miss rate move cost/latency a lot — so 0.7 is a deliberately conservative default.
export const cacheHitSliThreshold = signal(0.7)

export const sessionLimit = signal(25)
export const selectedAgentFilter = signal<AgentFilter>('all')
export const initiatorFilter = signal<InitiatorFilter>('all')
export const dataSourceFilter = signal<DataSourceFilter>('all')
export const insightFilter = signal<InsightFilter>('all')
export const workspaceFilter = signal<WorkspaceFilter>('all')
export const activeTab = signal('sessions')

// ── Ingestion settings ────────────────────────────────────────────────────────

export const enableOtelIngestion = signal(true)
export const enableLogIngestion = signal(true)
export const otlpPort = signal(4318)

// ── Session retention signals ─────────────────────────────────────────────────

export const swRetainedSessions = signal<SessionSummaryCard[]>([])
export const swLastSessionCount = signal(0)

// ── Set-based signals ─────────────────────────────────────────────────────────

export const dismissedSpanIds = makeSetSignal<string>()
export const lastSeenTraceIds = makeSetSignal<string>()
export const ignoredInsightKeys = makeSetSignal<string>()

// ── VS Code API handle ────────────────────────────────────────────────────────

export let vscode: VsCodeApi | null = null
export function setVscode(api: VsCodeApi): void { vscode = api }

// ── Navigation helpers ────────────────────────────────────────────────────────

export function goToHelp(anchor: string): void {
  activeTab.value = 'help'
  setTimeout(() => {
    const el = document.getElementById(anchor)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, 80)
}

// ── Color palette ─────────────────────────────────────────────────────────────

export const COLORS = [
  '#4fc3f7', '#81c784', '#ffb74d', '#e57373', '#ba68c8', '#4dd0e1',
  '#fff176', '#a1887f', '#90a4ae', '#f06292', '#aed581', '#7986cb',
]

// ── Workspace helpers ─────────────────────────────────────────────────────────

export function shortWorkspaceName(ws: string): string {
  if (!ws) return 'Unknown project'
  const parts = ws.replace(/\\/g, '/').split('/').filter(Boolean)
  if (parts.length === 0) return ws
  if (parts.length === 1) return parts[0]
  return parts.slice(-2).join('/')
}

// ── Derived (computed) signals ─────────────────────────────────────────────────

export const availableWorkspaces = computed<string[]>(() => {
  const all = sessionSummary.value?.sessions ?? []
  const paths = new Set(all.map(s => s.workspace ?? ''))
  return [...paths].sort((a, b) =>
    shortWorkspaceName(a).localeCompare(shortWorkspaceName(b), undefined, { sensitivity: 'base' })
  )
})

export const agentFilteredSessions = computed<SessionSummaryCard[]>(() => {
  let all = sessionSummary.value?.sessions ?? []
  const filter = selectedAgentFilter.value
  if (filter !== 'all') all = all.filter(s => s.source === filter)
  const dsFilter = dataSourceFilter.value
  if (dsFilter !== 'all') all = all.filter(s => (s.dataSource ?? 'otel') === dsFilter)
  const wsFilter = workspaceFilter.value
  if (wsFilter !== 'all') all = all.filter(s => (s.workspace ?? '') === wsFilter)
  return all
})

export const displaySessions = computed<SessionSummaryCard[]>(() => {
  const all = agentFilteredSessions.value
  const limit = sessionLimit.value
  if (limit >= all.length) return all
  return all.slice(0, limit)   // sessions are newest-first; take the first N (most recent)
})

// Sessions scoped to the active time range + agent filter.
// Live/All → in-memory displaySessions.
// Bounded preset → merge DB results with in-memory sessions that fall in the window
// so that sessions not yet persisted to the DB are never missed.
export const rangedSessions = computed<SessionSummaryCard[]>(() => {
  const range = timeRange.value
  const agent = selectedAgentFilter.value

  if (range.preset === 'all') {
    return agentFilteredSessions.value
  }

  const since = range.since ?? 0
  const until = range.until ?? Date.now()

  // Always include in-memory sessions that fall in the window (covers sessions not yet in DB)
  const allInMemory = agentFilteredSessions.value
  const inMemory = allInMemory.filter(s => {
    if (!s.startTime) return false
    const ms = new Date(s.startTime).getTime()
    return ms >= since && ms <= until
  })

  const dbResults = rangedSearchResults.value
  if (!dbResults) return inMemory  // still loading — show in-memory matches as fallback

  // Merge DB results (historical) with in-memory sessions, deduplicate by sessionId
  const dbIds = new Set(dbResults.sessions.map(s => s.sessionId))
  const merged = [
    ...dbResults.sessions,
    ...inMemory.filter(s => !dbIds.has(s.sessionId)),
  ]
  merged.sort((a, b) => Date.parse(b.startTime || '0') - Date.parse(a.startTime || '0'))

  const wsFilter = workspaceFilter.value
  const scoped = wsFilter === 'all' ? merged : merged.filter(s => (s.workspace ?? '') === wsFilter)

  if (agent === 'all') return scoped
  return scoped.filter(s => s.source === agent)
})

// Text-filtered + sorted view of rangedSessions — used by Efficiency, Cost, Traces, Search, Insights
export const filteredSessions = computed<SessionSummaryCard[]>(() => {
  let sessions = rangedSessions.value
  const evIds = evidenceSessionIds.value
  if (evIds !== null) {
    sessions = sessions.filter(s => evIds.has(s.sessionId))
  } else {
    const text = sessionTextFilter.value.toLowerCase().trim()
    if (text) {
      sessions = sessions.filter(s => (s.userRequest ?? '').toLowerCase().includes(text))
    }
  }
  const iFilter = initiatorFilter.value
  if (iFilter !== 'all') {
    sessions = sessions.filter(s => (s.initiator ?? 'user') === iFilter)
  }
  const key = sessionSortKey.value
  const dir = sessionSortDir.value
  if (key === 'start_time') return dir === 'asc' ? [...sessions].reverse() : sessions
  return [...sessions].sort((a, b) => {
    let cmp = 0
    switch (key) {
      case 'total_tokens': cmp = (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens); break
      case 'duration_ms':  cmp = b.durationMs - a.durationMs; break
      case 'errors':       cmp = b.errors - a.errors; break
      case 'prompt':       cmp = (a.userRequest ?? '').localeCompare(b.userRequest ?? ''); break
      case 'model':        cmp = (a.model ?? '').localeCompare(b.model ?? ''); break
      case 'source':       cmp = (a.source ?? '').localeCompare(b.source ?? ''); break
      case 'cost': {
        const costA = calcSessionCost(a, 'token').totalUsd
        const costB = calcSessionCost(b, 'token').totalUsd
        cmp = costB - costA
        break
      }
    }
    return dir === 'asc' ? -cmp : cmp
  })
})

export const agentPresence = computed(() => {
  const sessions = rangedSessions.value
  return {
    claude:    sessions.some(s => s.source === 'claude_code'),
    copilot:   sessions.some(s => s.source === 'copilot'),
    codex:     sessions.some(s => s.source === 'codex'),
    opencode:  sessions.some(s => s.source === 'opencode'),
  }
})
