// TRDD-CCFORNSC — cache_creation forensic diagnostics: "who is burning the EXPENSIVE cache_creation
// (1.25x write-rate) tokens, and with what content". Productizes two ad-hoc forensic scripts
// (archived at scripts_dev/cache-forensics/cc_scan.py, cc_trace.py) into two MCP tools.
//
// cache_creation_input_tokens is billed at ~1.25x the base input rate — a cold PREFIX WRITE (the
// server had no cached prefix to reuse, so it re-writes the whole context into the cache). This is
// the single most expensive per-token bucket short of raw output, and is invisible in aggregate
// "hit rate" summaries, which hide WHICH single events are the writes and WHO caused them.
//
// CORRELATION (empirically discovered while building TRDD-ICHAVFCS's OTEL body export): a response
// body's `id` (msg_...) is referenced by the FOLLOWING request's `diagnostics.previous_message_id`
// — every Claude Code turn's request carries the id of the response it is replying to. So: index
// every request by previous_message_id -> {sessionId, accountUuid, model, path}; a response's
// session is the session of the request that immediately follows it. The LAST turn of a session (or
// one still in flight) has no following request — those responses are UNATTRIBUTABLE and are
// reported as an explicit bucket, never hidden or silently dropped.
//
// LAZY + BOUNDED (mirrors contextCompositionIndex.ts's contract): the bodies directory can hold
// 15k+ files. This module NEVER loads them all into memory. fs.readdirSync + fs.statSync are cheap
// metadata-only operations over the whole directory; only a bounded, most-recent-first SLICE of
// files is actually opened and JSON-parsed. Every report carries a `coverage` block stating exactly
// what was scanned vs skipped, so a bounded scan is never mistaken for full history.
//
// POINTER-ONLY: this module never returns base64 image bytes or the raw metadata.user_id token
// blob. Only derived identifiers (session_id, account_uuid — both non-secret) and token counts /
// file paths (pointers, not content) cross the MCP boundary.

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { parseUserId } from './rawBodyContext'
import { buildCallComposition, type CallComposition } from './contextCompositionIndex'
import { calcTokenCostUsd } from './shared/pricing'

export const DEFAULT_BODIES_DIR = path.join(os.homedir(), '.agentlens', 'otel-bodies')

// Bounded scan caps — same convention as HOG_SCAN_CAP / CAUSE_SCAN_CAP in mcpServer.ts, sized for
// the (much larger) raw-body-file universe rather than the session universe. Only metadata (name +
// mtime) is read for files beyond these caps; JSON content is parsed for the capped slice only.
export const RESPONSE_SCAN_CAP = 4000
export const REQUEST_INDEX_CAP = 4000
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
// Matches rawBodyContext's own MAX_RAW_BODY_BYTES guard — request bodies carry embedded images and
// can be tens of MB; this bounds worst-case per-file memory, not the number of files touched.
export const MAX_REQUEST_BYTES = 64 * 1024 * 1024

export interface CacheCreationEvent {
  cacheCreateTokens: number
  cacheReadTokens: number
  inputTokens: number
  outputTokens: number
  costUsd: number             // cost of JUST the cache_creation write: calcTokenCostUsd(0, 0, cc, 0, model)
  // TRDD-CCFORNSC — the cache_creation write splits into TWO TTL tiers (Anthropic's `usage.cache_creation`
  // sub-object): a 5-minute ephemeral write and a 1-hour ephemeral write. A write in the 1h tier was
  // never going to expire on a 5-min clock, so this split is what tells TTL-expiry apart from a genuine
  // cache BREAK (see buildCacheBreakGapReport). Always present (0 when the response carries no split).
  cacheCreation5mTokens: number
  cacheCreation1hTokens: number
  model?: string
  responseId?: string
  ts: number                  // response file mtime (epoch ms) — proxy for call time
  responseRef: string
  requestRef?: string
  sessionId?: string
  accountUuid?: string
  attributed: boolean
}

export interface CacheCreationScanCoverage {
  bodiesDir: string
  dirExists: boolean
  responseFilesTotal: number
  responseFilesScanned: number
  requestFilesTotal: number
  requestFilesIndexed: number
  scanCap: number
  windowHours?: number
  complete: boolean
  note: string
}

export interface CacheCreationScanOptions {
  bodiesDir?: string
  windowHours?: number
  scanCap?: number
}

interface RawResponseBody {
  id?: unknown
  model?: unknown
  message?: { model?: unknown }
  usage?: {
    input_tokens?: unknown
    output_tokens?: unknown
    cache_read_input_tokens?: unknown
    cache_creation_input_tokens?: unknown
    cache_creation?: { ephemeral_5m_input_tokens?: unknown; ephemeral_1h_input_tokens?: unknown }
  }
}

interface RawRequestMeta {
  model?: unknown
  metadata?: { user_id?: unknown }
  diagnostics?: { previous_message_id?: unknown }
}

function numOr0(v: unknown): number { return typeof v === 'number' && isFinite(v) ? v : 0 }
function strOrUndef(v: unknown): string | undefined { return typeof v === 'string' && v.length > 0 ? v : undefined }

export interface DirEntry { name: string; path: string; mtimeMs: number }

