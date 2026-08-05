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
import { EXIT as CLI_EXIT } from './cliErrors'
import { flagValue } from './argHelpers'
import { queryStatusline, type StatuslineStream } from '../statuslineStore'
import { calcTokenCostUsd, lookupRates } from '../shared/pricing'

export const STATUSLINE_HISTORY_USAGE = `agentlenspro statusline-history [view] [flags]

Query the captured status-line history — the per-turn series Claude Code renders but never persists.
Reads the store on disk, so it works with the server down.

views:
  project     everything about the sessions running in ONE project: model, effort, fast mode,
              context fill, lifetime cost, and the account's 5h/7d window fill. Scopes itself to
              the current directory unless --project or --session says otherwise
  sessions    (default) one row per session: context fill, cost, samples, span
  subagents   per-subagent context history from subagentStatusLine — tokenCount vs
              contextWindowSize, effort, model, and the cwd that marks a worktree agent
  windows     rate-limit 5h/7d window history (full float precision, per session)
  peaks       the largest context/cost jumps between consecutive samples — "what spiked, when"
              (read the 'gap s'/'span' columns: a delta across an idle gap is an INTERVAL total,
              not one turn's cost)
  cache       per-turn cache WRITE vs READ — the falsifier for a claimed cache miss. Costs are
              bracketed 5m/1h because the write rate is tiered by TTL and the tier is not in
              the payload; the truth is inside the bracket.
  raw         individual samples

flags:
  --session ID   restrict to one session id
  --project DIR  restrict to sessions whose workspace or cwd is at or under DIR (worktree agents
                 included). Bare --project means the current directory. Works with EVERY view
  --since S      start of the window: ISO timestamp, or a number of HOURS back (default 24)
  --until S      end of the window (ISO timestamp)
  --limit N      max rows (default 40). Most views are RANKED (by cost / write / peak), NOT
                 chronological, so a recent low-ranking turn can fall off the list — raise this
                 to see it. Every run prints a coverage line naming the sort and the store's
                 newest sample, so truncation is never mistaken for stale capture
  --json         machine-readable output
  --out FILE     write the full report to FILE; print only a one-line digest

exit: 0 = answered · 2 = BLIND (cannot see — NOT "no burn") · 64 = bad command line · 1 = runtime failure`

/** Exit codes — the house contract (./cliErrors): 0 answered · 2 BLIND ("cannot see", NOT "no
 *  burn" — the house "could not answer honestly" code) · 64 bad command line · 1 runtime failure
 *  (an escaped throw, mapped by the shim). BLIND was 1 and usage was 2 during development; unified
 *  before the feature's first mainline release so no consumer ever meets the drifted vocabulary. */
export const EXIT = { OK: CLI_EXIT.OK, BLIND: CLI_EXIT.UNKNOWN, USAGE: CLI_EXIT.USAGE } as const

const VALUED_FLAGS = new Set(['--session', '--since', '--until', '--limit', '--out', '--project'])

/** ISO timestamp, or a bare number meaning "that many hours ago". Returns undefined for absent. */
export function parseWhenArg(v: string | undefined, nowMs: number = Date.now()): number | undefined {
  if (v === undefined || v === '') return undefined
  if (/^\d+(\.\d+)?$/.test(v)) return nowMs - Number(v) * 3_600_000
  const t = Date.parse(v)
  if (!Number.isFinite(t)) throw new Error(`unparseable time: ${v} (use an ISO timestamp or a number of hours)`)
  return t
}

/** JSON.stringify THROWS on a BigInt ("Do not know how to serialize a BigInt"), and DuckDB returns
 *  every BIGINT column (token counts, epoch ms, count(*)) as one. The table view hid this behind
 *  String(), so --json was the only broken path — and it failed outright rather than degrading.
 *  Exact integers up to 2^53 become numbers; anything larger becomes a string rather than silently
 *  losing precision. */
export function jsonSafe(v: unknown): unknown {
  if (typeof v === 'bigint') {
    return v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= -BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString()
  }
  if (Array.isArray(v)) return v.map(jsonSafe)
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, jsonSafe(x)]))
  }
  return v
}

