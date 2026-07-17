import type {
  ContextSource, ContextComposition, TimelineEntry,
  CacheBreakCause, CacheBreakTurn, CacheBreakOffender, CacheBreakReport, TurnSourceDiff,
} from './summarizerTypes'
import { lookupRates } from './pricing'

// ── Cache-break classifier (P4, TRDD-TKN5VALS) ────────────────────────────────
//
// The prompt cache is a PREFIX cache: turn N reuses turn N-1's cached prefix only up to the FIRST
// byte that differs; from that break point on everything is re-billed as `cache_creation` (full
// write rate) instead of `cache_read` (~10% of the input rate). A single volatile block early in
// the context therefore invalidates ALL cached content after it — the dominant, invisible token
// sink. This module reconstructs each turn's context blocks, diffs them vs the previous turn, finds
// the first divergence, classifies the CAUSE (taxonomy D of the plan), and sizes the wasted
// cache_creation. It is a PURE function (no I/O, no globals) so it is trivially unit-testable.
// Shared by the host (MCP diagnostic tools) and the webview (Cache tab / trace markers / Alerts) —
// this file replaced the hand-synced media/src/cacheBreak.ts mirror, whose copy had silently
// drifted (it was missing the FAST_MODE detection below). Keep it runtime-neutral: no Node
// imports, no DOM APIs.
//
// LIMITATION worth stating plainly: the composition parser emits each turn's injected blocks
// heaviest-first, not in true prompt position. So the diff below is a SET diff (add / remove /
// size-change by stable identity), and turn order is used only to pick a deterministic "first"
// offender to name. This localises the CAUSE reliably; the SIZE is the turn's real
// `cache_creation` from usage attributed to that cause (an estimate, an upper bound for a partial
// break).

// One turn's cache-relevant footprint. `sources` are the injected context blocks (from
// buildContextComposition); the token buckets are the EXACT usage figures for the turn.
export interface CacheTurnInput {
  turn: number
  sources: ContextSource[]
  cacheReadTokens: number
  cacheCreateTokens: number
  inputTokens: number
  model?: string
  hasFastMode?: boolean
  timestampMs?: number   // wall-clock of the turn (for IDLE_TTL_EXPIRY detection); optional
}

export interface AnalyzeCacheBreaksOpts {
  // Rates to price the wasted re-write. cost ≈ wastedTokens × (writeRate − cacheReadRate).
  // When the rates are absent, wastedCostUsd stays 0 (the token figure is still populated).
  writeRateUsdPerMTok?: number
  inputRateUsdPerMTok?: number
  // The model's ACTUAL cache-read rate. Most mainstream Claude/OpenAI models read at 0.1× input, but
  // some do not (e.g. codex-mini at 0.25×), and hardcoding 0.1× overstates the "wasted re-write" for
  // those. When omitted, falls back to 0.1 × inputRate (the previous behavior, correct for 0.1× models).
  cacheReadRateUsdPerMTok?: number
  idleTtlMs?: number     // gap beyond which the cache entry expired; default 5 min
}

const DEFAULT_IDLE_TTL_MS = 5 * 60_000

// Kinds the composition parser emits that live in the STABLE prefix (their turn-to-turn mutation is
// an avoidable break). All of them qualify — the parser never emits the conversation-message layer.
const CATALOG_KINDS = new Set(['toolCatalog', 'agentCatalog'])

const REMEDIATION: Record<CacheBreakCause, string> = {
  TOOLS_CHANGED:          'Never remove tools mid-session; use defer-loading stubs + tool-search so the catalog stays byte-identical.',
  TOOLS_REORDERED:        'Emit tools in a stable sorted order so the catalog bytes do not shuffle turn-to-turn.',
  SYSTEM_PROMPT_TIMESTAMP:'Move the moving clock/time out of the system prompt into a <system-reminder> in the next user message.',
  MODEL_SWITCHED:         'Do not switch models mid-conversation — hand off to a sub-agent instead (caches are model-specific).',
  EFFORT_CHANGED:         'Keep the reasoning-effort level fixed within a conversation; changing it invalidates the prefix.',
  FAST_MODE:              'Toggling fast mode invalidates the cache — decide it once at session start.',
  MCP_SERVER_TOGGLE:      'Keep MCP servers with non-deferred tools connected for the whole session, or make their tools deferred.',
  PLUGIN_TOGGLE:          'Do not toggle plugins that provide non-deferred MCP tools mid-session.',
  TOOL_DENY:              'Avoid denying an entire tool mid-session; scope the deny narrower or set it before the session starts.',
  INJECTED_BLOCK_CHANGED: 'Move this volatile injected block (hook/file/rule/memory) into the message suffix, after the last cache breakpoint.',
  COMPACTION:             'Compaction rebuilds the conversation layer — expected once; avoid compacting more than necessary.',
  UPGRADE:                'A Claude Code upgrade invalidates the cache once — unavoidable, but do not resume large sessions right after upgrading.',
  RESUME_AFTER_UPGRADE:   'Resuming after an upgrade forces a full re-read (the most expensive turn) — avoid resuming huge sessions post-upgrade.',
  IDLE_TTL_EXPIRY:        'A >5-min idle gap let the cache expire; keep turns within the TTL or accept the one-time re-warm.',
  UNKNOWN:                'Cause could not be localised from the block diff; inspect the raw prefix around this turn.',
}

