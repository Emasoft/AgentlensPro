// src/causingToolCall.ts — given a burn PEAK (a time, plus a session or workspace), extract the
// EXACT tool_use call that CAUSED it, VERBATIM, from the Claude session JSONL transcript.
//
// WHY: a burn peak with no causing tool-call is useless — the operator still has to hand-dig the
// transcript to learn WHICH Agent()/Workflow()/Task() spawned the fork storm. Every peak reporter
// (investigate_burn, --risk / burn-guard, watch, get_burn_status) attaches this so the peak NAMES
// its cause.
//
// HOW: transcripts reach ~2 GB (base64 images), so we do NOT parse them in JS (readline + JSON.parse
// on a 100 MB line is the exact slowness this avoids). DuckDB's read_json — already a runtime dep, it
// backs the forensics store — streams the NDJSON in C++, projects only {timestamp,type,message}, and
// extracts the spawn tool_use with a JSON path. The join is by TIMESTAMP (the append-only transcript
// is chronological). `maximum_object_size` is raised past the largest image-bloated line so a fat
// line is SKIPPED (ignore_errors), never aborting the read. Query verified against a live 21 MB
// transcript before this shipped.
//
// Fast-path discipline: callers invoke this ONLY when a peak actually fires (never on the quiet
// path), so --risk's ~50 ms budget is untouched; the streaming read is paid only to explain a real
// peak.

import * as fs from 'fs'
import * as path from 'path'
import { claudeProjectsDirs } from './logReader'

/** Tools whose call fans out / spawns work — i.e. the cause of a FORK_STORM / fan-out burst. */
export const SPAWN_TOOLS = ['Task', 'Agent', 'Workflow', 'SendMessage'] as const

export interface CausingCall {
  /** The tool that spawned the burst, e.g. 'Workflow'. */
  tool: string
  /** The tool_use input, VERBATIM (JSON) — the "exact call string" the operator asked for. */
  input: string
  /** The session whose transcript issued the call. */
  sessionId: string
  /** The issuing turn's timestamp (ISO). */
  iso: string
}

export interface CausingCallOptions {
  /** The peak time. The causing spawn is the LAST one in [atMs - windowMs, atMs + forwardSlackMs]. */
  atMs: number
  /** Live peaks know it (SubagentStart payload). Resolves <sessionId>.jsonl directly. */
  sessionId?: string
  /** investigate_burn knows the workspace, not the session — resolves that workspace's transcripts. */
  workspace?: string
  /** Explicit transcript file (tests / a known path). Takes precedence. */
  jsonlPath?: string
  /** Look-back window before atMs (the fan-out precedes the child cache-writes). Default 15 min. */
  windowMs?: number
  /** Allowance AFTER atMs for clock skew between file mtime and transcript ts. Default 90 s. */
  forwardSlackMs?: number
  /** Spawn-tool filter. Default SPAWN_TOOLS. */
  tools?: readonly string[]
  /** Override claudeProjectsDirs() — tests only. */
  projectsDirs?: string[]
}

export type CausingCallReason = 'no-locator' | 'no-transcript' | 'none-in-window' | 'duckdb-unavailable'

export interface CausingCallResult {
  /** The verbatim causing call, or null when it cannot be found. NEVER fabricated. */
  call: CausingCall | null
  /** Why `call` is null — surfaced honestly so a peak says "cause unavailable (reason)". */
  reason?: CausingCallReason
}

const DEFAULT_WINDOW_MS = 15 * 60_000
const DEFAULT_FORWARD_SLACK_MS = 90_000
// 256 MB: a single image-bloated turn (~100 MB base64) must SKIP under ignore_errors, not abort the
// read. The largest object DuckDB will buffer for one line.
const MAX_OBJECT_SIZE = 268_435_456
// mtime is a coarse proxy for "this session was active near the peak" — a session file spans time, so
// widen the mtime gate by an hour on each side before the precise ts filter runs inside DuckDB.
const MTIME_SLACK_MS = 3600_000
const MAX_FILES = 8

/** Claude names a workspace's project dir by replacing every non-alphanumeric char with '-'. */
function slugForWorkspace(ws: string): string {
  return ws.replace(/[^A-Za-z0-9]/g, '-')
}