// List a directory's entries matching a suffix, paired with mtime — WITHOUT reading file content.
// The cheap first pass every bounded scan starts from (readdir + stat are metadata-only syscalls).
// Exported so the cache-break TIMELINE (cacheBreakTimeline.ts) reuses the identical bounded-scan
// primitives instead of duplicating them (one source of truth for the disk-scan contract).
export function listBySuffix(dir: string, suffix: string): DirEntry[] {
  let names: string[]
  try { names = fs.readdirSync(dir) } catch { return [] }
  const out: DirEntry[] = []
  for (const n of names) {
    if (!n.endsWith(suffix)) continue
    const p = path.join(dir, n)
    try {
      const st = fs.statSync(p)
      if (st.isFile()) out.push({ name: n, path: p, mtimeMs: st.mtimeMs })
    } catch { /* file vanished between readdir and stat — skip it, not fatal */ }
  }
  return out
}

// Bounded, recency-first slice: newest mtime first, optionally windowed, capped at `cap` entries.
// `matched` is the count BEFORE the cap (how many fell in the window) so callers can report honest
// sample-vs-total coverage.
export function boundedRecent(entries: DirEntry[], opts: { windowHours?: number; cap: number }): { slice: DirEntry[]; matched: number } {
  let matched = entries
  if (opts.windowHours !== undefined && opts.windowHours > 0) {
    const cutoff = Date.now() - opts.windowHours * 3_600_000
    matched = matched.filter(e => e.mtimeMs >= cutoff)
  }
  const sorted = [...matched].sort((a, b) => b.mtimeMs - a.mtimeMs)
  return { slice: sorted.slice(0, opts.cap), matched: matched.length }
}

export function readJsonBounded<T>(filePath: string, maxBytes: number): T | null {
  let st: fs.Stats
  try { st = fs.statSync(filePath) } catch { return null }
  if (!st.isFile() || st.size > maxBytes) return null
  let raw: string
  try { raw = fs.readFileSync(filePath, 'utf8') } catch { return null }
  try { return JSON.parse(raw) as T } catch { return null }
}

// Index request bodies by the RESPONSE id they reference (diagnostics.previous_message_id) — the
// join key that attributes a response's cache_creation to a session/account (see module doc above).
interface RequestLink { sessionId?: string; accountUuid?: string; model?: string; path: string }
function indexRequestsByPreviousMessageId(entries: DirEntry[]): Map<string, RequestLink> {
  const index = new Map<string, RequestLink>()
  for (const e of entries) {
    const q = readJsonBounded<RawRequestMeta>(e.path, MAX_REQUEST_BYTES)
    if (!q) continue
    const pmid = strOrUndef(q.diagnostics?.previous_message_id)
    if (!pmid) continue
    const uid = parseUserId(q.metadata?.user_id)
    index.set(pmid, { sessionId: uid.sessionId, accountUuid: uid.accountUuid, model: strOrUndef(q.model), path: e.path })
  }
  return index
}

/** The shared bounded scan both cache-creation-forensic tools build on: every response body with a
 *  non-zero cache_creation_input_tokens, joined to its owning session via the previous_message_id
 *  chain. Never reads more than `scanCap` response files + `scanCap` request files (default
 *  RESPONSE_SCAN_CAP/REQUEST_INDEX_CAP) — a directory with 15k+ bodies is NEVER loaded whole. */
export async function scanCacheCreationEvents(
  opts: CacheCreationScanOptions = {},
): Promise<{ events: CacheCreationEvent[]; coverage: CacheCreationScanCoverage }> {
  const bodiesDir = opts.bodiesDir ?? DEFAULT_BODIES_DIR
  const scanCap = opts.scanCap ?? RESPONSE_SCAN_CAP
  const dirExists = fs.existsSync(bodiesDir)
  if (!dirExists) {
    return {
      events: [],
      coverage: {
        bodiesDir, dirExists: false, responseFilesTotal: 0, responseFilesScanned: 0,
        requestFilesTotal: 0, requestFilesIndexed: 0, scanCap, windowHours: opts.windowHours,
        complete: true,
        note: `No OTEL raw-body directory at ${bodiesDir} — set OTEL_LOG_RAW_API_BODIES to capture bodies.`,
      },
    }
  }

  const allResponses = listBySuffix(bodiesDir, '.response.json')
  const allRequests  = listBySuffix(bodiesDir, '.request.json')
  const { slice: responseSlice, matched: responseMatched } = boundedRecent(allResponses, { windowHours: opts.windowHours, cap: scanCap })
  // Requests are indexed over the SAME window + a matching cap — the request that attributes a
  // response arrives moments later (the next turn), so windowing both sides together keeps the join
  // intact without ever indexing the whole directory.
  const { slice: requestSlice } = boundedRecent(allRequests, { windowHours: opts.windowHours, cap: REQUEST_INDEX_CAP })
  const prevIndex = indexRequestsByPreviousMessageId(requestSlice)

  const events: CacheCreationEvent[] = []
  for (const r of responseSlice) {
    const body = readJsonBounded<RawResponseBody>(r.path, MAX_RESPONSE_BYTES)
    if (!body || !body.usage) continue
    const cc = numOr0(body.usage.cache_creation_input_tokens)
    if (cc <= 0) continue
    const responseId = strOrUndef(body.id)
    const link = responseId ? prevIndex.get(responseId) : undefined
    const model = link?.model ?? strOrUndef(body.model) ?? strOrUndef(body.message?.model)
    const tier = body.usage.cache_creation
    events.push({
      cacheCreateTokens: cc,
      cacheReadTokens: numOr0(body.usage.cache_read_input_tokens),
      inputTokens: numOr0(body.usage.input_tokens),
      outputTokens: numOr0(body.usage.output_tokens),
      costUsd: model ? calcTokenCostUsd(0, 0, cc, 0, model) : 0,
      cacheCreation5mTokens: numOr0(tier?.ephemeral_5m_input_tokens),
      cacheCreation1hTokens: numOr0(tier?.ephemeral_1h_input_tokens),
      model,
      responseId,
      ts: r.mtimeMs,
      responseRef: r.path,
      requestRef: link?.path,
      sessionId: link?.sessionId,
      accountUuid: link?.accountUuid,
      attributed: Boolean(link),
    })
  }

  const complete = responseSlice.length === responseMatched
  return {
    events,
    coverage: {
      bodiesDir, dirExists: true,
      responseFilesTotal: allResponses.length,
      responseFilesScanned: responseSlice.length,
      requestFilesTotal: allRequests.length,
      requestFilesIndexed: requestSlice.length,
      scanCap, windowHours: opts.windowHours, complete,
      note: complete
        ? `Scanned all ${responseMatched} response body file(s)${opts.windowHours ? ` in the last ${opts.windowHours}h` : ''} (${allResponses.length} total on disk).`
        : `SAMPLE: ${responseSlice.length} most-recent of ${responseMatched} matching response body file(s) scanned (cap ${scanCap}; ${allResponses.length} total on disk). Not full history.`,
    },
  }
}