// Stable identity of an injected block across turns.
function sourceKey(s: ContextSource): string { return `${s.kind}::${s.label}` }

// Classify the kind of a divergent block into a break cause.
function causeForKind(kind: string): CacheBreakCause {
  if (CATALOG_KINDS.has(kind)) return 'TOOLS_CHANGED'
  if (kind === 'mcp') return 'MCP_SERVER_TOGGLE'
  return 'INJECTED_BLOCK_CHANGED'
}

/**
 * Full turn-to-turn block set-diff (add / remove / resize / unchanged), with the FIRST divergence
 * flagged — the earliest byte the prefix cache trips on. This is the single source of truth for the
 * diff: `firstDivergentBlock` (the analyzer) and the cache-break popup (#92, TRDD-CB9POPUP) both
 * consume it, so the popup's highlighted offender is always identical to the analyzer's verdict.
 *
 * Ordering & "first divergence" are the SET-diff semantics the classifier has always used (the
 * composition parser emits blocks heaviest-first, not in true prompt position — see the module
 * header): the first added/resized block in `cur` order, else the first block dropped from `prev`.
 * Entries are returned in `cur` order first, then dropped-from-`prev` blocks.
 */
export function diffTurnSources(prev: ContextSource[], cur: ContextSource[]): TurnSourceDiff[] {
  const prevByKey = new Map<string, ContextSource>()
  for (const s of prev) prevByKey.set(sourceKey(s), s)
  const curKeys = new Set(cur.map(sourceKey))

  // Locate the first divergence's key exactly as the classifier did (cur order, then prev-dropped).
  let firstKey: string | null = null
  for (const s of cur) {
    const p = prevByKey.get(sourceKey(s))
    if (!p || p.tokens !== s.tokens) { firstKey = sourceKey(s); break }
  }
  if (firstKey === null) {
    for (const s of prev) if (!curKeys.has(sourceKey(s))) { firstKey = sourceKey(s); break }
  }
  // Flag only the FIRST entry carrying that key (a duplicate kind::label in one turn must not
  // double-flag) — mirrors the classifier returning a single ContextSource.
  let firstMarked = false
  const markFirst = (key: string): boolean => {
    if (!firstMarked && key === firstKey) { firstMarked = true; return true }
    return false
  }

  const out: TurnSourceDiff[] = []
  for (const s of cur) {
    const key = sourceKey(s)
    const p = prevByKey.get(key)
    const status = !p ? 'added' : (p.tokens !== s.tokens ? 'resized' : 'unchanged')
    out.push({
      key, label: s.label, kind: s.kind, status,
      prevTokens: p?.tokens ?? 0, curTokens: s.tokens,
      prevExcerpt: p?.excerpt, curExcerpt: s.excerpt,
      isFirstDivergence: markFirst(key),
    })
  }
  // A block present in prev but dropped in cur is also a divergence (the prefix shortened/shifted).
  for (const s of prev) {
    const key = sourceKey(s)
    if (curKeys.has(key)) continue
    out.push({
      key, label: s.label, kind: s.kind, status: 'removed',
      prevTokens: s.tokens, curTokens: 0,
      prevExcerpt: s.excerpt, curExcerpt: undefined,
      isFirstDivergence: markFirst(key),
    })
  }
  return out
}

// Find the first block that broke the prefix (the earliest divergence). Reuses diffTurnSources so
// the classifier and the popup can never disagree. Returns the cur block (added/resized) or, for a
// dropped block, the prev block — the classifier reads only its `.kind`/`.label`.
function firstDivergentBlock(prev: ContextSource[], cur: ContextSource[]): ContextSource | null {
  const d = diffTurnSources(prev, cur).find(e => e.isFirstDivergence)
  if (!d) return null
  return cur.find(s => sourceKey(s) === d.key) ?? prev.find(s => sourceKey(s) === d.key) ?? null
}

