// src/cli/searchCli.ts — `agentlenspro search`: grep a project's transcript .jsonl files with DuckDB
// (TRDD-P31SWA8I; project-wide scope, filters and output: TRDD-UIQS9RXZ).
//
// WHY DUCKDB AND NOT A JS LINE LOOP: a main transcript here is routinely 60MB+ with MB-sized
// tool_result lines; read_ndjson_objects streams it off disk (several threads for small files, one thread
// for big ones — see the stage-1 scan split) and never materializes the file in V8 — the exact
// single-core JS hot-loop shape the 2026-08-18 CPU incidents traced to (TRDD-7I5805QM/DMWOBWFH) must
// not be reintroduced here.
//
// TWO STAGES (project-wide scan), and why: a line number needs a window function over the scan, and
// a window is a BLOCKING operator — `row_number() OVER (PARTITION BY filename)` over this project's
// 3 GB of transcripts holds every row before the WHERE runs and dies with "Out of Memory Error
// (1.8 GiB/1.8 GiB used)" at the 2GB no-spill limit (measured 2026-11-17, reports_dev/UIQS9RXZ).
// So stage 1 scans the whole file list with NO window and keeps only small columns per match
// (excerpt + md5 of the line, never the json); stage 2 numbers lines for the SHOWN hits only, one
// single-file pass per distinct file, matching rows back by md5. A hit whose md5 is gone (the
// transcript grew or was rewritten between the stages) gets line null — never a wrong number.
// One transcript (the old single-file scope) keeps the one-statement window: one file always fits.
//
// stdout is the matches alone (one line each, or --json); everything describing WHAT was searched
// goes to stderr — the same pipe-safe split as cache-expired/last-compact.

import * as fs from 'fs'
import * as path from 'path'
import type { DuckDBConnection } from '@duckdb/node-api'
import { claudeProjectsDirs } from '../logReader'
import { MAX_OBJECT_SIZE } from '../ndjsonDuck'
import { resolveProjectSlugs } from '../projectSlug'
import { EXIT, UsageError } from './cliErrors'
import { assertKnownFlags, flagValue } from './argHelpers'

export const SEARCH_USAGE = `agentlenspro search <pattern> [flags]

Search the Claude transcripts (.jsonl) of the current project — tool outputs, agent responses,
thinking, user prompts, hook injections, sub-agent transcripts — with DuckDB's streaming NDJSON
reader. Without --session it covers EVERY session of the project, main and sub-agent.

scope:
  --project DIR        the project (default: the current directory); a path or a Claude project slug
  --session ID[,ID]    only these sessions (exact id or a unique prefix >= 6 chars); their sub-agent
                       transcripts are included
  --agent ID[,ID]      only sub-agent transcripts whose agent id starts with ID
  --main-only          main transcripts only (not with --subagents-only)
  --subagents-only     sub-agent transcripts only
  --worktrees          also search the project's sibling worktree folders (<slug>--claude-worktrees-*)
filters:
  --since T / --until T  ISO date or datetime (no zone = local time) or a span: 30m 2h 3d 1w;
                       an entry with no timestamp is excluded when either is given
  --branch B           entries whose gitBranch is B
  --cwd TEXT           entries whose cwd contains TEXT
  --worktree NAME      entries whose cwd contains /worktrees/NAME
  --model M            entries whose message.model contains M
  --role R             only entries whose message.role is R (user|assistant|...)
  --type T             only entries whose type is T (e.g. user, assistant, attachment, summary)
  --include-requests   also search api-request, api-request-blob, api-request-shape entries
                       (excluded by default: they repeat the conversation)
  --include-attachments  also search every attachment type (by default only hook output, queued
                       commands, edited files, file, diagnostics and task_status attachments)
match:
  --regex              <pattern> is a regular expression matched against the RAW JSON line (a quote
                       is \\" and a newline is \\n there). Default: literal, case-insensitive
output:
  --limit N            max matches to print (default 20, max 500)
  --width N            excerpt length in characters (default 300, max 2000)
  --order new|old      newest first / oldest first; without it: file order when exactly one transcript is in scope, otherwise newest first
  --count              per transcript: <count> <session8>[:<agent8>], largest first
  --files              only the paths of the transcripts that match (not with --count)
  --json               machine output: {line, ts, type, role, excerpt, session, agent, file} per
                       match + total

text line: <session8>[:<agent8>] <TAB> #<line> <TAB> <ts> <TAB> [role|type] <TAB> <excerpt>
stderr: transcripts and MB searched, matches, shown, total ms (scan = all-file scan, lines = line numbers of
       the shown hits). A line that is not valid JSON (e.g. the half-written last line of a live transcript) is not searched;
       the count of such lines is printed on stderr and is "skipped" in --json. A blank line is not counted by the reader,
       so each blank line lowers every later line number by one. A line larger than about 512 MiB makes the whole search fail
       with a maximum_object_size error; it is not skipped.

exit:
  0 = searched (even with 0 matches) · 2 = no transcript found / unreadable · 64 = bad usage

  agentlenspro search "ENOENT" --since 2d --type user
  agentlenspro search "hook" --subagents-only --count --worktrees`

