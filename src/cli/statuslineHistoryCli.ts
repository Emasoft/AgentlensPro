// src/cli/statuslineHistoryCli.ts — `agentlenspro statusline-history`: query the status-line sample
// store (src/statuslineStore.ts).
//
// WHY THIS EXISTS. Every other burn surface reports what a window COST in aggregate. None of them can
// show the SHAPE of a session over time, and none can say anything at all about a live subagent: the
// JSONL transcripts do not record a subagent's context size, and a subagent's own API requests cannot
// be reliably paired back to the parent that launched them. The `subagentStatusLine` payload is the
// only place Claude Code publishes per-agent `tokenCount` against `contextWindowSize`, plus the
// `effort` it actually runs at and the `cwd` that distinguishes a worktree-isolated agent.
//
// READS DISK DIRECTLY, NOT THE SERVER. The store is plain files under the data dir, so this answers
// even when the server is down — which is exactly when someone is investigating a burn.
//
// THE HONESTY CONTRACT. An empty store must read as BLIND, never as "nothing happened". A query that
// finds no data says so and exits non-zero, matching burnInvestigator's `coverage.blind` stance: a
// zero here means "we cannot see", and reporting it as "no burn" is how a diagnostic lies.

import * as fs from 'fs'
import * as path from 'path'
import { dataDir } from './cliCore'
import { queryStatusline, type StatuslineStream } from '../statuslineStore'

export const STATUSLINE_HISTORY_USAGE = `agentlenspro statusline-history [view] [flags]

Query the captured status-line history — the per-turn series Claude Code renders but never persists.
Reads the store on disk, so it works with the server down.

views:
  sessions    (default) one row per session: context fill, cost, samples, span
  subagents   per-subagent context history from subagentStatusLine — tokenCount vs
              contextWindowSize, effort, model, and the cwd that marks a worktree agent
  windows     rate-limit 5h/7d window history (full float precision, per session)
  peaks       the largest context/cost jumps between consecutive samples — "what spiked, when"
  raw         individual samples

flags:
  --session ID   restrict to one session id
  --since S      start of the window: ISO timestamp, or a number of HOURS back (default 24)
  --until S      end of the window (ISO timestamp)
  --limit N      max rows (default 40)
  --json         machine-readable output
  --out FILE     write the full report to FILE; print only a one-line digest`

/** Exit codes: 0 answered, 1 BLIND (no data — NOT "no burn"), 2 usage. */
export const EXIT = { OK: 0, BLIND: 1, USAGE: 2 } as const

const VALUED_FLAGS = new Set(['--session', '--since', '--until', '--limit', '--out'])

/** ISO timestamp, or a bare number meaning "that many hours ago". Returns undefined for absent. */
export function parseWhenArg(v: string | undefined, nowMs: number = Date.now()): number | undefined {
  if (v === undefined || v === '') return undefined
  if (/^\d+(\.\d+)?$/.test(v)) return nowMs - Number(v) * 3_600_000
  const t = Date.parse(v)
  if (!Number.isFinite(t)) throw new Error(`unparseable time: ${v} (use an ISO timestamp or a number of hours)`)
  return t
}

function fmtNum(v: unknown): string {
  const n = Number(v)
  if (!Number.isFinite(n)) return '-'
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}m`
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n * 100) / 100)
}

function fmtTime(v: unknown): string {
  const n = Number(v)
  if (!Number.isFinite(n)) return '-'
  return new Date(n).toISOString().slice(11, 19)
}

/** Render rows as an aligned table. Kept deliberately plain: the output is read in a terminal and
 *  piped into `distill`, so no box-drawing and no colour. */
export function table(rows: Array<Record<string, unknown>>, cols: Array<{ key: string; label: string; fmt?: (v: unknown) => string }>): string {
  const body = rows.map(r => cols.map(c => (c.fmt ? c.fmt(r[c.key]) : String(r[c.key] ?? '-'))))
  const widths = cols.map((c, i) => Math.max(c.label.length, ...body.map(b => b[i].length), 1))
  const line = (cells: string[]): string => cells.map((s, i) => s.padEnd(widths[i])).join('  ').trimEnd()
  return [line(cols.map(c => c.label)), line(widths.map(w => '-'.repeat(w))), ...body.map(line)].join('\n')
}

interface ViewSpec {
  stream: StatuslineStream
  sql: (limit: number, session?: string) => string
  cols: Array<{ key: string; label: string; fmt?: (v: unknown) => string }>
}

/** `session_id` filtering is done in SQL rather than by narrowing the file list: a session's samples
 *  can land in any day-partition, and the column is dictionary-encoded so the scan is cheap. */
const sessionFilter = (s?: string): string => (s ? `WHERE session_id = '${s.replace(/'/g, "''")}'` : '')

