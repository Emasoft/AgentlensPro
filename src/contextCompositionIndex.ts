// TRDD-CTXQUERY — LAZY context-composition query layer over Claude Code's raw OTEL request bodies.
//
// WHY: the burn investigation found ANIME2SVG carried 8 stuck screenshots (≈525k tokens, ~half a 1M
// window) re-read (cache_read) on EVERY turn (the Anthropic API is stateless → the whole append-only
// transcript is re-sent each call), costing ~$425 of re-reads. This module turns that manual dig into
// a fully-queryable dataset: per-call composition records (images, tool_results, text, thinking,
// system, tool catalog) keyed by session/project/turn, resident-block tracking (a block re-read across
// N turns) with cumulative wasted cache-read cost, and a generic block query engine.
//
// LAZY (USER directive): nothing is scanned at startup or in the background. A query resolves only the
// sessions it touches, parses their bodies via buildCallContext, and LRU-caches the result. A broad
// scope reads a BOUNDED, most-recent slice of the live CallBodyRegistry (never a full-disk sweep of the
// 20k+ body files) and reports honest coverage.
//
// POINTER-ONLY: records store token counts + refs (body-file path + block index), NEVER blob bytes.
// Image weight is derived from base64 LENGTH (buildCallContext already stores no base64). Exact per-call
// usage is read from the paired <request_id>.response.json (correlated via the registry's shared spanId)
// and used as the authoritative call total, apportioned across the request's blocks by estimated share;
// when a response file is absent it falls back to the request-side estimate and coverage records it.

import * as fs from 'fs'
import {
  buildCallContext, callBodyRegistry, IMAGE_BLOCK_LABEL_PREFIX,
} from './rawBodyContext'
import { calibrateTokens } from './tokenEstimator'
import { calcTokenCostUsd } from './shared/pricing'
import type { ContextBlock, ContextBlockKind, TokenSource } from './shared/summarizerTypes'

// The composition taxonomy is a SUPERSET of the shared ContextBlockKind: images live in the 'other'
// bucket on the shared ContextBlock (a dedicated shared kind would ripple into the residentCost Record
// + webview mirror) but are surfaced here as their own first-class 'image' category.
export type CompositionBlockKind = ContextBlockKind | 'image'

export interface CompositionBlock {
  index: number               // block position within the call (the get_block_content drill key)
  kind: CompositionBlockKind
  label: string
  tokens: number              // final per-block count: calibrated to the exact call usage when available, else estimated
  tokenSource: TokenSource
  bytes: number
  role: 'input' | 'output'
  toolName?: string
  isImage: boolean
  mediaType?: string
}

// Authoritative per-call usage read from the paired response body (never estimated).
export interface CallExactUsage {
  inputTokens: number         // uncached input (Anthropic reports input_tokens cache-excluded)
  outputTokens: number
  cacheReadTokens: number
  cacheCreateTokens: number
  serviceTier?: string
  responseId?: string
}

export interface CallComposition {
  sessionId: string
  accountUuid?: string
  project: string
  model?: string
  turn: number                // 1-based call index within the session (each request body = one llm call)
  ts: number
  bodyRef: string
  contextTokens: number       // prompt-side total (input + cacheRead + cacheCreate) — EXACT when a response body was found, else Σ estimated blocks
  contextPct: number          // contextTokens / windowSize (0..1+)
  windowSize: number
  tokenSource: TokenSource     // 'exact' when contextTokens came from response usage, else 'estimated'
  blocks: CompositionBlock[]
  images: { count: number; tokens: number }
  toolResultTokens: number
  textTokens: number
  thinkingTokens: number
  systemTokens: number
  toolCatalogTokens: number
  exact?: CallExactUsage
  truncated: boolean
}