function fmtNum(v: unknown): string {
  const n = Number(v)
  if (!Number.isFinite(n)) return '-'
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}m`
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n * 100) / 100)
}

/** LOCAL time, never UTC — a correctness fix, not a preference.
 *
 *  This rendered `toISOString()` (UTC) under a bare `time` header, while every sibling surface
 *  (get_cache_event_log's `localTime`) renders local. On a +0200 machine two views of the SAME
 *  store therefore disagreed by two hours with nothing marking the difference, and the newest row
 *  always looked ~2h old. That is precisely how it was read: on 2026-08-04 this view — THE
 *  falsifier for a claimed cache miss — was declared BLIND and abandoned mid-measurement while it
 *  was in fact live and 41 s fresh. A diagnostic that merely looks dead is worse than one that is,
 *  because it gets routed around silently. The offset is now printed in the header too (tzLabel). */
function fmtTime(v: unknown): string {
  const t = Number(v)
  if (!Number.isFinite(t)) return '-'
  const d = new Date(t)
  const p = (x: number): string => String(x).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** The machine's UTC offset as `+HHMM`, appended to every time-column header. A bare `time` header
 *  is what let the UTC/local mismatch above go unnoticed for as long as it did; a labelled one
 *  cannot. Matches the `%z` spelling used for every dated filename in this repo. */
export function tzLabel(d: Date = new Date()): string {
  const off = -d.getTimezoneOffset()
  const a = Math.abs(off)
  return `${off < 0 ? '-' : '+'}${String(Math.floor(a / 60)).padStart(2, '0')}${String(a % 60).padStart(2, '0')}`
}

/** Costs need more precision than fmtNum's 2dp: a warm turn is ~$0.35 and a cheap one ~$0.004, and
 *  rounding the latter to 0 turns "nearly free" into "free". null (unpriced model) stays "-". */
function fmtCost(v: unknown): string {
  if (v === null || v === undefined) return '-'
  const x = Number(v)
  return Number.isFinite(x) ? x.toFixed(4) : '-'
}

/** Above this gap between consecutive samples, a cumulative-cost delta covers more than one turn.
 *  Sampling runs at ~3 s while a turn is live, so 60 s is far outside normal jitter but still short
 *  enough that a genuine long single turn is labelled INTERVAL rather than silently called a turn —
 *  the conservative direction, since the failure being guarded is over-claiming. */
const PEAK_TURN_GAP_S = 60

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
  sql: (limit: number, f: Filters) => string
  /** How this view's SQL ranks its rows, in plain words, for the coverage footer.
   *
   *  Most views are RANKED (by cost, by write, by peak) rather than chronological, and every view is
   *  capped by --limit. Those two facts together mean the newest row in the OUTPUT is unrelated to
   *  the newest row in the STORE — so a perfectly live capture can present as stale. Naming the sort
   *  is what turns that from a trap into a fact the reader can act on. */
  sortedBy: string
  cols: Array<{ key: string; label: string; fmt?: (v: unknown) => string }>
  /** Derive columns in TS rather than SQL. Used by `cache`, whose numbers come from
   *  src/shared/pricing.ts — the ONE place rates live. Re-encoding them in a SQL literal would be a
   *  second source of truth that goes stale the next time a rate changes. */
  post?: (rows: Array<Record<string, unknown>>) => Array<Record<string, unknown>>
}

/** DuckDB hands back BIGINT as a JS BigInt and DOUBLE as a number; arithmetic mixing the two throws
 *  ("Cannot mix BigInt and other types"). Every value entering a cost computation goes through here. */
function n(v: unknown): number {
  // `Number()` already handles BigInt, so no special case is needed — an earlier version had a
  // `typeof v === 'bigint' ? … : …` whose branches were identical, which reads as if a case is being
  // handled when nothing is. What DOES matter is the finite guard: a null column arrives as null,
  // `Number(null)` is 0 but `Number(undefined)` is NaN, and a NaN reaching calcTokenCostUsd would
  // silently poison a cost rather than fail.
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}

/** What a view is restricted to. Filtering happens in SQL rather than by narrowing the file list: a
 *  session's samples land in any day-partition, and these columns are dictionary-encoded so the scan
 *  is cheap. */
export interface Filters {
  session?: string
  /** Absolute path. Matches a session whose workspace OR cwd is at or under it. */
  project?: string
}

const sqlStr = (s: string): string => `'${s.replace(/'/g, "''")}'`