/** Candidate transcript file(s) for this peak, most-recently-modified first (capped). */
function resolveTranscripts(opts: CausingCallOptions): string[] {
  if (opts.jsonlPath) return fs.existsSync(opts.jsonlPath) ? [opts.jsonlPath] : []
  const bases = opts.projectsDirs ?? claudeProjectsDirs()

  if (opts.sessionId) {
    // The transcript file is <sessionId>.jsonl inside the session's workspace project dir.
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
    const slug = slugForWorkspace(opts.workspace)
    const lo = opts.atMs - (opts.windowMs ?? DEFAULT_WINDOW_MS) - MTIME_SLACK_MS
    const hi = opts.atMs + (opts.forwardSlackMs ?? DEFAULT_FORWARD_SLACK_MS) + MTIME_SLACK_MS
    const cand: { p: string; mtime: number }[] = []
    for (const base of bases) {
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
 * The verbatim causing tool-call for a peak, or `{ call: null, reason }` — never a fabricated call.
 * DuckDB streams the candidate transcript(s) and returns the LAST spawn-class tool_use in the window.
 */
export async function causingToolCall(opts: CausingCallOptions): Promise<CausingCallResult> {
  const files = resolveTranscripts(opts)
  if (files.length === 0) {
    const located = Boolean(opts.jsonlPath || opts.sessionId || opts.workspace)
    return { call: null, reason: located ? 'no-transcript' : 'no-locator' }
  }

  let duck: typeof import('@duckdb/node-api')
  try { duck = await import('@duckdb/node-api') } catch { return { call: null, reason: 'duckdb-unavailable' } }

  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS
  const fwd = opts.forwardSlackMs ?? DEFAULT_FORWARD_SLACK_MS
  const fromIso = iso(opts.atMs - windowMs)
  const toIso = iso(opts.atMs + fwd)
  const tools = opts.tools ?? SPAWN_TOOLS
  const toolList = tools.map(sqlStr).join(', ')
  const fileList = files.map(sqlStr).join(', ')

  // filename=true tags each row with its source file so a multi-session workspace scan still knows
  // WHICH session issued the winning call. json_extract(... '$.content[*]') returns a LIST that
  // UNNEST flattens to one row per content block; the last spawn tool_use by timestamp is the cause.
  const sql = `
    WITH lines AS (
      SELECT filename, timestamp, type, message
      FROM read_json([${fileList}], format='newline_delimited',
             columns={timestamp:'VARCHAR', type:'VARCHAR', message:'JSON'},
             maximum_object_size=${MAX_OBJECT_SIZE}, ignore_errors=true, filename=true)
      WHERE type='assistant' AND timestamp >= ${sqlStr(fromIso)} AND timestamp <= ${sqlStr(toIso)}
    ),
    blocks AS (
      SELECT filename, timestamp, UNNEST(json_extract(message, '$.content[*]')) AS block FROM lines
    )
    SELECT filename, timestamp AS ts,
           json_extract_string(block, '$.name') AS tool,
           CAST(json_extract(block, '$.input') AS VARCHAR) AS input
    FROM blocks
    WHERE json_extract_string(block, '$.type') = 'tool_use'
      AND json_extract_string(block, '$.name') IN (${toolList})
    ORDER BY timestamp DESC
    LIMIT 1;`

  const inst = await duck.DuckDBInstance.create(':memory:')
  const con = await inst.connect()
  try {
    const rows = (await con.runAndReadAll(sql)).getRowObjects()
    if (rows.length === 0) return { call: null, reason: 'none-in-window' }
    const r = rows[0]
    const file = String(r.filename)
    return {
      call: {
        tool: String(r.tool),
        input: String(r.input),
        sessionId: opts.sessionId ?? path.basename(file, '.jsonl'),
        iso: String(r.ts),
      },
    }
  } finally {
    con.closeSync()
    inst.closeSync()
  }
}

/** One-line render for text reporters (--risk, watch). Full literal input (the user's explicit
 *  choice); a null result renders its honest reason, never a guess. */
export function renderCausingCall(r: CausingCallResult): string {
  if (r.call) return `cause-call: ${r.call.tool}(${r.call.input}) @ ${r.call.sessionId.slice(0, 8)} ${r.call.iso}`
  return `cause-call: unavailable (${r.reason ?? 'unknown'})`
}