export const VIEWS: Record<string, ViewSpec> = {
  // LATEST-WINS for the point-in-time fields and MAX for the peak — never SUM. The statusline can
  // miss fast turns, so summing its lines double-counts nothing and under-counts everything; this is
  // the same rule src/statuslineUsage.ts states and the reason its aggregates are shaped this way.
  sessions: {
    stream: 'main',
    sql: (limit, session) => `
      SELECT session_id,
             count(*)                              AS samples,
             max(context_window_used_percentage)   AS peak_pct,
             max(context_window_total_input_tokens) AS peak_ctx,
             max(cost_total_cost_usd)              AS cost_usd,
             max(ts)                               AS last_ts,
             (max(ts) - min(ts)) / 60000.0         AS span_min
      FROM samples ${sessionFilter(session)}
      GROUP BY session_id ORDER BY cost_usd DESC NULLS LAST LIMIT ${limit}`,
    cols: [
      { key: 'session_id', label: 'session', fmt: v => String(v ?? '-').slice(0, 8) },
      { key: 'samples', label: 'samples' },
      { key: 'peak_pct', label: 'peak%', fmt: fmtNum },
      { key: 'peak_ctx', label: 'peak ctx', fmt: fmtNum },
      { key: 'cost_usd', label: 'cost $', fmt: fmtNum },
      { key: 'span_min', label: 'span min', fmt: fmtNum },
      { key: 'last_ts', label: 'last', fmt: fmtTime },
    ],
  },

  // The one view nothing else in the product can produce. tokenCount/contextWindowSize is a LIVE
  // agent's context fill; cwd is what tells a worktree-isolated agent from one sharing the tree.
  // MEASURED against a live payload, not copied from the docs: the docs list a `name` field on each
  // task, and it does NOT exist — the real struct is
  // {id,type,status,description,label,startTime,model,effort,contextWindowSize,tokenCount,tokenSamples,cwd}.
  // `description` is the agent's task, `label` its current activity. Selecting `name` is a hard
  // binder error that takes the whole view down, so this list stays measured.
  subagents: {
    stream: 'subagent',
    sql: (limit, session) => `
      SELECT t.id AS agent_id,
             any_value(t.description) AS task, any_value(t.model) AS model,
             any_value(t.effort) AS effort, any_value(t.status) AS status,
             max(TRY_CAST(t.tokenCount AS BIGINT))              AS peak_tokens,
             100.0 * max(TRY_CAST(t.tokenCount AS BIGINT))
                   / nullif(any_value(TRY_CAST(t.contextWindowSize AS BIGINT)), 0) AS fill_pct,
             count(*) AS samples, max(ts) AS last_ts, any_value(t.cwd) AS cwd
      FROM samples, unnest(tasks) AS u(t) ${sessionFilter(session)}
      GROUP BY t.id ORDER BY peak_tokens DESC NULLS LAST LIMIT ${limit}`,
    cols: [
      { key: 'task', label: 'task', fmt: v => String(v ?? '-').slice(0, 34) },
      { key: 'model', label: 'model', fmt: v => String(v ?? '-').replace(/^claude-/, '') },
      { key: 'effort', label: 'effort' },
      { key: 'status', label: 'status' },
      { key: 'peak_tokens', label: 'peak tok', fmt: fmtNum },
      { key: 'fill_pct', label: 'fill%', fmt: fmtNum },
      { key: 'last_ts', label: 'last', fmt: fmtTime },
      { key: 'cwd', label: 'cwd', fmt: v => String(v ?? '-').replace(/^.*\/(?=[^/]+$)/, '') },
    ],
  },

  // Full float precision on purpose: these are the ONLY un-quantized window readings available.
  // /api/oauth/usage returns integers, which is a +-25% capacity error at pct=2.
  windows: {
    stream: 'main',
    sql: (limit, session) => `
      SELECT session_id, ts,
             rate_limits_five_hour_used_percentage  AS pct_5h,
             rate_limits_seven_day_used_percentage  AS pct_7d,
             rate_limits_five_hour_resets_at        AS resets_5h
      FROM samples ${sessionFilter(session)}
      ${session ? 'AND' : 'WHERE'} rate_limits_five_hour_used_percentage IS NOT NULL
      ORDER BY ts DESC LIMIT ${limit}`,
    cols: [
      { key: 'ts', label: 'time', fmt: fmtTime },
      { key: 'session_id', label: 'session', fmt: v => String(v ?? '-').slice(0, 8) },
      { key: 'pct_5h', label: '5h %', fmt: fmtNum },
      { key: 'pct_7d', label: '7d %', fmt: fmtNum },
      { key: 'resets_5h', label: '5h resets', fmt: v => (Number.isFinite(Number(v)) ? new Date(Number(v) * 1000).toISOString().slice(11, 16) : '-') },
    ],
  },

  // "What spiked, and when" — the delta between consecutive samples of the same session. This is
  // what the aggregate views cannot show: a session that ends at 40% may have got there in one jump.
  peaks: {
    stream: 'main',
    // A SUBQUERY, deliberately not a CTE: every view is spliced in after `WITH samples AS (...)`, so
    // a view that opens with its own WITH produces two consecutive WITH clauses and a parser error.
    sql: (limit, session) => `
      SELECT session_id, ts, model, ctx, d_ctx, d_cost FROM (
        SELECT session_id, ts, model_display_name AS model,
               context_window_total_input_tokens AS ctx,
               context_window_total_input_tokens
                 - lag(context_window_total_input_tokens) OVER (PARTITION BY session_id ORDER BY ts) AS d_ctx,
               cost_total_cost_usd
                 - lag(cost_total_cost_usd) OVER (PARTITION BY session_id ORDER BY ts) AS d_cost
        FROM samples ${sessionFilter(session)}
      )
      WHERE d_ctx IS NOT NULL ORDER BY d_cost DESC NULLS LAST LIMIT ${limit}`,
    cols: [
      { key: 'ts', label: 'time', fmt: fmtTime },
      { key: 'session_id', label: 'session', fmt: v => String(v ?? '-').slice(0, 8) },
      { key: 'model', label: 'model' },
      { key: 'ctx', label: 'ctx', fmt: fmtNum },
      { key: 'd_ctx', label: 'd ctx', fmt: fmtNum },
      { key: 'd_cost', label: 'd $', fmt: fmtNum },
    ],
  },

  raw: {
    stream: 'main',
    sql: (limit, session) => `
      SELECT ts, session_id, model_display_name AS model, effort_level AS effort,
             context_window_used_percentage AS pct,
             context_window_total_input_tokens AS ctx,
             cost_total_cost_usd AS cost
      FROM samples ${sessionFilter(session)} ORDER BY ts DESC LIMIT ${limit}`,
    cols: [
      { key: 'ts', label: 'time', fmt: fmtTime },
      { key: 'session_id', label: 'session', fmt: v => String(v ?? '-').slice(0, 8) },
      { key: 'model', label: 'model' },
      { key: 'effort', label: 'effort' },
      { key: 'pct', label: 'ctx%', fmt: fmtNum },
      { key: 'ctx', label: 'ctx', fmt: fmtNum },
      { key: 'cost', label: '$', fmt: fmtNum },
    ],
  },
}