/** Which samples belong to a project.
 *
 *  THREE location fields, not one, and each is load-bearing: `workspace_project_dir` is the root
 *  Claude Code was opened at, while `workspace_current_dir` and `cwd` follow the agent — a
 *  worktree-isolated agent runs under `<root>/.claude/worktrees/<name>`, so matching only the project
 *  dir would drop exactly the agents most worth finding. Prefix-matching the root catches all of them.
 *
 *  A trailing slash is stripped so `--project /x/y/` and `--project /x/y` mean the same thing, and
 *  the `/%` in the LIKE is what stops `/x/y` from also matching a sibling `/x/y-old`. */
export function projectPredicate(p: string): string {
  const root = p.replace(/\/+$/, '')
  const exact = sqlStr(root)
  // Escape LIKE's own wildcards inside the path before it becomes a pattern: `_` matches ANY single
  // character, so `--project /a/my_project` would silently also match `/a/myXproject`, and a `%`
  // matches anything at all. ESCAPE makes the path mean itself, literally.
  const under = sqlStr(`${root.replace(/[\\%_]/g, m => `\\${m}`)}/%`)
  return `(${['workspace_project_dir', 'workspace_current_dir', 'cwd']
    .map(c => `${c} = ${exact} OR ${c} LIKE ${under} ESCAPE '\\'`).join(' OR ')})`
}

/** Compose a view's WHERE from the shared filters plus any view-specific conditions.
 *
 *  Views must NEVER hand-roll `WHERE`/`AND`. Two of them used to switch on whether a session filter
 *  was present (`${session ? 'AND' : 'WHERE'}`), which is invalid the moment a SECOND filter exists —
 *  a shape that silently produces broken SQL rather than a type error. */
export function whereOf(f: Filters, ...extra: string[]): string {
  const c: string[] = []
  if (f.session) c.push(`CAST(session_id AS VARCHAR) = ${sqlStr(f.session)}`)
  if (f.project) c.push(projectPredicate(f.project))
  for (const e of extra) if (e) c.push(e)
  return c.length ? `WHERE ${c.join(' AND ')}` : ''
}

/** ALWAYS select a session id through this.
 *
 *  DuckDB's JSON reader AUTO-DETECTS a UUID-shaped string as the UUID type, and the node client hands
 *  a UUID back as `{hugeint: "-42379450445917529599431978701661611460"}` — not a string, not the id,
 *  and useless to every consumer. Worse, the inference is per-file: the same column can land as UUID
 *  in one part and VARCHAR in another, so an un-cast union is type-unstable across the seal boundary.
 *  Casting at every selection site keeps the id a string, always. */
const SESSION_COL = 'CAST(session_id AS VARCHAR) AS session_id'

/** Booleans render as `true`/`false`/`null`, three widths for a column that only ever answers one
 *  question. `yes` / `-` reads at a glance and keeps the column 3 chars wide. */
function fmtBool(v: unknown): string {
  return v === true ? 'yes' : v === false ? '-' : '?'
}