// ── get_cache_creation_report → the generalized COST-PEAK finder ─────────────────
export type CacheCreationGroupBy = 'session' | 'account' | 'model' | 'time'
// The MCP-facing groupBy dimension additionally offers 'cause' (buildCauseCostPeakReport, in
// cacheBreakTimeline.ts — it needs the full prefix-diff classifier, which lives there, not here). Kept
// as a separate wider type rather than folding 'cause' into CacheCreationGroupBy itself so
// buildCacheCreationReport's own groupKeyOf stays exhaustive and compile-time safe (it structurally
// cannot be called with a dimension it does not implement).
export type CostPeakGroupBy = CacheCreationGroupBy | 'cause'
// The cost BUCKET a peak is ranked by. cache_creation is the 1.25x/2x prefix WRITE; output is billed
// at ~5x the input rate (sometimes the real culprit, NOT the cache write); input is the uncached input;
// total is every token; billable_weighted is the real USD cost (weights cache_read at 0.1x, output at
// ~5x, cache_creation at 1.25x — the truthful "what did this actually cost" ranking).
export type CostBucket = 'cache_creation' | 'output' | 'input' | 'total' | 'billable_weighted'

export interface CacheCreationGroupRow {
  key: string
  cacheCreateTokens: number
  cacheReadTokens: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  costUsd: number                     // full per-group USD cost (input + cacheRead + cacheCreate + output)
  events: number
  maxSingleCacheCreateTokens: number
  maxSingleOutputTokens: number
  bucketValue: number                 // the ranked-bucket aggregate (what groups are sorted by)
}

export interface OutputSpike {
  sessionId?: string
  accountUuid?: string
  model?: string
  outputTokens: number
  cacheCreateTokens: number
  ts: string
}

export interface CacheCreationReport {
  bucket: CostBucket
  groupBy: CostPeakGroupBy
  windowHours?: number
  totalCacheCreateTokens: number
  totalCacheReadTokens: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCostUsd: number
  unattributed: { events: number; cacheCreateTokens: number; costUsd: number; note: string }
  outputSpikes: { note: string; top: OutputSpike[] }   // explicit: OUTPUT tokens (billed ~5x) can be the real peak
  groups: CacheCreationGroupRow[]
  coverage: CacheCreationScanCoverage
}

// Round a timestamp down to its containing hour, formatted as a compact bucket label — the 'time'
// groupBy dimension (e.g. "2026-07-08T14:00").
function hourBucket(ts: number): string {
  return new Date(Math.floor(ts / 3_600_000) * 3_600_000).toISOString().slice(0, 13) + ':00'
}

function groupKeyOf(e: CacheCreationEvent, groupBy: CacheCreationGroupBy): string {
  switch (groupBy) {
    case 'account': return e.accountUuid ?? '(unattributed)'
    case 'model':   return e.model ?? '(unknown model)'
    case 'time':    return hourBucket(e.ts)
    case 'session':
    default:        return e.sessionId ?? '(unattributed)'
  }
}

// Generic token-cost primitives — exported so buildCauseCostPeakReport (cacheBreakTimeline.ts) ranks
// its cause groups by the SAME bucket formulas as buildCacheCreationReport, without cacheBreakTimeline
// needing to import CacheCreationEvent itself (it has its own per-turn shape). Any object with these
// four counts + an optional model satisfies TokenCounts structurally.
export interface TokenCounts {
  inputTokens: number
  cacheReadTokens: number
  cacheCreateTokens: number
  outputTokens: number
  model?: string
}
export function tokenCountsTotal(t: TokenCounts): number {
  return t.inputTokens + t.cacheReadTokens + t.cacheCreateTokens + t.outputTokens
}
export function tokenCountsFullCost(t: TokenCounts): number {
  return t.model ? calcTokenCostUsd(t.inputTokens, t.cacheReadTokens, t.cacheCreateTokens, t.outputTokens, t.model) : 0
}
export function bucketValueOf(t: TokenCounts, bucket: CostBucket): number {
  switch (bucket) {
    case 'output':            return t.outputTokens
    case 'input':             return t.inputTokens
    case 'total':             return tokenCountsTotal(t)
    case 'billable_weighted': return tokenCountsFullCost(t)
    case 'cache_creation':
    default:                  return t.cacheCreateTokens
  }
}

