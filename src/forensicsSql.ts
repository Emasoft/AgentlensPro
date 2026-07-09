// TRDD-FB5RG4P1 — run_diagnostics_sql engine (design §6). Two modes over the forensics fact DB:
//   preset — a curated, parameterized read-only query from the frozen library (§6.5, ~16 presets);
//   sql    — RAW read-only SELECT/WITH gated to a single read statement + the custom cost fns.
// SAFETY (design §6.2): raw SQL runs on a fresh IN-MEMORY snapshot (source untouchable), passes a
// statement gate (single SELECT/WITH; INSERT/UPDATE/DELETE/DDL/ATTACH/PRAGMA rejected; no second ';'),
// params are BOUND (never concatenated), and every result is row-capped. Presets skip the gate (they
// are frozen, not user-supplied) but still bind params + apply the cap.

import { openReadonlyForensicsSnapshot, DEFAULT_FORENSICS_DB, type SqlDatabase, type SqlStatement } from './forensicsDb'

export type SqlFormat = 'json' | 'table' | 'markdown'
export interface RunDiagnosticsSqlOptions {
  preset?: string
  sql?: string
  params?: Record<string, unknown>
  format?: SqlFormat
  limit?: number
  forensicsDbPath?: string
}
export interface RunDiagnosticsSqlResult {
  mode: 'preset' | 'sql' | 'list'
  preset?: string
  columns?: string[]
  rows?: Array<Record<string, unknown>>
  rowCount?: number
  rendered?: string
  presets?: Array<{ name: string; description: string }>
  error?: string
  dbAvailable: boolean
  note?: string
}

const HARD_MAX_ROWS = 2000
const DEFAULT_ROWS = 200

// ── Statement gate (design §6.2) ─────────────────────────────────────────────────
const FORBIDDEN = /\b(ATTACH|DETACH|PRAGMA|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|REPLACE|VACUUM|REINDEX|TRIGGER)\b/i

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ')
}
/** Throws a clear message when `sql` is not exactly one read-only SELECT/WITH statement. Fail-closed. */
export function assertReadOnlySelect(rawSql: string): string {
  const cleaned = stripComments(rawSql).trim()
  if (cleaned.length === 0) { throw new Error('Empty SQL.') }
  // Allow at most ONE trailing semicolon; a semicolon anywhere else = a second statement.
  const noTrailing = cleaned.replace(/;\s*$/, '')
  if (noTrailing.includes(';')) { throw new Error('Only a single statement is allowed (a second ";" was found).') }
  if (!/^(SELECT|WITH)\b/i.test(noTrailing)) { throw new Error('Only read-only SELECT or WITH queries are allowed.') }
  if (FORBIDDEN.test(noTrailing)) { throw new Error('DDL/DML/ATTACH/PRAGMA keywords are rejected — this surface is read-only.') }
  return noTrailing
}