const VALUED = new Set([
  '--project', '--session', '--agent', '--since', '--until', '--branch', '--cwd', '--worktree', '--model',
  '--role', '--type', '--limit', '--width', '--order',
])
const KNOWN = new Set([
  ...VALUED, '--regex', '--json', '--count', '--files', '--main-only', '--subagents-only', '--worktrees',
  '--include-requests', '--include-attachments', '--help', '-h',
])

// Entries that repeat the conversation (a copy of it plus request metadata): a hit there duplicates
// a hit in the conversation, and they are 0.5 GB of this project's transcripts.
const REQUEST_TYPES = ['api-request-blob', 'api-request', 'api-request-shape']
// Attachments are 1.33 GB of 3.15 GB, mostly repeated reminders and prompt snapshots; these are the
// kinds that carry text a human or agent would look for.
const ATTACHMENT_TYPES = [
  'hook_success', 'hook_additional_context', 'hook_system_message', 'hook_blocking_error', 'hook_cancelled',
  'hook_non_blocking_error', 'async_hook_response', 'queued_command', 'edited_text_file', 'file', 'diagnostics',
  'task_status',
]

// Stage-1 scan split: a file under SMALL_FILE_BYTES cannot hold a line over SMALL_OBJECT_SIZE, so those files
// are scanned with a smaller per-thread JSON buffer and several threads; the rest keep the full
// MAX_OBJECT_SIZE buffer on ONE thread (the reader holds ~2 x maximum_object_size per thread).
const SMALL_FILE_BYTES = 32 * 1048576
const SMALL_OBJECT_SIZE = 64 * 1048576
const SMALL_SCAN_THREADS = 4

/** SQL single-quoted literal — the codebase queries by interpolation, so quoting is load-bearing. */
function sq(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

// ── time arguments ───────────────────────────────────────────────────────────────────────────────

const RELATIVE_SPAN = /^(\d+)([mhdw])$/
const SPAN_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }
const ISO_SHAPE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/

/** `--since`/`--until` value to an ISO UTC string (the transcripts' own `timestamp` format, so SQL
 *  compares it as text). A span is relative to `nowMs`; anything unparseable is a UsageError. */
export function parseTimeArg(value: string, flag: string, nowMs: number = Date.now()): string {
  const span = RELATIVE_SPAN.exec(value)
  if (span) return new Date(nowMs - Number(span[1]) * SPAN_MS[span[2]]).toISOString()
  const ms = ISO_SHAPE.test(value) ? Date.parse(value) : NaN
  if (Number.isNaN(ms)) throw new UsageError(`${flag} expects an ISO date/datetime or a span like 30m, 2h, 3d, 1w — got "${value}"`)
  return new Date(ms).toISOString()
}

// ── file discovery (JS, fs) ──────────────────────────────────────────────────────────────────────

export interface TranscriptFile {
  path: string
  /** Session id: the file stem of a main transcript, the parent folder of a sub-agent transcript. */
  session: string
  /** Sub-agent id (file stem without `agent-`), null for a main transcript. */
  agent: string | null
  size: number
  mtimeMs: number
}