// Price a wasted re-write. Only cache_creation above the cheap cache_read floor is "wasted": the
// break forces write-rate billing where a cache_read would have cost ~10% of the input rate.
function priceWaste(tokens: number, opts: AnalyzeCacheBreaksOpts): number {
  const write = opts.writeRateUsdPerMTok
  if (write === undefined) return 0
  const input = opts.inputRateUsdPerMTok ?? 0
  // Credit back the cache-read the break avoided: the model's real cache-read rate when provided,
  // else the 0.1×-input default (correct for mainstream models, overstates waste for the rest).
  const cacheRead = opts.cacheReadRateUsdPerMTok ?? 0.1 * input
  const perTok = (write - cacheRead) / 1_000_000
  return Math.max(0, tokens * perTok)
}

// Classify ONE transition (prev → cur) into a per-turn break verdict.
function classifyTurn(prev: CacheTurnInput, cur: CacheTurnInput, opts: AnalyzeCacheBreaksOpts): CacheBreakTurn {
  const idleTtl = opts.idleTtlMs ?? DEFAULT_IDLE_TTL_MS
  const idleGapMs = (cur.timestampMs !== undefined && prev.timestampMs !== undefined)
    ? cur.timestampMs - prev.timestampMs : undefined
  const wasted = cur.cacheCreateTokens

  const emit = (cause: CacheBreakCause, label?: string, kind?: string, gap?: number): CacheBreakTurn => ({
    turn: cur.turn, broke: true, cause,
    breakSourceLabel: label, breakSourceKind: kind,
    wastedTokens: wasted, wastedCostUsd: priceWaste(wasted, opts),
    idleGapMs: gap, remediation: REMEDIATION[cause],
  })

  // 1. Model switch — a full, model-specific invalidation, dominates any block diff.
  if (cur.model && prev.model && cur.model !== prev.model) return emit('MODEL_SWITCHED')
  // 2. Fast mode turned on this turn.
  if (cur.hasFastMode && !prev.hasFastMode) return emit('FAST_MODE')
  // 3. A localizable stable-block divergence (the common structural break).
  const diverged = firstDivergentBlock(prev.sources, cur.sources)
  if (diverged) return emit(causeForKind(diverged.kind), diverged.label, diverged.kind)
  // 4. No block diff but a long idle gap with a real re-write → the entry expired (one-time).
  if (idleGapMs !== undefined && idleGapMs > idleTtl && cur.cacheCreateTokens > 0) {
    return emit('IDLE_TTL_EXPIRY', undefined, undefined, idleGapMs)
  }
  // 5. No localizable cause — expected conversation growth, NOT flagged as an avoidable break.
  return {
    turn: cur.turn, broke: false, cause: 'UNKNOWN',
    wastedTokens: 0, wastedCostUsd: 0, idleGapMs,
  }
}

// Rank the avoidable breaks by cumulative wasted cost (tokens as tie-breaker), grouped by the
// offending source + cause — the "which block cost me the most cache re-writes" leaderboard.
function rankOffenders(turns: CacheBreakTurn[]): CacheBreakOffender[] {
  const byKey = new Map<string, CacheBreakOffender>()
  for (const t of turns) {
    if (!t.broke) continue
    const label = t.breakSourceLabel ?? `(${t.cause})`
    const kind = t.breakSourceKind ?? '-'
    const key = `${t.cause}::${kind}::${label}`
    const cur = byKey.get(key) ?? { label, kind, cause: t.cause, occurrences: 0, wastedTokens: 0, wastedCostUsd: 0 }
    cur.occurrences += 1
    cur.wastedTokens += t.wastedTokens
    cur.wastedCostUsd += t.wastedCostUsd
    byKey.set(key, cur)
  }
  return [...byKey.values()].sort((a, b) =>
    (b.wastedCostUsd - a.wastedCostUsd) || (b.wastedTokens - a.wastedTokens))
}

/**
 * Analyze a session's per-turn cache breaks. Pure: same input → same output, no side effects.
 * `turns` must be in chronological order; turn 1 (the first) never "breaks" (nothing precedes it).
 */
export function analyzeCacheBreaks(
  sessionId: string,
  turns: CacheTurnInput[],
  opts: AnalyzeCacheBreaksOpts = {},
): CacheBreakReport {
  const results: CacheBreakTurn[] = []
  let totalRead = 0
  let totalCreate = 0

  for (let i = 0; i < turns.length; i++) {
    const cur = turns[i]
    totalRead += cur.cacheReadTokens
    totalCreate += cur.cacheCreateTokens
    if (i === 0) {
      // The first turn warms the cache from cold — not an avoidable break.
      results.push({ turn: cur.turn, broke: false, cause: 'UNKNOWN', wastedTokens: 0, wastedCostUsd: 0 })
      continue
    }
    results.push(classifyTurn(turns[i - 1], cur, opts))
  }

  const offenders = rankOffenders(results)
  const totalWastedTokens = offenders.reduce((n, o) => n + o.wastedTokens, 0)
  const totalWastedCostUsd = offenders.reduce((n, o) => n + o.wastedCostUsd, 0)
  const denom = totalRead + totalCreate
  const cacheHitRate = denom > 0 ? totalRead / denom : 0

  return { sessionId, turns: results, offenders, totalWastedTokens, totalWastedCostUsd, cacheHitRate }
}