// ── Preset library (design §6.5) ─────────────────────────────────────────────────
// Every preset optionally windows on :since (a ts cutoff derived from params.window hours). Lift/spike
// presets take :mult (params.k, default 5) and :minCount (default 3). All params are bound.
const TIME = '(:since IS NULL OR a.ts >= :since)'
export const PRESETS: Record<string, { description: string; sql: string }> = {
  worst_configs_by_cache_creation: {
    description: 'Worst spawn_kind × model on avg cache_creation.',
    sql: `SELECT COALESCE(a.spawn_kind,'unresolved') AS spawn_kind, COALESCE(a.model,'(unknown)') AS model,
      COUNT(*) AS calls, AVG(a.cache_creation_tokens) AS avg_cc, SUM(a.cache_creation_tokens) AS sum_cc,
      SUM(a.billable_weight) AS billable_usd
      FROM api_calls a WHERE ${TIME}
      GROUP BY a.spawn_kind, a.model ORDER BY avg_cc DESC`,
  },
  fork_vs_fresh: {
    description: 'Forked vs fresh subagents, side by side (avg/sum cache_creation + output + billable).',
    sql: `SELECT a.spawn_kind, COUNT(*) AS calls, AVG(a.cache_creation_tokens) AS avg_cc,
      AVG(a.output_tokens) AS avg_out, SUM(a.billable_weight) AS billable_usd
      FROM api_calls a WHERE a.spawn_kind IN ('fork','fresh') AND ${TIME}
      GROUP BY a.spawn_kind ORDER BY avg_cc DESC`,
  },
  worktree_cost_delta: {
    description: 'Worktree vs non-worktree per-call billable cost.',
    sql: `SELECT CASE WHEN a.spawn_kind='worktree' THEN 'worktree' ELSE 'rest' END AS bucket,
      COUNT(*) AS calls, AVG(a.billable_weight) AS avg_billable, AVG(a.cache_creation_tokens) AS avg_cc
      FROM api_calls a WHERE ${TIME} GROUP BY bucket ORDER BY avg_billable DESC`,
  },
  chronic_offenders: {
    description: 'Recurring (break_cause, culprit_fingerprint) pairs (≥ :minCount) by total cache_creation.',
    sql: `SELECT a.break_cause, a.culprit_fingerprint, COUNT(*) AS hits, SUM(a.cache_creation_tokens) AS sum_cc
      FROM api_calls a WHERE a.break_cause IS NOT NULL AND ${TIME}
      GROUP BY a.break_cause, a.culprit_fingerprint HAVING COUNT(*) >= :minCount ORDER BY sum_cc DESC`,
  },
  output_peaks_by_skill: {
    description: 'Skills present on output-token spikes (≥ :mult× the mean output), ranked by spike count.',
    sql: `SELECT ci.name AS skill, COUNT(*) AS spike_calls, AVG(a.output_tokens) AS avg_out
      FROM api_calls a JOIN call_injections ci ON ci.call_id=a.call_id AND ci.kind='skill'
      WHERE a.output_tokens >= :mult * (SELECT AVG(output_tokens) FROM api_calls) AND ${TIME}
      GROUP BY ci.name ORDER BY spike_calls DESC`,
  },
  cache_by_skill: {
    description: 'Per-skill avg cache_creation LIFT vs the global mean (≥ :minCount calls).',
    sql: `SELECT ci.name AS skill, COUNT(*) AS calls, AVG(a.cache_creation_tokens) AS avg_cc,
      AVG(a.cache_creation_tokens) / NULLIF((SELECT AVG(cache_creation_tokens) FROM api_calls),0) AS lift
      FROM api_calls a JOIN call_injections ci ON ci.call_id=a.call_id AND ci.kind='skill'
      WHERE ${TIME} GROUP BY ci.name HAVING COUNT(*) >= :minCount ORDER BY lift DESC`,
  },
  cache_by_mcp: {
    description: 'Per-MCP-server avg cache_creation LIFT vs the global mean (≥ :minCount calls).',
    sql: `SELECT ci.name AS mcp, COUNT(*) AS calls, AVG(a.cache_creation_tokens) AS avg_cc,
      AVG(a.cache_creation_tokens) / NULLIF((SELECT AVG(cache_creation_tokens) FROM api_calls),0) AS lift
      FROM api_calls a JOIN call_injections ci ON ci.call_id=a.call_id AND ci.kind='mcp'
      WHERE ${TIME} GROUP BY ci.name HAVING COUNT(*) >= :minCount ORDER BY lift DESC`,
  },
  cache_by_rule: {
    description: 'Per-rule avg cache_creation LIFT vs the global mean (≥ :minCount calls).',
    sql: `SELECT ci.name AS rule, COUNT(*) AS calls, AVG(a.cache_creation_tokens) AS avg_cc,
      AVG(a.cache_creation_tokens) / NULLIF((SELECT AVG(cache_creation_tokens) FROM api_calls),0) AS lift
      FROM api_calls a JOIN call_injections ci ON ci.call_id=a.call_id AND ci.kind='rule'
      WHERE ${TIME} GROUP BY ci.name HAVING COUNT(*) >= :minCount ORDER BY lift DESC`,
  },
  content_tag_ranking: {
    description: 'cache_creation & output by content tag.',
    sql: `SELECT cc.tag, COUNT(*) AS calls, SUM(a.cache_creation_tokens) AS sum_cc, SUM(a.output_tokens) AS sum_out
      FROM api_calls a JOIN call_content cc ON cc.call_id=a.call_id
      WHERE ${TIME} GROUP BY cc.tag ORDER BY sum_cc DESC`,
  },
  image_burn: {
    description: 'Calls carrying images, ranked by cache_creation.',
    sql: `SELECT a.call_id, a.session_id, a.model, a.cache_creation_tokens, cc.tokens AS image_tokens, a.response_ref
      FROM api_calls a JOIN call_content cc ON cc.call_id=a.call_id AND cc.tag='image'
      WHERE ${TIME} ORDER BY a.cache_creation_tokens DESC`,
  },
  model_effort_matrix: {
    description: 'model × effort avg cache_creation + output.',
    sql: `SELECT COALESCE(a.model,'(unknown)') AS model, a.effort, COUNT(*) AS calls,
      AVG(a.cache_creation_tokens) AS avg_cc, AVG(a.output_tokens) AS avg_out
      FROM api_calls a WHERE ${TIME} GROUP BY a.model, a.effort ORDER BY avg_cc DESC`,
  },
  break_cause_ranking: {
    description: 'break_cause by total cache_creation & count (needs cacheBreakTimeline-populated causes).',
    sql: `SELECT a.break_cause, COUNT(*) AS hits, SUM(a.cache_creation_tokens) AS sum_cc
      FROM api_calls a WHERE a.break_cause IS NOT NULL AND ${TIME}
      GROUP BY a.break_cause ORDER BY sum_cc DESC`,
  },
  root_cause_leaderboard: {
    description: 'culprit_fingerprint by total cache_creation with a representative response_ref to drill.',
    sql: `SELECT a.culprit_fingerprint, a.break_cause, COUNT(*) AS hits, SUM(a.cache_creation_tokens) AS sum_cc,
      MIN(a.response_ref) AS sample_ref
      FROM api_calls a WHERE a.culprit_fingerprint IS NOT NULL AND ${TIME}
      GROUP BY a.culprit_fingerprint ORDER BY sum_cc DESC`,
  },
  unresolved_audit: {
    description: 'Coverage of unresolved spawn attribution (count / tokens / share).',
    sql: `SELECT a.spawn_resolution, COUNT(*) AS calls, SUM(a.cache_creation_tokens) AS sum_cc,
      SUM(a.billable_weight) AS billable_usd
      FROM api_calls a WHERE ${TIME} GROUP BY a.spawn_resolution ORDER BY calls DESC`,
  },
  session_hotlist: {
    description: 'Sessions by total billable_weight + spawn_kind (heaviest first).',
    sql: `SELECT a.session_id, MIN(a.spawn_kind) AS spawn_kind, COUNT(*) AS calls,
      SUM(a.billable_weight) AS billable_usd, SUM(a.cache_creation_tokens) AS sum_cc
      FROM api_calls a WHERE a.session_id IS NOT NULL AND ${TIME}
      GROUP BY a.session_id ORDER BY billable_usd DESC`,
  },
  tier_split_by_config: {
    description: '5m vs 1h cache tier share per spawn_kind (heartbeat relevance).',
    sql: `SELECT COALESCE(a.spawn_kind,'unresolved') AS spawn_kind, COUNT(*) AS calls,
      SUM(a.tier_5m_tokens) AS tier_5m, SUM(a.tier_1h_tokens) AS tier_1h
      FROM api_calls a WHERE ${TIME} GROUP BY a.spawn_kind ORDER BY (tier_5m + tier_1h) DESC`,
  },
}

