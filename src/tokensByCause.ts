import type {
  TimelineEntry, CauseDimension, CauseRollupRow, CauseDimensionRollup,
  CauseReconciliation, TokensByCauseReport,
} from './summarizers/summarizerTypes'

// ── Tokens-by-CAUSE attribution rollup (TRDD-UBEP5XY7) ────────────────────────
// Pure, runtime-neutral aggregation over the claude_code.api_request timeline entries the R-I
// rich-event ingestion produces (7612ff5): each carries the per-call usage buckets, the EXACT
// cost_usd, and WHO caused the call (querySource / agent / skill / plugin / mcp server+tool).
// This module groups those calls per cause dimension and sums buckets + cost, answering "which
// skill/plugin/subagent costs me the most?" as one ranked table. Figures are exact ground truth
// (per-call usage + cost_usd), never estimates. Pure OTEL data — works for OTEL-only sessions
// with no local .jsonl. MIRRORED verbatim in media/src/tokensByCause.ts — change both (same
// convention as spawnRollup.ts / residentCost.ts / cacheBreak.ts).

// Dimension order is the drill order the TRDD names: who issued (querySource) → which sub-agent →
// which skill → which plugin → which MCP server → which MCP tool. Exported so the MCP tool and the
// webview toggle iterate the same canonical order.
export const CAUSE_DIMENSIONS: CauseDimension[] = [
  'querySource', 'agent', 'skill', 'plugin', 'mcpServer', 'mcpTool',
]

export const CAUSE_DIMENSION_LABEL: Record<CauseDimension, string> = {
  querySource: 'query source',
  agent: 'agent',
  skill: 'skill',
  plugin: 'plugin',
  mcpServer: 'MCP server',
  mcpTool: 'MCP tool',
}

// The cause value one api_request entry carries for a dimension; '' = the entry carries no value
// for that dimension (→ the explicit unattributed bucket). mcpTool keys as "server/tool" so two
// same-named tools on different servers never merge into one row.
function causeKey(e: TimelineEntry, dim: CauseDimension): string {
  switch (dim) {
    case 'querySource': return e.querySource ?? ''
    case 'agent':       return e.agentName ?? ''
    case 'skill':       return e.skillName ?? ''
    case 'plugin':      return e.pluginName ?? ''
    case 'mcpServer':   return e.mcpServerName ?? ''
    case 'mcpTool':     return e.mcpToolName ? `${e.mcpServerName ?? '?'}/${e.mcpToolName}` : ''
  }
}

// The label of the pinned bucket that absorbs calls with NO value for a dimension. FAIL-FAST
// honesty: those tokens are counted and labeled, never silently dropped and never guessed into a
// named cause. For querySource an unattributed call is genuinely unknown; for the other dimensions
// absence MEANS "not caused by any <dim>" (e.g. a call with no skill active), so the label says so.
function unattributedLabel(dim: CauseDimension): string {
  return dim === 'querySource' ? '(unattributed)' : `(no ${CAUSE_DIMENSION_LABEL[dim]})`
}

function newRow(dim: CauseDimension, key: string, unattributed: boolean): CauseRollupRow {
  return {
    dimension: dim, key, unattributed, calls: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0,
    totalTokens: 0, costUsd: 0, costKnown: true,
  }
}

function foldEntry(row: CauseRollupRow, e: TimelineEntry): void {
  row.calls++
  row.inputTokens       += e.inputTokens ?? 0
  row.outputTokens      += e.outputTokens ?? 0
  row.cacheReadTokens   += e.cacheReadTokens ?? 0
  row.cacheCreateTokens += e.cacheCreateTokens ?? 0
  row.totalTokens = row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheCreateTokens
  // A call with no cost_usd (rare — an api_request event that lost the attribute) makes the row's
  // cost a FLOOR, flagged via costKnown:false instead of silently understating a complete figure.
  if (typeof e.costUsd === 'number' && Number.isFinite(e.costUsd)) row.costUsd += e.costUsd
  else row.costKnown = false
}