// A block signature (kind|label) tracked across a session's calls — the eviction-candidate unit. A block
// riding forward is re-read (cache-read billed) on every turn it is present; cumulativeRead* is the true
// wasted re-read weight/cost = Σ over every occurrence across every call.
export interface ResidentBlob {
  signature: string
  kind: CompositionBlockKind
  label: string
  isImage: boolean
  peakTokens: number          // largest single-occurrence token count
  occurrences: number         // total block occurrences across all calls
  residentTurns: number       // distinct calls the signature appears in
  firstSeenTurn: number
  lastSeenTurn: number
  cumulativeReadTokens: number   // Σ tokens over every occurrence (the re-read weight)
  cumulativeReadCostUsd: number  // cache-read cost of those re-reads (real per-model cache-read rate)
}

export interface SessionImageSummary {
  count: number               // max image blocks in any single call (e.g. 8)
  tokens: number              // per-call image token weight (max across calls, ≈525k)
  firstSeenTurn: number
  residentTurns: number       // calls carrying images
  cumulativeReadTokens: number   // Σ image tokens across every call (the re-read total)
  cumulativeReadCostUsd: number
}

export interface SessionComposition {
  sessionId: string
  accountUuid?: string
  project: string
  model?: string
  calls: CallComposition[]
  residentBlobs: ResidentBlob[]
  images: SessionImageSummary
  callsTotal: number
  callsWithExactUsage: number   // how many calls had a response body for exact usage (coverage honesty)
}

// A compact, transport-friendly per-session composition summary for the dashboard panel (piece 1 of the
// composition surface). It carries only rollups + the top eviction-candidate blobs — never the per-call
// block arrays or any bytes — so the payload stays small even for a many-thousand-turn session.
export interface ResidentBlobRow extends ResidentBlob {
  sampleTurn: number          // one occurrence's turn (get_block_content drill key), 0 when none found
  sampleBlockIndex: number    // that occurrence's block index; -1 when none found
}

export interface PeakCallBreakdown {
  turn: number
  contextTokens: number
  contextPct: number          // percent (0..100+), already ×100 from the fraction
  windowSize: number
  tokenSource: TokenSource
  imageTokens: number
  imageCount: number
  toolResultTokens: number
  textTokens: number
  thinkingTokens: number
  systemTokens: number
  toolCatalogTokens: number
  otherTokens: number         // contextTokens minus the six classified sums (tool_use, attachments, …), ≥0
}

export interface SessionCompositionSummary {
  sessionId: string
  accountUuid?: string
  project: string
  model?: string
  callsTotal: number
  callsWithExactUsage: number
  peakCall: PeakCallBreakdown | null   // the worst-case call, the breakdown-bar's representative
  images: SessionImageSummary
  residentBlobs: ResidentBlobRow[]     // top eviction candidates, ranked by wasted re-read cost
  coverageNote?: string
}

// A pointer to one request body + the correlation keys needed to find its response usage. The registry
// path fills these from CallBodyPointer; the test path passes explicit file paths.
export interface RequestRef {
  bodyRef: string
  ts: number
  spanId?: string
  requestId?: string
  responseRef?: string        // absolute path to the paired <request_id>.response.json, when known
  model?: string
}

// ── Window-size inference ─────────────────────────────────────────────────────
// The request body carries no context-window size (max_tokens is the OUTPUT cap). Infer from the model:
// 1M for the long-context families (fable / an explicit [1m] tag), else the 200k default. Approximate —
// contextPct is labeled as derived from this inference.
function windowSizeFor(model?: string): number {
  if (model && /fable|\[1m\]|-1m\b/i.test(model)) { return 1_000_000 }
  return 200_000
}

// ── Response-usage reader (bounded, cheap — response bodies are small) ─────────
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

interface RawUsage {
  input_tokens?: unknown
  output_tokens?: unknown
  cache_read_input_tokens?: unknown
  cache_creation_input_tokens?: unknown
  service_tier?: unknown
}

function numOr0(v: unknown): number {
  return typeof v === 'number' && isFinite(v) ? v : 0
}

/** Read the EXACT usage from a paired response body. Returns null (fall back to estimate) when the file
 *  is missing/oversized/unparseable or carries no usage — never throws. */