/** The COST-PEAK finder: ranks WHO/WHAT is burning the most of a chosen cost bucket
 *  {cache_creation | output | input | total | billable_weighted} — because the peak is sometimes an
 *  OUTPUT-token spike (billed ~5x), not a cache write. Aggregates by session, account, model, or hourly
 *  time-window. Always reports an explicit unattributed bucket AND surfaces the biggest single output
 *  spikes, so the output-token culprit is never hidden behind the cache_creation totals. */
export async function buildCacheCreationReport(
  opts: CacheCreationScanOptions & { groupBy?: CacheCreationGroupBy; bucket?: CostBucket; topN?: number } = {},
): Promise<CacheCreationReport> {
  // Fail-fast (never silently mis-group): groupBy='cause' needs the full prefix-diff classifier, which
  // lives in cacheBreakTimeline.ts's buildCauseCostPeakReport, not here. CacheCreationGroupBy already
  // excludes 'cause' at the type level for in-repo callers; this guard catches an untyped/JSON caller
  // (e.g. the raw MCP args boundary) that slips 'cause' through as a plain string.
  if ((opts.groupBy as string | undefined) === 'cause') {
    throw new Error("groupBy='cause' is served by buildCauseCostPeakReport (./cacheBreakTimeline), not buildCacheCreationReport.")
  }
  const groupBy = opts.groupBy ?? 'session'
  const bucket = opts.bucket ?? 'cache_creation'
  const topN = Math.min(opts.topN ?? 15, 50)
  const { events, coverage } = await scanCacheCreationEvents(opts)

  const groups = new Map<string, CacheCreationGroupRow>()
  let totalCC = 0, totalCR = 0, totalIn = 0, totalOut = 0, totalCost = 0
  let unattrEvents = 0, unattrCC = 0, unattrCost = 0
  for (const e of events) {
    const fullCost = tokenCountsFullCost(e)
    totalCC += e.cacheCreateTokens; totalCR += e.cacheReadTokens; totalIn += e.inputTokens; totalOut += e.outputTokens; totalCost += fullCost
    if (!e.attributed) { unattrEvents += 1; unattrCC += e.cacheCreateTokens; unattrCost += fullCost }
    const key = groupKeyOf(e, groupBy)
    const g = groups.get(key) ?? { key, cacheCreateTokens: 0, cacheReadTokens: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, events: 0, maxSingleCacheCreateTokens: 0, maxSingleOutputTokens: 0, bucketValue: 0 }
    g.cacheCreateTokens += e.cacheCreateTokens
    g.cacheReadTokens += e.cacheReadTokens
    g.inputTokens += e.inputTokens
    g.outputTokens += e.outputTokens
    g.totalTokens += tokenCountsTotal(e)
    g.costUsd += fullCost
    g.events += 1
    g.maxSingleCacheCreateTokens = Math.max(g.maxSingleCacheCreateTokens, e.cacheCreateTokens)
    g.maxSingleOutputTokens = Math.max(g.maxSingleOutputTokens, e.outputTokens)
    g.bucketValue += bucketValueOf(e, bucket)
    groups.set(key, g)
  }
  const ranked = [...groups.values()]
    .map(g => ({ ...g, costUsd: +g.costUsd.toFixed(4), bucketValue: +g.bucketValue.toFixed(4) }))
    .sort((a, b) => b.bucketValue - a.bucketValue)

  const outputTop = [...events]
    .filter(e => e.outputTokens > 0)
    .sort((a, b) => b.outputTokens - a.outputTokens)
    .slice(0, 5)
    .map(e => ({ sessionId: e.sessionId, accountUuid: e.accountUuid, model: e.model, outputTokens: e.outputTokens, cacheCreateTokens: e.cacheCreateTokens, ts: new Date(e.ts).toISOString() }))

  return {
    bucket, groupBy, windowHours: opts.windowHours,
    totalCacheCreateTokens: totalCC, totalCacheReadTokens: totalCR, totalInputTokens: totalIn, totalOutputTokens: totalOut, totalCostUsd: +totalCost.toFixed(4),
    unattributed: {
      events: unattrEvents, cacheCreateTokens: unattrCC, costUsd: +unattrCost.toFixed(4),
      note: 'Responses with no following request in the scanned window (last-turn / still-in-flight calls) — cannot be joined to a session.',
    },
    outputSpikes: {
      note: 'The biggest single OUTPUT-token events (output is billed at ~5x the input rate — sometimes the real cost peak, not the cache write). Rank by bucket=output or bucket=billable_weighted to surface these in the groups.',
      top: outputTop,
    },
    groups: ranked.slice(0, topN),
    coverage,
  }
}

/** Render a cost-peak report. json → the object; the others → a compact string wrapped as
 *  { format, text, coverage }. Reuses the ForensicsFormat contract from the trace tool. */
