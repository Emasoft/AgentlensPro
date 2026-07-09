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
import { calcTokenCostUsd } from './pricing'

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

// ── get_cache_creation_report ───────────────────────────────────────────────────
export type CacheCreationGroupBy = 'session' | 'account' | 'model' | 'time'

export interface CacheCreationGroupRow {
  key: string
  cacheCreateTokens: number
  cacheReadTokens: number
  events: number
  costUsd: number
  maxSingleCacheCreateTokens: number
}

export interface CacheCreationReport {
  groupBy: CacheCreationGroupBy
  windowHours?: number
  totalCacheCreateTokens: number
  totalCacheReadTokens: number
  totalCostUsd: number
  unattributed: { events: number; cacheCreateTokens: number; costUsd: number; note: string }
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

/** Ranks WHO is burning the expensive cache_creation write bucket — aggregated by session, account,
 *  model, or hourly time-window. Always reports an explicit unattributed bucket (last-turn / in-flight
 *  responses that could not be joined to a session) rather than folding it silently into the totals. */
export async function buildCacheCreationReport(
  opts: CacheCreationScanOptions & { groupBy?: CacheCreationGroupBy; topN?: number } = {},
): Promise<CacheCreationReport> {
  const groupBy = opts.groupBy ?? 'session'
  const topN = Math.min(opts.topN ?? 15, 50)
  const { events, coverage } = await scanCacheCreationEvents(opts)

  const groups = new Map<string, CacheCreationGroupRow>()
  let totalCC = 0, totalCR = 0, totalCost = 0
  let unattrEvents = 0, unattrCC = 0, unattrCost = 0
  for (const e of events) {
    totalCC += e.cacheCreateTokens; totalCR += e.cacheReadTokens; totalCost += e.costUsd
    if (!e.attributed) { unattrEvents += 1; unattrCC += e.cacheCreateTokens; unattrCost += e.costUsd }
    const key = groupKeyOf(e, groupBy)
    const g = groups.get(key) ?? { key, cacheCreateTokens: 0, cacheReadTokens: 0, events: 0, costUsd: 0, maxSingleCacheCreateTokens: 0 }
    g.cacheCreateTokens += e.cacheCreateTokens
    g.cacheReadTokens += e.cacheReadTokens
    g.events += 1
    g.costUsd += e.costUsd
    g.maxSingleCacheCreateTokens = Math.max(g.maxSingleCacheCreateTokens, e.cacheCreateTokens)
    groups.set(key, g)
  }
  const ranked = [...groups.values()]
    .map(g => ({ ...g, costUsd: +g.costUsd.toFixed(4) }))
    .sort((a, b) => b.cacheCreateTokens - a.cacheCreateTokens)

  return {
    groupBy, windowHours: opts.windowHours,
    totalCacheCreateTokens: totalCC, totalCacheReadTokens: totalCR, totalCostUsd: +totalCost.toFixed(4),
    unattributed: {
      events: unattrEvents, cacheCreateTokens: unattrCC, costUsd: +unattrCost.toFixed(4),
      note: 'Responses with no following request in the scanned window (last-turn / still-in-flight calls) — cannot be joined to a session.',
    },
    groups: ranked.slice(0, topN),
    coverage,
  }
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

export interface ExpensiveWriteEvent {
  cacheCreateTokens: number
  costUsd: number
  ts: string             // ISO
  model?: string
  sessionId?: string
  accountUuid?: string
  attributed: boolean
  requestRef?: string    // pointer to the raw request body file — never its content
  responseRef: string    // pointer to the raw response body file — never its content
  composition: ExpensiveWriteComposition | null   // null when no request body could be resolved/parsed
}

export interface ExpensiveWritesTrace {
  minCacheCreate: number
  windowHours?: number
  events: ExpensiveWriteEvent[]
  coverage: CacheCreationScanCoverage
}

const TOOL_CATALOG_COUNT_RE = /\((\d+) tools\)/

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

/** For the biggest single cache_creation write events, resolves session/account via the
 *  previous_message_id chain and summarizes the CONTENT that made the write so expensive (image /
 *  tool_result / text / system token shares + tool-catalog size) — pointer-only, never raw text or
 *  base64. Answers "what is IN the huge writes", complementing buildCacheCreationReport's "who". */
export async function buildExpensiveWritesTrace(
  opts: CacheCreationScanOptions & { minCacheCreate?: number; topN?: number } = {},
): Promise<ExpensiveWritesTrace> {
  const minCacheCreate = Math.max(0, opts.minCacheCreate ?? 0)
  const topN = Math.min(opts.topN ?? 6, 25)
  const { events, coverage } = await scanCacheCreationEvents(opts)
  const top = events
    .filter(e => e.cacheCreateTokens >= minCacheCreate)
    .sort((a, b) => b.cacheCreateTokens - a.cacheCreateTokens)
    .slice(0, topN)

  const out: ExpensiveWriteEvent[] = []
  for (const e of top) {
    let composition: ExpensiveWriteComposition | null = null
    if (e.requestRef) {
      const cc = await buildCallComposition(e.requestRef, 1, e.ts, {
        exact: {
          inputTokens: e.inputTokens, outputTokens: e.outputTokens,
          cacheReadTokens: e.cacheReadTokens, cacheCreateTokens: e.cacheCreateTokens,
          responseId: e.responseId,
        },
      })
      if (cc) composition = compositionSummaryFrom(cc)
    }
    out.push({
      cacheCreateTokens: e.cacheCreateTokens,
      costUsd: +e.costUsd.toFixed(4),
      ts: new Date(e.ts).toISOString(),
      model: e.model,
      sessionId: e.sessionId,
      accountUuid: e.accountUuid,
      attributed: e.attributed,
      requestRef: e.requestRef,
      responseRef: e.responseRef,
      composition,
    })
  }
  return { minCacheCreate, windowHours: opts.windowHours, events: out, coverage }
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