// ── param binding ────────────────────────────────────────────────────────────────
// Bind ONLY the :names actually referenced by the final SQL, drawn from a pool of {user params +
// derived since/mult/minCount + the row cap}. A referenced-but-unprovided known param binds NULL.
function buildParamPool(opts: RunDiagnosticsSqlOptions, cap: number): Record<string, unknown> {
  const user = opts.params ?? {}
  const windowH = typeof user.window === 'number' ? user.window : undefined
  const k = typeof user.k === 'number' ? user.k : undefined
  const minCount = typeof user.minCount === 'number' ? user.minCount : undefined
  return {
    ...user,
    since: windowH && windowH > 0 ? Date.now() - windowH * 3_600_000 : (user.since ?? null),
    mult: k ?? user.mult ?? 5,
    minCount: minCount ?? 3,
    __cap: cap,
  }
}
function collectBoundParams(sql: string, pool: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const re = /:([a-zA-Z_][a-zA-Z0-9_]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(sql)) !== null) {
    const name = m[1]
    out[`:${name}`] = pool[name] !== undefined ? pool[name] : null
  }
  return out
}

function execRows(db: SqlDatabase, sql: string, params: Record<string, unknown>): { columns: string[]; rows: Array<Record<string, unknown>> } {
  const st: SqlStatement = db.prepare(sql)
  const rows: Array<Record<string, unknown>> = []
  const columns = new Set<string>()
  try {
    st.bind(params)
    while (st.step()) {
      const obj = st.getAsObject()
      for (const c of Object.keys(obj)) { columns.add(c) }
      rows.push(obj)
    }
  } finally { st.free() }
  return { columns: [...columns], rows }
}