export async function readResponseUsage(responseRef?: string): Promise<CallExactUsage | null> {
  if (!responseRef) { return null }
  let raw: string
  try {
    const st = await fs.promises.stat(responseRef)
    if (!st.isFile() || st.size > MAX_RESPONSE_BYTES) { return null }
    raw = await fs.promises.readFile(responseRef, 'utf8')
  } catch {
    return null
  }
  let parsed: { usage?: RawUsage; id?: unknown } | null
  try { parsed = JSON.parse(raw) as { usage?: RawUsage; id?: unknown } } catch { return null }
  const u = parsed?.usage
  if (!u || typeof u !== 'object') { return null }
  return {
    inputTokens: numOr0(u.input_tokens),
    outputTokens: numOr0(u.output_tokens),
    cacheReadTokens: numOr0(u.cache_read_input_tokens),
    cacheCreateTokens: numOr0(u.cache_creation_input_tokens),
    serviceTier: typeof u.service_tier === 'string' ? u.service_tier : undefined,
    responseId: typeof parsed.id === 'string' ? parsed.id : undefined,
  }
}

// ── Block classification (image re-detection without a re-parse) ──────────────
// buildCallContext emits image blocks as kind 'other' with label "image <media_type>" (the stable
// IMAGE_BLOCK_LABEL_PREFIX contract). Re-classify those to the 'image' category here.
function classify(b: ContextBlock): { kind: CompositionBlockKind; isImage: boolean; mediaType?: string } {
  if (b.kind === 'other' && b.label.startsWith(`${IMAGE_BLOCK_LABEL_PREFIX} `)) {
    const media = b.label.slice(IMAGE_BLOCK_LABEL_PREFIX.length + 1)
    return { kind: 'image', isImage: true, mediaType: media || undefined }
  }
  return { kind: b.kind, isImage: false }
}

const TOOL_RESULT_KINDS = new Set<CompositionBlockKind>(['toolOutput', 'bashOutput'])
const SYSTEM_KINDS = new Set<CompositionBlockKind>(['system', 'claudemd', 'rule'])
const TEXT_KINDS = new Set<CompositionBlockKind>(['userMsg', 'assistantMsg'])

// ── One call → a CallComposition ──────────────────────────────────────────────
/** Build one call's composition record from its request-body file (reuses buildCallContext — no
 *  re-parse of the body). When exact usage is supplied, the block estimates are calibrated to the exact
 *  prompt-side total and the call total is authoritative. Returns null when the body is unreadable. */
export async function buildCallComposition(
  bodyRef: string,
  turn: number,
  ts: number,
  opts: { projectHint?: string; exact?: CallExactUsage | null; modelHint?: string } = {},
): Promise<CallComposition | null> {
  const ctx = await buildCallContext(bodyRef)
  if (!ctx) { return null }
  const model = ctx.model ?? opts.modelHint
  const exact = opts.exact ?? null
  // Prompt-side (context) total = uncached input + cacheRead + cacheCreate (output is the response, not
  // context). Apportion this exact total across the visible blocks by their estimated share.
  const exactContext = exact ? exact.inputTokens + exact.cacheReadTokens + exact.cacheCreateTokens : undefined
  const rawTokens = ctx.blocks.map(b => b.tokens)
  const cal = calibrateTokens(rawTokens, exactContext, { minScale: 0.2, maxScale: 5 })

  const blocks: CompositionBlock[] = ctx.blocks.map((b, i) => {
    const c = classify(b)
    return {
      index: i,
      kind: c.kind,
      label: b.label,
      tokens: cal.tokens[i],
      tokenSource: cal.source,
      bytes: b.bytes,
      role: b.role,
      toolName: b.toolName,
      isImage: c.isImage,
      mediaType: c.mediaType,
    }
  })

  const imageBlocks = blocks.filter(b => b.isImage)
  const sumOf = (pred: (b: CompositionBlock) => boolean): number => blocks.filter(pred).reduce((n, b) => n + b.tokens, 0)
  const estTotal = blocks.reduce((n, b) => n + b.tokens, 0)
  const contextTokens = exactContext ?? estTotal
  const windowSize = windowSizeFor(model)

  return {
    sessionId: ctx.sessionId,
    accountUuid: ctx.accountUuid,
    project: opts.projectHint ?? 'unknown',
    model,
    turn,
    ts,
    bodyRef,
    contextTokens,
    contextPct: windowSize > 0 ? contextTokens / windowSize : 0,
    windowSize,
    tokenSource: exactContext !== undefined ? 'exact' : 'estimated',
    blocks,
    images: { count: imageBlocks.length, tokens: imageBlocks.reduce((n, b) => n + b.tokens, 0) },
    toolResultTokens: sumOf(b => TOOL_RESULT_KINDS.has(b.kind) || (b.kind === 'mcp' && b.role === 'output')),
    textTokens: sumOf(b => TEXT_KINDS.has(b.kind)),
    thinkingTokens: sumOf(b => b.kind === 'reasoning'),
    systemTokens: sumOf(b => SYSTEM_KINDS.has(b.kind)),
    toolCatalogTokens: sumOf(b => b.kind === 'toolCatalog'),
    exact: exact ?? undefined,
    truncated: ctx.truncated,
  }
}