export interface ScopeOptions {
  sessions?: string[]
  agents?: string[]
  mainOnly?: boolean
  subagentsOnly?: boolean
  worktrees?: boolean
  /** A file last modified before this cannot hold an entry at or after it, so it is not opened. */
  sinceMs?: number
  /** Test override; defaults to claudeProjectsDirs() (which honours CLAUDE_CONFIG_DIR). */
  projectsDirs?: string[]
}

/** The scope names something that does not exist or is ambiguous — exit 2, not a usage error. */
export class SearchScopeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SearchScopeError'
  }
}

function readDirents(dir: string): fs.Dirent[] {
  try { return fs.readdirSync(dir, { withFileTypes: true }) } catch (e) {
    // A project with no folder yet is an empty scope, not a failure; anything else (EACCES, …) is.
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
}

function resolveSessions(tokens: string[], known: Set<string>): Set<string> {
  const out = new Set<string>()
  for (const t of tokens) {
    if (known.has(t)) { out.add(t); continue }
    const candidates = t.length >= 6 ? [...known].filter(s => s.startsWith(t)).sort() : []
    if (candidates.length === 1) { out.add(candidates[0]); continue }
    if (candidates.length > 1) {
      throw new SearchScopeError(`session prefix "${t}" is ambiguous: ${candidates.slice(0, 5).join(', ')}${candidates.length > 5 ? ', …' : ''}`)
    }
    throw new SearchScopeError(`no transcript found for session "${t}" in this project (exact id or a unique >=6-char prefix; --project / --worktrees change the scope)`)
  }
  return out
}

/** Every transcript of the project (`<projects dir>/<slug>/*.jsonl` and `<slug>/<sid>/subagents/agent-*.jsonl`),
 *  narrowed by the scope flags. Sorted by path so the engine's file list is deterministic. */
export function discoverTranscripts(project: string, scope: ScopeOptions = {}): TranscriptFile[] {
  const roots = scope.projectsDirs ?? claudeProjectsDirs()
  const slugs = resolveProjectSlugs(project, roots)
  const folders = new Set<string>()
  for (const root of roots) {
    for (const slug of slugs) folders.add(path.join(root, slug))
    if (scope.worktrees) {
      for (const e of readDirents(root)) {
        if (e.isDirectory() && slugs.some(s => e.name.startsWith(`${s}--claude-worktrees-`))) folders.add(path.join(root, e.name))
      }
    }
  }

  const found: Array<{ path: string; session: string; agent: string | null }> = []
  for (const folder of folders) {
    for (const e of readDirents(folder)) {
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        found.push({ path: path.join(folder, e.name), session: e.name.slice(0, -'.jsonl'.length), agent: null })
      } else if (e.isDirectory()) {
        const subDir = path.join(folder, e.name, 'subagents')
        for (const s of readDirents(subDir)) {
          if (s.isFile() && s.name.startsWith('agent-') && s.name.endsWith('.jsonl')) {
            found.push({ path: path.join(subDir, s.name), session: e.name, agent: s.name.slice('agent-'.length, -'.jsonl'.length) })
          }
        }
      }
    }
  }

  const wanted = scope.sessions ? resolveSessions(scope.sessions, new Set(found.map(f => f.session))) : null
  const out: TranscriptFile[] = []
  for (const f of found.sort((a, b) => a.path.localeCompare(b.path))) {
    if (wanted && !wanted.has(f.session)) continue
    if (scope.mainOnly && f.agent !== null) continue
    if (scope.subagentsOnly && f.agent === null) continue
    if (scope.agents && !(f.agent !== null && scope.agents.some(a => f.agent!.startsWith(a)))) continue
    let st: fs.Stats
    try { st = fs.statSync(f.path) } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue // raced a deletion
      throw e
    }
    if (scope.sinceMs !== undefined && st.mtimeMs < scope.sinceMs) continue
    out.push({ ...f, size: st.size, mtimeMs: st.mtimeMs })
  }
  return out
}

// ── the engine ───────────────────────────────────────────────────────────────────────────────────