export function formatCostPeaks(report: CacheCreationReport, format: ForensicsFormat): unknown {
  if (format === 'json') return report
  const lines: string[] = []
  const hdr = `cost peaks by ${report.bucket} — grouped by ${report.groupBy} (top ${report.groups.length})`
  const bucketOf = (g: CacheCreationGroupRow): string => g.bucketValue.toLocaleString()
  if (format === 'markdown') {
    lines.push(`# ${hdr}`, '')
    lines.push('| group | ' + report.bucket + ' | cache_create | output | cost | events |', '|---|---|---|---|---|---|')
    for (const g of report.groups) lines.push(`| ${g.key.slice(0, 20)} | ${bucketOf(g)} | ${g.cacheCreateTokens.toLocaleString()} | ${g.outputTokens.toLocaleString()} | $${g.costUsd} | ${g.events} |`)
    lines.push('', '## Output spikes (billed ~5x)', '')
    for (const s of report.outputSpikes.top) lines.push(`- ${s.outputTokens.toLocaleString()} out tok \`${s.ts}\` ${s.model ?? '?'} ${(s.sessionId ?? '(unattr)').slice(0, 12)}`)
  } else if (format === 'timeline') {
    lines.push(hdr)
    for (const s of report.outputSpikes.top) lines.push(`${s.ts}  🔊 output=${s.outputTokens.toLocaleString()}  cc=${s.cacheCreateTokens.toLocaleString()}  ${s.model ?? '?'}  ${(s.sessionId ?? '(unattr)').slice(0, 12)}`)
  } else { // table
    lines.push(hdr)
    lines.push('  ' + report.bucket.padEnd(14) + ' cache_create      output   cost     group')
    for (const g of report.groups) lines.push(`  ${bucketOf(g).padStart(14)} ${String(g.cacheCreateTokens).padStart(12)} ${String(g.outputTokens).padStart(11)}  $${String(g.costUsd).padStart(7)}  ${g.key.slice(0, 24)}`)
  }
  return { format, text: lines.join('\n'), coverage: report.coverage }
}

// ── trace_expensive_writes ──────────────────────────────────────────────────────
export interface ExpensiveWriteComposition {
  imageTokens: number
  imageCount: number
  toolResultTokens: number
  textTokens: number
  thinkingTokens: number
  systemTokens: number
  toolCatalogTokens: number
  toolCatalogCount: number
}

// One turn in the backward CONTEXT CHAIN leading up to an expensive write — how the context ramped
// to the write. Pointer-only: a composition summary + token totals, never raw text/base64.
export interface BackwardChainTurn {
  ts: string             // ISO — the request-body mtime (call time proxy)
  bodyRef: string        // pointer to the raw request body file — never its content
  composition: ExpensiveWriteComposition | null
}

export interface ExpensiveWriteEvent {
  turn?: number          // 1-based chronological index of this write AMONG its session's scanned cache_creation events
  cacheCreateTokens: number
  outputTokens: number
  costUsd: number
  ts: string             // ISO
  model?: string
  sessionId?: string
  accountUuid?: string
  attributed: boolean
  requestRef?: string    // pointer to the raw request body file — never its content
  responseRef: string    // pointer to the raw response body file — never its content
  composition: ExpensiveWriteComposition | null   // null when no request body could be resolved/parsed
  backwardChain?: BackwardChainTurn[]              // the ordered turns leading up to this write (chainDepth)
}

export interface ExpensiveWritesTraceFilters {
  sessionId?: string
  accountUuid?: string
  model?: string          // substring match
  minCacheCreate?: number
  minOutputTokens?: number
  turnFrom?: number       // filter on the per-session cache_creation-event turn index
  turnTo?: number
  timeFromIso?: string    // absolute time-range filter on the event ts
  timeToIso?: string
  topN?: number
  chainDepth?: number     // how many preceding turns of context to attach per event (0 = off; default 0)
}

export interface ExpensiveWritesTrace {
  minCacheCreate: number
  windowHours?: number
  filters: ExpensiveWritesTraceFilters
  events: ExpensiveWriteEvent[]
  coverage: CacheCreationScanCoverage
}

const TOOL_CATALOG_COUNT_RE = /\((\d+) tools\)/
const MAX_CHAIN_DEPTH = 20

// Reduce a full CallComposition (which carries raw block text) down to POINTER-ONLY summary numbers
// — never forwards a block's text, bytes, or the request's base64 image data.
function compositionSummaryFrom(cc: CallComposition): ExpensiveWriteComposition {
  const catalogBlock = cc.blocks.find(b => b.kind === 'toolCatalog')
  const m = catalogBlock ? TOOL_CATALOG_COUNT_RE.exec(catalogBlock.label) : null
  return {
    imageTokens: cc.images.tokens,
    imageCount: cc.images.count,
    toolResultTokens: cc.toolResultTokens,
    textTokens: cc.textTokens,
    thinkingTokens: cc.thinkingTokens,
    systemTokens: cc.systemTokens,
    toolCatalogTokens: cc.toolCatalogTokens,
    toolCatalogCount: m ? Number(m[1]) : 0,
  }
}

interface RawRequestSession { metadata?: { user_id?: unknown } }