// Rollup of ONE dimension over the api_request entries. Named rows rank heaviest-first by
// totalTokens; the unattributed bucket (when non-empty) is pinned LAST regardless of size so a
// reader always sees the named causes first but can never miss the unattributed remainder.
function rollupDimension(apiRequests: TimelineEntry[], dim: CauseDimension): CauseDimensionRollup {
  const byKey = new Map<string, CauseRollupRow>()
  let unattributed: CauseRollupRow | null = null
  for (const e of apiRequests) {
    const key = causeKey(e, dim)
    if (key === '') {
      if (!unattributed) unattributed = newRow(dim, unattributedLabel(dim), true)
      foldEntry(unattributed, e)
    } else {
      let row = byKey.get(key)
      if (!row) { row = newRow(dim, key, false); byKey.set(key, row) }
      foldEntry(row, e)
    }
  }
  const named = [...byKey.values()].sort((a, b) => b.totalTokens - a.totalTokens)
  const rows = unattributed ? [...named, unattributed] : named
  const attributedCalls = named.reduce((n, r) => n + r.calls, 0)
  return { dimension: dim, rows, attributedCalls, unattributedCalls: unattributed?.calls ?? 0 }
}

// Round once at the end — summing many 4-decimal per-call costs accumulates float noise.
function round4(n: number): number { return +n.toFixed(4) }

export interface TokensByCauseOptions {
  sessionId?: string
  sessionsScanned?: number
  // Session/window usage ground truth for reconciliation: uncached input + cacheRead + cacheCreate +
  // output (the same normalization sessionCost uses). null = caller has no reliable total (e.g. a
  // multi-session window mixing token conventions) — the remainder is then reported as null, not 0.
  sessionTotalTokens?: number | null
}

export function buildTokensByCause(timeline: TimelineEntry[], opts: TokensByCauseOptions = {}): TokensByCauseReport {
  const apiRequests = timeline.filter(e => e.type === 'api_request')
  const dimensions = CAUSE_DIMENSIONS.map(d => rollupDimension(apiRequests, d))

  // Attribution coverage vs the usage-bucket ground truth. Each api_request is one llm call, so the
  // Σ over api_request events is the attributABLE traffic; the (signed, never clamped) remainder is
  // traffic no rich event covered — e.g. calls made before rich OTEL logging was enabled.
  let inTok = 0, outTok = 0, readTok = 0, createTok = 0, cost = 0, costCalls = 0
  for (const e of apiRequests) {
    inTok     += e.inputTokens ?? 0
    outTok    += e.outputTokens ?? 0
    readTok   += e.cacheReadTokens ?? 0
    createTok += e.cacheCreateTokens ?? 0
    if (typeof e.costUsd === 'number' && Number.isFinite(e.costUsd)) { cost += e.costUsd; costCalls++ }
  }
  const attributedTotal = inTok + outTok + readTok + createTok
  const sessionTotal = opts.sessionTotalTokens ?? null
  const remainder = sessionTotal === null ? null : sessionTotal - attributedTotal
  const costComplete = costCalls === apiRequests.length

  const reconciliation: CauseReconciliation = {
    apiRequestCalls: apiRequests.length,
    attributedInputTokens: inTok,
    attributedOutputTokens: outTok,
    attributedCacheReadTokens: readTok,
    attributedCacheCreateTokens: createTok,
    attributedTotalTokens: attributedTotal,
    attributedCostUsd: round4(cost),
    costComplete,
    costCalls,
    sessionTotalTokens: sessionTotal,
    unattributedTotalTokens: remainder,
    note: remainder === null
      ? 'No usage-bucket ground truth supplied for this scope, so the unattributed remainder cannot be computed (reported null, never fabricated).'
      : remainder === 0
        ? 'The api_request events fully reconcile with the usage-bucket totals.'
        : `Signed remainder: ${remainder.toLocaleString()} tokens of the usage-bucket total were NOT covered by any api_request event ` +
          '(calls recorded before rich OTEL logging, or span/log ingestion drift). Negative = api_request events exceed the session usage totals.',
  }

  // Round the per-row cost sums once, after aggregation.
  for (const d of dimensions) for (const r of d.rows) r.costUsd = round4(r.costUsd)

  return {
    sessionId: opts.sessionId,
    sessionsScanned: opts.sessionsScanned,
    apiRequestCalls: apiRequests.length,
    hasAttribution: apiRequests.length > 0,
    dimensions,
    reconciliation,
    estimated: false,
    note: apiRequests.length === 0
      ? 'No claude_code.api_request events in this scope — per-cause attribution needs the rich OTEL log events (CLAUDE_CODE_ENABLE_TELEMETRY=1 with logs exported), or this is not a Claude Code session.'
      : 'Grouped from the per-call api_request ground truth (exact usage buckets + cost_usd per call). Calls carrying no value for a dimension are in that dimension\'s pinned unattributed bucket — counted, never dropped.',
  }
}