export interface SearchOptions {
  regex?: boolean
  role?: string
  type?: string
  limit?: number
  width?: number
  /** ISO UTC strings (see parseTimeArg). */
  since?: string
  until?: string
  branch?: string
  cwd?: string
  worktree?: string
  model?: string
  includeRequests?: boolean
  includeAttachments?: boolean
  /** Default: file order for ONE transcript, newest first otherwise. */
  order?: 'new' | 'old'
  /** 'count' fills `counts` (per transcript) and no hits; it needs no line numbers. */
  mode?: 'hits' | 'count'
}

export interface SearchHit {
  /** 1-based physical line; null when the transcript changed between the two stages. */
  line: number | null
  ts: string | null
  type: string | null
  role: string | null
  excerpt: string
  file: string
  session: string
  agent: string | null
}

export interface FileCount {
  file: string
  session: string
  agent: string | null
  count: number
}

export interface SearchResult {
  hits: SearchHit[]
  total: number
  counts: FileCount[]
  /** Wall time of stage 1 (the scan) and stage 2 (line numbers for the shown hits), in ms. */
  timing: { scanMs: number; linesMs: number }
  /** Lines that are not valid JSON (e.g. the half-written last line of a live transcript): not searched, counted here. */
  skipped: { lines: number; files: number }
}

/** Stage 2: line numbers and excerpts for the SHOWN hits only — one single-file pass per distinct file.
 *  The excerpt is computed here, not in stage 1: stage 1 with filters AND an excerpt expression
 *  exhausted the 2GB limit in 5 of 6 runs on this project, while either one alone never did.
 *  Only lines that satisfy the same match expression as stage 1 are hashed and excerpted: row_number()
 *  still numbers every physical line (line numbers stay true), but md5 and the excerpt of the other
 *  lines are never computed. */
async function assignLines(con: DuckDBConnection, shown: Array<{ hit: SearchHit; h: string }>, excerptExpr: string, matchExpr: string): Promise<void> {
  const byFile = new Map<string, Array<{ hit: SearchHit; h: string }>>()
  for (const s of shown) {
    const list = byFile.get(s.hit.file) ?? []
    list.push(s)
    byFile.set(s.hit.file, list)
  }
  for (const [file, items] of byFile) {
    const wanted = [...new Set(items.map(i => i.h))]
    const rows = (await con.runAndReadAll(
      `SELECT rn, h, excerpt FROM (
         SELECT rn, md5(raw) AS h, ${excerptExpr} AS excerpt FROM (
           SELECT row_number() OVER () AS rn, CAST(json AS VARCHAR) AS raw
           FROM read_ndjson_objects(${sq(file)}, maximum_object_size=${MAX_OBJECT_SIZE}, ignore_errors=true))
         WHERE ${matchExpr})
       WHERE h IN (${wanted.map(sq).join(",")}) ORDER BY rn`,
    )).getRowObjects()
    const lines = new Map<string, number[]>()
    const excerpts = new Map<string, string>()
    for (const r of rows) {
      const h = String(r.h)
      lines.set(h, [...(lines.get(h) ?? []), Number(r.rn)])
      excerpts.set(h, String(r.excerpt ?? "").replace(/\s+/g, " ").trim())
    }
    // Identical lines share an md5: hand their line numbers out ascending, one per shown hit.
    for (const { hit, h } of items) {
      hit.line = lines.get(h)?.shift() ?? null
      hit.excerpt = excerpts.get(h) ?? ""
    }
  }
}

/**
 * Search a set of transcripts. See the file header for the two-stage shape; every flag value goes
 * through sq(), and the transcript text never enters V8 beyond the shown excerpts.
 */