// One bounded request scan grouping every request body by its session_id → ordered (ts, bodyRef) turns.
// The backward-context-chain builder reuses this to find the turns preceding an expensive write WITHOUT
// re-parsing per event. Only run when chainDepth > 0 (it fully parses the bounded request slice).
function scanSessionRequestTurns(bodiesDir: string, opts: CacheCreationScanOptions): Map<string, { ts: number; bodyRef: string }[]> {
  const cap = opts.scanCap ?? REQUEST_INDEX_CAP
  const { slice } = boundedRecent(listBySuffix(bodiesDir, '.request.json'), { windowHours: opts.windowHours, cap })
  const bySession = new Map<string, { ts: number; bodyRef: string }[]>()
  for (const e of slice) {
    const q = readJsonBounded<RawRequestSession>(e.path, MAX_REQUEST_BYTES)
    if (!q) continue
    const sid = parseUserId(q.metadata?.user_id).sessionId
    if (!sid) continue
    const list = bySession.get(sid)
    const entry = { ts: e.mtimeMs, bodyRef: e.path }
    if (list) list.push(entry); else bySession.set(sid, [entry])
  }
  for (const list of bySession.values()) list.sort((a, b) => a.ts - b.ts)
  return bySession
}

/** For the biggest single cache_creation write events, resolves session/account via the
 *  previous_message_id chain and summarizes the CONTENT that made the write so expensive (image /
 *  tool_result / text / system token shares + tool-catalog size) — pointer-only, never raw text or
 *  base64. Rich filters {sessionId, accountUuid, model, minCacheCreate, minOutputTokens, turnRange,
 *  timeRange, topN} narrow the events; chainDepth attaches each event's backward CONTEXT CHAIN (the
 *  ordered turns leading up to it). Answers "what is IN the huge writes and how did the context ramp
 *  to them", complementing buildCacheCreationReport's "who". */
export async function buildExpensiveWritesTrace(
  opts: CacheCreationScanOptions & ExpensiveWritesTraceFilters = {},
): Promise<ExpensiveWritesTrace> {
  const minCacheCreate = Math.max(0, opts.minCacheCreate ?? 0)
  const minOutputTokens = Math.max(0, opts.minOutputTokens ?? 0)
  const topN = Math.min(opts.topN ?? 6, 25)
  const chainDepth = Math.min(Math.max(0, opts.chainDepth ?? 0), MAX_CHAIN_DEPTH)
  const bodiesDir = opts.bodiesDir ?? DEFAULT_BODIES_DIR
  const timeFrom = opts.timeFromIso ? Date.parse(opts.timeFromIso) : undefined
  const timeTo = opts.timeToIso ? Date.parse(opts.timeToIso) : undefined
  const { events, coverage } = await scanCacheCreationEvents(opts)

  // Apply the identity / size / time filters.
  let filtered = events.filter(e =>
    e.cacheCreateTokens >= minCacheCreate &&
    e.outputTokens >= minOutputTokens &&
    (!opts.sessionId || e.sessionId === opts.sessionId) &&
    (!opts.accountUuid || e.accountUuid === opts.accountUuid) &&
    (!opts.model || (e.model ?? '').includes(opts.model)) &&
    (timeFrom === undefined || e.ts >= timeFrom) &&
    (timeTo === undefined || e.ts <= timeTo))

  // Assign a per-session chronological turn index (1-based, among that session's cache_creation events)
  // so a turnRange filter has a stable meaning.
  const perSessionSeq = new Map<string, number>()
  const turnOf = new Map<CacheCreationEvent, number>()
  for (const e of [...filtered].sort((a, b) => a.ts - b.ts)) {
    const sid = e.sessionId ?? '(unattributed)'
    const n = (perSessionSeq.get(sid) ?? 0) + 1
    perSessionSeq.set(sid, n)
    turnOf.set(e, n)
  }
  if (opts.turnFrom !== undefined) filtered = filtered.filter(e => (turnOf.get(e) ?? 0) >= opts.turnFrom!)
  if (opts.turnTo !== undefined) filtered = filtered.filter(e => (turnOf.get(e) ?? 0) <= opts.turnTo!)

  const top = filtered.sort((a, b) => b.cacheCreateTokens - a.cacheCreateTokens).slice(0, topN)

  // The backward-chain session index + a per-body composition cache (a turn shared by two events is
  // parsed once). Built only when chains are requested.
  const sessionTurns = chainDepth > 0 ? scanSessionRequestTurns(bodiesDir, opts) : null
  const compCache = new Map<string, ExpensiveWriteComposition | null>()
  const summarize = async (bodyRef: string, ts: number, exact?: { input: number; output: number; cacheRead: number; cacheCreate: number; responseId?: string }): Promise<ExpensiveWriteComposition | null> => {
    if (compCache.has(bodyRef)) return compCache.get(bodyRef) ?? null
    const cc = await buildCallComposition(bodyRef, 1, ts, exact ? { exact: { inputTokens: exact.input, outputTokens: exact.output, cacheReadTokens: exact.cacheRead, cacheCreateTokens: exact.cacheCreate, responseId: exact.responseId } } : {})
    const summary = cc ? compositionSummaryFrom(cc) : null
    compCache.set(bodyRef, summary)
    return summary
  }

  const out: ExpensiveWriteEvent[] = []
  for (const e of top) {
    const composition = e.requestRef
      ? await summarize(e.requestRef, e.ts, { input: e.inputTokens, output: e.outputTokens, cacheRead: e.cacheReadTokens, cacheCreate: e.cacheCreateTokens, responseId: e.responseId })
      : null

    let backwardChain: BackwardChainTurn[] | undefined
    if (chainDepth > 0 && sessionTurns && e.sessionId) {
      const turns = sessionTurns.get(e.sessionId) ?? []
      const preceding = turns.filter(t => t.ts <= e.ts).slice(-chainDepth)
      backwardChain = []
      for (const t of preceding) {
        backwardChain.push({ ts: new Date(t.ts).toISOString(), bodyRef: t.bodyRef, composition: await summarize(t.bodyRef, t.ts) })
      }
    }

    out.push({
      turn: turnOf.get(e),
      cacheCreateTokens: e.cacheCreateTokens,
      outputTokens: e.outputTokens,
      costUsd: +e.costUsd.toFixed(4),
      ts: new Date(e.ts).toISOString(),
      model: e.model,
      sessionId: e.sessionId,
      accountUuid: e.accountUuid,
      attributed: e.attributed,
      requestRef: e.requestRef,
      responseRef: e.responseRef,
      composition,
      backwardChain,
    })
  }
  return {
    minCacheCreate, windowHours: opts.windowHours,
    filters: { sessionId: opts.sessionId, accountUuid: opts.accountUuid, model: opts.model, minCacheCreate, minOutputTokens, turnFrom: opts.turnFrom, turnTo: opts.turnTo, timeFromIso: opts.timeFromIso, timeToIso: opts.timeToIso, topN, chainDepth },
    events: out, coverage,
  }
}