export const VIEWS: Record<string, ViewSpec> = {
  // THE ONE COMMAND FOR "what is happening in THIS project" — what a caller running inside a repo
  // (the janitor) asks. `sessions` answers "what cost the most" machine-wide; this answers "who is
  // running HERE, on what model, how full, and how much of the ACCOUNT window they have burnt".
  //
  // Everything here is LATEST-WINS via `arg_max(x, ts)` — latest NON-NULL, which matters because an
  // optional block is absent from early samples rather than null-filled. `any_value()` would pick an
  // arbitrary row, including one from before a /model switch or a fast-mode toggle, and report a
  // stale model against a current cost. The two exceptions are `peak_ctx` (max, a high-water mark)
  // and `cost_usd` (max of a CUMULATIVE field = its latest value). Never SUM any of these: the
  // status line misses fast turns, so summing double-counts nothing and under-counts everything.
  project: {
    stream: 'main',
    sql: (limit, f) => `
      SELECT ${SESSION_COL},
             arg_max(model_id, ts)                              AS model,
             arg_max(effort_level, ts)                          AS effort,
             arg_max(fast_mode, ts)                             AS fast,
             arg_max(thinking_enabled, ts)                      AS thinking,
             arg_max(context_window_total_input_tokens, ts)     AS ctx,
             arg_max(context_window_used_percentage, ts)        AS ctx_pct,
             max(context_window_total_input_tokens)             AS peak_ctx,
             arg_max(exceeds_200k_tokens, ts)                   AS over_200k,
             max(cost_total_cost_usd)                           AS cost_usd,
             arg_max(rate_limits_five_hour_used_percentage, ts) AS five_h_pct,
             arg_max(rate_limits_seven_day_used_percentage, ts) AS seven_d_pct,
             arg_max(rate_limits_five_hour_resets_at, ts)       AS five_h_resets_at,
             arg_max(rate_limits_seven_day_resets_at, ts)       AS seven_d_resets_at,
             arg_max(version, ts)                               AS version,
             arg_max(session_name, ts)                          AS session_name,
             arg_max(workspace_repo_owner, ts)                  AS repo_owner,
             arg_max(workspace_repo_name, ts)                   AS repo_name,
             arg_max(workspace_project_dir, ts)                 AS project_dir,
             arg_max(cwd, ts)                                   AS cwd,
             count(*)                                           AS samples,
             (max(ts) - min(ts)) / 60000.0                      AS span_min,
             max(ts)                                            AS last_ts
      FROM samples ${whereOf(f)}
      GROUP BY session_id ORDER BY last_ts DESC LIMIT ${limit}`,
    sortedBy: 'time (last sample), newest first',
    // The table is the decision surface; --json carries every column above, including the reset
    // timestamps, the repo identity and the dirs that are constant per project and would only pad
    // the terminal.
    cols: [
      { key: 'session_id', label: 'session', fmt: v => String(v ?? '-').slice(0, 8) },
      { key: 'model', label: 'model', fmt: v => String(v ?? '-').replace(/^claude-/, '') },
      { key: 'effort', label: 'effort' },
      { key: 'fast', label: 'fast', fmt: fmtBool },
      { key: 'ctx', label: 'ctx', fmt: fmtNum },
      { key: 'ctx_pct', label: 'ctx%', fmt: fmtNum },
      { key: 'cost_usd', label: 'cost $', fmt: fmtNum },
      { key: 'five_h_pct', label: '5h%', fmt: fmtNum },
      { key: 'seven_d_pct', label: '7d%', fmt: fmtNum },
      { key: 'version', label: 'ver' },
      { key: 'samples', label: 'samples' },
      { key: 'last_ts', label: 'last', fmt: fmtTime },
    ],
  },

  // LATEST-WINS for the point-in-time fields and MAX for the peak — never SUM. The statusline can
  // miss fast turns, so summing its lines double-counts nothing and under-counts everything; this is
  // the same rule src/statuslineUsage.ts states and the reason its aggregates are shaped this way.
  sessions: {
    stream: 'main',
    sql: (limit, f) => `
      SELECT ${SESSION_COL},
             count(*)                              AS samples,
             max(context_window_used_percentage)   AS peak_pct,
             max(context_window_total_input_tokens) AS peak_ctx,
             max(cost_total_cost_usd)              AS cost_usd,
             max(ts)                               AS last_ts,
             (max(ts) - min(ts)) / 60000.0         AS span_min
      FROM samples ${whereOf(f)}
      GROUP BY session_id ORDER BY cost_usd DESC NULLS LAST LIMIT ${limit}`,
    sortedBy: 'cost, highest first',
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
  //
  // FIELDS ARE READ THROUGH JSON, not as struct members, and that is not stylistic. DuckDB infers
  // the `tasks` struct type PER FILE from the data in that file, so a part in which no task ever
  // reported `effort` gets a struct type with NO `effort` KEY — and `t.effort` against it is a hard
  // `Binder Error: Could not find key "effort" in struct` that kills the whole view. MEASURED on the
  // live store: of six subagent parts one had no `effort` key at all and another carried it on 1 of
  // 413 tasks. It survives today only because file selection is by DAY partition, so a sibling part
  // that does have the key joins the union and the merged struct type includes it; a day whose parts
  // all lack it would take the view down. `to_json(t)->>'x'` yields NULL for an absent key instead.
  //
  // This struct has already drifted twice — the docs list a `name` field the live payload does not
  // have (it carries `description` and `label`), and now `effort` comes and goes — so pinning the
  // view to a fixed struct shape is a standing bet against a payload we do not control.
  subagents: {
    stream: 'subagent',
    sql: (limit, f) => `
      SELECT agent_id,
             any_value(task) AS task, any_value(model) AS model,
             any_value(effort) AS effort, any_value(status) AS status,
             max(token_count)                                     AS peak_tokens,
             100.0 * max(token_count) / nullif(any_value(ctx_size), 0) AS fill_pct,
             count(*) AS samples, max(ts) AS last_ts, any_value(cwd) AS cwd
      FROM (
        SELECT ts,
               j->>'id' AS agent_id, j->>'description' AS task, j->>'model' AS model,
               j->>'effort' AS effort, j->>'status' AS status, j->>'cwd' AS cwd,
               TRY_CAST(j->>'tokenCount' AS BIGINT)        AS token_count,
               TRY_CAST(j->>'contextWindowSize' AS BIGINT) AS ctx_size
        FROM (SELECT ts, to_json(t) AS j FROM samples, unnest(tasks) AS u(t) ${whereOf(f)})
      )
      WHERE agent_id IS NOT NULL
      GROUP BY agent_id ORDER BY peak_tokens DESC NULLS LAST LIMIT ${limit}`,
    sortedBy: 'peak tokens, highest first',
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
    sql: (limit, f) => `
      SELECT ${SESSION_COL}, ts,
             rate_limits_five_hour_used_percentage  AS pct_5h,
             rate_limits_seven_day_used_percentage  AS pct_7d,
             rate_limits_five_hour_resets_at        AS resets_5h
      FROM samples ${whereOf(f, 'rate_limits_five_hour_used_percentage IS NOT NULL')}
      ORDER BY ts DESC LIMIT ${limit}`,
    sortedBy: 'time, newest first',
    cols: [
      { key: 'ts', label: 'time', fmt: fmtTime },
      { key: 'session_id', label: 'session', fmt: v => String(v ?? '-').slice(0, 8) },
      { key: 'pct_5h', label: '5h %', fmt: fmtNum },
      { key: 'pct_7d', label: '7d %', fmt: fmtNum },
      // Local, via fmtTime, so this cannot drift from the `time` column beside it — the reset clock
      // reading UTC while the sample clock read local was the same bug twice in one row.
      { key: 'resets_5h', label: '5h resets', fmt: v => (Number.isFinite(Number(v)) ? fmtTime(Number(v) * 1000).slice(0, 5) : '-') },
    ],
  },

  // "What spiked, and when" — the delta between consecutive samples of the same session. This is
  // what the aggregate views cannot show: a session that ends at 40% may have got there in one jump.
  //
  // `gap_s` AND `span` ARE LOAD-BEARING, not decoration. `cost_total_cost_usd` is CUMULATIVE, so a
  // delta is a per-turn cost ONLY when the two samples are adjacent in time — and sampling STOPS
  // while a session sits idle, so the pair bracketing an idle stretch lumps every turn in between
  // into one number. Reading this column without its gap is how I reported a $0.35 warm turn as a $5
  // cold write and repeated it for a dozen turns before the transcript contradicted me. A delta over
  // a long gap is an INTERVAL total; the view now shows the interval so it cannot be read as a turn.
  peaks: {
    stream: 'main',
    // A SUBQUERY, deliberately not a CTE: every view is spliced in after `WITH samples AS (...)`, so
    // a view that opens with its own WITH produces two consecutive WITH clauses and a parser error.
    sql: (limit, f) => `
      SELECT session_id, ts, model, ctx, d_ctx, d_cost, gap_s,
             CASE WHEN gap_s > ${PEAK_TURN_GAP_S} THEN 'INTERVAL' ELSE 'turn' END AS span
      FROM (
        SELECT ${SESSION_COL}, ts, model_display_name AS model,
               context_window_total_input_tokens AS ctx,
               context_window_total_input_tokens
                 - lag(context_window_total_input_tokens) OVER (PARTITION BY session_id ORDER BY ts) AS d_ctx,
               cost_total_cost_usd
                 - lag(cost_total_cost_usd) OVER (PARTITION BY session_id ORDER BY ts) AS d_cost,
               (ts - lag(ts) OVER (PARTITION BY session_id ORDER BY ts)) / 1000.0 AS gap_s
        FROM samples ${whereOf(f)}
      )
      WHERE d_ctx IS NOT NULL ORDER BY d_cost DESC NULLS LAST LIMIT ${limit}`,
    sortedBy: 'cost delta, largest first',
    cols: [
      { key: 'ts', label: 'time', fmt: fmtTime },
      { key: 'session_id', label: 'session', fmt: v => String(v ?? '-').slice(0, 8) },
      { key: 'model', label: 'model' },
      { key: 'ctx', label: 'ctx', fmt: fmtNum },
      { key: 'd_ctx', label: 'd ctx', fmt: fmtNum },
      { key: 'd_cost', label: 'd $', fmt: fmtNum },
      { key: 'gap_s', label: 'gap s', fmt: fmtNum },
      { key: 'span', label: 'span' },
    ],
  },

  // THE FALSIFIER. Answers "was that turn actually a cold cache write?" from the payload's own
  // per-turn buckets, so a warning that CLAIMS a huge cache miss can be CHECKED instead of believed
  // — which is the whole reason this view exists: a hook here reported "cache-miss write ~520k"
  // every turn while the transcript showed cache_read 630k against cache_creation ~1k, and nothing
  // on this machine could contradict it in one command.
  //
  // `current_usage` splits the turn into fresh input / cache WRITE / cache READ, and the ratio IS the
  // answer: a warm turn re-reads its whole prefix at 0.1x and writes only the new suffix, so the
  // write stays in the hundreds while the read carries the context. A genuine cold rewrite puts the
  // PREFIX in cache_creation — write% near 100, not near 0.
  //
  // GROUPED BY THE TURN'S INPUT SIDE, not one row per sample — and both halves of that were forced
  // by the first live runs, not by theory:
  //  * `current_usage` describes the LAST turn and the status line re-renders every ~3 s regardless,
  //    so an idle session republishes one turn indefinitely. Ungrouped, the view showed a single
  //    compaction rewrite twelve times and nothing else — a table that reads as twelve cold writes.
  //  * `output_tokens` GROWS while the response streams, so grouping on it split one turn back into
  //    its snapshots (out=2, then 119, then 170 — same write/read, three rows).
  // The input buckets are fixed the moment the request is sent, so they identify the turn; the
  // output is taken at its MAX (the completed response). `renders` is how many samples carried it.
  cache: {
    stream: 'main',
    sql: (limit, f) => `
      SELECT ${SESSION_COL}, min(ts) AS ts, any_value(model_id) AS model_id,
             context_window_current_usage_input_tokens                AS in_tok,
             context_window_current_usage_cache_creation_input_tokens AS cache_write,
             context_window_current_usage_cache_read_input_tokens     AS cache_read,
             max(context_window_current_usage_output_tokens)          AS out_tok,
             count(*)                                                 AS renders
      FROM samples ${whereOf(f, 'context_window_current_usage_cache_read_input_tokens IS NOT NULL')}
      GROUP BY session_id, in_tok, cache_write, cache_read
      ORDER BY cache_write DESC NULLS LAST LIMIT ${limit}`,
    sortedBy: 'cache WRITE, largest first',
    post: rows => rows.map(r => {
      const write = n(r.cache_write), read = n(r.cache_read)
      const model = String(r.model_id ?? '')
      // An unknown model must read as "-", never as $0. calcTokenCostUsd returns 0 for an unpriced
      // id, and a 0 in a cost column is indistinguishable from "this turn was free".
      const priced = lookupRates(model) !== null
      // The write rate is tiered by TTL (5m = 1.25x base input, 1h = 2x) and the payload does NOT
      // carry the tier, so a single figure would be a guess. Both bounds are shown: the true cost is
      // inside the bracket, and when the bracket is narrow the tier does not matter to the verdict.
      const cost5m = priced ? calcTokenCostUsd(n(r.in_tok), read, write, n(r.out_tok), model, 0) : null
      const cost1h = priced ? calcTokenCostUsd(n(r.in_tok), read, write, n(r.out_tok), model, write) : null
      const total = write + read
      return {
        ...r,
        write_pct: total > 0 ? (100 * write) / total : null,
        cost_5m: cost5m,
        cost_1h: cost1h,
        // WARM is the claim worth being able to make: the prefix was re-read, not re-written.
        verdict: total === 0 ? 'no-cache' : write / total >= 0.5 ? 'COLD-WRITE' : write / total >= 0.05 ? 'mixed' : 'warm',
      }
    }),
    cols: [
      { key: 'ts', label: 'time', fmt: fmtTime },
      { key: 'session_id', label: 'session', fmt: v => String(v ?? '-').slice(0, 8) },
      { key: 'model_id', label: 'model', fmt: v => String(v ?? '-').replace(/^claude-/, '') },
      { key: 'cache_write', label: 'WRITE', fmt: fmtNum },
      { key: 'cache_read', label: 'read', fmt: fmtNum },
      { key: 'out_tok', label: 'out', fmt: fmtNum },
      { key: 'renders', label: 'rndr', fmt: fmtNum },
      { key: 'write_pct', label: 'write%', fmt: fmtNum },
      { key: 'cost_5m', label: '$ 5m', fmt: fmtCost },
      { key: 'cost_1h', label: '$ 1h', fmt: fmtCost },
      { key: 'verdict', label: 'verdict' },
    ],
  },

  raw: {
    stream: 'main',
    sql: (limit, f) => `
      SELECT ts, ${SESSION_COL}, model_display_name AS model, effort_level AS effort,
             context_window_used_percentage AS pct,
             context_window_total_input_tokens AS ctx,
             cost_total_cost_usd AS cost
      FROM samples ${whereOf(f)} ORDER BY ts DESC LIMIT ${limit}`,
    sortedBy: 'time, newest first',
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

/** What the STORE holds for this filter, independent of what the view's ranking and --limit chose
 *  to show. This is the only number that answers "is capture alive?", and it must be computed
 *  separately precisely BECAUSE the view's own rows cannot answer it: a ranked, capped view shows
 *  the top-N by cost/write, whose newest member can be hours older than the newest sample on disk.
 *
 *  Never allowed to take the real answer down — a freshness probe that throws would turn a working
 *  query into a runtime failure, which is a strictly worse outcome than an unknown freshness line. */
export async function storeFreshness(
  root: string, stream: StatuslineStream, f: Filters, opts: { sinceMs?: number; untilMs?: number },
): Promise<{ newestTs: number | null; samples: number }> {
  try {
    const r = await queryStatusline(root, stream, `SELECT max(ts) AS ts, count(*) AS n FROM samples ${whereOf(f)}`, opts)
    if (r === null || r.length === 0) return { newestTs: null, samples: 0 }
    const ts = Number(r[0].ts)
    const samples = Number(r[0].n)
    return { newestTs: Number.isFinite(ts) ? ts : null, samples: Number.isFinite(samples) ? samples : 0 }
  } catch {
    return { newestTs: null, samples: 0 }
  }
}

/** The one-line coverage footer. Says what was shown, how it was ranked, and how fresh the STORE is
 *  — the three facts whose absence let a live view be mistaken for a dead one. */
export function coverageLine(
  shown: number, sortedBy: string, fresh: { newestTs: number | null; samples: number }, nowMs: number,
): string {
  const freshness = fresh.newestTs === null
    ? 'newest sample: unknown'
    : `newest sample ${fmtTime(fresh.newestTs)} ${tzLabel()} (${Math.max(0, Math.round((nowMs - fresh.newestTs) / 1000))}s ago)`
  return `coverage: ${shown} row(s), sorted by ${sortedBy} · ${fresh.samples} sample(s) in window · ${freshness}`
}

export async function runStatuslineHistoryCli(argv: string[]): Promise<number> {
  if (argv[0] === '--help' || argv[0] === '-h') {
    console.log(STATUSLINE_HISTORY_USAGE)
    return EXIT.OK
  }
  // flagValue, not a local helper. The local one returned undefined for a flag-shaped value so that
  // `--out --json` could not write a file named "--json" — right about the junk file, wrong about how:
  // it discarded the flag and ran as if it had never been typed. MEASURED: `--session --json` dropped
  // the filter and returned 14 sessions instead of 1, exit 0, with the JSON reporting no session
  // filter at all. A missing file is a nuisance; a silently unfiltered answer is a wrong answer.
  const flag = (name: string, what = 'a value', bareOk = false): string | undefined =>
    flagValue(argv, name, what, bareOk)
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

  // Read the flag VALUES outside the try: the catch below exists for parseWhenArg's "unparseable
  // time" and must not also swallow a UsageError from flagValue, or one flag surface would report a
  // caller mistake as a return code while its siblings throw. Every flag-value refusal here is a
  // UsageError, which the shim maps to 64 uniformly.
  const sinceArg = flag('--since', 'an ISO timestamp or a number of hours')
  const untilArg = flag('--until', 'an ISO timestamp')
  let sinceMs: number | undefined
  let untilMs: number | undefined
  try {
    sinceMs = parseWhenArg(sinceArg ?? '24')
    untilMs = parseWhenArg(untilArg)
  } catch (e) {
    console.error(String((e as Error).message))
    return EXIT.USAGE
  }
  const limit = Math.max(1, Math.min(Number(flag('--limit', 'a number')) || 40, 2000))
  const outFile = flag('--out', 'a path')
  const asJson = argv.includes('--json')
  const root = statuslineRoot()

  // `--project` with NO value means "the project I am running in" — that is the whole point of the
  // flag for a caller like the janitor, which runs inside a repo and wants its own picture without
  // knowing a path. Resolved to an absolute real path so a relative arg, a trailing slash, or a
  // symlinked checkout all match the absolute dirs the payload records.
  const filters: Filters = { session: flag('--session', 'a session id') }
  const wantsProject = argv.includes('--project')
  // The `project` view IMPLIES its own scope — the name is the contract, and a caller running
  // `statusline-history project` from inside a repo means "this repo". Skipped when --session
  // already narrows to one session, because a session filter is strictly more specific and adding
  // an unrequested project predicate on top could return zero rows for a session that exists.
  const impliedProject = viewName === 'project' && !wantsProject && !filters.session
  if (wantsProject || impliedProject) {
    // bareOk: `--project` alone is the DOCUMENTED spelling for "the directory I am in", so
    // `--project --json` is correct usage and must not be refused the way `--session --json` is.
    const given = wantsProject ? flag('--project', 'a directory', true) : undefined
    try { filters.project = fs.realpathSync(path.resolve(given ?? process.cwd())) } catch {
      console.error(`no such project directory: ${given ?? process.cwd()}`)
      return EXIT.USAGE
    }
    // To stderr, so a piped stdout stays machine-readable. Printed only when the scope was NOT
    // asked for: a caller that did not name a directory still has to be able to see which one it
    // got, or a wrong answer from the wrong repo is indistinguishable from a right one.
    if (impliedProject) console.error(`scope: ${filters.project} (implied by the 'project' view — pass --project DIR to override)`)
  }

  let rows: Array<Record<string, unknown>> | null
  try {
    rows = await queryStatusline(root, view.stream, view.sql(limit, filters), { sinceMs, untilMs })
    if (rows !== null && view.post) rows = view.post(rows)
  } catch (e) {
    // A failed query is a RUNTIME failure, not a caller mistake: rethrow and let the shim map it
    // to exit 1. Returning USAGE here made a DuckDB error read as "your command line was wrong",
    // which a scripting caller would route to its own-bug handler and suppress.
    throw new Error(`query failed: ${(e as Error).message}`)
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

  // Time columns render LOCAL, and the header carries the machine's offset, so this view's clock can
  // never be silently compared against a sibling surface's (get_cache_event_log renders local too).
  const cols = view.cols.map(c => (c.fmt === fmtTime ? { ...c, label: `${c.label} ${tzLabel()}` } : c))

  const fresh = await storeFreshness(root, view.stream, filters, { sinceMs, untilMs })

  const text = asJson
    ? JSON.stringify(jsonSafe({
      view: viewName, stream: view.stream, sinceMs, untilMs, ...filters,
      sortedBy: view.sortedBy, newestSampleTs: fresh.newestTs, samplesInWindow: fresh.samples,
      count: rows.length, rows,
    }), null, 2)
    : (rows.length === 0 ? '(no rows matched — the store has data for this window but nothing fits the filter)' : table(rows, cols))
  const digest = `${rows.length} row(s) — ${viewName}`

  // To stderr, so a piped stdout stays machine-readable. Always printed on the human path: the
  // freshness line is what makes "the newest row looks old" CHECKABLE instead of alarming.
  if (!asJson) {
    console.error(coverageLine(rows.length, view.sortedBy, fresh, Date.now()))
    // The exact trap that cost a live measurement on 2026-08-04: a view that is both RANKED and
    // CAPPED shows the top-N by rank, so recent low-ranking turns are simply absent — which from
    // the table alone is indistinguishable from capture having died. Name it explicitly.
    if (rows.length >= limit && !view.sortedBy.startsWith('time')) {
      console.error(
        `note: capped at --limit ${limit} and ranked by ${view.sortedBy}, so RECENT low-ranking turns `
        + "can be missing. That is truncation, NOT stale capture — compare 'newest sample' above "
        + 'against your clock, and raise --limit to see more.',
      )
    }
  }

  if (outFile) {
    fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true })
    fs.writeFileSync(outFile, text.endsWith('\n') ? text : `${text}\n`)
    console.log(`${digest} → ${outFile}`)
  } else {
    console.log(text)
  }
  return EXIT.OK
}