export async function searchTranscripts(files: TranscriptFile[], pattern: string, opts: SearchOptions = {}): Promise<SearchResult> {
  if (files.length === 0) return { hits: [], total: 0, counts: [], timing: { scanMs: 0, linesMs: 0 }, skipped: { lines: 0, files: 0 } }
  const limit = Math.min(Math.max(1, opts.limit ?? 20), 500)
  const width = Math.min(Math.max(1, opts.width ?? 300), 2000)
  const countMode = opts.mode === 'count'
  const single = files.length === 1 && !countMode
  const byFile = single && !opts.order
  const meta = new Map(files.map(f => [f.path, f]))

  // Literal mode matches the RAW JSON line, where a quote is \" and a newline is \n: escape the
  // pattern the way JSON would, or a pattern with any of those silently finds nothing.
  const needle = opts.regex ? pattern : JSON.stringify(pattern).slice(1, -1)
  const matchExpr = opts.regex
    ? `regexp_matches(raw, ${sq(needle)})`
    : `strpos(lower(raw), lower(${sq(needle)})) > 0`
  // Excerpt: a window around the first hit (literal) or the first regex capture, bounded by --width.
  // Computed in SQL so an MB-sized tool_result line never crosses into JS.
  const excerptExpr = opts.regex
    ? `substr(regexp_extract(raw, ${sq(needle)}), 1, ${width})`
    : `substr(raw, greatest(1, strpos(lower(raw), lower(${sq(needle)})) - 100), ${width})`

  const filters: string[] = []
  if (opts.role) filters.push(`role = ${sq(opts.role)}`)
  if (opts.type) filters.push(`type = ${sq(opts.type)}`)
  // An explicit --type already says which entries are wanted, so the default exclusions only apply without it.
  if (!opts.type && !opts.includeRequests) filters.push(`coalesce(type, '') NOT IN (${REQUEST_TYPES.map(sq).join(',')})`)
  if (!opts.type && !opts.includeAttachments) {
    filters.push(`(coalesce(type, '') <> 'attachment' OR json_extract_string(obj, '$.attachment.type') IN (${ATTACHMENT_TYPES.map(sq).join(',')}))`)
  }
  if (opts.since) filters.push(`ts >= ${sq(opts.since)}`)
  if (opts.until) filters.push(`ts <= ${sq(opts.until)}`)
  if (opts.branch) filters.push(`json_extract_string(obj, '$.gitBranch') = ${sq(opts.branch)}`)
  if (opts.cwd) filters.push(`strpos(coalesce(json_extract_string(obj, '$.cwd'), ''), ${sq(opts.cwd)}) > 0`)
  if (opts.worktree) filters.push(`strpos(coalesce(json_extract_string(obj, '$.cwd'), ''), ${sq(`/worktrees/${opts.worktree}`)}) > 0`)
  if (opts.model) filters.push(`strpos(coalesce(json_extract_string(obj, '$.message.model'), ''), ${sq(opts.model)}) > 0`)
  const where = filters.length > 0 ? `WHERE obj IS NULL OR (${filters.join(' AND ')})` : ''

  const columns = countMode
    ? 'filename'
    : single
      ? `filename, line, ts, type, role, ${excerptExpr} AS excerpt, NULL::VARCHAR AS h`
      : "filename, line, ts, type, role, '' AS excerpt, md5(raw) AS h"
  const stage1 = (group: TranscriptFile[], maxObjectSize: number, create: boolean): string => `
    ${create ? 'CREATE TEMP TABLE hits AS' : 'INSERT INTO hits'}
    WITH src AS (
      SELECT filename, ${single ? 'row_number() OVER ()' : 'NULL::BIGINT'} AS line, json AS obj, CAST(json AS VARCHAR) AS raw
      FROM read_ndjson_objects([${group.map(f => sq(f.path)).join(',')}], filename=true, maximum_object_size=${maxObjectSize}, ignore_errors=true)
    ), m AS (
      SELECT filename, line, obj, raw,
             json_extract_string(obj, '$.timestamp') AS ts,
             json_extract_string(obj, '$.type') AS type,
             json_extract_string(obj, '$.message.role') AS role
      FROM src WHERE obj IS NULL OR ${matchExpr}
    )
    SELECT ${columns}, (obj IS NULL) AS bad FROM m ${where}`

  // Imported lazily, same reason as store/db.ts: --version/hook/gate must not pay for the binding.
  const { DuckDBInstance } = await import('@duckdb/node-api')
  const inst = await DuckDBInstance.create(':memory:', {
    memory_limit: process.env['AGENTLENS_DUCKDB_MEMORY_LIMIT']?.trim() || '2GB',
    // Starts at ONE thread; each stage-1 scan group sets its own count (SET threads). The JSON reader holds
    // ~2 x maximum_object_size of buffer per thread: on this project's 3 GB, scanning ALL files at once with
    // the 256 MB cap hit the 2GB no-spill limit in 4 of 10 runs with 2 threads and in 0 of 10 with 1 (whole
    // command, measured 2026-11-17). Hence the split: files under 32 MB (cap 64 MB) on 4 threads, the rest
    // (cap 256 MB) on 1. Measured on the same project, 3,027 MB, literal pattern, limit 20: scan only 6.0-7.3 s /
    // whole command 6.4-7.8 s with 1 thread everywhere (3 runs); scan only 2.0-2.2 s / whole command 2.4-2.5 s
    // with the split, 0 of 10 runs failed, peak RSS ~0.9 GB. A smaller cap for the big files would make a huge
    // line fail the scan.
    threads: '1',
  })
  const con = await inst.connect()
  try {
    // No spill: an over-limit query must FAIL with a clear error, never write gigabytes to the SSD
    // or to a .tmp folder in the cwd (src/store/db.ts:3-21).
    await con.run("SET temp_directory = ''")
    // Stage 1 needs no row order (hits are re-sorted below), and ordered inserts make DuckDB buffer
    // out-of-order batches: with the default (true) this scan hit the 2GB limit on this project's 3 GB
    // (measured). The one-transcript form must KEEP the order: its row_number() numbers the scan order.
    if (!single) await con.run('SET preserve_insertion_order = false')
    const scanStart = Date.now()
    const bySize = [...files].sort((a, b) => a.size - b.size)
    const groups = [
      { group: bySize.filter(f => f.size < SMALL_FILE_BYTES), maxObjectSize: SMALL_OBJECT_SIZE, threads: SMALL_SCAN_THREADS },
      { group: bySize.filter(f => f.size >= SMALL_FILE_BYTES), maxObjectSize: MAX_OBJECT_SIZE, threads: 1 },
    ].filter(g => g.group.length > 0)
    for (const [i, g] of groups.entries()) {
      await con.run(`SET threads = ${g.threads}`)
      await con.run(stage1(g.group, g.maxObjectSize, i === 0))
    }
    // WHY: the reader yields one row with json NULL per line that is not valid JSON. Stage 1 keeps those rows
    // (obj IS NULL OR ...) so they can be counted here; they are removed so that no later query sees them.
    const bad = (await con.runAndReadAll('SELECT count(*) AS n, count(DISTINCT filename) AS f FROM hits WHERE bad')).getRowObjects()[0]
    const skipped = { lines: Number(bad.n), files: Number(bad.f) }
    if (skipped.lines > 0) await con.run('DELETE FROM hits WHERE bad')
    const scanMs = Date.now() - scanStart
    const fileMeta = (p: unknown): TranscriptFile => {
      const f = meta.get(String(p))
      if (!f) throw new Error(`search returned a transcript that was not in the scan list: ${String(p)}`)
      return f
    }

    if (countMode) {
      const rows = (await con.runAndReadAll('SELECT filename, count(*) AS c FROM hits GROUP BY filename ORDER BY c DESC, filename')).getRowObjects()
      const counts = rows.map(r => {
        const f = fileMeta(r.filename)
        return { file: f.path, session: f.session, agent: f.agent, count: Number(r.c) }
      })
      return { hits: [], total: counts.reduce((n, c) => n + c.count, 0), counts, timing: { scanMs, linesMs: 0 }, skipped }
    }

    const total = Number((await con.runAndReadAll('SELECT count(*) AS n FROM hits')).getRowObjects()[0].n)
    const orderBy = byFile ? 'line' : `(ts IS NULL), ts ${opts.order === 'old' ? 'ASC' : 'DESC'}, filename, line`
    const rows = (await con.runAndReadAll(`SELECT filename, line, ts, type, role, excerpt, h FROM hits ORDER BY ${orderBy} LIMIT ${limit}`)).getRowObjects()
    const pending: Array<{ hit: SearchHit; h: string }> = []
    const hits = rows.map(r => {
      const f = fileMeta(r.filename)
      const hit: SearchHit = {
        line: r.line === null || r.line === undefined ? null : Number(r.line),
        ts: (r.ts as string | null) ?? null,
        type: (r.type as string | null) ?? null,
        role: (r.role as string | null) ?? null,
        excerpt: String(r.excerpt ?? '').replace(/\s+/g, ' ').trim(),
        file: f.path,
        session: f.session,
        agent: f.agent,
      }
      if (!single) pending.push({ hit, h: String(r.h) })
      return hit
    })
    let linesMs = 0
    if (pending.length > 0) {
      // Stage 2's row_number() OVER () numbers the scan order, so the order must be preserved again.
      await con.run('SET preserve_insertion_order = true')
      // Stage 2 reads ONE file with the full 256 MB object cap: one thread, whatever stage 1 left behind
      // (the last stage-1 group sets 4 threads when every file in scope is under 32 MB).
      await con.run('SET threads = 1')
      const linesStart = Date.now()
      await assignLines(con, pending, excerptExpr, matchExpr)
      linesMs = Date.now() - linesStart
    }
    return { hits, total, counts: [], timing: { scanMs, linesMs }, skipped }
  } finally {
    con.closeSync()
    inst.closeSync()
  }
}