// ── Output formats for trace_expensive_writes ────────────────────────────────────
export type ForensicsFormat = 'json' | 'table' | 'markdown' | 'timeline'

function dominantComponent(c: ExpensiveWriteComposition | null): string {
  if (!c) return '(no body)'
  const parts: [string, number][] = [['image', c.imageTokens], ['tool_result', c.toolResultTokens], ['text', c.textTokens], ['thinking', c.thinkingTokens], ['system', c.systemTokens], ['toolCatalog', c.toolCatalogTokens]]
  const top = parts.sort((a, b) => b[1] - a[1])[0]
  return top[1] > 0 ? `${top[0]}~${top[1].toLocaleString()}` : '(mixed)'
}

/** Render an expensive-writes trace in the requested format. json → the object; the others → a compact
 *  string wrapped as { format, text, coverage } so the MCP result stays JSON-serializable. */
export function formatExpensiveWrites(trace: ExpensiveWritesTrace, format: ForensicsFormat): unknown {
  if (format === 'json') return trace
  const lines: string[] = []
  const hdr = `expensive cache_creation writes — top ${trace.events.length}${trace.filters.sessionId ? ` [session ${trace.filters.sessionId}]` : ''}`
  if (format === 'markdown') {
    lines.push(`# ${hdr}`, '')
    lines.push('| # | tokens | out | cost | model | session | dominant |', '|---|---|---|---|---|---|---|')
    trace.events.forEach((e, i) => lines.push(`| ${i + 1} | ${e.cacheCreateTokens.toLocaleString()} | ${e.outputTokens.toLocaleString()} | $${e.costUsd} | ${e.model ?? '?'} | ${(e.sessionId ?? '(unattr)').slice(0, 12)} | ${dominantComponent(e.composition)} |`))
    for (const e of trace.events) {
      if (!e.backwardChain?.length) continue
      lines.push('', `## Context ramp → write @ ${e.ts} (${e.cacheCreateTokens.toLocaleString()} tok)`)
      e.backwardChain.forEach((t, i) => lines.push(`- t-${e.backwardChain!.length - i}: \`${t.ts}\` ${dominantComponent(t.composition)}`))
    }
  } else if (format === 'timeline') {
    lines.push(hdr)
    for (const e of [...trace.events].sort((a, b) => a.ts.localeCompare(b.ts))) {
      lines.push(`${e.ts}  💥 ${e.cacheCreateTokens.toLocaleString()} tok  out=${e.outputTokens.toLocaleString()}  ${e.model ?? '?'}  ${(e.sessionId ?? '(unattr)').slice(0, 12)}  ← ${dominantComponent(e.composition)}`)
    }
  } else { // table
    lines.push(hdr)
    lines.push('  #      tokens       out    cost   dominant            session')
    trace.events.forEach((e, i) => lines.push(`${String(i + 1).padStart(3)}  ${String(e.cacheCreateTokens).padStart(11)}  ${String(e.outputTokens).padStart(8)}  $${String(e.costUsd).padStart(6)}  ${dominantComponent(e.composition).padEnd(18)}  ${(e.sessionId ?? '(unattr)').slice(0, 12)}`))
  }
  return { format, text: lines.join('\n'), coverage: trace.coverage }
}

// ── get_cache_break_gap_report ──────────────────────────────────────────────────
// Answers "is the expensive cache_creation caused by 5-min TTL expiry, or by a genuine cache BREAK
// (the prompt prefix changed)?" — a question the totals in buildCacheCreationReport cannot answer,
// because a TTL-driven re-write and a break-driven re-write cost the SAME cache_creation tokens but
// have completely different fixes (a heartbeat prevents TTL expiry; nothing about a heartbeat stops
// a prefix from actually changing).

export interface CacheCreationTierSplit {
  totalCacheCreateTokens: number
  ephemeral5mTokens: number
  ephemeral1hTokens: number
  ephemeral5mPct: number
  ephemeral1hPct: number
  note: string
}