// ── Convenience: assemble the report from a session's timeline + composition ───────────────────
// Folds the timeline into per-turn token buckets, overlays the composition's injected blocks,
// prices the waste from the session model's rates. Returns null when there isn't enough to diff
// (no composition, or a single turn — turn 1 can never break). The MCP diagnostic tools AND the
// webview tabs reuse this so the turn-bucketing logic lives in ONE place, not re-implemented per
// caller.
export function buildCacheBreakReport(
  sessionId: string,
  timeline: TimelineEntry[],
  composition: ContextComposition | null | undefined,
  sessionModel: string,
): CacheBreakReport | null {
  if (!composition) return null
  const sourcesByTurn = new Map<number, ContextSource[]>()
  for (const t of composition.turns) sourcesByTurn.set(t.turn, t.sources)

  interface Acc { cacheRead: number; cacheCreate: number; input: number; model?: string; ts?: number }
  const byTurn = new Map<number, Acc>()
  for (const e of timeline) {
    if (e.type === 'background' || e.turn === undefined) continue
    let a = byTurn.get(e.turn)
    if (!a) { a = { cacheRead: 0, cacheCreate: 0, input: 0 }; byTurn.set(e.turn, a) }
    a.cacheRead += e.cacheReadTokens ?? 0
    a.cacheCreate += e.cacheCreateTokens ?? 0
    a.input += e.inputTokens ?? 0
    if (!a.model && e.type === 'llm' && e.model) a.model = e.model
    if (a.ts === undefined && e.timestamp) { const ms = Date.parse(e.timestamp); if (!Number.isNaN(ms)) a.ts = ms }
  }
  if (byTurn.size < 2) return null

  const rates = lookupRates(sessionModel)
  const opts: AnalyzeCacheBreaksOpts = rates
    ? {
        writeRateUsdPerMTok: rates.cacheWritePerMTok,
        inputRateUsdPerMTok: rates.inputPerMTok,
        // Use the model's ACTUAL cache-read rate, not a hardcoded 0.1× input (wrong for e.g.
        // codex-mini at 0.25×), so the priced "wasted re-write" credits back the real avoided read.
        cacheReadRateUsdPerMTok: rates.cacheReadPerMTok,
      }
    : {}

  const inputs: CacheTurnInput[] = [...byTurn.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([turn, a]) => ({
      turn,
      sources: sourcesByTurn.get(turn) ?? [],
      cacheReadTokens: a.cacheRead,
      cacheCreateTokens: a.cacheCreate,
      inputTokens: a.input,
      model: a.model ?? sessionModel,
      timestampMs: a.ts,
    }))

  return analyzeCacheBreaks(sessionId, inputs, opts)
}

// Per-turn lookup of a report's verdicts — the shape the trace tree renders break markers from.
export function cacheBreaksByTurn(report: CacheBreakReport | null): Map<number, CacheBreakTurn> {
  const m = new Map<number, CacheBreakTurn>()
  if (report) for (const t of report.turns) m.set(t.turn, t)
  return m
}

// Short human label for a break cause, used by the trace marker + the Cache tab.
export const CAUSE_LABEL: Record<CacheBreakCause, string> = {
  TOOLS_CHANGED: 'Tools changed', TOOLS_REORDERED: 'Tools reordered',
  SYSTEM_PROMPT_TIMESTAMP: 'System-prompt timestamp', MODEL_SWITCHED: 'Model switched',
  EFFORT_CHANGED: 'Effort changed', FAST_MODE: 'Fast mode toggled',
  MCP_SERVER_TOGGLE: 'MCP server toggled', PLUGIN_TOGGLE: 'Plugin toggled',
  TOOL_DENY: 'Tool denied', INJECTED_BLOCK_CHANGED: 'Injected block changed',
  COMPACTION: 'Compaction', UPGRADE: 'Upgrade', RESUME_AFTER_UPGRADE: 'Resume after upgrade',
  IDLE_TTL_EXPIRY: 'Idle TTL expiry', UNKNOWN: 'Unknown',
}