/** One transcript, one statement (the original entry point; file order unless `order` is given). */
export async function searchTranscript(file: string, pattern: string, opts: SearchOptions = {}): Promise<SearchResult> {
  const st = fs.statSync(file)
  const stem = path.basename(file).replace(/\.jsonl$/, '')
  const isAgent = stem.startsWith('agent-')
  return searchTranscripts(
    [{ path: file, session: isAgent ? path.basename(path.dirname(path.dirname(file))) : stem, agent: isAgent ? stem.slice('agent-'.length) : null, size: st.size, mtimeMs: st.mtimeMs }],
    pattern,
    opts,
  )
}

// ── argv ─────────────────────────────────────────────────────────────────────────────────────────

function positiveArg(argv: string[], flag: string): number | undefined {
  const v = flagValue(argv, flag, 'a positive number')
  if (v === undefined) return undefined
  const n = Number(v)
  if (!Number.isFinite(n) || n < 1) throw new UsageError(`${flag} needs a positive number`)
  return Math.floor(n)
}

function listArg(argv: string[], flag: string): string[] | undefined {
  const v = flagValue(argv, flag, 'an id or a comma-separated list')
  if (v === undefined) return undefined
  const parts = v.split(',').map(s => s.trim()).filter(Boolean)
  if (parts.length === 0) throw new UsageError(`${flag} needs at least one id`)
  return parts
}