// Gap-since-previous-call-in-this-session buckets. '(no prev)' = the first scanned event for that
// session (nothing to measure a gap against, within the scanned window). The two TTLs anthropic
// actually enforces are 5 minutes and 1 hour — the buckets straddle both so each big write lands in
// exactly the bucket that names its most likely cause.
export type GapBucketKey = 'first-call(no prev)' | '<4.5m' | '4.5-6m(=5m TTL)' | '6-15m' | '15-65m' | '>65m(1h TTL)'
const GAP_BUCKET_ORDER: GapBucketKey[] = ['first-call(no prev)', '<4.5m', '4.5-6m(=5m TTL)', '6-15m', '15-65m', '>65m(1h TTL)']

export interface GapBucketRow {
  bucket: GapBucketKey
  events: number
  cacheCreateTokens: number
}

export interface CacheBreakGapReport {
  minCacheCreate: number
  windowHours?: number
  tierSplit: CacheCreationTierSplit
  bigEventCount: number
  gapBuckets: GapBucketRow[]
  interpretation: string[]
  coverage: CacheCreationScanCoverage
}

// The reference script's threshold for a "big" (worth TTL/break-classifying) cache_creation write.
const DEFAULT_BIG_CACHE_CREATE = 100_000

function classifyGapMinutes(gapMinutes: number): GapBucketKey {
  if (gapMinutes < 4.5) return '<4.5m'
  if (gapMinutes < 6) return '4.5-6m(=5m TTL)'
  if (gapMinutes < 15) return '6-15m'
  if (gapMinutes < 65) return '15-65m'
  return '>65m(1h TTL)'
}

/** Splits cache_creation into its 5-min / 1-hour TTL tiers, and buckets every BIG (>= minCacheCreate,
 *  default 100k) write by the time gap since the previous call in its session — the "was this a TTL
 *  expiry or a cache break" diagnostic. Events are grouped by sessionId; responses that could not be
 *  attributed to a session (see the module doc's previous_message_id join) fall into one shared
 *  '(unattributed)' pseudo-group, so gaps computed there mix unrelated calls and are indicative only —
 *  mirrors the reference script's methodology (TRDD-CCFORNSC), which reported this bucket as-is. */
export async function buildCacheBreakGapReport(
  opts: CacheCreationScanOptions & { minCacheCreate?: number } = {},
): Promise<CacheBreakGapReport> {
  const minCacheCreate = opts.minCacheCreate ?? DEFAULT_BIG_CACHE_CREATE
  const { events, coverage } = await scanCacheCreationEvents(opts)

  // Tier split — over EVERY scanned cache_creation event, not just the "big" ones (the totals answer
  // "how much of ALL cache_creation is even TTL-bound at all", independent of the break/TTL diagnostic
  // below, which only classifies the big single events).
  let totalCC = 0, t5 = 0, t1 = 0
  for (const e of events) { totalCC += e.cacheCreateTokens; t5 += e.cacheCreation5mTokens; t1 += e.cacheCreation1hTokens }
  const tierSplit: CacheCreationTierSplit = {
    totalCacheCreateTokens: totalCC,
    ephemeral5mTokens: t5,
    ephemeral1hTokens: t1,
    ephemeral5mPct: totalCC > 0 ? +(100 * t5 / totalCC).toFixed(1) : 0,
    ephemeral1hPct: totalCC > 0 ? +(100 * t1 / totalCC).toFixed(1) : 0,
    note: 'If mostly the 1h tier, a <5-min heartbeat is IRRELEVANT to those writes — they were never going to expire on the 5-min clock.',
  }

  // Group by session (an explicit '(unattributed)' pseudo-group for un-joinable responses), sorted
  // chronologically within each group so consecutive-call gaps are measured against the RIGHT prior call.
  const bySession = new Map<string, CacheCreationEvent[]>()
  for (const e of events) {
    const key = e.sessionId ?? '(unattributed)'
    const list = bySession.get(key)
    if (list) { list.push(e) } else { bySession.set(key, [e]) }
  }

  const buckets = new Map<GapBucketKey, GapBucketRow>(GAP_BUCKET_ORDER.map(k => [k, { bucket: k, events: 0, cacheCreateTokens: 0 }]))
  let bigEventCount = 0
  for (const list of bySession.values()) {
    const sorted = [...list].sort((a, b) => a.ts - b.ts)
    for (let i = 0; i < sorted.length; i++) {
      const e = sorted[i]
      if (e.cacheCreateTokens < minCacheCreate) continue
      bigEventCount += 1
      const key: GapBucketKey = i === 0 ? 'first-call(no prev)' : classifyGapMinutes((e.ts - sorted[i - 1].ts) / 60_000)
      const row = buckets.get(key) as GapBucketRow
      row.events += 1
      row.cacheCreateTokens += e.cacheCreateTokens
    }
  }

  return {
    minCacheCreate, windowHours: opts.windowHours, tierSplit, bigEventCount,
    gapBuckets: GAP_BUCKET_ORDER.map(k => buckets.get(k) as GapBucketRow),
    interpretation: [
      'Mass in "4.5-6m(=5m TTL)" -> 5-min TTL expiry: a <5min heartbeat WOULD convert these writes to cache_read.',
      'Mass in "first-call(no prev)" / ">65m(1h TTL)" / "15-65m" -> cold start/resume/1h-expiry: a 5-min heartbeat does NOT help.',
      'Mass in "<4.5m" -> a genuine CACHE BREAK (the prefix changed faster than any TTL could have expired it) — the fix is upstream (stop the prefix from changing), not a heartbeat.',
    ],
    coverage,
  }
}
