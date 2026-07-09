// TRDD-FB5RG4P1 — compare_configs engine (design §4). Groups every API-call fact by a config
// dimension and ranks the groups worst→best on a chosen metric, with per-group min/max/avg/median/
// p95/count/sum ALWAYS returned (task requirement) + a share of the total + a billable-weighted USD
// number. median/p95 are computed in TS (sql.js has no PERCENTILE) over the bounded fact rows —
// correctness over cleverness (design §4.3). The unresolved-spawn mass is NEVER hidden: it surfaces
// as its own group and in the coverage block (same honesty contract as CCFORNSC's unattributed bucket).

import {
  openReadonlyForensicsSnapshot, DEFAULT_FORENSICS_DB, type SqlDatabase, type SqlStatement,
} from './forensicsDb'

export type GroupByDim =
  | 'spawn_kind' | 'model' | 'effort' | 'isolation' | 'subagent_type' | 'frontmatter'
  | 'skill' | 'mcp' | 'rule' | 'content_tag' | 'break_cause' | 'account' | 'session'
export type MetricKey =
  | 'cache_creation' | 'cache_read' | 'output_tokens' | 'input_tokens' | 'breaks' | 'total' | 'billable_weighted'
export type AggKey = 'sum' | 'avg' | 'median' | 'min' | 'max' | 'p95' | 'count'

export interface CompareFilter {
  window?: number
  model?: string
  spawnKind?: string
  subagentType?: string
  effort?: string
  isolation?: string
  accountUuid?: string
  sessionId?: string
  minCacheCreate?: number
  minOutputTokens?: number
  breakCause?: string
  spawnResolution?: string
  hasContentTag?: string[]
  hasSkill?: string[]
  hasMcp?: string[]
  hasRule?: string[]
}
export interface CompareConfigsOptions {
  groupBy?: GroupByDim
  metric?: MetricKey
  agg?: AggKey
  filter?: CompareFilter
  rankOrder?: 'worst-first' | 'best-first'
  topN?: number
  forensicsDbPath?: string
}
export interface CompareGroup {
  key: string
  calls: number
  min: number; max: number; avg: number; median: number; p95: number; sum: number
  sharePct: number
  billableWeightedUsd: number
}
export interface CompareConfigsResult {
  groupBy: GroupByDim
  metric: MetricKey
  agg: AggKey
  rankOrder: 'worst-first' | 'best-first'
  baseline: { calls: number; sum: number; avg: number; median: number; p95: number }
  groups: CompareGroup[]
  verdict: string[]
  coverage: Record<string, unknown>
  dbAvailable: boolean
}

// group dimension → SQL (key expression + optional injection/content JOIN). COALESCE surfaces the
// null buckets under an explicit label rather than dropping them.
const GROUP_JOINS: Partial<Record<GroupByDim, { join: string; keyExpr: string; kindParam?: string }>> = {
  skill:       { join: 'JOIN call_injections ci ON ci.call_id = a.call_id', keyExpr: 'ci.name', kindParam: 'skill' },
  mcp:         { join: 'JOIN call_injections ci ON ci.call_id = a.call_id', keyExpr: 'ci.name', kindParam: 'mcp' },
  rule:        { join: 'JOIN call_injections ci ON ci.call_id = a.call_id', keyExpr: 'ci.name', kindParam: 'rule' },
  content_tag: { join: 'JOIN call_content cc ON cc.call_id = a.call_id',    keyExpr: 'cc.tag' },
}
const GROUP_COLS: Partial<Record<GroupByDim, string>> = {
  spawn_kind:    "COALESCE(a.spawn_kind, 'unresolved')",
  model:         "COALESCE(a.model, '(unknown)')",
  effort:        "COALESCE(a.effort, 'none')",
  isolation:     "COALESCE(a.spawn_isolation, 'none')",
  subagent_type: "COALESCE(a.subagent_type, '(unknown)')",
  frontmatter:   "COALESCE(a.frontmatter_fp, '(none)')",
  break_cause:   "COALESCE(a.break_cause, '(none)')",
  account:       "COALESCE(a.account_uuid, '(unattributed)')",
  session:       "COALESCE(a.session_id, '(unattributed)')",
}
const METRIC_EXPR: Record<MetricKey, string> = {
  cache_creation: 'a.cache_creation_tokens',
  cache_read: 'a.cache_read_tokens',
  output_tokens: 'a.output_tokens',
  input_tokens: 'a.input_tokens',
  total: '(a.input_tokens + a.output_tokens + a.cache_read_tokens + a.cache_creation_tokens)',
  billable_weighted: 'a.billable_weight',
  // avoidable breaks only (degrades to 0 when break_cause is unpopulated — cacheBreakTimeline absent)
  breaks: "CASE WHEN a.break_cause IS NOT NULL AND a.break_cause NOT IN ('COLD_START','TTL_EXPIRY') THEN 1 ELSE 0 END",
}