// ── Resident-block + image aggregation across a session's calls ───────────────
function costOfCacheRead(tokens: number, model?: string): number {
  if (tokens <= 0) { return 0 }
  return calcTokenCostUsd(0, tokens, 0, 0, model ?? '')
}

function aggregateResidents(calls: CallComposition[], model?: string): ResidentBlob[] {
  interface Acc { kind: CompositionBlockKind; label: string; isImage: boolean; peak: number; occ: number; turns: Set<number>; first: number; last: number; cum: number }
  const bySig = new Map<string, Acc>()
  for (const call of calls) {
    for (const b of call.blocks) {
      const sig = `${b.kind}|${b.label}`
      const a = bySig.get(sig) ?? { kind: b.kind, label: b.label, isImage: b.isImage, peak: 0, occ: 0, turns: new Set<number>(), first: call.turn, last: call.turn, cum: 0 }
      a.peak = Math.max(a.peak, b.tokens)
      a.occ += 1
      a.turns.add(call.turn)
      a.first = Math.min(a.first, call.turn)
      a.last = Math.max(a.last, call.turn)
      a.cum += b.tokens
      bySig.set(sig, a)
    }
  }
  return [...bySig.entries()].map(([signature, a]) => ({
    signature,
    kind: a.kind,
    label: a.label,
    isImage: a.isImage,
    peakTokens: a.peak,
    occurrences: a.occ,
    residentTurns: a.turns.size,
    firstSeenTurn: a.first,
    lastSeenTurn: a.last,
    cumulativeReadTokens: a.cum,
    cumulativeReadCostUsd: costOfCacheRead(a.cum, model),
  })).sort((x, y) => (y.cumulativeReadCostUsd - x.cumulativeReadCostUsd) || (y.cumulativeReadTokens - x.cumulativeReadTokens))
}

function summarizeImages(calls: CallComposition[], model?: string): SessionImageSummary {
  let count = 0, tokens = 0, residentTurns = 0, cumulative = 0, firstSeenTurn = 0
  for (const call of calls) {
    if (call.images.count === 0) { continue }
    residentTurns += 1
    cumulative += call.images.tokens
    if (firstSeenTurn === 0) { firstSeenTurn = call.turn }
    count = Math.max(count, call.images.count)
    tokens = Math.max(tokens, call.images.tokens)
  }
  return { count, tokens, firstSeenTurn, residentTurns, cumulativeReadTokens: cumulative, cumulativeReadCostUsd: costOfCacheRead(cumulative, model) }
}

/** Build a whole session's composition from an ordered list of request refs (oldest→newest). The class
 *  method resolves these from the registry; a test passes explicit file paths. Reads each call's exact
 *  usage from its paired response body when a responseRef is present. */
