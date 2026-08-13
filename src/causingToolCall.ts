// src/causingToolCall.ts — given a burn PEAK (a time window, plus a session or workspace), extract
// EVERY spawn tool-call that could have caused it, VERBATIM, from the Claude session JSONL — numbered,
// time-ordered, and measured (composition counts). NOT a single "nearest" call: a fork-storm is a
// SUSTAINED burst driven by potentially many spawns (Workflows that fan out internally, repeated
// Agent/Task calls), so reporting one is misleading — the full list is the honest view.
//
// WHY: a burn peak with no causing calls is useless — the operator still has to hand-dig the
// transcript. Every peak reporter (investigate_burn, --risk / burn-guard, watch, get_burn_status)
// attaches this so the peak lists WHAT spawned the storm, when, and how many of each.
//
// HOW: transcripts reach ~2 GB (base64 images), so we do NOT parse them in JS. DuckDB's read_json —
// already a runtime dep, it backs the forensics store — streams the NDJSON in C++, projects only
// {timestamp,type,message}, and extracts every spawn tool_use in the window with a JSON path. Reads
// the JSONL (always present), so it works even when raw-body capture is OFF. maximum_object_size is
// raised past the largest image-bloated line so a fat line is SKIPPED (ignore_errors), never aborting
// the read. Query verified against a live transcript before shipping.
//
// Fast-path discipline: callers invoke this ONLY when a peak actually fires (never on the quiet
// path), so --risk's ~50 ms budget is untouched; the streaming read is paid only to explain a peak.

import * as fs from 'fs'
import * as path from 'path'
import { claudeProjectsDirs } from './logReader'
import { resolveProjectSlugs } from './projectSlug'
import { transcriptReadSpec, tornLineSql } from './ndjsonDuck'

/** Tools whose call fans out / spawns work — the candidates behind a FORK_STORM / fan-out burst. */
export const SPAWN_TOOLS = ['Task', 'Agent', 'Workflow', 'SendMessage'] as const

/** One spawn tool-call found in the window. */
export interface SpawnCall {
  /** 1-based index in TIME order (oldest first) — the "numbered" view. */
  n: number
  /** When the call was issued (ISO). */
  iso: string
  /** The tool, e.g. 'Workflow' | 'Agent'. */
  tool: string
  /** input.subagent_type when present (Agent/Task), else null. */
  subagentType: string | null
  /** input.model when the call pinned one, else null (inherited). */
  model: string | null
  /** The tool_use input, VERBATIM (JSON) — the exact call, not a digest. */
  input: string
  /** The session whose transcript issued the call. */
  sessionId: string
}

export interface CausingCallsOptions {
  /** The peak time. Spawns are collected across [atMs - windowMs, atMs + forwardSlackMs]. */
  atMs: number
  /** Live peaks know it (SubagentStart payload). Resolves <sessionId>.jsonl directly. */
  sessionId?: string
  /** investigate_burn knows the workspace — resolves that workspace's transcripts. */
  workspace?: string
  /** Explicit transcript file (tests / a known path). Takes precedence. */
  jsonlPath?: string
  /** How far back before atMs to collect spawns (a sustained burst spans time). Default 15 min. */
  windowMs?: number
  /** Allowance AFTER atMs for clock skew. Default 90 s. */
  forwardSlackMs?: number
  /** Spawn-tool filter. Default SPAWN_TOOLS. */
  tools?: readonly string[]
  /** Override claudeProjectsDirs() — tests only. */
  projectsDirs?: string[]
}

export type CausingCallReason = 'no-locator' | 'no-transcript' | 'none-in-window' | 'duckdb-unavailable'

export interface CausingCallsResult {
  /** Every spawn call in the window, oldest-first (numbered). Empty when none / unresolved. */
  calls: SpawnCall[]
  windowFromIso: string
  windowToIso: string
  /** Set when `calls` is empty — the honest reason, never a fabricated call. */
  reason?: CausingCallReason
  /** Set only when the scanned transcript(s) contained unparseable (torn) NDJSON lines — the
   *  human-readable disclosure that ignore_errors silently degraded rather than dropped them. */
  note?: string
}