function queryRows(db: SqlDatabase, sql: string, params: Record<string, unknown>): Array<Record<string, unknown>> {
  const st: SqlStatement = db.prepare(sql)
  const out: Array<Record<string, unknown>> = []
  try { st.bind(params); while (st.step()) { out.push(st.getAsObject()) } } finally { st.free() }
  return out
}

function num(v: unknown): number { return typeof v === 'number' && isFinite(v) ? v : Number(v) || 0 }
function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) { return 0 }
  if (sortedAsc.length === 1) { return sortedAsc[0] }
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(q * sortedAsc.length) - 1))
  return sortedAsc[idx]
}

// Build the WHERE fragments + bound params for a filter (all values bound, never concatenated).
function buildFilter(f: CompareFilter | undefined): { where: string[]; params: Record<string, unknown> } {
  const where: string[] = []
  const params: Record<string, unknown> = {}
  if (!f) { return { where, params } }
  if (f.window && f.window > 0) { where.push('a.ts >= :__win'); params[':__win'] = Date.now() - f.window * 3_600_000 }
  const eq = (col: string, key: string, val: unknown): void => { if (val !== undefined && val !== null && val !== '') { where.push(`${col} = ${key}`); params[key] = val } }
  eq('a.model', ':f_model', f.model)
  eq('a.spawn_kind', ':f_sk', f.spawnKind)
  eq('a.subagent_type', ':f_sat', f.subagentType)
  eq('a.effort', ':f_eff', f.effort)
  eq('a.spawn_isolation', ':f_iso', f.isolation)
  eq('a.account_uuid', ':f_acc', f.accountUuid)
  eq('a.session_id', ':f_sess', f.sessionId)
  eq('a.break_cause', ':f_bc', f.breakCause)
  eq('a.spawn_resolution', ':f_res', f.spawnResolution)
  if (typeof f.minCacheCreate === 'number') { where.push('a.cache_creation_tokens >= :f_mcc'); params[':f_mcc'] = f.minCacheCreate }
  if (typeof f.minOutputTokens === 'number') { where.push('a.output_tokens >= :f_mot'); params[':f_mot'] = f.minOutputTokens }
  addExists(where, params, 'skill', f.hasSkill, 'call_injections', 'name', 'kind')
  addExists(where, params, 'mcp', f.hasMcp, 'call_injections', 'name', 'kind')
  addExists(where, params, 'rule', f.hasRule, 'call_injections', 'name', 'kind')
  addExists(where, params, undefined, f.hasContentTag, 'call_content', 'tag')
  return { where, params }
}
function addExists(where: string[], params: Record<string, unknown>, kind: string | undefined, vals: string[] | undefined, table: string, col: string, kindCol?: string): void {
  if (!vals || vals.length === 0) { return }
  const placeholders = vals.map((v, i) => { const k = `:he_${table}_${kind ?? 'tag'}_${i}`; params[k] = v; return k })
  const kindClause = kind && kindCol ? `x.${kindCol} = :hk_${table}_${kind} AND ` : ''
  if (kind && kindCol) { params[`:hk_${table}_${kind}`] = kind }
  where.push(`EXISTS (SELECT 1 FROM ${table} x WHERE x.call_id = a.call_id AND ${kindClause}x.${col} IN (${placeholders.join(', ')}))`)
}

function aggregate(values: number[]): { min: number; max: number; avg: number; median: number; p95: number; sum: number } {
  const n = values.length
  if (n === 0) { return { min: 0, max: 0, avg: 0, median: 0, p95: 0, sum: 0 } }
  const sorted = [...values].sort((x, y) => x - y)
  const sum = sorted.reduce((s, v) => s + v, 0)
  return { min: sorted[0], max: sorted[n - 1], avg: sum / n, median: quantile(sorted, 0.5), p95: quantile(sorted, 0.95), sum }
}

function pickSort(g: CompareGroup, agg: AggKey): number {
  switch (agg) {
    case 'sum': return g.sum
    case 'avg': return g.avg
    case 'median': return g.median
    case 'min': return g.min
    case 'max': return g.max
    case 'p95': return g.p95
    case 'count': return g.calls
  }
}

function buildVerdicts(groupBy: GroupByDim, metric: MetricKey, groups: CompareGroup[]): string[] {
  if (groupBy !== 'spawn_kind') { return [] }
  const by = new Map(groups.map(g => [g.key, g]))
  const out: string[] = []
  const cmp = (a: string, b: string, phrase: (ratio: number, ga: CompareGroup, gb: CompareGroup) => string): void => {
    const ga = by.get(a); const gb = by.get(b)
    if (ga && gb && gb.avg > 0) { out.push(phrase(ga.avg / gb.avg, ga, gb)) }
  }
  const m = metric.replace(/_/g, ' ')
  cmp('worktree', 'fork', (r, ga, gb) => `worktree averages ${r.toFixed(1)}× the ${m}/call of fork (${Math.round(ga.avg)} vs ${Math.round(gb.avg)}) — worktree spawns are cache-cold and isolated.`)
  cmp('fork', 'fresh', (r, ga, gb) => `fork averages ${Math.round((1 - r) * 100)}% ${r < 1 ? 'less' : 'more'} ${m} than fresh (${Math.round(ga.avg)} vs ${Math.round(gb.avg)}) — forks read the parent cache.`)
  cmp('fresh', 'root', (r, ga, gb) => `fresh subagents average ${r.toFixed(1)}× the ${m}/call of root sessions (${Math.round(ga.avg)} vs ${Math.round(gb.avg)}).`)
  return out
}

