// src/cli/searchCli.ts — `agentlenspro search`: grep a session's transcript jsonl with DuckDB
// (TRDD-P31SWA8I).
//
// WHY DUCKDB AND NOT A JS LINE LOOP: a main transcript here is routinely 60MB+ with MB-sized
// tool_result lines; read_ndjson_objects streams it off disk on the store's machine-scaled thread
// pool and never materializes the file in V8 — the exact single-core JS hot-loop shape the
// 2026-08-18 CPU incidents traced to (TRDD-7I5805QM/DMWOBWFH) must not be reintroduced here.
//
// stdout is the matches alone (one line each, or --json); everything describing WHICH transcript
// was searched goes to stderr — the same pipe-safe split as cache-expired/last-compact.

import * as fs from 'fs'
import * as path from 'path'
import { LogReader } from '../logReader'
import { EXIT, UsageError } from './cliErrors'
import { assertKnownFlags, flagValue } from './argHelpers'

export const SEARCH_USAGE = `agentlenspro search <pattern> --session ID [flags]

Search one session's transcript .jsonl — tool outputs, agent responses, thinking, user prompts —
with DuckDB's streaming NDJSON reader (fast on 60MB+ transcripts, no server needed).

flags:
  --session ID         the session (or sub-agent) transcript to search. Exact id, or a unique
                       id prefix (>= 6 chars). REQUIRED.
  --role R             only entries whose message.role is R (user|assistant|...)
  --type T             only entries whose type is T (e.g. tool_result, assistant, summary)
  --regex              treat <pattern> as a regular expression (default: literal substring,
                       case-insensitive)
  --limit N            max matches to print (default 20, max 500)
  --json               machine output: {line, ts, type, role, excerpt} per match + total

exit:
  0 = searched (even with 0 matches) · 2 = transcript not found / unreadable · 64 = bad usage

  agentlenspro search "ENOENT" --session 39b0d00b --type tool_result`

const KNOWN = new Set(['--session', '--role', '--type', '--regex', '--limit', '--json', '--help', '-h'])
const VALUED = new Set(['--session', '--role', '--type', '--limit'])