export function statuslineRoot(): string {
  return path.join(dataDir(), 'statusline')
}

export async function runStatuslineHistoryCli(argv: string[]): Promise<number> {
  if (argv[0] === '--help' || argv[0] === '-h') {
    console.log(STATUSLINE_HISTORY_USAGE)
    return EXIT.OK
  }
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name)
    const v = i >= 0 ? argv[i + 1] : undefined
    // `--out --json` must not resolve to a file literally named "--json".
    return v?.startsWith('--') ? undefined : v
  }
  let viewName = 'sessions'
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { viewName = a; break }
    if (VALUED_FLAGS.has(a)) i++
  }
  const view = VIEWS[viewName]
  if (!view) {
    console.error(`unknown view '${viewName}' — expected one of: ${Object.keys(VIEWS).join(', ')}`)
    return EXIT.USAGE
  }

  let sinceMs: number | undefined
  let untilMs: number | undefined
  try {
    sinceMs = parseWhenArg(flag('--since') ?? '24')
    untilMs = parseWhenArg(flag('--until'))
  } catch (e) {
    console.error(String((e as Error).message))
    return EXIT.USAGE
  }
  const limit = Math.max(1, Math.min(Number(flag('--limit')) || 40, 2000))
  const session = flag('--session')
  const outFile = flag('--out')
  const asJson = argv.includes('--json')
  const root = statuslineRoot()

  let rows: Array<Record<string, unknown>> | null
  try {
    rows = await queryStatusline(root, view.stream, view.sql(limit, session), { sinceMs, untilMs })
  } catch (e) {
    console.error(`query failed: ${(e as Error).message}`)
    return EXIT.USAGE
  }

  // BLIND vs EMPTY, and the difference is the whole point. `null` means the store holds nothing for
  // this window — we cannot see. An empty array means we looked and there genuinely was nothing.
  if (rows === null) {
    console.error(
      `BLIND: no status-line samples in ${root} for this window.\n`
      + 'This is "cannot see", NOT "no burn". Capture may be uninstalled — run: agentlenspro --install-statusline',
    )
    return EXIT.BLIND
  }

  const text = asJson
    ? JSON.stringify({ view: viewName, stream: view.stream, sinceMs, untilMs, session, count: rows.length, rows }, null, 2)
    : (rows.length === 0 ? '(no rows matched — the store has data for this window but nothing fits the filter)' : table(rows, view.cols))
  const digest = `${rows.length} row(s) — ${viewName}`

  if (outFile) {
    fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true })
    fs.writeFileSync(outFile, text.endsWith('\n') ? text : `${text}\n`)
    console.log(`${digest} → ${outFile}`)
  } else {
    console.log(text)
  }
  return EXIT.OK
}