const DEFAULT_WINDOW_MS = 15 * 60_000
const DEFAULT_FORWARD_SLACK_MS = 90_000
// mtime is a coarse "this session was active near the peak" proxy — a session file spans time, so
// widen the mtime gate by an hour on each side before the precise ts filter runs inside DuckDB.
const MTIME_SLACK_MS = 3600_000
const MAX_FILES = 8


/** Candidate transcript file(s) for this peak, most-recently-modified first (capped). */
function resolveTranscripts(opts: CausingCallsOptions): string[] {
  if (opts.jsonlPath) return fs.existsSync(opts.jsonlPath) ? [opts.jsonlPath] : []
  const bases = opts.projectsDirs ?? claudeProjectsDirs()

  if (opts.sessionId) {
    const out: string[] = []
    for (const base of bases) {
      let subs: string[]
      try { subs = fs.readdirSync(base) } catch { continue }
      for (const sub of subs) {
        const p = path.join(base, sub, `${opts.sessionId}.jsonl`)
        if (fs.existsSync(p)) out.push(p)
      }
    }
    return out
  }

  if (opts.workspace) {
    // Resolved against disk rather than derived: Claude Code truncates-and-hashes a slug past 200
    // chars, so a deep workspace path produces a directory name no formula here can predict — and
    // the naive derivation names a directory that cannot exist, finding no transcripts at all.
    const slugs = resolveProjectSlugs(opts.workspace, bases)
    const lo = opts.atMs - (opts.windowMs ?? DEFAULT_WINDOW_MS) - MTIME_SLACK_MS
    const hi = opts.atMs + (opts.forwardSlackMs ?? DEFAULT_FORWARD_SLACK_MS) + MTIME_SLACK_MS
    const cand: { p: string; mtime: number }[] = []
    for (const base of bases) for (const slug of slugs) {
      const dir = path.join(base, slug)
      let names: string[]
      try { names = fs.readdirSync(dir) } catch { continue }
      for (const n of names) {
        if (!n.endsWith('.jsonl')) continue
        const p = path.join(dir, n)
        try {
          const st = fs.statSync(p)
          if (st.mtimeMs < lo || st.mtimeMs > hi) continue
          cand.push({ p, mtime: st.mtimeMs })
        } catch { /* raced/unreadable — skip */ }
      }
    }
    return cand.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_FILES).map(c => c.p)
  }

  return []
}

const iso = (ms: number): string => new Date(ms).toISOString()
/** Single-quote a value for inlining in SQL. Paths/tool names are machine-local, not user input,
 *  but escaping the quote keeps a path with an apostrophe from breaking (or injecting) the query. */
const sqlStr = (s: string): string => `'${s.replace(/'/g, "''")}'`

/**
 * EVERY spawn tool-call in the peak window, numbered + time-ordered + verbatim — or an empty list
 * with a reason (never fabricated). One DuckDB streaming pass over the candidate transcript(s).
 */