/** SQL single-quoted literal — the codebase queries by interpolation, so quoting is load-bearing. */
function sq(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

export interface SearchHit {
  line: number
  ts: string | null
  type: string | null
  role: string | null
  excerpt: string
}

export interface SearchResult {
  hits: SearchHit[]
  total: number
}

/**
 * The engine, separated from argv so tests drive it directly. One streaming SQL pass: line
 * numbering, field extraction, filtering, match-windowed excerpt and the total all happen in
 * DuckDB — the transcript never enters V8 whole.
 */
export async function searchTranscript(
  file: string,
  pattern: string,
  opts: { regex?: boolean; role?: string; type?: string; limit?: number } = {},
): Promise<SearchResult> {
  const limit = Math.min(Math.max(1, opts.limit ?? 20), 500)
  // Imported lazily, same reason as store/db.ts: --version/hook/gate must not pay for the binding.
  const { DuckDBInstance } = await import('@duckdb/node-api')
  const inst = await DuckDBInstance.create(':memory:')
  const con = await inst.connect()
  try {
    const matchExpr = opts.regex
      ? `regexp_matches(raw, ${sq(pattern)})`
      : `strpos(lower(raw), lower(${sq(pattern)})) > 0`
    // Excerpt: a window around the first hit for substring mode; the first regex capture (bounded)
    // for regex mode. Computed in SQL so an MB-sized tool_result line never crosses into JS.
    const excerptExpr = opts.regex
      ? `substr(regexp_extract(raw, ${sq(pattern)}), 1, 300)`
      : `substr(raw, greatest(1, strpos(lower(raw), lower(${sq(pattern)})) - 100), 300)`
    const filters = [
      matchExpr,
      opts.role ? `json_extract_string(obj, '$.message.role') = ${sq(opts.role)}` : null,
      opts.type ? `json_extract_string(obj, '$.type') = ${sq(opts.type)}` : null,
    ].filter((f): f is string => f !== null)
    const sql = `
      WITH lines AS (
        SELECT row_number() OVER () AS line, json AS obj, CAST(json AS VARCHAR) AS raw
        FROM read_ndjson_objects(${sq(file)}, maximum_object_size=268435456)
      )
      SELECT line,
             json_extract_string(obj, '$.timestamp') AS ts,
             json_extract_string(obj, '$.type') AS type,
             json_extract_string(obj, '$.message.role') AS role,
             ${excerptExpr} AS excerpt,
             count(*) OVER () AS total
      FROM lines
      WHERE ${filters.join(' AND ')}
      ORDER BY line
      LIMIT ${limit}`
    const rows = (await con.runAndReadAll(sql)).getRowObjects()
    const hits: SearchHit[] = rows.map(r => ({
      line: Number(r.line),
      ts: (r.ts as string | null) ?? null,
      type: (r.type as string | null) ?? null,
      role: (r.role as string | null) ?? null,
      excerpt: String(r.excerpt ?? '').replace(/\s+/g, ' ').trim(),
    }))
    return { hits, total: rows.length > 0 ? Number(rows[0].total) : 0 }
  } finally {
    con.closeSync()
  }
}

/** Exact id via the reader's own lookup, else a UNIQUE >=6-char prefix over its file walk —
 *  ambiguity is an error naming the candidates, never a silent pick. */
function resolveTranscript(sessionId: string): { file: string } | { error: string } {
  const reader = new LogReader()
  const exact = reader.transcriptPathFor(sessionId)
  if (exact) return { file: exact }
  if (sessionId.length >= 6) {
    const stem = (p: string): string => path.basename(p).replace(/\.jsonl$/, '')
    const candidates = reader
      .collectFileMeta()
      .filter(f => f.agentKey === 'claude' && stem(f.filePath).startsWith(sessionId))
    if (candidates.length === 1) return { file: candidates[0].filePath }
    if (candidates.length > 1) {
      return { error: `session prefix "${sessionId}" is ambiguous: ${candidates.slice(0, 5).map(c => stem(c.filePath)).join(', ')}${candidates.length > 5 ? ', …' : ''}` }
    }
  }
  return { error: `no transcript found for session "${sessionId}" (exact id or a unique >=6-char prefix)` }
}

export async function runSearchCli(argv: string[]): Promise<number> {
  assertKnownFlags(argv, KNOWN, VALUED, 'agentlenspro search --help')
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(SEARCH_USAGE)
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
  const session = flagValue(argv, '--session')
  if (!session) throw new UsageError('--session ID is required — the transcript to search')
  const limitRaw = flagValue(argv, '--limit')
  const limit = limitRaw !== undefined ? Number(limitRaw) : undefined
  if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) throw new UsageError('--limit needs a positive number')

  const resolved = resolveTranscript(session)
  if ('error' in resolved) {
    console.error(resolved.error)
    return EXIT.UNKNOWN
  }
  let size = 0
  try { size = fs.statSync(resolved.file).size } catch {
    console.error(`transcript vanished: ${resolved.file}`)
    return EXIT.UNKNOWN
  }
  const t0 = Date.now()
  const { hits, total } = await searchTranscript(resolved.file, pattern, {
    regex: argv.includes('--regex'),
    role: flagValue(argv, '--role'),
    type: flagValue(argv, '--type'),
    limit,
  })
  // WHICH transcript + coverage → stderr; matches alone → stdout (pipe-safe split).
  console.error(`${resolved.file} (${(size / 1048576).toFixed(1)}MB) — ${total} match(es), showing ${hits.length}, ${Date.now() - t0}ms`)
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ file: resolved.file, total, hits }))
  } else {
    for (const h of hits) {
      const kind = h.role ?? h.type ?? '?'
      console.log(`#${h.line}\t${h.ts ?? '-'}\t[${kind}]\t${h.excerpt}`)
    }
  }
  return EXIT.OK
}