function readCoverage(db: SqlDatabase, groups: CompareGroup[]): Record<string, unknown> {
  const kv = new Map<string, string>()
  for (const r of queryRows(db, 'SELECT k, v FROM index_state', {})) { kv.set(String(r.k), String(r.v)) }
  const unresolved = groups.find(g => g.key === 'unresolved')
  return {
    responsesIndexed: Number(kv.get('responses_indexed') ?? '0'),
    responsesTotal: Number(kv.get('responses_total') ?? '0'),
    lastRunMs: Number(kv.get('last_run_ms') ?? '0'),
    note: kv.get('coverage_note') ?? 'No index_state — run the indexer.',
    unresolvedCalls: unresolved?.calls ?? 0,
  }
}

/** Build the compare_configs report. Reads a fresh read-only snapshot of forensics.db — the indexer
 *  (ensureFreshIndex) must have run first (the MCP handler does that). Returns dbAvailable:false with
 *  an explanatory coverage note when the fact DB or sql.js is unavailable. */
export async function buildCompareConfigs(opts: CompareConfigsOptions = {}): Promise<CompareConfigsResult> {
  const groupBy = opts.groupBy ?? 'spawn_kind'
  const metric = opts.metric ?? 'cache_creation'
  const agg = opts.agg ?? 'avg'
  const rankOrder = opts.rankOrder ?? 'worst-first'
  const topN = Math.min(Math.max(1, opts.topN ?? 20), 100)
  const empty: CompareConfigsResult = {
    groupBy, metric, agg, rankOrder,
    baseline: { calls: 0, sum: 0, avg: 0, median: 0, p95: 0 }, groups: [], verdict: [],
    coverage: { note: 'forensics.db unavailable (no OTEL bodies indexed yet, or sql.js unavailable in this runtime).' },
    dbAvailable: false,
  }
  const db = await openReadonlyForensicsSnapshot(opts.forensicsDbPath ?? DEFAULT_FORENSICS_DB)
  if (!db) { return empty }

  try {
    const joinSpec = GROUP_JOINS[groupBy]
    const keyExpr = joinSpec ? joinSpec.keyExpr : (GROUP_COLS[groupBy] ?? "COALESCE(a.spawn_kind, 'unresolved')")
    const metricExpr = METRIC_EXPR[metric]
    const { where, params } = buildFilter(opts.filter)
    if (joinSpec?.kindParam) { where.push('ci.kind = :__gk'); params[':__gk'] = joinSpec.kindParam }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const sql = `SELECT ${keyExpr} AS k, ${metricExpr} AS v, a.billable_weight AS bw
                 FROM api_calls a ${joinSpec ? joinSpec.join : ''} ${whereSql}`
    const rows = queryRows(db, sql, params)

    // Aggregate per group (+ overall baseline) in TS.
    const perGroup = new Map<string, { vals: number[]; bw: number }>()
    const allVals: number[] = []
    for (const r of rows) {
      const k = String(r.k)
      const v = num(r.v)
      const g = perGroup.get(k) ?? { vals: [], bw: 0 }
      g.vals.push(v); g.bw += num(r.bw)
      perGroup.set(k, g)
      allVals.push(v)
    }
    const baselineAgg = aggregate(allVals)
    const baselineSum = baselineAgg.sum

    let groups: CompareGroup[] = [...perGroup.entries()].map(([key, g]) => {
      const a = aggregate(g.vals)
      return {
        key, calls: g.vals.length,
        min: a.min, max: a.max, avg: a.avg, median: a.median, p95: a.p95, sum: a.sum,
        sharePct: baselineSum > 0 ? (a.sum / baselineSum) * 100 : 0,
        billableWeightedUsd: g.bw,
      }
    })
    groups.sort((x, y) => rankOrder === 'best-first' ? pickSort(x, agg) - pickSort(y, agg) : pickSort(y, agg) - pickSort(x, agg))
    const verdict = buildVerdicts(groupBy, metric, groups)
    const coverage = readCoverage(db, groups)
    groups = groups.slice(0, topN)

    return {
      groupBy, metric, agg, rankOrder,
      baseline: { calls: allVals.length, sum: baselineSum, avg: baselineAgg.avg, median: baselineAgg.median, p95: baselineAgg.p95 },
      groups, verdict, coverage, dbAvailable: true,
    }
  } finally { db.close() }
}