export async function causingToolCalls(opts: CausingCallsOptions): Promise<CausingCallsResult> {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS
  const fwd = opts.forwardSlackMs ?? DEFAULT_FORWARD_SLACK_MS
  const windowFromIso = iso(opts.atMs - windowMs)
  const windowToIso = iso(opts.atMs + fwd)

  const files = resolveTranscripts(opts)
  if (files.length === 0) {
    const located = Boolean(opts.jsonlPath || opts.sessionId || opts.workspace)
    return { calls: [], windowFromIso, windowToIso, reason: located ? 'no-transcript' : 'no-locator' }
  }

  let duck: typeof import('@duckdb/node-api')
  try { duck = await import('@duckdb/node-api') } catch { return { calls: [], windowFromIso, windowToIso, reason: 'duckdb-unavailable' } }

  const tools = opts.tools ?? SPAWN_TOOLS
  const toolList = tools.map(sqlStr).join(', ')

  // filename=true tags each row with its source file so a multi-session workspace scan knows WHICH
  // session issued each call. json_extract(... '$.content[*]') returns a LIST that UNNEST flattens to
  // one row per content block; ORDER BY ts ASC gives the numbered, oldest-first burst timeline.
  const readJson = transcriptReadSpec(files)
  const sql = `
    WITH lines AS (
      SELECT filename, timestamp, type, message
      FROM ${readJson}
      WHERE type='assistant' AND timestamp >= ${sqlStr(windowFromIso)} AND timestamp <= ${sqlStr(windowToIso)}
    ),
    blocks AS (
      SELECT filename, timestamp, UNNEST(json_extract(message, '$.content[*]')) AS block FROM lines
    )
    SELECT filename, timestamp AS ts,
           json_extract_string(block, '$.name') AS tool,
           json_extract_string(block, '$.input.subagent_type') AS subagent_type,
           json_extract_string(block, '$.input.model') AS model,
           CAST(json_extract(block, '$.input') AS VARCHAR) AS input
    FROM blocks
    WHERE json_extract_string(block, '$.type') = 'tool_use'
      AND json_extract_string(block, '$.name') IN (${toolList})
    ORDER BY timestamp ASC;`

  const inst = await duck.DuckDBInstance.create(':memory:')
  const con = await inst.connect()
  try {
    const rows = (await con.runAndReadAll(sql)).getRowObjects()

    // Torn-line disclosure: only after the main query succeeded (one extra round-trip). A malformed
    // line lands as an all-NULL row under ignore_errors, not a dropped one — count(*) alone would
    // pass silently, so compare it against a column EVERY real record carries.
    //
    // That column is `type`, NOT `timestamp`. Measured over 482,993 real transcript records:
    // `type` is missing from 0 of them, `timestamp` from 81,814 — 16.9%, because `attachment`,
    // `queue-operation` and `last-prompt` records legitimately carry no timestamp. This probe reads
    // the UNFILTERED scan (the `type='assistant'` filter belongs to the query above, not here), so
    // keying on `timestamp` would have reported roughly a sixth of a healthy machine's records as
    // "unparseable and excluded" — a disclosure that lies, which is worse than none at all.
    const [{ total: tlTotal, withCol: tlWithCol }] =
      (await con.runAndReadAll(tornLineSql(readJson, 'type'))).getRowObjects()
        .map(r => ({ total: Number(r.total ?? 0), withCol: Number(r.withCol ?? 0) }))
    const tornLines = tlTotal - tlWithCol
    const note = tornLines > 0 ? `${tornLines} line(s) unparseable and excluded.` : undefined

    if (rows.length === 0) return { calls: [], windowFromIso, windowToIso, reason: 'none-in-window', note }
    const calls: SpawnCall[] = rows.map((r, i) => ({
      n: i + 1,
      iso: String(r.ts),
      tool: String(r.tool),
      subagentType: r.subagent_type == null ? null : String(r.subagent_type),
      model: r.model == null ? null : String(r.model),
      input: String(r.input),
      sessionId: opts.sessionId ?? path.basename(String(r.filename), '.jsonl'),
    }))
    return { calls, windowFromIso, windowToIso, note }
  } finally {
    con.closeSync()
    inst.closeSync()
  }
}

/** Compact "Agent/general-purpose/opus×2, Workflow×2, …" tally of a spawn list, most-frequent first. */
export function composition(calls: SpawnCall[]): string {
  const by = new Map<string, number>()
  for (const c of calls) {
    const key = [c.tool, c.subagentType, c.model].filter(Boolean).join('/')
    by.set(key, (by.get(key) ?? 0) + 1)
  }
  return [...by.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join(', ')
}

/** Numbered, time-ordered, measured block for text reporters (--risk, watch, investigate_burn).
 *  Full literal input per call (the user's explicit choice); an empty result renders its honest
 *  reason, never a guess. */
export function renderCausingCalls(r: CausingCallsResult): string {
  const noteSuffix = r.note ? ` ${r.note}` : ''
  if (r.calls.length === 0) return `cause-calls: none (${r.reason ?? 'unknown'})${noteSuffix}`
  const head = `cause-calls: ${r.calls.length} spawn call(s) in ${r.windowFromIso}→${r.windowToIso} — ${composition(r.calls)}${noteSuffix}`
  const lines = r.calls.map(c => {
    const tag = [c.tool, c.subagentType && `subagent_type=${c.subagentType}`, c.model && `model=${c.model}`]
      .filter(Boolean).join(' ')
    return `  ${c.n}. ${c.iso}  ${tag}  ${c.input}`
  })
  return [head, ...lines].join('\n')
}