export async function buildSessionComposition(
  sessionId: string,
  refs: RequestRef[],
  opts: { projectHint?: string } = {},
): Promise<SessionComposition> {
  const calls: CallComposition[] = []
  let callsWithExactUsage = 0
  let model: string | undefined
  let accountUuid: string | undefined
  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i]
    const exact = await readResponseUsage(ref.responseRef)
    if (exact) { callsWithExactUsage += 1 }
    const cc = await buildCallComposition(ref.bodyRef, i + 1, ref.ts, { projectHint: opts.projectHint, exact, modelHint: ref.model })
    if (!cc) { continue }
    calls.push(cc)
    model = model ?? cc.model
    accountUuid = accountUuid ?? cc.accountUuid
  }
  return {
    sessionId,
    accountUuid,
    project: opts.projectHint ?? 'unknown',
    model,
    calls,
    residentBlobs: aggregateResidents(calls, model),
    images: summarizeImages(calls, model),
    callsTotal: refs.length,
    callsWithExactUsage,
  }
}

/** Read one block's real content on demand (the get_block_content drill). An image returns
 *  metadata + a ref (bodyRef + index), NEVER the base64 bytes. `full` lifts the per-block text cap. */
export async function readBlockContent(
  bodyRef: string,
  blockIndex: number,
  opts: { full?: boolean } = {},
): Promise<{ index: number; kind: CompositionBlockKind; label: string; tokens: number; bytes: number; role: string; isImage: boolean; mediaType?: string; bodyRef: string; text?: string } | null> {
  const ctx = await buildCallContext(bodyRef, { uncap: opts.full })
  if (!ctx) { return null }
  const b = ctx.blocks[blockIndex]
  if (!b) { return null }
  const c = classify(b)
  const base = { index: blockIndex, kind: c.kind, label: b.label, tokens: b.tokens, bytes: b.bytes, role: b.role, isImage: c.isImage, mediaType: c.mediaType, bodyRef }
  // Images: metadata + ref only (the base64 was never stored; keep it pointer-only in the response too).
  return c.isImage ? base : { ...base, text: b.text }
}

// ── Query types ───────────────────────────────────────────────────────────────
export interface BlockFilter {
  project?: string            // project path prefix
  sessionId?: string
  kind?: CompositionBlockKind
  model?: string              // substring match
  minTokens?: number
  turnFrom?: number
  turnTo?: number
}

export type GroupBy = 'kind' | 'session' | 'project' | 'model' | 'turn'

export interface ScopeCoverage {
  sessionsMatched: number
  sessionsScanned: number
  scanCap: number
  complete: boolean
  note: string
}

// ── The lazy, LRU-cached index ────────────────────────────────────────────────
export type ProjectResolver = (sessionId: string) => string | undefined

const DEFAULT_SCOPE_CAP = 25

export class ContextCompositionIndex {
  private cache = new Map<string, SessionComposition>()

  constructor(
    private readonly maxSessions = 64,
    private readonly scopeCap = DEFAULT_SCOPE_CAP,
  ) {}

  /** Build (or return cached) a session's composition. Resolves the session's request bodies + their
   *  paired responses from the shared CallBodyRegistry — the LAZY path the running collector populates
   *  as sessions emit bodies. Returns an empty composition when the registry holds no bodies for it. */
  async getSession(sessionId: string, projectFor?: ProjectResolver): Promise<SessionComposition> {
    const cached = this.cache.get(sessionId)
    if (cached) {
      // Re-insert to move to the MRU end.
      this.cache.delete(sessionId)
      this.cache.set(sessionId, cached)
      return cached
    }
    const pointers = callBodyRegistry.requestPointers(sessionId)
    const refs: RequestRef[] = pointers
      .filter(p => Boolean(p.bodyRef))
      .map(p => {
        const resp = callBodyRegistry.responseFor(sessionId, { spanId: p.spanId, requestId: p.requestId })
        return { bodyRef: p.bodyRef as string, ts: p.ts, spanId: p.spanId, requestId: p.requestId, responseRef: resp?.bodyRef, model: p.model }
      })
    const projectHint = projectFor?.(sessionId)
    const comp = await buildSessionComposition(sessionId, refs, { projectHint })
    this.put(sessionId, comp)
    return comp
  }