// ── formats ──────────────────────────────────────────────────────────────────────
function cell(v: unknown): string {
  if (v === null || v === undefined) { return '' }
  if (typeof v === 'number') { return Number.isInteger(v) ? String(v) : v.toFixed(3) }
  return String(v)
}
function renderTable(columns: string[], rows: Array<Record<string, unknown>>): string {
  if (columns.length === 0) { return '(no rows)' }
  const widths = columns.map(c => Math.max(c.length, ...rows.map(r => cell(r[c]).length), 3))
  const bar = (l: string, mid: string, rgt: string, fill: string) => l + columns.map((_, i) => fill.repeat(widths[i] + 2)).join(mid) + rgt
  const line = (vals: string[]) => '│ ' + vals.map((v, i) => v.padEnd(widths[i])).join(' │ ') + ' │'
  const out: string[] = []
  out.push(bar('┏', '┳', '┓', '━'))
  out.push('┃ ' + columns.map((c, i) => c.padEnd(widths[i])).join(' ┃ ') + ' ┃')
  out.push(bar('┡', '╇', '┩', '━'))
  for (const r of rows) { out.push(line(columns.map(c => cell(r[c])))) }
  out.push(bar('└', '┴', '┘', '─'))
  return out.join('\n')
}
function renderMarkdown(columns: string[], rows: Array<Record<string, unknown>>): string {
  if (columns.length === 0) { return '(no rows)' }
  const head = '| ' + columns.join(' | ') + ' |'
  const sep = '| ' + columns.map(() => '---').join(' | ') + ' |'
  const body = rows.map(r => '| ' + columns.map(c => cell(r[c])).join(' | ') + ' |').join('\n')
  return [head, sep, body].join('\n')
}

/** Run a preset or a raw read-only query over forensics.db. The MCP handler runs ensureFreshIndex
 *  first. Returns dbAvailable:false with a note when the fact DB / sql.js is unavailable, or an
 *  {error} object (never throws) when the statement gate rejects a raw query. */
export async function runDiagnosticsSql(opts: RunDiagnosticsSqlOptions = {}): Promise<RunDiagnosticsSqlResult> {
  const format = opts.format ?? 'json'
  const cap = Math.min(Math.max(1, opts.limit ?? DEFAULT_ROWS), HARD_MAX_ROWS)

  // No mode → list the preset library.
  if (!opts.preset && !opts.sql) {
    return { mode: 'list', dbAvailable: true, presets: Object.entries(PRESETS).map(([name, p]) => ({ name, description: p.description })) }
  }
  if (opts.preset && opts.sql) {
    return { mode: 'sql', dbAvailable: true, error: 'Provide EITHER preset OR sql, not both.' }
  }

  let inner: string
  let mode: 'preset' | 'sql'
  if (opts.preset) {
    const p = PRESETS[opts.preset]
    if (!p) { return { mode: 'preset', dbAvailable: true, error: `Unknown preset "${opts.preset}". Call with no args to list the library.` } }
    inner = p.sql; mode = 'preset'
  } else {
    try { inner = assertReadOnlySelect(opts.sql!) } catch (e) { return { mode: 'sql', dbAvailable: true, error: (e as Error).message } }
    mode = 'sql'
  }

  const db = await openReadonlyForensicsSnapshot(opts.forensicsDbPath ?? DEFAULT_FORENSICS_DB)
  if (!db) {
    return { mode, preset: opts.preset, dbAvailable: false, note: 'forensics.db unavailable (no OTEL bodies indexed yet, or sql.js unavailable in this runtime).' }
  }
  try {
    const capped = `SELECT * FROM (${inner}) LIMIT :__cap`
    const pool = buildParamPool(opts, cap)
    const bound = collectBoundParams(capped, pool)
    let columns: string[]; let rows: Array<Record<string, unknown>>
    try { ({ columns, rows } = execRows(db, capped, bound)) } catch (e) { return { mode, preset: opts.preset, dbAvailable: true, error: `Query failed: ${(e as Error).message}` } }
    const rendered = format === 'table' ? renderTable(columns, rows) : format === 'markdown' ? renderMarkdown(columns, rows) : undefined
    return { mode, preset: opts.preset, columns, rows, rowCount: rows.length, rendered, dbAvailable: true }
  } finally { db.close() }
}