/** A path (resolved against the cwd) or an already-derived slug, the two shapes projectSlugOf takes. */
function projectArg(argv: string[]): string {
  const v = flagValue(argv, '--project', 'a directory')
  if (v === undefined) return process.cwd()
  return v.includes('/') || v.includes('\\') || v === '.' || v === '..' ? path.resolve(v) : v
}

function tag(x: { session: string; agent: string | null }): string {
  return x.session.slice(0, 8) + (x.agent ? `:${x.agent.slice(0, 8)}` : '')
}

// stdout is the matches alone, stderr the description of the run (see the file header).
const writeOut = (line: string): void => { process.stdout.write(`${line}\n`) }
const writeErr = (line: string): void => { process.stderr.write(`${line}\n`) }

export async function runSearchCli(argv: string[]): Promise<number> {
  assertKnownFlags(argv, KNOWN, VALUED, 'agentlenspro search --help')
  if (argv.includes('--help') || argv.includes('-h')) {
    writeOut(SEARCH_USAGE)
    return EXIT.OK
  }
  const positionals: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (VALUED.has(argv[i])) { i++; continue }
    if (!argv[i].startsWith('-')) positionals.push(argv[i])
  }
  const pattern = positionals[0]
  if (!pattern) throw new UsageError('a search <pattern> is required — see: agentlenspro search --help')
  if (positionals.length > 1) throw new UsageError(`one pattern only (got ${positionals.length}) — quote patterns containing spaces`)

  const has = (flag: string): boolean => argv.includes(flag)
  const limit = positiveArg(argv, '--limit')
  const width = positiveArg(argv, '--width')
  if (has('--main-only') && has('--subagents-only')) throw new UsageError('--main-only and --subagents-only are mutually exclusive')
  if (has('--count') && has('--files')) throw new UsageError('--count and --files are mutually exclusive')
  const orderRaw = flagValue(argv, '--order')
  if (orderRaw !== undefined && orderRaw !== 'new' && orderRaw !== 'old') throw new UsageError(`--order expects new or old, got "${orderRaw}"`)
  const now = Date.now()
  const sinceRaw = flagValue(argv, '--since')
  const untilRaw = flagValue(argv, '--until')
  const since = sinceRaw !== undefined ? parseTimeArg(sinceRaw, '--since', now) : undefined
  const until = untilRaw !== undefined ? parseTimeArg(untilRaw, '--until', now) : undefined

  const project = projectArg(argv)
  let files: TranscriptFile[]
  try {
    files = discoverTranscripts(project, {
      sessions: listArg(argv, '--session'),
      agents: listArg(argv, '--agent'),
      mainOnly: has('--main-only'),
      subagentsOnly: has('--subagents-only'),
      worktrees: has('--worktrees'),
      sinceMs: since !== undefined ? Date.parse(since) : undefined,
    })
  } catch (e) {
    if (e instanceof SearchScopeError) {
      writeErr(e.message)
      return EXIT.UNKNOWN
    }
    throw e
  }
  if (files.length === 0) {
    writeErr(`no transcript found for project ${project} with this scope (--project DIR, --worktrees, --session and --agent change it)`)
    return EXIT.UNKNOWN
  }

  const countMode = has('--count')
  const filesMode = has('--files')
  const t0 = Date.now()
  const { hits, total, counts, timing, skipped } = await searchTranscripts(files, pattern, {
    regex: has('--regex'),
    role: flagValue(argv, '--role'),
    type: flagValue(argv, '--type'),
    limit,
    width,
    since,
    until,
    branch: flagValue(argv, '--branch'),
    cwd: flagValue(argv, '--cwd'),
    worktree: flagValue(argv, '--worktree'),
    model: flagValue(argv, '--model'),
    includeRequests: has('--include-requests'),
    includeAttachments: has('--include-attachments'),
    order: orderRaw,
    mode: countMode || filesMode ? 'count' : 'hits',
  })
  // WHAT was searched + coverage → stderr; matches alone → stdout (pipe-safe split).
  const mb = (files.reduce((n, f) => n + f.size, 0) / 1048576).toFixed(1)
  const shown = countMode || filesMode ? `${counts.length} transcript(s) match` : `showing ${hits.length}`
  const skippedNote = skipped.lines > 0 ? ` — ${skipped.lines} invalid line(s) in ${skipped.files} transcript(s) skipped` : ''
  writeErr(`searched ${files.length} transcript(s), ${mb}MB — ${total} match(es), ${shown}, ${Date.now() - t0}ms (scan ${timing.scanMs}ms, lines ${timing.linesMs}ms)${skippedNote}`)

  const asJson = has('--json')
  if (countMode) {
    if (asJson) writeOut(JSON.stringify({ total, counts, skipped }))
    else for (const c of counts) writeOut(`${c.count}\t${tag(c)}`)
  } else if (filesMode) {
    if (asJson) writeOut(JSON.stringify({ total, files: counts.map(c => c.file), skipped }))
    else for (const c of counts) writeOut(c.file)
  } else if (asJson) {
    writeOut(JSON.stringify({ total, hits, skipped }))
  } else {
    for (const h of hits) {
      writeOut(`${tag(h)}\t#${h.line ?? '?'}\t${h.ts ?? '-'}\t[${h.role ?? h.type ?? '?'}]\t${h.excerpt}`)
    }
  }
  return EXIT.OK
}