  private put(sessionId: string, comp: SessionComposition): void {
    this.cache.delete(sessionId)
    this.cache.set(sessionId, comp)
    while (this.cache.size > this.maxSessions) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) { break }
      this.cache.delete(oldest)
    }
  }

  /** Resolve a scope to a bounded, most-recent set of session ids (LAZY: only the live-registry
   *  sessions, capped) + a coverage note. A specific sessionId scope resolves to just that session. */
  private resolveScope(scope: string | undefined, projectFor?: ProjectResolver): { ids: string[]; coverage: ScopeCoverage } {
    const all = callBodyRegistry.sessionIds()
    // A scope that exactly names a known session is a single-session scope.
    if (scope && all.includes(scope)) {
      return { ids: [scope], coverage: { sessionsMatched: 1, sessionsScanned: 1, scanCap: this.scopeCap, complete: true, note: `Single session ${scope}.` } }
    }
    const matched = scope
      ? all.filter(id => (projectFor?.(id) ?? '').startsWith(scope) || id.startsWith(scope))
      : all
    const scanned = matched.slice(0, this.scopeCap)
    const complete = scanned.length === matched.length
    return {
      ids: scanned,
      coverage: {
        sessionsMatched: matched.length,
        sessionsScanned: scanned.length,
        scanCap: this.scopeCap,
        complete,
        note: complete
          ? `Scanned all ${matched.length} live-registry session(s) in scope${scope ? ` "${scope}"` : ''}. Historical sessions not in the live registry are not scanned (lazy).`
          : `SAMPLE: ${scanned.length} most-recent of ${matched.length} in-scope sessions scanned (cap ${this.scopeCap}). Lazy — no full-disk sweep; not full history.`,
      },
    }
  }

  private async sessionsInScope(scope: string | undefined, projectFor?: ProjectResolver): Promise<{ comps: SessionComposition[]; coverage: ScopeCoverage }> {
    const { ids, coverage } = this.resolveScope(scope, projectFor)
    const comps: SessionComposition[] = []
    for (const id of ids) { comps.push(await this.getSession(id, projectFor)) }
    return { comps, coverage }
  }

  /** Per-session image report: count, per-call token weight, first turn, resident turns, cumulative
   *  cache-read cost. Answers "how many images were sent, when, and what did re-reading them cost". */
  async imageReport(scope: string | undefined, projectFor?: ProjectResolver) {
    const { comps, coverage } = await this.sessionsInScope(scope, projectFor)
    const sessions = comps
      .filter(c => c.images.count > 0)
      .map(c => ({
        sessionId: c.sessionId, project: c.project, model: c.model, accountUuid: c.accountUuid,
        images: c.images.count, perCallTokens: c.images.tokens, firstSeenTurn: c.images.firstSeenTurn,
        residentTurns: c.images.residentTurns, cumulativeReadTokens: c.images.cumulativeReadTokens,
        cumulativeReadCostUsd: +c.images.cumulativeReadCostUsd.toFixed(4),
        callsWithExactUsage: c.callsWithExactUsage, callsTotal: c.callsTotal,
      }))
      .sort((a, b) => b.cumulativeReadCostUsd - a.cumulativeReadCostUsd || b.cumulativeReadTokens - a.cumulativeReadTokens)
    return {
      scope: scope ?? 'all',
      totalImageSessions: sessions.length,
      totalCumulativeReadTokens: sessions.reduce((n, s) => n + s.cumulativeReadTokens, 0),
      totalCumulativeReadCostUsd: +sessions.reduce((n, s) => n + s.cumulativeReadCostUsd, 0).toFixed(4),
      coverage,
      sessions,
    }
  }

  /** Eviction-candidate finder: blocks resident across > N turns, ranked by wasted cumulative re-read
   *  cost. The "what should I compact / move to a sub-agent" list. */
  async findResidentBlobs(
    scope: string | undefined,
    filters: { kind?: CompositionBlockKind; minTokens?: number; minResidentTurns?: number; topN?: number },
    projectFor?: ProjectResolver,
  ) {
    const { comps, coverage } = await this.sessionsInScope(scope, projectFor)
    const minResident = filters.minResidentTurns ?? 2
    const minTokens = filters.minTokens ?? 0
    const rows = comps.flatMap(c => c.residentBlobs
      .filter(b => b.residentTurns >= minResident && b.peakTokens >= minTokens && (!filters.kind || b.kind === filters.kind))
      .map(b => ({ sessionId: c.sessionId, project: c.project, model: c.model, ...b, cumulativeReadCostUsd: +b.cumulativeReadCostUsd.toFixed(4) })))
      .sort((a, b) => b.cumulativeReadCostUsd - a.cumulativeReadCostUsd || b.cumulativeReadTokens - a.cumulativeReadTokens)
    // Token-lean default: 20 rows, not the old hardcoded 50 — raise topN explicitly for a bigger pull.
    const topN = Math.min(Math.max(1, filters.topN ?? 20), 100)
    const blobs = rows.slice(0, topN)
    return {
      scope: scope ?? 'all', count: rows.length, coverage, blobs,
      note: rows.length > blobs.length ? `Showing top ${blobs.length} of ${rows.length} by wasted cache-read cost; raise topN to see more (max 100).` : undefined,
    }
  }

  /** The generic engine: filter every call's blocks by any dimension, group by any dimension, and
   *  aggregate tokens/count/est-cost. "All possible queries" in one tool. */
  async queryBlocks(filter: BlockFilter & { topN?: number }, groupBy: GroupBy, projectFor?: ProjectResolver) {
    const scope = filter.sessionId ?? filter.project
    const { comps, coverage } = await this.sessionsInScope(scope, projectFor)
    interface Row { key: string; tokens: number; count: number; estCostUsd: number }
    const groups = new Map<string, Row>()
    let matchedBlocks = 0
    for (const c of comps) {
      if (filter.project && !c.project.startsWith(filter.project)) { continue }
      if (filter.sessionId && c.sessionId !== filter.sessionId) { continue }
      if (filter.model && !(c.model ?? '').includes(filter.model)) { continue }
      for (const call of c.calls) {
        if (filter.turnFrom !== undefined && call.turn < filter.turnFrom) { continue }
        if (filter.turnTo !== undefined && call.turn > filter.turnTo) { continue }
        for (const b of call.blocks) {
          if (filter.kind && b.kind !== filter.kind) { continue }
          if (filter.minTokens !== undefined && b.tokens < filter.minTokens) { continue }
          matchedBlocks += 1
          const key = groupBy === 'kind' ? b.kind
            : groupBy === 'session' ? c.sessionId
            : groupBy === 'project' ? c.project
            : groupBy === 'model' ? (c.model ?? 'unknown')
            : String(call.turn)
          const g = groups.get(key) ?? { key, tokens: 0, count: 0, estCostUsd: 0 }
          g.tokens += b.tokens
          g.count += 1
          g.estCostUsd += costOfCacheRead(b.tokens, c.model)
          groups.set(key, g)
        }
      }
    }
    const rows = [...groups.values()].map(g => ({ ...g, estCostUsd: +g.estCostUsd.toFixed(4) })).sort((a, b) => b.tokens - a.tokens)
    // Token-lean default: 20 groups, not the old hardcoded 100 — raise topN explicitly for a bigger pull.
    const topN = Math.min(Math.max(1, filter.topN ?? 20), 100)
    const shown = rows.slice(0, topN)
    return {
      groupBy, filter, matchedBlocks, distinctGroups: rows.length, coverage, groups: shown,
      note: rows.length > shown.length ? `Showing top ${shown.length} of ${rows.length} groups by tokens; raise topN to see more (max 100).` : undefined,
    }
  }

  /** Real content of one block (get_block_content). Images return metadata + ref, never base64. */
  async getBlockContent(sessionId: string, turn: number, blockIndex: number, opts: { full?: boolean } = {}) {
    const pointers = callBodyRegistry.requestPointers(sessionId)
    const p = pointers[turn - 1]
    if (!p || !p.bodyRef) {
      return { sessionId, turn, message: `No raw body for call/turn ${turn} of session ${sessionId} in the live registry (lazy — historical bodies are not indexed).` }
    }
    const block = await readBlockContent(p.bodyRef, blockIndex, opts)
    if (!block) { return { sessionId, turn, blockIndex, message: `No block ${blockIndex} at turn ${turn}.` } }
    return { sessionId, turn, ...block }
  }

  /** A compact per-session composition summary for the dashboard composition panel (piece 1 of the
   *  surface). Reuses the LRU-cached getSession, then rolls the whole session down to: the peak-context
   *  call's block-type split (the breakdown bar's representative — the worst case that tells the "half
   *  the window is images" story), the image rollup, and the top resident (eviction-candidate) blobs —
   *  each with a sample (turn, blockIndex) so a UI row can drill to real content via getBlockContent.
   *  Pointer-only: no per-block arrays and no bytes cross to the browser. */
  async sessionCompositionSummary(sessionId: string, projectFor?: ProjectResolver): Promise<SessionCompositionSummary> {
    const comp = await this.getSession(sessionId, projectFor)

    // Representative call for the breakdown bar = the peak-context call. null when the session has no
    // parsed calls (no raw bodies in the live registry — the honest lazy empty state).
    let peak: CallComposition | null = null
    for (const c of comp.calls) { if (!peak || c.contextTokens > peak.contextTokens) { peak = c } }
    let peakCall: PeakCallBreakdown | null = null
    if (peak) {
      // otherTokens is the remainder the six named categories don't name (tool_use blocks, attachments,
      // cache_control, mcp input …) — clamped ≥0 so a small estimate drift can't make it negative.
      const classified = peak.images.tokens + peak.toolResultTokens + peak.textTokens +
        peak.thinkingTokens + peak.systemTokens + peak.toolCatalogTokens
      peakCall = {
        turn: peak.turn,
        contextTokens: peak.contextTokens,
        contextPct: +(peak.contextPct * 100).toFixed(1),
        windowSize: peak.windowSize,
        tokenSource: peak.tokenSource,
        imageTokens: peak.images.tokens,
        imageCount: peak.images.count,
        toolResultTokens: peak.toolResultTokens,
        textTokens: peak.textTokens,
        thinkingTokens: peak.thinkingTokens,
        systemTokens: peak.systemTokens,
        toolCatalogTokens: peak.toolCatalogTokens,
        otherTokens: Math.max(0, peak.contextTokens - classified),
      }
    }

    // For each top resident blob find one occurrence (turn + block index) so a UI row can drill to it.
    const findSample = (signature: string): { sampleTurn: number; sampleBlockIndex: number } => {
      for (const c of comp.calls) {
        const idx = c.blocks.findIndex(b => `${b.kind}|${b.label}` === signature)
        if (idx >= 0) { return { sampleTurn: c.turn, sampleBlockIndex: idx } }
      }
      return { sampleTurn: 0, sampleBlockIndex: -1 }
    }
    const residentBlobs: ResidentBlobRow[] = comp.residentBlobs.slice(0, 15).map(b => ({ ...b, ...findSample(b.signature) }))

    return {
      sessionId: comp.sessionId,
      accountUuid: comp.accountUuid,
      project: comp.project,
      model: comp.model,
      callsTotal: comp.callsTotal,
      callsWithExactUsage: comp.callsWithExactUsage,
      peakCall,
      images: comp.images,
      residentBlobs,
      coverageNote: comp.callsTotal === 0
        ? 'No raw OTEL request bodies for this session in the live registry (lazy — historical bodies are not indexed). Set OTEL_LOG_RAW_API_BODIES to capture them.'
        : undefined,
    }
  }
}
